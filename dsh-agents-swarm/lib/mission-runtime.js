/**
 * The mission stage machine: run one mission through twelve stages, one at a
 * time, and record every transition durably enough that a process which dies
 * mid-stage can be picked up by the next one.
 *
 * This module owns the ORCHESTRATION and nothing else. It holds no database
 * handle, opens no transaction of its own, calls no model, touches no network,
 * reads no clock and arms no timer. Everything it needs arrives as a parameter:
 * the store (§4), a `clock()` returning ISO 8601, the stage handlers, the
 * budget pool (§8.3) and a run registry (§5.3). That is not tidiness — it is
 * the only way the behaviours that matter can be tested. A wall-clock expiry, a
 * seven-day resume window and a reclaim cap are all statements about elapsed
 * time, and a runner that reads `Date.now()` itself passes every test that can
 * be written for it while being wrong about the one thing it exists to do.
 *
 * WHY THERE ARE NO TIMERS IN HERE. §5.2 arms two — a mission wall timer and a
 * 30-second no-progress interval — and §2 wants a one-shot `stage:stalled`
 * notice per stage. All three are decisions about elapsed time, and they are
 * exported here as pure predicates (`checkDeadlines`, `detectNoProgress`,
 * `checkStall`) for `lifecycle.js` to drive from the one interval it already
 * owns. One interval asking three questions beats a timer per stage, and it
 * structurally cannot reproduce the failure playground shipped and then deleted
 * on 2026-05-06: a per-stage deadline that repeatedly killed fan-outs which
 * were demonstrably alive, emitting a progress event every second, because the
 * deadline could not see sub-events.
 *
 * WHY IT OWNS NO SQL. `insight-store.js` established the rule — one module
 * holds every statement — and §5.0 established why it cannot be bent here:
 * `BEGIN` inside `BEGIN` throws, the inner `catch`'s `ROLLBACK` destroys the
 * OUTER transaction, and the outer `COMMIT` then throws with the rows already
 * gone. So this module never imports the transaction helper directly; it goes
 * through `store.withTx()`, which means one depth counter per connection
 * instead of three modules each believing they own `BEGIN`.
 *
 * THE ONE RULE THIS MODULE MUST NOT BREAK: no `await` between the open and the
 * close of a `store.withTx()` callback. On one shared connection an `await`
 * inside a transaction lets the hourly collector's inserts execute *inside* the
 * mission's transaction, where a rollback silently discards them. Every
 * `withTx` body below is synchronous by construction: the stage is awaited
 * first, and only its already-settled result is committed.
 *
 * IMPORT DIRECTION. This module imports nothing from the plugin. The stage
 * handlers, the store and the budget pool import it, never the reverse: a cycle
 * between the machine and the stages would make both untestable in isolation.
 */

import { createHash } from "node:crypto";

/* ── vocabularies ──────────────────────────────────────────────────────── */

/**
 * Every status a mission row may hold. Exhaustive and deliberately small.
 *
 * Playground's status column was a free varchar; writers began producing
 * `quality-failed`, the display mapping still held the old enum, and the
 * fall-through returned `running`. The mission then showed as running with a
 * live cancel button that 400'd on every click — the frontend caught the error,
 * toasted, reloaded, and landed on a view that said running again. Cancel
 * became permanently impossible. Defaulting to `running` is what manufactures a
 * forever-running illusion, so nothing here defaults; an unmapped status
 * carrying `completed_at` resolves to `failed` (see `publicStatus` in
 * `mission-store.js`, which is the one place that decision is made).
 *
 * There is no `degraded` member, on purpose (§2): degradation is computed by
 * the projector from `(status, artifact.degraded, degraded dimension count)`.
 * Every member added here is another hand-copied list somebody can forget —
 * that module had four copies, each missing a different one.
 */
export const MISSION_STATUSES = Object.freeze([
  "running",
  // Parked by the boot sweep: out of `running`, checkpoint intact, resume
  // offered but not taken (§5.2). It is NOT terminal. This list used to omit it
  // while `mission-store.js`'s copy carried it, so a status the store can write
  // was a status this module's vocabulary did not contain — and `canResume`
  // refused every parked mission as `wrong-status`, which is the one refusal
  // that tells the user to re-run from scratch.
  "resumable",
  "completed",
  "failed",
  "cancelled",
  "quality-failed",
]);

/**
 * The four statuses that mean the mission is over. Imported by
 * `mission-store.js`, which is where they are asserted at the write.
 */
export const TERMINAL_STATUSES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "quality-failed",
]);

/**
 * Terminal statuses whose checkpoint survives, so the mission can be resumed.
 *
 * ONE list, imported by `mission-store.js`'s `settleCheckpoint` rather than
 * copied into it as `CHECKPOINT_KEEPING_STATUSES`. Which statuses keep a
 * snapshot and which statuses may be resumed from one are the same decision,
 * and the two copies of it were free to drift in the direction nothing reports:
 * "a rerun killed in its first second, zero output" is what that looks like from
 * outside.
 */
export const RESUMABLE_STATUSES = Object.freeze(["failed", "quality-failed"]);

/**
 * Every status `canResume` will consider, which is the above plus `resumable`.
 *
 * DERIVED, not copied. The two lists answer two questions — "whose snapshot
 * survives settlement?" is about terminal statuses only, and `resumable` is not
 * one — and spelling the second out by hand is how they drift in the direction
 * where a parked mission is offered a resume that then refuses.
 */
export const RESUMABLE_FROM_STATUSES = Object.freeze([...RESUMABLE_STATUSES, "resumable"]);

/**
 * Every reason `canResume` may answer with — `ok` and the five refusals. Each
 * refusal names a different next action, because "resume did nothing" is
 * indistinguishable from "resume is broken".
 *
 * `reclaim-limit` is the member `mission-store.js`'s own copy of this list did
 * not have: a mission the boot sweep gave up on has a checkpoint that is
 * present, fresh and pipeline-compatible, so every other reason would be a lie
 * and `no-checkpoint` would send the reader hunting for a bug in the checkpoint
 * writer.
 */
export const RESUME_REFUSALS = Object.freeze([
  "ok",
  "wrong-status",
  "no-checkpoint",
  "expired",
  "pipeline-changed",
  "reclaim-limit",
]);

/**
 * Every status a `mission_stages` row may hold (§4.3), and the vocabulary
 * `mission_stages.status` is validated against — `mission-store.js` imports
 * this rather than keeping a second copy.
 */
export const STAGE_STATUSES = Object.freeze([
  "pending",
  "running",
  "done",
  "failed",
  "degraded",
  "skipped-by-tier",
]);

/** Stage statuses that mean "this stage will not be dispatched again". */
const SETTLED_STAGE_STATUSES = Object.freeze(["done", "degraded", "skipped-by-tier"]);

/**
 * Stage modes. §2 lists seven; two more are added here, and the addition is
 * load-bearing rather than cosmetic.
 *
 * `gate` and `verify` cover the two stages §2's own table draws grey — `s1`,
 * which is arithmetic, and `s9`, which is arithmetic with an agent inside it.
 * Labelling them `plan` and `review` would have been free, except that the
 * runner dispatches on mode: only a `persist` stage may return a terminal
 * intent, and `validateStageDag` asserts exactly one stage carries that mode. A
 * mode field that is approximately right cannot support a check like that.
 */
export const STAGE_MODES = Object.freeze([
  "gate",
  "plan",
  "fan-out",
  "synthesize",
  "draft",
  "review",
  "verify",
  "signoff",
  "persist",
]);

/**
 * The three depth tiers. `quick` runs eight of the twelve stages (§1).
 *
 * One list under one name. `mission-store.js` used to carry the same three
 * strings as `DEPTHS`, which is not a difference anybody can see until the two
 * are edited apart.
 */
export const DEPTH_TIERS = Object.freeze(["quick", "standard", "deep"]);

/**
 * The frozen abort vocabulary (§5.3).
 *
 * `signal.reason` is the authoritative discriminator for failure
 * classification, never a message regex. Playground's regex version misread
 * budget exhaustion and wall-time as user cancellation, which skipped the
 * failure write entirely, left the row at `running`, and let the liveness guard
 * finish it fifteen minutes later with a message that said "pod restarted".
 * Two lies and a fifteen-minute delay out of one wrong `if`.
 */
export const ABORT_REASONS = Object.freeze([
  "user_cancelled",
  "budget_exhausted",
  "wall_time_exceeded",
  "no_progress",
  "context_exceeded",
  "row_missing",
  "superseded",
  "shutdown",
]);

/**
 * Every failure code that may be written to `missions.failure_code`.
 *
 * ONE list, and it is `mission-store.js`'s column vocabulary as well — that
 * module imports this array rather than declaring its own. It used to declare
 * one, ten members long, and the four missing from it are exactly the four the
 * failure paths use. `finalizeMissionRow` asserts membership INSIDE its
 * transaction, so a code the column vocabulary did not carry did not produce a
 * wrong failure code: it threw over the terminal write, rolled it back, and
 * left the row `running` for ever. The mechanism that exists to stop a broken
 * mission was the mechanism that broke.
 *
 * §5.5 tabulates nine. `stage_contract_violation` is the tenth, and it exists
 * because §2 makes the runner reject a stage return that omits `degraded` — a
 * rejection with no code to write is a rejection that surfaces as a bare throw
 * with the row still at `running`. The last three mirror abort reasons that
 * §5.5's table has no row for; every one of them still has to be writable, or
 * the mapping below cannot be total.
 */
export const FAILURE_CODES = Object.freeze([
  "budget_exhausted",
  "wall_time_exceeded",
  "context_exceeded",
  "tool_unavailable",
  "rate_limited",
  "model_error",
  "no_evidence",
  "runtime_crashed",
  "input_invalid",
  "stage_contract_violation",
  "no_progress",
  "user_cancelled",
  "superseded",
  "shutdown",
  // The Leader read the report and declined to sign, or `contentGuard` fired.
  // Its own code because the alternative was reusing `no_evidence` for a report
  // that has plenty of evidence and was refused on entirely different grounds —
  // a lie in the one column §5.5 exists to make learnable.
  "quality_refused",
]);

/**
 * Abort reason → failure code, total over `ABORT_REASONS`.
 *
 * Totality is asserted at import rather than hoped for. "A retry mechanism that
 * never fires, for months" is what a recoverable-code set naming a code the
 * loop never emits looks like; the same gap in the other direction is an abort
 * reason with no code, which falls through to `model_error` and tells the user
 * to check a provider that was never involved.
 */
export const ABORT_REASON_TO_FAILURE = Object.freeze({
  user_cancelled: "user_cancelled",
  budget_exhausted: "budget_exhausted",
  wall_time_exceeded: "wall_time_exceeded",
  no_progress: "no_progress",
  context_exceeded: "context_exceeded",
  row_missing: "input_invalid",
  superseded: "superseded",
  shutdown: "shutdown",
});

/**
 * Abort reason → terminal status. `user_cancelled` and `superseded` are the two
 * that are not failures: in both cases the mission ended because somebody asked
 * for that, and filing them under `failed` is what makes a postmortem corpus
 * useless for finding real failures.
 */
export const ABORT_REASON_TO_STATUS = Object.freeze({
  user_cancelled: "cancelled",
  budget_exhausted: "failed",
  wall_time_exceeded: "failed",
  no_progress: "failed",
  context_exceeded: "failed",
  row_missing: "failed",
  superseded: "cancelled",
  shutdown: "failed",
});

/**
 * Event types this module writes, and the class each is stored under (§4.7).
 *
 * The class is written AT INSERT, never reconstructed by prefix at read,
 * because the read side would have to guess and this guess is expensive: a
 * `business` event is evidence the mission is alive, and `last_progress_at`
 * moves with it. A lifecycle event the USER caused must never be classed
 * business — otherwise cancelling a wedged mission is itself proof the wedged
 * mission is making progress.
 *
 * `stage:stalled` is lifecycle for exactly that reason. It is a notice about
 * the ABSENCE of progress; classing it business would have the stall notice
 * reset the stall clock that produced it.
 */
export const EVENT_TYPES = Object.freeze({
  // The four the STORE writes on its own account. They live in this table
  // because there was briefly a second one: `mission-store.js` hard-coded a
  // class at each of its own append sites while this table claimed to be the
  // registry, so `mission:claimed` was classed by one file and `stage:done` by
  // two. `#appendEventRow` now looks the class up here and throws on a type
  // nobody registered, which is the only way "written at insert, never guessed"
  // can be true of every writer rather than of most of them.
  "mission:created": "lifecycle",
  "mission:claimed": "lifecycle",
  "mission:parked": "lifecycle",
  // `mission:finalized`, not `mission:finished`: the store's conditional UPDATE
  // is the only writer of the terminal row and it appends this in the same
  // transaction. Two names for that one event is how "exactly one terminal
  // event" stops being countable.
  "mission:finalized": "lifecycle",
  "mission:started": "business",
  "mission:resumed": "lifecycle",
  "stages:opened": "lifecycle",
  "stage:started": "business",
  "stage:done": "business",
  "stage:degraded": "business",
  "stage:failed": "business",
  "stage:skipped-by-tier": "lifecycle",
  "stage:stalled": "lifecycle",
  "gate:passed": "business",
  "gate:soft-warning": "business",
  "gate:hard-warning": "business",
  "gate:refused": "business",
  // `MissionStore.putArtifact` appends exactly this type, and `#appendEventRow`
  // throws on an unregistered one — inside putArtifact's own transaction, so the
  // artefact row rolled back with the throw. s12 could not write an artefact at
  // all until this line existed.
  "artifact:written": "business",
  "evidence:none": "business",
  "evidence:thin": "business",
  "recollect:allowed": "business",
  "recollect:refused": "business",
  "recollect:no-gain": "business",
  "checkpoint:divergence": "lifecycle",
  "runtime:orphan-reclaimed": "lifecycle",
  "runtime:owner-conflict": "lifecycle",
  "runtime:reclaim-limit": "lifecycle",
  "postlude:pending": "lifecycle",
  "postlude:handoff-failed": "lifecycle",
});

/* ── constants that are policy, not magic ──────────────────────────────── */

/**
 * How many times the boot sweep hands the same mission back before it stops
 * offering and finalizes it (§5.2).
 *
 * Without a cap, a deterministic crash at one stage resumes and re-crashes on
 * every boot, for ever. `run_count` already exists as the counter to notice it
 * with, so the cap costs one comparison.
 */
export const RECLAIM_LIMIT = 3;

/**
 * How long a checkpoint stays usable. Seven days, not the reference's
 * twenty-four hours: a cloud checkpoint can reference state that has since been
 * evicted, whereas here the documents, findings and chapters are rows in the
 * same file as the checkpoint. Nothing expires underneath it.
 */
export const DEFAULT_RESUME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** At most one `s4 → s3` recollect round, persisted on the mission row (§2). */
export const MAX_PATCH_ROUNDS = 1;

/**
 * Below this fraction of the summed derived floors, the mission is degraded
 * rather than failed (§2's evidence floor). Zero verified findings is a
 * separate and harder case, handled in `evidenceFloorGate`.
 */
export const THIN_EVIDENCE_RATIO = 0.4;

/**
 * Who may call `finalize` (§2, §5.1).
 *
 * The reference enforces its equivalent with a test that greps for call sites.
 * A grep test is a check that runs when somebody runs it; this is the same rule
 * expressed as a parameter, so a caller that is not on the list throws at the
 * call instead of failing review. The runtime is on the list because §5.1
 * counts a stage throw, the wall timer, the budget pool and the boot sweep
 * among the six paths that can end a mission, and four of those arrive here.
 */
export const FINALIZE_ORIGINS = Object.freeze(["s12-persist", "mission-runtime", "lifecycle"]);

/* ── the store seam ────────────────────────────────────────────────────── */

