/**
 * Local source library: a SQLite-backed store owned by this plugin.
 *
 * Why not `ctx.storageDomain`: the domain layer serves reads from authoritative
 * in-memory state and documents "no secondary indexes" among its limitations,
 * so every filter/sort/page over a source library would be a full scan of a
 * fully-resident table. A source feed is exactly the shape that wants indexed
 * paging, so this owns a database rather than a KV domain. It also keeps the
 * plugin resolvable from outside the harness checkout, which a
 * `@deepseek-ai/dsh-storage-domain` import would not be.
 *
 * The row shape mirrors `Resource` in the gens.team schema
 * (`backend/prisma/schema/models.prisma`), narrowed to the columns the feed
 * and the detail view actually read. Everything the upstream sends is kept in
 * `raw` so a later column can be backfilled without re-fetching.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Schema version stamped in `user_version`; a different stamp rebuilds. */
const SCHEMA_VERSION = 1;

/** `ResourceType` values the feed narrows to, mirroring the upstream enum. */
export const RESOURCE_TYPES = [
  "PAPER", "BLOG", "REPORT", "YOUTUBE_VIDEO", "NEWS", "PROJECT", "EVENT", "RSS", "POLICY",
];

/** Columns a caller may sort by, mapped to their SQL expression. */
const SORTABLE = {
  publishedAt: "published_at",
  qualityScore: "quality_score",
  trendingScore: "trending_score",
  createdAt: "created_at",
};

const DDL = `
CREATE TABLE IF NOT EXISTS resources (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  title            TEXT NOT NULL,
  abstract         TEXT,
  ai_summary       TEXT,
  source_url       TEXT NOT NULL,
  thumbnail_url    TEXT,
  authors          TEXT,
  categories       TEXT,
  published_at     TEXT,
  quality_score    REAL,
  trending_score   REAL,
  upvote_count     INTEGER NOT NULL DEFAULT 0,
  comment_count    INTEGER NOT NULL DEFAULT 0,
  source_type      TEXT,
  normalized_url   TEXT,
  raw              TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

-- Plugin-owned configuration: collector roster, provider keys, schedule.
-- Kept beside the rows it governs so a library is one portable file.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Subtitle tracks fetched for a video, keyed by resource. Cached because the
-- provider rate-limits and a transcript does not change once published.
-- The cues column holds timed segments as JSON: the reader needs timestamps to
-- seek the player, and the joined text stays for grounding a model request.
CREATE TABLE IF NOT EXISTS transcripts (
  resource_id TEXT PRIMARY KEY,
  language    TEXT NOT NULL,
  text        TEXT NOT NULL,
  cues        TEXT,
  fetched_at  TEXT NOT NULL
) STRICT;

-- AI-derived chapter markers for a video. Cached because deriving them costs a
-- model call over the whole transcript.
CREATE TABLE IF NOT EXISTS key_moments (
  resource_id TEXT PRIMARY KEY,
  moments     TEXT NOT NULL,
  created_at  TEXT NOT NULL
) STRICT;

-- Reader's own notes against a source, optionally pinned to a timestamp.
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  at_seconds  REAL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_notes_resource ON notes(resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_resources_type_published ON resources(type, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_resources_quality        ON resources(quality_score DESC);
CREATE INDEX IF NOT EXISTS ix_resources_trending       ON resources(trending_score DESC);
CREATE INDEX IF NOT EXISTS ix_resources_created        ON resources(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resources_norm_url ON resources(normalized_url)
  WHERE normalized_url IS NOT NULL;
`;

