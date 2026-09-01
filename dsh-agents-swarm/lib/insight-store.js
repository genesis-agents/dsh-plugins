/**
 * 洞察 storage: every SQL statement the insight pass runs, and nothing else.
 *
 * This module owns no database handle. It is constructed over the existing
 * `SourceStore` and writes through `store.db`, so a library stays one portable
 * file with one WAL, one connection and one `PRAGMA user_version` — which this
 * module never writes. store.js stamps 1 and throws
 * "source store: unsupported schema version N" for anything else at open, so a
 * second module bumping the stamp would make every existing library refuse to
 * open at the NEXT boot, on somebody else's machine, presenting as a corrupt
 * database rather than as a schema mismatch. `CREATE TABLE IF NOT EXISTS` is
 * the whole migration story here, exactly as store.js does for `notes` and
 * `transcripts`.
 *
 * No model calls, no HTTP, and no clock beyond `new Date().toISOString()` for
 * write stamps. The scoring that needs the present takes `now` as a parameter
 * and lives in insights.js.
 *
 * IMPORT DIRECTION: insights.js imports the frozen vocabularies from here.
 * This module must never import insights.js — a cycle between the pure stage
 * functions and the storage layer would make both untestable in isolation, and
 * duplicating the arrays instead lets them drift apart silently.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

/**
 * The schema, as one executable string. Exported so a test can build a scratch
 * `new DatabaseSync(':memory:')` and exercise every query without a
 * SourceStore. Contains no `PRAGMA` of any kind, deliberately — see the module
 * comment.
 */
/**
 * What one pass can conclude about one source, in order of concern.
 *
 * THE ORDER IS THE CONTRACT, not a preference: `passLedger` sorts by position
 * in this array, because a reader opening a pass's account is asking what went
 * wrong, and a failure sorted alphabetically among two hundred successes is a
 * failure nobody finds.
 *
 * - `failed`        the model call for its cluster threw. It carries a reason.
 * - `no-transcript` a video the library holds no transcript for. Skipped
 *                   before the model sees it, because a title and a blurb
 *                   cannot produce a checkable quote — the correct behaviour,
 *                   and the one that was previously invisible.
 * - `unusable`      no title or no body the clusterer could use at all.
 * - `binned`        clustered, then lost the ceiling. NOT a loss: the
 *                   watermark does not cover it and it returns next pass.
 * - `read`          shown to the model, which found nothing worth keeping.
 *                   The commonest honest outcome and not a fault.
 * - `extracted`     produced at least one claim that survived verification.
 */
export const PASS_STATES = ["failed", "no-transcript", "unusable", "binned", "read", "extracted"];

/**
 * How many passes' ledgers to keep.
 *
 * A pass writes up to `insightMaxRows` entries and runs as often as the
 * collection tick, so an unpruned ledger grows by roughly 1.7 million rows a
 * year to serve a screen that shows the latest batch. Twenty is a fortnight of
 * hourly passes at the point anybody is still asking "what did it do".
 */
export const LEDGER_BATCHES = 20;

/**
 * Longest attribution this store will keep.
 *
 * A name and a role -- "Jensen Huang, Nvidia" -- is about twenty characters.
 * This is a CEILING, not a target: a model that answers the speaker field with
 * a sentence has not given a name. Duplicated from the extractor's own bound
 * on purpose, because a store that trusts its caller to have checked is a
 * store with no bound at all the first time a second caller appears.
 */
export const MAX_SPEAKER_CHARS = 80;

export const INSIGHT_DDL = `
-- ── 洞察 ────────────────────────────────────────────────────────────────
-- Lives in the SAME database file as \`resources\`, created by InsightStore over
-- the SourceStore's own handle.

-- A standing claim with provenance. Not a document and not a summary: the row
-- persists across passes and accrues evidence, which is the entire difference
-- between this and the daily digest that already exists.
CREATE TABLE IF NOT EXISTS insights (
  id                  TEXT PRIMARY KEY,
  statement           TEXT NOT NULL,     -- one sentence, the claim itself
  kind                TEXT NOT NULL,     -- launch | funding | policy | finding | shift
  -- energy | compute | model | application | cross, or NULL for a row written
  -- before the extractor was asked for one. See INSIGHT_LAYERS.
  layer               TEXT,
  entities            TEXT,              -- JSON array, who/what it is about
  status              TEXT NOT NULL,     -- candidate | standing | contested | dormant
  -- A person's own verdict on this card, and it OUTRANKS the pass. Without it
  -- "dismiss" is a button that works until the next pass runs and silently
  -- undoes it, which is the failure mode this repo keeps producing: a control
  -- that reports success while the thing it controls reverts.
  pinned_status       TEXT,
  -- 64-bit simhash of the statement, 16 lowercase hex characters. Stored so
  -- reconciliation can find near-identical standing claims without a model
  -- call and without re-shingling every row on every pass.
  simhash             TEXT NOT NULL,
  first_seen_at       TEXT NOT NULL,     -- ISO 8601, as every timestamp here
  last_seen_at        TEXT NOT NULL,
  source_count        INTEGER NOT NULL DEFAULT 0,
  independent_count   INTEGER NOT NULL DEFAULT 0,   -- distinct sources, not articles
  contradiction_count INTEGER NOT NULL DEFAULT 0,
  -- The four tests, stored rather than recomputed on read: the list route
  -- orders by them and an ORDER BY over an expression cannot use an index.
  novelty             REAL NOT NULL DEFAULT 0,
  relevance           REAL NOT NULL DEFAULT 0,
  credibility         REAL NOT NULL DEFAULT 0,
  momentum            REAL NOT NULL DEFAULT 0,
  rank_score          REAL NOT NULL DEFAULT 0,       -- the weighted blend, the default sort
  -- When the four were last computed. Novelty decays with the wall clock, so a
  -- stored score with no stamp cannot be told from a fresh one — a tab that
  -- has been ranking on month-old novelty looks exactly like a working tab.
  scored_at           TEXT,
  -- ONE SENTENCE ON WHAT THE CLAIM MEANS, and the only field on this row that
  -- is not checkable against a quote. The statement is verified, every quote
  -- is verified character for character, the speaker must be stated in the
  -- block -- this is a READING, and every surface that renders it has to
  -- present it as one rather than beside them as another fact.
  --
  -- NULL-able and never required: the prompt asks the model to omit it rather
  -- than speculate, and a claim must not be discarded for taking that
  -- instruction.
  gloss               TEXT,
  supersedes          TEXT,              -- id of the claim this replaced
  updated_at          TEXT NOT NULL
) STRICT;

-- One row per (claim, source). \`stance\` is what makes disagreement a
-- first-class object rather than an inconvenience.
CREATE TABLE IF NOT EXISTS insight_evidence (
  insight_id    TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  stance        TEXT NOT NULL,           -- supports | contradicts | context
  quote         TEXT NOT NULL,           -- verbatim, verified against the block the model was shown
  -- The independence key, denormalised on purpose. \`independent_count\` means
  -- DISTINCT SOURCES, and deriving it by joining back to \`resources\` makes the
  -- count silently drop every row whose resource has since been pruned — the
  -- number would fall, the card would demote itself from standing to
  -- candidate, and nothing anywhere would report an error. Copied at write
  -- time it stays true regardless of what happens to the library.
  source_key    TEXT NOT NULL,
  -- Denormalised for exactly the same reason, and it is the same failure:
  -- credibility is weighted by resource type, so reading the type through the
  -- join means a pruned PAPER (weight 1.0) silently becomes an unknown type
  -- (0.4) and the claim it backed drops down the list with nothing reporting
  -- anything wrong. Empty string when the type was not known at write time,
  -- which \`stats()\` counts so the gap is visible rather than assumed away.
  resource_type TEXT NOT NULL DEFAULT '',
  -- WHO SAID IT, when the source block itself says so.
  --
  -- On the EVIDENCE and not on the claim, because a claim with three sources
  -- has three speakers, and folding them onto the claim would put one name
  -- under sentences the other two people said. It is the same reason the
  -- source_key column lives here.
  --
  -- Only ever what the block states: an interviewer naming their guest, a
  -- transcript line attributing a sentence, an article quoting somebody by
  -- name. Never inferred from the channel or the title, because a name under
  -- a sentence is an attribution and a wrong attribution is worse than none.
  speaker       TEXT,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (insight_id, resource_id)
) STRICT;

-- No FOREIGN KEY on \`resource_id\`, matching \`notes\` beside it: store.js turns
-- foreign keys ON at open, so a constraint here would make an ordinary library
-- prune fail at the DELETE rather than merely leaving an evidence row pointing
-- at nothing. The routes already render a missing resource as
-- \`resource: null\`, which is the honest answer.
--
-- (This string is deliberately free of the word that names a SQLite directive,
-- comments included: the rule that this DDL executes no such directive is one
-- a reviewer checks with a grep, and a comment that trips it costs more than
-- the rewording.)

-- ── what one pass did to each source it looked at ────────────────────────
--
-- WHY A LEDGER AND NOT A COUNTER. The pass already reported five aggregate
-- numbers — rows, unusable, binned, clusters, failures — and every one of them
-- answers "how many" for a question whose only useful form is "which one".
-- A pass that reads two hundred sources and writes three claims is either
-- working perfectly on a quiet week or silently dropping a hundred and ninety
-- videos for want of a transcript, and the aggregates report those two
-- identically.
--
-- MEASURED, on the library this was built against: 523 videos held, 23
-- transcripts. The scan skips a video it holds no transcript for — correctly,
-- since a title and a blurb cannot produce a checkable quote — and said
-- nothing at all about the other five hundred. They were not counted as read,
-- not counted as unusable, not counted as binned, and not in any error. They
-- were simply absent, which is the shape of loss this repository keeps
-- re-shipping.
--
-- ONE ROW PER SOURCE PER PASS. The batch is the run's own timestamp, so a
-- pass is a unit a reader can ask about: what did the 09:00 run actually read.
CREATE TABLE IF NOT EXISTS insight_pass_rows (
  batch            TEXT NOT NULL,       -- the run's ISO stamp
  resource_id      TEXT NOT NULL,
  title            TEXT NOT NULL,
  resource_type    TEXT NOT NULL,
  duration_seconds INTEGER,             -- NULL when nobody ever asked
  -- extracted | read | unusable | binned | failed | no-transcript
  state            TEXT NOT NULL,
  -- WHY, AS A CODE. The words belong to the page, not to the database.
  --
  -- The first version wrote sentences here, and half of them were written in
  -- Chinese: "这个视频没有字幕可取" beside "over this pass's cluster ceiling".
  -- A localized string baked into a stored row can never be shown in the other
  -- language, so the ledger was permanently half-translated for every reader
  -- whichever language they had chosen. Every other vocabulary in this feature
  -- is a code with a face table beside it; this one had simply been written by
  -- hand at each call site.
  reason_code      TEXT,
  -- Free-form detail that is NOT ours to translate: the transcript provider's
  -- own error text, a model's refusal. Rendered after the code's sentence.
  reason           TEXT,
  claims           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch, resource_id)
) STRICT;

-- The ledger is read one batch at a time, newest first, and pruned by batch.
CREATE INDEX IF NOT EXISTS ix_insight_pass_batch ON insight_pass_rows(batch DESC);

-- ── indexes the routes actually make queries against ─────────────────────
-- \`/insights/list\` default and \`?status=\`: filtered, ordered by rank.
--
-- A single \`?status=\` is the one query this serves end to end — one index
-- range, already in rank order, no sort. The DEFAULT page spells its clause as
-- \`status IN ('candidate','standing','contested')\` instead of
-- \`status != 'dormant'\`, and the reason is NOT that the IN avoids a sort: it
-- does not. Measured on this schema, three-value IN = three index ranges plus a
-- temp b-tree over the live rows; \`!= 'dormant'\` = an ordered walk of
-- ix_insights_rank with no sort at all. The IN wins anyway because of what
-- each one's cost is proportional to:
--   live=200  dormant=0       IN 0.053ms   != 0.013ms
--   live=200  dormant=5000    IN 0.056ms   != 0.359ms
--   live=200  dormant=50000   IN 0.054ms   != 4.202ms
-- The IN is flat in the dormant pile; the walk pays for every dormant row it
-- steps over to find twenty live ones. Dormant grows for the life of the
-- library and nothing prunes it, while the live set is precisely what
-- insightMinIndependent exists to cap — so the IN's cost is bounded by the
-- thing under control and the walk's is bounded by the thing that is not.
-- (The inverse case is real: at live=5000 the IN costs 1.5ms. A live set that
-- large means the sprawl control has failed, and that is the number to fix.)
CREATE INDEX IF NOT EXISTS ix_insights_status_rank ON insights(status, rank_score DESC);
-- \`?sort=rank\` unfiltered.
CREATE INDEX IF NOT EXISTS ix_insights_rank        ON insights(rank_score DESC);
-- \`?kind=\` chips.
CREATE INDEX IF NOT EXISTS ix_insights_kind_seen   ON insights(kind, last_seen_at DESC);
-- \`?filter=new\` (first-seen window) and \`?filter=dormant\` / \`?sort=recent\`.
CREATE INDEX IF NOT EXISTS ix_insights_first_seen  ON insights(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS ix_insights_last_seen   ON insights(last_seen_at DESC);
-- \`?filter=contested\`, and the rescore sweep's "scored before X" scan. NULLs
-- sort first in an ASC index, which is what dueForRescore wants: a row that
-- has never been scored is the most urgent one.
CREATE INDEX IF NOT EXISTS ix_insights_contested   ON insights(contradiction_count DESC, rank_score DESC)
  WHERE contradiction_count > 0;
CREATE INDEX IF NOT EXISTS ix_insights_scored      ON insights(scored_at);
-- Walking a supersedes chain forwards, for the detail view's history.
CREATE INDEX IF NOT EXISTS ix_insights_supersedes  ON insights(supersedes)
  WHERE supersedes IS NOT NULL;
-- \`/insights/for-resource/{id}\`: which claims cite this source. Reading by
-- insight_id alone needs no index — the primary key's leading column covers it.
CREATE INDEX IF NOT EXISTS ix_insight_evidence_resource ON insight_evidence(resource_id, added_at DESC);
-- The card preview asks for supporting rows and contradicting rows separately.
CREATE INDEX IF NOT EXISTS ix_insight_evidence_stance   ON insight_evidence(insight_id, stance, added_at DESC);
`;