/**
 * The synchronous store this module drives. Every method is `DatabaseSync`-shaped:
 * it returns a value, it never returns a promise, and it never awaits.
 *
 * This typedef is the whole contract between the machine and `mission-store.js`,
 * written out because "an assumption about your own codebase is a check that has
 * not been run". A store missing a method fails at `runMission`'s entry guard
 * naming the method, not at stage nine.
 *
 * EVERY NAME BELOW IS THE STORE'S. This file used to spell eleven of them
 * differently — `insertStageRows` for `initStages`, `claimTerminal` for
 * `finalizeMissionRow`, `deleteCheckpoint` + `stampCheckpointStatus` for the one
 * `settleCheckpoint` — and the entry guard below caught it as "the store is
 * missing 12 of the 17 methods runMission requires". Where the two disagreed the
 * store won, because the store tracks the revised design: §5.1 settles a
 * checkpoint rather than clearing it, and §2 has `s11` return an intent while
 * `finalizeMissionRow` performs the one arbitrated write. Renaming rather than
 * adapting is deliberate — an adapter is two vocabularies plus a translation
 * table, which is this same bug with somewhere new to hide.
 *
 * Rows arrive in the store's camelCase shape (`runCount`, `bootId`,
 * `budget.wallMs`, `stepId`), not as raw snake_case columns. Reading
 * `mission.boot_id` off a shaped row yields `undefined`, which compares unequal
 * to every boot id, so the runner refused every mission it was handed as "owned
 * by boot (none)" — a total outage that throws nothing.
 *
 * @typedef {object} MissionStore
 * @property {(fn: () => any) => any} withTx - §5.0's helper. Re-entrant via savepoints; the ONLY place BEGIN appears.
 * @property {(missionId: string) => object | undefined} getMission - the camelCase shape.
 * @property {(missionId: string) => object[]} listStages - rows in ordinal order, keyed by `stepId`.
 * @property {(missionId: string) => object | undefined} getCheckpoint - `{savedAt, completedKeys[], crossState{}, pipelineHash, status}`, already parsed.
 * @property {(missionId: string, options?: object) => number} distinctVerifiedPairs - distinct (source_host, claim_hash) pairs at verify_state 'verified-source-text'.
 * @property {(missionId: string, options?: object) => number} sumDerivedFloors - Σ derived floor across this run's dimensions.
 * @property {(missionId: string, options?: object) => object} collectionDiagnostics - queries issued, hosts tried, why each returned nothing.
 * @property {(bootId: string) => object[]} orphans - status 'running' with a foreign or null boot_id.
 * @property {(missionId: string, limit?: number) => object[]} recentToolCalls - newest first; the loop-shape half of the no-progress guard.
 * @property {() => object | undefined} getRuntimeOwner - `{pid, bootId, startedAt}`.
 * @property {(owner: object) => object} putRuntimeOwner
 * @property {(missionId: string, stages: object[]) => number} initStages - `[{stepId, ordinal}]`, ordinals 1..n; the tier split is applied here.
 * @property {(missionId: string, stepId: string, at: string, options?: object) => number|null} startStage - returns the attempt number; also emits `stage:started`.
 * @property {(missionId: string, stepId: string, result: object) => object} finishStage - settles the row, emits the terminal stage event and saves the checkpoint, in one transaction.
 * @property {(missionId: string, options: object) => boolean} touchMission - progress without an event; `{stepId, at}`.
 * @property {(missionId: string, event: object) => number} appendEvent - `{type, agentId?, stepId?, payload?, at}`; assigns and returns `seq`.
 * @property {(missionId: string, snapshot: object) => string} saveCheckpoint - `{completedKeys[], crossState{}, pipelineHash, status, at}`.
 * @property {(missionId: string, status: string, at: string) => object} settleCheckpoint - deletes for completed/cancelled, stamps and keeps otherwise.
 * @property {(intent: object) => object} finalizeMissionRow - the one conditional UPDATE; returns `{won, reason, mission, checkpoint}`.
 * @property {(missionId: string, at: string) => number|null} bumpPatchRound - increments and returns the new round.
 * @property {(missionId: string, options: object) => object} claimForRun - the atomic re-claim; boot_id/pid/run_count/last_reopened_at in one statement.
 */

/**
 * Every `MissionStore` method `runMission` may call. Checked once, at entry.
 *
 * Exported, so the seam has exactly one list rather than one here and a
 * hand-copied one in the test that guards it — a third copy of a vocabulary is
 * how the first two got away with disagreeing.
 *
 * It is `runMission`'s needs, not the module's: `sweepOrphans` also wants
 * `orphans` and `settleCheckpoint`, and `claimRuntimeOwner` wants the runtime
 * owner pair, but a store that cannot sweep can still run a mission, so those
 * are checked where they are used. `SWEEP_STORE_METHODS` below covers them.
 */
export const REQUIRED_STORE_METHODS = Object.freeze([
  "withTx",
  "getMission",
  "listStages",
  "getCheckpoint",
  "distinctVerifiedPairs",
  "sumDerivedFloors",
  "collectionDiagnostics",
  "initStages",
  "startStage",
  "finishStage",
  "appendEvent",
  "saveCheckpoint",
  "finalizeMissionRow",
  "bumpPatchRound",
]);

/** What the boot sweep and the ownership claim need on top of the above. */
export const SWEEP_STORE_METHODS = Object.freeze([
  "orphans",
  "settleCheckpoint",
  "getRuntimeOwner",
  "putRuntimeOwner",
]);

/**
 * The entry guard, in one place so every entry point refuses the same way.
 *
 * It runs BEFORE a row is touched, which is the only reason this class of
 * mistake was catchable at all: a store whose methods are named for a different
 * draft of the design fails here, naming every method, instead of at stage nine
 * of a three-hour deep mission with half the work already paid for.
 *
 * @param store - the candidate store.
 * @param names - the method names that entry point calls.
 * @param entry - the function's name, for the error.
 * @returns true. Throws a TypeError otherwise.
 */
function assertStoreHas(store, names, entry) {
  const missing = names.filter((name) => typeof store?.[name] !== "function");
  if (missing.length > 0) {
    throw new TypeError(`mission runtime: ${entry}() was handed a store missing ${missing.length} of the ${names.length} methods it calls: ${missing.join(", ")}. Every one is synchronous and DatabaseSync-shaped, and every name is MissionStore's own; see the MissionStore typedef above.`);
  }
  return true;
}

/* ── the twelve stages ─────────────────────────────────────────────────── */

/**
 * Recursively freezes a stage declaration so a handler cannot mutate the
 * contract it is being graded against.
 *
 * Playground's `MAX_S4_ROUNDS` guard is unreachable dead code because its round
 * counter lives on a per-invocation context object the hook builder rebuilds
 * every call. A mutable shared contract is the same bug with a longer fuse: one
 * stage pushing an id onto `successors` changes the rerun cascade for every
 * later mission in the process, and nothing reports it.
 *
 * @param value - any plain value.
 * @returns the same value, deeply frozen.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * The twelve stages, in execution order. Twelve, counted by a test, because a
 * pipeline whose own length is ambiguous cannot have a correct checkpoint —
 * playground's `s8b` shares stage number 8 with `s8`, so a checkpoint saved
 * after `s8` lists `s8b` complete and a crash between them silently skips the
 * whole section-quality stage on resume while reporting success.
 *
 * `successors` is the forward transitive closure written out LITERALLY, not
 * computed, so a rerun cascade is auditable by reading it. The back edge is a
 * separate field on purpose: re-running `s4` must not cascade into re-running
 * `s3`, and folding the back edge into `successors` is how it would.
 *
 * The closure names tier-skipped stages too (`s5`, `s6`, `s7`, `s10`); the
 * cascade filters by the mission's tier at run time. Writing a tier-specific
 * closure per stage would be four more lists that can drift.
 */
/**
 * The stages that spend the writing reserve rather than the collection share.
 *
 * `s5-reconcile` and everything after it. NOT `s4-assess`: it holds the back
 * edge to `s3-collect`, so a mission sitting in s4 may still collect again and
 * must still be held to the collection ceiling.
 */
export const WRITING_STAGES = Object.freeze(new Set([
  "s5-reconcile", "s6-synthesize", "s7-outline", "s8-write",
  "s9-verify", "s10-critique", "s11-signoff", "s12-persist",
]));

export const STAGES = deepFreeze([
  {
    id: "s1-brief",
    agent: null,
    mode: "gate",
    tiers: ["quick", "standard", "deep"],
    stallMs: 30_000,
    inputBudgetTokens: 0,
    maxOutputTokens: null,
    shrinkLadder: [],
    dag: {
      reads: ["input"],
      writes: ["caps", "gate", "contextPlan"],
      dbWrites: ["missions", "mission_config", "mission_stages", "mission_events"],
      successors: [
        "s2-plan", "s3-collect", "s4-assess", "s5-reconcile", "s6-synthesize",
        "s7-outline", "s8-write", "s9-verify", "s10-critique", "s11-signoff", "s12-persist",
      ],
      backEdge: null,
      rerunable: false,
      rerunReason: "a budget gate cannot be re-run — the caps it froze are what this mission is graded against. Start a new mission.",
      invalidates: [],
    },
  },
  {
    id: "s2-plan",
    agent: "leader",
    mode: "plan",
    tiers: ["quick", "standard", "deep"],
    stallMs: 180_000,
    inputBudgetTokens: 24_000,
    maxOutputTokens: 6_000,
    shrinkLadder: ["fewer postmortems", "library census counts only"],
    dag: {
      reads: ["caps", "postmortems", "libraryCensus"],
      writes: ["dimensions", "goals"],
      dbWrites: ["mission_dimensions", "missions", "mission_events"],
      successors: [
        "s3-collect", "s4-assess", "s5-reconcile", "s6-synthesize", "s7-outline",
        "s8-write", "s9-verify", "s10-critique", "s11-signoff", "s12-persist",
      ],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["dimensions", "findings", "facts", "chapters", "report"],
    },
  },
  {
    id: "s3-collect",
    agent: "researcher",
    mode: "fan-out",
    tiers: ["quick", "standard", "deep"],
    stallMs: 900_000,
    inputBudgetTokens: 60_000,
    maxOutputTokens: 8_000,
    shrinkLadder: ["fewer leads per facet", "abstract instead of full page"],
    dag: {
      reads: ["plan"],
      writes: ["findings"],
      dbWrites: ["mission_dimensions", "mission_findings", "mission_evidence", "mission_documents"],
      successors: [
        "s4-assess", "s5-reconcile", "s6-synthesize", "s7-outline", "s8-write",
        "s9-verify", "s10-critique", "s11-signoff", "s12-persist",
      ],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["findings", "facts", "chapters", "report"],
    },
  },
  {
    id: "s4-assess",
    agent: "leader",
    mode: "review",
    tiers: ["quick", "standard", "deep"],
    stallMs: 180_000,
    inputBudgetTokens: 40_000,
    maxOutputTokens: 4_000,
    shrinkLadder: ["per-dimension counts instead of findings"],
    dag: {
      reads: ["findings", "derivedFloor"],
      writes: ["assessment"],
      dbWrites: ["mission_dimensions", "missions", "mission_events"],
      successors: [
        "s5-reconcile", "s6-synthesize", "s7-outline", "s8-write", "s9-verify",
        "s10-critique", "s11-signoff", "s12-persist",
      ],
      // The one back edge in the pipeline, and it is real because the counter is
      // real: `patch_round` is a column, written in the same synchronous
      // transaction as the stage output, so the round cap survives a restart.
      backEdge: "s3-collect",
      rerunable: true,
      rerunReason: null,
      invalidates: ["assessment", "facts", "chapters", "report"],
    },
  },
  {
    id: "s5-reconcile",
    agent: "reconciler",
    mode: "synthesize",
    // `quick` skips this: a three-dimension mission does not need a Reconciler
    // adjudicating conflicts among twelve findings.
    tiers: ["standard", "deep"],
    stallMs: 300_000,
    inputBudgetTokens: 90_000,
    maxOutputTokens: 10_000,
    shrinkLadder: ["fact-table rows instead of full findings", "drop quotes, keep claim + source", "batch by entity"],
    dag: {
      // The evidence boundary, declared. `s5`'s input query carries the WHERE,
      // and this string is what a reviewer reads to check that it does.
      reads: ["findings:verified"],
      writes: ["facts", "conflicts", "gaps", "hypotheses"],
      dbWrites: ["mission_facts", "mission_conflicts", "mission_events"],
      successors: [
        "s6-synthesize", "s7-outline", "s8-write", "s9-verify", "s10-critique",
        "s11-signoff", "s12-persist",
      ],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["facts", "conflicts", "chapters", "report"],
    },
  },
  {
    id: "s6-synthesize",
    agent: "analyst",
    mode: "synthesize",
    tiers: ["standard", "deep"],
    stallMs: 300_000,
    inputBudgetTokens: 60_000,
    maxOutputTokens: 10_000,
    shrinkLadder: ["fact table without conflict detail"],
    dag: {
      reads: ["facts", "conflicts"],
      writes: ["insights", "foresight", "cards"],
      dbWrites: ["mission_analysis", "mission_events"],
      successors: [
        "s7-outline", "s8-write", "s9-verify", "s10-critique", "s11-signoff", "s12-persist",
      ],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["analysis", "chapters", "report"],
    },
  },
  {
    id: "s7-outline",
    agent: "writer",
    mode: "plan",
    tiers: ["standard", "deep"],
    stallMs: 240_000,
    inputBudgetTokens: 40_000,
    maxOutputTokens: 8_000,
    shrinkLadder: ["fact ids and one-line summaries"],
    dag: {
      reads: ["plan", "facts"],
      // Facts are allocated to chapters BEFORE the chapters are written, so two
      // concurrent chapters cannot both claim a fact or both drop it.
      writes: ["outline", "factAllocation", "sectionTypes"],
      dbWrites: ["mission_chapters", "mission_events"],
      successors: ["s8-write", "s9-verify", "s10-critique", "s11-signoff", "s12-persist"],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["outline", "chapters", "report"],
    },
  },
  {
    id: "s8-write",
    // Two roles run inside this stage — Writer drafts, Reviewer grades. `agent`
    // names the accountable one; the loop is `s8`'s own business.
    agent: "writer",
    mode: "draft",
    tiers: ["quick", "standard", "deep"],
    stallMs: 1_800_000,
    inputBudgetTokens: 60_000,
    maxOutputTokens: 12_000,
    shrinkLadder: ["headings + first paragraph per chapter", "headings only"],
    dag: {
      reads: ["outline", "findings:verified", "facts"],
      writes: ["chapters", "report", "sections", "citations"],
      dbWrites: ["mission_chapters", "mission_artifacts", "mission_events"],
      successors: ["s9-verify", "s10-critique", "s11-signoff", "s12-persist"],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["chapters", "report", "scorecard"],
    },
  },
  {
    id: "s9-verify",
    agent: "verifier",
    mode: "verify",
    // Tier-invariant. Whatever else `quick` skips, it does not skip
    // verification: a cheap tier that reaches a terminal state by a path the
    // expensive tiers never take is a cheap tier whose test results mean
    // nothing.
    tiers: ["quick", "standard", "deep"],
    stallMs: 900_000,
    inputBudgetTokens: 80_000,
    maxOutputTokens: 6_000,
    shrinkLadder: ["batch per N citations", "narrower excerpt window per citation", "one citation per call"],
    dag: {
      reads: ["report", "citations", "documents"],
      writes: ["verdicts", "scorecard"],
      dbWrites: ["mission_citations", "mission_artifacts", "mission_events"],
      successors: ["s10-critique", "s11-signoff", "s12-persist"],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["scorecard", "citations"],
    },
  },
  {
    id: "s10-critique",
    agent: "reviewer",
    mode: "review",
    tiers: ["standard", "deep"],
    stallMs: 300_000,
    inputBudgetTokens: 40_000,
    maxOutputTokens: 6_000,
    shrinkLadder: ["summary and headings only"],
    dag: {
      reads: ["reportSummary", "sectionHeadings", "facts"],
      writes: ["blindspots", "biases", "forecastVulnerabilities"],
      dbWrites: ["mission_critique", "mission_events"],
      successors: ["s11-signoff", "s12-persist"],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["critique"],
    },
  },
  {
    id: "s11-signoff",
    agent: "leader",
    mode: "signoff",
    tiers: ["quick", "standard", "deep"],
    stallMs: 240_000,
    inputBudgetTokens: 50_000,
    maxOutputTokens: 6_000,
    shrinkLadder: ["bounded digest: scorecard, foreword, criteria, decisions", "drop stage outcomes"],
    dag: {
      reads: ["report", "scorecard", "critique", "goals"],
      // Writes the signature to the mission row and RETURNS AN INTENT. It never
      // calls finalize: if `s11` wrote the status, `s12`'s conditional write
      // would lose the race, `won` would be false, and everything hanging off
      // `onWon` — the terminal event, the checkpoint policy, the learn queue —
      // would never run. A refused mission would get no postmortem.
      writes: ["foreword", "signature"],
      dbWrites: ["missions", "mission_events"],
      successors: ["s12-persist"],
      backEdge: null,
      rerunable: true,
      rerunReason: null,
      invalidates: ["signoff"],
    },
  },
  {
    id: "s12-persist",
    agent: null,
    mode: "persist",
    tiers: ["quick", "standard", "deep"],
    stallMs: 60_000,
    inputBudgetTokens: 0,
    maxOutputTokens: null,
    shrinkLadder: [],
    dag: {
      reads: ["signature", "scorecard", "report"],
      writes: ["terminal"],
      dbWrites: ["missions", "mission_artifacts", "mission_checkpoints", "mission_events"],
      successors: [],
      backEdge: null,
      rerunable: false,
      rerunReason: "the terminal write is arbitrated exactly once; re-running it alone would lose its own race. Re-run the mission, not the stage.",
      invalidates: [],
    },
  },
]);