/**
 * Normalize a URL for dedup: drop the scheme's case, `www.`, trailing slash,
 * the fragment, and the tracking params the upstream collectors also strip.
 * @param url - a source URL.
 * @returns the normalized form, or undefined when the URL cannot be parsed.
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|si$|feature$)/i.test(key)) parsed.searchParams.delete(key);
    }
    let text = parsed.toString();
    if (text.endsWith("/")) text = text.slice(0, -1);
    return text;
  } catch {
    return undefined;
  }
}

/** JSON text, or null for an absent value. */
function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Parse JSON text back to a value, tolerating malformed rows. */
function parseJson(text, fallback) {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Coerce a possibly-decimal-string score to a number, or null. */
function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The local source library. */
export class SourceStore {
  /**
   * Open (creating if needed) the library database.
   * @param path - absolute file path, or ':memory:'.
   */
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    const stamped = this.db.prepare("PRAGMA user_version").get().user_version;
    if (stamped !== 0 && stamped !== SCHEMA_VERSION) {
      throw new Error(`source store: unsupported schema version ${stamped}`);
    }
    this.db.exec(DDL);
    // `cues` was added after the first libraries were built. Adding the column
    // in place rather than bumping the schema version keeps an existing
    // library — which may be the only copy of a migrated corpus — readable
    // instead of rejecting it at open.
    const columns = this.db.prepare("PRAGMA table_info(transcripts)").all();
    if (!columns.some((column) => column.name === "cues")) {
      this.db.exec("ALTER TABLE transcripts ADD COLUMN cues TEXT");
    }
    if (stamped === 0) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** Release the database handle. */
  close() {
    this.db.close();
  }

  /** Total rows held, optionally narrowed to one type. */
  count(type) {
    const sql = type === undefined
      ? "SELECT COUNT(*) AS n FROM resources"
      : "SELECT COUNT(*) AS n FROM resources WHERE type = ?";
    const row = type === undefined ? this.db.prepare(sql).get() : this.db.prepare(sql).get(type);
    return row.n;
  }

  /** Rows per type, as `{ TYPE: count }`, for the kind chips. */
  countsByType() {
    const rows = this.db.prepare("SELECT type, COUNT(*) AS n FROM resources GROUP BY type").all();
    const counts = {};
    for (const row of rows) counts[row.type] = row.n;
    return counts;
  }

  /**
   * Insert or replace one upstream row.
   * @param row - a `Resource`-shaped object.
   * @returns true when the row was written, false when it was rejected.
   */
  put(row) {
    if (typeof row?.id !== "string" || typeof row?.title !== "string" || typeof row?.sourceUrl !== "string") {
      return false;
    }
    const now = new Date().toISOString();
    const normalized = normalizeUrl(row.sourceUrl) ?? null;
    // A duplicate normalized URL under a DIFFERENT id is the upstream's
    // problem, not ours: keep the row already stored and skip the newcomer,
    // which is what the upstream deduplicator settles on too.
    if (normalized !== null) {
      const clash = this.db.prepare("SELECT id FROM resources WHERE normalized_url = ?").get(normalized);
      if (clash !== undefined && clash.id !== row.id) return false;
    }
    this.db.prepare(`
      INSERT INTO resources (
        id, type, title, abstract, ai_summary, source_url, thumbnail_url, authors,
        categories, published_at, quality_score, trending_score, upvote_count,
        comment_count, source_type, normalized_url, raw, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type, title = excluded.title, abstract = excluded.abstract,
        ai_summary = excluded.ai_summary, source_url = excluded.source_url,
        thumbnail_url = excluded.thumbnail_url, authors = excluded.authors,
        categories = excluded.categories, published_at = excluded.published_at,
        quality_score = excluded.quality_score, trending_score = excluded.trending_score,
        upvote_count = excluded.upvote_count, comment_count = excluded.comment_count,
        source_type = excluded.source_type, normalized_url = excluded.normalized_url,
        raw = excluded.raw, updated_at = excluded.updated_at
    `).run(
      row.id,
      typeof row.type === "string" ? row.type : "NEWS",
      row.title,
      row.abstract ?? null,
      row.aiSummary ?? null,
      row.sourceUrl,
      row.thumbnailUrl ?? null,
      jsonOrNull(row.authors),
      jsonOrNull(row.categories),
      typeof row.publishedAt === "string" ? row.publishedAt : null,
      numberOrNull(row.qualityScore),
      numberOrNull(row.trendingScore),
      Number.isFinite(row.upvoteCount) ? row.upvoteCount : 0,
      Number.isFinite(row.commentCount) ? row.commentCount : 0,
      row.sourceType ?? null,
      normalized,
      JSON.stringify(row),
      typeof row.createdAt === "string" ? row.createdAt : now,
      now,
    );
    return true;
  }

  /**
   * Write many rows in one transaction.
   * @param rows - upstream rows.
   * @returns `{ written, skipped }`.
   */
  putMany(rows) {
    let written = 0;
    let skipped = 0;
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        if (this.put(row)) written += 1;
        else skipped += 1;
      }
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    return { written, skipped };
  }

  /**
   * Page the feed.
   * @param options - `{ type, search, sortBy, take, skip }`.
   * @returns `{ rows, total, hasMore }` in the upstream's envelope shape.
   */
  query({ type, search, sortBy, take = 20, skip = 0 } = {}) {
    const where = [];
    const params = [];
    if (typeof type === "string" && type !== "") {
      where.push("type = ?");
      params.push(type);
    }
    if (typeof search === "string" && search.trim() !== "") {
      where.push("(title LIKE ? OR abstract LIKE ? OR ai_summary LIKE ?)");
      const like = `%${search.trim()}%`;
      params.push(like, like, like);
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const order = SORTABLE[sortBy] ?? SORTABLE.publishedAt;
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM resources ${clause}`).get(...params).n;
    const limit = Math.max(1, Math.min(100, Number(take) || 20));
    const offset = Math.max(0, Number(skip) || 0);
    const rows = this.db.prepare(
      `SELECT raw FROM resources ${clause} ORDER BY ${order} IS NULL, ${order} DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    return {
      rows: rows.map((row) => parseJson(row.raw, {})),
      total,
      hasMore: offset + rows.length < total,
    };
  }

  /**
   * Read one row by id.
   * @param id - the resource id.
   * @returns the stored row, or undefined.
   */
  get(id) {
    const row = this.db.prepare("SELECT raw FROM resources WHERE id = ?").get(id);
    return row === undefined ? undefined : parseJson(row.raw, undefined);
  }

  /**
   * Title suggestions for the search box.
   * @param query - the partial query.
   * @param limit - maximum suggestions.
   * @returns `{ id, type, title }` rows.
   */
  suggest(query, limit = 8) {
    if (typeof query !== "string" || query.trim() === "") return [];
    return this.db.prepare(
      "SELECT id, type, title FROM resources WHERE title LIKE ? ORDER BY published_at DESC LIMIT ?",
    ).all(`%${query.trim()}%`, Math.max(1, Math.min(20, limit)));
  }

  /**
   * Read one configuration value.
   * @param key - the setting key.
   * @param fallback - value returned when the key is unset.
   * @returns the parsed value.
   */
  getSetting(key, fallback) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row === undefined ? fallback : parseJson(row.value, fallback);
  }

  /**
   * Write one configuration value.
   * @param key - the setting key.
   * @param value - any JSON-serializable value.
   */
  setSetting(key, value) {
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, JSON.stringify(value));
  }

  /**
   * Read a cached transcript.
   * @param resourceId - the video's resource id.
   * @returns `{ language, text, fetchedAt }`, or undefined.
   */
  getTranscript(resourceId) {
    const row = this.db.prepare(
      "SELECT language, text, cues, fetched_at FROM transcripts WHERE resource_id = ?",
    ).get(resourceId);
    if (row === undefined) return undefined;
    return {
      language: row.language,
      text: row.text,
      cues: parseJson(row.cues, []),
      fetchedAt: row.fetched_at,
    };
  }

  /**
   * Cache one transcript.
   * @param resourceId - the video's resource id.
   * @param language - the track's language code.
   * @param text - the plain-text transcript.
   * @param cues - timed segments, kept so the reader can seek.
   */
  putTranscript(resourceId, language, text, cues = []) {
    this.db.prepare(`
      INSERT INTO transcripts (resource_id, language, text, cues, fetched_at) VALUES (?,?,?,?,?)
      ON CONFLICT(resource_id) DO UPDATE SET
        language = excluded.language, text = excluded.text,
        cues = excluded.cues, fetched_at = excluded.fetched_at
    `).run(resourceId, language, text, JSON.stringify(cues), new Date().toISOString());
  }

  /**
   * Read cached key moments.
   * @param resourceId - the video's resource id.
   * @returns the stored moments, or undefined when none were derived yet.
   */
  getKeyMoments(resourceId) {
    const row = this.db.prepare("SELECT moments FROM key_moments WHERE resource_id = ?").get(resourceId);
    return row === undefined ? undefined : parseJson(row.moments, undefined);
  }

  /**
   * Cache derived key moments.
   * @param resourceId - the video's resource id.
   * @param moments - `[{ at, title, summary }]`.
   */
  putKeyMoments(resourceId, moments) {
    this.db.prepare(`
      INSERT INTO key_moments (resource_id, moments, created_at) VALUES (?,?,?)
      ON CONFLICT(resource_id) DO UPDATE SET moments = excluded.moments, created_at = excluded.created_at
    `).run(resourceId, JSON.stringify(moments), new Date().toISOString());
  }

  /**
   * List a source's notes, newest first.
   * @param resourceId - the source id.
   * @returns `[{ id, atSeconds, body, createdAt }]`.
   */
  listNotes(resourceId) {
    return this.db.prepare(
      "SELECT id, at_seconds, body, created_at FROM notes WHERE resource_id = ? ORDER BY created_at DESC",
    ).all(resourceId).map((row) => ({
      id: row.id, atSeconds: row.at_seconds, body: row.body, createdAt: row.created_at,
    }));
  }

  /**
   * Add one note.
   * @param resourceId - the source id.
   * @param body - the note text.
   * @param atSeconds - playback position the note refers to, when any.
   * @returns the stored note.
   */
  addNote(resourceId, body, atSeconds) {
    const id = `note-${Date.now()}-${Math.floor(performance.now() * 1000) % 100000}`;
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO notes (id, resource_id, at_seconds, body, created_at) VALUES (?,?,?,?,?)")
      .run(id, resourceId, Number.isFinite(atSeconds) ? atSeconds : null, body, createdAt);
    return { id, atSeconds: Number.isFinite(atSeconds) ? atSeconds : null, body, createdAt };
  }

  /**
   * Delete one note.
   * @param id - the note id.
   * @returns true when a row was removed.
   */
  deleteNote(id) {
    return this.db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Source-host facets, mirroring the upstream `sources/facets` shape.
   * @param limit - maximum hosts.
   * @returns `[{ domain, count }]` descending by count.
   */
  facets(limit = 20) {
    const rows = this.db.prepare("SELECT source_url FROM resources").all();
    const counts = new Map();
    for (const row of rows) {
      let host;
      try {
        host = new URL(row.source_url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, limit);
  }
}
