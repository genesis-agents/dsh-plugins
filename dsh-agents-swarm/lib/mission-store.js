/**
 * Mission storage: every SQL statement the mission runtime and the read model
 * run, and nothing else. No model calls, no HTTP, no timers, no policy.
 *
 * This module owns no database handle. It is constructed over the existing
 * `SourceStore` and writes through `store.db`, so a library stays one portable
 * file with one WAL, one connection and one `PRAGMA user_version` — which this
 * module never writes. `store.js` stamps 1 and throws
 * "source store: unsupported schema version N" for anything else at open, so a
 * second module bumping the stamp would make every existing library refuse to
 * open at the NEXT boot, on somebody else's machine, presenting as a corrupt
 * database rather than as a schema mismatch. `insight-store.js` established
 * that rule; this module keeps it.
 *
 * What this module adds over `insight-store.js` is a migration ledger, because
 * `CREATE TABLE IF NOT EXISTS` is not the whole migration story and this
 * codebase already knows it: `store.js` patches two columns by hand after its
 * DDL runs, precisely because bumping the version would reject a library that
 * may be the only copy of a migrated corpus. `IF NOT EXISTS` creates a missing
 * table and does NOTHING AT ALL to an existing table whose shape is wrong. A
 * column shaped wrong in phase 0 and discovered in phase 3 is then unfixable on
 * an installed machine: fresh installs get the corrected DDL, existing ones keep
 * the old table, and the two diverge in silence.
 *
 * Everything here is synchronous, matching `store.js`'s 45 call sites and zero
 * awaits. Nothing in this file may become async: on one shared connection an
 * `await` inside a transaction means somebody else's inserts execute INSIDE our
 * transaction and are discarded by our rollback.
 *
 * IMPORT DIRECTION: this module imports `mission-runtime.js`, and never the
 * reverse. That file imports nothing but `node:crypto`, so there is no cycle,
 * and it is where the three things BOTH modules must agree on live: the stage
 * declarations (so the tier split is applied by one function rather than
 * decided independently at each end), the event-type registry (so a class is
 * looked up rather than hard-coded per append site), and `RESUMABLE_STATUSES`
 * (so "which snapshots survive settlement" and "which missions may be resumed"
 * cannot drift apart). Everything else — every SQL statement in the system —
 * lives here.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import {
  DEPTH_TIERS,
  EVENT_TYPES,
  FAILURE_CODES,
  MISSION_STATUSES,
  RESUMABLE_STATUSES,
  STAGES,
  STAGE_STATUSES,
  TERMINAL_STATUSES,
  canResume as canResumeMission,
  stagesForTier,
} from "./mission-runtime.js";
import { normalizeUrl } from "./store.js";

// ── the transaction owner ──────────────────────────────────────────────────

/**
 * Names for nested savepoints. Monotonic rather than a depth index, because
 * SQLite allows duplicate savepoint names and `ROLLBACK TO` then targets the
 * innermost match — a reused name would silently roll back the wrong scope.
 */
let savepointCounter = 0;

/**
 * Run `fn` inside a transaction, nesting via SAVEPOINT.
 *
 * Three modules sharing one connection cannot each own `BEGIN`. Reproduced on
 * this Node with `store.putMany` called inside a mission transaction:
 *
 *     inner BEGIN threw: cannot start a transaction within a transaction
 *     inner catch ROLLBACK succeeded          <- rolls back the OUTER transaction
 *     outer COMMIT threw: cannot commit - no transaction is active
 *     rows: []                                 <- the outer write is gone
 *
 * The mission row stays 'running', the terminal write vanishes, and only the
 * next boot sweep notices.
 *
 * Outer-vs-nested is decided from `db.isTransaction` — SQLite's own answer —
 * rather than from a module-private depth counter, and that difference is
 * load-bearing: a depth counter only sees transactions opened THROUGH the
 * counter, so a bare `BEGIN` in `store.js` or `insight-store.js` is invisible to
 * it and reproduces the failure above verbatim.
 *
 * The mirror case is the one this helper cannot close: a bare `BEGIN` executed
 * INSIDE a transaction this helper opened still throws. Those call sites have to
 * be retrofitted onto this function. Until they are, do not call
 * `store.putMany` or the `insight-store` write methods from inside a `withTx`.
 *
 * @param db - the shared DatabaseSync handle.
 * @param fn - a SYNCHRONOUS function; its return value is returned.
 * @returns whatever `fn` returned.
 */
export function withTx(db, fn) {
  if (!(db instanceof DatabaseSync)) throw new TypeError("withTx needs the DatabaseSync handle, not a store");
  if (typeof fn !== "function") throw new TypeError("withTx needs a function to run inside the transaction");
  // Checked rather than trusted: an async callback returns a promise the instant
  // it reaches its first await, so COMMIT would run while the body is still
  // executing and every write after the await would land outside the
  // transaction that was supposed to protect it.
  if (fn.constructor?.name === "AsyncFunction") {
    throw new TypeError("withTx needs a synchronous function; move the await outside the transaction");
  }

  const nested = db.isTransaction;
  const name = `sp_${(savepointCounter += 1)}`;
  if (nested) db.exec(`SAVEPOINT ${name}`);
  else db.exec("BEGIN IMMEDIATE");

  try {
    const out = fn();
    // A thenable slips past the AsyncFunction check when the callback is a plain
    // function that returns a promise. Same consequence, so same refusal.
    if (out !== null && typeof out === "object" && typeof out.then === "function") {
      throw new TypeError("withTx callback returned a promise; a transaction on this connection must not span an await");
    }
    if (nested) db.exec(`RELEASE ${name}`);
    else db.exec("COMMIT");
    return out;
  } catch (error) {
    // Guarded on `isTransaction`: some errors abort the transaction inside
    // SQLite, and an unconditional ROLLBACK would then throw over the real error
    // and replace the diagnosis with "no transaction is active".
    if (db.isTransaction) {
      try {
        if (nested) {
          db.exec(`ROLLBACK TO ${name}`);
          // ROLLBACK TO does not pop the savepoint; without the RELEASE the name
          // stays on the stack for the life of the transaction.
          db.exec(`RELEASE ${name}`);
        } else {
          db.exec("ROLLBACK");
        }
      } catch {
        // The transaction is already gone; the original error is the news.
      }
    }
    // Never swallowed: a caller that continues over a rolled-back write is the
    // bug this helper exists to prevent.
    throw error;
  }
}

// ── frozen vocabularies ────────────────────────────────────────────────────

/**
 * The vocabularies this module VALIDATES against but does not own.
 *
 * Five of them used to be declared here as well as in `mission-runtime.js`, and
 * three of the five had drifted. `missions.failure_code` could not hold four of
 * the codes the runner classifies — and because `finalizeMissionRow` asserts
 * membership INSIDE its transaction, those four did not produce a wrong code,
 * they threw over the terminal write, rolled it back and left the row `running`
 * for ever. `missions.status` could hold `resumable` while the runtime's copy
 * could not, so a parked mission was refused a resume. And the depth tiers were
 * one list under two names, `DEPTHS` here and `DEPTH_TIERS` there.
 *
 * They live in `mission-runtime.js` because that module imports nothing, so it
 * can be the one both ends read. Re-exported rather than hidden: these ARE part
 * of this module's contract — they are what its `assertMember` calls enforce and
 * what its columns are documented against — and a caller should not have to know
 * which file the array is declared in to check a value it is about to write.
 * This is one binding with two names for its import path, not two arrays.
 */
export {
  DEPTH_TIERS,
  FAILURE_CODES,
  MISSION_STATUSES,
  STAGE_STATUSES,
  TERMINAL_STATUSES,
};

/**
 * Every value `mission_checkpoints.status` may hold.
 *
 * The mission statuses plus `abandoned`, which is not one: it is the boot
 * sweep's mark for a snapshot it has given up on after `RECLAIM_LIMIT` crashes,
 * so `canResume` can answer `reclaim-limit` instead of a reason that is a lie.
 * Validating this column against MISSION_STATUSES alone made that write throw,
 * which meant the sweep could never mark anything abandoned and a deterministic
 * crash was offered for resume on every boot, for ever.
 */
export const CHECKPOINT_STATUSES = Object.freeze([...MISSION_STATUSES, "abandoned"]);

/** Every value `mission_dimensions.state` may hold. */
export const DIMENSION_STATES = Object.freeze(["pending", "collecting", "collected", "degraded", "failed"]);

/** Every value `mission_dimensions.facet` may hold. */
export const FACETS = Object.freeze(["scientific", "technical", "market", "policy", "social", "general"]);

/**
 * Every value `mission_findings.verify_state` may hold. The split matters more
 * than the count.
 *
 *   verified-source-text     the quote sits in a span of a page WE FETCHED
 *   verified-adjacent-spans  two consecutive spans of the same fetched block
 *   verified-abstract        the quote sits in a library row's PUBLISHER abstract
 *   misattributed            found, but in a source other than the one named
 *   unverifiable             not found anywhere we hold
 *   too-short                below the quote floor
 *   unchecked-fetch-failed   we could not read the page
 *   unchecked-rate-limited   the host or backend refused us
 *   unchecked-stale          the stored text no longer backs the quote — either
 *                            older than documentMaxAgeDays with no budget to
 *                            re-fetch, or re-fetched and the text changed
 *
 * The three `unchecked-` states exist because "a 429 returned as an empty
 * result" is this repository's signature bug: collapsing a refusal into a
 * fabrication reproduces it in the column every gate reads. `misattributed` is
 * the highest-signal diagnostic in the system and would otherwise collapse into
 * `unverifiable`, which reads as hallucination.
 */
export const VERIFY_STATES = Object.freeze([
  "verified-source-text",
  "verified-adjacent-spans",
  "verified-abstract",
  "misattributed",
  "unverifiable",
  "too-short",
  "unchecked-fetch-failed",
  "unchecked-rate-limited",
  "unchecked-stale",
]);

/**
 * The ONE state that counts toward the floors, the chapter supply contract and
 * the sign-off ratio. A constant rather than a literal repeated at every gate,
 * because the evidence boundary is one string in one place or it is nothing.
 */
export const COUNTING_VERIFY_STATE = "verified-source-text";

/**
 * Verify states that require a fetched `mission_documents` row behind them.
 *
 * `verified-abstract` is absent on purpose: it is checked against a library
 * row's PUBLISHER abstract, not a page we fetched. It is reported and shown, and
 * discounted.
 */
export const FETCH_BACKED_VERIFY_STATES = Object.freeze(["verified-source-text", "verified-adjacent-spans"]);

/**
 * The orders `listFindings` will sort by, and the only ones.
 *
 * A CLOSED vocabulary mapped to a whitelisted `ORDER BY` in `FINDING_ORDER_SQL`,
 * never a fragment interpolated from the parameter. `?order=created_at; DROP`
 * is refused by name here rather than reaching a string template, and the same
 * list is what the route's 400 prints — one vocabulary, two readers, no chance
 * for them to disagree about what is legal.
 *
 * `created` is the default because it is the order the evidence was actually
 * gathered in, which is the only one that carries information the row itself
 * does not already print.
 */
export const FINDING_ORDERS = Object.freeze(["created", "host", "verifyState"]);

/**
 * Each order's literal `ORDER BY`. Every one ends in `created_at, id` so the
 * sort is TOTAL: a page boundary inside a run of equal hosts would otherwise
 * repeat or drop rows between `skip=0` and `skip=50`, which reads as evidence
 * appearing and disappearing as the reader scrolls.
 */
const FINDING_ORDER_SQL = Object.freeze({
  created: "created_at, id",
  host: "source_host, created_at, id",
  verifyState: "verify_state, created_at, id",
});

/** Every value `mission_events.class` may hold. */
export const EVENT_CLASSES = Object.freeze(["business", "lifecycle"]);

/** Every value `mission_chapters.section_type` may hold. */
export const SECTION_TYPES = Object.freeze(["evidenced", "interpretive"]);

/** Every value `mission_chapters.decision` may hold. */
export const CHAPTER_DECISIONS = Object.freeze(["passed", "fallback-length", "fallback-exhausted"]);

/** Every value `mission_artifacts.trigger` may hold. */
export const ARTIFACT_TRIGGERS = Object.freeze(["initial", "rerun-fresh", "rerun-incremental", "recovered"]);

/** Every value `mission_config.mutation_reason` may hold. */
export const MUTATION_REASONS = Object.freeze(["fresh", "rerun-fresh", "rerun-incremental", "stage-rerun"]);

// `canResume`'s refusal vocabulary is `RESUME_REFUSALS` in `mission-runtime.js`,
// and so is the decision itself. This module used to carry a second
// `canResume` with a second five-reason list, missing `reclaim-limit`: one name,
// two implementations, which is worse than two names for one operation because
// the caller cannot tell which answer it got.

/**
 * The normalised-character floor a fetched page must clear to back a verified
 * state. Below it the "page" is a paywall notice, a cookie wall or a 404 body,
 * all of which Readability will happily extract something from.
 */
export const MIN_DOCUMENT_CHARS = 200;

// ── schema ────────────────────────────────────────────────────────────────