/** The twelve step ids, in order. */
export const STAGE_IDS = Object.freeze(STAGES.map((stage) => stage.id));

/* ── contract validation ───────────────────────────────────────────────── */

/**
 * Validates the stage array's shape and its DAG, throwing on the first problem.
 *
 * Playground validates the same invariants only inside a test file, which means
 * a bad edit ships whenever the test is not run. This runs at import (bottom of
 * this file) and again at plugin init: a validator you have to remember to call
 * is a validator that ships broken.
 *
 * @param stages - a stage array, defaulting to the module's own.
 * @returns true. Throws an Error naming the offending stage and field otherwise.
 */
export function validateStageDag(stages = STAGES) {
  if (!Array.isArray(stages) || stages.length !== 12) {
    throw new Error(`mission runtime: the pipeline must be exactly 12 stages, found ${Array.isArray(stages) ? stages.length : typeof stages}. A pipeline whose own length is ambiguous cannot have a correct checkpoint.`);
  }

  const ids = new Set();
  const indexOf = new Map();
  for (const [index, stage] of stages.entries()) {
    if (!stage || typeof stage.id !== "string" || stage.id === "") {
      throw new Error(`mission runtime: stage at index ${index} has no id.`);
    }
    if (ids.has(stage.id)) {
      throw new Error(`mission runtime: duplicate stage id "${stage.id}". Step ids are the checkpoint's primary key; two stages sharing one is how a resume silently skips a stage and reports success.`);
    }
    ids.add(stage.id);
    indexOf.set(stage.id, index);
  }

  let persistCount = 0;
  for (const [index, stage] of stages.entries()) {
    const where = `stage "${stage.id}" (index ${index})`;

    if (!STAGE_MODES.includes(stage.mode)) {
      throw new Error(`mission runtime: ${where} has mode "${stage.mode}". Use one of: ${STAGE_MODES.join(", ")}.`);
    }
    if (stage.mode === "persist") persistCount += 1;

    if (!Array.isArray(stage.tiers) || stage.tiers.length === 0) {
      throw new Error(`mission runtime: ${where} declares no tiers. A stage no tier runs is a stage that will never be dispatched; delete it or give it tiers.`);
    }
    for (const tier of stage.tiers) {
      if (!DEPTH_TIERS.includes(tier)) {
        throw new Error(`mission runtime: ${where} names tier "${tier}". Use one of: ${DEPTH_TIERS.join(", ")}.`);
      }
    }

    if (!Number.isInteger(stage.stallMs) || stage.stallMs <= 0) {
      throw new Error(`mission runtime: ${where} needs a positive integer stallMs. It is a visibility notice, not a kill timer, but a stage with no stall threshold can wedge with nothing on screen.`);
    }
    if (!Number.isInteger(stage.inputBudgetTokens) || stage.inputBudgetTokens < 0) {
      throw new Error(`mission runtime: ${where} needs inputBudgetTokens (§8.5), checked against the context window before dispatch. Use 0 for a code stage.`);
    }
    if (stage.agent !== null && (!Number.isInteger(stage.maxOutputTokens) || stage.maxOutputTokens <= 0)) {
      // quick's "report in one call, ~3,000 words" sits near the output cap of
      // many routes; an unset maxTokens truncates there silently.
      throw new Error(`mission runtime: ${where} has an agent and must declare maxOutputTokens. An unset output cap truncates silently and the truncation reads as a short answer.`);
    }

    const dag = stage.dag;
    if (!dag || typeof dag !== "object") {
      throw new Error(`mission runtime: ${where} has no dag block.`);
    }
    for (const field of ["reads", "writes", "dbWrites", "successors", "invalidates"]) {
      if (!Array.isArray(dag[field])) {
        throw new Error(`mission runtime: ${where} dag.${field} must be an array, written out literally so the cascade is auditable by reading it.`);
      }
    }
    if (typeof dag.rerunable !== "boolean") {
      throw new Error(`mission runtime: ${where} dag.rerunable must be a boolean.`);
    }
    if (dag.rerunable === false && (typeof dag.rerunReason !== "string" || dag.rerunReason.trim() === "")) {
      throw new Error(`mission runtime: ${where} is rerunable: false and must carry a rerunReason. "You cannot re-run this" with no reason is a dead end the user cannot act on.`);
    }

    for (const successor of dag.successors) {
      if (!ids.has(successor)) {
        throw new Error(`mission runtime: ${where} lists successor "${successor}", which is not a stage. A cascade that names a missing stage stops silently at that entry.`);
      }
      if (indexOf.get(successor) <= index) {
        throw new Error(`mission runtime: ${where} lists successor "${successor}", which runs earlier. Backwards edges must be declared as dag.backEdge, never hidden in the successor closure, or re-running a stage cascades into re-running its own input.`);
      }
    }

    if (dag.backEdge !== null) {
      if (!ids.has(dag.backEdge)) {
        throw new Error(`mission runtime: ${where} declares backEdge "${dag.backEdge}", which is not a stage.`);
      }
      if (indexOf.get(dag.backEdge) >= index) {
        throw new Error(`mission runtime: ${where} declares backEdge "${dag.backEdge}", which does not run earlier. That is a forward edge; put it in successors.`);
      }
      const target = stages[indexOf.get(dag.backEdge)];
      if (!target.dag.successors.includes(stage.id)) {
        throw new Error(`mission runtime: ${where} declares a backEdge to "${dag.backEdge}", but "${dag.backEdge}" does not list "${stage.id}" as a successor. A loop whose two halves disagree about their own shape cannot be reasoned about.`);
      }
    }
  }

  if (stages[0].mode !== "gate") {
    throw new Error(`mission runtime: stage one is "${stages[0].id}" with mode "${stages[0].mode}". Budget is stage one (§8): the gate resolves the five ceilings and refuses a plan that cannot fit, and every later stage reads its caps from the row it froze.`);
  }
  // The gate and the terminal write must exist in EVERY tier. A tier that skips
  // the gate has caps nobody resolved and a wall floor nobody checked; a tier
  // that skips persist can never leave `running`. The runner's own gate guard
  // also depends on the gate being plan[0] at every tier, so this is the
  // assumption that keeps that guard reachable.
  for (const tier of DEPTH_TIERS) {
    if (!stages[0].tiers.includes(tier)) {
      throw new Error(`mission runtime: the budget gate "${stages[0].id}" does not run at tier "${tier}". Budget is stage one at every tier.`);
    }
    if (!stages.at(-1).tiers.includes(tier)) {
      throw new Error(`mission runtime: the persist stage "${stages.at(-1).id}" does not run at tier "${tier}". A tier with no terminal write is a tier whose missions stay running for ever.`);
    }
  }
  if (stages[0].dag.rerunable !== false) {
    throw new Error(`mission runtime: the budget gate must be rerunable: false. Re-running it would re-resolve caps that this mission is already being graded against.`);
  }
  if (persistCount !== 1) {
    throw new Error(`mission runtime: exactly one stage may have mode "persist", found ${persistCount}. The runner honours a terminal intent only from the persist stage; two of them means two paths to the terminal write.`);
  }
  if (stages.at(-1).mode !== "persist") {
    throw new Error(`mission runtime: the last stage must be the persist stage, found "${stages.at(-1).id}". A pipeline that ends before its terminal write leaves the row at running.`);
  }

  return true;
}

/**
 * Splits the pipeline into the stages this tier runs and the ones it does not.
 *
 * `quick` runs eight of twelve. The four it skips still get rows, written
 * `skipped-by-tier` at `s1`, so `mission_stages` holds twelve rows for every
 * mission and the UI never has to decide whether a missing row means pending or
 * excluded.
 *
 * @param stages - a stage array.
 * @param tier - quick | standard | deep.
 * @returns `{run, skipped}`, both arrays of stage declarations, in order.
 */
export function stagesForTier(stages, tier) {
  if (!DEPTH_TIERS.includes(tier)) {
    throw new Error(`mission runtime: unknown depth tier "${tier}". Use one of: ${DEPTH_TIERS.join(", ")}.`);
  }
  const run = [];
  const skipped = [];
  for (const stage of stages) (stage.tiers.includes(tier) ? run : skipped).push(stage);
  return { run, skipped };
}

/**
 * Canonical JSON with recursively sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so moving one field in a stage
 * declaration would change the pipeline hash and invalidate every checkpoint in
 * the user's library for a diff that changed nothing. Sorting makes the hash a
 * statement about content.
 *
 * @param value - any JSON-able value.
 * @returns a stable string.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/**
 * The pipeline hash a checkpoint is stamped with, over the stage CONTRACTS.
 *
 * Not over their ids: a changed `inputBudgetTokens`, a changed successor closure
 * or a changed `tiers` list is a changed pipeline, and resuming across one is
 * exactly the silent skip §2 opens by describing.
 *
 * The hash covers only the stages this tier actually runs, plus the ids it
 * skips. Hashing all twelve would invalidate every `quick` checkpoint whenever a
 * `standard`-only stage was edited — a refusal to resume that is safe and
 * wrong, and the kind of false alarm that gets a guard switched off.
 *
 * @param stages - a stage array.
 * @param tier - quick | standard | deep.
 * @returns a lowercase sha256 hex digest.
 */
export function computePipelineHash(stages, tier) {
  const { run, skipped } = stagesForTier(stages, tier);
  const shape = { tier, run, skipped: skipped.map((stage) => stage.id) };
  return createHash("sha256").update(canonicalJson(shape)).digest("hex");
}

/* ── time, as a parameter ──────────────────────────────────────────────── */

/**
 * Parses an ISO 8601 stamp, throwing with the field name rather than returning
 * NaN. A NaN deadline compares false against everything, so a wall timer built
 * on one never fires and the mission runs until the process does.
 *
 * @param iso - an ISO 8601 string.
 * @param field - the parameter name, for the error.
 * @returns epoch milliseconds.
 */
function msOf(iso, field) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new TypeError(`mission runtime: ${field} must be an ISO 8601 timestamp, received ${JSON.stringify(iso)}.`);
  }
  return ms;
}

/**
 * The instant a mission's wall clock runs from.
 *
 * `max(started_at, last_reopened_at)`, and the max is resolved ONCE, by
 * `shapeMission`, into `effectiveStartedAt`. This function used to recompute it
 * from the two raw columns while the store computed it too — two
 * implementations of one decision, which is the same class of defect as two
 * names for one method and harder to see, because both were right until a clock
 * skew made `last_reopened_at` earlier than `started_at` and only one of them
 * took the max.
 *
 * Without a reopen stamp a resumed mission is instantly wall-time-killed against
 * its original start, the rerun's own terminal write then loses the
 * conditional-write race, and the user reads it as "my rerun broke".
 *
 * @param mission - a shaped mission row.
 * @returns epoch milliseconds.
 */
export function effectiveStartMs(mission) {
  return msOf(mission.effectiveStartedAt, "missions.effectiveStartedAt");
}

/* ── liveness predicates, driven by somebody else's interval ───────────── */

/**
 * Whether this mission has run out of wall clock or budget.
 *
 * Returns the numbers on both paths, not only on expiry, so §9.2's meter can be
 * rendered from the same call the guard makes instead of a second query that
 * can disagree with it.
 *
 * @param options - `{mission, now, budget}`; `budget` may be null.
 * @returns `{expired, reason, detail}` where `reason` is an ABORT_REASONS member or null.
 */
export function checkDeadlines({ mission, now, budget = null, stage = null }) {
  const elapsedMs = msOf(now, "now") - effectiveStartMs(mission);
  // `budget.wallMs`, not a bare `wall_ms`: the five ceilings are one nested
  // object on the shaped row. Read flat, this was `undefined`, and
  // `elapsedMs >= undefined` is false for ever — a wall timer that can never
  // fire, on the module whose one job is to end missions that overrun.
  const capMs = mission.budget.wallMs;

  if (elapsedMs >= capMs) {
    return { expired: true, reason: "wall_time_exceeded", detail: { elapsedMs, capMs, remainingMs: 0 } };
  }
  if (budget && budget.isExhausted()) {
    // A STAGE THAT SPENDS NOTHING STILL RUNS. `stage.agent === null` is the
    // contract's own word for "this stage makes no model calls" — s1-brief and
    // s12-persist are the two — and s12-persist is the stage that WRITES THE
    // ARTEFACT. Measured on a real quick-tier mission: collection finished, the
    // writer produced three chapters, verify and sign-off both ran, and then
    // the budget guard refused to let the persist gate store any of it. The
    // report existed and was thrown away at the last step, by the check that
    // exists to stop the mission spending money it does not have — on a stage
    // that cannot spend any.
    //
    // The wall clock above still kills these stages, because that is a real
    // deadline rather than an allowance.
    if (stage === null || stage.agent !== null) {
      // `ratio()` names the dimension that is actually tight. An unnamed scalar
      // would almost certainly be tokens-only, so a mission that burned 100% of
      // max_arxiv at 20% of tokens would never warn and never degrade — it would
      // just start failing tool calls with no explanation.
      return { expired: true, reason: "budget_exhausted", detail: { elapsedMs, capMs, ...budget.ratio() } };
    }
  }
  return { expired: false, reason: null, detail: { elapsedMs, capMs, remainingMs: capMs - elapsedMs } };
}

/**
 * Whether a run is wedged: producing no business events while still spending,
 * or repeating one tool call with one set of arguments.
 *
 * The second condition detects the SHAPE of a stuck loop rather than inferring
 * it statistically, and it does so in seconds. Playground needs a no-progress
 * tier precisely because a thrashing mission emits events constantly, so its
 * "heartbeat and events both stale" rule can never fire while credits burn.
 *
 * @param options - `{entry, now, noProgressKillMs, spendRose, toolShapes}`.
 * @returns `{tripped, reason, detail, why}` — `why` says which condition held or did not, on both paths.
 */
