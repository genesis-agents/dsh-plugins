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
  -- How long the recording is, for the types that have a length.
  --
  -- IT WAS ALREADY BEING FETCHED AND THROWN AWAY. dropShortVideos asks the
  -- watch page for lengthSeconds on every NEW video — one request each,
  -- deliberately budgeted — uses it to drop anything under the floor, and
  -- then discards the number. So the library enforced a duration rule it
  -- could not state, no screen could show a length, and no filter could name
  -- one, while the cost of knowing had already been paid.
  duration_seconds INTEGER,
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

-- Translated transcript blocks, one row per block per target language.
--
-- The language is part of the key. The reference keys its cache on the video
-- alone and stores the target language beside it as a plain column, so asking
-- for a second language silently discards the first one's work. Paying for a
-- translation twice because the key was too narrow is not a trade-off worth
-- inheriting.
--
-- Keyed on the block's start time rather than its ordinal: the merge that
-- turns cues into reading blocks can change with the merge rules, and an
-- ordinal would then point at the wrong line, whereas a timestamp still names
-- the same moment in the recording.
CREATE TABLE IF NOT EXISTS transcript_translations (
  resource_id TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  block_start REAL NOT NULL,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (resource_id, target_lang, block_start)
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

/**
 * Rehydrate a stored row, letting columns win over the snapshot.
 *
 * `raw` is what the source handed us at collection time and is kept so a
 * column can be backfilled later without re-fetching. But it is a SNAPSHOT:
 * anything written to a column afterwards — a thumbnail found by looking at
 * the page — is invisible if the row is served from `raw` alone. That is
 * exactly what happened: every enriched image was stored correctly and never
 * reached the page, because reads went through `raw`.
 * @param row - `{ raw, ...columns }` from a SELECT.
 * @returns the resource, with column values layered on top.
 */
function withColumns(row) {
  const base = parseJson(row.raw, {});
  const thumbnail = row.thumbnail_url;
  if (typeof thumbnail === "string" && thumbnail !== "") base.thumbnailUrl = thumbnail;
  else if (thumbnail === null) delete base.thumbnailUrl;
  // Collected rows carry no `createdAt` in the snapshot — the column is set by
  // `put` at write time, and is what `sortBy: "createdAt"` orders on. Serving
  // the row without it hands the page a list ordered by a field it cannot see,
  // so anything asking "what arrived since X" silently compares undefined.
  if (typeof row.created_at === "string") base.createdAt = row.created_at;
  // Length is a COLUMN fact, not a snapshot one: it is learned from the watch
  // page after the feed row was parsed, so `raw` never carries it. Served from
  // `raw` alone every duration in the library would be invisible — the exact
  // shape of the thumbnail bug this function was written for.
  if (row.duration_seconds !== undefined && row.duration_seconds !== null) {
    base.durationSeconds = Number(row.duration_seconds);
  }
  return base;
}

/**
 * A duration in whole seconds, or null for "not known".
 *
 * NULL AND ZERO ARE DIFFERENT ANSWERS and both reach here. A row collected
 * before the column existed knows nothing about its length; a lookup that
 * failed also knows nothing — and `dropShortVideos` keeps that video on
 * purpose, because a network error is not evidence that something is short.
 * Coercing either to 0 would make every one of them shorter than any floor a
 * reader sets, so a length filter would quietly delete the back catalogue.
 * @param value - the reported length.
 * @returns whole seconds above zero, or null.
 */
function durationOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
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
    // `thumbnail_checked_at` records that a row's page was looked at, whether
    // or not an image came back. Without it a row whose page simply has no
    // image is re-fetched on every pass, forever — which is what the reference
    // does: it never persists a negative, so its only memory of a failure is a
    // Map in one browser tab.
    const resourceColumns = this.db.prepare("PRAGMA table_info(resources)").all();
    if (!resourceColumns.some((column) => column.name === "thumbnail_checked_at")) {
      this.db.exec("ALTER TABLE resources ADD COLUMN thumbnail_checked_at TEXT");
    }
    // In place rather than a version bump, for `cues`' reason: an existing
    // library may be the only copy of a migrated corpus. Rows written before
    // this column existed carry NULL — which is "not known", not "zero", and
    // every reader below has to keep those apart or a filter on length would
    // silently exclude the whole back catalogue.
    if (!resourceColumns.some((column) => column.name === "duration_seconds")) {
      this.db.exec("ALTER TABLE resources ADD COLUMN duration_seconds INTEGER");
    }
    // `key_moments` backed a panel that was removed: the reference's own key
    // moments are hardcoded placeholders, and the video description turned out
    // to be the thing worth showing instead. Dropping it here rather than
    // leaving a table nothing writes to — an empty table with no reader is a
    // standing invitation to wonder what it was for.
    this.db.exec("DROP TABLE IF EXISTS key_moments");
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
        comment_count, source_type, normalized_url, duration_seconds, raw, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type, title = excluded.title, abstract = excluded.abstract,
        ai_summary = excluded.ai_summary, source_url = excluded.source_url,
        -- COALESCE, not overwrite: a thumbnail found by looking at the page is
        -- worth more than the nothing the feed carries, and the hourly
        -- collection re-writes every row it still sees. Plain assignment would
        -- erase the enrichment on the next cycle, so the work would be redone
        -- forever and the image would flicker in and out of the feed.
        thumbnail_url = COALESCE(excluded.thumbnail_url, resources.thumbnail_url),
        authors = excluded.authors,
        categories = excluded.categories, published_at = excluded.published_at,
        quality_score = excluded.quality_score, trending_score = excluded.trending_score,
        upvote_count = excluded.upvote_count, comment_count = excluded.comment_count,
        source_type = excluded.source_type, normalized_url = excluded.normalized_url,
        -- COALESCE, for the thumbnail's reason and one sharper. A length costs a
        -- request and is only paid for on a video the library has never seen,
        -- so the hourly re-write of a row it already holds carries no duration
        -- at all. Plain assignment would erase the number on the next poll and
        -- there would be no second chance to learn it: the lookup is gated on
        -- the row being NEW.
        duration_seconds = COALESCE(excluded.duration_seconds, resources.duration_seconds),
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
      durationOrNull(row.durationSeconds),
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
  query({ type, search, sortBy, sortOrder, createdAfter, publishedAfter, minDurationSeconds, take = 20, skip = 0 } = {}) {
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
    // A watermark filter in SQL rather than in the caller. The insight scan
    // walks forward from the oldest unread row; filtering after the fact means
    // paging through everything already read to find the first row that is not
    // — which on a full library is the whole library, every pass.
    if (typeof createdAfter === "string" && createdAfter !== "") {
      where.push("created_at > ?");
      params.push(createdAfter);
    }
    // A LENGTH FLOOR THAT KEEPS THE UNKNOWNS. `duration_seconds IS NULL` means
    // nobody ever asked the watch page — every row collected before the column
    // existed, every non-video, and every video whose lookup failed. Written as
    // a plain `>= ?` SQLite drops all of them, so "only videos over 20 minutes"
    // would return nothing at all on a library whose back catalogue predates
    // this column, and would look exactly like a filter that works over a
    // library with nothing in it.
    //
    // The floor therefore excludes only rows KNOWN to be shorter. A caller who
    // wants "known to be long" has to say so, and none does yet.
    // WHEN THE THING HAPPENED, which is a different question from when this
    // library learned of it. `createdAfter` is the drain's watermark — where
    // the reader got to — and it says nothing about whether a row is worth
    // reading now: a 2009 comparison harvested this morning is new by that
    // measure and old by every measure a person uses.
    //
    // COALESCE, because `published_at` is nullable. A feed that carries no date
    // would otherwise be excluded by every window, silently and for ever;
    // falling back to `created_at` treats "we do not know when this was
    // published" as "as old as our knowledge of it", which is the honest
    // reading and the one that keeps the row reachable.
    if (typeof publishedAfter === "string" && publishedAfter !== "") {
      where.push("COALESCE(published_at, created_at) >= ?");
      params.push(publishedAfter);
    }
    const floor = Number(minDurationSeconds);
    if (Number.isFinite(floor) && floor > 0) {
      where.push("(duration_seconds IS NULL OR duration_seconds >= ?)");
      params.push(Math.round(floor));
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const order = SORTABLE[sortBy] ?? SORTABLE.publishedAt;
    // Ascending is opt-in and everything else keeps newest-first. A reader
    // looks at the top of a feed; only the insight drain wants the other end,
    // and it wants it because taking the NEWEST rows and then watermarking
    // past them makes every older row permanently invisible.
    const direction = sortOrder === "asc" ? "ASC" : "DESC";
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM resources ${clause}`).get(...params).n;
    const limit = Math.max(1, Math.min(100, Number(take) || 20));
    const offset = Math.max(0, Number(skip) || 0);
    const rows = this.db.prepare(
      `SELECT raw, thumbnail_url, created_at, duration_seconds FROM resources ${clause} ORDER BY ${order} IS NULL, ${order} ${direction} LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    return {
      rows: rows.map(withColumns),
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
    const row = this.db.prepare("SELECT raw, thumbnail_url, created_at, duration_seconds FROM resources WHERE id = ?").get(id);
    return row === undefined ? undefined : withColumns(row);
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
   * Videos held that no transcript has ever been stored for.
   *
   * THE NUMBER THAT EXPLAINS A PASS READING TEN SOURCES OUT OF TWO HUNDRED.
   * It has been computable since videos were first collected and appeared
   * nowhere: not on the 信源 tab, not in the pass's summary, not in a log. The
   * insight scan skips these correctly and for a stated reason, so the whole
   * system behaved as designed while reading 5% of the library.
   *
   * A LEFT JOIN RATHER THAN `NOT IN (SELECT ...)`. The subquery form makes the
   * count silently zero the moment a NULL reaches it, which on this schema it
   * cannot today and could the first time `transcripts` gains a nullable key —
   * a check that passes while the thing it checks is broken.
   * @returns the count.
   */
  countVideosWithoutTranscript() {
    return this.db.prepare(`
      SELECT COUNT(*) AS n
        FROM resources r
        LEFT JOIN transcripts t ON t.resource_id = r.id
       WHERE r.type IN ('YOUTUBE_VIDEO','YOUTUBE','VIDEO','PODCAST')
         AND (t.resource_id IS NULL OR t.text = '')
    `).get().n;
  }

  /**
   * Videos waiting on a transcript, oldest first.
   *
   * OLDEST FIRST, matching the insight scan's own drain order. A backlog worked
   * from the newest end leaves the tail permanently unread, which is the exact
   * trade `collectCandidates` documents at length and reverses for the same
   * reason: rows nothing ever reaches are rows nobody knows are missing.
   * @param limit - how many to name.
   * @returns `[{ id, title, type, sourceUrl }]`.
   */
  videosWithoutTranscript(limit = 20) {
    const take = Math.max(1, Math.min(200, Number(limit) || 20));
    return this.db.prepare(`
      SELECT r.id, r.title, r.type, r.source_url AS sourceUrl
        FROM resources r
        LEFT JOIN transcripts t ON t.resource_id = r.id
       WHERE r.type IN ('YOUTUBE_VIDEO','YOUTUBE','VIDEO','PODCAST')
         AND (t.resource_id IS NULL OR t.text = '')
       ORDER BY r.created_at ASC
       LIMIT ?
    `).all(take);
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
   * How many rows were created at or after a moment.
   *
   * Compared as ISO text against ISO text. SQLite's own `datetime('now')`
   * renders `YYYY-MM-DD HH:MM:SS` with a space where the stored values have a
   * `T`, and `'T' > ' '`, so mixing the two makes every row stored today look
   * newer than any such bound — a comparison that fails by over-reporting,
   * silently.
   * @param since - an ISO 8601 instant.
   * @returns the count.
   */
  countCreatedSince(since) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM resources WHERE created_at >= ?").get(since).n;
  }

  /**
   * Rows whose page has not been looked at for an image yet.
   *
   * Ordered newest first, because a reader looks at the top of the feed and a
   * backfill that starts at the oldest row spends its whole budget where
   * nobody is looking.
   * @param limit - how many to return.
   * @param types - resource types to consider.
   * @returns `[{ id, sourceUrl }]`.
   */
  rowsNeedingThumbnail(limit, types) {
    const placeholders = types.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT id, source_url AS sourceUrl FROM resources
      WHERE (thumbnail_url IS NULL OR thumbnail_url = '')
        AND thumbnail_checked_at IS NULL
        AND source_url LIKE 'http%'
        AND type IN (${placeholders})
      ORDER BY published_at DESC
      LIMIT ?
    `).all(...types, limit);
  }

  /**
   * Whether this row's page has already been looked at for an image.
   *
   * The point of recording a negative is that it survives the session. Without
   * consulting it, a page that genuinely has no image is re-fetched every time
   * its card appears in a fresh tab — which is the reference's behaviour, its
   * only memory of a failure being a Map in one browser.
   * @param id - the resource id.
   * @returns true when the page has been checked.
   */
  thumbnailChecked(id) {
    const row = this.db.prepare("SELECT thumbnail_checked_at FROM resources WHERE id = ?").get(id);
    return row !== undefined && row.thumbnail_checked_at !== null;
  }

  /**
   * Record the outcome of looking at one row's page.
   * @param id - the resource id.
   * @param url - the image found, or an empty string for none.
   */
  markThumbnailChecked(id, url) {
    const now = new Date().toISOString();
    if (typeof url === "string" && url !== "") {
      this.db.prepare("UPDATE resources SET thumbnail_url = ?, thumbnail_checked_at = ? WHERE id = ?").run(url, now, id);
      return;
    }
    this.db.prepare("UPDATE resources SET thumbnail_checked_at = ? WHERE id = ?").run(now, id);
  }

  /**
   * How many rows already carry this exact image.
   *
   * A site that serves one image for every page — arXiv answers every paper
   * with its own logo — is only detectable by noticing the repetition. Naming
   * such sites in a blocklist, which is what the reference does, only ever
   * covers the ones already discovered.
   * @param url - a candidate image URL.
   * @returns the count of rows holding it.
   */
  countThumbnailUse(url) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM resources WHERE thumbnail_url = ?").get(url).n;
  }

  /**
   * Read every cached translation for one video in one language.
   * @param resourceId - the video's resource id.
   * @param targetLang - the target language code.
   * @returns `[{ start, text }]` ordered by position in the recording.
   */
  getTranslations(resourceId, targetLang) {
    return this.db.prepare(`
      SELECT block_start AS start, text FROM transcript_translations
      WHERE resource_id = ? AND target_lang = ?
      ORDER BY block_start
    `).all(resourceId, targetLang);
  }

  /**
   * Store translated blocks, replacing any row for the same block.
   *
   * Written in one transaction so a batch that fails midway leaves no partial
   * row set behind — a half-written batch would read as "already translated"
   * on the next pass and the gap would never be filled.
   * @param resourceId - the video's resource id.
   * @param targetLang - the target language code.
   * @param rows - `[{ start, text }]` for the blocks just translated.
   */
  putTranslations(resourceId, targetLang, rows) {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO transcript_translations (resource_id, target_lang, block_start, text, created_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(resource_id, target_lang, block_start) DO UPDATE SET
        text = excluded.text, created_at = excluded.created_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        if (typeof row?.start !== "number" || typeof row?.text !== "string" || row.text === "") continue;
        statement.run(resourceId, targetLang, row.start, row.text, now);
      }
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
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