/**
 * The only values `insights.kind` may hold. A CLAIM kind — not a resource
 * type. The two vocabularies are both spelt "kind" upstream and mixing them
 * scores every card's relevance at zero forever without throwing, so the
 * resource-type setting is named `insightResourceTypes` and never touches this
 * list.
 */
export const INSIGHT_KINDS = Object.freeze(["launch", "funding", "policy", "finding", "shift"]);

/** The only values `insights.status` and `insights.pinned_status` may hold. */
export const INSIGHT_STATUSES = Object.freeze(["candidate", "standing", "contested", "dormant"]);

/**
 * Where in the stack a claim sits — the layer, not the kind and not the status.
 *
 * THREE VOCABULARIES, THREE QUESTIONS, and they were being read as one.
 * `kind` is what a claim is ABOUT (something shipped, money moved, a result
 * measured). `status` is how far it has GOT (nobody has corroborated it yet,
 * two independent sources have, something contradicts it). Neither answers
 * the question a reader of this library actually opens it with, which is
 * WHAT PART OF THE STACK — and grouping by `kind` put a claim about a data
 * centre's capex next to one about a model's licence because both happened
 * to be measurements.
 *
 * THE STACK, NOT A TOPIC TREE. Five layers, and the fifth is the honest
 * escape: a claim about open weights changing compute demand is not in the
 * model layer or the compute layer, it is the relationship between them, and
 * filing it under either loses exactly what makes it worth reading.
 *
 * NULL IS A VALUE. Every row written before this column existed has no layer
 * and cannot be given one without a model call; the pane groups those under
 * their own heading rather than guessing, which is also what tells a reader
 * how much of the table predates the classification.
 */
export const INSIGHT_LAYERS = Object.freeze(["energy", "compute", "model", "application", "cross"]);

/** The only values `insight_evidence.stance` may hold. */
export const EVIDENCE_STANCES = Object.freeze(["supports", "contradicts", "context"]);

/** Statuses the default list page shows. Spelt as a set, not as `!= dormant`. */
const LIVE_STATUSES = Object.freeze(["candidate", "standing", "contested"]);

/** Columns a caller may sort by, mapped to their SQL expression. */
const SORTABLE = {
  rank: "rank_score",
  recent: "last_seen_at",
  new: "first_seen_at",
  momentum: "momentum",
  credibility: "credibility",
  sources: "source_count",
};

/** Shape of an id this module mints; the routes reject anything else. */
const ID_PATTERN = /^insight-[0-9A-Za-z]+-[0-9a-f]{8}$/;

/** 16 lowercase hex characters, the stored simhash. */
const SIMHASH_PATTERN = /^[0-9a-f]{16}$/;

/** ISO 8601 with a `T` and a zone, which is what `toISOString` produces. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** One InsightStore per SourceStore; see openInsightStore. */
const STORES = new WeakMap();

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
 * The `entities` column as an array, whatever the column actually holds.
 *
 * Tolerant on purpose: a malformed JSON column must not throw a whole page,
 * and an entity list is decoration on a claim rather than part of it. Callers
 * that compare entity sets get an array either way, which is the thing that
 * matters — `statementsMatch` computing an overlap over a raw JSON *string*
 * returns 0 for every pair forever and no third test ever fires.
 */
function entitiesOf(text) {
  const parsed = parseJson(text, []);
  return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
}

/** JSON text for an entity list, or null. */
function entitiesJson(value) {
  if (!Array.isArray(value)) return null;
  const names = value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
  return names.length === 0 ? null : JSON.stringify(names);
}

/** Reject a value outside a fixed vocabulary, naming what was accepted. */
function assertMember(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
  }
}

/**
 * Reject a timestamp SQLite would happily store and every reader would then
 * misread.
 *
 * STRICT enforces TEXT and nothing more, so "yesterday" is a valid value for a
 * timestamp column. `daysBetween` answers 0 for an unparseable date, novelty
 * over a zero age is 1 — the maximum — and the dormancy test never fires, so
 * one corrupt row pins itself to the top of the default sort permanently.
 * Checked here because this is the only place those columns are written.
 */