export function detectNoProgress({ entry, now, noProgressKillMs, spendRose = false, toolShapes = [] }) {
  if (!entry) return { tripped: false, reason: null, detail: null, why: "no live run for that mission" };

  const stalledMs = msOf(now, "now") - entry.lastProgressAtMs;

  // A TOOL CALL LANDING IS PROGRESS, and without this clause the branch below
  // is a five-minute PER-STAGE DEADLINE wearing another name — the exact
  // failure this module's own header says it is structurally immune to:
  //
  //     a per-stage deadline that repeatedly killed fan-outs which were
  //     demonstrably alive ... because the deadline could not see sub-events
  //
  // It could not see them either. Every `business` event is stage-level —
  // stage:started, stage:done, gate:*, artifact:written — and NONE fires while
  // a stage runs, so `lastProgressAtMs` cannot move between stage boundaries.
  // s3-collect over eight dimensions of paced fetches takes longer than five
  // minutes by construction, and it was killed at 311s while its researchers
  // were fetching pages successfully.
  //
  // `toolShapes` is already filtered to calls newer than the last progress mark
  // AND to this stage, so a non-empty list is work that landed since the clock
  // started. That is the branch's own stated meaning — "the model is being
  // called and nothing it returns is landing" — read literally rather than
  // approximated by the wall clock.
  const landed = toolShapes.length > 0;

  if (stalledMs >= noProgressKillMs && spendRose && !landed) {
    return {
      tripped: true,
      reason: "no_progress",
      detail: { stalledMs, noProgressKillMs, stepId: entry.stepId, condition: "silent-but-spending", landed: 0 },
      why: `no business event for ${stalledMs}ms while spend kept rising — the model is being called and nothing it returns counts as progress`,
    };
  }

  // `shape.argsHash`, the store's name for it — `recentToolCalls` is the only
  // supplier of these shapes. Read as `shape.args_hash` every key was
  // `tool::undefined`, so three unrelated calls to one tool tripped the guard
  // and a healthy fan-out was killed as a wedge.
  // Keyed by (agent, tool, args), not by (tool, args).
  //
  // `s3-collect` fans out over five dimensions and each researcher searches the
  // topic's own vocabulary, so two dimensions asking arXiv the same question is
  // ordinary and three is not rare. Aggregating across the fan-out cannot tell
  // that from one agent asking the same question three times, which is the
  // actual loop shape -- and it did not: measured, a mission whose s3 had just
  // delivered findings for three of five dimensions was killed as `no_progress`
  // with "No progress for 0s", because this branch borrowed its sentence from
  // the timeout branch, which had not fired at all.
  //
  // Same failure playground records for its stage stopwatch: a liveness rule
  // that cannot see sub-work kills a stage that is demonstrably alive. Their
  // answer was to stop killing on the stage clock; ours is to count a loop
  // where a loop can happen, which is inside one agent.
  const seen = new Map();
  for (const shape of toolShapes) {
    const key = `${shape.agentId ?? shape.stepId ?? "?"}::${shape.tool}::${shape.argsHash}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count >= 3) {
      return {
        tripped: true,
        reason: "no_progress",
        detail: { stalledMs, stepId: entry.stepId, agentId: shape.agentId ?? null, tool: shape.tool, argsHash: shape.argsHash, repeats: count, condition: "loop-shape" },
        why: `${shape.agentId ?? "an agent"} called ${shape.tool} ${count} times with identical arguments — that is a loop shape, not a statistic`,
      };
    }
  }

  return {
    tripped: false,
    reason: null,
    detail: { stalledMs, noProgressKillMs, spendRose, landed: toolShapes.length },
    why: stalledMs < noProgressKillMs
      ? `last business event ${stalledMs}ms ago, under the ${noProgressKillMs}ms threshold`
      : landed
        ? `no business event for ${stalledMs}ms, but ${toolShapes.length} tool call(s) landed in this stage since — the stage is working, it just has no stage-level event to emit until it finishes`
        : "stage is quiet but spend is flat, which is a paced fetch or a serialised parse, not a wedge",
  };
}

/**
 * Whether the running stage has passed its `stallMs`, latched so the notice
 * fires exactly once per stage.
 *
 * `stallMs` emits one notice and nothing else. This is the single most
 * important lesson in the reference: playground deleted its per-stage deadline
 * after it repeatedly killed fan-outs that were alive. That matters more here,
 * where a paced arXiv round plus a serialised jsdom parse makes a
 * long-but-healthy stage the normal case.
 *
 * The latch is a mutation of the registry entry, deliberately: the alternative
 * is every caller remembering to dedupe, and a 30-second interval that forgets
 * emits 120 identical notices an hour.
 *
 * @param options - `{entry, now}`.
 * @returns `{stalled, detail, why}`.
 */
export function checkStall({ entry, now }) {
  if (!entry || !entry.stepId) return { stalled: false, detail: null, why: "no stage is running" };
  if (entry.stallNoticed) return { stalled: false, detail: null, why: "the one notice for this stage has already fired" };

  const elapsedMs = msOf(now, "now") - entry.stageStartedAtMs;
  if (elapsedMs < entry.stallMs) {
    return { stalled: false, detail: { elapsedMs, stallMs: entry.stallMs }, why: `${elapsedMs}ms of ${entry.stallMs}ms` };
  }

  entry.stallNoticed = true;
  return {
    stalled: true,
    detail: { stepId: entry.stepId, elapsedMs, stallMs: entry.stallMs },
    why: `${entry.stepId} has run ${elapsedMs}ms past its ${entry.stallMs}ms notice threshold. This is a notice, not a kill: termination comes only from the wall clock, the no-progress guard and a terminal error from the model seam.`,
  };
}

/* ── the run registry (abort + liveness, no module state) ──────────────── */

/**
 * The live map of in-flight missions, and the abort registry, as one object.
 *
 * `runs` is ground truth for liveness — not a poll of the database — because
 * `lastProgressAtMs` is a number updated synchronously by the code that emits
 * the event. Playground infers the same thing from a heartbeat row plus an
 * events table plus a spend delta, and needed three detectors and a 14.5-hour
 * production wedge to arrive at the question this map answers directly.
 *
 * Entries are keyed by `(missionId, runCount)`, because `register()` overwrites
 * and a late abort issued while a rerun has already registered a fresh
 * controller would otherwise kill the new run.
 *
 * @returns a registry with register / abort / hasLiveRun / markProgress / release.
 */
export function createRunRegistry() {
  const byKey = new Map();
  const byMission = new Map();
  const keyOf = (missionId, runCount) => `${missionId}#${runCount}`;

  return {
    /**
     * Claims a mission for this process. Overwrites any entry for the same
     * `(missionId, runCount)`, which only happens on a re-entry the caller
     * should have refused, so it returns the displaced entry rather than
     * hiding it.
     *
     * @param options - `{missionId, runCount, now, controller}`.
     * @returns `{entry, displaced}`.
     */
    register({ missionId, runCount, now, controller = new AbortController() }) {
      const nowMs = msOf(now, "now");
      const key = keyOf(missionId, runCount);
      const displaced = byKey.get(key) ?? null;
      const entry = {
        missionId,
        runCount,
        controller,
        startedAtMs: nowMs,
        lastProgressAtMs: nowMs,
        stepId: null,
        stageStartedAtMs: nowMs,
        stallMs: Number.MAX_SAFE_INTEGER,
        stallNoticed: false,
      };
      byKey.set(key, entry);
      byMission.set(missionId, entry);
      return { entry, displaced };
    },

    /** @param missionId - a mission id. @returns the live entry, or null. */
    get(missionId) {
      return byMission.get(missionId) ?? null;
    },

    /**
     * Aborts a run. Idempotent, and a no-op when the run count does not match —
     * a late abort must not kill a rerun that has since started.
     *
     * @param missionId - the mission.
     * @param reason - an ABORT_REASONS member; anything else throws.
     * @param options - `{runCount}` to target one generation.
     * @returns `{aborted, already, why}` — never silently nothing.
     */
    /**
     * Abort a live run, and CARRY WHAT THE GUARD LEARNED.
     *
     * `detail` was not a parameter, so every guard that computed one threw it
     * away at this door. `detectNoProgress` returns which of its two conditions
     * fired, how long the stall was, and — for a loop — the agent, the tool and
     * the repeat count; `describeFailure` selects between two sentences by
     * reading `detail.condition`. Between them sat this signature, and the
     * field never arrived. So every `no_progress` kill reported the timeout
     * branch's wording with `stalledMs ?? 0`: "No progress for 0s", on a
     * mission that had not stalled for 0s and possibly had not stalled at all.
     *
     * The two sentences and the field that chooses between them were both
     * written, both correct, and unreachable from each other.
     */
    abort(missionId, reason, { runCount = null, detail = null } = {}) {
      if (!ABORT_REASONS.includes(reason)) {
        throw new Error(`mission runtime: abort reason "${reason}" is not in the frozen vocabulary. Add it to ABORT_REASONS and to ABORT_REASON_TO_FAILURE, or the failure write will classify it as a provider error.`);
      }
      const entry = runCount === null ? byMission.get(missionId) : byKey.get(keyOf(missionId, runCount));
      if (!entry) {
        return { aborted: false, already: false, why: `no live run in this process for ${missionId}${runCount === null ? "" : ` run ${runCount}`}. If the row still says running it belongs to a dead process; the boot sweep owns it.` };
      }
      if (runCount !== null && entry.runCount !== runCount) {
        return { aborted: false, already: false, why: `the live run is generation ${entry.runCount}, not ${runCount}. Refusing, so a late abort cannot kill a rerun.` };
      }
      if (entry.controller.signal.aborted) {
        return { aborted: true, already: true, why: `already aborted with reason "${entry.controller.signal.reason}"` };
      }
      // Recorded on the ENTRY rather than passed through the AbortSignal:
      // `signal.reason` is a string this vocabulary is frozen on, and widening
      // it to an object would change what every reader of it receives.
      if (detail !== null && typeof detail === "object") entry.abortDetail = detail;
      entry.controller.abort(reason);
      return { aborted: true, already: false, why: `aborted with reason "${reason}"` };
    },

    /**
     * What the guard that aborted this run recorded, or `{}`.
     * @param missionId - a mission id.
     * @returns the detail object an `abort` carried, never null.
     */
    detailOf(missionId) {
      return byMission.get(missionId)?.abortDetail ?? {};
    },

    /** @param missionId - a mission id. @returns true when a run exists and is not aborted. */
    hasLiveRun(missionId) {
      const entry = byMission.get(missionId);
      return Boolean(entry) && !entry.controller.signal.aborted;
    },

    /**
     * Stamps progress. Called by the same code that appends a `business` event,
     * so the in-memory signal and `missions.last_progress_at` cannot disagree.
     *
     * @param missionId - the mission.
     * @param now - ISO 8601.
     */
    markProgress(missionId, now) {
      const entry = byMission.get(missionId);
      if (entry) entry.lastProgressAtMs = msOf(now, "now");
    },

    /**
     * Records which stage is running, resetting the stall latch.
     *
     * @param missionId - the mission.
     * @param stage - a stage declaration, or null when none is running.
     * @param now - ISO 8601.
     */
    setStage(missionId, stage, now) {
      const entry = byMission.get(missionId);
      if (!entry) return;
      entry.stepId = stage ? stage.id : null;
      entry.stageStartedAtMs = msOf(now, "now");
      entry.stallMs = stage ? stage.stallMs : Number.MAX_SAFE_INTEGER;
      entry.stallNoticed = false;
    },

    /** @param missionId - the mission. @param runCount - the generation. @returns true when an entry was removed. */
    release(missionId, runCount) {
      const key = keyOf(missionId, runCount);
      const entry = byKey.get(key);
      if (!entry) return false;
      byKey.delete(key);
      if (byMission.get(missionId) === entry) byMission.delete(missionId);
      return true;
    },

    /** @returns every live entry, for the shutdown handler and §9's read model. */
    list() {
      return [...byKey.values()];
    },
  };
}

/* ── failure classification ────────────────────────────────────────────── */

/**
 * One actionable sentence per failure code (§5.5). Every one names a concrete
 * next action, because "monitor closely" is not one.
 */
const FAILURE_SENTENCES = Object.freeze({
  budget_exhausted: (d) =>
    `Budget exhausted: ${d.dimension ?? "a ceiling"} reached ${d.used ?? "?"} of ${d.limit ?? "?"}. Raise that one ceiling and start a new mission, or run at a lower depth.`,
  wall_time_exceeded: (d) =>
    `Wall clock exceeded: ${Math.round((d.elapsedMs ?? 0) / 1000)}s against a ${Math.round((d.capMs ?? 0) / 1000)}s cap. ${d.resumable ? "A resume point exists — resume from the mission list." : "No usable resume point; re-run fresh."}`,
  context_exceeded: (d) =>
    `The model's context window was exceeded at ${d.stepId ?? "an unnamed stage"} on input "${d.input ?? "unknown"}". Re-run this stage at a smaller batch size.`,
  tool_unavailable: (d) =>
    `Tool "${d.tool ?? "unknown"}" is not reachable.${d.tool === "web_search" ? " Install the search plugin, or re-run — arXiv and the local library do not need it." : ""}`,
  rate_limited: (d) =>
    `${d.backend ?? "A backend"} rate-limited us${d.retryAfter ? `, asking for ${d.retryAfter}` : " and gave no retry-after"}. Wait, then re-run the stage.`,
  model_error: (d) =>
    // The advice is conditional, because this code covers two different
    // things. A transport failure IS "wait for the provider". A model that
    // answered in prose instead of calling the tool it was given is not, and
    // telling somebody to wait for a recovery that has nothing to recover
    // sends them away from the only place the answer is.
    `The model returned an error: ${d.providerMessage ?? "no message"}${d.providerCode ? ` (${d.providerCode})` : ""}. `
    + (d.providerMessage === undefined || /(HTTP|timeout|connect|network|unavailable|overload|refused by the provider)/iu.test(String(d.providerMessage))
      ? "There is one model and no fallback, so re-run when the provider recovers."
      : "That is what the model did, not a transport failure — re-running will repeat it unless the stage's instructions change."),
  no_evidence: (d) =>
    `${d.emptyDimensions ?? 0} of ${d.totalDimensions ?? 0} dimensions returned no verifiable evidence. The brief lists every query issued and every host tried. Narrow the topic, or install the search plugin if only arXiv was reachable.`,
  runtime_crashed: (d) =>
    `The process died during ${d.stepId ?? "an unnamed stage"}${d.runCount ? `, ${d.runCount} time(s) now` : ""}. ${d.resumeArmed ? "Resume is armed — the mission list offers it." : `That is at or over the ${RECLAIM_LIMIT}-crash limit, so resume is no longer offered; re-run fresh or narrow the topic.`}`,
  input_invalid: (d) =>
    `Invalid input: ${d.field ?? "an unnamed field"}. ${d.detail ?? "Correct it and start a new mission."}`,
  stage_contract_violation: (d) =>
    `Stage ${d.stepId ?? "unknown"} broke the stage contract: ${d.detail ?? "no detail"}. This is a bug in the stage, not in your mission; the run stopped rather than continuing over it.`,
  no_progress: (d) =>
    // Two conditions, two sentences. Reporting "No progress for 0s" for a
    // loop-shape trip -- which does not consult the clock at all -- sent
    // whoever read it looking for a stall that never happened.
    d.condition === "loop-shape"
      ? `${d.agentId ?? "An agent"} at ${d.stepId ?? "an unnamed stage"} called ${d.tool ?? "a tool"} ${d.repeats ?? "several"} times with identical arguments, which is a loop rather than work. Re-run the stage.`
      : `No progress for ${Math.round((d.stalledMs ?? 0) / 1000)}s at ${d.stepId ?? "an unnamed stage"} while spend kept rising. Re-run the stage.`,
  quality_refused: (d) =>
    `The report was written but not accepted: ${d.detail ?? d.refusalReason ?? "the Leader declined to sign it"}. It is readable in full — open the artefact and judge it yourself, or re-run with a narrower topic.${Array.isArray(d.violations) && d.violations.length > 0 ? ` Content guard: ${d.violations.join("; ")}.` : ""}`,
  user_cancelled: () => "Cancelled on request. Everything produced up to the cancel was kept and is readable.",
  superseded: () => "Superseded by a newer run of the same mission. Nothing was lost; open the newer run.",
  shutdown: (d) =>
    `The harness shut down during ${d.stepId ?? "an unnamed stage"}. ${d.resumeArmed ? "Resume is armed." : "Re-run fresh."}`,
});

/**
 * Turns a failure code and its detail into one sentence the user can act on.
 *
 * Never throws, including on an unknown code. This runs on the failure path,
 * and a describer that throws there is the same bug as an exception in the
 * event emit before the `abort()` that was not in a `finally`: the failure
 * write never happens and the row stays `running`.
 *
 * @param code - a FAILURE_CODES member, or anything.
 * @param detail - fields the sentence interpolates.
 * @returns a sentence, always.
 */
export function describeFailure(code, detail = {}) {
  const build = FAILURE_SENTENCES[code];
  if (!build) {
    return `The mission failed with code "${code}", which has no description. Add it to FAILURE_CODES and FAILURE_SENTENCES — a code with no sentence reaches the user as a bare string.`;
  }
  try {
    return build(detail ?? {});
  } catch (error) {
    return `The mission failed with code "${code}". Its description could not be built (${error.message}), which is a bug in FAILURE_SENTENCES.`;
  }
}

/**
 * Classifies a failure in a fixed priority order: abort reason first, error
 * class second, message regex last and only as a last resort.
 *
 * The order is the whole point. Playground put the regex first and it misread
 * budget exhaustion and wall-time as user cancellation — which skipped the
 * failure write entirely, left the row at `running`, and let the liveness guard
 * finish it fifteen minutes later saying "pod restarted".
 *
 * @param options - `{signal, error, fallbackCode, detail}`.
 * @returns `{status, code, message, source}` where `source` names which rule decided.
 */
export function classifyFailure({ signal = null, error = null, fallbackCode = "model_error", detail = {} } = {}) {
  // 1. The abort reason is authoritative when there is one.
  if (signal && signal.aborted) {
    const reason = typeof signal.reason === "string" ? signal.reason : null;
    if (reason && ABORT_REASON_TO_FAILURE[reason]) {
      const code = ABORT_REASON_TO_FAILURE[reason];
      return {
        status: ABORT_REASON_TO_STATUS[reason],
        code,
        message: describeFailure(code, detail),
        source: "abort-reason",
      };
    }
    if (reason) {
      // An abort reason outside the vocabulary is a programming error, and
      // saying so beats classifying it as a provider outage.
      return {
        status: "failed",
        code: "input_invalid",
        message: `The run was aborted with reason "${reason}", which is not in ABORT_REASONS. Add it there and to both mapping tables.`,
        source: "abort-reason-unknown",
      };
    }
  }

  // 2. A code the error itself carries. The harness's own canonical codes
  //    arrive this way, and CONTEXT_WINDOW_EXCEEDED is a routine outcome (§8.5),
  //    not an exceptional one.
  // The error's own message, carried into EVERY branch below.
  //
  // It used to be read only by the last one. A stage that knows exactly what
  // went wrong throws `fail(code, diagnostic)` — and the diagnostic says "the
  // model returned an error on turn 3: <what the provider said>" — but the
  // moment the classifier recognised the code it called `describeFailure(code,
  // detail)` and dropped the sentence. Twice in one afternoon a mission ended
  // with "The model returned an error: no message" while holding the message.
  const carriedMessage = error && typeof error.message === "string" && error.message !== ""
    ? error.message
    : undefined;
  const said = { providerMessage: carriedMessage, ...detail };
  const carried = error && (error.code ?? error.failureCode ?? null);
  if (carried === "CONTEXT_WINDOW_EXCEEDED" || carried === "context_exceeded") {
    return { status: "failed", code: "context_exceeded", message: describeFailure("context_exceeded", said), source: "error-code" };
  }
  if (typeof carried === "string" && FAILURE_CODES.includes(carried)) {
    return { status: "failed", code: carried, message: describeFailure(carried, said), source: "error-code" };
  }

  // 3. Message text, last, and only to pick between two codes that both already
  //    exist. It never decides that something was a user cancellation.
  const text = error && typeof error.message === "string" ? error.message : "";
  if (/\b429\b|rate.?limit/i.test(text)) {
    return { status: "failed", code: "rate_limited", message: describeFailure("rate_limited", said), source: "message-regex" };
  }

  const code = FAILURE_CODES.includes(fallbackCode) ? fallbackCode : "model_error";
  return {
    status: "failed",
    code,
    // `said` first, then detail, then the message again — a caller that passes
    // an explicit providerMessage wins, and a detail carrying the key as
    // `undefined` no longer erases the one the error came with.
    message: describeFailure(code, { ...said, ...detail, providerMessage: detail?.providerMessage ?? carriedMessage ?? (text || undefined) }),
    source: text ? "fallback-with-message" : "fallback",
  };
}

// The status fallback that used to live here as `publicStatusOf` is gone, not
// moved: `mission-store.js` already applies `publicStatus(status, completedAt)`
// inside `shapeMission`, so every row this module reads has been through it
// once. Two implementations of "what does an unmapped status display as" is the
// same defect as two names for one method, and it is the defect whose wrong
// answer — `running` — lights a cancel button that 400s for ever.

/* ── terminal arbitration ──────────────────────────────────────────────── */

/**
 * The single arbitrated terminal write. Six paths can end a mission — `s12`, a
 * stage throw, the user cancelling, the wall timer, the budget pool draining,
 * and the boot sweep — and without arbitration the true cause is overwritten by
 * a later, vaguer one. Playground's incident: `budget_exhausted` was rewritten
 * layer by layer into `cancelled` and then into "lost contact", destroying the
 * diagnosis.
 *
 * Four details, each earned:
 *
 * - **Abort fires before the write**, so a caller that goes on to LOSE the race
 *   has still stopped the work. Writing `failed` without aborting forks reality:
 *   the UI shows failed, resume is refused by the re-entry guard, and the
 *   still-running work's own terminal write loses the race, so every minute of
 *   compute is discarded.
 * - **The conditional write carries `run_count`** as well as `status='running'`.
 *   §5.1 keys it on status alone; adding the generation closes the same hole the
 *   abort registry closes, where a late finalize from a dead generation kills a
 *   rerun that has already started.
 * - **The checkpoint is settled, not cleared.** The winner deletes it only for
 *   `completed` and `cancelled`; for `failed` and `quality-failed` it stamps the
 *   status and leaves the snapshot, which is what makes §5.4's "failed missions
 *   are resumable" true rather than a policy that looks alive and never fires.
 * - **Everything commits together** — the row, the terminal event, the
 *   checkpoint settlement, and a durable `postlude:pending` marker. That marker
 *   is what closes "won the race but nothing was ever told": if the in-memory
 *   `onWon` throws, the queue can still be rebuilt from the event log at boot.
 *
 * @param options - `{store, clock, missionId, intent, origin, registry, abort, onWon, logger}`.
 * @returns `{won, reason, status, previousStatus, onWonError}`. When `won` is false, `reason` says why.
 */
export function finalize({
  store,
  clock,
  missionId,
  intent,
  origin,
  registry = null,
  abort = true,
  onWon = null,
  logger = null,
}) {
  if (!FINALIZE_ORIGINS.includes(origin)) {
    throw new Error(`mission runtime: finalize() was called with origin "${origin}". Only ${FINALIZE_ORIGINS.join(", ")} may end a mission — s11 writes its signature and returns an intent, it does not finalize. Add your caller to FINALIZE_ORIGINS only if it is genuinely a sixth termination path.`);
  }
  if (!intent || !TERMINAL_STATUSES.includes(intent.status)) {
    throw new Error(`mission runtime: finalize() needs intent.status in ${TERMINAL_STATUSES.join(" | ")}, received ${JSON.stringify(intent?.status)}.`);
  }
  if (!Number.isInteger(intent.runCount)) {
    throw new Error("mission runtime: finalize() needs intent.runCount. Without the generation, a late finalize from a crashed run can end a rerun that has already started.");
  }
  const needsCode = intent.status === "failed" || intent.status === "quality-failed";
  if (needsCode && !FAILURE_CODES.includes(intent.failureCode)) {
    throw new Error(`mission runtime: a ${intent.status} mission must carry a failure_code from FAILURE_CODES, received ${JSON.stringify(intent.failureCode)}. A failed mission with no code is a failure nobody can classify or learn from.`);
  }

  // BEFORE the write, and unconditionally: losing the race is not a reason to
  // leave the work running.
  if (abort && registry) {
    const reason = intent.abortReason ?? (intent.status === "cancelled" ? "user_cancelled" : "superseded");
    registry.abort(missionId, ABORT_REASONS.includes(reason) ? reason : "superseded", { runCount: intent.runCount });
  }

  const at = clock();
  let previousStatus = null;
  let lostReason = null;

  const won = store.withTx(() => {
    const before = store.getMission(missionId);
    if (!before) {
      lostReason = `no mission row for ${missionId}. Nothing was written.`;
      return false;
    }
    previousStatus = before.status;

    // ONE call, and the store owns everything that has to commit with the row:
    // the conditional UPDATE, the `mission:finalized` event and §5.1's
    // checkpoint settlement. This module used to append its own
    // `mission:finished` and call its own delete/stamp pair beside the store's,
    // so a mission that ended left two terminal events under two names and the
    // "exactly one terminal event" invariant could not be counted at all.
    const claim = store.finalizeMissionRow({
      missionId,
      runCount: intent.runCount,
      status: intent.status,
      failureCode: intent.failureCode ?? null,
      errorMessage: intent.errorMessage ?? (needsCode ? describeFailure(intent.failureCode, intent.detail ?? {}) : null),
      finalScore: intent.finalScore ?? null,
      leaderSigned: intent.leaderSigned ?? null,
      at,
      origin,
      reason: intent.abortReason ?? intent.reason ?? null,
      detail: intent.detail ?? null,
    });

    if (!claim.won) {
      // Say WHICH of the three ways it lost, or the next person debugging this
      // has to reconstruct it from timestamps.
      lostReason = claim.reason === "no-mission"
        ? `no mission row for ${missionId}. Nothing was written.`
        : before.status !== "running"
          ? `the mission was already ${before.status}${before.completedAt ? ` at ${before.completedAt}` : ""}${before.failureCode ? ` (${before.failureCode})` : ""}. The first writer's cause is the true one and was kept.`
          : `this intent is for generation ${intent.runCount} but the row is at generation ${before.runCount}. A newer run owns it.`;
      return false;
    }

    // The durable half of the handoff. If `onWon` throws below, the postlude is
    // still discoverable from the event log rather than lost with the closure.
    store.appendEvent(missionId, {
      at,
      type: "postlude:pending",
      agentId: null,
      payload: { status: intent.status, runCount: intent.runCount },
    });

    return true;
  });

  if (!won) return { won: false, reason: lostReason ?? "unknown", status: intent.status, previousStatus, onWonError: null };

  let onWonError = null;
  if (onWon) {
    try {
      onWon({ missionId, status: intent.status, runCount: intent.runCount, at, intent });
    } catch (error) {
      // Reported, not swallowed: the caller learns that the row is terminal AND
      // that the handoff failed, which are two different facts.
      onWonError = error;
      if (logger?.warn) logger.warn(`mission runtime: onWon threw after ${missionId} reached ${intent.status}: ${error.message}`);
      try {
        store.withTx(() => {
          store.appendEvent(missionId, {
            at: clock(),
            type: "postlude:handoff-failed",
            agentId: null,
            payload: { message: error.message },
          });
        });
      } catch {
        // The terminal write already committed. A failure to record the
        // handoff failure must not undo it, and there is nowhere left to
        // report it to that is more durable than the logger above.
      }
    }
  }

  return { won: true, reason: `won as ${intent.status} from ${origin}`, status: intent.status, previousStatus, onWonError };
}

/* ── checkpoint and resume ─────────────────────────────────────────────── */

/**
 * Whether a mission can be resumed, and when it cannot, exactly why.
 *
 * Five named reasons, one more than §5.4 lists. `reclaim-limit` is the addition:
 * a mission the boot sweep gave up on has a checkpoint that is present, fresh
 * and pipeline-compatible, so every other reason would be a lie, and
 * `no-checkpoint` would send the reader looking for a bug in the checkpoint
 * writer.
 *
 * @param options - `{store, mission, now, stages, resumeWindowMs}`.
 * @returns `{ok, reason, detail}` and, when ok, `{resumeFromStepId, nextIndex, crossState, completedKeys}`.
 */
export function canResume({ store, mission, now, stages = STAGES, resumeWindowMs = DEFAULT_RESUME_WINDOW_MS }) {
  // Every refusal goes through here, so RESUME_REFUSALS is a list the code
  // cannot get out of step with rather than a list somebody has to keep
  // matching by eye. `mission-store.js` used to carry its own second copy,
  // shorter by one member, under a second implementation of this function.
  const refuse = (reason, detail) => {
    if (!RESUME_REFUSALS.includes(reason)) {
      throw new Error(`mission runtime: canResume refused with "${reason}", which is not in RESUME_REFUSALS. Add it there with the next action it implies — an unnamed refusal reaches the user as "resume did nothing", which is indistinguishable from "resume is broken".`);
    }
    return { ok: false, reason, detail };
  };

  if (mission.status === "running") {
    return refuse("wrong-status", "the mission is already running. If it belongs to a dead process, run the boot sweep first.");
  }
  if (!RESUMABLE_FROM_STATUSES.includes(mission.status)) {
    return refuse("wrong-status", `${mission.status} missions are not resumable; only ${RESUMABLE_FROM_STATUSES.join(", ")} are. Re-run fresh instead.`);
  }
  if (mission.runCount >= RECLAIM_LIMIT && mission.failureCode === "runtime_crashed") {
    return refuse("reclaim-limit", `the process has crashed ${mission.runCount} times at ${mission.lastStage ?? "an unnamed stage"}. Resuming again would crash again; re-run fresh or narrow the topic.`);
  }

  const checkpoint = store.getCheckpoint(mission.id);
  if (!checkpoint) {
    return refuse("no-checkpoint", "no snapshot was saved. A mission that failed before its first stage settled has nothing to resume from.");
  }
  if (checkpoint.status === "abandoned") {
    return refuse("reclaim-limit", "the boot sweep abandoned this snapshot after repeated crashes.");
  }

  const ageMs = msOf(now, "now") - msOf(checkpoint.savedAt, "mission_checkpoints.saved_at");
  if (ageMs > resumeWindowMs) {
    return refuse("expired", `the snapshot is ${Math.round(ageMs / 86_400_000)} days old, past the ${Math.round(resumeWindowMs / 86_400_000)}-day window.`);
  }

  const expected = computePipelineHash(stages, mission.depth);
  if (checkpoint.pipelineHash !== expected) {
    return refuse("pipeline-changed", "a stage contract changed since this snapshot was taken. Resuming across it is how a resume silently skips a stage and reports success.");
  }

  // Already parsed by `getCheckpoint`. This used to `JSON.parse` the columns
  // itself, which threw a TypeError out of the resume path instead of returning
  // one of the named refusals the path promises — a failure arriving as a stack
  // trace from a function whose whole contract is "say why, by name".
  const { completedKeys, crossState } = checkpoint;
  if (!Array.isArray(completedKeys)) {
    return refuse("no-checkpoint", "completedKeys is not an array; treating the snapshot as absent rather than resuming from a half-read bag.");
  }

  const { run } = stagesForTier(stages, mission.depth);
  const done = new Set(completedKeys);
  const nextIndex = run.findIndex((stage) => !done.has(stage.id));

  return {
    ok: true,
    reason: "ok",
    detail: nextIndex === -1
      ? "every stage in this tier is already settled; the resume will go straight to the terminal check."
      : `resumes at ${run[nextIndex].id}.`,
    resumeFromStepId: completedKeys.at(-1) ?? null,
    nextIndex: nextIndex === -1 ? run.length : nextIndex,
    completedKeys,
    crossState,
  };
}

/* ── boot: orphans and ownership ───────────────────────────────────────── */

/**
 * Claims process ownership of the library, refusing loudly if another live
 * process already holds it.
 *
 * The boot id answers "is another machine working on this?" for the case that
 * actually exists — one process, restarted. This guards the case it does not
 * cover: two harnesses somehow opened against the same file. Reclaiming another
 * live process's missions would abort work that is genuinely running, so this
 * refuses rather than resolves.
 *
 * @param options - `{store, clock, bootId, pid, isPidLive}` where `isPidLive` is injected (a probe is a side effect).
 * @returns `{claimed, reason, owner}`.
 */
export function claimRuntimeOwner({ store, clock, bootId, pid, isPidLive }) {
  if (typeof isPidLive !== "function") {
    throw new TypeError("mission runtime: claimRuntimeOwner needs an isPidLive(pid) probe. It is injected because process.kill(pid, 0) is a side effect and a test must be able to answer it without one.");
  }
  assertStoreHas(store, ["withTx", "getRuntimeOwner", "putRuntimeOwner"], "claimRuntimeOwner");
  const at = clock();
  const existing = store.getRuntimeOwner() ?? null;

  if (existing && existing.bootId !== bootId && existing.pid !== pid && isPidLive(existing.pid)) {
    return {
      claimed: false,
      reason: `pid ${existing.pid} (boot ${existing.bootId}) is alive and already owns this library. Two harnesses on one file would reclaim each other's missions. Close one, or point this one at a different library file.`,
      owner: existing,
    };
  }

  const owner = { pid, bootId, startedAt: at };
  store.withTx(() => { store.putRuntimeOwner(owner); });
  return { claimed: true, reason: existing ? `took over from a dead owner (pid ${existing.pid})` : "claimed a free library", owner };
}

/**
 * The boot sweep: move every mission left `running` by a dead process out of
 * `running`, and say what happened to each.
 *
 * Every row returned by the orphan query is orphaned BY DEFINITION — no other
 * owner can exist in one process — so there is no threshold, no grace period,
 * no scan loop and zero false positives, and the answer arrives in one
 * synchronous query at startup rather than fifteen to eighteen minutes later.
 * This one column replaces the entire Redis-heartbeat reclamation apparatus.
 *
 * The sweep does NOT auto-resume, and that is deliberate. A plugin process
 * restarts on a settings change and on a harness auto-update, not only on a
 * crash, so a `deep` mission with a 4M-token ceiling would otherwise silently
 * resume, unattended, on every restart. Resume is offered; it is not taken.
 *
 * @param options - `{store, clock, bootId, registry, logger, stages, resumeWindowMs}`.
 * @returns `{swept: [{missionId, outcome, reason}]}` — `outcome` is `resumable` | `abandoned` | `finalize-lost`.
 */
export function sweepOrphans({ store, clock, bootId, registry = null, logger = null, stages = STAGES, resumeWindowMs = DEFAULT_RESUME_WINDOW_MS }) {
  assertStoreHas(store, [...REQUIRED_STORE_METHODS, ...SWEEP_STORE_METHODS], "sweepOrphans");
  const orphans = store.orphans(bootId);
  const swept = [];

  for (const orphan of orphans) {
    const at = clock();
    const overLimit = orphan.runCount >= RECLAIM_LIMIT;

    // The terminal write is `failed` + `runtime_crashed` in both cases, because
    // §4.1's status vocabulary has no `resumable` member and §5.1 is right that
    // adding one is how display bugs are manufactured. What distinguishes
    // "parked, resume offered" from "given up on" is the CHECKPOINT: §5.1's
    // settlement leaves it for `failed`, and above the limit the sweep marks it
    // abandoned so canResume can say `reclaim-limit` instead of lying.
    const result = finalize({
      store,
      clock,
      missionId: orphan.id,
      origin: "lifecycle",
      registry,
      abort: true,
      intent: {
        status: "failed",
        runCount: orphan.runCount,
        failureCode: "runtime_crashed",
        abortReason: "shutdown",
        detail: { stepId: orphan.lastStage, runCount: orphan.runCount, resumeArmed: !overLimit },
        reason: "boot sweep",
      },
      logger,
    });

    if (!result.won) {
      swept.push({ missionId: orphan.id, outcome: "finalize-lost", reason: result.reason });
      continue;
    }

    store.withTx(() => {
      if (overLimit) store.settleCheckpoint(orphan.id, "abandoned", at);
      store.appendEvent(orphan.id, {
        at,
        type: overLimit ? "runtime:reclaim-limit" : "runtime:orphan-reclaimed",
        agentId: null,
        payload: { bootId, previousBootId: orphan.bootId, lastStage: orphan.lastStage, runCount: orphan.runCount },
      });
    });

    if (overLimit) {
      swept.push({
        missionId: orphan.id,
        outcome: "abandoned",
        reason: `crashed ${orphan.runCount} times at ${orphan.lastStage ?? "an unnamed stage"}; resume is no longer offered.`,
      });
      continue;
    }

    const mission = store.getMission(orphan.id);
    const check = canResume({ store, mission, now: at, stages, resumeWindowMs });
    swept.push({
      missionId: orphan.id,
      outcome: check.ok ? "resumable" : "abandoned",
      reason: check.ok
        ? `parked at ${orphan.lastStage ?? "an unnamed stage"}; ${check.detail}`
        : `parked, but not resumable: ${check.reason} — ${check.detail}`,
    });
  }

  return { swept };
}

/* ── stage one: the budget gate ────────────────────────────────────────── */

/**
 * The wall-clock floor a plan implies from its rate limits alone, as a SUM.
 *
 * `max_arxiv × arxivInterval + max_fetch × (fetchInterval + parseP50)`. The
 * second term is the larger one at every tier, and it is wall clock in the
 * strictest sense: jsdom parsing is blocking CPU on the shared event loop, so
 * during it the SSE stream, the hourly collector and the harness UI are all
 * stalled. Revision 1 computed this from arXiv alone and understated the `deep`
 * floor by more than half.
 *
 * `parseP50Ms` is measured, not assumed — it is why phase −1 exists. Passing a
 * guess is allowed; passing nothing is not, because a floor computed without it
 * is the same understatement in a new place.
 *
 * @param options - `{maxArxiv, maxFetch, arxivIntervalMs, fetchIntervalMs, parseP50Ms}`.
 * @returns `{floorMs, arxivMs, fetchMs, terms}`.
 */
export function computeWallFloorMs({ maxArxiv, maxFetch, arxivIntervalMs, fetchIntervalMs, parseP50Ms }) {
  for (const [name, value] of Object.entries({ maxArxiv, maxFetch, arxivIntervalMs, fetchIntervalMs, parseP50Ms })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`mission runtime: computeWallFloorMs needs a non-negative ${name}, received ${JSON.stringify(value)}. parseP50Ms in particular must come from the measured value in settings, not from a guess in this file.`);
    }
  }
  const arxivMs = maxArxiv * arxivIntervalMs;
  const fetchMs = maxFetch * (fetchIntervalMs + parseP50Ms);
  return {
    floorMs: arxivMs + fetchMs,
    arxivMs,
    fetchMs,
    terms: `${maxArxiv} arXiv × ${arxivIntervalMs}ms + ${maxFetch} fetches × (${fetchIntervalMs}ms + ${parseP50Ms}ms parse)`,
  };
}