/**
 * The migration ledger's own table. Never versioned, never altered; it is the
 * thing that lets everything else be.
 */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS mission_schema (
  id         TEXT PRIMARY KEY,     -- e.g. '001-spine'
  applied_at TEXT NOT NULL
) STRICT;
`;

/**
 * Migration 001: the spine — the tables a mission needs before any agent
 * exists. Exported so a test can build a scratch `new DatabaseSync(':memory:')`
 * and exercise every query without a SourceStore. Contains no directive of the
 * kind `store.js` stamps at open, deliberately.
 */
export const MISSION_DDL_SPINE = `
-- ── missions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS missions (
  id                TEXT PRIMARY KEY,
  topic             TEXT NOT NULL,
  depth             TEXT NOT NULL,            -- quick | standard | deep
  language          TEXT NOT NULL DEFAULT 'zh',
  status            TEXT NOT NULL,            -- MISSION_STATUSES
  -- The five ceilings, resolved once and frozen here. Read from this row, never
  -- re-resolved: a settings change between a mission's start and its rerun must
  -- not silently move the bar it is graded against. These are the GRADING caps;
  -- a stage rerun executes against a fresh allowance recorded as a new
  -- mission_config revision, because grading against the original and executing
  -- against its residual are different questions.
  max_tokens        INTEGER NOT NULL,
  max_calls         INTEGER NOT NULL,
  max_arxiv         INTEGER NOT NULL,
  max_web           INTEGER NOT NULL,
  max_fetch         INTEGER NOT NULL,
  wall_ms           INTEGER NOT NULL,
  -- Whether a retry layer sits below the model seam. Recorded so the agent
  -- loop's own backoff can be disabled: two retry layers double-charge the
  -- ledger and double-count the wall clock.
  retry_below_seam  INTEGER NOT NULL DEFAULT 0,
  -- The Leader's own success criteria, stored. Without this a resumed mission is
  -- reviewed against criteria it never set.
  goals             TEXT,
  -- The floor derived from MEASURED supply after s3. Written once; read by s4's
  -- flags, the researcher retry prompt and the researcher's own check.
  derived_floor     INTEGER,
  -- Which process claimed this row. At boot, status='running' AND
  -- boot_id <> CURRENT_BOOT is an orphan BY DEFINITION — no threshold, no stale
  -- window, no false positives. This one column replaces the whole
  -- heartbeat-reclamation apparatus a multi-pod service needs.
  boot_id           TEXT,
  pid               INTEGER,
  -- Updated in the same transaction as every business event append. The only
  -- liveness signal, and it is exact.
  last_progress_at  TEXT,
  last_stage        TEXT,
  -- The s4 -> s3 counter, PERSISTED. In the reference this lives on an object
  -- rebuilt per call and never written back, which makes its own round cap
  -- unreachable dead code.
  patch_round       INTEGER NOT NULL DEFAULT 0,
  -- Incremented on every start AND every boot reclaim, so a deterministic crash
  -- that re-resumes and re-crashes on every boot is countable. Note for whoever
  -- sets RECLAIM_LIMIT: one crash-then-resume cycle costs TWO, because the park
  -- and the re-claim each increment.
  run_count         INTEGER NOT NULL DEFAULT 1,
  started_at        TEXT NOT NULL,
  -- Effective start = max(started_at, last_reopened_at). Without it a resumed
  -- mission is instantly wall-time-killed against its original start, its own
  -- terminal write then loses the conditional-write race, and the user reads it
  -- as "my rerun broke".
  last_reopened_at  TEXT,
  completed_at      TEXT,
  failure_code      TEXT,
  error_message     TEXT,
  -- Nullable is load-bearing. NULL means the mission died before sign-off; 0
  -- means the Leader read the report and refused. Different failures, different
  -- next actions.
  leader_signed     INTEGER,
  leader_score      REAL,                     -- the Leader's own number, pre-correction
  leader_verdict    TEXT,
  -- The number the UI shows and the postmortem classifies on: the Leader's score
  -- AFTER the forced-unsign ladder and the scorecard fusion. Two score columns
  -- with no stated relationship is how two numbers for one thing starts; the
  -- relationship is stated here and asserted in the projector.
  final_score       REAL,
  soft_warned_at    TEXT,                     -- the budget notice fires once
  exhausted_at      TEXT,
  trace_enabled     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_missions_status  ON missions(status, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_missions_created ON missions(created_at DESC);
-- The boot sweep's exact query. Partial, because 'running' is a handful of rows
-- in a table that grows for the life of the library, and the sweep runs on the
-- boot path where every millisecond is user-visible startup latency.
CREATE INDEX IF NOT EXISTS ix_missions_live    ON missions(boot_id)
  WHERE status = 'running';

-- ── config snapshots ──────────────────────────────────────────────────────
-- A rerun DERIVES a new revision; it never edits one. The frozen input is what
-- makes a rerun reproducible, and what stops "I changed a setting" from silently
-- changing what a six-month-old mission is compared against.
CREATE TABLE IF NOT EXISTS mission_config (
  mission_id      TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  mutation_reason TEXT NOT NULL,       -- MUTATION_REASONS
  config          TEXT NOT NULL,       -- JSON: the whole resolved input, including
                                       -- the execution allowance for this revision
  created_at      TEXT NOT NULL,
  PRIMARY KEY (mission_id, revision)
) STRICT;

-- ── stages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_stages (
  mission_id   TEXT NOT NULL,
  step_id      TEXT NOT NULL,
  -- Literal position; NEVER derived from a shared stage number. In the reference
  -- s8b shares number 8 with s8, so a checkpoint after s8 lists s8b complete and
  -- a resume skips it while reporting success.
  ordinal      INTEGER NOT NULL,
  status       TEXT NOT NULL,          -- STAGE_STATUSES
  attempts     INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  ended_at     TEXT,
  -- Populated. The reference ships stageDurationsMs as an empty object with a
  -- "next version" comment, while the orchestrator already knows both ends.
  duration_ms  INTEGER,
  tokens       INTEGER NOT NULL DEFAULT 0,
  output       TEXT,                   -- JSON, the stage's return value
  degrade_note TEXT,                   -- the REQUIRED degraded field of the return
  PRIMARY KEY (mission_id, step_id)
) STRICT;

-- Two stages sharing an ordinal IS the s8/s8b bug, expressed as data. A unique
-- index makes it impossible instead of merely discouraged.
CREATE UNIQUE INDEX IF NOT EXISTS ux_stages_ordinal ON mission_stages(mission_id, ordinal);

-- ── events ────────────────────────────────────────────────────────────────
-- The complete event log. No ring buffer, no TTL, no eviction. The reference's
-- in-memory FIFO of 5,000 with a one-hour TTL is the named cause of a class of
-- UI bug: identical unfinished dimensions rendered red or grey purely according
-- to whether their events had been squeezed out. The WRITE is unbounded; the
-- READ is not — see eventTail().
CREATE TABLE IF NOT EXISTS mission_events (
  mission_id TEXT NOT NULL,
  -- Monotonic per mission, assigned in the same transaction as the write.
  -- Ordering by millisecond timestamp is ambiguous; this is not.
  seq        INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL,
  -- Written at insert, not reconstructed by prefix at read. A lifecycle event
  -- the USER caused must never count as evidence the mission is alive.
  class      TEXT NOT NULL,            -- EVENT_CLASSES
  agent_id   TEXT,
  step_id    TEXT,
  payload    TEXT NOT NULL,            -- JSON
  PRIMARY KEY (mission_id, seq)
) STRICT;

-- ── checkpoints ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_checkpoints (
  mission_id     TEXT PRIMARY KEY,
  saved_at       TEXT NOT NULL,
  completed_keys TEXT NOT NULL,        -- JSON array of step ids, LITERAL. Never a
                                       -- numeric ordinal shared between stages.
  cross_state    TEXT NOT NULL,        -- JSON, the whole inter-stage bag
  pipeline_hash  TEXT NOT NULL,        -- sha256 over the stage CONTRACTS, not their
                                       -- ids: a changed contract is a changed pipeline
  status         TEXT NOT NULL
) STRICT;

-- ── spend ─────────────────────────────────────────────────────────────────
-- Append-only. SUM over this table is the authoritative TERMINAL cost. The live
-- pool is an ESTIMATE and the two are reconciled here at every settlement; a
-- divergence beyond 15% is a signal, not something to absorb silently.
CREATE TABLE IF NOT EXISTS mission_spend (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id     TEXT NOT NULL,
  step_id        TEXT NOT NULL,
  role           TEXT NOT NULL,
  agent_id       TEXT,
  prompt_tok     INTEGER NOT NULL DEFAULT 0,   -- from the usage chunk. Exact.
  completion_tok INTEGER NOT NULL DEFAULT 0,
  cache_read_tok INTEGER NOT NULL DEFAULT 0,   -- disjoint from prompt_tok
  estimated_tok  INTEGER NOT NULL DEFAULT 0,   -- what the pool believed at the time
  calls          INTEGER NOT NULL DEFAULT 0,
  at             TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_spend_mission ON mission_spend(mission_id, step_id);
CREATE INDEX IF NOT EXISTS ix_spend_agent   ON mission_spend(mission_id, agent_id);
`;

/**
 * Migration 002: the corpus — dimensions, findings, the fetched-page substrate,
 * and the tool-call ledger the no-progress guard reads.
 */
export const MISSION_DDL_CORPUS = `
CREATE TABLE IF NOT EXISTS mission_dimensions (
  mission_id      TEXT NOT NULL,
  dimension_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  rationale       TEXT,
  facet           TEXT NOT NULL,       -- FACETS
  state           TEXT NOT NULL,       -- DIMENSION_STATES
  attempt         INTEGER NOT NULL DEFAULT 0,
  grade           REAL,
  grade_axes      TEXT,                -- JSON
  summary         TEXT,
  failure_code    TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  -- THE GENERATION IS PART OF THE KEY. It was (mission_id, dimension_id), on
  -- the stated assumption that a mission has one set of dimensions for its
  -- whole life. A fresh rerun replans, and the leader names the new dimensions
  -- itself, so instead of updating eight rows a rerun ADDED eight: one mission
  -- reached run 11 holding 37 dimensions for a plan of 8. Every reader passed
  -- runCount and none of them could scope by it.
  --
  -- weakestDimensions is where that stopped being cosmetic. It ranks by
  -- verified findings IN THIS RUN, so the 29 dimensions belonging to dead
  -- generations all scored zero and were permanently the weakest — and the
  -- s4 back edge exists to re-collect the weakest two. Every rerun since the
  -- first spent its back edge re-collecting dimensions that were not in its
  -- plan.
  PRIMARY KEY (mission_id, run_count, dimension_id)
) STRICT;
-- There is deliberately NO verified_count column here. A denormalised counter
-- with four writers (initial collect, recollect, salvage, the layer-3 retry) and
-- one critical reader (s4's loop-termination test) is a drift generator. It is a
-- COUNT(*) over an indexed column instead; see countVerified().

CREATE TABLE IF NOT EXISTS mission_findings (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL,
  dimension_id  TEXT NOT NULL,
  -- Which run produced it. A rerun-fresh does NOT delete the previous run's
  -- evidence: without this key, version 1's markdown survives while every
  -- finding row its citations point at is gone, and the old report becomes
  -- permanently unverifiable with nothing telling the user.
  run_count     INTEGER NOT NULL,
  attempt       INTEGER NOT NULL,      -- which s3 generation; recollect APPENDS
  claim         TEXT NOT NULL,
  -- Normalised. With source_host it is the distinctness key the s4 -> s3 back
  -- edge measures: same-source rephrasings must not count as improvement.
  claim_hash    TEXT NOT NULL,
  evidence      TEXT NOT NULL,         -- the model's quote, as written
  source_url    TEXT NOT NULL,
  -- The independence key, DENORMALISED. Deriving it by join makes the count drop
  -- silently when a row is pruned, and the claim demotes itself with nothing
  -- reporting anything wrong.
  source_host   TEXT NOT NULL,
  source_title  TEXT,
  published_at  TEXT,
  verify_state  TEXT NOT NULL,         -- VERIFY_STATES
  verify_reason TEXT,                  -- the verifier's own reason string, verbatim
  -- MUST equal sha256(normalizeUrl(source_url)) for any fetch-backed verified
  -- state. Enforced in insertFinding(), not by convention: they are otherwise
  -- independent columns, and a quote lifted from an arXiv abstract, attributed
  -- to nature.com and verified against the arXiv document lands as verified with
  -- source_host='nature.com' while unique_hosts and the whole independence model
  -- count it.
  document_id   TEXT,
  span_index    INTEGER,               -- which contiguous span matched
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_findings_dim   ON mission_findings(mission_id, dimension_id, run_count);
CREATE INDEX IF NOT EXISTS ix_findings_state ON mission_findings(mission_id, verify_state);
-- The per-dimension verified count is read by every gate in s3 and s4, and
-- ix_findings_state does not carry dimension_id — that count would otherwise
-- scan every verified finding in the mission on each check. The two trailing
-- columns make the back edge's distinct-(host, claim) count index-only too.
CREATE INDEX IF NOT EXISTS ix_findings_dim_state
  ON mission_findings(mission_id, dimension_id, verify_state, source_host, claim_hash);
-- Invalidation walks findings by the document they were checked against.
CREATE INDEX IF NOT EXISTS ix_findings_document ON mission_findings(document_id)
  WHERE document_id IS NOT NULL;

-- Fetched page text. Three jobs in one table: the fetch cache (never pay the
-- pacer twice for the same URL), the substrate a quote is verified against and
-- re-verified against later, and the corpus a mission upserts into the library —
-- which is the only way the library ever acquires body text at all.
CREATE TABLE IF NOT EXISTS mission_documents (
  -- sha256(normalized url). The IDENTITY is the URL: a content hash would create
  -- a new row per fetch and break the cache.
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  host         TEXT NOT NULL,
  title        TEXT,
  -- readArticle().markdown, chosen deliberately. Against the plain text field
  -- nearly the whole document is one span and the splice guard dissolves;
  -- against markdown every paragraph is its own span and the guard is strict and
  -- measurable.
  markdown     TEXT NOT NULL,
  -- sha256(markdown). A re-fetch that changes this INVALIDATES stored verify
  -- states for the row rather than silently replacing the text a prior mission's
  -- quote was checked against.
  content_hash TEXT NOT NULL,
  -- Normalised character count, not bytes, because the >= 200 precondition is
  -- stated in normalised characters. Below the floor the page is a paywall
  -- notice or an error body, both of which Readability extracts happily.
  byte_length  INTEGER NOT NULL,
  -- The HTTP status. A 404 body and a PDF both parse into something Readability
  -- will "extract", and a quote verified against an error page reads exactly
  -- like a real one. 2xx is a precondition of any verified state.
  status       INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_documents_url     ON mission_documents(url);
CREATE INDEX IF NOT EXISTS ix_documents_fetched ON mission_documents(fetched_at);

CREATE TABLE IF NOT EXISTS mission_tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id  TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  tool        TEXT NOT NULL,
  pace_key    TEXT,                    -- which ceiling this consumed
  -- Also the thrash detector's key: the same tool with the same args three times
  -- is a loop SHAPE, not a statistic.
  args_hash   TEXT NOT NULL,
  -- The arguments themselves, truncated. The hash answers "is this the same
  -- call again" and nothing else: a dimension that produced no findings could
  -- not be diagnosed, because what it SEARCHED FOR was never written down.
  -- Eight dimensions, eighty-six searches, thirteen fetches, and the only
  -- honest answer to "why did four find nothing" was that nobody could see the
  -- queries.
  args_text   TEXT NOT NULL DEFAULT '',
  ok          INTEGER NOT NULL,
  error_code  TEXT,
  cached      INTEGER NOT NULL DEFAULT 0,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_tool_calls_mission ON mission_tool_calls(mission_id, at);
CREATE INDEX IF NOT EXISTS ix_tool_calls_pace    ON mission_tool_calls(mission_id, pace_key);
-- The no-progress guard trips on the same (tool, args_hash) three times. Neither
-- index above carries args_hash, so without this the guard scans every tool call
-- the mission has made, every 30 seconds, on the connection the mission itself
-- is writing through.
CREATE INDEX IF NOT EXISTS ix_tool_calls_args    ON mission_tool_calls(mission_id, tool, args_hash, at DESC);
`;

/**
 * Migration 003: the report — chapters and versioned artefacts. Separate from
 * the corpus because they arrive with their consumers, and a table with no
 * reader is a guess that has been frozen.
 */
export const MISSION_DDL_REPORT = `
CREATE TABLE IF NOT EXISTS mission_chapters (
  mission_id    TEXT NOT NULL,
  run_count     INTEGER NOT NULL,
  dimension_id  TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  section_type  TEXT NOT NULL,         -- SECTION_TYPES
  heading       TEXT NOT NULL,
  body          TEXT,
  word_count    INTEGER NOT NULL DEFAULT 0,
  -- The ONE number, stored, so the ledger and the prompt cannot disagree after
  -- the fact.
  min_delivery  INTEGER NOT NULL,
  under_delivered INTEGER NOT NULL DEFAULT 0,   -- a fact, not an action
  decision      TEXT,                  -- CHAPTER_DECISIONS
  score         REAL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  -- Everything that can change the output. Hashing outline + findings only means
  -- a rerun-incremental after a PROMPT fix skips every chapter and reports
  -- success having done nothing — while prompt-editing is the flagship
  -- capability the incremental rerun exists to serve.
  input_hash    TEXT NOT NULL,         -- sha256(outline || finding ids+quotes ||
                                       --        sha256(SKILL.md) || duty name ||
                                       --        min_delivery || tier)
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (mission_id, run_count, dimension_id, chapter_index)
) STRICT;

CREATE TABLE IF NOT EXISTS mission_artifacts (
  mission_id    TEXT NOT NULL,
  version       INTEGER NOT NULL,
  run_count     INTEGER NOT NULL,
  trigger       TEXT NOT NULL,         -- ARTIFACT_TRIGGERS
  title         TEXT NOT NULL,
  markdown      TEXT NOT NULL,
  -- JSON: offsets into markdown, each typed evidenced|interpretive. Any mutation
  -- of markdown MUST rebuild this and re-scan citations; the content guard
  -- checks that every offset still resolves, because offset drift is silent and
  -- catastrophic.
  sections      TEXT NOT NULL,
  citations     TEXT NOT NULL,         -- JSON
  -- The resolved evidence set, frozen INTO the artefact: finding ids, quotes,
  -- document ids, verify states, fetched_at. A versioned report must carry its
  -- own provenance regardless of what the live tables later hold, or version 1
  -- becomes permanently unverifiable the moment version 2 is produced.
  evidence      TEXT NOT NULL,
  quality       TEXT NOT NULL,         -- JSON: the fused scorecard, per section type
  word_count    INTEGER NOT NULL,
  degraded      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (mission_id, version)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_artifacts_run ON mission_artifacts(mission_id, run_count, version DESC);
`;

/**
 * The ordered migration list, applied at init inside one transaction, each
 * idempotent, each recorded in `mission_schema`.
 *
 * Adding a column later is a NEW entry with a `PRAGMA table_info` guard, never
 * an edit to an existing one: editing 001 changes nothing on any machine that
 * has already recorded 001 as applied, which is the silent divergence this
 * ledger exists to prevent.
 */
export const MISSION_DDL_OWNER = `
-- ── runtime owner ─────────────────────────────────────────────────────────
-- One row, always. The boot_id column on missions answers "did the process that
-- owned this row survive?", which covers the case that actually happens - one
-- process, restarted. This covers the case it does not: two harnesses opened
-- against the same library file, where reclaiming the other's missions would
-- abort work that is genuinely running. claimRuntimeOwner refuses loudly on a
-- live foreign pid rather than resolving it.
--
-- A separate migration rather than an edit to 001: editing an applied migration
-- changes nothing on any machine that already recorded it, which is the silent
-- divergence the ledger exists to prevent.
CREATE TABLE IF NOT EXISTS runtime_owner (
  -- Pinned to 1 by the CHECK, so "one owner" is a constraint rather than a
  -- convention every writer has to remember.
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pid        INTEGER,
  boot_id    TEXT NOT NULL,
  started_at TEXT NOT NULL
) STRICT;
`;

/**
 * The image types a publisher's figure may be held and served as.
 *
 * A CLOSED raster list, the way `VERIFY_STATES` is closed, and checked TWICE:
 * once by `holdFigure` before bytes are stored, and again by the byte route
 * before they are written out. Not a duplicate — the first check stops a hole
 * being dug, the second stops one dug by an older build from being served by
 * this one. `mime` is stored for exactly that second check.
 *
 * `image/svg+xml` is absent, and that is a security decision rather than a
 * taste one. An SVG is a document: it carries script and external references,
 * and served from OUR origin under its honest content type it executes in our
 * origin. There is no way to serve a publisher's SVG as an image without also
 * offering it as a page. The cost is real and named in the risks: a page whose
 * figures are all vector charts yields no pictures at all, and each one is
 * filed as a `refused` row with a sentence rather than vanishing.
 */
export const FIGURE_MIME_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The states a figure row can be in. Four, never collapsed into "has bytes /
 * has none": a candidate nobody has asked for yet, a publisher who refused,
 * and a host we could not reach want three different next moves. `enrich.js`
 * already wrote down what collapsing them costs — "the reference persists no
 * negative, so it re-fetches those pages forever".
 *
 * No CHECK constraint, matching `verify_state`, `facet` and `decision`, which
 * are all closed vocabularies enforced in the writer: a CHECK on a STRICT
 * table cannot be widened later without rebuilding the table, and this list is
 * the kind that grows.
 */
export const FIGURE_STATES = Object.freeze(["candidate", "held", "refused", "failed"]);

/**
 * The largest single figure whose bytes are kept.
 *
 * A 1200px-wide chart or diagram lands between 80 and 300 kB in any of the four
 * formats above. This is five times the top of that range and still refuses a
 * full-bleed hero photograph, which is decoration whatever its caption says.
 */
export const MAX_FIGURE_BYTES = 1_500_000;

/**
 * The two held ceilings. THIS IS THE SCALE ARGUMENT, and it is a ceiling rather
 * than a hope.
 *
 * A deep mission fetches hundreds of pages. Holding every page's images would
 * be 300 pages x 2 figures x 1.5 MB = 900 MB in the library file, for one
 * mission, nearly all of it for pages no chapter ever cited. So bytes are NOT
 * fetched when a page is absorbed: every figure the selector kept lands as a
 * `candidate` row costing a few hundred bytes, and bytes are fetched only for a
 * document one of this run's verified findings cites. That set is bounded by
 * the evidence that survived verification rather than by the fetch log, and it
 * is roughly an order of magnitude smaller.
 *
 * Worst case with both ceilings is 40 x 1.5 MB = 60 MB per mission; the
 * expected case is nearer 40 x 200 kB = 8 MB. There is no configuration in
 * which it is smaller than it looks. `holdFigure` enforces the PER-DOCUMENT
 * ceiling itself, because a ceiling that only exists in an unwritten driver is
 * a ceiling that does not exist; the per-mission one needs the mission and so
 * belongs to `heldFigureCounts` and its caller.
 */
export const MAX_HELD_FIGURES_PER_DOCUMENT = 2;
export const MAX_HELD_FIGURES_PER_MISSION = 40;

/**
 * Figures lifted out of a fetched page, and the bytes when we hold them.
 *
 * A SEPARATE TABLE, not columns on `mission_documents`. A document has zero or
 * many figures, and the one thing a column set could not express is the one
 * this table exists for: WHICH page a figure came off. That is the whole
 * provenance claim — an image on a screen with no page behind it is a
 * fabricated figure rather than a citation — so `document_id` is NOT NULL and
 * is the only way a row is ever reached.
 *
 * THE MISSION IS NOT A COLUMN HERE, deliberately, and for the same reason
 * `mission_documents` does not carry one: that table is a URL-keyed cache
 * shared by every mission, and a figure inherits exactly the scope of the page
 * it was lifted from. A mission reaches its figures the way it reaches its
 * pages — through its OWN findings' `document_id`. A denormalised mission
 * column could disagree with that join, and the copy that disagreed would be
 * the one handing out bytes.
 *
 * IDENTITY IS (page, image url), never the bytes — the same reasoning
 * `mission_documents.id` already records. A content-hash key would mint a new
 * row every time a publisher re-encodes their chart, so the writer could never
 * upsert and the table would grow a duplicate per re-fetch. The bytes get
 * `content_hash` as a COLUMN instead, which is what notices a changed image
 * without being asked to identify one.
 */
export const MISSION_DDL_FIGURES = `
-- ── figures ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_figures (
  -- sha256(document_id + newline + normalizeUrl(image url)). Deterministic, so
  -- re-absorbing a page upserts its figures instead of duplicating them, and
  -- two spellings of one image resolve to one row the way two spellings of one
  -- page already do.
  id            TEXT PRIMARY KEY,
  -- The page this came off: mission_documents.id. The provenance, and the only
  -- route to a mission. A figure whose document is not in this run's
  -- documentsForMission() is not this mission's to serve.
  document_id   TEXT NOT NULL,
  -- Absolute, resolved against the PAGE rather than its origin: img/chart.png
  -- on https://site.com/blog/post/ is https://site.com/blog/post/img/chart.png,
  -- and resolving against the origin is the 404 enrich.js records in its header.
  url           TEXT NOT NULL,
  -- The IMAGE's host, which is frequently NOT the page's, because publishers
  -- serve figures off a CDN. Stored because the deny list and the pacer are
  -- both applied to this host and not to the page's.
  host          TEXT NOT NULL,
  alt           TEXT,
  -- The publisher's own <figcaption>. Shown as the figure's caption and NEVER
  -- merged into the article text: quote_verify checks a quote as a literal
  -- substring of exactly the string fetch_page returned, and a caption spliced
  -- into that string makes every verified quote in the system unverifiable.
  -- The column is here so the caption has somewhere to live that is not there.
  caption       TEXT,
  -- A short run of the page's own prose next to the image, so the accumulator
  -- can place a figure BESIDE the claim it illustrates instead of by ordinal.
  anchor_text   TEXT,
  -- Where that prose sat in the pre-turndown DOM's textContent. A SORT HINT AND
  -- NOTHING ELSE. It is not an index into mission_documents.markdown: that
  -- column holds fetch_page's 4,000-character slice of a differently normalised
  -- string, so indexing into it with this number would land in the wrong place
  -- silently. -1 means the extractor did not say; 0 is a real offset.
  text_offset   INTEGER NOT NULL DEFAULT -1,
  -- Intrinsic size where the page declared it, 0 where it did not. 0 is not
  -- "small", it is "unknown", and a selector must not treat the two alike.
  width         INTEGER NOT NULL DEFAULT 0,
  height        INTEGER NOT NULL DEFAULT 0,
  -- Why the selector kept this one, and which positive signals fired. Stored
  -- rather than recomputed, so a filter that starts admitting site furniture is
  -- a query somebody can run rather than an anecdote somebody reports.
  score         REAL NOT NULL DEFAULT 0,
  signals       TEXT NOT NULL DEFAULT '[]',
  -- FIGURE_STATES, about the BYTES only.
  state         TEXT NOT NULL DEFAULT 'candidate',
  -- The sentence for the unhappy states. A refusal with no reason is a figure
  -- that silently never appears and no way to find out why.
  reason        TEXT,
  -- As SERVED, not as guessed from the extension. A path ending .png is a
  -- publisher's claim, not a fact about the body. Re-checked by the route.
  mime          TEXT,
  status        INTEGER NOT NULL DEFAULT 0,
  byte_length   INTEGER NOT NULL DEFAULT 0,
  -- sha256 of the BYTES. mission_documents.content_hash hashes TEXT; these two
  -- columns share a name and hash different things, which is worth saying in
  -- the one place a reader would assume otherwise.
  content_hash  TEXT,
  -- NULL until state='held'. The copy we kept: a publisher URL that 404s next
  -- month changes nothing here, which is the entire reason bytes are stored
  -- rather than fetched when a reader opens the report.
  bytes         BLOB,
  -- THE STAMP OF THE PAGE VERSION THIS FIGURE WAS SEEN ON, and the answer to
  -- "the same page fetched twice". The writer passes the SAME instant it passes
  -- putDocument, so a figure still on the page gets last_seen_at =
  -- mission_documents.fetched_at and a figure the publisher deleted keeps the
  -- older stamp. Every read that feeds a screen requires the two to be equal,
  -- so a removed image stops being drawable at the moment its page is
  -- re-fetched, instead of being drawn for ever under a caption from a parse
  -- nobody can check. It fails CLOSED: a future putDocument caller that forgets
  -- putFigures hides that page's figures rather than showing stale ones.
  last_seen_at  TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  fetched_at    TEXT
) STRICT;

-- Every read is "the figures of these documents", because document_id is the
-- only way in, and every read wants the best-scoring first.
CREATE INDEX IF NOT EXISTS ix_figures_document ON mission_figures(document_id, score DESC, text_offset);
-- The held ceilings are counted over this. A partial index keeps that count off
-- the candidate rows, which outnumber the held ones by design.
CREATE INDEX IF NOT EXISTS ix_figures_held ON mission_figures(document_id)
  WHERE state = 'held';
-- placeableFigures asks how many DISTINCT documents one image address appears
-- under, because an image on two different pages is site furniture and that is
-- MEASURED rather than guessed from a filename. Without this the subquery
-- groups the whole table on every call.
CREATE INDEX IF NOT EXISTS ix_figures_url ON mission_figures(url);
`;

/**
 * The `mission_figures.id` one image on one page must be stored under.
 *
 * Exported for the same reason `documentIdFor` is: it is half of the provenance
 * guarantee. The writer, the byte fetcher and the route all have to mint the
 * same id from the same pair, or a figure is stored under one key and looked up
 * under another — and the symptom of that is a report with no pictures and
 * nothing in any log saying why.
 *
 * THE PAGE IS IN THE KEY, not just the image URL. The same chart syndicated
 * onto two sites is two figures with two attributions, and a key that collapsed
 * them would credit whichever page happened to be absorbed second.
 * @param documentId - the `mission_documents.id` the figure was found on.
 * @param url - the absolute image URL.
 * @returns lowercase hex sha256 of the pair.
 */
export function figureIdFor(documentId, url) {
  const normalized = normalizeUrl(url);
  if (normalized === undefined) {
    throw new Error(`cannot key a figure by an unparseable url: ${JSON.stringify(url)}`);
  }
  return sha256(`${assertText(documentId, "documentId")}\n${normalized}`);
}

/** Lowercase hex sha256 of raw bytes. `sha256` stringifies, and would hash "[object Object]". */
function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Turn one joined `mission_figures` row into camelCase. NEVER carries bytes.
 *
 * `page` is the attribution and it travels ON the row rather than beside it.
 * Rule 2 is a property of the thing that reaches a screen: an image whose page
 * title and page URL arrive by a separate lookup is an image that can arrive
 * without them. Every read below selects FIGURE_COLUMNS, which joins the page,
 * so `page` is never null on anything a caller can obtain.
 */
function shapeFigure(row) {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    documentId: row.document_id,
    // The publisher's own image address. Present to be CREDITED and to be
    // fetched by the byte driver — never handed to a browser as a `src`.
    url: row.url,
    host: row.host,
    alt: row.alt ?? null,
    caption: row.caption ?? null,
    anchorText: row.anchor_text ?? null,
    textOffset: row.text_offset,
    width: row.width,
    height: row.height,
    score: row.score,
    signals: parseJson(row.signals, []),
    state: row.state,
    reason: row.reason ?? null,
    mime: row.mime ?? null,
    status: row.status,
    byteLength: row.byte_length,
    contentHash: row.content_hash ?? null,
    lastSeenAt: row.last_seen_at,
    discoveredAt: row.discovered_at,
    fetchedAt: row.fetched_at ?? null,
    page: { documentId: row.document_id, url: row.page_url, title: row.page_title ?? null, host: row.page_host },
  };
}

export const MISSION_MIGRATIONS = Object.freeze([
  Object.freeze({ id: "001-spine", up: (db) => db.exec(MISSION_DDL_SPINE) }),
  Object.freeze({ id: "002-corpus", up: (db) => db.exec(MISSION_DDL_CORPUS) }),
  Object.freeze({ id: "003-report", up: (db) => db.exec(MISSION_DDL_REPORT) }),
  Object.freeze({ id: "004-owner", up: (db) => db.exec(MISSION_DDL_OWNER) }),
  // FIGURES WERE EVIDENCE WITH NOWHERE TO LIVE. `readHit` calls `readArticle`
  // and keeps `.text`; `readArticle`'s own turndown rule strips
  // ["img","picture","figure"] before the markdown exists, so no hop downstream
  // ever saw an image at all. This table is where one lands.
  //
  // A NEW TABLE, so the migration is one CREATE IF NOT EXISTS and needs no
  // PRAGMA guard. 005..008 each widen a table that already exists on somebody's
  // disk and cannot do without one; this has nothing to widen.
  //
  // Its position is not a dependency: it references none of 005..008's tables,
  // and `#migrate` runs the whole pending list inside ONE transaction, so
  // either every pending entry applies or none does. It sits at the head of the
  // block below because that block reads newest-first, which is where 008 sits.
  Object.freeze({ id: "009-figures", up: (db) => db.exec(MISSION_DDL_FIGURES) }),
  // `args_text` landed after libraries already held tool-call rows, so the DDL
  // above cannot reach them: CREATE TABLE IF NOT EXISTS does nothing to a table
  // that exists. Without this, the first insert after an upgrade fails on a
  // column the schema says is there — on somebody else's machine, at the first
  // tool call of a mission they just started.
  // THE CEILING WAS A LIFETIME BUDGET. `mission_spend` and `mission_tool_calls`
  // had no generation column, and `budgetFor` seeds the pool from the whole
  // mission — deliberately, so a RESUME does not get the ceiling again. For a
  // FRESH RERUN that is the opposite of what is wanted: run 9 of this mission
  // opened with nine runs of spend already against a cap chosen for one, so
  // s3-collect failed all eight dimensions with `budget_exhausted` five
  // milliseconds in, and reported "0 of 0 dimensions returned no verifiable
  // evidence" — a sentence about evidence for a failure about money.
  //
  // One column serves both: a resume keeps its generation and keeps
  // accumulating, a fresh rerun bumps it and starts clean. Rows written before
  // this migration get 0, which belongs to no generation — they are history,
  // and no run's ceiling counts them.
  // The dimension plan belongs to the generation that planned it, the way
  // findings, chapters and artefacts already do. SQLite cannot alter a primary
  // key, so the table is rebuilt; the whole migration list runs in one
  // transaction, so a half-rebuilt table is not reachable.
  //
  // Existing rows are backfilled to the LAST generation whose findings cite
  // them, because the row's state, grade and summary are from its last write
  // and that is the generation that wrote them. A dimension no finding ever
  // cited takes the mission's current generation: it is part of the plan on
  // screen, and retiring it to a generation nobody queries would empty a
  // running mission's pane.
  // WHICH MODEL SPENT IT. The ledger recorded the role, the agent instance
  // and four token counts, and never the model — so "which model ran this
  // stage, how many calls did it take, what share of the tokens did it eat"
  // could not be asked at all. The value was in hand the whole time:
  // streamTurn passes route.model to ctx.llm.stream on every call.
  //
  // Rows written before this get NULL, which is honest — nobody recorded it
  // then — and reads as "not recorded" rather than as some model's name.
  Object.freeze({
    id: "008-spend-model",
    up: (db) => {
      const has = db.prepare("PRAGMA table_info(mission_spend)").all().some((column) => column.name === "model");
      if (!has) db.exec("ALTER TABLE mission_spend ADD COLUMN model TEXT");
    },
  }),
  Object.freeze({
    id: "007-dimension-generation",
    up: (db) => {
      const has = db.prepare("PRAGMA table_info(mission_dimensions)").all().some((c) => c.name === "run_count");
      if (has) return;
      db.exec(`
        CREATE TABLE mission_dimensions_rebuilt (
          mission_id      TEXT NOT NULL,
          dimension_id    TEXT NOT NULL,
          name            TEXT NOT NULL,
          rationale       TEXT,
          facet           TEXT NOT NULL,
          state           TEXT NOT NULL,
          attempt         INTEGER NOT NULL DEFAULT 0,
          grade           REAL,
          grade_axes      TEXT,
          summary         TEXT,
          failure_code    TEXT,
          run_count       INTEGER NOT NULL DEFAULT 0,
          updated_at      TEXT NOT NULL,
          PRIMARY KEY (mission_id, run_count, dimension_id)
        ) STRICT;
        INSERT INTO mission_dimensions_rebuilt (
          mission_id, dimension_id, name, rationale, facet, state, attempt,
          grade, grade_axes, summary, failure_code, run_count, updated_at
        )
        SELECT d.mission_id, d.dimension_id, d.name, d.rationale, d.facet, d.state, d.attempt,
               d.grade, d.grade_axes, d.summary, d.failure_code,
               COALESCE(
                 (SELECT MAX(f.run_count) FROM mission_findings f
                   WHERE f.mission_id = d.mission_id AND f.dimension_id = d.dimension_id),
                 (SELECT m.run_count FROM missions m WHERE m.id = d.mission_id),
                 0
               ),
               d.updated_at
        FROM mission_dimensions d;
        DROP TABLE mission_dimensions;
        ALTER TABLE mission_dimensions_rebuilt RENAME TO mission_dimensions;
      `);
    },
  }),
  Object.freeze({
    id: "006-spend-generation",
    up: (db) => {
      for (const table of ["mission_spend", "mission_tool_calls"]) {
        const has = db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === "run_count");
        if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0`);
      }
    },
  }),
  Object.freeze({
    id: "005-tool-args",
    up: (db) => {
      const has = db.prepare("PRAGMA table_info(mission_tool_calls)").all()
        .some((column) => column.name === "args_text");
      if (!has) db.exec("ALTER TABLE mission_tool_calls ADD COLUMN args_text TEXT NOT NULL DEFAULT ''");
    },
  }),
  // WHICH PICTURES A VERSION PLACED, FROZEN. `evidence` exists because the live
  // findings and documents move on and "a versioned report must carry its own
  // provenance regardless of what the live tables later hold"; a caption is the
  // same kind of claim and rots the same way, only faster. `putFigures` upserts
  // on (page, image url) — a key that deliberately survives a caption edit — and
  // its ON CONFLICT list refreshes `caption` and `alt` in place, so the next
  // run's parse of a rewritten <figcaption> BECOMES version 1's caption with
  // nothing recorded anywhere. `holdFigure` does the same to `bytes` and
  // `content_hash` when a publisher swaps the image at one address. Freeze the
  // words and the byte hash here and version 1 stays checkable; leave them live
  // and version 1 shows version 2's caption under version 2's picture, credited
  // to version 1's chapter, and nothing throws.
  //
  // A COLUMN ADD, so it carries the PRAGMA guard 005/006/008 carry: ALTER TABLE
  // is not idempotent and the DDL above cannot reach a table that already
  // exists on somebody's disk. Rows written before this get '[]', which is
  // honest — those reports placed no figures because there were none to place.
  //
  // At the tail rather than beside 009 because the two are independent: this
  // widens a table 003 created and touches nothing 009 makes, so whichever runs
  // first, the one transaction the ledger opens either applies both or neither.
  Object.freeze({
    id: "010-figure-manifest",
    up: (db) => {
      const has = db.prepare("PRAGMA table_info(mission_artifacts)").all().some((column) => column.name === "figures");
      if (!has) db.exec("ALTER TABLE mission_artifacts ADD COLUMN figures TEXT NOT NULL DEFAULT '[]'");
    },
  }),

  // THE RECLAIM COUNTER, SPLIT OFF FROM THE GENERATION KEY.
  //
  // `run_count` was doing two jobs. It is the GENERATION KEY — every read
  // that must see one attempt's work and not another's is scoped by it — and
  // it was also the RECLAIM COUNTER that `canResume` refuses at.
  //
  // A fresh rerun wants both advanced. A RESUME wants only the counter: it
  // continues an attempt, so the slate has to stay. It advanced both, which
  // left every completed stage's rows one generation behind and invisible to
  // the stages the resume re-ran.
  //
  // Measured on a real mission: eight chapters and 107 citations in
  // generation 3, a continuation into generation 4, and s12 assembling a
  // 413-word stub because it could see none of them.
  //
  // Backfilled from `run_count`, which is what the limit has been reading all
  // along, so no mission's standing with the limit changes on migration.
  Object.freeze({
    id: "011-reclaim-count",
    up: (db) => {
      const has = db.prepare("PRAGMA table_info(missions)").all().some((column) => column.name === "reclaim_count");
      if (!has) db.exec("ALTER TABLE missions ADD COLUMN reclaim_count INTEGER NOT NULL DEFAULT 0");
      db.exec("UPDATE missions SET reclaim_count = run_count WHERE reclaim_count = 0");
    },
  }),
]);

// ── small helpers ─────────────────────────────────────────────────────────

/**
 * The later of two ISO stamps, tolerating a null second one.
 *
 * ISO 8601 with a fixed zone sorts lexicographically, which is why the column
 * type is TEXT; this relies on that rather than parsing, so a stamp SQLite would
 * store and every reader would misread cannot become a NaN comparison that is
 * false against everything.
 *
 * @param first - an ISO stamp.
 * @param second - an ISO stamp, or null.
 * @returns the later of the two.
 */
function maxIso(first, second) {
  if (second === null || second === undefined) return first;
  if (first === null || first === undefined) return second;
  return second > first ? second : first;
}

/** ISO 8601 with a `T` and a zone, which is what `toISOString` produces. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Shape of a mission id this module mints; the routes reject anything else. */
const MISSION_ID_PATTERN = /^mission-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/**
 * The event a settled stage writes, by the status it settled with.
 *
 * A table rather than a ternary because the three statuses answer three
 * different questions for the reader — finished, finished over something,
 * stopped — and folding `degraded` into `done` is how a swallowed failure
 * becomes a mission that reports success. `skipped-by-tier` and the two
 * non-terminal statuses have no entry: they never reach `finishStage`.
 */
const STAGE_EVENT_FOR_STATUS = Object.freeze({
  done: "stage:done",
  degraded: "stage:degraded",
  failed: "stage:failed",
});

/** One MissionStore per SourceStore; see openMissionStore. */
const STORES = new WeakMap();

/** Parse JSON text back to a value, tolerating a malformed row. */
function parseJson(text, fallback) {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** JSON text for a value, or null when there is nothing to store. */
function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
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
 * timestamp column. A `last_progress_at` that will not parse makes the
 * no-progress guard compute NaN, every comparison against NaN is false, and the
 * guard silently never fires again for that mission.
 */
function assertIso(value, field) {
  if (typeof value !== "string" || !ISO_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO 8601 instant like 2026-01-31T09:00:00.000Z; got ${JSON.stringify(value)}`);
  }
}

/** A non-empty trimmed string, or a throw naming the field. */
function assertText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${field} must be a non-empty string; got ${JSON.stringify(value)}`);
  return text;
}

/** A whole number at or above `low`, refusing anything else by name. */
function assertCount(value, field, low = 0) {
  const parsed = Number(value);
  // Rejected rather than coerced: Number(undefined) is NaN, a NaN written to a
  // ceiling makes every `used >= limit` comparison false, and the budget pool
  // then never drains — the mission runs to the wall clock with no explanation.
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < low) {
    throw new Error(`${field} must be a whole number >= ${low}; got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** An integer within bounds, for take/limit style parameters. */
function clampInt(value, low, high, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(low, Math.min(high, Math.trunc(parsed)));
}

/**
 * A finite number or null, for scores that are legitimately absent.
 *
 * THE EXPLICIT NULL IS THE CASE THIS EXISTS FOR, and it was the one case it
 * got wrong. `Number(null)` is 0, not NaN, so every `score: null` handed to
 * it landed in the column as a nought: s7 and s8 write exactly that for a
 * chapter they have planned and not yet reviewed. A REAL column that stores
 * `never scored` as zero cannot be read back afterwards, because 0 is also a
 * score a reviewer can give, and the two readings are opposite ones. It
 * survived this long because `undefined` DOES come back null, so only the
 * callers explicit enough to pass the null were hit.
 */
function numberOrNull(value) {
  // Empty string as well: `Number("")` is 0 by the same rule.
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 0 or 1 for a STRICT INTEGER column standing in for a boolean. */
function flag(value) {
  return value ? 1 : 0;
}

/** Lowercase hex sha256 of some text. */
function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

/** `now` shifted back by whole days, as ISO text. */
function isoDaysBefore(nowIso, days) {
  const at = Date.parse(nowIso);
  if (!Number.isFinite(at)) throw new Error(`a window start needs a parseable now; got ${JSON.stringify(nowIso)}`);
  return new Date(at - days * 86400000).toISOString();
}

/**
 * A sortable, collision-resistant mission id, mirroring `newInsightId`.
 * @param at - the creation instant.
 * @returns `mission-<YYYYMMDDTHHMMSSZ>-<8 hex>`.
 */
export function newMissionId(at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `mission-${stamp}-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`;
}

/**
 * Whether a string is a mission id this module could have minted.
 * @param id - a candidate id, typically off a URL.
 * @returns true when it matches the mint pattern.
 */
export function isMissionId(id) {
  return typeof id === "string" && MISSION_ID_PATTERN.test(id);
}

/**
 * The `mission_documents.id` a URL must be stored under.
 *
 * Exported because it is half of the attribution guarantee: `insertFinding`
 * requires `document_id === documentIdFor(source_url)` for any fetch-backed
 * verified state, and the fetch path has to mint the same id or every insert
 * fails. Throws on an unparseable URL rather than falling back to the raw
 * string — a document we cannot key is a document whose cache and whose
 * attribution check both silently stop working.
 * @param url - the source URL.
 * @returns lowercase hex sha256 of the normalized URL.
 */
export function documentIdFor(url) {
  const normalized = normalizeUrl(url);
  if (normalized === undefined) {
    throw new Error(`cannot key a document by an unparseable url: ${JSON.stringify(url)}`);
  }
  return sha256(normalized);
}

/**
 * The host a finding's independence is counted by.
 *
 * Denormalised onto the finding row at write time. Deriving it later by parsing
 * `source_url` again is the same value until somebody changes the parse, at
 * which point every historical count moves with no migration and no error.
 * @param url - the source URL.
 * @returns the lowercase host without `www.`, or `"unknown"`.
 */
export function sourceHostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    // "unknown" rather than a throw: every unkeyable source collapses into one
    // independence key, so ten of them count as one and nothing is ever
    // over-credited. That is the safe direction, and stats() counts them so the
    // gap is visible rather than assumed away.
    return "unknown";
  }
}

/**
 * The distinctness key for a claim, insensitive to rephrasing noise.
 *
 * With `source_host` this is what the s4 -> s3 back edge measures. Hashing the
 * raw claim instead would let a re-search's near-duplicate wording count as new
 * evidence, so the loop's "distinct verified evidence must strictly increase"
 * condition is always satisfied and only the round cap terminates it.
 * @param claim - the claim sentence.
 * @returns lowercase hex sha256 of the normalised claim.
 */
export function claimHashOf(claim) {
  const normalised = String(claim ?? "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return sha256(normalised);
}

/**
 * The status a UI may show, with an evidence-based fallback.
 *
 * There is no `default: return 'running'`. That fall-through is what
 * manufactures a forever-running mission with a live cancel button that 400s on
 * every click. An unrecognised status carrying `completed_at` is `failed` — we
 * know the work ended, not that it succeeded.
 * @param status - the persisted status.
 * @param completedAt - the row's `completed_at`, or null.
 * @returns a member of MISSION_STATUSES.
 */
export function publicStatus(status, completedAt) {
  if (MISSION_STATUSES.includes(status)) return status;
  // Both branches are `failed`, and the parameter is kept because the two cases
  // are different diagnoses even though the display is the same: with a
  // `completed_at` the row ended and the vocabulary drifted; without one the row
  // was abandoned. Neither is `running`, which is the only answer that would
  // give the user a cancel button that cannot work.
  return completedAt ? "failed" : "failed";
}

/** Turn one `missions` row into the camelCase shape every reader uses. */
function shapeMission(row) {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    topic: row.topic,
    depth: row.depth,
    language: row.language,
    status: publicStatus(row.status, row.completed_at),
    // Kept beside the mapped one so a status that fell through the mapping is
    // visible to the projector rather than only to a log line nobody reads.
    rawStatus: row.status,
    budget: {
      maxTokens: row.max_tokens,
      maxCalls: row.max_calls,
      maxArxiv: row.max_arxiv,
      maxWeb: row.max_web,
      maxFetch: row.max_fetch,
      wallMs: row.wall_ms,
    },
    retryBelowSeam: row.retry_below_seam === 1,
    goals: parseJson(row.goals, null),
    derivedFloor: row.derived_floor ?? null,
    bootId: row.boot_id ?? null,
    pid: row.pid ?? null,
    lastProgressAt: row.last_progress_at ?? null,
    lastStage: row.last_stage ?? null,
    patchRound: row.patch_round,
    // THE GENERATION KEY. Every read scoped to one attempt uses this.
    runCount: row.run_count,
    // AND THE TIMES IT HAS BEEN PICKED BACK UP, which is a different fact.
    // Coalesced to `run_count` so a row written before 011 reads as it always
    // did rather than as zero, which would hand a mission that has crashed
    // three times a fresh set of attempts.
    reclaimCount: row.reclaim_count ?? row.run_count,
    startedAt: row.started_at,
    lastReopenedAt: row.last_reopened_at ?? null,
    // The clock every wall-time decision measures from. Computed here, once, so
    // three call sites cannot each pick a different one — `checkDeadlines` now
    // reads this rather than re-deriving it from the two raw columns.
    //
    // MAX, not COALESCE. A `last_reopened_at` earlier than `started_at` — clock
    // skew, a restored file, a hand-edited row — would otherwise move the wall
    // clock BACKWARDS and hand the run more time than its cap allows, silently.
    effectiveStartedAt: maxIso(row.started_at, row.last_reopened_at),
    completedAt: row.completed_at ?? null,
    failureCode: row.failure_code ?? null,
    errorMessage: row.error_message ?? null,
    // null / true / false, never coerced: null means the mission died before
    // sign-off, false means the Leader read the report and refused.
    leaderSigned: row.leader_signed === null || row.leader_signed === undefined ? null : row.leader_signed === 1,
    leaderScore: row.leader_score ?? null,
    leaderVerdict: row.leader_verdict ?? null,
    finalScore: row.final_score ?? null,
    softWarnedAt: row.soft_warned_at ?? null,
    exhaustedAt: row.exhausted_at ?? null,
    traceEnabled: row.trace_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every column shapeMission reads, so no reader is served a half row. */
const MISSION_COLUMNS = `
  id, topic, depth, language, status,
  max_tokens, max_calls, max_arxiv, max_web, max_fetch, wall_ms,
  retry_below_seam, goals, derived_floor, boot_id, pid,
  last_progress_at, last_stage, patch_round, run_count,
  started_at, last_reopened_at, completed_at, failure_code, error_message,
  leader_signed, leader_score, leader_verdict, final_score,
  soft_warned_at, exhausted_at, trace_enabled, created_at, updated_at
`;

/** Turn one `mission_stages` row into camelCase. */
function shapeStage(row) {
  return {
    stepId: row.step_id,
    ordinal: row.ordinal,
    status: row.status,
    attempts: row.attempts,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    durationMs: row.duration_ms ?? null,
    tokens: row.tokens,
    output: parseJson(row.output, null),
    degradeNote: row.degrade_note ?? null,
  };
}

/** Turn one `mission_dimensions` row into camelCase. */
function shapeDimension(row) {
  return {
    dimensionId: row.dimension_id,
    name: row.name,
    rationale: row.rationale ?? null,
    facet: row.facet,
    state: row.state,
    attempt: row.attempt,
    grade: row.grade ?? null,
    gradeAxes: parseJson(row.grade_axes, null),
    summary: row.summary ?? null,
    failureCode: row.failure_code ?? null,
    updatedAt: row.updated_at,
  };
}

/** Turn one `mission_findings` row into camelCase. */
function shapeFinding(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    dimensionId: row.dimension_id,
    runCount: row.run_count,
    attempt: row.attempt,
    claim: row.claim,
    claimHash: row.claim_hash,
    evidence: row.evidence,
    sourceUrl: row.source_url,
    sourceHost: row.source_host,
    sourceTitle: row.source_title ?? null,
    publishedAt: row.published_at ?? null,
    verifyState: row.verify_state,
    verifyReason: row.verify_reason ?? null,
    documentId: row.document_id ?? null,
    spanIndex: row.span_index ?? null,
    // The one derived flag every gate asks for, computed in one place so no
    // caller re-spells the evidence boundary as a literal.
    counts: row.verify_state === COUNTING_VERIFY_STATE,
    createdAt: row.created_at,
  };
}

/** Every column shapeFinding reads. */
const FINDING_COLUMNS = `
  id, mission_id, dimension_id, run_count, attempt, claim, claim_hash, evidence,
  source_url, source_host, source_title, published_at,
  verify_state, verify_reason, document_id, span_index, created_at
`;

/**
 * The figure columns every read selects, WITH the page joined on.
 *
 * One list rather than four, because the reads differ only in their WHERE
 * clause and a column added to one and not the others is exactly the "field
 * that does not survive a hop" defect: the chapter's figures would quietly
 * carry an attribution the mission's figures did not. It is also why `page` in
 * `shapeFigure` can be unconditional — every read that produces a shaped figure
 * goes through here, and every one of them INNER JOINs the page.
 *
 * `bytes` is absent and must stay absent. These reads run per render, and a
 * metadata read that drags a megabyte a row through memory to draw a caption is
 * the reason `figureBytes` is a separate method a reader can grep for.
 */
const FIGURE_COLUMNS = `
  g.id AS id, g.document_id AS document_id, g.url AS url, g.host AS host,
  g.alt AS alt, g.caption AS caption, g.anchor_text AS anchor_text,
  g.text_offset AS text_offset, g.width AS width, g.height AS height,
  g.score AS score, g.signals AS signals, g.state AS state, g.reason AS reason,
  g.mime AS mime, g.status AS status, g.byte_length AS byte_length,
  g.content_hash AS content_hash, g.last_seen_at AS last_seen_at,
  g.discovered_at AS discovered_at, g.fetched_at AS fetched_at,
  d.url AS page_url, d.title AS page_title, d.host AS page_host
`;

/**
 * The predicate that keeps a figure tied to the page version we hold.
 *
 * Written once and spliced into all three scoped reads, because three copies of
 * one rule is three chances for a renderer's query and the byte route's query
 * to disagree about which pictures still exist — and the copy that disagreed
 * would be the one handing out bytes.
 */
const FIGURE_STILL_ON_PAGE = "g.last_seen_at = d.fetched_at";

/** Turn one `mission_documents` row into camelCase. */
function shapeDocument(row) {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    url: row.url,
    host: row.host,
    title: row.title ?? null,
    markdown: row.markdown,
    contentHash: row.content_hash,
    charCount: row.byte_length,
    status: row.status,
    fetchedAt: row.fetched_at,
    // Precomputed rather than left to each caller: the two preconditions of a
    // verified state are checked at insert AND read here, because two verifiers
    // with different ideas of what counts is how a guarantee holds at one call
    // site and not the other.
    admissible: row.status >= 200 && row.status < 300 && row.byte_length >= MIN_DOCUMENT_CHARS,
  };
}

/** Turn one `mission_chapters` row into camelCase. */
function shapeChapter(row) {
  return {
    runCount: row.run_count,
    dimensionId: row.dimension_id,
    chapterIndex: row.chapter_index,
    sectionType: row.section_type,
    heading: row.heading,
    body: row.body ?? null,
    wordCount: row.word_count,
    minDelivery: row.min_delivery,
    underDelivered: row.under_delivered === 1,
    decision: row.decision ?? null,
    score: row.score ?? null,
    attempts: row.attempts,
    inputHash: row.input_hash,
    updatedAt: row.updated_at,
  };
}

/** Turn one `mission_artifacts` row into camelCase. */
function shapeArtifact(row) {
  if (row === undefined) return undefined;
  return {
    missionId: row.mission_id,
    version: row.version,
    runCount: row.run_count,
    trigger: row.trigger,
    title: row.title,
    markdown: row.markdown,
    sections: parseJson(row.sections, []),
    citations: parseJson(row.citations, []),
    // Frozen for the same reason `evidence` is, and read back the same way. A
    // manifest the writer stores and the shaper drops is a write-only column:
    // every projection would see `figures: undefined`, decide the version
    // placed none, and the freeze would protect nothing while looking applied.
    figures: parseJson(row.figures, []),
    evidence: parseJson(row.evidence, []),
    quality: parseJson(row.quality, {}),
    wordCount: row.word_count,
    degraded: row.degraded === 1,
    createdAt: row.created_at,
  };
}

/** Turn one `mission_events` row into camelCase. */
function shapeEvent(row) {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    class: row.class,
    agentId: row.agent_id ?? null,
    stepId: row.step_id ?? null,
    payload: parseJson(row.payload, {}),
  };
}

/**
 * The one MissionStore for this SourceStore, memoised on the instance.
 *
 * Memoised rather than constructed twice because construction runs the migration
 * ledger, and while every migration is idempotent, two instances would be two
 * places to look when a statement is wrong.
 * @param store - the open SourceStore.
 * @returns the MissionStore layered over its handle.
 */
export function openMissionStore(store) {
  if (store === null || typeof store !== "object" || store.db === undefined) {
    throw new TypeError("openMissionStore needs the SourceStore, not a path");
  }
  const existing = STORES.get(store);
  if (existing !== undefined) return existing;
  const created = new MissionStore(store);
  STORES.set(store, created);
  return created;
}

/** Mission rows, layered over the source library's own database handle. */
export class MissionStore {
  /**
   * Apply the migration ledger over an open SourceStore.
   * @param store - the SourceStore whose `db` handle this shares.
   */
  constructor(store) {
    if (store === null || typeof store !== "object" || !(store.db instanceof DatabaseSync)) {
      throw new TypeError("openMissionStore needs the SourceStore, not a path");
    }
    this.store = store;
    this.db = store.db;
    this.db.exec(LEDGER_DDL);
    this.#migrate();
    this.#patchForeignTables();
    // Deliberately no close(): the handle belongs to the SourceStore, and
    // offering a close here is an invitation to shut the whole library from a
    // route handler.
  }

  /**
   * Run every unapplied migration, in order, in one transaction.
   *
   * One transaction for the lot rather than one each: a process killed between
   * two migrations otherwise leaves a shape no version number describes, and the
   * ledger would claim the first was applied while the second's tables are
   * missing.
   */
  #migrate() {
    const applied = new Set(
      this.db.prepare("SELECT id FROM mission_schema").all().map((row) => String(row.id)),
    );
    const pending = MISSION_MIGRATIONS.filter((migration) => !applied.has(migration.id));
    if (pending.length === 0) return;

    withTx(this.db, () => {
      const record = this.db.prepare("INSERT INTO mission_schema (id, applied_at) VALUES (?,?)");
      const at = new Date().toISOString();
      for (const migration of pending) {
        migration.up(this.db);
        record.run(migration.id, at);
      }
    });
  }

  /**
   * Columns this module needs on tables another module owns.
   *
   * NOT a ledger migration, and the distinction matters: `insights` is created by
   * `insight-store.js`, which may not have opened yet. A ledger entry that ran
   * against a missing table and recorded itself as applied would never run again,
   * so the column would be permanently absent on exactly the machines where the
   * ordering went the other way. Checked every init instead — the
   * `PRAGMA table_info` pattern `store.js` already uses for `cues`.
   */
  #patchForeignTables() {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'insights'")
      .all();
    if (tables.length === 0) return;
    const columns = this.db.prepare("PRAGMA table_info(insights)").all();
    if (columns.some((column) => column.name === "origin")) return;
    // `pass` as the default, because every row that exists when this runs was
    // written by the hourly pass. NULL-able would make "never recorded" and
    // "written by the pass" indistinguishable, and the two overlap for two
    // phases while both writers share the ledger.
    this.db.exec("ALTER TABLE insights ADD COLUMN origin TEXT NOT NULL DEFAULT 'pass'");
  }

  /**
   * Run `fn` inside a transaction on this library's connection.
   *
   * The module-level `withTx(db, fn)` above needs the handle, and the handle is
   * `store.db` — so a caller that has only the MissionStore either reached
   * through `missions.db` to get it or, worse, opened its own `BEGIN`. Both are
   * how three modules end up each believing they own the transaction, which is
   * §5.0's single most destructive defect: the inner `catch`'s `ROLLBACK`
   * destroys the OUTER transaction and the outer `COMMIT` then throws with the
   * rows already gone.
   *
   * Re-entrant via savepoints, so a store method that opens its own transaction
   * inside this one nests rather than throwing.
   *
   * @param fn - a SYNCHRONOUS function; its return value is returned.
   * @returns whatever `fn` returned.
   */
  withTx(fn) {
    return withTx(this.db, fn);
  }

  /**
   * Which migrations this library has recorded.
   *
   * Read by the health route: a library whose ledger is short of
   * `MISSION_MIGRATIONS` is a library that failed to migrate, and that is a
   * different problem from an empty one.
   * @returns `{ applied: [{id, appliedAt}], pending: [id] }`.
   */
  schemaState() {
    const rows = this.db.prepare("SELECT id, applied_at FROM mission_schema ORDER BY id").all();
    const applied = new Set(rows.map((row) => String(row.id)));
    return {
      applied: rows.map((row) => ({ id: row.id, appliedAt: row.applied_at })),
      pending: MISSION_MIGRATIONS.filter((migration) => !applied.has(migration.id)).map((m) => m.id),
    };
  }

  /**
   * Assert every persisted status has a public mapping.
   *
   * Called once at boot. The reference's display mapping fell out of step with
   * its writers and defaulted to `running`, which made cancel permanently
   * impossible on every affected mission; the whole failure is one `SELECT
   * DISTINCT` away from being caught at startup instead.
   * @returns the unmapped statuses found, empty when the vocabulary is intact.
   */
  assertStatusVocabulary() {
    const rows = this.db.prepare("SELECT DISTINCT status FROM missions").all();
    return rows.map((row) => String(row.status)).filter((status) => !MISSION_STATUSES.includes(status));
  }

  // ── missions ────────────────────────────────────────────────────────────

  /**
   * Open a mission: the row, its frozen config revision and all of its stage
   * rows, in one transaction.
   *
   * The stage rows are written HERE rather than lazily, because the stage count
   * has to be invariant: a `quick` mission writes its four `skipped-by-tier`
   * rows at open, so the UI never has to decide whether a missing row means
   * pending or excluded. The twelve declarations come from the pipeline module —
   * this store does not know how many stages there are and must not, or the
   * pipeline length would be spelt in two files.
   *
   * @param record - `{ id?, topic, depth, language?, budget, retryBelowSeam?, bootId, pid?, trace?, config, at? }`.
   * @param stages - `[{ stepId, ordinal, status? }]`, ordinals 1..n with no gaps.
   * @returns `{ id, revision, stages }`.
   */
  createMission(record, stages) {
    const topic = assertText(record?.topic, "topic");
    assertMember(record?.depth, DEPTH_TIERS, "depth");
    const language = typeof record?.language === "string" && record.language !== "" ? record.language : "zh";
    const bootId = assertText(record?.bootId, "bootId");
    const at = record?.at ?? new Date().toISOString();
    assertIso(at, "at");

    const budget = record?.budget ?? {};
    const maxTokens = assertCount(budget.maxTokens, "budget.maxTokens", 1);
    const maxCalls = assertCount(budget.maxCalls, "budget.maxCalls", 1);
    const maxArxiv = assertCount(budget.maxArxiv, "budget.maxArxiv", 0);
    const maxWeb = assertCount(budget.maxWeb, "budget.maxWeb", 0);
    const maxFetch = assertCount(budget.maxFetch, "budget.maxFetch", 0);
    const wallMs = assertCount(budget.wallMs, "budget.wallMs", 1000);

    if (record?.config === undefined || record.config === null) {
      throw new Error("createMission needs the resolved config to freeze as revision 1; pass resolveBudget()'s whole answer");
    }
    const rows = this.#validateStageRows(stages, record.depth);
    const id = typeof record?.id === "string" && record.id !== "" ? record.id : newMissionId(new Date(at));

    return withTx(this.db, () => {
      this.db.prepare(`
        INSERT INTO missions (
          id, topic, depth, language, status,
          max_tokens, max_calls, max_arxiv, max_web, max_fetch, wall_ms,
          retry_below_seam, boot_id, pid, last_progress_at, patch_round, run_count,
          started_at, trace_enabled, created_at, updated_at
        ) VALUES (?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?,0,1,?,?,?,?)
      `).run(
        id, topic, record.depth, language,
        maxTokens, maxCalls, maxArxiv, maxWeb, maxFetch, wallMs,
        flag(record?.retryBelowSeam), bootId,
        Number.isInteger(record?.pid) ? record.pid : null,
        at, at, flag(record?.trace), at, at,
      );
      this.#writeStageRows(id, rows);
      const revision = this.#insertConfig(id, "fresh", record.config, at);
      this.#appendEventRow(id, {
        type: "mission:created",
        stepId: null,
        payload: { topic, depth: record.depth, revision },
        at,
      });
      return { id, revision, stages: rows.length };
    });
  }

  /**
   * One mission.
   * @param id - the mission id.
   * @returns the camelCase row, or undefined when there is no such row.
   */
  getMission(id) {
    return shapeMission(this.db.prepare(`SELECT ${MISSION_COLUMNS} FROM missions WHERE id = ?`).get(String(id)));
  }


  /**
   * Delete a mission and everything hanging off it.
   *
   * There was no way to remove one at all — no store method, no route, no
   * button. A list that only grows is a list nobody opens, and the first thing
   * anybody does with a run that failed for a reason they have since fixed is
   * try to get rid of it.
   *
   * A RUNNING mission is refused rather than deleted: the runtime holds its id
   * and would go on writing stages and events against rows that no longer
   * exist. Cancel it first, which is what the refusal says.
   *
   * @param missionId - the mission to remove.
   * @returns `{ok}` and, when refused, `reason` — never a silent false.
   */
  deleteMission(missionId) {
    const id = assertText(missionId, "missionId");
    const row = this.db.prepare("SELECT status FROM missions WHERE id = ?").get(id);
    if (row === undefined) return { ok: false, reason: `no mission ${id}` };
    if (row.status === "running") {
      return { ok: false, reason: `mission ${id} is running. Cancel it first — deleting a live one leaves the runtime writing stages and events against rows that are gone.` };
    }
    return withTx(this.db, () => {
      // Children first, then the row itself. Ordered rather than relying on a
      // cascade, because `notes` beside this schema deliberately has no foreign
      // key and neither do these — a delete that half-succeeded would leave
      // evidence pointing at a mission the list no longer shows.
      let removed = 0;
      for (const table of [
        "mission_tool_calls", "mission_spend", "mission_events", "mission_checkpoints",
        "mission_findings", "mission_chapters", "mission_artifacts", "mission_dimensions",
        "mission_conflicts", "mission_stages",
      ]) {
        try {
          removed += this.db.prepare(`DELETE FROM ${table} WHERE mission_id = ?`).run(id).changes;
        } catch {
          // A table this schema version does not have is not an error here: the
          // list is written once and the migrations add tables over time.
        }
      }
      const gone = this.db.prepare("DELETE FROM missions WHERE id = ?").run(id).changes;
      return { ok: gone > 0, removed, reason: gone > 0 ? undefined : `mission ${id} vanished between the check and the delete` };
    });
  }
  /**
   * Page the mission list, with the numbers the list row shows.
   *
   * The counts come from ONE extra query over the page's ids rather than one per
   * row: the list is the hot path and an N+1 here is twenty round trips per
   * render that nothing reports.
   * @param options - `{ status, depth, search, take, skip }`.
   * @returns `{ missions, total, hasMore, counts }`.
   */
  listMissions({ status, depth, search, take = 20, skip = 0 } = {}) {
    const where = [];
    const params = [];
    if (typeof status === "string" && status !== "") {
      assertMember(status, MISSION_STATUSES, "status");
      where.push("status = ?");
      params.push(status);
    }
    if (typeof depth === "string" && depth !== "") {
      assertMember(depth, DEPTH_TIERS, "depth");
      where.push("depth = ?");
      params.push(depth);
    }
    if (typeof search === "string" && search.trim() !== "") {
      // An unavoidable full scan: LIKE with a leading wildcard cannot use an
      // index, and the corpus is one row per mission a person asked for.
      where.push("topic LIKE ?");
      params.push(`%${search.trim()}%`);
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const limit = clampInt(take, 1, 100, 20);
    const offset = Math.max(0, clampInt(skip, 0, Number.MAX_SAFE_INTEGER, 0));

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM missions ${clause}`).get(...params).n;
    const rows = this.db.prepare(
      `SELECT ${MISSION_COLUMNS} FROM missions ${clause} ORDER BY started_at DESC, id LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);

    const missions = rows.map(shapeMission);
    const ids = missions.map((mission) => mission.id);
    const verified = this.#verifiedCountsFor(ids);
    const spend = this.#spendSumsFor(ids);
    for (const mission of missions) {
      mission.verifiedFindings = verified.get(mission.id) ?? 0;
      mission.spend = spend.get(mission.id) ?? { tokens: 0, calls: 0 };
    }

    const counts = {};
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS n FROM missions GROUP BY status").all()) {
      counts[row.status] = row.n;
    }
    return { missions, total, hasMore: offset + rows.length < total, counts };
  }

  /**
   * Record that work happened, without an event.
   *
   * The ordinary path stamps `last_progress_at` inside `appendEvent`. This is
   * for the places that make progress without emitting — a stage boundary, a
   * chapter accepted — so the no-progress guard cannot trip on a mission that is
   * demonstrably working but quiet.
   * @param id - the mission id.
   * @param options - `{ stepId, at }`.
   * @returns false when there is no such mission.
   */
  touchMission(id, { stepId, at = new Date().toISOString() } = {}) {
    assertIso(at, "at");
    return this.db.prepare(`
      UPDATE missions SET last_progress_at = ?, last_stage = COALESCE(?, last_stage), updated_at = ?
      WHERE id = ?
    `).run(at, stepId ?? null, at, String(id)).changes > 0;
  }

  /**
   * Store the Leader's own success criteria.
   *
   * Persisted because a resumed mission otherwise gets a degraded generic bar and
   * is reviewed against criteria it never set.
   * @param id - the mission id.
   * @param goals - any JSON-serialisable shape.
   * @param at - the write stamp.
   * @returns false when there is no such mission.
   */
  setGoals(id, goals, at = new Date().toISOString()) {
    assertIso(at, "at");
    return this.db.prepare("UPDATE missions SET goals = ?, updated_at = ? WHERE id = ?")
      .run(jsonOrNull(goals), at, String(id)).changes > 0;
  }

  /**
   * Write the evidence floor derived from measured supply after s3.
   *
   * One variable that both the prompt and the gate read. A floor hard-coded in
   * nine places is a floor nothing can reach, and chapters then rewrite until
   * wall-time.
   * @param id - the mission id.
   * @param floor - the derived per-dimension floor.
   * @param at - the write stamp.
   * @returns false when there is no such mission.
   */
  setDerivedFloor(id, floor, at = new Date().toISOString()) {
    assertIso(at, "at");
    const value = assertCount(floor, "derivedFloor", 0);
    return this.db.prepare("UPDATE missions SET derived_floor = ?, updated_at = ? WHERE id = ?")
      .run(value, at, String(id)).changes > 0;
  }

  /**
   * Advance the s4 -> s3 round counter and read it back.
   *
   * Persisted and returned in one statement so no caller can decide the loop is
   * over from a value it read before someone else incremented. The reference
   * keeps this on a per-invocation object that is never written back, which
   * makes its own round cap unreachable dead code.
   * @param id - the mission id.
   * @param at - the write stamp.
   * @returns the new round, or null when there is no such mission.
   */
  bumpPatchRound(id, at = new Date().toISOString()) {
    assertIso(at, "at");
    const row = this.db.prepare(`
      UPDATE missions SET patch_round = patch_round + 1, updated_at = ? WHERE id = ?
      RETURNING patch_round
    `).get(at, String(id));
    return row === undefined ? null : row.patch_round;
  }

  /**
   * Record the Leader's sign-off. `s11` calls this and nothing else.
   *
   * It deliberately cannot end a mission. If `s11` wrote the status, `s12`'s
   * finalize would lose the conditional-write race, `won === false`, and
   * everything hanging off it — the terminal event, the checkpoint policy, the
   * postlude queue — would never run: a refused mission would get no postmortem,
   * no claim reconciliation and no library upsert.
   * @param id - the mission id.
   * @param verdict - `{ signed, score, verdict }`; `signed` may be null.
   * @param at - the write stamp.
   * @returns false when there is no such mission.
   */
  recordSignoff(id, { signed, score, verdict } = {}, at = new Date().toISOString()) {
    assertIso(at, "at");
    return this.db.prepare(`
      UPDATE missions SET leader_signed = ?, leader_score = ?, leader_verdict = ?, updated_at = ?
      WHERE id = ?
    `).run(
      signed === null || signed === undefined ? null : flag(signed),
      numberOrNull(score),
      typeof verdict === "string" ? verdict : null,
      at, String(id),
    ).changes > 0;
  }

  /**
   * Stamp the soft budget warning, once.
   *
   * The column IS the once-only mechanism. The reference needs two in-memory maps
   * with a 60-minute expiry to fire each warning once, and leaks both.
   * @param id - the mission id.
   * @param at - the write stamp.
   * @returns `{ marked, reason }` — `already-warned` or `no-mission` when not.
   */
  markSoftWarned(id, at = new Date().toISOString()) {
    assertIso(at, "at");
    const changed = this.db.prepare(
      "UPDATE missions SET soft_warned_at = ?, updated_at = ? WHERE id = ? AND soft_warned_at IS NULL",
    ).run(at, at, String(id)).changes;
    if (changed > 0) return { marked: true, reason: null };
    return { marked: false, reason: this.#whyNoUpdate(id, "already-warned") };
  }

  /**
   * Stamp budget exhaustion, once.
   * @param id - the mission id.
   * @param at - the write stamp.
   * @returns `{ marked, reason }` — `already-exhausted` or `no-mission` when not.
   */
  markExhausted(id, at = new Date().toISOString()) {
    assertIso(at, "at");
    const changed = this.db.prepare(
      "UPDATE missions SET exhausted_at = ?, updated_at = ? WHERE id = ? AND exhausted_at IS NULL",
    ).run(at, at, String(id)).changes;
    if (changed > 0) return { marked: true, reason: null };
    return { marked: false, reason: this.#whyNoUpdate(id, "already-exhausted") };
  }

  /**
   * Why a conditional UPDATE changed nothing.
   *
   * A method that can silently do nothing has to say which nothing it did:
   * "the row is gone" and "the flag was already set" want opposite responses
   * from the caller.
   */
  #whyNoUpdate(id, whenPresent) {
    const row = this.db.prepare("SELECT id FROM missions WHERE id = ?").get(String(id));
    return row === undefined ? "no-mission" : whenPresent;
  }

  /**
   * Turn tracing on or off for one mission.
   *
   * Off by default and per-mission, because a `deep` mission is on the order of
   * 16 MB of text per run and the trace table would otherwise become the largest
   * object in the user's library file.
   * @param id - the mission id.
   * @param enabled - whether to record.
   * @param at - the write stamp.
   * @returns false when there is no such mission.
   */
  setTrace(id, enabled, at = new Date().toISOString()) {
    assertIso(at, "at");
    return this.db.prepare("UPDATE missions SET trace_enabled = ?, updated_at = ? WHERE id = ?")
      .run(flag(enabled), at, String(id)).changes > 0;
  }

  /**
   * Claim a mission for this process, atomically.
   *
   * The check and the claim are ONE statement. The reference separates them by
   * several awaits and needs a 60-second in-memory claims map with a TTL to
   * cover the window; two clicks 100 ms apart both got through anyway, each
   * deleting the other's session. Synchronously there is no window, so there is
   * nothing to patch.
   *
   * `newGeneration` is not cosmetic. A rerun-fresh must bump `run_count` so the
   * previous run's findings, chapters and artefacts survive as their own
   * generation. A rerun-INCREMENTAL must not: it reuses chapters keyed by
   * `run_count`, and bumping would orphan the very rows it means to reuse and
   * silently rewrite everything while reporting an incremental run.
   *
   * @param id - the mission id.
   * @param options - `{ bootId, pid, newGeneration = true, clearTerminal = true, at }`.
   * @returns `{ claimed, reason, runCount }`; `reason` is `no-mission` or `already-running`.
   */
  claimForRun(id, { bootId, pid, newGeneration = true, clearTerminal = true, at = new Date().toISOString() } = {}) {
    const boot = assertText(bootId, "bootId");
    assertIso(at, "at");
    return withTx(this.db, () => {
      const row = this.db.prepare(`
        UPDATE missions SET
          status = 'running',
          boot_id = ?,
          pid = ?,
          run_count = run_count + ?,
          -- ALWAYS, and this is the half that is not the key. It says how
          -- many times the mission has been picked back up, which is what
          -- canResume's limit has always been about — its own message says
          -- "the process has crashed N times". A continuation that keeps its
          -- slate still has to advance it, or a mission that crashes in the
          -- same place could be resumed for ever.
          reclaim_count = reclaim_count + 1,
          last_reopened_at = ?,
          last_progress_at = ?,
          -- Cleared so a resumed mission is not displayed with the previous
          -- run's verdict beside a live progress bar. The previous run's report
          -- is not lost: every terminal outcome wrote an artefact version, and
          -- each version carries its own frozen evidence blob.
          completed_at    = CASE WHEN ? THEN NULL ELSE completed_at END,
          failure_code    = CASE WHEN ? THEN NULL ELSE failure_code END,
          error_message   = CASE WHEN ? THEN NULL ELSE error_message END,
          leader_signed   = CASE WHEN ? THEN NULL ELSE leader_signed END,
          leader_score    = CASE WHEN ? THEN NULL ELSE leader_score END,
          leader_verdict  = CASE WHEN ? THEN NULL ELSE leader_verdict END,
          final_score     = CASE WHEN ? THEN NULL ELSE final_score END,
          soft_warned_at  = CASE WHEN ? THEN NULL ELSE soft_warned_at END,
          exhausted_at    = CASE WHEN ? THEN NULL ELSE exhausted_at END,
          updated_at = ?
        WHERE id = ? AND status <> 'running'
        RETURNING run_count
      `).get(
        boot,
        Number.isInteger(pid) ? pid : null,
        newGeneration ? 1 : 0,
        at, at,
        flag(clearTerminal), flag(clearTerminal), flag(clearTerminal), flag(clearTerminal),
        flag(clearTerminal), flag(clearTerminal), flag(clearTerminal), flag(clearTerminal),
        flag(clearTerminal),
        at, String(id),
      );
      if (row === undefined) {
        return { claimed: false, reason: this.#whyNoUpdate(id, "already-running"), runCount: null };
      }
      this.#appendEventRow(id, {
        type: "mission:claimed",
        stepId: null,
        payload: { bootId: boot, runCount: row.run_count, newGeneration },
        at,
      });
      return { claimed: true, reason: null, runCount: row.run_count };
    });
  }

  /**
   * Missions this process did not start but that claim to be running.
   *
   * Every row returned is orphaned BY DEFINITION — in one process no other owner
   * can exist. No threshold, no grace period, no scan loop, zero false
   * positives, and the answer arrives in one synchronous query at startup rather
   * than fifteen minutes later.
   * @param bootId - this process's boot id.
   * @returns `[{ id, runCount, bootId, lastStage, lastProgressAt, pid, depth, topic }]`.
   */
  orphans(bootId) {
    const boot = assertText(bootId, "bootId");
    return this.db.prepare(`
      SELECT id, run_count, boot_id, last_stage, last_progress_at, pid, depth, topic
      FROM missions
      WHERE status = 'running' AND (boot_id IS NULL OR boot_id <> ?)
      ORDER BY started_at
    `).all(boot).map((row) => ({
      id: row.id,
      runCount: row.run_count,
      // The DEAD owner's boot id, carried so the reclaim event can name which
      // process left the row behind. Without it the sweep's event says only
      // that something was reclaimed, which is the half of the fact nobody can
      // act on.
      bootId: row.boot_id ?? null,
      lastStage: row.last_stage ?? null,
      lastProgressAt: row.last_progress_at ?? null,
      pid: row.pid ?? null,
      depth: row.depth,
      topic: row.topic,
    }));
  }

  /**
   * Who owns this library file, if anybody has said so.
   *
   * @returns `{ pid, bootId, startedAt }`, or undefined when the library is free.
   */
  getRuntimeOwner() {
    const row = this.db.prepare("SELECT pid, boot_id, started_at FROM runtime_owner WHERE id = 1").get();
    if (row === undefined) return undefined;
    return { pid: row.pid ?? null, bootId: row.boot_id, startedAt: row.started_at };
  }

  /**
   * Claim this library file for a process.
   *
   * An unconditional upsert, deliberately: deciding whether the previous owner
   * is still alive needs `process.kill(pid, 0)`, which is a side effect and a
   * probe a test must be able to answer without one. That decision is
   * `claimRuntimeOwner`'s, above this; the row is this module's.
   *
   * @param owner - `{ pid, bootId, startedAt }`.
   * @returns the stored owner.
   */
  putRuntimeOwner(owner) {
    const bootId = assertText(owner?.bootId, "bootId");
    const startedAt = owner?.startedAt ?? new Date().toISOString();
    assertIso(startedAt, "startedAt");
    this.db.prepare(`
      INSERT INTO runtime_owner (id, pid, boot_id, started_at) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        pid = excluded.pid, boot_id = excluded.boot_id, started_at = excluded.started_at
    `).run(Number.isInteger(owner?.pid) ? owner.pid : null, bootId, startedAt);
    return { pid: Number.isInteger(owner?.pid) ? owner.pid : null, bootId, startedAt };
  }

  /**
   * Park an orphan out of `running` while keeping its checkpoint.
   *
   * The sweep ALWAYS moves an orphan out of `running`, so nothing is ever stuck;
   * this is the branch where the checkpoint is usable and resume is offered
   * rather than taken. Auto-resume is deliberately not the default: a plugin
   * process restarts on a settings change and on a harness auto-update, not only
   * on a crash, so a `deep` mission would otherwise silently resume, unattended,
   * on every restart.
   *
   * `run_count` is incremented here as well as on the re-claim, so one
   * crash-then-resume cycle costs two. Whoever sets RECLAIM_LIMIT needs to know
   * that; it is the reason the limit is a small odd number rather than a count of
   * crashes.
   *
   * @param id - the mission id.
   * @param options - `{ note, at }`.
   * @returns `{ parked, reason, runCount }`; `reason` is `no-mission` or `not-running`.
   */
  parkResumable(id, { note, at = new Date().toISOString() } = {}) {
    assertIso(at, "at");
    return withTx(this.db, () => {
      const row = this.db.prepare(`
        UPDATE missions SET status = 'resumable', boot_id = NULL, pid = NULL,
               run_count = run_count + 1, error_message = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
        RETURNING run_count
      `).get(typeof note === "string" ? note : null, at, String(id));
      if (row === undefined) {
        return { parked: false, reason: this.#whyNoUpdate(id, "not-running"), runCount: null };
      }
      this.#appendEventRow(id, {
        type: "mission:parked",
        stepId: null,
        payload: { note: note ?? null, runCount: row.run_count },
        at,
      });
      return { parked: true, reason: null, runCount: row.run_count };
    });
  }

  /**
   * The one arbitrated terminal write.
   *
   * Six paths can end a mission — s12, a stage throw, the user cancelling, the
   * wall timer, the budget pool draining, and the boot sweep — and without
   * arbitration the true cause gets overwritten by a later, vaguer one. The
   * reference's incident: `budget_exhausted` was rewritten layer by layer into
   * `cancelled` and then "lost contact", destroying the diagnosis.
   *
   * The row, the terminal event and the checkpoint settlement are ONE
   * transaction, and the winner reads the row back inside it. That is stronger
   * than the reference, whose broadcast sits outside the transaction with its
   * exceptions swallowed, so "won the race but nothing was ever told" is
   * permanently open there.
   *
   * Aborting the work is the CALLER's job and must happen BEFORE this call, so a
   * caller that goes on to lose the race has still stopped the spending. This
   * function does not abort, does not broadcast and does not run the postlude:
   * only `lifecycle.js` and `s12` may call it, and they own those.
   *
   * The conditional write carries `run_count` as well as `status = 'running'`
   * whenever the intent names a generation. Keyed on status alone, a late
   * finalize from a crashed run ends a rerun that has already started — the
   * same hole the abort registry closes in memory, left open in the one write
   * that is supposed to arbitrate. The generation is optional because
   * `lifecycle.js` cancels a mission it has only just read, and requiring it
   * there would mean a second read for no gain.
   *
   * @param intent - `{ missionId, runCount?, status, failureCode, errorMessage, finalScore, leaderSigned, at, origin?, reason?, detail? }`.
   * @returns `{ won, reason, mission, checkpoint }`; `reason` is `no-mission`, `not-running` or `stale-generation`.
   */
  finalizeMissionRow(intent) {
    const id = assertText(intent?.missionId, "missionId");
    assertMember(intent?.status, TERMINAL_STATUSES, "status");
    const at = intent?.at ?? new Date().toISOString();
    assertIso(at, "at");
    if (intent?.failureCode !== undefined && intent.failureCode !== null) {
      assertMember(intent.failureCode, FAILURE_CODES, "failureCode");
    }
    const runCount = Number.isInteger(intent?.runCount) ? intent.runCount : null;

    return withTx(this.db, () => {
      const info = this.db.prepare(`
        UPDATE missions SET
          status = ?, failure_code = ?, error_message = ?, completed_at = ?,
          -- COALESCE, never overwrite with null: s11 already wrote the Leader's
          -- verdict, and a finalize path that did not carry one would otherwise
          -- erase the only record of why the report was refused.
          final_score = COALESCE(?, final_score),
          leader_signed = COALESCE(?, leader_signed),
          boot_id = NULL, pid = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND (? IS NULL OR run_count = ?)
      `).run(
        intent.status,
        intent?.failureCode ?? null,
        typeof intent?.errorMessage === "string" ? intent.errorMessage : null,
        at,
        numberOrNull(intent?.finalScore),
        intent?.leaderSigned === null || intent?.leaderSigned === undefined ? null : flag(intent.leaderSigned),
        at, id, runCount, runCount,
      );
      if (info.changes !== 1) {
        return { won: false, reason: this.#whyNoTerminalWrite(id, runCount), mission: undefined, checkpoint: null };
      }
      this.#appendEventRow(id, {
        type: "mission:finalized",
        stepId: null,
        payload: {
          status: intent.status,
          failureCode: intent?.failureCode ?? null,
          errorMessage: typeof intent?.errorMessage === "string" ? intent.errorMessage : null,
          runCount,
          // Carried through from the caller so the ONE terminal event says
          // which of the six paths ended the mission. The runtime used to
          // append a second event of its own to record this, under the name
          // `mission:finished`, which made "exactly one terminal event"
          // uncountable.
          origin: typeof intent?.origin === "string" ? intent.origin : null,
          reason: typeof intent?.reason === "string" ? intent.reason : null,
          finalScore: numberOrNull(intent?.finalScore),
          leaderSigned: intent?.leaderSigned ?? null,
          detail: intent?.detail ?? null,
        },
        at,
      });
      const checkpoint = this.settleCheckpoint(id, intent.status, at);
      return { won: true, reason: null, mission: this.getMission(id), checkpoint };
    });
  }

  /**
   * Which of the three ways the terminal write lost.
   *
   * "The row is gone", "somebody else already ended it" and "a newer generation
   * owns it" want three different responses from the caller, and reporting one
   * of them for all three is how the reference's `budget_exhausted` became
   * "lost contact".
   */
  #whyNoTerminalWrite(id, runCount) {
    const row = this.db.prepare("SELECT status, run_count FROM missions WHERE id = ?").get(String(id));
    if (row === undefined) return "no-mission";
    if (row.status !== "running") return "not-running";
    if (runCount !== null && row.run_count !== runCount) return "stale-generation";
    return "not-running";
  }

  // ── config revisions ────────────────────────────────────────────────────

  /**
   * Freeze a resolved input as a new revision.
   *
   * A rerun DERIVES a revision; it never edits one. That is what stops "I changed
   * a setting" from silently changing what a six-month-old mission is compared
   * against — and it is what lets a stage rerun execute against a FRESH
   * allowance while still being graded against the mission row's frozen caps.
   * Running a stage rerun a month later against the residual of a pool the
   * original run drained means it dies instantly at `budget_exhausted`.
   *
   * @param missionId - the mission.
   * @param mutationReason - a member of MUTATION_REASONS.
   * @param config - the whole resolved input, JSON-serialisable.
   * @param at - the write stamp.
   * @returns the new revision number.
   */
  putConfig(missionId, mutationReason, config, at = new Date().toISOString()) {
    assertMember(mutationReason, MUTATION_REASONS, "mutationReason");
    assertIso(at, "at");
    if (config === undefined || config === null) throw new Error("a config revision needs the resolved config; got nothing");
    return withTx(this.db, () => this.#insertConfig(String(missionId), mutationReason, config, at));
  }

  /** Insert the next revision. Callers are already inside a transaction. */
  #insertConfig(missionId, mutationReason, config, at) {
    const next = this.db
      .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM mission_config WHERE mission_id = ?")
      .get(missionId).n;
    this.db.prepare(`
      INSERT INTO mission_config (mission_id, revision, mutation_reason, config, created_at)
      VALUES (?,?,?,?,?)
    `).run(missionId, next, mutationReason, JSON.stringify(config), at);
    return next;
  }

  /**
   * The newest frozen config for a mission.
   * @param missionId - the mission.
   * @returns `{ revision, mutationReason, config, createdAt }`, or undefined.
   */
  latestConfig(missionId) {
    const row = this.db.prepare(`
      SELECT revision, mutation_reason, config, created_at FROM mission_config
      WHERE mission_id = ? ORDER BY revision DESC LIMIT 1
    `).get(String(missionId));
    if (row === undefined) return undefined;
    return {
      revision: row.revision,
      mutationReason: row.mutation_reason,
      config: parseJson(row.config, {}),
      createdAt: row.created_at,
    };
  }

  /**
   * Every frozen config revision, oldest first.
   *
   * The meter needs two of these at once — the current revision's allowance and
   * the original as a faint reference line — and it has to say which is which.
   * @param missionId - the mission.
   * @returns `[{ revision, mutationReason, config, createdAt }]`.
   */
  listConfigs(missionId) {
    return this.db.prepare(`
      SELECT revision, mutation_reason, config, created_at FROM mission_config
      WHERE mission_id = ? ORDER BY revision
    `).all(String(missionId)).map((row) => ({
      revision: row.revision,
      mutationReason: row.mutation_reason,
      config: parseJson(row.config, {}),
      createdAt: row.created_at,
    }));
  }

  // ── stages ──────────────────────────────────────────────────────────────

  /**
   * Check a stage declaration set before any of it is written.
   *
   * Contiguous ordinals with no duplicates, and unique step ids. The count is
   * NOT checked here: the pipeline owns how many stages there are, and spelling
   * "twelve" in the storage layer too is how two files end up disagreeing about
   * the length of a pipeline whose own length is the thing a correct checkpoint
   * depends on.
   */
  #validateStageRows(stages, depth) {
    const rows = Array.isArray(stages) ? stages : [];
    if (rows.length === 0) {
      throw new Error("createMission needs the stage declarations from mission-runtime.js; a mission with no stage rows cannot be resumed or displayed");
    }
    // Which stages this depth does not run, decided by the pipeline module's own
    // `stagesForTier` rather than by a second tier table here. §2 wants the row
    // COUNT invariant — twelve rows at every tier, four of them
    // `skipped-by-tier` at `quick` — so the UI never has to decide whether a
    // missing row means "not yet" or "never". Before this, `createMission`
    // wrote all twelve `pending` and `markSkippedByTier` had no caller
    // anywhere, so a quick mission showed four stages that will never run as
    // though they were still queued and its progress bar could never reach the
    // end.
    const skippedByTier = DEPTH_TIERS.includes(depth)
      ? new Set(stagesForTier(STAGES, depth).skipped.map((stage) => stage.id))
      : new Set();

    const seenIds = new Set();
    const seenOrdinals = new Set();
    const shaped = rows.map((row, index) => {
      const stepId = assertText(row?.stepId, `stages[${index}].stepId`);
      const ordinal = assertCount(row?.ordinal, `stages[${index}].ordinal`, 1);
      // A caller may state the status; when it does not, the tier decides. A
      // caller that explicitly asks for `pending` on a stage this tier skips is
      // corrected, because "pending for ever" is the state this rule exists to
      // make unrepresentable.
      const asked = row?.status ?? "pending";
      const status = asked === "pending" && skippedByTier.has(stepId) ? "skipped-by-tier" : asked;
      assertMember(status, STAGE_STATUSES, `stages[${index}].status`);
      if (seenIds.has(stepId)) throw new Error(`stage ${stepId} is declared twice`);
      // The s8/s8b bug, caught before it can be written: a checkpoint after one
      // stage would list the other complete and a resume would skip it while
      // reporting success.
      if (seenOrdinals.has(ordinal)) throw new Error(`two stages share ordinal ${ordinal}; ordinals are literal positions, never shared stage numbers`);
      seenIds.add(stepId);
      seenOrdinals.add(ordinal);
      return { stepId, ordinal, status };
    });
    shaped.sort((a, b) => a.ordinal - b.ordinal);
    for (let index = 0; index < shaped.length; index += 1) {
      if (shaped[index].ordinal !== index + 1) {
        throw new Error(`stage ordinals must run 1..${shaped.length} with no gaps; found ${shaped[index].ordinal} at position ${index + 1}`);
      }
    }
    return shaped;
  }

  /** Write the stage rows. Callers are already inside a transaction. */
  #writeStageRows(missionId, rows) {
    const insert = this.db.prepare(`
      INSERT INTO mission_stages (mission_id, step_id, ordinal, status)
      VALUES (?,?,?,?)
      ON CONFLICT(mission_id, step_id) DO UPDATE SET ordinal = excluded.ordinal
    `);
    for (const row of rows) insert.run(missionId, row.stepId, row.ordinal, row.status);
  }

  /**
   * Re-declare the stage rows for a mission that already exists.
   *
   * Used by a resume across a changed tier, and by nothing else. Existing rows
   * keep their status and their recorded work; only the ordinal is corrected.
   * @param missionId - the mission.
   * @param stages - `[{ stepId, ordinal, status? }]`.
   * @returns the number of stage rows the mission now has.
   */
  initStages(missionId, stages) {
    const depth = this.db.prepare("SELECT depth FROM missions WHERE id = ?").get(String(missionId))?.depth;
    const rows = this.#validateStageRows(stages, depth);
    return withTx(this.db, () => {
      this.#writeStageRows(String(missionId), rows);
      return this.db.prepare("SELECT COUNT(*) AS n FROM mission_stages WHERE mission_id = ?").get(String(missionId)).n;
    });
  }

  /**
   * Put every stage of a tier back to `pending`, for a FRESH rerun.
   *
   * WITHOUT THIS, A FRESH RERUN RAN NOTHING. `mission_stages` holds one row per
   * step id — not one per generation — so after a run finished, all twelve rows
   * said `done`. `runMission` computes `settled` from those rows and starts at
   * the first unsettled one, so a fresh rerun found every stage settled, walked
   * to the end without dispatching anything, and died in seven seconds as
   * `stage_contract_violation`: "every stage settled but s12-persist wrote no
   * terminal state". Measured, not reasoned about — and it is the row
   * docs/insight-mission.md §12 predicts as "a rerun killed in its first
   * second, zero output".
   *
   * `skipped-by-tier` rows are REWRITTEN rather than preserved, because the
   * tier can change between generations: `#validateStageRows` asks the pipeline
   * which stages this depth runs, so a mission reran at a deeper tier gets the
   * four rows back as `pending` instead of keeping a skip that no longer
   * applies.
   *
   * The recorded WORK is not touched. Findings, chapters and artefacts are
   * keyed by `run_count` and survive by design (§6.1); what this clears is the
   * stage machine's own progress, which is per-step and cannot be.
   * @param missionId - the mission.
   * @param at - ISO stamp for the reset.
   * @returns the number of rows now pending.
   */
  resetStagesForFreshRerun(missionId, at = new Date().toISOString()) {
    assertIso(at, "at");
    const id = String(missionId);
    return withTx(this.db, () => {
      this.db.prepare(`
        UPDATE mission_stages
        SET status = 'pending', attempts = 0, started_at = NULL, ended_at = NULL,
            duration_ms = NULL, tokens = 0, output = NULL, degrade_note = NULL
        WHERE mission_id = ? AND status != 'skipped-by-tier'
      `).run(id);
      // The checkpoint describes a generation that is being abandoned. Left
      // behind, a later resume would rehydrate cross-state from a run whose
      // stage rows no longer exist in any form — the silent-skip failure the
      // checkpoint design exists to prevent.
      this.db.prepare("DELETE FROM mission_checkpoints WHERE mission_id = ?").run(id);
      return this.db.prepare("SELECT COUNT(*) AS n FROM mission_stages WHERE mission_id = ? AND status = 'pending'").get(id).n;
    });
  }

  /**
   * Put ONE stage and its declared successors back to `pending`, for a rerun
   * INSIDE the current generation.
   *
   * The narrow sibling of `resetStagesForFreshRerun`, and it differs from it in
   * the three places that matter.
   *
   * IT CASCADES, because a stage's output is its successors' input. Re-running
   * `s7-outline` alone would leave `s8-write`'s chapters standing against the
   * outline that had just been replaced, and the runner — which starts at the
   * first unsettled stage — would walk straight past them to `s12` and deliver a
   * report assembled from two different plans, with every stage row saying
   * `done`. The cascade set is `dag.successors`, the forward transitive closure
   * written out literally in `mission-runtime.js`, so what a rerun of `s7` will
   * discard is auditable by reading that declaration rather than by trusting
   * this function to compute it. `dag.backEdge` is deliberately NOT followed:
   * re-running `s4-assess` must not re-run `s3-collect`, and keeping the two
   * edges in separate fields is the whole reason that is expressible.
   *
   * IT KEEPS THE CHECKPOINT, where the fresh reset deletes it. No generation is
   * being abandoned here — every stage BEFORE this one keeps its work, and the
   * cross-state bag inside the checkpoint is the only place their in-memory
   * output lives. Deleting it would hand the re-run stage an empty bag, and a
   * stage whose upstream state is gone fails a downstream gate for a structural
   * reason unrelated to the work, which is exactly the state `runMission`
   * refuses to resume into. What is corrected instead is `completed_keys`:
   * leaving the reset ids listed there makes the runner emit a
   * `checkpoint:divergence` on every single stage rerun, which spends a real
   * alarm on an operation somebody deliberately asked for. `saved_at` is left
   * exactly as it was — refreshing it would silently extend the seven-day resume
   * window on a snapshot nobody re-took.
   *
   * `skipped-by-tier` rows are PRESERVED, the opposite of the fresh reset. There
   * the tier may change between generations, so the rows are rewritten; here the
   * mission stays in its own generation and is graded against the caps `s1`
   * already froze, so a tier change is not on the table and rewriting those rows
   * would schedule work this mission never agreed to do.
   *
   * @param missionId - the mission.
   * @param stepId - the stage to re-run.
   * @param at - ISO stamp for the reset.
   * @returns `{ ok, reason, detail, reset }`; `reset` names every step id put back to pending, in pipeline order.
   */
  resetStageForRerun(missionId, stepId, at = new Date().toISOString()) {
    assertIso(at, "at");
    const id = String(missionId);
    const step = String(stepId);
    const decl = STAGES.find((stage) => stage.id === step);
    // Every refusal is NAMED and carries the sentence to act on. "It did not
    // re-run" is the answer that sends somebody to read this file, and the two
    // un-rerunable stages already wrote their own reason into the pipeline
    // declaration precisely so that nobody has to.
    if (decl === undefined) {
      return { ok: false, reason: "unknown-stage", detail: `"${step}" is not a stage in this pipeline. The twelve are ${STAGES.map((stage) => stage.id).join(", ")}.`, reset: [] };
    }
    if (decl.dag.rerunable === false) {
      return { ok: false, reason: "not-rerunable", detail: decl.dag.rerunReason, reset: [] };
    }
    return withTx(this.db, () => {
      const status = new Map(this.db
        .prepare("SELECT step_id, status FROM mission_stages WHERE mission_id = ?")
        .all(id)
        .map((row) => [row.step_id, row.status]));
      if (!status.has(step)) {
        return { ok: false, reason: "no-stage-row", detail: `mission ${id} has no mission_stages row for ${step}, so a reset would settle nothing and the run would report success having done nothing.`, reset: [] };
      }
      if (status.get(step) === "skipped-by-tier") {
        return { ok: false, reason: "skipped-by-tier", detail: `${step} is not run at this mission's depth, so there is no work of its to re-run. Re-run the whole mission at a deeper tier instead.`, reset: [] };
      }
      // PIPELINE ORDER, not the order the closure happens to be written in. This
      // list is shown to a person as "what this will discard", and a list whose
      // order comes from somewhere else reads as a different answer on a re-read.
      const cascade = new Set([step, ...decl.dag.successors]);
      const reset = STAGES
        .map((stage) => stage.id)
        .filter((candidate) => cascade.has(candidate) && status.has(candidate) && status.get(candidate) !== "skipped-by-tier");
      const clear = this.db.prepare(`
        UPDATE mission_stages
        SET status = 'pending', attempts = 0, started_at = NULL, ended_at = NULL,
            duration_ms = NULL, tokens = 0, output = NULL, degrade_note = NULL
        WHERE mission_id = ? AND step_id = ?
      `);
      for (const candidate of reset) clear.run(id, candidate);
      const checkpoint = this.getCheckpoint(id);
      if (checkpoint !== undefined) {
        this.db.prepare("UPDATE mission_checkpoints SET completed_keys = ?, saved_at = saved_at WHERE mission_id = ?")
          .run(JSON.stringify(checkpoint.completedKeys.filter((key) => !cascade.has(key))), id);
      }
      return { ok: true, reason: null, detail: null, reset };
    });
  }

  /**
   * Mark stages this tier does not run.
   *
   * NOT the primary path any more, and it must not become a second one. The
   * tier split is applied by `#validateStageRows`, which asks the pipeline
   * module's own `stagesForTier`, so both `createMission` and `initStages` write
   * the four `skipped-by-tier` rows at the moment the rows are created. This is
   * the REPAIR path: a mission whose depth changed has rows already written
   * under the old tier, and re-running the rule over them is what this is for.
   *
   * The count is invariant either way: twelve rows at every tier, four of them
   * `skipped-by-tier` at `quick`, so the UI never has to decide whether a
   * pending row means "not yet" or "never".
   * @param missionId - the mission.
   * @param stepIds - the step ids this tier skips.
   * @param at - the write stamp.
   * @returns `{ skipped, missing }`; `missing` names ids with no row.
   */
  markSkippedByTier(missionId, stepIds, at = new Date().toISOString()) {
    assertIso(at, "at");
    const ids = Array.isArray(stepIds) ? stepIds.map(String) : [];
    return withTx(this.db, () => {
      const update = this.db.prepare(`
        UPDATE mission_stages SET status = 'skipped-by-tier', ended_at = ?
        WHERE mission_id = ? AND step_id = ? AND status = 'pending'
      `);
      const exists = this.db.prepare("SELECT step_id FROM mission_stages WHERE mission_id = ? AND step_id = ?");
      let skipped = 0;
      const missing = [];
      for (const stepId of ids) {
        // Reported, not thrown on: a tier list naming a stage that is not in the
        // pipeline is a caller bug, and the returned list is what surfaces it.
        // Throwing here would abandon the stages that were correct.
        if (exists.get(String(missionId), stepId) === undefined) {
          missing.push(stepId);
          continue;
        }
        skipped += update.run(at, String(missionId), stepId).changes;
      }
      return { skipped, missing };
    });
  }

  /**
   * Begin a stage: status running, attempt counted, start stamped, and the one
   * `stage:started` event appended in the same transaction.
   *
   * The attempt number is RETURNED rather than left for the caller to derive
   * from the stage rows. The runner used to compute its own from a row it had
   * read earlier and emit its own `stage:started` beside this one, so every
   * dispatch wrote the event twice and the two attempt counters were free to
   * disagree about which try this was.
   *
   * @param missionId - the mission.
   * @param stepId - the stage.
   * @param at - the write stamp.
   * @param options - `{ agentId, payload }` merged into the event.
   * @returns the attempt number, or null when there is no such stage row.
   */
  startStage(missionId, stepId, at = new Date().toISOString(), { agentId, payload } = {}) {
    assertIso(at, "at");
    return withTx(this.db, () => {
      const row = this.db.prepare(`
        UPDATE mission_stages SET status = 'running', attempts = attempts + 1, started_at = ?, ended_at = NULL
        WHERE mission_id = ? AND step_id = ?
        RETURNING attempts
      `).get(at, String(missionId), String(stepId));
      if (row === undefined) return null;
      this.touchMission(missionId, { stepId, at });
      this.#appendEventRow(missionId, {
        type: "stage:started",
        agentId: typeof agentId === "string" ? agentId : null,
        stepId,
        payload: { ...(payload ?? {}), attempt: row.attempts },
        at,
      });
      return row.attempts;
    });
  }

  /**
   * End a stage and, in the same transaction, checkpoint the mission.
   *
   * One transaction is the point. The reference writes stage progress and the
   * checkpoint as two separate awaited calls with a crash window between them,
   * so "stage marked complete but checkpoint missing" is a real state there. A
   * synchronous local write costs microseconds, so every stage is a resume point
   * and that state is structurally impossible here.
   *
   * `degradeNote` is required whenever the status is `degraded`: a stage that
   * swallowed something and continued has to say what, in a column, rather than
   * in a comment nobody greps for.
   *
   * The terminal stage EVENT is written here too, and its type follows the
   * status — `stage:done`, `stage:degraded` or `stage:failed`. The runner used
   * to append its own beside this one under those three names while this method
   * wrote `stage:done` for all three, so a degraded stage produced two events
   * that disagreed about whether anything had gone wrong.
   *
   * @param missionId - the mission.
   * @param stepId - the stage.
   * @param result - `{ status, output, degradeNote, tokens, at, agentId, payload, checkpoint }`.
   * @returns `{ ended, reason, durationMs }`; `reason` is `no-stage` when nothing changed.
   */
  finishStage(missionId, stepId, result = {}) {
    assertMember(result?.status, STAGE_STATUSES, "status");
    const at = result?.at ?? new Date().toISOString();
    assertIso(at, "at");
    // A degraded stage that cannot say what it degraded is indistinguishable
    // from a healthy one at every later read, which is how a swallowed failure
    // becomes a mission that reports success.
    if (result.status === "degraded") assertText(result?.degradeNote, "degradeNote");
    const tokens = assertCount(result?.tokens ?? 0, "tokens", 0);

    return withTx(this.db, () => {
      const prior = this.db
        .prepare("SELECT started_at FROM mission_stages WHERE mission_id = ? AND step_id = ?")
        .get(String(missionId), String(stepId));
      if (prior === undefined) return { ended: false, reason: "no-stage", durationMs: null };

      // Computed here because the orchestrator already knows both ends. The
      // reference ships an empty durations object with a "next version" comment,
      // so "which stage ate the clock" is unanswerable there and free here.
      const started = prior.started_at === null || prior.started_at === undefined ? null : Date.parse(prior.started_at);
      const ended = Date.parse(at);
      const durationMs = started !== null && Number.isFinite(started) && Number.isFinite(ended)
        ? Math.max(0, ended - started)
        : null;

      this.db.prepare(`
        UPDATE mission_stages SET status = ?, ended_at = ?, duration_ms = ?,
               tokens = tokens + ?, output = ?, degrade_note = ?
        WHERE mission_id = ? AND step_id = ?
      `).run(
        result.status, at, durationMs, tokens,
        jsonOrNull(result?.output),
        typeof result?.degradeNote === "string" ? result.degradeNote : null,
        String(missionId), String(stepId),
      );
      this.touchMission(missionId, { stepId, at });
      this.#appendEventRow(missionId, {
        type: STAGE_EVENT_FOR_STATUS[result.status] ?? "stage:done",
        agentId: typeof result?.agentId === "string" ? result.agentId : null,
        stepId,
        payload: { ...(result?.payload ?? {}), status: result.status, durationMs, degraded: result.status === "degraded" },
        at,
      });
      if (result?.checkpoint !== undefined && result.checkpoint !== null) {
        this.saveCheckpoint(missionId, { ...result.checkpoint, at });
      }
      return { ended: true, reason: null, durationMs };
    });
  }

  /**
   * Every stage row for a mission, in pipeline order.
   * @param missionId - the mission.
   * @returns `[{ stepId, ordinal, status, attempts, startedAt, endedAt, durationMs, tokens, output, degradeNote }]`.
   */
  listStages(missionId) {
    return this.db.prepare(`
      SELECT step_id, ordinal, status, attempts, started_at, ended_at, duration_ms, tokens, output, degrade_note
      FROM mission_stages WHERE mission_id = ? ORDER BY ordinal
    `).all(String(missionId)).map(shapeStage);
  }

  /**
   * One stage's recorded return value.
   *
   * The resume path's rehydration reads through this: an agent holding state
   * produced by a stage the resume skipped will fail a downstream gate for a
   * structural reason unrelated to the work.
   * @param missionId - the mission.
   * @param stepId - the stage.
   * @returns the parsed output, or undefined when the stage has none.
   */
  stageOutput(missionId, stepId) {
    const row = this.db
      .prepare("SELECT output FROM mission_stages WHERE mission_id = ? AND step_id = ?")
      .get(String(missionId), String(stepId));
    if (row === undefined || row.output === null) return undefined;
    return parseJson(row.output, undefined);
  }

  /**
   * WHAT THE STAGES DECIDED, all of it, in one read.
   *
   * `stageOutput` answers for one stage and is what the resume path wants;
   * this answers for the mission and is what a reader wants. Every judgement
   * the pipeline made is already on disk in this column — the Leader's
   * recollect decision and its reasons, the fact table s5 reconciled, the
   * blindspots s10 named, the signature s11 refused to give — and until now
   * the only way to see any of it was to guess the event `seq` a trajectory
   * ref is keyed on.
   *
   * The parsed `output` is returned WITH `status` and `attempts`, because
   * "s4 decided recollect" and "s4 decided recollect on its second attempt
   * after the first one failed" are different sentences and the second is the
   * true one. A stage that never ran comes back with `output: null` and its
   * real status, never as an empty object — an absent decision and a decision
   * to do nothing must not render the same.
   *
   * @param missionId - the mission.
   * @returns `[{stepId, ordinal, status, attempts, output}]` in catalogue order.
   */
  listStageOutputs(missionId) {
    return this.db.prepare(`
      SELECT step_id, ordinal, status, attempts, output
      FROM mission_stages WHERE mission_id = ? ORDER BY ordinal
    `).all(assertText(missionId, "missionId")).map((row) => ({
      stepId: row.step_id,
      ordinal: row.ordinal,
      status: row.status,
      attempts: row.attempts,
      output: parseJson(row.output, null),
    }));
  }

  // ── dimensions ──────────────────────────────────────────────────────────

  /**
   * Insert or update one dimension of the plan.
   * @param record - `{ missionId, dimensionId, name, rationale?, facet, state?, at? }`.
   * @returns the dimension id.
   */
  upsertDimension(record) {
    const missionId = assertText(record?.missionId, "missionId");
    const dimensionId = assertText(record?.dimensionId, "dimensionId");
    const name = assertText(record?.name, "name");
    assertMember(record?.facet, FACETS, "facet");
    const state = record?.state ?? "pending";
    assertMember(state, DIMENSION_STATES, "state");
    const at = record?.at ?? new Date().toISOString();
    assertIso(at, "at");

    // The generation doing the planning, resolved here so no caller has to
    // remember — the same shape `insertSpend` uses. A dimension is written by
    // the run that planned it and belongs to that run.
    const runCount = Number(record?.runCount ?? this.getMission(missionId)?.runCount ?? 0) || 0;

    this.db.prepare(`
      INSERT INTO mission_dimensions (mission_id, dimension_id, name, rationale, facet, state, run_count, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(mission_id, run_count, dimension_id) DO UPDATE SET
        name = excluded.name,
        rationale = excluded.rationale,
        facet = excluded.facet,
        updated_at = excluded.updated_at
        -- state, attempt, grade and summary are untouched: setDimensionState and
        -- gradeDimension own them, and a replan that reset a collected
        -- dimension to pending would discard its findings from every count while
        -- the rows sat there.
    `).run(
      missionId, dimensionId, name,
      typeof record?.rationale === "string" ? record.rationale : null,
      record.facet, state, runCount, at,
    );
    return dimensionId;
  }

  /**
   * Move a dimension's state, optionally counting a new attempt.
   * @param missionId - the mission.
   * @param dimensionId - the dimension.
   * @param state - a member of DIMENSION_STATES.
   * @param options - `{ countAttempt, failureCode, summary, at }`.
   * @returns false when there is no such dimension.
   */
  setDimensionState(missionId, dimensionId, state, options = {}) {
    assertMember(state, DIMENSION_STATES, "state");
    const at = options?.at ?? new Date().toISOString();
    assertIso(at, "at");
    return this.db.prepare(`
      UPDATE mission_dimensions SET
        state = ?,
        attempt = attempt + ?,
        failure_code = COALESCE(?, failure_code),
        summary = COALESCE(?, summary),
        updated_at = ?
      WHERE mission_id = ? AND run_count = ? AND dimension_id = ?
    `).run(
      state,
      options?.countAttempt ? 1 : 0,
      typeof options?.failureCode === "string" ? options.failureCode : null,
      typeof options?.summary === "string" ? options.summary : null,
      at, String(missionId),
      // This run's row. Without the generation the update lands on whichever
      // row of that dimension_id SQLite reaches first, which after a replan is
      // a dead generation's.
      Number(options?.runCount ?? this.getMission(missionId)?.runCount ?? 0) || 0,
      String(dimensionId),
    ).changes > 0;
  }

  /**
   * Record a dimension's grade.
   * @param missionId - the mission.
   * @param dimensionId - the dimension.
   * @param grade - `{ score, axes }`.
   * @param at - the write stamp.
   * @returns false when there is no such dimension.
   */
  gradeDimension(missionId, dimensionId, grade = {}, at = new Date().toISOString()) {
    assertIso(at, "at");
    return this.db.prepare(`
      UPDATE mission_dimensions SET grade = ?, grade_axes = ?, updated_at = ?
      WHERE mission_id = ? AND run_count = ? AND dimension_id = ?
    `).run(
      numberOrNull(grade?.score), jsonOrNull(grade?.axes), at,
      String(missionId),
      Number(grade?.runCount ?? this.getMission(missionId)?.runCount ?? 0) || 0,
      String(dimensionId),
    ).changes > 0;
  }

  /**
   * Every dimension, with the counts the card actually renders.
   *
   * The counts are a GROUP BY over `mission_findings`, not a stored column. A
   * denormalised counter here would have four writers — initial collect,
   * recollect, salvage, the layer-3 retry — and one critical reader in s4's
   * loop-termination test, which is a drift generator.
   *
   * Every `verify_state` is reported separately, because "4 fetches failed with
   * 429" and "4 quotes were invented" are the same number in the same place and
   * require opposite responses.
   *
   * @param missionId - the mission.
   * @param options - `{ runCount }`; defaults to the mission's current run.
   * @returns `[{ ...dimension, verified, byState, uniqueHosts, total }]`.
   */
  listDimensions(missionId, { runCount } = {}) {
    const id = String(missionId);
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const rows = this.db.prepare(`
      SELECT dimension_id, name, rationale, facet, state, attempt, grade, grade_axes, summary, failure_code, updated_at
      FROM mission_dimensions WHERE mission_id = ? AND run_count = ? ORDER BY dimension_id
    `).all(id, run).map(shapeDimension);

    const tallies = new Map();
    for (const row of this.db.prepare(`
      SELECT dimension_id, verify_state, COUNT(*) AS n
      FROM mission_findings WHERE mission_id = ? AND run_count = ?
      GROUP BY dimension_id, verify_state
    `).all(id, run)) {
      const entry = tallies.get(row.dimension_id) ?? { byState: {}, total: 0 };
      entry.byState[row.verify_state] = row.n;
      entry.total += row.n;
      tallies.set(row.dimension_id, entry);
    }
    const hosts = new Map();
    for (const row of this.db.prepare(`
      SELECT dimension_id, COUNT(DISTINCT source_host) AS n
      FROM mission_findings WHERE mission_id = ? AND run_count = ? AND verify_state = ?
      GROUP BY dimension_id
    `).all(id, run, COUNTING_VERIFY_STATE)) {
      hosts.set(row.dimension_id, row.n);
    }

    for (const row of rows) {
      const tally = tallies.get(row.dimensionId) ?? { byState: {}, total: 0 };
      row.runCount = run;
      row.byState = tally.byState;
      row.total = tally.total;
      row.verified = tally.byState[COUNTING_VERIFY_STATE] ?? 0;
      // Shown separately and never folded into `verified`: it is genuine
      // publisher text and admissible at a discount, and averaging it into the
      // headline number is how a discount stops existing.
      row.verifiedAbstract = tally.byState["verified-abstract"] ?? 0;
      row.unchecked = (tally.byState["unchecked-fetch-failed"] ?? 0)
        + (tally.byState["unchecked-rate-limited"] ?? 0)
        + (tally.byState["unchecked-stale"] ?? 0);
      row.uniqueHosts = hosts.get(row.dimensionId) ?? 0;
    }
    return rows;
  }

  /**
   * The dimensions with the fewest verified findings.
   *
   * The back edge re-collects the WEAKEST two, not the two the model finds most
   * interesting: fixing the weakest two while four keep working beats redoing
   * five and having them all collapse.
   * @param missionId - the mission.
   * @param options - `{ limit = 2, runCount, below }`; `below` filters to dimensions under a floor.
   * @returns `[{ dimensionId, verified }]`, weakest first.
   */
  weakestDimensions(missionId, { limit = 2, runCount, below } = {}) {
    const id = String(missionId);
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const rows = this.db.prepare(`
      SELECT d.dimension_id AS dimension_id,
             (SELECT COUNT(*) FROM mission_findings f
               WHERE f.mission_id = d.mission_id AND f.dimension_id = d.dimension_id
                 AND f.run_count = ? AND f.verify_state = ?) AS verified
      FROM mission_dimensions d
      WHERE d.mission_id = ? AND d.run_count = ?
      ORDER BY verified ASC, d.dimension_id
    `).all(run, COUNTING_VERIFY_STATE, id, run);
    const floor = Number.isFinite(Number(below)) ? Number(below) : Infinity;
    return rows
      .filter((row) => row.verified < floor)
      .slice(0, clampInt(limit, 1, 50, 2))
      .map((row) => ({ dimensionId: row.dimension_id, verified: row.verified }));
  }

  // ── findings ────────────────────────────────────────────────────────────

  /**
   * Write one finding, refusing any verified state whose preconditions do not
   * hold.
   *
   * This is the enforcement point for four guarantees that are otherwise
   * conventions, and a convention is a check that has not been run:
   *
   *  1. `document_id === sha256(normalizeUrl(source_url))` for any fetch-backed
   *     verified state. They are otherwise independent columns and nothing
   *     relates them, so a quote lifted from an arXiv abstract, attributed to
   *     nature.com and verified against the arXiv document lands as verified
   *     with `source_host = 'nature.com'` — and `unique_hosts` and the whole
   *     independence model count it.
   *  2. The backing document exists, returned 2xx, and carried at least
   *     MIN_DOCUMENT_CHARS normalised characters. A 404 body and a PDF both parse
   *     into something Readability will happily extract, and a quote verified
   *     against an error page reads exactly like a real one.
   *  3. A span-verified state names the span it matched. A verifier that
   *     discards the matching index cannot be re-checked later, and "verified"
   *     then means "somebody said so once".
   *  4. `verified-abstract` requires a library row with a real PUBLISHER
   *     abstract. `ai_summary` is our own model's prose — 117 rows of it — and a
   *     quote "verified" against it is the model checking its own homework.
   *
   * @param record - `{ id?, missionId, dimensionId, runCount, attempt, claim, claimHash?, evidence, sourceUrl, sourceHost?, sourceTitle?, publishedAt?, verifyState, verifyReason?, documentId?, spanIndex?, createdAt? }`.
   * @returns the finding id.
   */
  insertFinding(record) {
    const missionId = assertText(record?.missionId, "missionId");
    const dimensionId = assertText(record?.dimensionId, "dimensionId");
    const runCount = assertCount(record?.runCount, "runCount", 1);
    const attempt = assertCount(record?.attempt, "attempt", 0);
    const claim = assertText(record?.claim, "claim");
    const evidence = assertText(record?.evidence, "evidence");
    const sourceUrl = assertText(record?.sourceUrl, "sourceUrl");
    assertMember(record?.verifyState, VERIFY_STATES, "verifyState");
    const createdAt = record?.createdAt ?? new Date().toISOString();
    assertIso(createdAt, "createdAt");

    const verifyState = record.verifyState;
    const documentId = typeof record?.documentId === "string" && record.documentId !== "" ? record.documentId : null;
    const spanIndex = Number.isInteger(record?.spanIndex) ? record.spanIndex : null;

    if (FETCH_BACKED_VERIFY_STATES.includes(verifyState)) {
      const expected = documentIdFor(sourceUrl);
      if (documentId === null) {
        throw new Error(`a ${verifyState} finding must name the document it was checked against; pass documentId = documentIdFor(sourceUrl)`);
      }
      if (documentId !== expected) {
        throw new Error(`documentId ${documentId} is not the document for ${sourceUrl} (expected ${expected}); the quote was checked against a page other than the one it is attributed to`);
      }
      const document = shapeDocument(
        this.db.prepare("SELECT id, url, host, title, markdown, content_hash, byte_length, status, fetched_at FROM mission_documents WHERE id = ?").get(documentId),
      );
      if (document === undefined) {
        throw new Error(`no document ${documentId} for ${sourceUrl}; store the fetched page with putDocument() before marking a finding ${verifyState}`);
      }
      if (!document.admissible) {
        throw new Error(`document ${documentId} cannot back a verified state: status ${document.status}, ${document.charCount} normalised characters (need 2xx and >= ${MIN_DOCUMENT_CHARS}); record this finding as unchecked-fetch-failed instead`);
      }
      if (spanIndex === null || spanIndex < 0) {
        throw new Error(`a ${verifyState} finding must record which span matched; pass spanIndex from verifyQuote`);
      }
    } else if (verifyState === "verified-abstract") {
      if (documentId !== null) {
        throw new Error("verified-abstract means the quote came from a library row's publisher abstract, not a page we fetched; leave documentId null or use verified-source-text");
      }
      this.#assertQuotableAbstract(sourceUrl);
    }

    const id = typeof record?.id === "string" && record.id !== "" ? record.id : `finding-${sha256(`${missionId}|${runCount}|${attempt}|${sourceUrl}|${claim}`).slice(0, 24)}`;
    const claimHash = typeof record?.claimHash === "string" && record.claimHash !== ""
      ? record.claimHash
      : claimHashOf(claim);
    const sourceHost = typeof record?.sourceHost === "string" && record.sourceHost !== ""
      ? record.sourceHost
      : sourceHostOf(sourceUrl);

    this.db.prepare(`
      INSERT INTO mission_findings (
        id, mission_id, dimension_id, run_count, attempt, claim, claim_hash, evidence,
        source_url, source_host, source_title, published_at,
        verify_state, verify_reason, document_id, span_index, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        verify_state = excluded.verify_state,
        verify_reason = excluded.verify_reason,
        document_id = excluded.document_id,
        span_index = excluded.span_index
        -- Only the verification columns are re-writable. The claim, the quote
        -- and the attribution are what the finding IS; letting a re-verify pass
        -- rewrite them would let a second look silently change what was checked.
    `).run(
      id, missionId, dimensionId, runCount, attempt, claim, claimHash, evidence,
      sourceUrl, sourceHost,
      typeof record?.sourceTitle === "string" ? record.sourceTitle : null,
      typeof record?.publishedAt === "string" ? record.publishedAt : null,
      verifyState,
      typeof record?.verifyReason === "string" ? record.verifyReason : null,
      documentId, spanIndex, createdAt,
    );
    return id;
  }

  /**
   * Refuse a `verified-abstract` whose "abstract" is our own model's prose.
   *
   * The library has no body-text column: abstracts average 234 characters across
   * 19,179 rows and `ai_summary` is 117 rows written by this plugin's model.
   * Quoting `ai_summary` back as evidence is the model checking its own homework,
   * and it is exactly what an unquotable-source marker exists to prevent.
   */
  #assertQuotableAbstract(sourceUrl) {
    const normalized = normalizeUrl(sourceUrl) ?? sourceUrl;
    const row = this.db.prepare(`
      SELECT id, abstract, ai_summary FROM resources
      WHERE normalized_url = ? OR source_url = ? OR source_url = ?
      LIMIT 1
    `).get(normalized, normalized, sourceUrl);
    if (row === undefined) {
      throw new Error(`verified-abstract needs the library row for ${sourceUrl}, and there is none; fetch the page and use verified-source-text`);
    }
    const abstract = typeof row.abstract === "string" ? row.abstract.trim() : "";
    if (abstract !== "") return;
    const generated = typeof row.ai_summary === "string" ? row.ai_summary.trim() : "";
    if (generated !== "") {
      throw new Error(`resource ${row.id} has no publisher abstract, only ai_summary, which this plugin's own model wrote; it is not quotable evidence`);
    }
    throw new Error(`resource ${row.id} has no abstract text to verify a quote against`);
  }

  /**
   * Re-verify one finding without touching what it claims.
   *
   * Separate from `insertFinding` because a re-verify is a different act: it may
   * only move the verify columns, and it must be refused the same way when the
   * new state's preconditions do not hold.
   * @param findingId - the finding.
   * @param verifyState - a member of VERIFY_STATES.
   * @param options - `{ reason, documentId, spanIndex }`.
   * @returns `{ updated, reason }`; `reason` is `no-finding` when nothing changed.
   */
  setFindingVerifyState(findingId, verifyState, options = {}) {
    assertMember(verifyState, VERIFY_STATES, "verifyState");
    const row = this.db
      .prepare("SELECT source_url FROM mission_findings WHERE id = ?")
      .get(String(findingId));
    if (row === undefined) return { updated: false, reason: "no-finding" };

    if (FETCH_BACKED_VERIFY_STATES.includes(verifyState)) {
      const expected = documentIdFor(row.source_url);
      if (options?.documentId !== expected) {
        throw new Error(`documentId ${options?.documentId} is not the document for ${row.source_url} (expected ${expected})`);
      }
      const document = shapeDocument(
        this.db.prepare("SELECT id, url, host, title, markdown, content_hash, byte_length, status, fetched_at FROM mission_documents WHERE id = ?").get(expected),
      );
      if (document === undefined || !document.admissible) {
        throw new Error(`document ${expected} cannot back ${verifyState}; store an admissible fetch first`);
      }
      if (!Number.isInteger(options?.spanIndex) || options.spanIndex < 0) {
        throw new Error(`a ${verifyState} finding must record which span matched; pass spanIndex`);
      }
    }

    this.db.prepare(`
      UPDATE mission_findings SET verify_state = ?, verify_reason = ?, document_id = ?, span_index = ?
      WHERE id = ?
    `).run(
      verifyState,
      typeof options?.reason === "string" ? options.reason : null,
      typeof options?.documentId === "string" ? options.documentId : null,
      Number.isInteger(options?.spanIndex) ? options.spanIndex : null,
      String(findingId),
    );
    return { updated: true, reason: null };
  }

  /**
   * Findings, filtered.
   *
   * `order` is a MEMBER of `FINDING_ORDERS`, mapped through `FINDING_ORDER_SQL`
   * to a literal clause. It is never interpolated from the argument: the one
   * place a read route's query string could reach a SQL string is here, and a
   * template that pasted the parameter in would make `?order=` an injection
   * point on a route whose whole purpose is to be linkable.
   *
   * @param options - `{ missionId, dimensionId, runCount, verifyState, sourceHost, attempt, order, take, skip }`.
   * @returns `[finding]`, oldest first by default so an attempt's order is preserved.
   */
  listFindings({ missionId, dimensionId, runCount, verifyState, sourceHost, attempt, order, take = 200, skip = 0 } = {}) {
    const where = ["mission_id = ?"];
    const params = [assertText(missionId, "missionId")];
    if (typeof dimensionId === "string" && dimensionId !== "") {
      where.push("dimension_id = ?");
      params.push(dimensionId);
    }
    if (typeof sourceHost === "string" && sourceHost !== "") {
      where.push("source_host = ?");
      params.push(sourceHost);
    }
    if (runCount !== undefined && runCount !== null) {
      where.push("run_count = ?");
      params.push(assertCount(runCount, "runCount", 1));
    }
    if (typeof verifyState === "string" && verifyState !== "") {
      assertMember(verifyState, VERIFY_STATES, "verifyState");
      where.push("verify_state = ?");
      params.push(verifyState);
    }
    if (attempt !== undefined && attempt !== null) {
      where.push("attempt = ?");
      params.push(assertCount(attempt, "attempt", 0));
    }
    const orderKey = order === undefined || order === null || order === "" ? "created" : String(order);
    assertMember(orderKey, FINDING_ORDERS, "order");
    return this.db.prepare(`
      SELECT ${FINDING_COLUMNS} FROM mission_findings
      WHERE ${where.join(" AND ")}
      ORDER BY ${FINDING_ORDER_SQL[orderKey]} LIMIT ? OFFSET ?
    `).all(...params, clampInt(take, 1, 2000, 200), Math.max(0, clampInt(skip, 0, Number.MAX_SAFE_INTEGER, 0)))
      .map(shapeFinding);
  }

  /**
   * The evidence boundary, as one method.
   *
   * ONLY findings in the counting state may become facts, chapters and
   * citations. Drawing the boundary at collection and nowhere after it means a
   * finding whose quote failed verification still earns a fact row, an
   * allocation to a chapter and a citation — while every count stays green. This
   * method exists so no downstream stage has to spell the `WHERE` itself, and so
   * a grep for the boundary finds one call site per consumer.
   *
   * @param missionId - the mission.
   * @param options - `{ dimensionId, runCount }`.
   * @returns `[finding]`, every one of them verified against a page we fetched.
   */
  verifiedFindings(missionId, { dimensionId, runCount } = {}) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const where = ["mission_id = ?", "run_count = ?", "verify_state = ?"];
    const params = [id, run, COUNTING_VERIFY_STATE];
    if (typeof dimensionId === "string" && dimensionId !== "") {
      where.push("dimension_id = ?");
      params.push(dimensionId);
    }
    return this.db.prepare(`
      SELECT ${FINDING_COLUMNS} FROM mission_findings
      WHERE ${where.join(" AND ")} ORDER BY dimension_id, created_at, id
    `).all(...params).map(shapeFinding);
  }

  /**
   * How many findings of one dimension reached the counting state.
   *
   * A COUNT over `ix_findings_dim_state`, computed at read. See the note beside
   * `mission_dimensions` for why this is not a column.
   * @param missionId - the mission.
   * @param dimensionId - the dimension, or undefined for the whole mission.
   * @param runCount - the generation; defaults to the mission's current run.
   * @returns the count.
   */
  countVerified(missionId, dimensionId, runCount) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    if (dimensionId === undefined || dimensionId === null || dimensionId === "") {
      return this.db.prepare(
        "SELECT COUNT(*) AS n FROM mission_findings WHERE mission_id = ? AND run_count = ? AND verify_state = ?",
      ).get(id, run, COUNTING_VERIFY_STATE).n;
    }
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM mission_findings
      WHERE mission_id = ? AND dimension_id = ? AND run_count = ? AND verify_state = ?
    `).get(id, String(dimensionId), run, COUNTING_VERIFY_STATE).n;
  }

  /**
   * Findings per verify state, for the whole mission.
   *
   * Reported as nine numbers, never as a ratio. `verified/total` at 0/0 is NaN
   * or, worse, reads as "no failures" — a mission with no citations at all
   * presenting as fully verified to the one decision the pipeline converges on.
   * @param missionId - the mission.
   * @param runCount - the generation; defaults to the mission's current run.
   * @returns `{ [state]: n }`, absent states omitted, plus `total`.
   */
  verifyStateCounts(missionId, runCount) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const counts = { total: 0 };
    for (const row of this.db.prepare(`
      SELECT verify_state, COUNT(*) AS n FROM mission_findings
      WHERE mission_id = ? AND run_count = ? GROUP BY verify_state
    `).all(id, run)) {
      counts[row.verify_state] = row.n;
      counts.total += row.n;
    }
    return counts;
  }

  /**
   * Distinct `(source_host, claim_hash)` pairs in the counting state.
   *
   * This is the number the s4 -> s3 back edge must see strictly increase.
   * Counting raw findings instead would let a recollect's near-duplicate
   * rephrasings satisfy the condition every time, so only the round cap would
   * ever terminate the loop; counting after a replace would let a worse second
   * round destroy a better first one. Recollect appends into a new `attempt`,
   * the union is kept, and this counts across attempts.
   *
   * ACROSS GENERATIONS, not within one. `run_count <= :run`, because a rerun
   * writes a new generation and deletes nothing, so the evidence a mission has
   * verified is the union of what its generations verified. Counted at the
   * current generation only, this returned 0 on every resume — and the two
   * gates that read it are §2's evidence floor and the s4 -> s3 improvement
   * test, so a resumed mission ended `quality-failed` with `no_evidence`,
   * reporting "we looked and found nothing verifiable" about a run that had
   * found plenty. The resume could not recover either: `s3-collect` had already
   * settled, so it was never re-dispatched and the new generation could never
   * acquire evidence of its own. Every resumed mission failed, with the one
   * message that reads as a fact about the topic rather than as a bug here.
   *
   * The back edge is unaffected — it compares this number before and after one
   * round inside a single generation, and adding a constant to both sides of a
   * strict increase changes nothing.
   *
   * @param missionId - the mission.
   * @param options - `{ dimensionId, runCount }`.
   * @returns the number of distinct verified evidence pairs.
   */
  distinctVerifiedPairs(missionId, { dimensionId, runCount } = {}) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const where = ["mission_id = ?", "run_count <= ?", "verify_state = ?"];
    const params = [id, run, COUNTING_VERIFY_STATE];
    if (typeof dimensionId === "string" && dimensionId !== "") {
      where.push("dimension_id = ?");
      params.push(dimensionId);
    }
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT DISTINCT source_host, claim_hash FROM mission_findings WHERE ${where.join(" AND ")}
      )
    `).get(...params).n;
  }

  /**
   * Σ derived floor across the dimensions this generation planned.
   *
   * `missions.derived_floor` is the PER-DIMENSION floor derived from measured
   * supply after s3 — one number, in one column, that both the researcher's
   * prompt and s4's gate read (§1: a floor hard-coded in nine places is a floor
   * nothing can reach). §2's thin-evidence rule compares total verified evidence
   * against the SUM of those floors, so the multiplication happens here, beside
   * the query that counts the dimensions, rather than in the runtime where it
   * would be a second place a statement lives.
   *
   * Answers 0 when no floor has been written yet, which `evidenceFloorGate`
   * reads as "the ratio cannot be computed" rather than as "the floor is zero".
   *
   * @param missionId - the mission.
   * @param options - `{ runCount }`; defaults to the mission's current run.
   * @returns the summed floor.
   */
  sumDerivedFloors(missionId, { runCount } = {}) {
    const id = assertText(missionId, "missionId");
    const floor = this.db.prepare("SELECT derived_floor FROM missions WHERE id = ?").get(id)?.derived_floor;
    if (floor === null || floor === undefined) return 0;
    // The generation key arrived, so this is the parameter that has to start
    // being used — the comment here said exactly that. Counting every
    // generation's dimensions made the floor a multiple of how many times the
    // mission had been rerun.
    const run = runCount ?? this.getMission(id)?.runCount ?? 0;
    const dimensions = this.db
      .prepare("SELECT COUNT(*) AS n FROM mission_dimensions WHERE mission_id = ? AND run_count = ?")
      .get(id, run).n;
    return floor * dimensions;
  }

  /**
   * Why a collection round came back with nothing: what was asked, where, and
   * what each answer turned out to be.
   *
   * This is the body of the `no_evidence` brief (§2). "We looked and found
   * nothing verifiable" is a useful and cheap answer; it is only useful if it
   * names every query issued and every host tried, because the reader's next
   * question is whether the topic is empty or the search plugin is missing —
   * and `verify_state` alone cannot tell them apart. Four `unchecked-rate-limited`
   * and four `unverifiable` are the same number in the same place and require
   * opposite responses.
   *
   * @param missionId - the mission.
   * @param options - `{ runCount, limit }`; `runCount` defaults to the current run.
   * @returns `{ runCount, findings, hosts, tools, queries }`.
   */
  collectionDiagnostics(missionId, { runCount, limit = 50 } = {}) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;

    const tools = {};
    for (const row of this.db.prepare(`
      SELECT tool, ok, COUNT(*) AS n FROM mission_tool_calls
      WHERE mission_id = ? GROUP BY tool, ok
    `).all(id)) {
      const entry = tools[row.tool] ?? { calls: 0, ok: 0, failed: 0 };
      entry.calls += row.n;
      if (row.ok === 1) entry.ok += row.n;
      else entry.failed += row.n;
      tools[row.tool] = entry;
    }

    return {
      runCount: run,
      // Nine numbers, never a ratio: `verified/total` at 0/0 is NaN or, worse,
      // reads as "no failures".
      findings: this.verifyStateCounts(id, run),
      hosts: this.uniqueHosts(id, { runCount: run }),
      tools,
      // The failing calls, newest first, each with the error code the tool door
      // classified it as. A refusal is not an empty result set, and this is
      // where that distinction survives into the brief.
      queries: this.db.prepare(`
        SELECT step_id, agent_id, tool, pace_key, error_code, at FROM mission_tool_calls
        WHERE mission_id = ? AND ok = 0 ORDER BY at DESC, id DESC LIMIT ?
      `).all(id, clampInt(limit, 1, 500, 50)).map((row) => ({
        stepId: row.step_id,
        agentId: row.agent_id ?? null,
        tool: row.tool,
        paceKey: row.pace_key ?? null,
        errorCode: row.error_code ?? null,
        at: row.at,
      })),
    };
  }

  /**
   * Distinct hosts behind a mission's verified findings.
   * @param missionId - the mission.
   * @param options - `{ dimensionId, runCount }`.
   * @returns the host names, most-cited first.
   */
  /**
   * How many findings each RUN of this mission holds.
   *
   * WHY THIS EXISTS: every other reader on this table scopes to the mission's
   * CURRENT `run_count`, which is correct while a mission is running and a lie
   * the moment it is re-run. Measured on a real mission: five runs, fourteen
   * verified findings — all of them in run 1 — and a detail screen that read
   * "0 verified of 0 findings" on all eight dimensions because run 5 had
   * settled without collecting anything. The evidence was one integer away and
   * the interface said there was none.
   *
   * Newest run first, and runs with nothing are NOT omitted: "run 5 produced
   * nothing" is the sentence the screen has to be able to say.
   * @param missionId - the mission.
   * @returns `[{runCount, total, verified, dimensions}]`, newest run first.
   */
  findingRuns(missionId) {
    const id = assertText(missionId, "missionId");
    return this.db.prepare(`
      SELECT run_count AS run_count,
             COUNT(*) AS total,
             SUM(CASE WHEN verify_state = ? THEN 1 ELSE 0 END) AS verified,
             COUNT(DISTINCT dimension_id) AS dimensions
      FROM mission_findings
      WHERE mission_id = ?
      GROUP BY run_count
      ORDER BY run_count DESC
    `).all(COUNTING_VERIFY_STATE, id).map((row) => ({
      runCount: row.run_count,
      total: row.total,
      verified: row.verified ?? 0,
      dimensions: row.dimensions,
    }));
  }

  /**
   * Per-dimension counts for ONE run.
   *
   * The companion to `findingRuns`: once a reader has chosen a run that is not
   * the mission's current one, every dimension card on the screen is still
   * drawing the current run's zeroes. One GROUP BY rather than a request per
   * card.
   * @param missionId - the mission.
   * @param runCount - the run to count.
   * @returns `{[dimensionId]: {total, verified, hosts}}`.
   */
  findingCountsByDimension(missionId, runCount) {
    const id = assertText(missionId, "missionId");
    const run = assertCount(runCount, "runCount", 1);
    const rows = this.db.prepare(`
      SELECT dimension_id AS dimension_id,
             COUNT(*) AS total,
             SUM(CASE WHEN verify_state = ? THEN 1 ELSE 0 END) AS verified,
             COUNT(DISTINCT CASE WHEN verify_state = ? THEN source_host END) AS hosts
      FROM mission_findings
      WHERE mission_id = ? AND run_count = ?
      GROUP BY dimension_id
    `).all(COUNTING_VERIFY_STATE, COUNTING_VERIFY_STATE, id, run);
    const out = {};
    for (const row of rows) {
      out[row.dimension_id] = { total: row.total, verified: row.verified ?? 0, hosts: row.hosts ?? 0 };
    }
    return out;
  }

  /**
   * The hosts a mission's evidence came from, with a row count each.
   *
   * `verified` defaults to TRUE — the independence model counts hosts among
   * findings that passed verification, and every existing caller means that
   * one. Pass `false` for the complete host set in scope, which is what a
   * host FILTER must be validated against: a control whose legal values were
   * the verified-only list would refuse a host that has findings, and a
   * refusal on a host the data holds is indistinguishable from a broken route.
   *
   * @param missionId - the mission.
   * @param options - `{ dimensionId, runCount, verified = true }`.
   * @returns `[{host, findings}]`, busiest first.
   */
  uniqueHosts(missionId, { dimensionId, runCount, verified = true } = {}) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const where = ["mission_id = ?", "run_count = ?"];
    const params = [id, run];
    if (verified !== false) {
      where.push("verify_state = ?");
      params.push(COUNTING_VERIFY_STATE);
    }
    if (typeof dimensionId === "string" && dimensionId !== "") {
      where.push("dimension_id = ?");
      params.push(dimensionId);
    }
    return this.db.prepare(`
      SELECT source_host, COUNT(*) AS n FROM mission_findings
      WHERE ${where.join(" AND ")} GROUP BY source_host ORDER BY n DESC, source_host
    `).all(...params).map((row) => ({ host: row.source_host, findings: row.n }));
  }

  /**
   * ONE ROW PER SOURCE, not per finding.
   *
   * The references screen asks a different question from the evidence screen:
   * not "what did we learn" but "what did we read". Fourteen findings over
   * seven pages is seven rows here and fourteen there, and a list that answers
   * the second question when asked the first shows the same page six times and
   * makes a mission look far better sourced than it is.
   *
   * Grouped by `source_url` and NOT by host: two pages on one site are two
   * things somebody read. The host roll-up is `uniqueHosts`, and the totals
   * below carry the host count so a caller never has to derive one from the
   * other and get a different answer.
   *
   * `firstSeenAt` is a MIN over `created_at`, so the ordering a reader
   * recognises — the order the mission met these pages — is available without a
   * second query.
   *
   * @param missionId - the mission.
   * @param options - `{ runCount, dimensionId }`.
   * `publishedAt` is the PUBLISHER's date and is null far more often than not:
   * only a page a search or the library led us to carries one. It is never
   * filled in from `firstSeenAt` — that is when we read the page, and a
   * substitute would date a 2019 paper to the afternoon the mission ran.
   *
   * `library` IS THE JOIN, and its `null` is an answer rather than a gap. The
   * pane that draws these rows wants to say what kind of thing each page is
   * and what it scored; `resources` holds both for the pages this
   * installation collected, and holds NOTHING for the open-web pages a
   * mission mostly reads. Both cases ship: a page the library has never seen
   * carries `library: null`, and every reader is expected to say so in words
   * rather than fill the space with something derived.
   *
   * @returns `[{url, host, title, publishedAt, findings, verified, dimensionIds, verifyStates, firstSeenAt, library}]`, most findings first.
   */
  listSources(missionId, { runCount, dimensionId } = {}) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const where = ["mission_id = ?", "run_count = ?"];
    const params = [id, assertCount(run, "runCount", 1)];
    if (typeof dimensionId === "string" && dimensionId !== "") {
      where.push("dimension_id = ?");
      params.push(dimensionId);
    }

    const grouped = this.db.prepare(`
      SELECT source_url,
             MIN(source_host)  AS source_host,
             MAX(source_title) AS source_title,
             -- MAX skips NULLs, so a page whose date reached one of its
             -- findings and not another keeps the date instead of losing it to
             -- the row that was written without one. Same rule as the title.
             MAX(published_at) AS published_at,
             COUNT(*)          AS findings,
             SUM(CASE WHEN verify_state = ? THEN 1 ELSE 0 END) AS verified,
             MIN(created_at)   AS first_seen_at
      FROM mission_findings
      WHERE ${where.join(" AND ")}
      GROUP BY source_url
      ORDER BY findings DESC, first_seen_at, source_url
    `).all(COUNTING_VERIFY_STATE, ...params);

    // The per-URL breakdowns, as two more GROUP BYs rather than as N queries or
    // as a GROUP_CONCAT this side would have to split back apart. Both are
    // small: the outer group is already one row per page read.
    const states = new Map();
    for (const row of this.db.prepare(`
      SELECT source_url, verify_state, COUNT(*) AS n FROM mission_findings
      WHERE ${where.join(" AND ")} GROUP BY source_url, verify_state
    `).all(...params)) {
      let bag = states.get(row.source_url);
      if (bag === undefined) { bag = {}; states.set(row.source_url, bag); }
      bag[row.verify_state] = row.n;
    }
    const dimensionIds = new Map();
    for (const row of this.db.prepare(`
      SELECT source_url, dimension_id FROM mission_findings
      WHERE ${where.join(" AND ")} GROUP BY source_url, dimension_id ORDER BY dimension_id
    `).all(...params)) {
      const list = dimensionIds.get(row.source_url);
      if (list === undefined) dimensionIds.set(row.source_url, [row.dimension_id]);
      else list.push(row.dimension_id);
    }

    const library = this.#libraryFactsFor(grouped.map((row) => row.source_url));

    return grouped.map((row) => ({
      url: row.source_url,
      host: row.source_host,
      title: row.source_title ?? null,
      publishedAt: row.published_at ?? null,
      findings: row.findings,
      verified: row.verified ?? 0,
      dimensionIds: dimensionIds.get(row.source_url) ?? [],
      verifyStates: states.get(row.source_url) ?? {},
      firstSeenAt: row.first_seen_at,
      // ALWAYS PRESENT, EVEN WHEN IT IS NULL. A missing key and a null are two
      // different sentences on the screen — "this half is older than the join"
      // and "the library has never collected this page" — and only the second
      // is something this query actually looked up.
      library: library.get(row.source_url) ?? null,
    }));
  }

  /**
   * What the source library holds for a set of pages, and nothing for a page it
   * has never collected.
   *
   * NOT AN EQUIJOIN IN THE GROUPING STATEMENT, and the reason is the key.
   * `mission_findings.source_url` is the address as the mission met it, while
   * `resources` is unique on `normalized_url` — the `www.`-less, fragment-less,
   * tracking-param-less form `store.js` mints — so `ON f.source_url = r.source_url`
   * answers "never collected" for a page the library is holding under one extra
   * slash. `#assertQuotableAbstract` settled the matching rule already:
   * normalized against normalized, with the raw address as the last chance for a
   * row stored before normalization existed. This follows it rather than
   * inventing a second rule that disagrees on a handful of URLs nobody audits.
   *
   * ONE QUERY, NOT ONE PER ROW: the outer group is already one row per page
   * read, and a per-row SELECT here would be N round trips on the one screen
   * whose whole point is listing everything at once.
   *
   * NOTHING IS INVENTED FOR A MISS. The alternative considered and refused was a
   * type read off the TLD with a score derived from it. On screen that is
   * indistinguishable from a measured one, which makes every real score less
   * trustworthy rather than the missing ones more.
   *
   * @param urls - the source addresses, spelled as the findings stored them.
   * @returns Map url → `{ type, quality }`; no entry for a page the library does not hold.
   */
  #libraryFactsFor(urls) {
    const found = new Map();
    if (urls.length === 0) return found;

    const keys = new Map();
    for (const url of urls) keys.set(url, normalizeUrl(url) ?? url);
    // Both spellings in one IN-list, so a page is looked up under the form the
    // library keys on AND under the form the mission met.
    const wanted = [...new Set([...keys.keys(), ...keys.values()])];
    const holes = wanted.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT source_url, normalized_url, type, quality_score FROM resources
      WHERE normalized_url IN (${holes}) OR source_url IN (${holes})
      ORDER BY id
    `).all(...wanted, ...wanted);

    // FIRST ROW WINS, UNDER A STABLE ORDER. `normalized_url` is unique only
    // where it is set, so two rows can answer one address; a chip that changed
    // between two reads of the same mission would be reporting the query plan.
    const byKey = new Map();
    for (const row of rows) {
      for (const key of [row.normalized_url, row.source_url]) {
        if (typeof key === "string" && key !== "" && !byKey.has(key)) byKey.set(key, row);
      }
    }

    for (const [url, normalized] of keys) {
      const row = byKey.get(normalized) ?? byKey.get(url);
      if (row === undefined) continue;
      found.set(url, {
        type: row.type,
        // THE SCORE AS THE LIBRARY RECORDED IT. Not rescaled, and not defaulted:
        // the column is nullable, a collected row nobody scored is a real third
        // state, and `?? 0` would print the library's worst score for it — 0 is
        // not "lowest quality", it is "never graded".
        quality: typeof row.quality_score === "number" ? row.quality_score : null,
      });
    }
    return found;
  }

  /** Verified counts for a page of missions, in one query rather than N. */
  #verifiedCountsFor(ids) {
    const counts = new Map();
    if (ids.length === 0) return counts;
    const holes = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT f.mission_id AS mission_id, COUNT(*) AS n
      FROM mission_findings f
      JOIN missions m ON m.id = f.mission_id AND m.run_count = f.run_count
      WHERE f.mission_id IN (${holes}) AND f.verify_state = ?
      GROUP BY f.mission_id
    `).all(...ids, COUNTING_VERIFY_STATE);
    for (const row of rows) counts.set(row.mission_id, row.n);
    return counts;
  }

  // ── documents: the evidence substrate ───────────────────────────────────

  /**
   * Store a fetched page, and invalidate anything a changed body no longer
   * backs.
   *
   * The row is keyed by the URL, not by the content, so the cache survives
   * re-fetches and a page fetched six months ago can back today's verified
   * claim. When the text HAS changed, the findings that were checked against the
   * old text are moved to `unchecked-stale` rather than left pointing at prose
   * that no longer contains their quote: silently replacing the substrate would
   * leave every one of them reading `verified` against text nobody ever checked.
   *
   * @param record - `{ url, host?, title?, markdown, status, fetchedAt? }`.
   * @returns `{ id, action, invalidated, admissible }`; `action` is `inserted` | `refreshed` | `unchanged`.
   */
  putDocument(record) {
    const url = assertText(record?.url, "url");
    const markdown = typeof record?.markdown === "string" ? record.markdown : "";
    const status = assertCount(record?.status, "status", 0);
    const fetchedAt = record?.fetchedAt ?? new Date().toISOString();
    assertIso(fetchedAt, "fetchedAt");

    const id = documentIdFor(url);
    const host = typeof record?.host === "string" && record.host !== "" ? record.host : sourceHostOf(url);
    const contentHash = sha256(markdown);
    // Normalised characters, matching the precondition's own wording: raw length
    // would count a page of whitespace and indentation as substantial text.
    const charCount = markdown.replace(/\s+/gu, " ").trim().length;

    return withTx(this.db, () => {
      const prior = this.db
        .prepare("SELECT content_hash FROM mission_documents WHERE id = ?")
        .get(id);
      if (prior === undefined) {
        this.db.prepare(`
          INSERT INTO mission_documents (id, url, host, title, markdown, content_hash, byte_length, status, fetched_at)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(id, url, host, typeof record?.title === "string" ? record.title : null,
          markdown, contentHash, charCount, status, fetchedAt);
        return { id, action: "inserted", invalidated: 0, admissible: status >= 200 && status < 300 && charCount >= MIN_DOCUMENT_CHARS };
      }

      const changed = prior.content_hash !== contentHash;
      this.db.prepare(`
        UPDATE mission_documents SET url = ?, host = ?, title = ?, markdown = ?,
               content_hash = ?, byte_length = ?, status = ?, fetched_at = ?
        WHERE id = ?
      `).run(url, host, typeof record?.title === "string" ? record.title : null,
        markdown, contentHash, charCount, status, fetchedAt, id);

      let invalidated = 0;
      if (changed) {
        const holes = FETCH_BACKED_VERIFY_STATES.map(() => "?").join(",");
        invalidated = this.db.prepare(`
          UPDATE mission_findings SET verify_state = 'unchecked-stale', verify_reason = ?
          WHERE document_id = ? AND verify_state IN (${holes})
        `).run(
          `source text changed on re-fetch at ${fetchedAt}; re-verify before citing`,
          id, ...FETCH_BACKED_VERIFY_STATES,
        ).changes;
      }
      return {
        id,
        action: changed ? "refreshed" : "unchanged",
        invalidated,
        admissible: status >= 200 && status < 300 && charCount >= MIN_DOCUMENT_CHARS,
      };
    });
  }

  /**
   * One stored page.
   * @param id - the document id, i.e. `documentIdFor(url)`.
   * @returns the camelCase row with `admissible` precomputed, or undefined.
   */
  getDocument(id) {
    return shapeDocument(this.db.prepare(`
      SELECT id, url, host, title, markdown, content_hash, byte_length, status, fetched_at
      FROM mission_documents WHERE id = ?
    `).get(String(id)));
  }

  /**
   * The stored page for a URL, if we hold one.
   *
   * Looked up by the derived id rather than by the raw URL, so two spellings of
   * the same page — a tracking parameter, a trailing slash — resolve to the one
   * row and the pacer is never paid twice for the same fetch.
   * @param url - the page URL.
   * @returns the document, or undefined.
   */
  documentByUrl(url) {
    return this.getDocument(documentIdFor(url));
  }

  /**
   * Stored pages older than a cutoff, oldest first.
   *
   * Staleness is surfaced, not assumed away: a document past
   * `documentMaxAgeDays` is re-fetched when budget allows and its findings are
   * marked `unchecked-stale` when it does not.
   * @param options - `{ before, limit }`; `before` is an ISO instant.
   * @returns `[{ id, url, host, fetchedAt }]`.
   */
  staleDocuments({ before, limit = 20 } = {}) {
    assertIso(before, "before");
    return this.db.prepare(`
      SELECT id, url, host, fetched_at FROM mission_documents
      WHERE fetched_at < ? ORDER BY fetched_at LIMIT ?
    `).all(before, clampInt(limit, 1, 500, 20)).map((row) => ({
      id: row.id, url: row.url, host: row.host, fetchedAt: row.fetched_at,
    }));
  }

  /**
   * Pages fetched during one mission, for the library upsert in the postlude.
   *
   * This is the only way the library ever acquires body text: it has no content
   * column, its abstracts average 234 characters, and a library that has run
   * fifty missions is materially better than one that has run none.
   * @param missionId - the mission.
   * @param options - `{ runCount, minChars }`.
   * @returns `[{ id, url, host, title, markdown, charCount, status, fetchedAt }]`.
   */
  documentsForMission(missionId, { runCount, minChars = MIN_DOCUMENT_CHARS } = {}) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    return this.db.prepare(`
      SELECT DISTINCT d.id AS id, d.url AS url, d.host AS host, d.title AS title,
             d.markdown AS markdown, d.byte_length AS byte_length, d.status AS status,
             d.fetched_at AS fetched_at
      FROM mission_documents d
      JOIN mission_findings f ON f.document_id = d.id
      WHERE f.mission_id = ? AND f.run_count = ?
        AND d.status >= 200 AND d.status < 300 AND d.byte_length >= ?
      ORDER BY d.fetched_at
    `).all(id, run, assertCount(minChars, "minChars", 0)).map((row) => ({
      id: row.id,
      url: row.url,
      host: row.host,
      title: row.title ?? null,
      markdown: row.markdown,
      charCount: row.byte_length,
      status: row.status,
      fetchedAt: row.fetched_at,
    }));
  }

  // ── figures: the publisher's own image, and the page it came off ───────

  /**
   * Record every figure one fetched page offered. Metadata only; no bytes.
   *
   * THE BATCH IS THE UNIT because the page is the unit: one page absorbed, one
   * transaction, one `last_seen_at`. A per-figure writer would let half a
   * page's figures carry the new stamp and half the old, and the reads below
   * would then show an arbitrary subset of a page's pictures as "still there".
   *
   * Cheap on purpose. This runs for every figure the selector kept on every
   * fetched page, and a deep mission fetches hundreds; the expensive half —
   * asking the publisher for the image — happens later and only for a page one
   * of this run's verified findings cites. That split is what keeps the worst
   * case at `MAX_HELD_FIGURES_PER_MISSION` rather than at the size of the fetch
   * log.
   *
   * THE PAGE MUST ALREADY BE STORED, checked here rather than filtered at the
   * read. A figure whose `document_id` names nothing is a figure with no
   * provenance, and provenance is the only thing separating a cited figure from
   * a fabricated one — so it is refused at the write, where the caller still
   * knows what it was trying to do.
   *
   * THE SAME PAGE FETCHED TWICE upserts by `(document_id, image url)`. The
   * publisher's own words are refreshed — alt, caption, anchor text, offset,
   * size, score, signals — and `state`, `reason`, `mime`, `status`,
   * `byte_length`, `content_hash`, `bytes`, `fetched_at` and `discovered_at`
   * are deliberately NOT in the SET list. Re-reading a page's markup teaches us
   * nothing about whether the publisher will serve us the image, and
   * overwriting `held` with `candidate` would re-request a picture we already
   * hold on every re-absorb, for ever — the loop `enrich.js` persists a
   * negative to avoid, arriving from the other direction.
   *
   * @param documentId - `mission_documents.id` for the page these came off.
   * @param candidates - `[{url, alt?, caption?, anchorText?, textOffset?, width?, height?, score?, signals?}]`.
   * @param at - the ISO instant of the fetch. MUST be the same instant passed
   *   to `putDocument` for this page, or every figure on it reads as removed.
   * @returns `{ documentId, ids, written, dropped }`.
   */
  putFigures(documentId, candidates, at = new Date().toISOString()) {
    const document = assertText(documentId, "documentId");
    assertIso(at, "at");
    const rows = Array.isArray(candidates) ? candidates : [];
    return withTx(this.db, () => {
      const page = this.db.prepare("SELECT id FROM mission_documents WHERE id = ?").get(document);
      if (page === undefined) {
        throw new Error(`cannot attach figures to document ${document}, which this library does not hold; store the page with putDocument() first`);
      }
      const write = this.db.prepare(`
        INSERT INTO mission_figures (
          id, document_id, url, host, alt, caption, anchor_text, text_offset,
          width, height, score, signals, last_seen_at, discovered_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          url = excluded.url, host = excluded.host, alt = excluded.alt,
          caption = excluded.caption, anchor_text = excluded.anchor_text,
          text_offset = excluded.text_offset, width = excluded.width,
          height = excluded.height, score = excluded.score,
          signals = excluded.signals, last_seen_at = excluded.last_seen_at
      `);
      const ids = [];
      let dropped = 0;
      for (const row of rows) {
        const raw = typeof row?.url === "string" ? row.url.trim() : "";
        let id;
        try {
          id = figureIdFor(document, raw);
        } catch {
          // An unkeyable address is dropped and COUNTED, never stored under its
          // raw string: a figure whose id nobody else can mint is a row the
          // route will look for under a different key and never find.
          dropped += 1;
          continue;
        }
        const text = (value, limit) => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, limit) : null);
        write.run(
          id, document, raw, sourceHostOf(raw),
          text(row?.alt, 1_000), text(row?.caption, 2_000), text(row?.anchorText, 300),
          Number.isInteger(row?.textOffset) ? row.textOffset : -1,
          assertCount(row?.width ?? 0, "width", 0), assertCount(row?.height ?? 0, "height", 0),
          Number.isFinite(Number(row?.score)) ? Number(row.score) : 0,
          JSON.stringify(Array.isArray(row?.signals) ? row.signals.map(String) : []),
          at, at,
        );
        ids.push(id);
      }
      return { documentId: document, ids, written: ids.length, dropped };
    });
  }

  /**
   * Store the bytes of one figure, and say we hold them.
   *
   * Refuses anything outside `FIGURE_MIME_TYPES`, over `MAX_FIGURE_BYTES`, or
   * past this document's held ceiling by RECORDING a refusal rather than by
   * throwing: a publisher serving a 9 MB TIFF is an ordinary event, and an
   * exception here would abandon the other figures on the same page.
   *
   * The CEILING IS ENFORCED HERE, not only in the driver that calls this. A
   * ceiling that lives in a caller is a ceiling the next caller does not have,
   * and there is no caller yet — see the risks. The per-mission ceiling needs a
   * mission, which this row does not carry, so it stays with
   * `heldFigureCounts`.
   *
   * This is the inner of the two mime checks. The route runs the outer one
   * again over what it is about to write, because a row stored by a build whose
   * allow list was wider must not become servable by this one.
   *
   * @param record - `{ id, bytes, mime, status, fetchedAt? }`; `bytes` is a Uint8Array.
   * @returns `{ id, state, reason }`.
   */
  holdFigure(record) {
    const id = assertText(record?.id, "id");
    const fetchedAt = record?.fetchedAt ?? new Date().toISOString();
    assertIso(fetchedAt, "fetchedAt");
    const status = assertCount(record?.status ?? 0, "status", 0);
    // The type as SERVED, with its parameters cut off: "image/jpeg; charset=x"
    // IS image/jpeg, and comparing the raw header would refuse it.
    const mime = String(record?.mime ?? "").split(";")[0].trim().toLowerCase();
    const bytes = record?.bytes instanceof Uint8Array ? record.bytes : null;
    const refuse = (reason) => this.refuseFigure({ id, reason, status, at: fetchedAt });

    if (status < 200 || status >= 300) return refuse(`the publisher answered ${status} for this image`);
    if (bytes === null || bytes.byteLength === 0) return refuse("the image came back empty");
    if (!FIGURE_MIME_TYPES.includes(mime)) {
      return refuse(`${mime === "" ? "an unnamed content type" : mime} is not one of ${FIGURE_MIME_TYPES.join(", ")}`);
    }
    if (bytes.byteLength > MAX_FIGURE_BYTES) {
      return refuse(`the image is ${bytes.byteLength} bytes, over the ${MAX_FIGURE_BYTES} ceiling`);
    }

    return withTx(this.db, () => {
      const row = this.db.prepare("SELECT document_id FROM mission_figures WHERE id = ?").get(id);
      if (row === undefined) throw new Error(`no figure ${id} to hold bytes for; record the page's figures with putFigures() first`);
      // `id != ?` so re-holding a figure we already hold does not count itself
      // out and refuse a refresh of bytes we are already storing.
      const held = this.db.prepare(
        "SELECT COUNT(*) AS n FROM mission_figures WHERE document_id = ? AND state = 'held' AND id != ?",
      ).get(row.document_id, id).n;
      if (held >= MAX_HELD_FIGURES_PER_DOCUMENT) {
        return refuse(`this page already holds ${held} figures, which is the ${MAX_HELD_FIGURES_PER_DOCUMENT} allowed`);
      }
      this.db.prepare(`
        UPDATE mission_figures
        SET state = 'held', reason = NULL, mime = ?, status = ?, byte_length = ?,
            content_hash = ?, bytes = ?, fetched_at = ?
        WHERE id = ?
      `).run(mime, status, bytes.byteLength, sha256Bytes(bytes), bytes, fetchedAt, id);
      return { id, state: "held", reason: null };
    });
  }

  /**
   * Record that a figure's bytes will not be held, and why.
   *
   * A PERSISTED NEGATIVE, which `enrich.js` already argues for on the same kind
   * of data: "the reference persists no negative, so it re-fetches those pages
   * forever". A refused figure is never asked for again and never served.
   *
   * `refused` and `failed` are kept apart because a retry policy that cannot
   * tell them apart either re-requests a 415 for ever or never re-requests a
   * timeout, and those are opposite mistakes. status 0 means the request never
   * completed, which is `failed`; any status the publisher actually sent is a
   * `refused`.
   *
   * IT CLEARS BYTES IT WAS HOLDING. A re-fetch that finds something we will not
   * serve must not leave the old copy servable under a row that now says we
   * refused it — the state column and the blob would be telling a reader two
   * different things. The cost is named in the risks.
   *
   * @param record - `{ id, reason, status?, at? }`.
   * @returns `{ id, state, reason }`.
   */
  refuseFigure(record) {
    const id = assertText(record?.id, "id");
    const reason = assertText(record?.reason, "reason");
    const at = record?.at ?? new Date().toISOString();
    assertIso(at, "at");
    const status = assertCount(record?.status ?? 0, "status", 0);
    const state = status === 0 ? "failed" : "refused";
    const changed = this.db.prepare(`
      UPDATE mission_figures
      SET state = ?, reason = ?, status = ?, bytes = NULL, byte_length = 0,
          content_hash = NULL, fetched_at = ?
      WHERE id = ?
    `).run(state, reason, status, at, id).changes;
    if (changed === 0) throw new Error(`no figure ${id} to refuse; record the page's figures with putFigures() first`);
    return { id, state, reason };
  }

  /**
   * One figure's metadata and the page it came off, by id, unscoped. No bytes.
   *
   * DECLARED ONCE. Two patches proposed this name with two different row
   * shapes, and class-method redeclaration is silent JavaScript: the second
   * wins and every caller written against the first reads undefined without
   * anything throwing. There is one `getFigure` and one `figureBytes` in this
   * file, and a test counts them.
   *
   * Unscoped, so it is NOT a screen read — the two scoped reads below are. It
   * exists for the byte driver, which knows an id and needs the row.
   * @param id - the figure id.
   * @returns the camelCase row with its `page`, or undefined.
   */
  getFigure(id) {
    return shapeFigure(this.db.prepare(`
      SELECT ${FIGURE_COLUMNS}
      FROM mission_figures g
      JOIN mission_documents d ON d.id = g.document_id
      WHERE g.id = ?
    `).get(String(id)));
  }

  /**
   * The stored bytes of one held figure.
   *
   * Separate from `getFigure` so no metadata read ever drags a megabyte a row
   * through memory to render a caption, and so the ONE place bytes leave this
   * database is a method a reader can grep for. It does NOT check scope: the
   * route must have satisfied itself through `figuresForMission` or
   * `figuresForChapter` first, because an id alone says nothing about who may
   * see it.
   * @param id - the figure id.
   * @returns `{ bytes, mime, byteLength, contentHash }`, or undefined when we hold none.
   */
  figureBytes(id) {
    const row = this.db.prepare(`
      SELECT bytes, mime, byte_length, content_hash FROM mission_figures
      WHERE id = ? AND state = 'held' AND bytes IS NOT NULL
    `).get(String(id));
    if (row === undefined) return undefined;
    return { bytes: Buffer.from(row.bytes), mime: row.mime, byteLength: row.byte_length, contentHash: row.content_hash };
  }

  /**
   * The held figures of every page this run's findings cite. THE ROUTE'S SCOPE.
   *
   * Mirrors `documentsForMission` exactly, one table further out: a figure is
   * this mission's when one of this run's own findings was checked against the
   * page it came off, and nothing else is ever served under this mission's
   * path. A byte route keyed on a figure id alone would hand anyone holding an
   * id every image every other mission ever pulled, under a URL that says it
   * belongs to this one.
   *
   * The join to `mission_documents` is not decoration either: it re-applies the
   * 2xx and `MIN_DOCUMENT_CHARS` bar the document reader applies, so a page
   * re-fetched into a paywall notice takes its figures out of the answer at the
   * same moment it takes its own text out.
   *
   * @param missionId - the mission.
   * @param options - `{ runCount, limit }`.
   * @returns `[figure]`, best-scoring first, each carrying its `page`.
   */
  figuresForMission(missionId, { runCount, limit = MAX_HELD_FIGURES_PER_MISSION } = {}) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const holes = FETCH_BACKED_VERIFY_STATES.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT DISTINCT ${FIGURE_COLUMNS}
      FROM mission_figures g
      JOIN mission_documents d ON d.id = g.document_id
      JOIN mission_findings  f ON f.document_id = g.document_id
      WHERE f.mission_id = ? AND f.run_count = ?
        AND f.verify_state IN (${holes})
        AND g.state = 'held' AND ${FIGURE_STILL_ON_PAGE}
        AND d.status >= 200 AND d.status < 300 AND d.byte_length >= ?
      ORDER BY g.score DESC, g.text_offset, g.id
      LIMIT ?
    `).all(id, assertCount(run, "runCount", 1), ...FETCH_BACKED_VERIFY_STATES, MIN_DOCUMENT_CHARS,
      clampInt(limit, 1, 500, MAX_HELD_FIGURES_PER_MISSION)).map(shapeFigure);
  }

  /**
   * The held figures of the pages ONE CHAPTER cites. RULE 3, AS A JOIN.
   *
   * A figure may only appear in a chapter whose own findings were checked
   * against the page the figure came off; a figure lifted from a page the
   * chapter does not cite is decoration presented as evidence. Enforced HERE,
   * in SQL, and not in the renderer — a projection that filtered in JavaScript
   * would be one filter, and the byte route would need a second one that agreed
   * with it for ever. There is one query and both callers use it.
   *
   * A chapter is keyed `(mission, run, dimension, index)` and a finding is keyed
   * `(mission, run, dimension)`, so the DIMENSION is the tightest bound this
   * schema can express. That is a real bound rather than a formality: it
   * excludes every page the mission fetched for another dimension, and every
   * page it fetched and never cited at all. A tighter bound exists one table
   * out — `mission_artifacts.citations` carries a `findingId` per citation — and
   * belongs to the projection, not here.
   *
   * @param missionId - the mission.
   * @param options - `{ runCount, dimensionId, limit }`.
   * @returns `[figure]`, best-scoring first, each carrying its `page`.
   */
  figuresForChapter(missionId, { runCount, dimensionId, limit = MAX_HELD_FIGURES_PER_DOCUMENT * 4 } = {}) {
    const id = assertText(missionId, "missionId");
    const dimension = assertText(dimensionId, "dimensionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const holes = FETCH_BACKED_VERIFY_STATES.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT DISTINCT ${FIGURE_COLUMNS}
      FROM mission_figures g
      JOIN mission_documents d ON d.id = g.document_id
      JOIN mission_findings  f ON f.document_id = g.document_id
      WHERE f.mission_id = ? AND f.run_count = ? AND f.dimension_id = ?
        AND f.verify_state IN (${holes})
        AND g.state = 'held' AND ${FIGURE_STILL_ON_PAGE}
        AND d.status >= 200 AND d.status < 300 AND d.byte_length >= ?
      ORDER BY g.score DESC, g.text_offset, g.id
      LIMIT ?
    `).all(id, assertCount(run, "runCount", 1), dimension, ...FETCH_BACKED_VERIFY_STATES, MIN_DOCUMENT_CHARS,
      clampInt(limit, 1, 500, MAX_HELD_FIGURES_PER_DOCUMENT * 4)).map(shapeFigure);
  }

  /**
   * The figures the byte driver may consider fetching, for a set of pages.
   *
   * OFFERING IS NOT PLACING. This is the candidate list, so it does not require
   * `state = 'held'` — nothing would ever be offered if it did, and no figure
   * would ever be fetched. Rule 3 is finished at draw time by
   * `figuresForChapter`; this only decides what is worth spending a request on.
   *
   * Two exclusions, both about what a picture MEANS rather than what it is. A
   * `url` appearing under two or more different documents is site furniture — a
   * masthead, a share icon, an author avatar — and that is MEASURED across the
   * corpus rather than guessed from a filename denylist, which is why it also
   * catches furniture nobody has seen before. And a row already `refused` or
   * `failed` is excluded, so a publisher's 403 is paid for once.
   *
   * @param documentIds - `mission_documents.id` values.
   * @returns `[figure]`, best-scoring first, each carrying its `page`.
   */
  placeableFigures(documentIds) {
    const ids = (Array.isArray(documentIds) ? documentIds : [])
      .map((value) => String(value ?? "")).filter((value) => value !== "");
    if (ids.length === 0) return [];
    const holes = ids.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT ${FIGURE_COLUMNS}
      FROM mission_figures g
      JOIN mission_documents d ON d.id = g.document_id
      WHERE g.document_id IN (${holes})
        AND g.state IN ('candidate', 'held')
        AND ${FIGURE_STILL_ON_PAGE}
        AND g.url NOT IN (
          SELECT url FROM mission_figures GROUP BY url HAVING COUNT(DISTINCT document_id) >= 2
        )
      ORDER BY g.score DESC, g.text_offset, g.id
    `).all(...ids).map(shapeFigure);
  }

  /**
   * How many figures already hold bytes, against each ceiling.
   *
   * ONE STATEMENT for both numbers. A driver that read them separately would
   * race itself between two documents of the same mission and overshoot the
   * mission ceiling by however many pages it had in flight.
   * @param missionId - the mission.
   * @param options - `{ runCount, documentId }`.
   * @returns `{ mission, document }` — counts of rows in state 'held'.
   */
  /**
   * The figures still worth asking a publisher for, for ONE chapter's pages.
   *
   * THE FETCH QUEUE, and it is a different question from `figuresForChapter`
   * even though it is the same join. That one answers "what may this chapter
   * SHOW", so it selects `state = 'held'` and is the only shape a screen ever
   * sees. This one answers "what may this mission ASK FOR", so it selects
   * `state = 'candidate'` — the rows whose bytes are neither held nor already
   * refused.
   *
   * A SECOND METHOD RATHER THAN A `state` OPTION ON `figuresForChapter`. A read
   * that can be ASKED for un-held figures is a read that can hand a route a row
   * for a figure we do not hold, and the whole reason the serving path has one
   * query is that it cannot be talked into a different one. Splitting on the
   * question keeps the served set unparameterised.
   *
   * RULE 3 IS APPLIED AT THE FETCH AS WELL AS AT THE READ, and that is not
   * belt-and-braces. A figure lifted off a page no chapter cites must never
   * cost a request to that publisher, let alone a megabyte on this disk — the
   * fetch is the expensive half and the cheap half already ran. Because the
   * join is `figuresForChapter`'s, anything this returns is something the same
   * dimension would be allowed to show if the bytes arrive; a figure that could
   * never be shown is never asked for.
   *
   * `refused` AND `failed` ARE BOTH EXCLUDED, and excluding `failed` is a
   * declined decision rather than a policy. `refuseFigure`'s docblock keeps the
   * two states apart precisely so a retry policy can tell a 415 from a timeout;
   * this driver is not that policy, and retrying `failed` here would double the
   * requests for exactly the dimension being collected a second time because
   * the first round went badly. The column keeps the distinction for a policy
   * that does not exist yet rather than having it silently consumed here.
   *
   * @param missionId - the mission.
   * @param options - `{ runCount, dimensionId, limit }`.
   * @returns `[figure]`, best-scoring first, each carrying its `page`. Never bytes.
   */
  fetchableFigures(missionId, { runCount, dimensionId, limit = MAX_HELD_FIGURES_PER_DOCUMENT * 4 } = {}) {
    const id = assertText(missionId, "missionId");
    const dimension = assertText(dimensionId, "dimensionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const holes = FETCH_BACKED_VERIFY_STATES.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT DISTINCT ${FIGURE_COLUMNS}
      FROM mission_figures g
      JOIN mission_documents d ON d.id = g.document_id
      JOIN mission_findings  f ON f.document_id = g.document_id
      WHERE f.mission_id = ? AND f.run_count = ? AND f.dimension_id = ?
        AND f.verify_state IN (${holes})
        AND g.state = 'candidate'
        AND d.status >= 200 AND d.status < 300 AND d.byte_length >= ?
      ORDER BY g.score DESC, g.id
      LIMIT ?
    `).all(id, assertCount(run, "runCount", 1), dimension, ...FETCH_BACKED_VERIFY_STATES, MIN_DOCUMENT_CHARS,
      clampInt(limit, 1, 500, MAX_HELD_FIGURES_PER_DOCUMENT * 4)).map(shapeFigure);
  }

  heldFigureCounts(missionId, { runCount, documentId } = {}) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT g.id) FROM mission_figures g
           JOIN mission_findings f ON f.document_id = g.document_id
          WHERE f.mission_id = ? AND f.run_count = ? AND g.state = 'held') AS mission,
        (SELECT COUNT(*) FROM mission_figures WHERE document_id = ? AND state = 'held') AS document
    `).get(id, assertCount(run, "runCount", 1), String(documentId ?? ""));
    return { mission: row.mission, document: row.document };
  }

  // ── chapters ────────────────────────────────────────────────────────────

  /**
   * Insert or update one chapter of one generation.
   * @param record - `{ missionId, runCount, dimensionId, chapterIndex, sectionType, heading, body?, wordCount?, minDelivery, underDelivered?, decision?, score?, attempts?, inputHash, at? }`.
   * @returns the chapter key, as `{ runCount, dimensionId, chapterIndex }`.
   */
  upsertChapter(record) {
    const missionId = assertText(record?.missionId, "missionId");
    const runCount = assertCount(record?.runCount, "runCount", 1);
    const dimensionId = assertText(record?.dimensionId, "dimensionId");
    const chapterIndex = assertCount(record?.chapterIndex, "chapterIndex", 0);
    assertMember(record?.sectionType, SECTION_TYPES, "sectionType");
    const heading = assertText(record?.heading, "heading");
    const minDelivery = assertCount(record?.minDelivery, "minDelivery", 0);
    const inputHash = assertText(record?.inputHash, "inputHash");
    if (record?.decision !== undefined && record.decision !== null) {
      assertMember(record.decision, CHAPTER_DECISIONS, "decision");
    }
    const at = record?.at ?? new Date().toISOString();
    assertIso(at, "at");

    this.db.prepare(`
      INSERT INTO mission_chapters (
        mission_id, run_count, dimension_id, chapter_index, section_type, heading, body,
        word_count, min_delivery, under_delivered, decision, score, attempts, input_hash, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(mission_id, run_count, dimension_id, chapter_index) DO UPDATE SET
        section_type = excluded.section_type,
        heading = excluded.heading,
        body = excluded.body,
        word_count = excluded.word_count,
        min_delivery = excluded.min_delivery,
        under_delivered = excluded.under_delivered,
        decision = excluded.decision,
        score = excluded.score,
        attempts = excluded.attempts,
        input_hash = excluded.input_hash,
        updated_at = excluded.updated_at
    `).run(
      missionId, runCount, dimensionId, chapterIndex, record.sectionType, heading,
      typeof record?.body === "string" ? record.body : null,
      assertCount(record?.wordCount ?? 0, "wordCount", 0),
      minDelivery,
      flag(record?.underDelivered),
      record?.decision ?? null,
      numberOrNull(record?.score),
      assertCount(record?.attempts ?? 0, "attempts", 0),
      inputHash, at,
    );
    return { runCount, dimensionId, chapterIndex };
  }

  /**
   * Every chapter of one generation, in report order.
   * @param missionId - the mission.
   * @param runCount - the generation; defaults to the mission's current run.
   * @returns `[chapter]`.
   */
  listChapters(missionId, runCount) {
    const id = assertText(missionId, "missionId");
    const run = runCount ?? this.db.prepare("SELECT run_count FROM missions WHERE id = ?").get(id)?.run_count ?? 1;
    return this.db.prepare(`
      SELECT run_count, dimension_id, chapter_index, section_type, heading, body, word_count,
             min_delivery, under_delivered, decision, score, attempts, input_hash, updated_at
      FROM mission_chapters WHERE mission_id = ? AND run_count = ?
      ORDER BY chapter_index, dimension_id
    `).all(id, run).map(shapeChapter);
  }

  /**
   * Chapters an incremental rerun may keep.
   *
   * Keyed on `input_hash`, which must cover EVERYTHING that can change the
   * output — outline, findings, the skill text, the duty name, the delivery
   * floor and the tier. Hashing outline and findings alone means a rerun after a
   * PROMPT fix skips every chapter and reports success having done nothing,
   * while prompt-editing is the capability the incremental rerun exists for.
   *
   * `fromRunCount` is explicit rather than "the previous run", because a rerun
   * may be reusing a generation two back and guessing would silently rewrite
   * everything.
   *
   * @param missionId - the mission.
   * @param options - `{ fromRunCount, hashes }` — `hashes` maps chapter key to the freshly computed hash.
   * @returns `[{ dimensionId, chapterIndex, reusable, reason }]`.
   */
  chapterReuse(missionId, { fromRunCount, hashes } = {}) {
    const id = assertText(missionId, "missionId");
    const run = assertCount(fromRunCount, "fromRunCount", 1);
    const wanted = hashes instanceof Map ? hashes : new Map(Object.entries(hashes ?? {}));
    const rows = this.listChapters(id, run);
    const decisions = [];
    for (const [key, hash] of wanted) {
      const [dimensionId, indexText] = String(key).split("#");
      const chapterIndex = Number(indexText);
      const prior = rows.find((row) => row.dimensionId === dimensionId && row.chapterIndex === chapterIndex);
      if (prior === undefined) {
        decisions.push({ dimensionId, chapterIndex, reusable: false, reason: "not-written" });
        continue;
      }
      if (prior.inputHash !== hash) {
        decisions.push({ dimensionId, chapterIndex, reusable: false, reason: "inputs-changed" });
        continue;
      }
      // A matching hash over an EMPTY body is not a reusable chapter; it is the
      // hole the content guard exists to catch, carried forward under a green
      // flag.
      if (prior.body === null || prior.body.trim() === "") {
        decisions.push({ dimensionId, chapterIndex, reusable: false, reason: "empty-body" });
        continue;
      }
      decisions.push({ dimensionId, chapterIndex, reusable: true, reason: null, chapter: prior });
    }
    return decisions;
  }

  // ── artefacts ───────────────────────────────────────────────────────────

  /**
   * Write a new artefact version.
   *
   * Versioning is not optional. A rerun overwrites nothing: every terminal
   * outcome, INCLUDING a failure that produced a partial report, writes a
   * version. Without it an improvement attempt that turns out worse is
   * unrecoverable.
   *
   * `evidence` is required and must be non-empty for a non-degraded artefact:
   * the frozen blob is what lets version 1 stay verifiable after version 2 is
   * produced, and an artefact with no provenance is a report nobody can check
   * later. A degraded artefact may carry an empty set — "we looked and found
   * nothing verifiable" is a real, useful answer — but it has to declare itself
   * degraded to say so.
   *
   * @param record - `{ missionId, runCount, trigger, title, markdown, sections, citations, evidence, quality, wordCount?, degraded?, at? }`.
   * @returns the new version number.
   */
  putArtifact(record) {
    const missionId = assertText(record?.missionId, "missionId");
    const runCount = assertCount(record?.runCount, "runCount", 1);
    assertMember(record?.trigger, ARTIFACT_TRIGGERS, "trigger");
    const title = assertText(record?.title, "title");
    const markdown = typeof record?.markdown === "string" ? record.markdown : "";
    const at = record?.at ?? new Date().toISOString();
    assertIso(at, "at");
    if (!Array.isArray(record?.sections)) throw new Error("an artefact needs its typed section offsets; pass sections as an array");
    if (!Array.isArray(record?.citations)) throw new Error("an artefact needs its citation list; pass citations as an array, empty if there are none");
    if (!Array.isArray(record?.evidence)) throw new Error("an artefact needs its frozen evidence blob; pass evidence as an array");
    // OPTIONAL, unlike the three above, because every artefact written before
    // the manifest existed had none and a required field would refuse them.
    // But an ENTRY is not optional about its attribution: rule 2 says every
    // image on a screen names its page and links to it, and the manifest IS the
    // screen's source for a published version — the live row it was projected
    // from can be gone. An entry with no page is an image the report will draw
    // and cannot credit, so it is refused here, where the caller still knows
    // what it was assembling, rather than rendered as a picture from nowhere.
    const figures = Array.isArray(record?.figures) ? record.figures : [];
    for (const figure of figures) {
      const pageUrl = typeof figure?.pageUrl === "string" ? figure.pageUrl.trim() : "";
      const figureId = typeof figure?.figureId === "string" ? figure.figureId.trim() : "";
      if (pageUrl === "" || figureId === "") {
        throw new Error(`a frozen figure needs both its figureId and the pageUrl it must be credited to; got ${JSON.stringify(figure)}`);
      }
    }
    const degraded = flag(record?.degraded);
    if (record.evidence.length === 0 && degraded === 0) {
      throw new Error("an artefact with no frozen evidence cannot be verified after the live tables move on; mark it degraded if that is genuinely the outcome");
    }

    return withTx(this.db, () => {
      const version = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM mission_artifacts WHERE mission_id = ?")
        .get(missionId).n;
      this.db.prepare(`
        INSERT INTO mission_artifacts (
          mission_id, version, run_count, trigger, title, markdown, sections, citations,
          figures, evidence, quality, word_count, degraded, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        missionId, version, runCount, record.trigger, title, markdown,
        JSON.stringify(record.sections), JSON.stringify(record.citations),
        JSON.stringify(figures),
        JSON.stringify(record.evidence), JSON.stringify(record?.quality ?? {}),
        assertCount(record?.wordCount ?? markdown.split(/\s+/u).filter(Boolean).length, "wordCount", 0),
        degraded, at,
      );
      this.#appendEventRow(missionId, {
        type: "artifact:written",
        stepId: null,
        payload: { version, trigger: record.trigger, degraded: degraded === 1, citations: record.citations.length },
        at,
      });
      return version;
    });
  }

  /**
   * The newest artefact version, or a stable sentinel saying why there is none.
   *
   * Never `undefined`. An absent artefact is a `{kind, reason}` object so the
   * client branches on `kind` rather than optional-chaining everywhere — and
   * `not-yet-materialized` and `write-failed` are different reasons, because a
   * sentinel that means two things is a default wearing a costume.
   * @param missionId - the mission.
   * @returns the artefact, or `{ kind: "empty-artifact", reason }`.
   */
  latestArtifact(missionId) {
    const id = assertText(missionId, "missionId");
    const row = shapeArtifact(this.db.prepare(`
      SELECT mission_id, version, run_count, trigger, title, markdown, sections, citations,
             figures, evidence, quality, word_count, degraded, created_at
      FROM mission_artifacts WHERE mission_id = ? ORDER BY version DESC LIMIT 1
    `).get(id));
    if (row !== undefined) return row;
    const mission = this.db.prepare("SELECT status FROM missions WHERE id = ?").get(id);
    if (mission === undefined) return { kind: "empty-artifact", reason: "no-mission" };
    // A terminal mission with no artefact row means the write did not happen —
    // which every terminal path is supposed to guarantee. Reporting that as
    // "not yet" would hide a broken write for ever.
    const reason = TERMINAL_STATUSES.includes(mission.status) ? "write-failed" : "not-yet-materialized";
    return { kind: "empty-artifact", reason };
  }

  /**
   * One artefact version.
   * @param missionId - the mission.
   * @param version - the version number.
   * @returns the artefact, or undefined.
   */
  getArtifact(missionId, version) {
    return shapeArtifact(this.db.prepare(`
      SELECT mission_id, version, run_count, trigger, title, markdown, sections, citations,
             figures, evidence, quality, word_count, degraded, created_at
      FROM mission_artifacts WHERE mission_id = ? AND version = ?
    `).get(String(missionId), assertCount(version, "version", 1)));
  }

  /**
   * Every artefact version's header, newest first, without the markdown.
   *
   * The bodies are deliberately not read: a `deep` report is tens of thousands
   * of words and the version list is rendered on every detail view.
   * @param missionId - the mission.
   * @returns `[{ version, runCount, trigger, title, wordCount, degraded, citations, createdAt }]`.
   */
  listArtifactVersions(missionId) {
    return this.db.prepare(`
      SELECT version, run_count, trigger, title, word_count, degraded, citations, created_at
      FROM mission_artifacts WHERE mission_id = ? ORDER BY version DESC
    `).all(String(missionId)).map((row) => ({
      version: row.version,
      runCount: row.run_count,
      trigger: row.trigger,
      title: row.title,
      wordCount: row.word_count,
      degraded: row.degraded === 1,
      citations: parseJson(row.citations, []).length,
      createdAt: row.created_at,
    }));
  }

  // ── events ──────────────────────────────────────────────────────────────

  /**
   * Append one event and, for business events, stamp progress.
   *
   * `seq` is assigned inside the same transaction as the insert. Ordering by
   * millisecond timestamp is ambiguous — two events in one tick have the same
   * `ts` — and a replay cursor over an ambiguous order re-delivers or skips.
   *
   * `class` is written, never reconstructed from the type prefix at read time. A
   * lifecycle event the USER caused must not count as evidence the mission is
   * alive, and a prefix convention is exactly the kind of rule that drifts.
   *
   * It is also not a PARAMETER any more. It is looked up in `EVENT_TYPES`, the
   * one registry, and an unregistered type throws. Passing it meant this module
   * hard-coded a class at each of its own five append sites while the runtime
   * looked its own up in a table that did not list any of them — two registries,
   * neither complete, and the failure mode is a lifecycle event classed
   * `business`, which makes cancelling a wedged mission read as proof the wedged
   * mission is making progress.
   *
   * @param missionId - the mission.
   * @param event - `{ type, agentId?, stepId?, payload?, at? }`.
   * @returns the assigned `seq`.
   */
  appendEvent(missionId, event) {
    return withTx(this.db, () => this.#appendEventRow(String(missionId), event));
  }

  /** Append one event. Callers are already inside a transaction. */
  #appendEventRow(missionId, event) {
    const type = assertText(event?.type, "type");
    const eventClass = EVENT_TYPES[type];
    if (eventClass === undefined) {
      throw new Error(`mission store: event type "${type}" is not in EVENT_TYPES. Register it there with its class — an unregistered type would have to be classed by guessing, and guessing wrong makes a lifecycle event read as evidence the mission is alive.`);
    }
    assertMember(eventClass, EVENT_CLASSES, "class");
    const at = event?.at ?? new Date().toISOString();
    assertIso(at, "at");
    const seq = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mission_events WHERE mission_id = ?")
      .get(missionId).n;
    this.db.prepare(`
      INSERT INTO mission_events (mission_id, seq, ts, type, class, agent_id, step_id, payload)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      missionId, seq, at, type, eventClass,
      typeof event?.agentId === "string" ? event.agentId : null,
      typeof event?.stepId === "string" ? event.stepId : null,
      JSON.stringify(event?.payload ?? {}),
    );
    // The liveness signal, updated in the SAME transaction as the business event
    // that earned it. The reference infers liveness from a heartbeat row plus an
    // events table plus a spend delta, and needed three detectors and a
    // 14.5-hour production wedge to arrive at the same question this column
    // answers directly.
    if (eventClass === "business") {
      this.db.prepare(`
        UPDATE missions SET last_progress_at = ?, last_stage = COALESCE(?, last_stage), updated_at = ?
        WHERE id = ?
      `).run(at, typeof event?.stepId === "string" ? event.stepId : null, at, missionId);
    }
    return seq;
  }

  /**
   * Events after a cursor, oldest first.
   *
   * This is what makes a page refresh, a plugin restart or a dropped stream
   * invisible: the client resumes from the last `seq` it saw.
   * @param missionId - the mission.
   * @param options - `{ since, limit }`.
   * @returns `{ events, nextSeq, hasMore }`.
   */
  readEvents(missionId, { since = 0, limit = 500 } = {}) {
    const id = String(missionId);
    const cursor = Math.max(0, clampInt(since, 0, Number.MAX_SAFE_INTEGER, 0));
    const cap = clampInt(limit, 1, 2000, 500);
    const rows = this.db.prepare(`
      SELECT seq, ts, type, class, agent_id, step_id, payload FROM mission_events
      WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?
    `).all(id, cursor, cap).map(shapeEvent);
    const highest = this.lastEventSeq(id);
    const nextSeq = rows.length === 0 ? cursor : rows[rows.length - 1].seq;
    return { events: rows, nextSeq, hasMore: nextSeq < highest };
  }

  /**
   * The most recent events, newest first.
   *
   * The WRITE side has no eviction; it is the READ that is bounded. A three-hour
   * mission with chunk-level narration produces tens of thousands of rows, and
   * re-reading all of them on every tick would make the pane that describes the
   * mission the thing that stalls it — on the same blocking connection the
   * mission runs on.
   * @param missionId - the mission.
   * @param limit - how many, capped at 1000.
   * @returns `[event]`, newest first.
   */
  eventTail(missionId, limit = 200) {
    return this.db.prepare(`
      SELECT seq, ts, type, class, agent_id, step_id, payload FROM mission_events
      WHERE mission_id = ? ORDER BY seq DESC LIMIT ?
    `).all(String(missionId), clampInt(limit, 1, 1000, 200)).map(shapeEvent);
  }

  /**
   * The highest `seq` a mission has written.
   * @param missionId - the mission.
   * @returns the sequence number, 0 when there are no events.
   */
  lastEventSeq(missionId) {
    return this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM mission_events WHERE mission_id = ?")
      .get(String(missionId)).n;
  }

  /**
   * Events of one type, for counting a guard's firings across missions.
   *
   * "The content guard fired" is countable rather than anecdotal because every
   * violation writes a row.
   * @param type - the event type.
   * @param options - `{ missionId, since, limit }`.
   * @returns `[{ missionId, seq, ts, payload }]`.
   */
  eventsOfType(type, { missionId, since, limit = 200 } = {}) {
    const where = ["type = ?"];
    const params = [assertText(type, "type")];
    if (typeof missionId === "string" && missionId !== "") {
      where.push("mission_id = ?");
      params.push(missionId);
    }
    if (typeof since === "string" && since !== "") {
      where.push("ts >= ?");
      params.push(since);
    }
    return this.db.prepare(`
      SELECT mission_id, seq, ts, payload FROM mission_events
      WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?
    `).all(...params, clampInt(limit, 1, 1000, 200)).map((row) => ({
      missionId: row.mission_id, seq: row.seq, ts: row.ts, payload: parseJson(row.payload, {}),
    }));
  }

  // ── checkpoints ─────────────────────────────────────────────────────────

  /**
   * Save the resume snapshot.
   *
   * `completedKeys` holds LITERAL step ids, never a numeric ordinal shared
   * between stages, and `pipelineHash` is computed over the stage CONTRACTS
   * rather than their ids: a changed input budget, a changed successor closure
   * or a changed tier list is a changed pipeline, and resuming across one is a
   * silent skip.
   * @param missionId - the mission.
   * @param snapshot - `{ completedKeys, crossState, pipelineHash, status?, at? }`.
   * @returns the saved instant.
   */
  saveCheckpoint(missionId, snapshot) {
    const id = assertText(missionId, "missionId");
    if (!Array.isArray(snapshot?.completedKeys)) {
      throw new Error("a checkpoint needs completedKeys as an array of literal step ids");
    }
    for (const key of snapshot.completedKeys) {
      if (typeof key !== "string" || key === "") {
        throw new Error(`completedKeys must be step ids; got ${JSON.stringify(key)}`);
      }
    }
    const pipelineHash = assertText(snapshot?.pipelineHash, "pipelineHash");
    const at = snapshot?.at ?? new Date().toISOString();
    assertIso(at, "at");
    const status = snapshot?.status ?? "running";
    assertMember(status, CHECKPOINT_STATUSES, "status");

    this.db.prepare(`
      INSERT INTO mission_checkpoints (mission_id, saved_at, completed_keys, cross_state, pipeline_hash, status)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(mission_id) DO UPDATE SET
        saved_at = excluded.saved_at,
        completed_keys = excluded.completed_keys,
        cross_state = excluded.cross_state,
        pipeline_hash = excluded.pipeline_hash,
        status = excluded.status
    `).run(id, at, JSON.stringify(snapshot.completedKeys),
      JSON.stringify(snapshot?.crossState ?? {}), pipelineHash, status);
    return at;
  }

  /**
   * The resume snapshot, if there is one.
   * @param missionId - the mission.
   * @returns `{ savedAt, completedKeys, crossState, pipelineHash, status }`, or undefined.
   */
  getCheckpoint(missionId) {
    const row = this.db.prepare(`
      SELECT saved_at, completed_keys, cross_state, pipeline_hash, status
      FROM mission_checkpoints WHERE mission_id = ?
    `).get(String(missionId));
    if (row === undefined) return undefined;
    return {
      savedAt: row.saved_at,
      completedKeys: parseJson(row.completed_keys, []),
      crossState: parseJson(row.cross_state, {}),
      pipelineHash: row.pipeline_hash,
      status: row.status,
    };
  }

  // `canResume` is NOT a method here. It lives in `mission-runtime.js`, which
  // is where the policy it applies already lives: the seven-day window, the
  // pipeline hash over the stage CONTRACTS, and `RECLAIM_LIMIT`. This module
  // used to carry a second implementation under the same name, with its own
  // five-reason vocabulary missing `reclaim-limit` — one name, two answers, so
  // a caller could not tell which of them it had got. The snapshot itself comes
  // from `getCheckpoint` above; deciding what may be done with it is not a SQL
  // question.

  /**
   * Settle the checkpoint for a terminal status.
   *
   * NOT an unconditional clear. Clearing on every win contradicts "failed
   * missions are resumable" and would leave that policy looking alive while
   * never firing; clearing outside the conditional update lets a losing writer
   * wipe the snapshot of a mission a rerun has since flipped back to running. So
   * the winner DELETES only for `completed` and `cancelled`, and for `failed`
   * and `quality-failed` it stamps the status and leaves the snapshot.
   * `abandoned` is accepted alongside the four terminal statuses and is the boot
   * sweep's: above `RECLAIM_LIMIT` crashes the snapshot is stamped rather than
   * deleted, so `canResume` can answer `reclaim-limit` instead of
   * `no-checkpoint`, which would send the reader hunting for a bug in the
   * checkpoint writer. This method used to accept only TERMINAL_STATUSES, so
   * the sweep's abandon call threw and a deterministic crash was offered for
   * resume on every boot, for ever.
   *
   * @param missionId - the mission.
   * @param status - the terminal status being written, or `abandoned`.
   * @param at - the write stamp.
   * @returns `{ action, reason }`; `action` is `deleted` | `stamped` | `none`.
   */
  settleCheckpoint(missionId, status, at = new Date().toISOString()) {
    assertMember(status, [...TERMINAL_STATUSES, "abandoned"], "status");
    assertIso(at, "at");
    const id = String(missionId);
    if (status === "abandoned" || RESUMABLE_STATUSES.includes(status)) {
      const changed = this.db
        .prepare("UPDATE mission_checkpoints SET status = ?, saved_at = saved_at WHERE mission_id = ?")
        .run(status, id).changes;
      return changed > 0
        ? { action: "stamped", reason: null }
        : { action: "none", reason: "no-checkpoint" };
    }
    const removed = this.db.prepare("DELETE FROM mission_checkpoints WHERE mission_id = ?").run(id).changes;
    return removed > 0 ? { action: "deleted", reason: null } : { action: "none", reason: "no-checkpoint" };
  }

  // ── spend ───────────────────────────────────────────────────────────────

  /**
   * Record one settlement: the exact usage, and what the pool believed.
   *
   * Both numbers, on purpose. Usage arrives as one chunk at the end of a
   * generation, so there is no running token count and the live pool is
   * necessarily an ESTIMATE while `SUM(mission_spend)` is exact. They are two
   * different quantities and storing only one of them makes the estimator
   * permanently untunable.
   * @param record - `{ missionId, stepId, role, agentId?, promptTok?, completionTok?, cacheReadTok?, estimatedTok?, calls?, at? }`.
   * @returns the row id.
   */
  insertSpend(record) {
    const missionId = assertText(record?.missionId, "missionId");
    const stepId = assertText(record?.stepId, "stepId");
    const role = assertText(record?.role, "role");
    const at = record?.at ?? new Date().toISOString();
    assertIso(at, "at");
    // THE GENERATION THIS SPEND BELONGS TO. Without it the pool cannot tell a
    // resume — same run, keep accumulating, which is what its comment promises
    // — from a fresh rerun, which is a new attempt and must get the ceiling
    // somebody chose for one attempt. Taken from the row when the caller knows
    // it and from the mission otherwise, so no writer has to remember.
    const runCount = Number(record?.runCount ?? this.getMission(missionId)?.runCount ?? 0) || 0;
    const info = this.db.prepare(`
      INSERT INTO mission_spend (
        mission_id, step_id, role, agent_id, run_count, model,
        prompt_tok, completion_tok, cache_read_tok, estimated_tok, calls, at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      missionId, stepId, role,
      typeof record?.agentId === "string" ? record.agentId : null,
      runCount,
      typeof record?.model === "string" && record.model !== "" ? record.model : null,
      assertCount(record?.promptTok ?? 0, "promptTok", 0),
      assertCount(record?.completionTok ?? 0, "completionTok", 0),
      assertCount(record?.cacheReadTok ?? 0, "cacheReadTok", 0),
      assertCount(record?.estimatedTok ?? 0, "estimatedTok", 0),
      assertCount(record?.calls ?? 1, "calls", 0),
      at,
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * The authoritative terminal cost of a mission.
   *
   * `cacheReadTok` is disjoint from `promptTok`, so `tokens` is the sum of all
   * three. Folding cache reads into prompt tokens would double-count them
   * against the ceiling and make a cached mission look more expensive than an
   * uncached one.
   * @param missionId - the mission.
   * @returns `{ tokens, promptTok, completionTok, cacheReadTok, estimatedTok, calls }`.
   */
  spendTotals(missionId, runCount = null) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(prompt_tok), 0) AS prompt_tok,
             COALESCE(SUM(completion_tok), 0) AS completion_tok,
             COALESCE(SUM(cache_read_tok), 0) AS cache_read_tok,
             COALESCE(SUM(estimated_tok), 0) AS estimated_tok,
             COALESCE(SUM(calls), 0) AS calls
      FROM mission_spend WHERE mission_id = ?
        AND (? IS NULL OR run_count = ?)
    `).get(String(missionId), runCount === null ? null : Number(runCount), runCount === null ? null : Number(runCount));
    return {
      tokens: row.prompt_tok + row.completion_tok + row.cache_read_tok,
      promptTok: row.prompt_tok,
      completionTok: row.completion_tok,
      cacheReadTok: row.cache_read_tok,
      estimatedTok: row.estimated_tok,
      calls: row.calls,
    };
  }

  /**
   * Spend per stage, for the waste analysis.
   *
   * Retries and chapter rewrites are visible here for free, because every
   * settlement carries its `step_id`.
   * @param missionId - the mission.
   * @returns `[{ stepId, tokens, calls, settlements }]`, most expensive first.
   */
  spendByStage(missionId) {
    return this.db.prepare(`
      SELECT step_id,
             SUM(prompt_tok + completion_tok + cache_read_tok) AS tokens,
             SUM(calls) AS calls,
             COUNT(*) AS settlements
      FROM mission_spend WHERE mission_id = ? GROUP BY step_id ORDER BY tokens DESC
    `).all(String(missionId)).map((row) => ({
      stepId: row.step_id, tokens: row.tokens, calls: row.calls, settlements: row.settlements,
    }));
  }

  /**
   * Spend per agent.
   * @param missionId - the mission.
   * @returns `[{ agentId, role, tokens, calls }]`, most expensive first.
   */
  spendByAgent(missionId) {
    return this.db.prepare(`
      SELECT COALESCE(agent_id, role) AS agent_id, role,
             SUM(prompt_tok + completion_tok + cache_read_tok) AS tokens,
             SUM(calls) AS calls
      FROM mission_spend WHERE mission_id = ? GROUP BY COALESCE(agent_id, role), role
      ORDER BY tokens DESC
    `).all(String(missionId)).map((row) => ({
      agentId: row.agent_id, role: row.role, tokens: row.tokens, calls: row.calls,
    }));
  }

  /**
   * How far the pool's estimate has drifted from the ledger.
   *
   * Reported rather than absorbed. The meter shows both when they disagree by
   * more than the threshold instead of picking one — the reference fought three
   * stale copies of this figure and shipped a state where one card showed zero
   * while the strip beside it showed the real number.
   * @param missionId - the mission.
   * @param threshold - the fraction beyond which this counts as drift.
   * @returns `{ exact, estimated, ratio, drifting }`.
   */
  estimateDrift(missionId, threshold = 0.15) {
    const totals = this.spendTotals(missionId);
    const exact = totals.tokens;
    const estimated = totals.estimatedTok;
    // Denominated in the EXACT figure, and floored at 1 so a mission that has
    // settled nothing yet reports 0 rather than dividing by zero and reporting
    // Infinity as a drift alarm on every fresh mission.
    const ratio = Math.abs(exact - estimated) / Math.max(1, exact);
    return { exact, estimated, ratio, drifting: exact > 0 && ratio > threshold };
  }

  /** Spend sums for a page of missions, in one query rather than N. */
  #spendSumsFor(ids) {
    const sums = new Map();
    if (ids.length === 0) return sums;
    const holes = ids.map(() => "?").join(",");
    for (const row of this.db.prepare(`
      SELECT mission_id, SUM(prompt_tok + completion_tok + cache_read_tok) AS tokens, SUM(calls) AS calls
      FROM mission_spend WHERE mission_id IN (${holes}) GROUP BY mission_id
    `).all(...ids)) {
      sums.set(row.mission_id, { tokens: row.tokens, calls: row.calls });
    }
    return sums;
  }

  // ── tool calls ──────────────────────────────────────────────────────────

  /**
   * Record one tool call.
   *
   * `paceKey` names which of the five ceilings this consumed, and `argsHash` is
   * both the cache key and the thrash detector's key.
   * @param record - `{ missionId, stepId, agentId, tool, paceKey?, argsHash, ok, errorCode?, cached?, latencyMs?, at? }`;
   *   `agentId` and `argsHash` may be empty for a call refused before it ran.
   * @returns the row id.
   */
  insertToolCall(record) {
    const missionId = assertText(record?.missionId, "missionId");
    const stepId = assertText(record?.stepId, "stepId");
    const tool = assertText(record?.tool, "tool");
    // `agentId` and `argsHash` are NOT required to be non-empty, and the two
    // exceptions are the same case: a call the circuit or the ACL refused
    // arrives here before its arguments were ever validated or hashed, and a
    // tool refused at the door has no agent behind it yet. Asserting them
    // non-empty threw on exactly those rows — and `invokeTool` swallows a
    // throwing ledger so the mission survives it, so the refusals silently
    // stopped being recorded. A refusal that leaves no row is a refusal that
    // reads as an empty result set, which is this repository's signature bug.
    const agentId = typeof record?.agentId === "string" ? record.agentId : "";
    const argsHash = typeof record?.argsHash === "string" ? record.argsHash : "";
    const at = record?.at ?? new Date().toISOString();
    assertIso(at, "at");
    const info = this.db.prepare(`
      INSERT INTO mission_tool_calls (
        mission_id, step_id, agent_id, run_count, tool, pace_key, args_hash, args_text, ok, error_code, cached, latency_ms, at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      missionId, stepId, agentId,
      // The generation, for the same reason the spend row carries one: the
      // per-tool ceilings (arXiv, web, fetch) are seeded from these counts, so
      // without it a fresh rerun opens with every allowance already spent.
      Number(record?.runCount ?? this.getMission(missionId)?.runCount ?? 0) || 0,
      tool,
      typeof record?.paceKey === "string" && record.paceKey !== "" ? record.paceKey : null,
      argsHash,
      // Truncated: a fetch's arguments are a URL and a search's are a sentence,
      // and an unbounded column on a per-call table is a library that grows
      // without anybody choosing to.
      String(record?.argsText ?? "").slice(0, 300),
      flag(record?.ok),
      typeof record?.errorCode === "string" ? record.errorCode : null,
      flag(record?.cached),
      assertCount(record?.latencyMs ?? 0, "latencyMs", 0),
      at,
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * Consumption against each rate-limited ceiling.
   *
   * Cached hits are counted separately and NOT charged: paying the pacer twice
   * for the same URL is the thing the document cache exists to prevent, and a
   * counter that charges for cache hits would make the saving invisible.
   * @param missionId - the mission.
   * @returns `{ [paceKey]: { charged, cached, failed } }`.
   */
  toolCallTotals(missionId, runCount = null) {
    const totals = {};
    for (const row of this.db.prepare(`
      SELECT COALESCE(pace_key, tool) AS pace_key,
             SUM(CASE WHEN cached = 0 THEN 1 ELSE 0 END) AS charged,
             SUM(cached) AS cached,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
      FROM mission_tool_calls WHERE mission_id = ?
        AND (? IS NULL OR run_count = ?)
      GROUP BY COALESCE(pace_key, tool)
    `).all(String(missionId), runCount === null ? null : Number(runCount), runCount === null ? null : Number(runCount))) {
      totals[row.pace_key] = { charged: row.charged, cached: row.cached, failed: row.failed };
    }
    return totals;
  }

  /**
   * Per-TOOL spend, failure and latency.
   *
   * `toolCallTotals` above groups by `pace_key`, which is which CEILING a call
   * consumed — three buckets for every tool in the product. This groups by the
   * tool itself, which is the axis a person asks about: not "how much web
   * quota went", but "which tool failed, and which one was slow".
   *
   * `latencyMeasured` IS NOT `calls`, and this method exists at all because
   * collapsing them is the failure this codebase keeps producing. `latency_ms`
   * is `NOT NULL DEFAULT 0`, so a call recorded by a path that never measured
   * one is stored as zero and is indistinguishable, in a SUM, from a call that
   * genuinely returned instantly. An average over `calls` would report those
   * unmeasured calls as instantaneous and make a slow tool look fast; an
   * average over `latencyMeasured` is over the calls that were actually timed.
   * Both numbers are returned so the caller cannot compute the wrong one
   * without choosing to.
   *
   * NO `runCount` PARAMETER. `mission_tool_calls` carries no generation column
   * — the same reason `readTrace` gives for showing both generations' calls in
   * one trajectory — so these totals are for the WHOLE mission, and they match
   * `cost.waste.toolFailures` / `toolCached`, which are also whole-mission. A
   * `runCount` argument here would be a filter that silently did nothing.
   *
   * @param missionId - the mission.
   * @returns `[{tool, calls, failures, cached, latencyMs, latencyMeasured}]`, busiest first.
   */
  toolTotalsByTool(missionId) {
    return this.db.prepare(`
      SELECT tool,
             COUNT(*)                                        AS calls,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)         AS failures,
             SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END)     AS cached,
             SUM(latency_ms)                                 AS latency_ms,
             SUM(CASE WHEN latency_ms > 0 THEN 1 ELSE 0 END) AS latency_measured
      FROM mission_tool_calls WHERE mission_id = ? GROUP BY tool
      ORDER BY calls DESC, tool
    `).all(assertText(missionId, "missionId")).map((row) => ({
      tool: row.tool,
      calls: row.calls,
      failures: row.failures ?? 0,
      cached: row.cached ?? 0,
      latencyMs: row.latency_ms ?? 0,
      latencyMeasured: row.latency_measured ?? 0,
    }));
  }

  /**
   * How many times a mission has made the same call with the same arguments.
   *
   * The no-progress guard trips on three. This detects the SHAPE of a stuck loop
   * rather than inferring it statistically, and it does so in seconds — a
   * multi-pod service cannot do this without shipping every action to a shared
   * store, which is why the reference has to infer stalls from heartbeats and
   * event staleness, and why its rule can never fire on a thrashing mission that
   * is emitting events the whole time.
   * @param missionId - the mission.
   * @param tool - the tool name.
   * @param argsHash - the argument hash.
   * @param options - `{ since }` — an ISO instant to count from.
   * @returns the number of matching calls.
   */
  repeatedCallCount(missionId, tool, argsHash, { since } = {}) {
    const params = [String(missionId), String(tool), String(argsHash)];
    let clause = "mission_id = ? AND tool = ? AND args_hash = ?";
    if (typeof since === "string" && since !== "") {
      clause += " AND at >= ?";
      params.push(since);
    }
    return this.db.prepare(`SELECT COUNT(*) AS n FROM mission_tool_calls WHERE ${clause}`).get(...params).n;
  }

  /**
   * The most recent tool calls, newest first, for the live pane and for the
   * loop-shape half of the no-progress guard.
   *
   * `argsHash` is selected because `detectNoProgress` keys on `(tool, argsHash)`
   * — the same tool with the same arguments three times is a loop SHAPE, not a
   * statistic. It was omitted, so the only supplier of the shapes that guard
   * reads handed it rows with nothing to key on: every shape hashed to
   * `tool::undefined`, three unrelated calls to one tool tripped it, and a
   * healthy fan-out was killed as a wedge.
   *
   * @param missionId - the mission.
   * @param limit - how many, capped at 500.
   * @returns `[{ stepId, agentId, tool, paceKey, argsHash, ok, errorCode, cached, latencyMs, at }]`.
   */
  recentToolCalls(missionId, limit = 50) {
    return this.db.prepare(`
      SELECT step_id, agent_id, tool, pace_key, args_hash, args_text, ok, error_code, cached, latency_ms, at
      FROM mission_tool_calls WHERE mission_id = ? ORDER BY at DESC, id DESC LIMIT ?
    `).all(String(missionId), clampInt(limit, 1, 500, 50)).map((row) => ({
      stepId: row.step_id,
      agentId: row.agent_id,
      tool: row.tool,
      paceKey: row.pace_key ?? null,
      argsHash: row.args_hash,
      argsText: row.args_text ?? "",
      ok: row.ok === 1,
      errorCode: row.error_code ?? null,
      cached: row.cached === 1,
      latencyMs: row.latency_ms,
      at: row.at,
    }));
  }

  // ── the read model's inputs ─────────────────────────────────────────────

  /**
   * Everything the projector needs, gathered in one call.
   *
   * The projector itself is a pure function elsewhere: no I/O, no writes, no
   * container. This is the I/O half, kept here so there is exactly one place
   * that decides which tables a view reads and how much of each.
   *
   * KNOWN DUPLICATION, stated rather than left to be discovered:
   * `mission-view.js`'s `readMissionViewInput(db, id)` reads the same tables for
   * the same projector. The two are not interchangeable — that one hands the
   * projector RAW snake_case rows and this one hands routes the camelCase shape
   * — so collapsing them means rewriting the 1,600-line fold that consumes the
   * raw shape, which is a change to the read model rather than to the seam
   * between the runner and the store. Until that happens, `readMissionViewInput`
   * is the one under test and the one the mission page uses; anything new should
   * go through it, and every statement below should be deleted the day the
   * projector reads shaped rows.
   *
   * It projects from the COUNTER TABLES, not from the event log. Folding the
   * whole stream would mean a three-hour mission re-folding tens of thousands of
   * rows on every tick, on the same blocking connection the mission runs on —
   * the view would become the thing that stalls the mission it describes. State
   * comes from indexed reads; only the live pane reads events, and it reads a
   * bounded tail.
   *
   * @param missionId - the mission.
   * @param options - `{ tail = 200, since, now }`; `since` switches the pane to the incremental read.
   * @returns `{ row, stages, dimensions, chapters, artifact, artifactVersions, spend, spendByStage, spendByAgent, tools, findings, events, checkpoint, resume, config, drift }`, or undefined when there is no such mission.
   */
  readModelInputs(missionId, { tail = 200, since, now = new Date().toISOString() } = {}) {
    const id = assertText(missionId, "missionId");
    // The generation the ceilings on this page belong to. Read once here rather
    // than by each caller, so the meters and the pool cannot disagree about
    // which run they are describing.
    const run = this.getMission(id)?.runCount ?? null;
    const row = this.getMission(id);
    if (row === undefined) return undefined;

    const events = since === undefined || since === null
      ? this.eventTail(id, tail)
      : this.readEvents(id, { since, limit: tail }).events;

    return {
      row,
      stages: this.listStages(id),
      dimensions: this.listDimensions(id, { runCount: row.runCount }),
      chapters: this.listChapters(id, row.runCount),
      artifact: this.latestArtifact(id),
      artifactVersions: this.listArtifactVersions(id),
      // THIS GENERATION, matching the pool. The ceilings on this pane are the
      // ones the run is actually held to, and they are seeded per generation —
      // so an unscoped read here tells the reader "289 of 300 calls" about a
      // run that has made nine. A meter that reports a cap as nearly spent
      // while the run has barely started is worse than no meter: it invites
      // exactly the wrong action.
      //
      // `run` is the mission's current generation, so a resume — which keeps
      // its generation — still sees everything it has spent.
      spend: this.spendTotals(id, run),
      spendByStage: this.spendByStage(id),
      spendByAgent: this.spendByAgent(id),
      tools: this.toolCallTotals(id, run),
      recentTools: this.recentToolCalls(id, 20),
      findings: this.verifyStateCounts(id, row.runCount),
      events,
      lastSeq: this.lastEventSeq(id),
      checkpoint: this.getCheckpoint(id) ?? null,
      // Resolved here rather than left to the client, because "can I resume
      // this?" has six different answers and the button has to say which. The
      // decision is the runtime's one `canResume`; this call is the I/O half
      // handing it the row and the store it reads the snapshot through.
      resume: canResumeMission({ store: this, mission: row, now, stages: STAGES }),
      config: this.latestConfig(id) ?? null,
      drift: this.estimateDrift(id),
    };
  }

  // ── health ──────────────────────────────────────────────────────────────

  /**
   * One row of health for the status route.
   *
   * `unmappedStatuses` and `staleRunning` are the canaries. A mission stuck at
   * `running` with a `last_progress_at` hours old is either a crashed process
   * this boot has not swept or a guard that stopped firing, and both look
   * exactly like a healthy long mission until the number is printed.
   * `unkeyedFindings` is counted for the same reason the evidence store counts
   * its unkeyed rows: every source that could not be keyed collapses into one
   * independence key, so ten of them count as one — the safe direction, but
   * invisible unless it is counted.
   * @param options - `{ bootId, now, staleMs }`.
   * @returns the health record.
   */
  stats({ bootId, now = new Date().toISOString(), staleMs = 900000 } = {}) {
    assertIso(now, "now");
    const byStatus = {};
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS n FROM missions GROUP BY status").all()) {
      byStatus[row.status] = row.n;
    }
    const staleBefore = new Date(Date.parse(now) - Math.max(0, Number(staleMs) || 0)).toISOString();
    const staleRunning = this.db.prepare(`
      SELECT COUNT(*) AS n FROM missions
      WHERE status = 'running' AND (last_progress_at IS NULL OR last_progress_at < ?)
    `).get(staleBefore).n;

    const findingsByState = {};
    for (const row of this.db.prepare("SELECT verify_state, COUNT(*) AS n FROM mission_findings GROUP BY verify_state").all()) {
      findingsByState[row.verify_state] = row.n;
    }

    return {
      schema: this.schemaState(),
      unmappedStatuses: this.assertStatusVocabulary(),
      missions: this.db.prepare("SELECT COUNT(*) AS n FROM missions").get().n,
      byStatus,
      staleRunning,
      orphans: typeof bootId === "string" && bootId !== "" ? this.orphans(bootId).length : null,
      dimensions: this.db.prepare("SELECT COUNT(*) AS n FROM mission_dimensions").get().n,
      findings: this.db.prepare("SELECT COUNT(*) AS n FROM mission_findings").get().n,
      findingsByState,
      unkeyedFindings: this.db.prepare("SELECT COUNT(*) AS n FROM mission_findings WHERE source_host = 'unknown'").get().n,
      documents: this.db.prepare("SELECT COUNT(*) AS n FROM mission_documents").get().n,
      // Documents that cannot back any verified state. A pile of these is a
      // fetch layer returning error pages, and it is the difference between "we
      // found nothing" and "we were refused".
      inadmissibleDocuments: this.db.prepare(
        `SELECT COUNT(*) AS n FROM mission_documents WHERE status < 200 OR status >= 300 OR byte_length < ?`,
      ).get(MIN_DOCUMENT_CHARS).n,
      chapters: this.db.prepare("SELECT COUNT(*) AS n FROM mission_chapters").get().n,
      artifacts: this.db.prepare("SELECT COUNT(*) AS n FROM mission_artifacts").get().n,
      events: this.db.prepare("SELECT COUNT(*) AS n FROM mission_events").get().n,
      checkpoints: this.db.prepare("SELECT COUNT(*) AS n FROM mission_checkpoints").get().n,
      toolCalls: this.db.prepare("SELECT COUNT(*) AS n FROM mission_tool_calls").get().n,
    };
  }
}