function assertIso(value, field) {
  if (typeof value !== "string" || !ISO_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO 8601 instant like 2026-01-31T09:00:00.000Z; got ${JSON.stringify(value)}`);
  }
}

/** Clamp to 0..1, refusing a non-finite score by name. */
function clampScore(value, field) {
  const parsed = Number(value);
  // Rejected rather than coerced: a NaN written to `rank_score` sorts the whole
  // tab into an arbitrary order, every SELECT still returns rows, and no page
  // reports anything wrong. `Number(undefined)` is NaN, so a caller that
  // simply forgot a field is caught here too.
  if (!Number.isFinite(parsed)) throw new Error(`score ${field} must be a finite number; got ${JSON.stringify(value)}`);
  return Math.max(0, Math.min(1, parsed));
}

/** An integer within bounds, for take/limit style parameters. */
function clampInt(value, low, high, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(low, Math.min(high, Math.trunc(parsed)));
}

/** `now` shifted back by whole days, as ISO text. */
function isoDaysBefore(nowIso, days) {
  const at = Date.parse(nowIso);
  if (!Number.isFinite(at)) throw new Error(`window start needs a parseable now; got ${JSON.stringify(nowIso)}`);
  return new Date(at - days * 86400000).toISOString();
}

/**
 * Turn one `insights` row into the camelCase shape every reader uses.
 *
 * Three status fields, not two, and never one coalesced field called `status`:
 * `status` is the pass's own verdict and the column that filtering and the
 * chip counts run against, `pinnedStatus` is a person's, and
 * `effectiveStatus` is what the card renders. Collapsing them made the list
 * and the detail page report different statuses for the same row out of the
 * same database, with nothing to say which was right.
 */
function shapeInsight(row) {
  const pinned = row.pinned_status ?? null;
  return {
    id: row.id,
    statement: row.statement,
    kind: row.kind,
    // NULL FOR EVERY ROW WRITTEN BEFORE THE EXTRACTOR WAS ASKED FOR ONE, and
    // the pane files those under their own heading rather than guessing at
    // one — which is also how a reader sees how much of the table predates
    // the field.
    layer: row.layer ?? null,
    // A READING, NOT A FACT, and every surface that renders it has to say so.
    // Null for every row written before the extractor was asked for one, and
    // null again whenever the model declined — which the prompt asks it to do
    // rather than speculate.
    gloss: row.gloss ?? null,
    entities: entitiesOf(row.entities),
    status: row.status,
    pinnedStatus: pinned,
    effectiveStatus: pinned ?? row.status,
    simhash: row.simhash,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    sourceCount: row.source_count,
    independentCount: row.independent_count,
    contradictionCount: row.contradiction_count,
    novelty: row.novelty,
    relevance: row.relevance,
    credibility: row.credibility,
    momentum: row.momentum,
    rankScore: row.rank_score,
    scoredAt: row.scored_at ?? null,
    supersedes: row.supersedes ?? null,
    updatedAt: row.updated_at,
  };
}

/** Every column shapeInsight reads, so no reader is served a half row. */
const INSIGHT_COLUMNS = `
  id, statement, kind, layer, gloss, entities, status, pinned_status, simhash,
  first_seen_at, last_seen_at, source_count, independent_count, contradiction_count,
  novelty, relevance, credibility, momentum, rank_score, scored_at, supersedes, updated_at
`;

/**
 * A sortable, collision-resistant insight id, mirroring `documentId`.
 *
 * Exported so the extractor can mint an id BEFORE writing, which is what lets
 * it set `supersedes` on the new row and link the old one in the same
 * transaction.
 * @param at - the creation instant.
 * @returns `insight-<YYYYMMDDTHHMMSSZ>-<8 hex>`.
 */
export function newInsightId(at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `insight-${stamp}-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`;
}

/**
 * Whether a string is an id this module could have minted.
 * @param id - a candidate id, typically off a URL.
 * @returns true when it matches the mint pattern.
 */
export function isInsightId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * The one InsightStore for this SourceStore, memoised on the instance.
 *
 * Both the routes and the timer call this. Memoised rather than constructed
 * twice because construction runs the DDL, and while `CREATE TABLE IF NOT
 * EXISTS` is idempotent, two instances would be two places to look when a
 * statement is wrong.
 * @param store - the open SourceStore.
 * @returns the InsightStore layered over its handle.
 */
export function openInsightStore(store) {
  if (store === null || typeof store !== "object" || store.db === undefined) {
    throw new TypeError("openInsightStore needs the SourceStore, not a path");
  }
  const existing = STORES.get(store);
  if (existing !== undefined) return existing;
  const created = new InsightStore(store);
  STORES.set(store, created);
  return created;
}

/** 洞察 rows, layered over the source library's own database handle. */
export class InsightStore {
  /**
   * Create the insight tables over an open SourceStore.
   * @param store - the SourceStore whose `db` handle this shares.
   */
  constructor(store) {
    if (store === null || typeof store !== "object" || !(store.db instanceof DatabaseSync)) {
      throw new TypeError("openInsightStore needs the SourceStore, not a path");
    }
    this.store = store;
    this.db = store.db;
    this.db.exec(INSIGHT_DDL);
    // ONE COLUMN, ADDED IN PLACE. `CREATE TABLE IF NOT EXISTS` is this
    // module's whole migration story — see the file's own note — and it does
    // nothing for a table that already exists. Every library in the world
    // already has `insights`, so a new column has to be added rather than
    // declared, exactly as store.js does for `transcripts.cues`.
    const claimColumns = this.db.prepare("PRAGMA table_info(insights)").all();
    if (claimColumns.length > 0 && !claimColumns.some((column) => column.name === "layer")) {
      this.db.exec("ALTER TABLE insights ADD COLUMN layer TEXT");
    }
    // `resource_type` was added after the column list above was first settled.
    // Adding it in place rather than bumping any version keeps an existing
    // library readable, exactly as store.js does for `cues`. NOT NULL needs a
    // DEFAULT on ADD COLUMN, and '' is the honest value for rows written
    // before the column existed — stats() counts them.
    const columns = this.db.prepare("PRAGMA table_info(insight_evidence)").all();
    if (!columns.some((column) => column.name === "resource_type")) {
      this.db.exec("ALTER TABLE insight_evidence ADD COLUMN resource_type TEXT NOT NULL DEFAULT ''");
    }
    // `corroborated_at` arrived with the search stage, after the column list
    // was settled. Added in place for the same reason and NULL-able on
    // purpose: never-asked and asked-and-found-nothing are different states,
    // and a DEFAULT of '' would make every existing card look already tried.
    const own = this.db.prepare("PRAGMA table_info(insights)").all();
    if (!own.some((column) => column.name === "corroborated_at")) {
      this.db.exec("ALTER TABLE insights ADD COLUMN corroborated_at TEXT");
    }
    // `gloss` and `speaker` arrived together, after the column lists above were
    // settled. Added in place for `cues`' reason, and NULL-able on purpose:
    // "never asked" and "asked and declined" are both honestly nothing, and a
    // DEFAULT of '' would make every existing card look like one whose gloss
    // came back empty.
    if (!own.some((column) => column.name === "gloss")) {
      this.db.exec("ALTER TABLE insights ADD COLUMN gloss TEXT");
    }
    if (!columns.some((column) => column.name === "speaker")) {
      this.db.exec("ALTER TABLE insight_evidence ADD COLUMN speaker TEXT");
    }
    // `reason_code` arrived after the ledger's first rows were written. Added in
    // place for `cues`' reason; existing rows carry NULL and the page falls
    // back to their stored sentence, which is the only thing that can be done
    // with a sentence somebody already wrote in one language.
    const ledgerColumns = this.db.prepare("PRAGMA table_info(insight_pass_rows)").all();
    if (ledgerColumns.length > 0 && !ledgerColumns.some((column) => column.name === "reason_code")) {
      this.db.exec("ALTER TABLE insight_pass_rows ADD COLUMN reason_code TEXT");
    }
    // Deliberately no close(): the handle belongs to the SourceStore, and
    // offering a close here is an invitation to shut the whole library from a
    // route handler.
  }

  /**
   * Rows held, optionally narrowed to one status.
   * @param status - a member of INSIGHT_STATUSES, or undefined for all.
   * @returns the count.
   */
  count(status) {
    if (status === undefined) return this.db.prepare("SELECT COUNT(*) AS n FROM insights").get().n;
    assertMember(status, INSIGHT_STATUSES, "status");
    return this.db.prepare("SELECT COUNT(*) AS n FROM insights WHERE status = ?").get(status).n;
  }

  /**
   * Rows per status, for the chips.
   *
   * Counted on the `status` column, not on the effective status: the chips have
   * to agree with what the filters actually select, and a chip counting one
   * thing while its filter selects another is a number that is wrong without
   * looking wrong. Statuses with no rows are absent, as `countsByType` behaves;
   * callers use `?? 0`.
   * @returns `{ candidate: n, standing: n, ... }`.
   */
  countsByStatus() {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM insights GROUP BY status").all();
    const counts = {};
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /**
   * Rows per VERDICT — what a person decided, not what the pass computed.
   *
   * COUNTED THE SAME WAY THE FILTER SELECTS, which is the rule countsByStatus
   * states one method up and the reason this is a second method rather than
   * arithmetic over the first: `status` and `pinned_status` are different
   * columns, and a card whose person and pass disagree is counted in one bucket
   * by each. Deriving either tally from the other is wrong for exactly those
   * cards — the ones a reader has actually touched.
   *
   * `pending` IS THE INBOX and is the count of NULLs, because "nobody has
   * judged this" is the absence of a verdict rather than a fourth kind of one.
   * It is scoped to the live statuses, matching what `list` selects for
   * `verdict: "pending"`: an inbox that fills with everything the pass has
   * given up on is an inbox nobody reaches the bottom of.
   *
   * The three decided buckets are NOT scoped that way, matching `list` again:
   * a card the reader shelved stays counted where they put it even after the
   * pass lets it go dormant.
   * @returns `{ pending: n, standing: n, contested: n, dormant: n }`.
   */
  countsByVerdict() {
    const counts = { pending: 0, standing: 0, contested: 0, dormant: 0 };
    counts.pending = this.db.prepare(
      `SELECT COUNT(*) AS n FROM insights
        WHERE pinned_status IS NULL AND status IN (${LIVE_STATUSES.map(() => "?").join(",")})`,
    ).get(...LIVE_STATUSES).n;
    for (const row of this.db.prepare(
      "SELECT pinned_status AS v, COUNT(*) AS n FROM insights WHERE pinned_status IS NOT NULL GROUP BY pinned_status",
    ).all()) {
      counts[row.v] = row.n;
    }
    return counts;
  }

  /**
   * Page the 洞察 tab.
   * @param options - `{ status, kind, filter, search, sortBy, take, skip, now, windowDays, minIndependent }`.
   * @returns `{ insights, total, hasMore, counts }`.
   */
  list({
    status, kind, resourceType, verdict, filter, search, sortBy,
    take = 20, skip = 0,
    now = new Date().toISOString(),
    windowDays = 7,
    minIndependent = 2,
  } = {}) {
    const where = [];
    const params = [];

    if (typeof status === "string" && status !== "") {
      assertMember(status, INSIGHT_STATUSES, "status");
      where.push("status = ?");
      params.push(status);
    }
    if (typeof kind === "string" && kind !== "") {
      assertMember(kind, INSIGHT_KINDS, "kind");
      where.push("kind = ?");
      params.push(kind);
    }
    // WHICH KIND OF SOURCE THE CLAIM RESTS ON, which is a different question
    // from what kind of claim it is, and the two are the most confusable pair
    // of vocabularies in this feature. `kind` is launch / funding / policy /
    // finding / shift — what the claim SAYS. This is NEWS / PAPER /
    // YOUTUBE_VIDEO — where it CAME FROM, and the same list the 信源 tab pages
    // by. Both are plain strings and neither validates as the other, so a
    // caller that passes one where the other belongs gets an empty page rather
    // than an error, which is why they are separate parameters with separate
    // names rather than one "type".
    //
    // AN EXISTS SUBQUERY, NOT A JOIN. A claim with three NEWS quotes is ONE
    // claim; joining evidence would return it three times, and the total,
    // the paging and the `hasMore` would all be wrong by a factor nobody
    // could predict. EXISTS asks "does any of its evidence come from here",
    // which is the question, and stops at the first row that answers it.
    //
    // Against the DENORMALISED `resource_type`, not a join back to
    // `resources`: that column is what survives a library prune, and it is
    // the same value `scoreCredibility` weighs the claim by. Filtering on the
    // live row would silently drop every claim whose source has since been
    // pruned — the card would vanish from a filtered page while still
    // appearing on the unfiltered one.
    if (typeof resourceType === "string" && resourceType !== "") {
      where.push(`EXISTS (
        SELECT 1 FROM insight_evidence e
         WHERE e.insight_id = insights.id AND e.resource_type = ?
      )`);
      params.push(resourceType);
    }

    // ── WHAT A PERSON DECIDED, as opposed to what the pass computed ──────
    //
    // `status` is the pass's opinion and moves under the reader's feet on
    // every run. `pinned_status` is the reader's own, and it outranks the
    // pass — that is the whole reason the column exists. They are separate
    // columns and this is a separate cut.
    //
    // "pending" IS THE INBOX AND IS NOT A STATUS. A card nobody has judged is
    // not a fourth verdict; it is the absence of one, so it is NULL and has to
    // be asked for as a distinct value rather than as a member of the
    // vocabulary. Spelling it "" or leaving it out would make "show me what I
    // have not looked at" indistinguishable from "show me everything".
    const verdicting = typeof verdict === "string" && verdict !== "";
    // A DECIDED VERDICT SUPPRESSES THE DEFAULT LIVE-STATUS CLAUSE; "pending"
    // does not. "Show me what I shelved" means all of it, including the rows
    // the pass has since let go dormant — hiding those would make a card
    // disappear from the one place the reader put it. "Show me what I have
    // not judged" is the opposite: it is an INBOX, and an inbox that fills up
    // with everything the pass has already given up on is an inbox nobody
    // reaches the bottom of.
    const judged = verdicting && verdict !== "pending";
    if (verdicting) {
      if (verdict === "pending") {
        where.push("pinned_status IS NULL");
      } else {
        assertMember(verdict, INSIGHT_STATUSES, "verdict");
        where.push("pinned_status = ?");
        params.push(verdict);
      }
    }

    const filtering = typeof filter === "string" && filter !== "";
    const narrowed = typeof status === "string" && status !== "";

    if (filtering) {
      const windowStart = isoDaysBefore(now, windowDays);
      const floor = clampInt(minIndependent, 1, 20, 2);
      if (filter === "new") {
        where.push("first_seen_at >= ?");
        params.push(windowStart);
      } else if (filter === "rising") {
        where.push("status IN ('standing','contested') AND independent_count >= ? AND last_seen_at >= ?");
        params.push(floor, windowStart);
      } else if (filter === "contested") {
        // On the count, NOT on `status = 'contested'`. A disagreement that has
        // since gone dormant is still the most valuable row on the page, and
        // hiding it defeats the point of recording stance at all.
        where.push("contradiction_count > 0");
      } else if (filter === "dormant") {
        where.push("status = 'dormant'");
      } else {
        throw new Error(`filter must be one of new, rising, contested, dormant; got ${JSON.stringify(filter)}`);
      }
    } else if (!narrowed && !judged) {
      // Default page: the three live statuses. Candidates are INCLUDED —
      // hiding them by default gives the first day an empty tab, which reads
      // as a broken feature rather than as a sprawl control. Spelt as an IN
      // rather than `status != 'dormant'` because the IN's cost is bounded by
      // the live set and the walk's by the dormant pile, which nothing prunes;
      // the measurements are in the DDL above ix_insights_status_rank.
      where.push(`status IN (${LIVE_STATUSES.map(() => "?").join(",")})`);
      params.push(...LIVE_STATUSES);
    }

    if (typeof search === "string" && search.trim() !== "") {
      // An unavoidable full scan: LIKE with a leading wildcard cannot use an
      // index, and the corpus this ranks is ~10 standing cards a week.
      const like = `%${search.trim()}%`;
      where.push("(statement LIKE ? OR entities LIKE ?)");
      params.push(like, like);
    }

    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const order = SORTABLE[sortBy] ?? SORTABLE.rank;
    const limit = clampInt(take, 1, 100, 20);
    const offset = Math.max(0, clampInt(skip, 0, Number.MAX_SAFE_INTEGER, 0));

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM insights ${clause}`).get(...params).n;
    const rows = this.db.prepare(
      `SELECT ${INSIGHT_COLUMNS} FROM insights ${clause} ORDER BY ${order} DESC, id LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);

    const insights = rows.map(shapeInsight);
    const preview = this.#evidencePreview(insights.map((row) => row.id));
    for (const row of insights) row.evidencePreview = preview.get(row.id) ?? [];

    return {
      insights,
      total,
      hasMore: offset + rows.length < total,
      // Always the full tally, whatever the active filter, so the page can
      // offer "+N candidates" without a second request.
      counts: this.countsByStatus(),
      // AND THE VERDICT TALLY, on the same terms and for a sharper reason: the
      // page's verdict strip IS its navigation, so every segment has to carry
      // its own number while a different one is selected. Derived here rather
      // than from `counts` because they answer different questions out of two
      // different columns, and a page that subtracted one from the other would
      // be quietly wrong for every card whose person and pass disagree.
      verdictCounts: this.countsByVerdict(),
    };
  }

  /**
   * Up to two supporting rows and one contradicting row per insight.
   *
   * ONE query over the whole page, not one per row: the list is the hot path
   * and an N+1 here is twenty round trips per render that nothing reports.
   * `ROW_NUMBER() OVER (PARTITION BY insight_id, stance ...)` is what makes the
   * per-insight limit expressible in a single statement; the bundled SQLite
   * (3.50) has window functions.
   */
  #evidencePreview(ids) {
    const byInsight = new Map();
    if (ids.length === 0) return byInsight;
    const holes = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT e.insight_id, e.resource_id, e.stance, e.quote, e.source_key, e.speaker, e.added_at,
             r.title AS title, r.source_url AS source_url, r.type AS type
      FROM (
        SELECT insight_id, resource_id, stance, quote, source_key, speaker, added_at,
               ROW_NUMBER() OVER (PARTITION BY insight_id, stance ORDER BY added_at DESC) AS rn
        FROM insight_evidence
        WHERE insight_id IN (${holes}) AND stance IN ('supports','contradicts')
      ) AS e
      LEFT JOIN resources r ON r.id = e.resource_id
      WHERE (e.stance = 'supports' AND e.rn <= 2) OR (e.stance = 'contradicts' AND e.rn <= 1)
      ORDER BY e.insight_id, e.stance = 'contradicts', e.added_at DESC
    `).all(...ids);
    for (const row of rows) {
      const list = byInsight.get(row.insight_id) ?? [];
      list.push({
        resourceId: row.resource_id,
        stance: row.stance,
        quote: row.quote,
        sourceKey: row.source_key,
        // Who said it, when the block said so. On the CARD PREVIEW as well as
        // on the detail, because the card is where a reader decides whether a
        // quote is worth opening — and "somebody named, on the record" and
        // "an outlet's own prose" are different weights of evidence.
        speaker: row.speaker ?? null,
        // Null, not dropped, when the library no longer holds the row: the
        // page renders the quote with its sourceKey and no link, rather than
        // showing five rows under a card claiming six sources.
        title: row.title ?? null,
        sourceUrl: row.source_url ?? null,
        type: row.type ?? null,
      });
      byInsight.set(row.insight_id, list);
    }
    return byInsight;
  }

  /**
   * One insight.
   * @param id - the insight id.
   * @returns the camelCase row, or undefined when there is no such row.
   */
  get(id) {
    const row = this.db.prepare(`SELECT ${INSIGHT_COLUMNS} FROM insights WHERE id = ?`).get(id);
    return row === undefined ? undefined : shapeInsight(row);
  }

  /**
   * One insight with its whole evidence trail and its supersedes history.
   * @param id - the insight id.
   * @returns the row plus `evidence`, `supersededRow`, `supersededBy`, or undefined.
   */
  getWithEvidence(id) {
    const insight = this.get(id);
    if (insight === undefined) return undefined;
    const supersededRow = insight.supersedes === null
      ? null
      : this.db.prepare("SELECT id, statement FROM insights WHERE id = ?").get(insight.supersedes) ?? null;
    const supersededBy = this.db.prepare(
      "SELECT id, statement, first_seen_at FROM insights WHERE supersedes = ? ORDER BY first_seen_at DESC",
    ).all(id).map((row) => ({ id: row.id, statement: row.statement, firstSeenAt: row.first_seen_at }));
    return { ...insight, evidence: this.listEvidence(id), supersededRow, supersededBy };
  }

  /**
   * Every evidence row for one insight, contradictions first.
   *
   * LEFT JOIN, not JOIN: an INNER JOIN would make a pruned source delete the
   * evidence from the page while the row still counts toward `source_count`,
   * so the card would claim six sources and show five.
   * @param insightId - the insight id.
   * @returns `[{ resourceId, stance, quote, sourceKey, resourceType, type, addedAt, resource }]`.
   */
  listEvidence(insightId) {
    const rows = this.db.prepare(`
      SELECT e.resource_id, e.stance, e.quote, e.source_key, e.resource_type, e.speaker, e.added_at,
             r.id AS r_id, r.title AS r_title, r.source_url AS r_source_url,
             r.type AS r_type, r.source_type AS r_source_type, r.published_at AS r_published_at
      FROM insight_evidence e
      LEFT JOIN resources r ON r.id = e.resource_id
      WHERE e.insight_id = ?
      ORDER BY e.stance = 'contradicts' DESC, e.added_at DESC
    `).all(insightId);
    return rows.map((row) => ({
      resourceId: row.resource_id,
      stance: row.stance,
      quote: row.quote,
      sourceKey: row.source_key,
      resourceType: row.resource_type,
      // Who said the quote, when the block said so. Null is the common answer
      // and the honest one: an article speaking in its own voice has no
      // speaker, and neither has an hour of conversation between two people
      // whose names appear nowhere in what the model was shown.
      speaker: row.speaker ?? null,
      // `type` is the DENORMALISED value, not the joined one, and deliberately
      // so: the credibility weight is looked up by `type`, and reading it off
      // the join means a pruned PAPER quietly weighs the same as an unknown
      // source and the claim it backed slides down the list with nothing
      // reporting an error. The live row's own type is under `resource.type`.
      type: row.resource_type === "" ? null : row.resource_type,
      addedAt: row.added_at,
      resource: row.r_id === null || row.r_id === undefined ? null : {
        id: row.r_id,
        title: row.r_title,
        sourceUrl: row.r_source_url,
        type: row.r_type,
        sourceType: row.r_source_type,
        publishedAt: row.r_published_at,
      },
    }));
  }

  /**
   * Claims this source is evidence for, best-ranked first.
   * @param resourceId - the source id.
   * @param limit - maximum rows.
   * @returns `[{ id, statement, kind, status, pinnedStatus, effectiveStatus, stance, quote, rankScore }]`.
   */
  insightsForResource(resourceId, limit = 20) {
    return this.db.prepare(`
      SELECT i.id, i.statement, i.kind, i.status, i.pinned_status, i.rank_score, e.stance, e.quote
      FROM insight_evidence e
      JOIN insights i ON i.id = e.insight_id
      WHERE e.resource_id = ?
      ORDER BY i.rank_score DESC
      LIMIT ?
    `).all(resourceId, clampInt(limit, 1, 200, 20)).map((row) => ({
      id: row.id,
      statement: row.statement,
      kind: row.kind,
      layer: row.layer ?? null,
      status: row.status,
      pinnedStatus: row.pinned_status ?? null,
      effectiveStatus: row.pinned_status ?? row.status,
      stance: row.stance,
      quote: row.quote,
      rankScore: row.rank_score,
    }));
  }

  /**
   * Lean rows for reconciliation's cheap lexical pass.
   *
   * Deliberately NOT an SQL similarity search: at the volumes this plan
   * measures — around ten standing cards a week — a full read of a bounded
   * window plus a Hamming compare in insights.js beats any indexing scheme,
   * and it is testable without a database.
   * @param options - `{ since, limit }`; `since` filters on `last_seen_at >= since`.
   * @returns `[{ id, statement, simhash, kind, entities, status, firstSeenAt, lastSeenAt, independentCount }]`.
   */
  candidatesForMatch({ since, limit } = {}) {
    const size = clampInt(limit, 1, 2000, 1000);
    const clause = typeof since === "string" && since !== "" ? "WHERE last_seen_at >= ?" : "";
    const params = clause === "" ? [] : [since];
    return this.db.prepare(`
      SELECT id, statement, simhash, kind, entities, status, first_seen_at, last_seen_at, independent_count
      FROM insights ${clause}
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(...params, size).map((row) => ({
      id: row.id,
      statement: row.statement,
      simhash: row.simhash,
      kind: row.kind,
      layer: row.layer ?? null,
      // Parsed here, not handed over raw: `statementsMatch` counts shared
      // entities, and counting them over a JSON *string* returns 0 for every
      // pair forever — one of the prefilter's three tests would simply never
      // fire, and nothing would say so.
      entities: entitiesOf(row.entities),
      status: row.status,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      independentCount: row.independent_count,
    }));
  }

  /**
   * Insert or update one insight.
   * @param record - `{ id?, statement, kind, entities?, status?, simhash, firstSeenAt?, lastSeenAt?, supersedes? }`.
   * @returns the insight's id.
   */
  /**
   * Rewrite one claim's own words and where it sits, and nothing else.
   *
   * NOT `upsertInsight`, THOUGH IT LOOKS LIKE ONE. That method is the
   * EXTRACTOR's write: it takes entities, a status and two timestamps, and a
   * caller who only has a new sentence would have to invent the rest or read
   * them back and hand them in again — which is how a re-classification ends
   * up resetting `first_seen_at` and telling every card it was found today.
   *
   * THE SIMHASH MOVES WITH THE STATEMENT. It is computed over the sentence
   * and it is what near-duplicate detection reads; leaving it behind would
   * make the next pass compare new claims against the words this row used to
   * have. The caller computes it, because `simhash` lives in insights.js and
   * this module must not import from there — see the file's own note on the
   * import direction.
   * @param id - the claim.
   * @param patch - `{ statement, simhash, layer }`; each is optional.
   * @returns false when there is no such row.
   */
  reclassifyInsight(id, patch) {
    const statement = typeof patch?.statement === "string" ? patch.statement.trim() : "";
    const simhash = typeof patch?.simhash === "string" ? patch.simhash.trim().toLowerCase() : "";
    // BOTH OR NEITHER. A statement written without its hash leaves the row
    // saying one thing and deduplicating as another, which is silent and
    // permanent; the pair is refused rather than half-applied.
    if ((statement === "") !== (simhash === "")) {
      throw new Error("reclassifyInsight needs the statement and its simhash together, or neither");
    }
    if (statement !== "" && !/^[0-9a-f]{16}$/u.test(simhash)) {
      throw new Error(`simhash must be sixteen lowercase hex characters; got ${JSON.stringify(patch?.simhash ?? null)}`);
    }
    const layer = INSIGHT_LAYERS.includes(patch?.layer) ? patch.layer : null;
    if (statement === "" && layer === null) return false;
    return this.db.prepare(`
      UPDATE insights SET
        statement = COALESCE(?, statement),
        simhash   = COALESCE(?, simhash),
        layer     = COALESCE(?, layer),
        updated_at = ?
      WHERE id = ?
    `).run(
      statement === "" ? null : statement,
      statement === "" ? null : simhash,
      layer,
      new Date().toISOString(),
      String(id),
    ).changes > 0;
  }

  upsertInsight(record) {
    const statement = String(record?.statement ?? "").trim();
    if (statement === "") throw new Error("an insight needs a statement; got an empty one");
    assertMember(record?.kind, INSIGHT_KINDS, "kind");
    const status = record?.status ?? "candidate";
    assertMember(status, INSIGHT_STATUSES, "status");

    const simhash = record?.simhash;
    if (typeof simhash !== "string" || !SIMHASH_PATTERN.test(simhash)) {
      throw new Error(`simhash must be 16 lowercase hex characters; got ${JSON.stringify(simhash)}`);
    }
    // The all-zero hash is what simhash() returns for text it could not
    // tokenize. Two such rows are 0 bits apart, so the prefilter calls them
    // near-identical and every text-less claim merges into every other one.
    // A validated non-empty statement that hashes to zero is a tokenize bug,
    // and it should surface here rather than as a card that swallows others.
    if (simhash === "0000000000000000") {
      throw new Error(`simhash of ${JSON.stringify(statement.slice(0, 60))} is all zeroes, which means tokenize found no usable text`);
    }

    const now = new Date().toISOString();
    const firstSeenAt = record?.firstSeenAt ?? now;
    const lastSeenAt = record?.lastSeenAt ?? now;
    assertIso(firstSeenAt, "firstSeenAt");
    assertIso(lastSeenAt, "lastSeenAt");

    const id = typeof record?.id === "string" && record.id !== "" ? record.id : newInsightId();
    this.db.prepare(`
      INSERT INTO insights (
        id, statement, kind, layer, gloss, entities, status, simhash,
        first_seen_at, last_seen_at, supersedes, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        statement = excluded.statement,
        kind = excluded.kind,
        -- COALESCE, so a re-extraction that could not place the claim does
        -- not erase a layer an earlier pass — or a person — established.
        -- The other direction is fine: a pass that DOES place it wins.
        layer = COALESCE(excluded.layer, insights.layer),
        -- COALESCE, for the layer's reason. A later pass that could not write
        -- a gloss must not erase one an earlier pass produced: the field is
        -- optional by design, so "absent" is the common case and overwriting
        -- with it would make the reading flicker away on the next merge.
        gloss = COALESCE(excluded.gloss, insights.gloss),
        entities = excluded.entities,
        simhash = excluded.simhash,
        supersedes = excluded.supersedes,
        -- MIN, never overwrite: first_seen_at is the column that makes "since
        -- when" answerable, and a re-extraction of the same claim would
        -- otherwise reset the card's whole history to today.
        first_seen_at = MIN(insights.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(insights.last_seen_at, excluded.last_seen_at),
        updated_at = excluded.updated_at
        -- counts, scores and pinned_status are untouched: recount, applyScores
        -- and setStatus own them, and each is the only writer of its columns.
    `).run(
      id, statement, record.kind,
      // NULL RATHER THAN A GUESS. A claim the extractor could not place has
      // no layer, and the pane groups those under their own heading — which
      // is also how a reader sees how much of the table predates the field.
      INSIGHT_LAYERS.includes(record?.layer) ? record.layer : null,
      typeof record?.gloss === "string" && record.gloss.trim() !== "" ? record.gloss.trim() : null,
      entitiesJson(record?.entities), status, simhash,
      firstSeenAt, lastSeenAt,
      typeof record?.supersedes === "string" && record.supersedes !== "" ? record.supersedes : null,
      now,
    );
    return id;
  }

  /**
   * Attach evidence to one insight and refresh its counts.
   * @param insightId - the insight the quotes belong to.
   * @param rows - `[{ resourceId, stance, quote, sourceKey, resourceType?, speaker?, addedAt? }]`.
   * @returns `{ added, updated, skipped, conflicted, counts }`.
   */
  addEvidence(insightId, rows) {
    // Evidence attached to nothing is invisible, and it is precisely the shape
    // of failure that leaves a card reporting six sources it cannot show.
    const owner = this.db.prepare("SELECT id FROM insights WHERE id = ?").get(insightId);
    if (owner === undefined) throw new Error(`no insight ${insightId} to attach evidence to; upsert it first`);

    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT stance FROM insight_evidence WHERE insight_id = ? AND resource_id = ?");
    const insert = this.db.prepare(`
      INSERT INTO insight_evidence (insight_id, resource_id, stance, quote, source_key, resource_type, speaker, added_at)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    const refresh = this.db.prepare(`
      UPDATE insight_evidence SET stance = ?, quote = ?, source_key = ?, resource_type = ?,
        -- COALESCE, so a re-extraction that could not name the speaker does
        -- not erase one an earlier pass found. Same rule as the layer and the
        -- gloss, and it matters most here: the field is optional BY DESIGN, so
        -- "absent" is the common answer and plain assignment would delete a
        -- correct attribution on the next merge.
        speaker = COALESCE(?, speaker)
      WHERE insight_id = ? AND resource_id = ?
    `);
    const typeOf = this.db.prepare("SELECT type FROM resources WHERE id = ?");

    let added = 0;
    let updated = 0;
    let skipped = 0;
    let conflicted = 0;

    this.db.exec("BEGIN");
    try {
      for (const row of Array.isArray(rows) ? rows : []) {
        const resourceId = typeof row?.resourceId === "string" ? row.resourceId.trim() : "";
        const quote = typeof row?.quote === "string" ? row.quote.trim() : "";
        const sourceKey = typeof row?.sourceKey === "string" && row.sourceKey.trim() !== ""
          ? row.sourceKey.trim()
          : "unknown";
        // Skipped, not thrown on: the extractor has already verified quotes,
        // so a bad row here means a CALLER bug, and the returned count is what
        // surfaces it. Throwing would lose the good rows beside it.
        if (resourceId === "" || quote === "" || !EVIDENCE_STANCES.includes(row?.stance)) {
          skipped += 1;
          continue;
        }
        const addedAt = typeof row?.addedAt === "string" ? row.addedAt : now;
        assertIso(addedAt, "addedAt");
        const resourceType = typeof row?.resourceType === "string" && row.resourceType !== ""
          ? row.resourceType
          : (typeOf.get(resourceId)?.type ?? "");

        // Bounded and trimmed to null. A "speaker" that arrived as a sentence
        // is not a name, and rendering one inline breaks the card row it sits
        // in; the extractor already applies the same ceiling, and this is the
        // store refusing to trust that it did.
        const said = typeof row?.speaker === "string" ? row.speaker.trim() : "";
        const speaker = said !== "" && said.length <= MAX_SPEAKER_CHARS ? said : null;

        const prior = existing.get(insightId, resourceId);
        if (prior === undefined) {
          insert.run(insightId, resourceId, row.stance, quote, sourceKey, resourceType, speaker, addedAt);
          added += 1;
          continue;
        }
        if (prior.stance === row.stance || prior.stance === "context") {
          // Only `context` may be upgraded. Letting any stance overwrite any
          // other lets a reconciliation pass flip an existing `supports` row on
          // the same card into `contradicts`: recount then decrements
          // sourceCount, increments contradictionCount, and demotes a standing
          // card — with no error and no log anywhere.
          refresh.run(row.stance, quote, sourceKey, resourceType, speaker, insightId, resourceId);
          updated += 1;
          continue;
        }
        conflicted += 1;
      }
      // Recounted inside the same transaction rather than left to the caller:
      // a caller that forgets leaves source_count disagreeing with the rows on
      // screen, which is a card that lies quietly and forever.
      const counts = this.recount(insightId);
      this.db.exec("COMMIT");
      return { added, updated, skipped, conflicted, counts };
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  /**
   * Recompute an insight's three counts from its evidence rows.
   *
   * Counted from `insight_evidence.source_key` alone — no join to `resources` —
   * so a library prune cannot silently demote a standing card.
   * @param insightId - the insight id.
   * @returns `{ sourceCount, independentCount, contradictionCount }`.
   */
  recount(insightId) {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN stance = 'supports' THEN 1 ELSE 0 END) AS supports,
        COUNT(DISTINCT CASE WHEN stance = 'supports' THEN source_key END) AS independent,
        SUM(CASE WHEN stance = 'contradicts' THEN 1 ELSE 0 END) AS contradicts
      FROM insight_evidence WHERE insight_id = ?
    `).get(insightId);
    const sourceCount = Number(row?.supports ?? 0);
    const independentCount = Number(row?.independent ?? 0);
    const contradictionCount = Number(row?.contradicts ?? 0);
    this.db.prepare(`
      UPDATE insights SET source_count = ?, independent_count = ?, contradiction_count = ?, updated_at = ?
      WHERE id = ?
    `).run(sourceCount, independentCount, contradictionCount, new Date().toISOString(), insightId);
    return { sourceCount, independentCount, contradictionCount };
  }

  /**
   * Write the four scores and the rank blend.
   * @param insightId - the insight id.
   * @param scores - `{ novelty, relevance, credibility, momentum, rank }`, each 0..1.
   * @param options - `{ status, now }`; `status` is the pass's verdict, never a pin.
   * @returns false when no row changed.
   */
  applyScores(insightId, scores, options = {}) {
    const novelty = clampScore(scores?.novelty, "novelty");
    const relevance = clampScore(scores?.relevance, "relevance");
    const credibility = clampScore(scores?.credibility, "credibility");
    const momentum = clampScore(scores?.momentum, "momentum");
    const rank = clampScore(scores?.rank, "rank");
    const now = options.now ?? new Date().toISOString();
    assertIso(now, "now");

    if (options.status === undefined || options.status === null) {
      return this.db.prepare(`
        UPDATE insights SET novelty = ?, relevance = ?, credibility = ?, momentum = ?,
          rank_score = ?, scored_at = ?, updated_at = ? WHERE id = ?
      `).run(novelty, relevance, credibility, momentum, rank, now, now, insightId).changes > 0;
    }
    assertMember(options.status, INSIGHT_STATUSES, "status");
    // `pinned_status` is never written here. A pass that could overwrite it
    // would make "dismiss" a button that works until the next tick.
    return this.db.prepare(`
      UPDATE insights SET novelty = ?, relevance = ?, credibility = ?, momentum = ?,
        rank_score = ?, status = ?, scored_at = ?, updated_at = ? WHERE id = ?
    `).run(novelty, relevance, credibility, momentum, rank, options.status, now, now, insightId).changes > 0;
  }

  /**
   * Insights whose scores have gone stale, most urgent first.
   *
   * The sweep exists because novelty decays with the wall clock: a card that
   * gained no new evidence still has to fall, and without this it keeps
   * whatever rank it was last given forever while the tab looks healthy.
   * @param options - `{ before, limit }`; `before` is an ISO instant.
   * @returns ids, oldest score first, never-scored rows first of all.
   */

  /**
   * Candidates that have not been sent looking for a second source lately.
   *
   * Only candidates: a claim already standing has its independent sources and
   * spending a page fetch on it buys nothing. Ordered by first seen, so the
   * oldest unresolved claim is tried before today's.
   *
   * @param options - `{ before, limit }`; `before` is an ISO instant.
   * @returns insight ids.
   */
  dueForCorroboration({ before, limit = 3 } = {}) {
    const cap = Math.max(1, Math.min(20, Number(limit) || 3));
    const cutoff = typeof before === "string" && before !== "" ? before : new Date().toISOString();
    return this.db.prepare(
      `SELECT id FROM insights
        WHERE status = 'candidate'
          AND (corroborated_at IS NULL OR corroborated_at < ?)
        ORDER BY first_seen_at ASC
        LIMIT ?`,
    ).all(cutoff, cap).map((row) => String(row.id));
  }

  /**
   * Record that a claim was searched for, whatever the search found.
   *
   * Stamped on the attempt rather than on success: a claim nobody else has
   * written about finds nothing again in an hour, and a queue keyed on success
   * would ask about it every pass for ever.
   * @param id - the insight.
   * @param at - ISO instant.
   */
  markCorroborated(id, at) {
    this.db.prepare("UPDATE insights SET corroborated_at = ?, updated_at = ? WHERE id = ?")
      .run(String(at), String(at), String(id));
  }

  /**
   * Attach a page found by searching, as an ordinary source.
   *
   * The page is written into `resources` first and then cited like anything
   * else. That is deliberate: evidence with no row behind it would need a
   * second shape everywhere — the card could not link to a reader, the counts
   * would need a union, and `for-resource` would answer half the truth. A
   * corroborating article IS a source this library now holds, so it becomes
   * one.
   *
   * @param insightId - the claim.
   * @param found - `{ url, sourceKey, stance, quote, addedAt }`.
   * @returns the resource id it was stored under.
   */
  addExternalEvidence(insightId, found) {
    const url = String(found?.url ?? "");
    if (url === "") throw new Error("external evidence needs a url");
    const at = String(found?.addedAt ?? new Date().toISOString());
    const host = String(found?.sourceKey ?? "").trim();

    // An id derived from the URL, so the same page found twice for two claims
    // is one row rather than two — `store.put` refuses a second id for one
    // normalized URL and would otherwise silently drop the citation.
    // Looked up here rather than through a SourceStore helper, because there
    // is not one: `put` refuses a second id for a normalized URL it already
    // holds, so the only way to cite an existing page is to find its id first.
    const existing = this.db
      .prepare("SELECT id FROM resources WHERE source_url = ? OR normalized_url = ? LIMIT 1")
      .get(url, url);
    let resourceId = existing?.id;
    if (resourceId === undefined) {
      resourceId = `corroborate-${createHash("sha1").update(url).digest("hex").slice(0, 16)}`;
      const stored = this.store.put({
        id: resourceId,
        type: /arxiv\.org/u.test(host) ? "PAPER" : "NEWS",
        title: String(found?.title ?? url).slice(0, 300),
        sourceUrl: url,
        sourceType: host === "" ? "web" : host,
        createdAt: at,
        raw: JSON.stringify({ foundBy: "insight-corroboration", url }),
      });
      if (stored === false) {
        // `put` refuses when the normalized URL is already held under another
        // id. Ask again rather than citing an id that was never written.
        resourceId = this.db
          .prepare("SELECT id FROM resources WHERE source_url = ? OR normalized_url = ? LIMIT 1")
          .get(url, url)?.id;
        if (resourceId === undefined) throw new Error(`could not store the corroborating page at ${url}`);
      }
    }

    // An ARRAY: addEvidence takes rows, and handing it one object makes it
    // iterate the object's keys instead of the row.
    this.addEvidence(insightId, [{
      resourceId,
      stance: String(found?.stance ?? "supports"),
      quote: String(found?.quote ?? ""),
      sourceKey: host === "" ? "web" : host,
      addedAt: at,
    }]);
    return resourceId;
  }
  dueForRescore({ before, limit } = {}) {
    assertIso(before, "before");
    // Plain `ORDER BY scored_at`: SQLite sorts NULLs first in ASC, which is
    // exactly the wanted order, and an expression here would give up
    // ix_insights_scored.
    return this.db.prepare(`
      SELECT id FROM insights
      WHERE status != 'dormant' AND (scored_at IS NULL OR scored_at < ?)
      ORDER BY scored_at
      LIMIT ?
    `).all(before, clampInt(limit, 1, 500, 200)).map((row) => row.id);
  }

  /**
   * Record a PERSON's verdict on one card.
   *
   * Writes `pinned_status` — which the pass reads and leaves alone — and also
   * `status`, so a row that is never rescored still reads back the way the
   * person left it. `null` clears the pin and hands the card back to the pass.
   * @param id - the insight id.
   * @param status - a member of INSIGHT_STATUSES, or null to clear.
   * @param now - the write stamp.
   * @returns false when there is no such insight.
   */
  setStatus(id, status, now = new Date().toISOString()) {
    assertIso(now, "now");
    if (status === null) {
      return this.db.prepare("UPDATE insights SET pinned_status = NULL, updated_at = ? WHERE id = ?")
        .run(now, id).changes > 0;
    }
    assertMember(status, INSIGHT_STATUSES, "status");
    return this.db.prepare("UPDATE insights SET pinned_status = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(status, status, now, id).changes > 0;
  }

  /**
   * Record that one claim replaced another.
   *
   * Written by the pass only — no route reaches this today, and split-by-hand
   * is deferred; see the notes on the insight routes.
   * @param oldId - the claim being replaced.
   * @param newId - the claim replacing it.
   * @param now - the write stamp.
   * @returns true when both rows were updated.
   */
  markSuperseded(oldId, newId, now = new Date().toISOString()) {
    assertIso(now, "now");
    if (oldId === newId) throw new Error(`an insight cannot supersede itself: ${oldId}`);
    const read = this.db.prepare("SELECT id, supersedes FROM insights WHERE id = ?");
    const older = read.get(oldId);
    const newer = read.get(newId);
    if (older === undefined) throw new Error(`no insight ${oldId} to supersede`);
    if (newer === undefined) throw new Error(`no insight ${newId} to supersede ${oldId} with`);

    // Walk the chain up from the old row. A cycle makes the detail view's
    // history walk run forever, which presents as one card that never loads —
    // a hang, not an error, in a page that otherwise works. The step ceiling
    // catches a loop that predates this call rather than trusting the data.
    let cursor = older.supersedes;
    for (let step = 0; cursor !== null && cursor !== undefined && step < 1000; step += 1) {
      if (cursor === newId) throw new Error(`superseding ${newId} with ${oldId} would close a loop`);
      cursor = read.get(cursor)?.supersedes ?? null;
    }

    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE insights SET supersedes = ?, updated_at = ? WHERE id = ?").run(oldId, now, newId);
      this.db.prepare("UPDATE insights SET status = 'dormant', updated_at = ? WHERE id = ?").run(now, oldId);
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    return true;
  }

  /**
   * Detach one evidence row and refresh the counts.
   *
   * The narrow hand correction: a quote attributed to the wrong source can go
   * without destroying the card. `remove` is the blunt instrument.
   * @param insightId - the insight id.
   * @param resourceId - the source whose evidence goes.
   * @returns `{ removed, counts }`.
   */
  removeEvidence(insightId, resourceId) {
    this.db.exec("BEGIN");
    try {
      const removed = this.db.prepare("DELETE FROM insight_evidence WHERE insight_id = ? AND resource_id = ?")
        .run(insightId, resourceId).changes > 0;
      const counts = this.recount(insightId);
      this.db.exec("COMMIT");
      return { removed, counts };
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  /**
   * Forget one insight, its evidence, and any reference to it.
   * @param id - the insight id.
   * @returns whether a row was removed.
   */
  remove(id) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM insight_evidence WHERE insight_id = ?").run(id);
      // A dangling `supersedes` renders as a history entry that cannot be
      // opened — a link to nothing, in the one view that exists to explain
      // where a claim came from.
      this.db.prepare("UPDATE insights SET supersedes = NULL WHERE supersedes = ?").run(id);
      const removed = this.db.prepare("DELETE FROM insights WHERE id = ?").run(id).changes > 0;
      this.db.exec("COMMIT");
      return removed;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  /**
   * Record what one pass did to each source it looked at.
   *
   * WRITTEN IN ONE TRANSACTION AND PRUNED IN THE SAME ONE. A ledger nobody
   * prunes is a table that grows by two hundred rows an hour for the life of
   * the library — 1.7 million rows a year — to serve a screen that shows the
   * latest batch and, at most, the handful before it.
   *
   * NEVER THROWS OUT OF HERE ON A ROW. A ledger is a record OF the work, not
   * the work: losing the account of a pass must not lose the claims the pass
   * extracted, which are already committed by the time this is called.
   * @param batch - the run's ISO stamp, the same one the record carries.
   * @param entries - `[{ resourceId, title, resourceType, durationSeconds, state, reason, claims }]`.
   * @param keepBatches - how many passes' ledgers to retain.
   * @returns the number of rows written.
   */
  recordPass(batch, entries, { keepBatches = LEDGER_BATCHES } = {}) {
    if (typeof batch !== "string" || batch === "" || !Array.isArray(entries)) return 0;
    const insert = this.db.prepare(`
      INSERT INTO insight_pass_rows (
        batch, resource_id, title, resource_type, duration_seconds, state, reason_code, reason, claims
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(batch, resource_id) DO UPDATE SET
        -- A SOURCE IS LOOKED AT ONCE PER PASS, but it reaches this table from
        -- two places: the scan reports what it skipped, and the extractor
        -- reports what happened to what it kept. The extractor's verdict is
        -- the later and the more specific, so it wins.
        state = excluded.state, reason_code = excluded.reason_code,
        reason = excluded.reason, claims = excluded.claims,
        duration_seconds = COALESCE(excluded.duration_seconds, insight_pass_rows.duration_seconds)
    `);
    let written = 0;
    this.db.exec("BEGIN");
    try {
      for (const entry of entries) {
        const id = String(entry?.resourceId ?? "");
        const state = String(entry?.state ?? "");
        if (id === "" || !PASS_STATES.includes(state)) continue;
        const seconds = Number(entry?.durationSeconds);
        insert.run(
          batch,
          id,
          String(entry?.title ?? ""),
          String(entry?.resourceType ?? ""),
          Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null,
          state,
          typeof entry?.reasonCode === "string" && entry.reasonCode !== "" ? entry.reasonCode : null,
          typeof entry?.reason === "string" && entry.reason !== "" ? entry.reason : null,
          Number.isFinite(Number(entry?.claims)) ? Number(entry.claims) : 0,
        );
        written += 1;
      }
      // Whole batches, never "the oldest N rows": half a pass's ledger is a
      // screen that reports a run read forty sources when it read two hundred.
      const keep = this.db.prepare(
        "SELECT DISTINCT batch FROM insight_pass_rows ORDER BY batch DESC LIMIT ?",
      ).all(Math.max(1, keepBatches)).map((row) => row.batch);
      if (keep.length > 0) {
        this.db.prepare(
          `DELETE FROM insight_pass_rows WHERE batch NOT IN (${keep.map(() => "?").join(",")})`,
        ).run(...keep);
      }
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
    return written;
  }

  /**
   * The batches the ledger still holds, newest first.
   * @param limit - how many to name.
   * @returns `[{ batch, rows }]`.
   */
  passBatches(limit = LEDGER_BATCHES) {
    return this.db.prepare(
      "SELECT batch, COUNT(*) AS rows FROM insight_pass_rows GROUP BY batch ORDER BY batch DESC LIMIT ?",
    ).all(Math.max(1, Math.min(50, Number(limit) || LEDGER_BATCHES)));
  }

  /**
   * What one pass did, source by source.
   *
   * ORDERED BY STATE, NOT BY TITLE. A reader opening this is asking what went
   * wrong, and a failure sorted alphabetically among two hundred successes is
   * a failure nobody finds. The order is the order of concern: the states that
   * cost the library something come first.
   * @param batch - the run's stamp, or undefined for the newest.
   * @param options - `{ state, take }`.
   * @returns `{ batch, counts, rows }`; `batch` is null when the ledger is empty.
   */
  passLedger(batch, { state, take = 200 } = {}) {
    const wanted = typeof batch === "string" && batch !== ""
      ? batch
      : this.db.prepare("SELECT batch FROM insight_pass_rows ORDER BY batch DESC LIMIT 1").get()?.batch;
    if (wanted === undefined) return { batch: null, counts: {}, rows: [] };
    const counts = {};
    for (const row of this.db.prepare(
      "SELECT state, COUNT(*) AS n FROM insight_pass_rows WHERE batch = ? GROUP BY state",
    ).all(wanted)) {
      counts[row.state] = row.n;
    }
    const params = [wanted];
    let clause = "batch = ?";
    if (typeof state === "string" && PASS_STATES.includes(state)) {
      clause += " AND state = ?";
      params.push(state);
    }
    const limit = Math.max(1, Math.min(500, Number(take) || 200));
    const rows = this.db.prepare(`
      SELECT resource_id, title, resource_type, duration_seconds, state, reason_code, reason, claims
        FROM insight_pass_rows
       WHERE ${clause}
       ORDER BY CASE state
         ${PASS_STATES.map((one, at) => `WHEN '${one}' THEN ${at}`).join(" ")}
         ELSE 99 END,
         claims DESC, title ASC
       LIMIT ?
    `).all(...params, limit).map((row) => ({
      resourceId: row.resource_id,
      title: row.title,
      resourceType: row.resource_type,
      durationSeconds: row.duration_seconds ?? null,
      state: row.state,
      reasonCode: row.reason_code ?? "",
      reason: row.reason ?? "",
      claims: row.claims,
    }));
    return { batch: wanted, counts, rows };
  }

  /**
   * One row of health for `/insights/status`.
   *
   * `oldestScoredAt` and `neverScored` are the staleness canaries: a
   * `oldestScoredAt` drifting away from now means the rescore sweep is not
   * keeping up and the ranking on screen is stale. `neverScored` is reported
   * beside it because MIN() ignores NULLs entirely — a store where NOTHING has
   * ever been scored reports the healthiest possible `oldestScoredAt`, which
   * is the check that passes while the thing it checks is broken.
   * @returns the health record.
   */
  stats() {
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM insights").get().n;
    const byKind = {};
    for (const row of this.db.prepare("SELECT kind, COUNT(*) AS n FROM insights GROUP BY kind").all()) {
      byKind[row.kind] = row.n;
    }
    const evidenceRows = this.db.prepare("SELECT COUNT(*) AS n FROM insight_evidence").get().n;
    const contested = this.db.prepare("SELECT COUNT(*) AS n FROM insights WHERE contradiction_count > 0").get().n;
    const newestFirstSeen = this.db.prepare("SELECT MAX(first_seen_at) AS at FROM insights").get().at ?? null;
    const scored = this.db.prepare(
      "SELECT MIN(scored_at) AS at FROM insights WHERE status != 'dormant' AND scored_at IS NOT NULL",
    ).get().at ?? null;
    const neverScored = this.db.prepare(
      "SELECT COUNT(*) AS n FROM insights WHERE status != 'dormant' AND scored_at IS NULL",
    ).get().n;
    // Every source that could not be keyed collapses into one independence
    // key, so ten of them count as one and no card built on them ever gets
    // promoted. That is the safe direction — under-confidence, not over — but
    // it is invisible unless it is counted, so it is counted.
    const unkeyedEvidence = this.db.prepare(
      "SELECT COUNT(*) AS n FROM insight_evidence WHERE source_key = 'unknown'",
    ).get().n;
    const untypedEvidence = this.db.prepare(
      "SELECT COUNT(*) AS n FROM insight_evidence WHERE resource_type = ''",
    ).get().n;
    return {
      total,
      byStatus: this.countsByStatus(),
      byKind,
      evidenceRows,
      contested,
      newestFirstSeen,
      oldestScoredAt: scored,
      neverScored,
      unkeyedEvidence,
      untypedEvidence,
    };
  }
}