/**
 * Stage one's gate: does this plan fit its wall clock, and what has work like
 * this actually cost before?
 *
 * Three outcomes, all notifications rather than prompts — in a daemon plugin,
 * unattended is the normal path, so a blocking question reduces to a countdown
 * that almost always expires.
 *
 * FAILS OPEN on an estimator throw. A broken meter must never block work, and
 * the return says the estimate was unavailable rather than reporting a pass it
 * did not compute.
 *
 * This function is the gate only. Resolving the five ceilings is
 * `resolveBudget()`'s job in the budget module and its answer is frozen onto the
 * mission row; nothing here re-resolves a cap.
 *
 * @param options - `{caps, floor, history}` where `history` is `() => {p50, p90, n}` and may throw.
 * @returns `{verdict, refuse, reason, floorMs, estimate}` — verdict is `pass` | `soft` | `hard` | `refused`.
 */
export function budgetGate({ caps, floor, history = null }) {
  if (floor.floorMs > caps.wallMs) {
    return {
      verdict: "refused",
      refuse: true,
      reason: `the rate limits alone need ${Math.round(floor.floorMs / 1000)}s (${floor.terms}) but the wall cap is ${Math.round(caps.wallMs / 1000)}s. This plan cannot fit before a single model call is made. Lower max_arxiv or max_fetch, or raise the wall cap.`,
      floorMs: floor.floorMs,
      estimate: null,
    };
  }

  let estimate = null;
  let estimateError = null;
  if (history) {
    try {
      estimate = history();
    } catch (error) {
      estimateError = error;
    }
  }

  if (!estimate || !Number.isFinite(estimate.p50)) {
    return {
      verdict: "pass",
      refuse: false,
      reason: estimateError
        ? `the cost estimator failed (${estimateError.message}); proceeding, because a broken meter must not block work. The floor is ${Math.round(floor.floorMs / 1000)}s.`
        : `no prior missions at this depth to estimate from. The floor is ${Math.round(floor.floorMs / 1000)}s.`,
      floorMs: floor.floorMs,
      estimate: null,
    };
  }

  // Reported against HISTORY, not against arithmetic on the ceiling the user
  // just picked. Playground's estimate is `credits × 1000 × multiplier`, which
  // can only ever answer whether you can afford your own ceiling.
  const shape = `missions at this depth have cost ${estimate.p50} / ${estimate.p90} tokens (p50 / p90, n = ${estimate.n}); your ceiling is ${caps.maxTokens}`;

  if (estimate.p90 > caps.maxTokens) {
    return { verdict: "hard", refuse: false, reason: `${shape} — nine in ten runs like this would hit the ceiling. Raise it now or expect a partial report.`, floorMs: floor.floorMs, estimate };
  }
  if (estimate.p50 > caps.maxTokens) {
    return { verdict: "soft", refuse: false, reason: `${shape} — the median run would hit the ceiling.`, floorMs: floor.floorMs, estimate };
  }
  return { verdict: "pass", refuse: false, reason: shape, floorMs: floor.floorMs, estimate };
}

/**
 * Writes the twelve `mission_stages` rows, four of them `skipped-by-tier` for
 * `quick`, so the count is invariant and the UI never has to decide whether a
 * missing row means pending or excluded.
 *
 * Idempotent by caller contract: `runMission` calls it only when the mission has
 * no stage rows at all, so a resumed mission never has its progress reset.
 *
 * @param options - `{store, clock, missionId, tier, stages}`.
 * @returns `{opened, skipped}` counts.
 */
export function openStageRows({ store, clock, missionId, tier, stages = STAGES }) {
  const { run, skipped } = stagesForTier(stages, tier);
  const skippedIds = new Set(skipped.map((stage) => stage.id));
  const at = clock();

  // `{stepId, ordinal}` and nothing else. The status is the STORE's to write:
  // `#validateStageRows` calls this module's own `stagesForTier` against the
  // mission's depth, so the tier split is decided once, in one function, for
  // both entry points — `createMission` at open and this one on a rehydrate.
  // Deciding it here as well is what left `markSkippedByTier` with no caller
  // and a quick mission showing four stages that will never run as though they
  // were still queued, with a progress bar that can never reach the end.
  //
  // The ordinal is 1-based and is the LITERAL position in the array, never a
  // shared stage number: playground's s8b shares number 8 with s8, so a
  // checkpoint after s8 lists s8b complete and a resume skips it while
  // reporting success.
  const rows = stages.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1 }));

  store.withTx(() => {
    store.initStages(missionId, rows);
    store.appendEvent(missionId, {
      at,
      type: "stages:opened",
      agentId: null,
      payload: { tier, total: rows.length, running: run.length, skipped: [...skippedIds] },
    });
  });

  return { opened: run.length, skipped: skippedIds.size };
}

/* ── the evidence floor and the one back edge ──────────────────────────── */

/**
 * The arithmetic guard between `s4` and `s5`: is there enough verified evidence
 * to justify writing anything at all?
 *
 * Revision 1 keyed the abort on dimension STATE, so eight honestly-empty
 * dimensions meant zero failed, nothing degraded, and nine thousand words
 * written on nothing. A dimension can complete honestly with zero findings —
 * the researcher's escape hatch is designed to produce exactly that rather than
 * deadlock — so the guard has to count evidence, not states.
 *
 * Run for EVERY tier, not only where `s5` exists. `quick` skips `s5`, and a
 * `quick` mission that wrote 3,000 words on nothing would be the same failure
 * with a smaller word count.
 *
 * @param options - `{store, mission}`.
 * @returns `{outcome, verified, floorSum, ratio, why}` — outcome is `none` | `thin` | `ok`.
 */
export function evidenceFloorGate({ store, mission }) {
  const verified = store.distinctVerifiedPairs(mission.id, { runCount: mission.runCount });
  const floorSum = store.sumDerivedFloors(mission.id, { runCount: mission.runCount });

  if (verified === 0) {
    return {
      outcome: "none",
      verified,
      floorSum,
      ratio: 0,
      why: "no dimension produced a single finding whose quote verified against a contiguous span of a page we fetched. 'We looked and found nothing verifiable' is a useful answer; an essay dressed as one is not.",
    };
  }
  if (floorSum <= 0) {
    return {
      outcome: "ok",
      verified,
      floorSum,
      ratio: null,
      why: `${verified} verified findings, but no derived floor was written for this run, so the thin-evidence ratio cannot be computed. s3 must write missions.derived_floor before s4 settles.`,
    };
  }

  const ratio = verified / floorSum;
  if (ratio < THIN_EVIDENCE_RATIO) {
    return {
      outcome: "thin",
      verified,
      floorSum,
      ratio,
      why: `${verified} verified findings against a summed derived floor of ${floorSum} (${Math.round(ratio * 100)}%, under the ${Math.round(THIN_EVIDENCE_RATIO * 100)}% bar). The mission continues at degrade level 1.`,
    };
  }
  return { outcome: "ok", verified, floorSum, ratio, why: `${verified} verified findings against a floor of ${floorSum}.` };
}

/**
 * Whether `s4` may jump back to `s3` for one more collection round.
 *
 * Three of the four terminating conditions are checked here; the fourth —
 * distinct verified evidence must strictly increase — can only be measured
 * after the round runs, and is `recordRecollectOutcome`'s job.
 *
 * The round counter is `missions.patch_round`, a column written in the same
 * synchronous transaction as the stage output. In playground the same counter
 * lives on a context object the hook builder rebuilds on every call and never
 * copies back, so it is always 0 on entry and its own round cap is unreachable
 * dead code.
 *
 * @param options - `{store, mission, stage, now, budget}`.
 * @returns `{allowed, reason, baseline, detail}`. `reason` says why on both paths.
 */
export function evaluateBackEdge({ store, mission, stage, now, budget = null }) {
  if (stage.dag.backEdge === null) {
    return { allowed: false, reason: "no-back-edge", baseline: null, detail: `${stage.id} declares no back edge; a "next" from it is a stage-contract bug.` };
  }
  if (mission.patchRound >= MAX_PATCH_ROUNDS) {
    return { allowed: false, reason: "patch-round-exhausted", baseline: null, detail: `patch_round is ${mission.patchRound} of a maximum ${MAX_PATCH_ROUNDS}. The mission continues forward with what it has.` };
  }

  const deadlines = checkDeadlines({ mission, now, budget });
  if (deadlines.expired) {
    return {
      allowed: false,
      reason: deadlines.reason === "budget_exhausted" ? "budget-exhausted" : "wall-time-exceeded",
      baseline: null,
      detail: `a second collection round cannot be afforded: ${JSON.stringify(deadlines.detail)}.`,
    };
  }

  return {
    allowed: true,
    reason: "ok",
    // Recorded BEFORE the round so the improvement test has something to
    // compare against. Recollect APPENDS into a new attempt generation and the
    // union is kept, so this counts distinct (source_host, claim_hash) pairs:
    // same-source rephrasings from a re-search must not read as improvement.
    baseline: store.distinctVerifiedPairs(mission.id, { runCount: mission.runCount }),
    detail: `round ${mission.patchRound + 1} of ${MAX_PATCH_ROUNDS}, with ${Math.round(deadlines.detail.remainingMs / 1000)}s of wall clock left.`,
  };
}

/**
 * Did the recollect round actually add distinct verified evidence?
 *
 * The union of attempts is compared on distinct `(source_host, claim_hash)`
 * pairs at `verified-source-text`. Appending without this test makes
 * near-duplicate findings from a re-search inflate the count, so the "must
 * strictly increase" condition is always satisfied and only the round cap ever
 * terminates the loop.
 *
 * @param options - `{store, mission, baseline}`.
 * @returns `{gained, baseline, after, note}` — `note` is written into `s4`'s degrade_note when nothing was gained.
 */
export function recordRecollectOutcome({ store, mission, baseline }) {
  const after = store.distinctVerifiedPairs(mission.id, { runCount: mission.runCount });
  const gained = after > baseline;
  return {
    gained,
    baseline,
    after,
    note: gained
      ? null
      : `the recollect round added no distinct verified evidence (${baseline} → ${after} distinct source/claim pairs). The second search found the same sources again.`,
  };
}

/* ── the stage return contract ─────────────────────────────────────────── */

/**
 * Checks a stage's return value against the contract, returning the violation
 * as a sentence or null.
 *
 * `degraded` is a REQUIRED field. Revision 1 made `markStageDegraded` a hard
 * invariant policed by "a reviewer greps for it", which is the same class of
 * thing this design exists to eliminate. Inverting it costs nothing: a stage
 * that swallowed something and continued has to write `degraded: false`
 * explicitly — an assertion somebody can be wrong about on purpose, rather than
 * an omission nobody can see. "Half the dimensions missing, mission looks fine"
 * is what the omission looks like from outside.
 *
 * @param stage - the stage declaration.
 * @param result - whatever the handler returned.
 * @returns a violation sentence, or null when the return is well formed.
 */
export function checkStageReturn(stage, result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return `${stage.id} returned ${Array.isArray(result) ? "an array" : typeof result} instead of an object. Return {output, degraded}.`;
  }
  if (!Object.hasOwn(result, "output")) {
    return `${stage.id} returned no "output" field. Return {output: null, degraded: false} if there is genuinely nothing to hand on.`;
  }
  if (typeof result.degraded !== "boolean") {
    return `${stage.id} returned no boolean "degraded" field. It is required, not optional: a stage that caught something and continued must say so, and a stage that did not must write degraded: false rather than leaving it out.`;
  }
  if (result.degraded === true && (typeof result.degradeNote !== "string" || result.degradeNote.trim() === "")) {
    return `${stage.id} returned degraded: true with no degradeNote. A degradation with no reason is invisible in the one place a person looks.`;
  }
  if (Object.hasOwn(result, "next") && result.next !== null && result.next !== stage.dag.backEdge) {
    return `${stage.id} asked to jump to "${result.next}", but its declared backEdge is ${stage.dag.backEdge === null ? "null" : `"${stage.dag.backEdge}"`}. Only a declared back edge may be taken.`;
  }
  if (Object.hasOwn(result, "terminalIntent") && result.terminalIntent && stage.mode !== "persist") {
    return `${stage.id} returned a terminalIntent but its mode is "${stage.mode}". Only the persist stage may end a mission — s11 writes its signature to the mission row and returns an intent, so that s12's arbitrated write is the one that runs.`;
  }
  if (Object.hasOwn(result, "crossPatch") && result.crossPatch !== null && (typeof result.crossPatch !== "object" || Array.isArray(result.crossPatch))) {
    return `${stage.id} returned a crossPatch that is not a plain object.`;
  }
  return null;
}

/**
 * Checks that stage one produced the frozen caps and the gate verdict every
 * later stage reads.
 *
 * Budget is stage one, and this is what makes that structural rather than
 * documentary: without these fields the pipeline would run to completion
 * against caps nobody resolved, which is exactly how playground's rerun fell
 * back to a two-dollar default and died instantly.
 *
 * @param output - stage one's output.
 * @returns a violation sentence, or null.
 */
function checkGateOutput(output) {
  if (!output || typeof output !== "object") return "s1-brief produced no output. It must return {caps, gate, contextPlan}.";
  if (!output.caps || typeof output.caps !== "object") return "s1-brief produced no `caps`. The five ceilings are resolved once, here, and read from the mission row thereafter.";
  if (!output.gate || typeof output.gate.verdict !== "string") return "s1-brief produced no `gate.verdict`. The gate's three outcomes are what the mission is allowed to start on.";
  if (output.gate.verdict === "refused") return `s1-brief refused the plan but the mission was started anyway: ${output.gate.reason ?? "no reason given"}. A refused plan must never reach s2.`;
  return null;
}

/* ── the runner ────────────────────────────────────────────────────────── */

/**
 * Runs one mission through its stages, one at a time, checkpointing after each.
 *
 * Every database write below is synchronous and inside `store.withTx`, and no
 * `await` appears between a `withTx(` and its closing brace: on one shared
 * connection an `await` inside a transaction lets the hourly collector's
 * inserts execute inside the mission's transaction, where a rollback discards
 * them. The pattern throughout is: await the stage, then commit its settled
 * result.
 *
 * The runner never ends a mission except through `finalize`, and it never
 * returns success it has not verified — the summary carries the terminal
 * outcome including which writer won, or says that nobody wrote one.
 *
 * @param options - `{store, clock, bootId, missionId, handlers, registry, budget, stages, logger, resumeWindowMs, onWon}`.
 * @returns `{ok, missionId, runCount, dispatched, completed, skipped, stoppedAt, reason, terminal}`.
 */
export async function runMission({
  store,
  clock,
  bootId,
  missionId,
  handlers,
  registry,
  budget = null,
  stages = STAGES,
  logger = null,
  resumeWindowMs = DEFAULT_RESUME_WINDOW_MS,
  onWon = null,
}) {
  /* ── entry guards. Every one of these fails BEFORE a row is touched. ── */

  if (typeof clock !== "function") {
    throw new TypeError("mission runtime: runMission needs clock(), a function returning an ISO 8601 string. Time is a parameter here so a wall-clock test does not have to wait.");
  }
  assertStoreHas(store, REQUIRED_STORE_METHODS, "runMission");

  const mission = store.getMission(missionId);
  if (!mission) {
    return summary({ ok: false, missionId, runCount: null, reason: `no mission row for ${missionId}. Nothing was run.` });
  }
  if (mission.status !== "running") {
    return summary({ ok: false, missionId, runCount: mission.runCount, reason: `the mission is ${mission.status}, not running. Claim it first — rerun and resume both go through the atomic claim, which is what stops two clicks 100ms apart from both starting it.` });
  }
  if (mission.bootId !== bootId) {
    return summary({ ok: false, missionId, runCount: mission.runCount, reason: `the row is owned by boot ${mission.bootId ?? "(none)"}, not ${bootId}. A mission left running by a dead process belongs to the boot sweep; running it here would fork reality between two owners.` });
  }

  // A re-claimed mission must carry `last_reopened_at`. Without it the wall
  // clock is measured from the ORIGINAL start, so a mission resumed an hour
  // later dies in its first stage against a twenty-minute cap, that run's own
  // terminal write then loses the conditional-write race, and the user reads it
  // as "my rerun broke". Refusing here names the column; the alternative is a
  // `wall_time_exceeded` that is technically true and completely useless.
  if (mission.runCount > 1 && !mission.lastReopenedAt) {
    return summary({
      ok: false,
      missionId,
      runCount: mission.runCount,
      reason: `this is generation ${mission.runCount} but missions.last_reopened_at is null. Whatever re-claimed this row must stamp it in the same UPDATE that sets status='running', or the wall clock runs from ${mission.startedAt} and this run is killed against a cap it never had.`,
    });
  }

  const tier = mission.depth;
  const { run: plan, skipped } = stagesForTier(stages, tier);

  const missingHandlers = plan.filter((stage) => typeof handlers?.[stage.id] !== "function").map((stage) => stage.id);
  if (missingHandlers.length > 0) {
    // Fails here, before any write, rather than at stage nine of a three-hour
    // deep mission.
    throw new TypeError(`mission runtime: no handler for ${missingHandlers.join(", ")}. Every stage this tier runs needs one.`);
  }

  /* ── open or rehydrate ─────────────────────────────────────────────── */

  let stageRows = store.listStages(missionId);
  if (stageRows.length === 0) {
    openStageRows({ store, clock, missionId, tier, stages });
    stageRows = store.listStages(missionId);
  }

  // `row.stepId`, the store's key. Read as `row.step_id` this set held exactly
  // one member — `undefined` — so `plan.findIndex(stage => !settled.has(...))`
  // answered 0 for every mission and every resume restarted from stage one,
  // re-running and re-paying for everything that had already finished while
  // reporting itself as a resume.
  //
  // Restricted to THIS TIER's stages. `skipped-by-tier` is a settled status —
  // correctly, since such a stage will never be dispatched — but the four rows
  // a quick mission skips are not stages this run completed, and letting them
  // into `settled` puts them into `completedKeys` and therefore into the
  // checkpoint. A snapshot listing `s5-reconcile` as completed is a snapshot a
  // resume at `standard` would skip `s5` from, which is the silent-skip failure
  // the whole checkpoint design exists to prevent.
  const planIds = new Set(plan.map((stage) => stage.id));
  const statusByStep = new Map(stageRows.map((row) => [row.stepId, row.status]));
  const settled = new Set(stageRows
    .filter((row) => planIds.has(row.stepId) && SETTLED_STAGE_STATUSES.includes(row.status))
    .map((row) => row.stepId));

  let startIndex = plan.findIndex((stage) => !settled.has(stage.id));
  if (startIndex === -1) startIndex = plan.length;

  // Budget is stage one, and this is where that stops being documentary.
  //
  // The obvious guard — "resuming past index 0 means the gate must have
  // settled" — cannot ever fire: the gate runs in every tier, so it is always
  // plan[0], and `startIndex > 0` therefore already implies it settled. That is
  // the same unreachable-dead-code shape as playground's MAX_S4_ROUNDS, and it
  // was in this file until a test asked it to fire.
  //
  // The reachable question is the opposite one: did anything run WITHOUT the
  // gate? Rows saying s2..s12 finished while the gate is still pending mean
  // either the caps were never frozen, or the gate's write was rolled back
  // underneath stages that had already read them. Both are states to refuse,
  // not to resume into.
  const gateStage = stages[0];
  const ranWithoutGate = plan.filter((stage) => stage.id !== gateStage.id && settled.has(stage.id));
  if (!settled.has(gateStage.id) && ranWithoutGate.length > 0) {
    return summary({
      ok: false,
      missionId,
      runCount: mission.runCount,
      reason: `${ranWithoutGate.map((stage) => stage.id).join(", ")} settled while ${gateStage.id} is "${statusByStep.get(gateStage.id) ?? "missing"}". The budget gate is stage one and every later stage reads the caps it froze, so those stages ran against caps nobody resolved. Re-run this mission fresh rather than resuming into it.`,
    });
  }

  const pipelineHash = computePipelineHash(stages, tier);
  let crossState = {};
  // In PLAN order, not set-insertion order: the snapshot's own `.at(-1)` is
  // reported as the stage a resume picks up after, and a list ordered by
  // whatever the rows came back in makes that a different stage on a re-read.
  const completedKeys = plan.filter((stage) => settled.has(stage.id)).map((stage) => stage.id);

  const checkpoint = store.getCheckpoint(missionId);
  if (checkpoint) {
    const check = canResume({ store, mission: { ...mission, status: "failed" }, now: clock(), stages, resumeWindowMs });
    if (check.ok) {
      crossState = check.crossState ?? {};
      // "Stage marked complete but checkpoint missing" is supposed to be
      // structurally impossible — the two are written in one transaction. A
      // claim like that deserves a check rather than a comment: if the two ever
      // disagree, the stage rows win (they are what the UI renders) and the
      // divergence is recorded so it is discoverable instead of invisible.
      const fromCheckpoint = new Set(check.completedKeys);
      const disagreement = [...settled].filter((id) => !fromCheckpoint.has(id))
        .concat([...fromCheckpoint].filter((id) => !settled.has(id)));
      if (disagreement.length > 0) {
        store.withTx(() => {
          store.appendEvent(missionId, {
            at: clock(),
            type: "checkpoint:divergence",
            agentId: null,
            payload: { onlyInRows: [...settled].filter((id) => !fromCheckpoint.has(id)), onlyInCheckpoint: [...fromCheckpoint].filter((id) => !settled.has(id)) },
          });
        });
      }
    } else if (check.reason !== "wrong-status") {
      // The snapshot is unusable, but the stage rows still say what finished.
      // Resuming from the rows without the cross-state bag is worse than
      // refusing, because a stage whose upstream in-memory state is gone fails
      // a downstream gate for a structural reason unrelated to the work.
      return summary({ ok: false, missionId, runCount: mission.runCount, reason: `the checkpoint cannot be used (${check.reason}: ${check.detail}), so the inter-stage state a resumed stage needs is not available. Re-run fresh.` });
    }
  }

  /* ── claim the run in memory ───────────────────────────────────────── */

  const openedAt = clock();
  const { entry, displaced } = registry.register({ missionId, runCount: mission.runCount, now: openedAt });
  if (displaced) {
    if (logger?.warn) logger.warn(`mission runtime: ${missionId} was already registered for generation ${displaced.runCount}; the re-entry guard should have refused this. Aborting the displaced entry so it cannot keep spending.`);
    if (!displaced.controller.signal.aborted) displaced.controller.abort("superseded");
  }
  const signal = entry.controller.signal;

  /**
   * Appends an event and, for a business one, stamps in-memory progress.
   *
   * The event's CLASS is not passed: `appendEvent` reads it out of EVENT_TYPES
   * and throws on a type nobody registered, so there is one registry rather
   * than a lookup here and a hard-coded class at each of the store's own append
   * sites. `last_progress_at` is stamped by the same insert, in the same
   * transaction as the event that earned it — this used to call `touchMission`
   * alongside, which was a second writer of the one liveness column.
   */
  const emit = (type, payload, agentId = null, at = clock()) => {
    store.appendEvent(missionId, { at, type, agentId, stepId: entry.stepId, payload });
    if (EVENT_TYPES[type] === "business") registry.markProgress(missionId, at);
  };

  const completed = [];
  let index = startIndex;
  let stopped = null;
  let terminal = null;
  let current = store.getMission(missionId);
  let recollect = null;

  // A loop that can jump backwards needs a counter that is not on an object
  // rebuilt per call. `patch_round` is that counter and it is persisted; this
  // one is belt and braces against a stage handler returning `next` in a way
  // the round cap somehow does not catch, and it costs three lines.
  const maxDispatches = plan.length + MAX_PATCH_ROUNDS * plan.length + 2;
  let dispatched = 0;

  try {
    if (startIndex > 0) {
      store.withTx(() => { emit("mission:resumed", { fromIndex: startIndex, stepId: plan[startIndex]?.id ?? null, runCount: current.runCount }); });
    }

    while (index < plan.length) {
      const stage = plan[index];

      if (dispatched >= maxDispatches) {
        stopped = { kind: "guard", reason: `the runner dispatched ${dispatched} stages for a ${plan.length}-stage pipeline. Something is returning a back edge the round cap is not catching.` };
        terminal = endMission({ code: "stage_contract_violation", status: "failed", detail: { stepId: stage.id, detail: stopped.reason } });
        break;
      }

      if (signal.aborted) {
        stopped = { kind: "abort", reason: `aborted before ${stage.id} with reason "${signal.reason}"` };
        // The guard's own detail first, this stage's id after it: the stage is
        // where the guard says it tripped when it says nothing else.
        terminal = endMission({ fromSignal: true, detail: { stepId: stage.id, ...(registry.detailOf?.(missionId) ?? {}) } });
        break;
      }

      current = store.getMission(missionId);
      if (!current || current.status !== "running") {
        // Somebody else won the terminal race — the wall timer, the budget
        // pool, or a cancel. Stop, and do not write over their cause.
        stopped = { kind: "lost", reason: `the mission row is now ${current ? current.status : "missing"}; another writer ended it first and its cause is the true one.` };
        break;
      }

      const deadlines = checkDeadlines({ mission: current, now: clock(), budget, stage });
      if (deadlines.expired) {
        registry.abort(missionId, deadlines.reason, { runCount: current.runCount });
        stopped = { kind: "deadline", reason: deadlines.reason };
        terminal = endMission({ fromSignal: true, detail: { stepId: stage.id, ...deadlines.detail, resumable: true } });
        break;
      }

      /* ── dispatch ─────────────────────────────────────────────────── */

      const startedAt = clock();
      registry.setStage(missionId, stage, startedAt);

      // `startStage` returns the attempt number and appends `stage:started`
      // itself, in the same transaction as the row it stamps. The runner used
      // to recompute the attempt from the stage rows AND emit its own
      // `stage:started` beside the store's, so every dispatch wrote the event
      // twice under one name and the two counters were free to disagree.
      const attempt = store.withTx(() => store.startStage(missionId, stage.id, startedAt, {
        agentId: stage.agent,
        payload: { stepId: stage.id, ordinal: index, agent: stage.agent },
      }));
      if (attempt === null) {
        // `null` means there is no `mission_stages` row for this step, so
        // `finishStage` will not find one either and would settle NOTHING while
        // returning normally — the stage would run, spend, and leave no trace,
        // and the checkpoint that rides on the same call would never be written.
        // The row count is supposed to be invariant at twelve; refuse rather
        // than run into a state where success and silence look identical.
        stopped = { kind: "contract", reason: `${stage.id} has no mission_stages row, so nothing this stage does could be recorded. The twelve rows are written at open and the count is invariant; a missing one means the row set was edited underneath the run.` };
        terminal = endMission({ code: "stage_contract_violation", status: "failed", detail: { stepId: stage.id, detail: stopped.reason } });
        break;
      }
      registry.markProgress(missionId, startedAt);

      // THE SEAM. Everything from here down writes rather than collects, and
      // `s5-reconcile` is the first stage no back edge reaches — `s4-assess`
      // can send the run back to `s3-collect`, so releasing any earlier would
      // hand the reserve to the phase it is being held back from.
      //
      // Measured on a real quick-tier mission before this existed: collection
      // drained the call pool inside `s3-collect`, `s8-write` opened with
      // nothing left, and twelve verified findings produced no words at all.
      if (WRITING_STAGES.has(stage.id)) {
        const released = budget?.enterWriting?.();
        // A log line rather than an event: EVENT_TYPES is a closed vocabulary
        // and `#appendEventRow` throws on a member it does not carry, so an
        // unregistered type here would take the mission down at the seam. A
        // `registry.note?.()` would have been worse — a silent no-op that reads
        // like it records something.
        if (released?.released === true && logger?.info) {
          logger.info(`mission ${missionId}: ${stage.id} released the writing reserve on ${released.dimensions.join(", ")}`);
        }
      }

      let result;
      try {
        // The one await in the loop, and it is deliberately outside every
        // transaction above and below it.
        result = await handlers[stage.id]({
          missionId,
          runCount: current.runCount,
          mission: current,
          tier,
          stage,
          attempt,
          signal,
          crossState,
          budget,
          now: clock,
          emit: (type, payload, agentId = null) => { store.withTx(() => { emit(type, payload, agentId); }); },
          logger,
        });
      } catch (error) {
        const failedAt = clock();
        store.withTx(() => {
          store.finishStage(missionId, stage.id, {
            status: "failed",
            at: failedAt,
            output: null,
            degradeNote: null,
            tokens: result?.tokens ?? 0,
            agentId: stage.agent,
            payload: { stepId: stage.id, message: error.message, name: error.name },
          });
        });
        stopped = { kind: "throw", reason: `${stage.id} threw: ${error.message}` };
        terminal = endMission({ fromSignal: signal.aborted, error, detail: { stepId: stage.id } });
        break;
      }

      /* ── contract ─────────────────────────────────────────────────── */

      let violation = checkStageReturn(stage, result);
      if (!violation && stage.mode === "gate") violation = checkGateOutput(result.output);
      if (violation) {
        const failedAt = clock();
        store.withTx(() => {
          store.finishStage(missionId, stage.id, {
            status: "failed",
            at: failedAt,
            output: null,
            degradeNote: null,
            tokens: 0,
            agentId: stage.agent,
            payload: { stepId: stage.id, violation },
          });
        });
        stopped = { kind: "contract", reason: violation };
        terminal = endMission({ code: "stage_contract_violation", status: "failed", detail: { stepId: stage.id, detail: violation } });
        break;
      }

      /* ── gates that run between stages ────────────────────────────── */

      let degraded = result.degraded;
      let degradeNote = result.degradeNote ?? null;
      let evidence = null;

      // Fold the recollect verdict into the second pass of s4 rather than
      // logging it somewhere nobody reads.
      if (recollect && stage.id === recollect.stepId) {
        const outcome = recordRecollectOutcome({ store, mission: current, baseline: recollect.baseline });
        store.withTx(() => { emit(outcome.gained ? "recollect:allowed" : "recollect:no-gain", outcome); });
        if (!outcome.gained) {
          degraded = true;
          degradeNote = degradeNote ? `${degradeNote} ${outcome.note}` : outcome.note;
        }
        recollect = null;
      }

      if (stage.dag.backEdge === "s3-collect") {
        evidence = evidenceFloorGate({ store, mission: current });
        if (evidence.outcome === "none") {
          store.withTx(() => { emit("evidence:none", { ...evidence, diagnostics: safeDiagnostics(store, current, logger) }); });
          store.withTx(() => {
            store.finishStage(missionId, stage.id, {
              status: "degraded",
              at: clock(),
              // The VALUE, not a JSON transcript of it. `finishStage` runs the
              // output through `jsonOrNull` itself; stringifying here as well
              // stored a quoted string, so `stageOutput` handed the resume a
              // transcript where the rehydrated object belonged.
              output: result.output ?? null,
              degradeNote: evidence.why,
              tokens: result.tokens ?? 0,
              agentId: stage.agent,
              payload: { stepId: stage.id, evidence },
            });
          });
          stopped = { kind: "evidence", reason: evidence.why };
          // quality-failed, not failed: the work happened, the brief exists and
          // can be read, and "we looked and found nothing verifiable" is a
          // useful and cheap answer.
          terminal = endMission({
            code: "no_evidence",
            status: "quality-failed",
            detail: { emptyDimensions: evidence.floorSum, totalDimensions: evidence.floorSum, ...evidence },
          });
          break;
        }
        if (evidence.outcome === "thin") {
          degraded = true;
          degradeNote = degradeNote ? `${degradeNote} ${evidence.why}` : evidence.why;
          crossState = { ...crossState, degradeLevel: Math.max(1, crossState.degradeLevel ?? 0) };
        }
      }

      /* ── settle, checkpoint, and say so ───────────────────────────── */

      const endedAt = clock();
      // No `durationMs` computed here any more: `finishStage` measures it from
      // the row's own `started_at` and puts it in the event payload. Two
      // subtractions of one interval is how "which stage ate the clock" gets
      // two answers.
      if (result.crossPatch) crossState = { ...crossState, ...result.crossPatch };
      if (stage.mode === "gate") crossState = { ...crossState, caps: result.output.caps, gate: result.output.gate, contextPlan: result.output.contextPlan ?? null };
      completedKeys.push(stage.id);

      store.withTx(() => {
        // `finishStage` settles the row, emits the one terminal stage event
        // (`stage:done` or `stage:degraded`, chosen from the status) and saves
        // the checkpoint — all inside the transaction it opens. Handing it the
        // checkpoint rather than writing one afterwards is what makes "stage
        // marked complete but checkpoint missing" structurally impossible
        // rather than merely unlikely; a synchronous local write costs
        // microseconds, so every stage is a resume point instead of
        // playground's three milestones.
        //
        // `completedKeys` and `crossState` go over as an ARRAY and an OBJECT.
        // Pre-stringified, `saveCheckpoint` threw — and because the throw
        // happened inside this transaction it did not merely lose the
        // checkpoint, it rolled back the settled stage with it.
        store.finishStage(missionId, stage.id, {
          status: degraded ? "degraded" : "done",
          at: endedAt,
          output: result.output ?? null,
          degradeNote,
          tokens: result.tokens ?? 0,
          agentId: stage.agent,
          payload: { stepId: stage.id, ordinal: index, degradeNote, evidence },
          checkpoint: {
            at: endedAt,
            completedKeys,
            crossState,
            pipelineHash,
            status: "running",
          },
        });
        registry.markProgress(missionId, endedAt);
        if (evidence && evidence.outcome === "thin") emit("evidence:thin", evidence, null, endedAt);
        if (stage.mode === "gate" && result.output.gate.verdict !== "pass") {
          emit(result.output.gate.verdict === "hard" ? "gate:hard-warning" : "gate:soft-warning", result.output.gate, null, endedAt);
        } else if (stage.mode === "gate") {
          emit("gate:passed", result.output.gate, null, endedAt);
        }
      });

      completed.push(stage.id);
      dispatched += 1;
      registry.setStage(missionId, null, endedAt);
      stageRows = store.listStages(missionId);
      statusByStep.set(stage.id, degraded ? "degraded" : "done");
      current = store.getMission(missionId);

      /* ── terminal intent, back edge, or forward ───────────────────── */

      if (stage.mode === "persist" && result.terminalIntent) {
        terminal = finalize({
          store,
          clock,
          missionId,
          origin: "s12-persist",
          registry,
          abort: true,
          onWon,
          logger,
          intent: { runCount: current.runCount, ...result.terminalIntent },
        });
        stopped = { kind: "terminal", reason: terminal.reason };
        break;
      }

      if (result.next) {
        const verdict = evaluateBackEdge({ store, mission: current, stage, now: clock(), budget });
        store.withTx(() => { emit(verdict.allowed ? "recollect:allowed" : "recollect:refused", { from: stage.id, to: stage.dag.backEdge, ...verdict }); });
        if (verdict.allowed) {
          const at = clock();
          // `bumpPatchRound` increments and returns the new round in ONE
          // statement, so no caller can decide the loop is over from a value it
          // read before somebody else incremented. The runner used to read the
          // round, add one and write it back, which is that race spelled out.
          store.withTx(() => { store.bumpPatchRound(missionId, at); });
          current = store.getMission(missionId);
          recollect = { baseline: verdict.baseline, stepId: stage.id };
          index = plan.findIndex((candidate) => candidate.id === stage.dag.backEdge);
          continue;
        }
        // Refused, and the reason is on the record. The mission goes forward
        // with what it has rather than silently doing nothing.
      }

      index += 1;
    }

    /* ── the pipeline ended without anybody writing a terminal state ── */

    if (!stopped && !terminal) {
      const after = store.getMission(missionId);
      if (after && after.status === "running") {
        // A silent return at the persist stage is how playground produced a
        // fake completion: the default success path took over and the mission
        // reported completed with no signature behind it.
        stopped = { kind: "no-terminal", reason: `every stage settled but ${stages.at(-1).id} wrote no terminal state. The mission is not complete and will not be reported as such.` };
        terminal = endMission({ code: "stage_contract_violation", status: "failed", detail: { stepId: stages.at(-1).id, detail: stopped.reason } });
      } else {
        stopped = { kind: "terminal", reason: `the mission is ${after ? after.status : "gone"}; a terminal write landed outside this loop.` };
      }
    }
  } finally {
    registry.setStage(missionId, null, clock());
    registry.release(missionId, mission.runCount);
  }

  return summary({
    ok: Boolean(terminal?.won) && terminal.status === "completed",
    missionId,
    runCount: current?.runCount ?? mission.runCount,
    dispatched,
    completed,
    skipped: skipped.map((stage) => stage.id),
    stoppedAt: plan[index]?.id ?? null,
    reason: stopped?.reason ?? "ran to the end of the pipeline",
    terminal,
  });

  /**
   * Ends the mission through the one arbitrated write, classifying first.
   *
   * @param options - `{fromSignal, error, code, status, detail}`.
   * @returns finalize's result.
   */
  function endMission({ fromSignal = false, error = null, code = null, status = null, detail = {} }) {
    const classified = code
      ? { status: status ?? "failed", code, message: describeFailure(code, detail) }
      : classifyFailure({ signal: fromSignal ? signal : null, error, detail });

    return finalize({
      store,
      clock,
      missionId,
      origin: "mission-runtime",
      registry,
      abort: true,
      onWon,
      logger,
      intent: {
        status: classified.status,
        runCount: current?.runCount ?? mission.runCount,
        failureCode: classified.status === "completed" || classified.status === "cancelled" ? null : classified.code,
        errorMessage: classified.message,
        abortReason: fromSignal && typeof signal.reason === "string" ? signal.reason : null,
        detail,
      },
    });
  }
}

/**
 * Reads the collection diagnostics without letting a reporting query take down
 * the failure path.
 *
 * The `no_evidence` brief is worth having and is not worth failing for: a throw
 * here would leave the mission at `running` for the sake of a nicer message.
 *
 * @param store - the mission store.
 * @param mission - the mission row.
 * @param logger - optional.
 * @returns the diagnostics object, or a note saying it was unavailable.
 */
function safeDiagnostics(store, mission, logger) {
  try {
    return store.collectionDiagnostics(mission.id, { runCount: mission.runCount });
  } catch (error) {
    if (logger?.warn) logger.warn(`mission runtime: collectionDiagnostics threw (${error.message}); the no-evidence brief will be written without it.`);
    return { unavailable: error.message };
  }
}

/**
 * Normalises the runner's return value so every exit path carries the same
 * fields. A caller that has to check which shape it got is a caller that will
 * check for the wrong one.
 *
 * @param fields - partial summary fields.
 * @returns the full summary.
 */
function summary(fields) {
  return {
    ok: false,
    missionId: null,
    runCount: null,
    dispatched: 0,
    completed: [],
    skipped: [],
    stoppedAt: null,
    reason: "no reason given",
    terminal: null,
    ...fields,
  };
}

/* ── boot assertions ───────────────────────────────────────────────────── */

/**
 * Asserts the vocabularies are total and consistent with each other.
 *
 * §5.1 makes this a boot assertion for the status mapping; the same argument
 * applies to every other list in this file. A mapping with a hole does not fail
 * loudly — it falls through to a default, and the default is what produced a
 * cancel button that stayed lit and 400'd for ever.
 *
 * @returns true. Throws otherwise.
 */
export function assertRuntimeVocabularies() {
  for (const reason of ABORT_REASONS) {
    if (!ABORT_REASON_TO_FAILURE[reason]) {
      throw new Error(`mission runtime: abort reason "${reason}" has no failure code. Add it to ABORT_REASON_TO_FAILURE, or it classifies as a provider error and tells the user to check a provider that was never involved.`);
    }
    if (!FAILURE_CODES.includes(ABORT_REASON_TO_FAILURE[reason])) {
      throw new Error(`mission runtime: abort reason "${reason}" maps to failure code "${ABORT_REASON_TO_FAILURE[reason]}", which is not in FAILURE_CODES.`);
    }
    if (!MISSION_STATUSES.includes(ABORT_REASON_TO_STATUS[reason])) {
      throw new Error(`mission runtime: abort reason "${reason}" maps to status "${ABORT_REASON_TO_STATUS[reason]}", which is not in MISSION_STATUSES.`);
    }
  }
  for (const code of FAILURE_CODES) {
    if (typeof FAILURE_SENTENCES[code] !== "function") {
      throw new Error(`mission runtime: failure code "${code}" has no sentence. A code with no description reaches the user as a bare string with no action in it.`);
    }
  }
  for (const status of RESUMABLE_STATUSES) {
    if (!TERMINAL_STATUSES.includes(status)) {
      throw new Error(`mission runtime: "${status}" is listed as resumable but is not terminal.`);
    }
    if (status === "completed" || status === "cancelled") {
      // `settleCheckpoint` reads THIS list to decide stamp-vs-delete, so a
      // member here that it deletes for would be a mission `canResume` offers
      // and whose snapshot is already gone: a rerun killed in its first second
      // with zero output.
      throw new Error(`mission runtime: "${status}" is listed as resumable, but a ${status} mission's snapshot is deleted at settlement. Those two decisions drifting apart is what kills a rerun in its first second with zero output.`);
    }
  }
  for (const eventClass of Object.values(EVENT_TYPES)) {
    if (eventClass !== "business" && eventClass !== "lifecycle") {
      throw new Error(`mission runtime: event class "${eventClass}" is neither business nor lifecycle.`);
    }
  }
  return true;
}

// Run at import, not only at plugin init. §2 asks for init; init is a place
// somebody can forget, and this costs microseconds. A validator you must
// remember to call is a validator that ships broken.
validateStageDag(STAGES);
assertRuntimeVocabularies();
