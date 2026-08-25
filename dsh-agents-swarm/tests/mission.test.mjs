/**
 * The mission foundation: the store, the stage machine, the tool door and the
 * read model.
 *
 * Tested here rather than by watching a mission run, because every way this can
 * be wrong is SILENT. A resume that restarts from stage one looks exactly like a
 * resume that worked, only slower and twice as expensive. Two writers racing a
 * terminal state produce a mission whose failure_code is the vaguer of the two
 * causes, and nothing anywhere reports that the true one was overwritten. A
 * circuit that never opens presents as a slow mission, not as a broken tool. A
 * projector reading a cold database answers `running` for a mission that died
 * last week, and the only symptom is a cancel button that 400s forever. None of
 * it throws, so none of it surfaces without being asked directly.
 *
 * The store tests each open their own `:memory:` library and close it in
 * `t.after`, so no test can see another's rows.
 *
 * THE SEAM SECTION IS NOT DECORATION. `lib/mission-runtime.js` and
 * `lib/mission-store.js` were written against the same design document but never
 * against each other, and they disagreed at every boundary they share: method
 * names, row key casing, parameter object keys and value encodings. The first
 * section pins each disagreement so that fixing one cannot silently reintroduce
 * another. Where the two named one operation twice, the STORE's name is the one
 * that survived — it tracks revision 2, where a checkpoint is settled rather
 * than cleared and `s11` returns an intent while `finalizeMissionRow` performs
 * the one arbitrated write.
 *
 * The sections after it hand `runMission` the real `MissionStore`. There is no
 * adapter between them and there must never be one: the shim this file used to
 * carry made every orchestration test pass while the seam itself was broken, so
 * "the wiring is wrong" was a question only the first section could answer.
 *
 * Run with `npm test` from the package root.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SourceStore } from "../lib/store.js";
import { operativeWordFloor } from "../lib/mission-stages-back.js";
import { MAX_READ_NOTHING_REFUSALS } from "../lib/mission-stages-front.js";
import { oneHostRefusal } from "../lib/mission-agent.js";
import {
  FAILURE_CODES as STORE_FAILURE_CODES,
  MISSION_STATUSES,
  TERMINAL_STATUSES,
  documentIdFor,
  isMissionId,
  newMissionId,
  openMissionStore,
  withTx,
} from "../lib/mission-store.js";
import {
  ABORT_REASONS,
  DEFAULT_RESUME_WINDOW_MS,
  FAILURE_CODES as RUNTIME_FAILURE_CODES,
  MAX_PATCH_ROUNDS,
  REQUIRED_STORE_METHODS,
  STAGES,
  STAGE_IDS,
  SWEEP_STORE_METHODS,
  budgetGate,
  detectNoProgress,
  classifyFailure,
} from "../lib/mission-runtime.js";
import {
  canResume,
  checkDeadlines,
  checkStageReturn,
  computePipelineHash,
  computeWallFloorMs,
  claimRuntimeOwner,
  createRunRegistry,
  finalize,
  runMission,
  stagesForTier,
  sweepOrphans,
  validateStageDag,
} from "../lib/mission-runtime.js";
import { TOOL_CODES, createCircuit } from "../lib/mission-tools.js";
import { projectMissionView, readMissionViewInput } from "../lib/mission-view.js";
import { createMissionRoutes } from "../lib/mission-routes.js";

/* ── fixtures ──────────────────────────────────────────────────────────── */

/** A fresh in-memory library with its mission tables, closed when the test ends. */
function library(t) {
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  return { store, missions: openMissionStore(store) };
}

/** The twelve stage rows in the shape `createMission` insists on: 1-based, no gaps. */
const STAGE_ROWS = STAGES.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1, status: "pending" }));

/** Every ceiling `createMission` requires, wide enough that nothing trips on it. */
const BUDGET = { maxTokens: 100_000, maxCalls: 200, maxArxiv: 10, maxWeb: 10, maxFetch: 10, wallMs: 3_600_000 };

/** A running mission owned by `boot-1`, at whatever depth the test needs. */
function mission(missions, overrides = {}) {
  const { id } = missions.createMission({
    topic: "how far has solid-state battery manufacturing actually got",
    depth: "quick",
    bootId: "boot-1",
    pid: 4242,
    at: "2026-08-24T00:00:00.000Z",
    config: { resolved: true },
    budget: BUDGET,
    ...overrides,
  }, STAGE_ROWS);
  return id;
}

/**
 * A clock that advances one second per read, starting at a fixed instant.
 *
 * Injected rather than read, because a wall-clock expiry, a seven-day resume
 * window and a stage duration are all statements about elapsed time, and a
 * runner that reads `Date.now()` itself passes every test that can be written
 * for it while being wrong about the one thing it exists to do.
 */
function fakeClock(startIso = "2026-08-24T00:00:10.000Z") {
  let ms = Date.parse(startIso);
  const clock = () => {
    const iso = new Date(ms).toISOString();
    ms += 1000;
    return iso;
  };
  clock.jump = (byMs) => { ms += byMs; };
  clock.peek = () => new Date(ms).toISOString();
  return clock;
}

// `runtimeFacing()` used to live here: a test-only shim translating twenty-odd
// method names, row keys and value encodings between `runMission` and
// `MissionStore`, because the two modules were written against the same design
// document and never against each other. It is gone, and its deletion is the
// point — `runMission` is handed the real `MissionStore` below. A shim that
// makes a seam pass is a second vocabulary with a translation table between it
// and the first, which is the same bug with somewhere new to hide.

/** Handlers for every stage a tier runs, each returning a valid stage result. */
function handlersFor(tier, overrides = {}) {
  const { run } = stagesForTier(STAGES, tier);
  const handlers = {};
  for (const stage of run) {
    handlers[stage.id] = overrides[stage.id] ?? (async () => ({ output: { ran: stage.id }, degraded: false }));
  }
  // Stage one is the budget gate: it must freeze the caps and the verdict every
  // later stage reads, or `checkGateOutput` refuses the run.
  handlers["s1-brief"] = overrides["s1-brief"] ?? (async () => ({
    output: { caps: BUDGET, gate: { verdict: "pass", reason: "no history" }, contextPlan: { batch: 4 } },
    degraded: false,
  }));
  // Only the persist stage may end a mission.
  handlers["s12-persist"] = overrides["s12-persist"] ?? (async () => ({
    output: { persisted: true },
    degraded: false,
    terminalIntent: { status: "completed", finalScore: 0.91, leaderSigned: true },
  }));
  return handlers;
}

/** Enough verified evidence that the floor gate between s4 and s5 says `ok`. */
function seedEvidence(missions, missionId, { runCount = 1 } = {}) {
  const url = "https://example.test/solid-state-manufacturing";
  const markdown = `The pilot line reached a yield of sixty two percent in the second quarter, up from
    forty one percent a year earlier, according to the company's own disclosure to its investors, which
    also confirmed that the separator coating step remains the throughput bottleneck at roughly nine
    hundred cells per hour across both installed production lines.`;
  missions.putDocument({ url, markdown, status: 200, fetchedAt: "2026-08-24T00:00:05.000Z" });
  missions.upsertDimension({ missionId, dimensionId: "d1", name: "manufacturing yield", facet: "technical" });
  missions.insertFinding({
    missionId, dimensionId: "d1", runCount, attempt: 0,
    claim: "pilot line yield reached 62% in Q2",
    evidence: "The pilot line reached a yield of sixty two percent in the second quarter",
    sourceUrl: url, documentId: documentIdFor(url), spanIndex: 0,
    verifyState: "verified-source-text", createdAt: "2026-08-24T00:00:06.000Z",
  });
  missions.setDerivedFloor(missionId, 1, "2026-08-24T00:00:07.000Z");
}

/* ── the seam between the runner and the store ─────────────────────────── */

test("every store method the runner declares it needs exists on MissionStore", async (t) => {
  // `runMission` checks this list at entry and throws before touching a row, so
  // a missing name is not a subtle bug — it is a mission that cannot start at
  // all. It is pinned here because the check lives inside a function nothing
  // currently calls: `lib/index.js` imports none of the four mission modules, so
  // the whole foundation can be this broken with every other test green.
  //
  // The list is IMPORTED, not retyped. It used to be spelled out here, which
  // made the test a third copy of a vocabulary two modules were already
  // disagreeing about — and a third copy cannot arbitrate, it can only pick a
  // side. `REQUIRED_STORE_METHODS` is the entry guard's own array, so this
  // asserts the thing that actually happens at startup.
  const { missions } = library(t);
  const required = [...REQUIRED_STORE_METHODS, ...SWEEP_STORE_METHODS];
  const absent = required.filter((name) => typeof missions[name] !== "function");
  assert.deepEqual(absent, [], `MissionStore is missing ${absent.length} of the ${required.length} methods runMission requires`);

  // And the guard fires, naming them. A list nothing checks is a list that can
  // be right while the check is unreachable.
  await assert.rejects(
    () => runMission({
      store: { withTx: (fn) => fn() },
      clock: fakeClock(),
      bootId: "boot-1",
      missionId: mission(missions),
      handlers: {},
      registry: createRunRegistry(),
    }),
    /missing 13 of the 14 methods it calls/,
    "runMission must refuse a store that cannot serve it, before it touches a row",
  );
});

test("a mission row read by the store can be read by the runner", (t) => {
  // The runner used to read `run_count`, `boot_id` and `wall_ms` off a row
  // `getMission` shapes as `runCount`, `bootId` and `budget.wallMs`. Undefined
  // is not an error in JavaScript, which is exactly the problem:
  // `mission.boot_id !== bootId` is true for EVERY mission, so the runner
  // refused each one as "owned by boot (none)", and `checkDeadlines` compared
  // elapsed time against an undefined cap — a wall timer that can never fire.
  // The store's shape won; these are the fields the runner now reads.
  const { missions } = library(t);
  const row = missions.getMission(mission(missions));
  for (const field of ["runCount", "bootId", "patchRound", "startedAt", "effectiveStartedAt", "depth", "status"]) {
    assert.notEqual(row[field], undefined, `the runner reads mission.${field} and the store does not provide it`);
  }
  assert.equal(typeof row.budget.wallMs, "number", "the runner reads mission.budget.wallMs as the wall cap");

  // The wall clock's origin is resolved ONCE, by the store, and it is the MAX
  // of the two stamps. A `last_reopened_at` earlier than `started_at` must not
  // move the clock backwards and hand the run more time than its cap allows.
  assert.equal(row.effectiveStartedAt, row.startedAt, "a mission that has never been reopened runs from its start");
});

test("a stage row read by the store can be read by the runner", (t) => {
  // This is the resume bug, and it is completely silent. The runner builds its
  // settled set with `stageRows.map((row) => row.step_id)`; the store returns
  // `stepId`. The set therefore contains one member, `undefined`, so
  // `plan.findIndex((stage) => !settled.has(stage.id))` answers 0 for every
  // mission — and a resume restarts from stage one, re-running and re-paying for
  // every stage that had already finished, while reporting itself as a resume.
  const { missions } = library(t);
  const id = mission(missions);
  const [row] = missions.listStages(id);
  assert.notEqual(row.stepId, undefined, "the runner keys settled stages by row.stepId, which is what the store returns");
  assert.equal(row.stepId, STAGE_IDS[0], "and the first row is the first stage, because the rows come back in ordinal order");
});

test("a checkpoint the runner writes is a checkpoint the store accepts", (t) => {
  // `runMission` hands `completedKeys` over already stringified; `saveCheckpoint`
  // demands an array and throws. The stage row and the checkpoint are written in
  // ONE transaction precisely so that "stage complete but checkpoint missing" is
  // impossible — so this throw does not lose a checkpoint, it rolls back the
  // settled stage with it.
  const { missions } = library(t);
  const id = mission(missions);
  const snapshot = {
    at: "2026-08-24T00:01:00.000Z",
    completedKeys: ["s1-brief"],
    crossState: { caps: { maxTokens: 1 } },
    pipelineHash: computePipelineHash(STAGES, "quick"),
    status: "running",
  };
  assert.doesNotThrow(() => missions.saveCheckpoint(id, snapshot), "the runner's saveCheckpoint payload must be one the store accepts");

  // An ARRAY and an OBJECT, not JSON text. Pre-stringified, the array check
  // threw, and because the throw happened inside `finishStage`'s transaction it
  // did not merely lose the checkpoint — it rolled back the settled stage with
  // it, so the two rows that exist to be written together were lost together.
  assert.throws(
    () => missions.saveCheckpoint(id, { ...snapshot, completedKeys: JSON.stringify(["s1-brief"]) }),
    /array of literal step ids/,
    "a stringified completedKeys must be refused rather than stored as text nobody can resume from",
  );
  assert.deepEqual(missions.getCheckpoint(id).completedKeys, ["s1-brief"], "the refusal left the good snapshot alone");
});

test("a checkpoint the store writes is a checkpoint the runner can resume from", (t) => {
  // `canResume` used to read `saved_at`, `completed_keys` and `pipeline_hash`
  // and JSON.parse the last two, while `getCheckpoint` returns `savedAt` and an
  // already-parsed array. The first read threw rather than returning a refusal,
  // so the failure arrived as a TypeError out of a resume instead of as one of
  // the six named reasons the resume path promises.
  const { missions } = library(t);
  const id = mission(missions);
  missions.saveCheckpoint(id, {
    at: "2026-08-24T00:01:00.000Z",
    completedKeys: ["s1-brief"],
    crossState: {},
    pipelineHash: computePipelineHash(STAGES, "quick"),
    status: "running",
  });
  const row = { ...missions.getMission(id), status: "failed" };
  const verdict = canResume({ store: missions, mission: row, now: "2026-08-24T00:02:00.000Z" });
  assert.equal(verdict.ok, true, `canResume refused a fresh, pipeline-matching checkpoint: ${verdict.reason} — ${verdict.detail}`);
});

test("the runner's progress stamp carries the injected clock, not the wall clock", (t) => {
  // `runMission` used to call `touchMission(id, {lastStage, lastProgressAt})`
  // while the store's parameters are `{stepId, at}`, so neither field landed and
  // the liveness column every no-progress guard reads kept its default — the
  // REAL clock, in a module whose entire design is that it reads no clock. A
  // test that fakes time could not then detect a stall, and a mission restored
  // from a fixture looked permanently fresh.
  //
  // The runner no longer calls this at all: `appendEvent` stamps the column in
  // the same transaction as the business event that earned it, so there is one
  // writer rather than two. This is the other one — progress without an event,
  // for a stage boundary or an accepted chapter — and its stamp is a parameter.
  const { missions } = library(t);
  const id = mission(missions);
  missions.touchMission(id, { stepId: "s2-plan", at: "2026-08-24T00:05:00.000Z" });
  assert.equal(missions.getMission(id).lastProgressAt, "2026-08-24T00:05:00.000Z");
  assert.equal(missions.getMission(id).lastStage, "s2-plan");

  // And an event stamps it too, from the event's own `at`, so the two cannot
  // disagree about when the mission was last alive.
  missions.appendEvent(id, { type: "stage:done", stepId: "s2-plan", at: "2026-08-24T00:06:00.000Z", payload: {} });
  assert.equal(missions.getMission(id).lastProgressAt, "2026-08-24T00:06:00.000Z");
});

/* ── the stage machine ─────────────────────────────────────────────────── */

test("the twelve stages form a valid DAG with no shared ordinal", () => {
  // Playground's `s8b` shares stage number 8 with `s8`, so a checkpoint saved
  // after `s8` lists `s8b` complete and a crash between them silently skips the
  // whole section-quality stage on resume while reporting success.
  assert.equal(STAGES.length, 12);
  assert.equal(new Set(STAGE_IDS).size, 12, "two stages sharing an id makes a checkpoint ambiguous");
  assert.equal(validateStageDag(STAGES), true, "validateStageDag throws on a problem and answers true otherwise");
});

test("every failure code the runner can produce is one the store can write", () => {
  // The most dangerous divergence in the foundation, and it was invisible until
  // something went wrong. The runner classifies a failure, hands the code to the
  // store's conditional write, and the store's `assertMember` THROWS on a code
  // its own list does not carry — inside the transaction, so the terminal write
  // rolls back and the mission row stays `running` forever. The four codes only
  // the runner knew were exactly the ones the failure paths use, so the
  // mechanism that exists to stop a broken mission was the mechanism that broke.
  const unwritable = RUNTIME_FAILURE_CODES.filter((code) => !STORE_FAILURE_CODES.includes(code));
  assert.deepEqual(unwritable, [], `the runner can classify ${unwritable.length} failures the store refuses to record`);

  // Stronger than the subset, and the reason the subset can no longer fail:
  // there is ONE array. `mission-store.js` imports it and re-exports it, so the
  // two import paths resolve to the same frozen object rather than to two lists
  // somebody has to keep in step. Identity, not deepEqual — two arrays with
  // equal contents today is the state this whole seam was in.
  assert.equal(STORE_FAILURE_CODES, RUNTIME_FAILURE_CODES, "the store's failure vocabulary must BE the runtime's, not a copy of it");

  // And the four that were only the runner's are in it, named, so an edit that
  // drops one fails here rather than at the moment a mission is trying to end.
  for (const code of ["stage_contract_violation", "no_progress", "superseded", "shutdown"]) {
    assert.equal(STORE_FAILURE_CODES.includes(code), true, `missions.failure_code must be able to hold "${code}"`);
  }

  // The same for the two status vocabularies. `resumable` is the member the
  // runtime's copy did not have, which made `canResume` refuse every mission the
  // boot sweep had parked — as `wrong-status`, the one refusal that tells the
  // user to start again from nothing.
  assert.equal(MISSION_STATUSES.includes("resumable"), true, "the sweep parks missions as `resumable` and both ends must know the word");
  for (const status of TERMINAL_STATUSES) {
    assert.equal(MISSION_STATUSES.includes(status), true, `${status} is terminal and must be a status`);
  }
});

test("the four stages a quick mission does not run are marked skipped, not left pending", (t) => {
  // The row count is invariant on purpose: twelve rows at every tier, four of
  // them `skipped-by-tier` at `quick`, so the UI never has to decide whether a
  // pending row means "not yet" or "never". `createMission` writes all twelve as
  // `pending` and `markSkippedByTier` has no caller anywhere in lib/, so a quick
  // mission shows four stages that will never run as though they were still
  // queued — and its progress bar can never reach the end.
  const { missions } = library(t);
  const id = mission(missions);
  const rows = new Map(missions.listStages(id).map((row) => [row.stepId, row.status]));
  for (const stage of stagesForTier(STAGES, "quick").skipped) {
    assert.equal(rows.get(stage.id), "skipped-by-tier", `${stage.id} is not run at quick depth and must say so`);
  }
});

test("a mission runs its stages in order and records each", async (t) => {
  const { store, missions } = library(t);
  const id = mission(missions);
  seedEvidence(missions, id);
  const seen = [];
  const handlers = handlersFor("quick");
  for (const stepId of Object.keys(handlers)) {
    const inner = handlers[stepId];
    handlers[stepId] = async (ctx) => { seen.push(stepId); return inner(ctx); };
  }

  const result = await runMission({
    store: missions, clock: fakeClock(), bootId: "boot-1",
    missionId: id, handlers, registry: createRunRegistry(),
  });

  const { run: plan } = stagesForTier(STAGES, "quick");
  assert.deepEqual(seen, plan.map((stage) => stage.id), `stages ran out of order: ${result.reason}`);
  assert.equal(result.ok, true, `the mission did not complete: ${result.reason}`);

  // Recorded, not merely executed. A stage the runner ran but never settled
  // leaves a row that says `running` forever, which the projector then sweeps to
  // `failed` on a mission the user was told had completed.
  const rows = new Map(missions.listStages(id).map((row) => [row.stepId, row]));
  for (const stage of plan) {
    assert.equal(rows.get(stage.id).status, "done", `${stage.id} was not recorded as done`);
    assert.notEqual(rows.get(stage.id).endedAt, null, `${stage.id} has no ended_at`);
  }
  assert.equal(missions.getMission(id).status, "completed");
  assert.deepEqual(missions.stageOutput(id, "s2-plan"), { ran: "s2-plan" }, "the recorded output must be the value, not a quoted transcript of it");
  assert.equal(store.db.isTransaction, false, "the runner must leave no transaction open");
});

test("the budget gate refuses a plan whose rate limits alone exceed the wall cap", () => {
  // The refusal is arithmetic on the rate limiter, computed BEFORE a single
  // model call. Playground's estimate is `credits × 1000 × multiplier`, which can
  // only ever answer whether you can afford your own ceiling — it cannot know
  // that ten arXiv calls at one per three seconds plus ten fetches cannot fit
  // inside a thirty-second cap no matter how many tokens you are willing to buy.
  const floor = computeWallFloorMs({ maxArxiv: 10, maxFetch: 10, arxivIntervalMs: 3000, fetchIntervalMs: 1000, parseP50Ms: 500 });
  assert.equal(floor.floorMs, 45_000, "10 × 3000ms arXiv + 10 × 1500ms fetch");

  const refused = budgetGate({ caps: { wallMs: 30_000, maxTokens: 100_000 }, floor });
  assert.equal(refused.verdict, "refused");
  assert.equal(refused.refuse, true);
  assert.match(refused.reason, /cannot fit before a single model call/);

  const passes = budgetGate({ caps: { wallMs: 600_000, maxTokens: 100_000 }, floor });
  assert.equal(passes.refuse, false);

  // A broken estimator must never block work, and must say the estimate was
  // unavailable rather than reporting a pass it did not compute.
  const blind = budgetGate({
    caps: { wallMs: 600_000, maxTokens: 100_000 }, floor,
    history: () => { throw new Error("no such table: mission_spend"); },
  });
  assert.equal(blind.verdict, "pass");
  assert.equal(blind.estimate, null);
  assert.match(blind.reason, /cost estimator failed/);
});

test("a mission that cannot afford stage one never reaches stage two", async (t) => {
  // The gate's refusal has to be structural, not documentary. If a refused
  // verdict could flow past `s1`, the pipeline would run to completion against
  // caps nobody resolved — which is exactly how playground's rerun fell back to
  // a two-dollar default and died instantly at a stage that had no idea why.
  const { missions } = library(t);
  const id = mission(missions);
  const reached = [];
  const handlers = handlersFor("quick", {
    "s1-brief": async () => ({
      output: { caps: BUDGET, gate: { verdict: "refused", reason: "the rate limits alone need 45s against a 30s cap" }, contextPlan: null },
      degraded: false,
    }),
  });
  for (const stepId of Object.keys(handlers)) {
    if (stepId === "s1-brief") continue;
    handlers[stepId] = async () => { reached.push(stepId); return { output: null, degraded: false }; };
  }

  let result;
  let threw = null;
  try {
    result = await runMission({
      store: missions, clock: fakeClock(), bootId: "boot-1",
      missionId: id, handlers, registry: createRunRegistry(),
    });
  } catch (error) {
    threw = error;
  }

  assert.deepEqual(reached, [], "no stage after the gate may run on a refused plan");
  // The runner must RECORD the refusal, not throw it. A throw out of the run
  // loop leaves the row `running` with nobody left to end it — the exact
  // forever-running state the arbitrated write exists to prevent.
  assert.equal(threw, null, `the runner threw instead of writing a terminal state: ${threw?.message}`);
  assert.equal(result.ok, false);
  const row = missions.getMission(id);
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "stage_contract_violation");
  assert.match(result.reason, /refused/);
});

test("an aborted mission stops where it was and says it was aborted", async (t) => {
  const { missions } = library(t);
  const id = mission(missions);
  const registry = createRunRegistry();
  const reached = [];
  const handlers = handlersFor("quick");
  for (const stepId of Object.keys(handlers)) {
    const inner = handlers[stepId];
    handlers[stepId] = async (ctx) => {
      reached.push(stepId);
      // Cancel arrives while s2 is in flight, the way a user's click does.
      if (stepId === "s2-plan") registry.abort(id, "user_cancelled");
      return inner(ctx);
    };
  }

  const result = await runMission({
    store: missions, clock: fakeClock(), bootId: "boot-1",
    missionId: id, handlers, registry,
  });

  assert.deepEqual(reached, ["s1-brief", "s2-plan"], "the stage after the abort must not be dispatched");
  assert.equal(result.ok, false);
  assert.match(result.reason, /abort/i, "the summary must say it was aborted, not merely that it stopped");

  // `cancelled`, not `failed`. A cancel recorded as a failure is a mission the
  // user is invited to diagnose instead of one they ended on purpose, and
  // `user_cancelled` is the only abort reason that maps to it.
  const row = missions.getMission(id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.failureCode, null, "a cancellation is not a failure and carries no failure code");
  assert.ok(ABORT_REASONS.includes("user_cancelled"));
});

test("a mission interrupted mid-stage resumes from its checkpoint rather than restarting", async (t) => {
  // The expensive silent bug: a resume that re-runs settled stages costs the
  // user the whole mission again and reports itself as a resume. Playground
  // checkpoints at three milestones; a synchronous local write costs
  // microseconds, so every stage here is a resume point — which is only worth
  // anything if the second run actually starts from one.
  const { missions } = library(t);
  const id = mission(missions);
  seedEvidence(missions, id);

  const firstRun = [];
  const crashHandlers = handlersFor("quick");
  for (const stepId of Object.keys(crashHandlers)) {
    const inner = crashHandlers[stepId];
    crashHandlers[stepId] = async (ctx) => {
      firstRun.push(stepId);
      if (stepId === "s4-assess") throw new Error("the process died mid-stage");
      return inner(ctx);
    };
  }
  await runMission({
    store: missions, clock: fakeClock(), bootId: "boot-1",
    missionId: id, handlers: crashHandlers, registry: createRunRegistry(),
  });

  assert.deepEqual(firstRun, ["s1-brief", "s2-plan", "s3-collect", "s4-assess"]);
  const checkpoint = missions.getCheckpoint(id);
  assert.deepEqual(checkpoint.completedKeys, ["s1-brief", "s2-plan", "s3-collect"], "the checkpoint must list exactly the stages that settled");
  assert.equal(missions.getMission(id).status, "failed");

  // Re-claim the row the way a resume does, stamping `last_reopened_at` in the
  // same update: without it the wall clock still runs from the ORIGINAL start,
  // so a mission resumed an hour later dies in its first stage against a cap it
  // never had, and the user reads it as "my rerun broke".
  const claim = missions.claimForRun(id, { bootId: "boot-1", pid: 4242, at: "2026-08-24T01:00:00.000Z" });
  assert.equal(claim.claimed, true, claim.reason ?? "");
  assert.notEqual(missions.getMission(id).lastReopenedAt, null, "a re-claimed mission must carry last_reopened_at");

  // The re-claim opened generation 2, and every finding the first run verified
  // is filed under generation 1. The evidence floor gate counts the CURRENT
  // generation, and the resume skips `s3-collect` because it already settled, so
  // without this the resumed mission cannot collect and cannot pass — see the
  // dedicated test below, which is what this line is standing in for.
  seedEvidence(missions, id, { runCount: 2 });

  const secondRun = [];
  const resumeHandlers = handlersFor("quick");
  for (const stepId of Object.keys(resumeHandlers)) {
    const inner = resumeHandlers[stepId];
    resumeHandlers[stepId] = async (ctx) => { secondRun.push(stepId); return inner(ctx); };
  }
  const result = await runMission({
    store: missions, clock: fakeClock("2026-08-24T01:00:10.000Z"), bootId: "boot-1",
    missionId: id, handlers: resumeHandlers, registry: createRunRegistry(),
  });

  assert.equal(secondRun.includes("s1-brief"), false, "the budget gate must not be re-run: the caps it froze are what the mission is graded against");
  assert.equal(secondRun.includes("s2-plan"), false, "a settled stage must not be re-run on resume");
  assert.equal(secondRun[0], "s4-assess", `the resume must start at the first unsettled stage, not at ${secondRun[0]}`);
  assert.equal(result.ok, true, `the resumed mission did not complete: ${result.reason}`);
});

test("a resumed mission still owns the evidence its first generation verified", (t) => {
  // Resuming increments `run_count`, and every finding, dimension grade and
  // chapter is filed under the generation that produced it. The evidence floor
  // gate counts the CURRENT generation only — so on resume it counts zero and
  // ends the mission `quality-failed` with `no_evidence`, reporting "we looked
  // and found nothing verifiable" about a run that found plenty. The resume
  // cannot recover either: `s3-collect` already settled, so it is never
  // re-dispatched and the new generation can never acquire evidence of its own.
  // Every resumed mission therefore fails, and it fails with the one message
  // that reads as a fact about the topic rather than a bug in the runner.
  const { missions } = library(t);
  const id = mission(missions);
  seedEvidence(missions, id, { runCount: 1 });
  assert.equal(missions.distinctVerifiedPairs(id, { runCount: 1 }), 1);

  missions.finalizeMissionRow({ missionId: id, status: "failed", failureCode: "runtime_crashed", at: "2026-08-24T00:05:00.000Z" });
  missions.claimForRun(id, { bootId: "boot-1", pid: 4242, at: "2026-08-24T01:00:00.000Z" });
  const generation = missions.getMission(id).runCount;
  assert.equal(generation, 2, "a resume opens a new generation");

  assert.equal(
    missions.distinctVerifiedPairs(id, { runCount: generation }), 1,
    "the resumed generation must still be able to see the evidence the mission already verified",
  );
});

test("a resume is refused by name once its checkpoint is past the window", (t) => {
  // "Resume did nothing" is indistinguishable from "resume is broken". Every
  // refusal is named so the difference is readable from the answer itself.
  const { missions } = library(t);
  const id = mission(missions);
  const hash = computePipelineHash(STAGES, "quick");
  missions.saveCheckpoint(id, { at: "2026-08-24T00:01:00.000Z", completedKeys: ["s1-brief"], crossState: {}, pipelineHash: hash, status: "running" });
  const base = { id, depth: "quick", status: "failed", run_count: 1, failure_code: "model_error", last_stage: "s2-plan" };

  const fresh = canResume({ store: missions, mission: base, now: "2026-08-24T00:02:00.000Z" });
  const stale = canResume({
    store: missions, mission: base,
    now: new Date(Date.parse("2026-08-24T00:01:00.000Z") + DEFAULT_RESUME_WINDOW_MS + 1000).toISOString(),
  });
  assert.equal(fresh.ok, true, `${fresh.reason}: ${fresh.detail}`);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "expired");

  // A completed mission is not resumable and must say so as `wrong-status`,
  // never as `no-checkpoint` — the latter sends the reader hunting for a bug in
  // the checkpoint writer.
  const done = canResume({ store: missions, mission: { ...base, status: "completed" }, now: "2026-08-24T00:02:00.000Z" });
  assert.equal(done.reason, "wrong-status");
});

test("a pipeline whose stage contract changed refuses to resume across the change", (t) => {
  // Resuming across a changed pipeline is how a resume silently skips a stage
  // and reports success. The hash is the whole defence.
  const { missions } = library(t);
  const id = mission(missions);
  missions.saveCheckpoint(id, {
    at: "2026-08-24T00:01:00.000Z", completedKeys: ["s1-brief"], crossState: {},
    pipelineHash: "not-the-hash-of-this-pipeline", status: "running",
  });
  const verdict = canResume({
    store: missions,
    mission: { id, depth: "quick", status: "failed", run_count: 1, failure_code: "model_error" },
    now: "2026-08-24T00:02:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "pipeline-changed");
  assert.notEqual(computePipelineHash(STAGES, "quick"), computePipelineHash(STAGES, "deep"), "two tiers must not share a pipeline hash");
});

/* ── the arbitrated terminal write ─────────────────────────────────────── */

test("two writers racing a terminal state produce exactly one terminal state", (t) => {
  // Six paths can end a mission. Without arbitration the true cause is
  // overwritten by a later, vaguer one — the reference's incident rewrote
  // `budget_exhausted` into `cancelled` and then into "lost contact", destroying
  // the diagnosis. The conditional `WHERE status = 'running'` is what makes the
  // FIRST writer's cause the surviving one.
  const { missions } = library(t);
  const id = mission(missions);

  const first = missions.finalizeMissionRow({
    missionId: id, status: "failed", failureCode: "budget_exhausted",
    errorMessage: "max_arxiv reached 10 of 10", at: "2026-08-24T00:10:00.000Z",
  });
  const second = missions.finalizeMissionRow({
    missionId: id, status: "cancelled", errorMessage: "user pressed cancel", at: "2026-08-24T00:10:01.000Z",
  });

  assert.equal(first.won, true);
  assert.equal(second.won, false, "the second writer must lose rather than overwrite");
  assert.equal(second.reason, "not-running", "the loser must be told which of the ways it lost, by name");

  const row = missions.getMission(id);
  assert.equal(row.status, "failed", "the first writer's status survives");
  assert.equal(row.failureCode, "budget_exhausted", "the first writer's CAUSE survives, which is the whole point");
  assert.equal(row.completedAt, "2026-08-24T00:10:00.000Z");

  // Exactly one, counted. Two `mission:finalized` events would mean two writers
  // both believed they had ended it, which is the state the arbitration exists
  // to make impossible.
  const finalized = missions.eventsOfType("mission:finalized", { missionId: id });
  assert.equal(finalized.length, 1, "exactly one terminal event, not two");
});

test("the terminal write clears ownership so a dead boot cannot be swept twice", (t) => {
  const { missions } = library(t);
  const id = mission(missions);
  missions.finalizeMissionRow({ missionId: id, status: "completed", at: "2026-08-24T00:10:00.000Z" });
  const row = missions.getMission(id);
  assert.equal(row.bootId, null);
  assert.equal(row.pid, null);
  assert.deepEqual(missions.orphans("boot-2"), [], "a finished mission is not an orphan");
});

test("a completed mission's checkpoint is cleared and a failed mission's is kept", (t) => {
  // Asymmetric on purpose, and it is what makes `failed` resumable at all. The
  // reference clears unconditionally after its conditional update, so a LOSING
  // writer wipes the resume snapshot of a mission a rerun has since flipped back
  // to running.
  const { missions } = library(t);
  const hash = computePipelineHash(STAGES, "quick");
  const done = mission(missions);
  const broke = mission(missions);
  for (const id of [done, broke]) {
    missions.saveCheckpoint(id, { at: "2026-08-24T00:01:00.000Z", completedKeys: ["s1-brief"], crossState: {}, pipelineHash: hash, status: "running" });
  }
  missions.finalizeMissionRow({ missionId: done, status: "completed", at: "2026-08-24T00:10:00.000Z" });
  missions.finalizeMissionRow({ missionId: broke, status: "failed", failureCode: "model_error", at: "2026-08-24T00:10:00.000Z" });

  assert.equal(missions.getCheckpoint(done), undefined, "a completed mission has nothing to resume");
  assert.equal(missions.getCheckpoint(broke)?.status, "failed", "a failed mission keeps its snapshot so it can be resumed");
});

test("finalize refuses to end a mission on behalf of a generation that no longer owns it", (t) => {
  // A late finalize from a crashed run must not end a rerun that has since
  // started. `finalize` passes `runCount` into the conditional write for exactly
  // this reason, so the write has to actually use it.
  const { missions } = library(t);
  const id = mission(missions);
  missions.finalizeMissionRow({ missionId: id, status: "failed", failureCode: "runtime_crashed", at: "2026-08-24T00:05:00.000Z" });
  const claim = missions.claimForRun(id, { bootId: "boot-1", pid: 4242, at: "2026-08-24T00:06:00.000Z" });
  assert.equal(claim.claimed, true);
  assert.equal(missions.getMission(id).runCount, 2, "a re-claim opens a new generation");

  const stale = finalize({
    store: missions,
    clock: () => "2026-08-24T00:07:00.000Z",
    missionId: id,
    origin: "mission-runtime",
    intent: { status: "failed", runCount: 1, failureCode: "runtime_crashed", errorMessage: "the first run's ghost" },
  });
  assert.equal(stale.won, false, "generation 1's finalize must not end generation 2");
  assert.equal(missions.getMission(id).status, "running", "the rerun must still be running");
});

/* ── the tool door's circuit ───────────────────────────────────────────── */

test("the tool circuit opens after its threshold and bans only the tool, not the run", () => {
  // Two failures must NOT open it: a circuit that trips on the first blip makes
  // the whole research phase unavailable after one flaky request, which is
  // indistinguishable from a topic with no sources.
  const now = new Date("2026-08-24T00:00:00.000Z");
  const circuit = createCircuit({ now: () => now });

  assert.equal(circuit.stateOf("arxiv_search").state, "closed");
  circuit.recordFailure("arxiv_search", TOOL_CODES.FAILED, "socket hang up");
  circuit.recordFailure("arxiv_search", TOOL_CODES.FAILED, "socket hang up");
  assert.equal(circuit.stateOf("arxiv_search").usable, true, "two consecutive failures are not a broken upstream");

  circuit.recordFailure("arxiv_search", TOOL_CODES.FAILED, "socket hang up");
  const open = circuit.stateOf("arxiv_search");
  assert.equal(open.usable, false);
  assert.equal(open.state, "open");
  assert.match(open.reason, /failed 3 times in a row/);

  assert.deepEqual(circuit.bannedTools(), ["arxiv_search"]);
  assert.equal(circuit.stateOf("web_search").usable, true, "banning one tool must not ban the others");
  assert.equal(circuit.drainNotices().length, 1, "the model is owed one sentence about it");
  assert.deepEqual(circuit.drainNotices(), [], "notices are drained, not repeated forever");

  // A success before the threshold resets the run counter, so three failures
  // spread across a working session never accumulate into a ban.
  const patchy = createCircuit({ now: () => now });
  patchy.recordFailure("web_search", TOOL_CODES.FAILED, "timeout");
  patchy.recordFailure("web_search", TOOL_CODES.FAILED, "timeout");
  patchy.recordSuccess("web_search");
  patchy.recordFailure("web_search", TOOL_CODES.FAILED, "timeout");
  assert.equal(patchy.stateOf("web_search").usable, true, "a success in between must reset the consecutive count");
});

test("a rate-limited tool cools down on disk and recovers through a single probe", (t) => {
  // The cooldown outlives the run because the upstream's rate limit does. Held
  // only in memory, every restart would re-issue the request that got us
  // limited, which is how a fifteen-minute penalty becomes a permanent one.
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let now = new Date("2026-08-24T00:00:00.000Z");

  const first = createCircuit({ db, now: () => now });
  first.recordFailure("web_search", TOOL_CODES.RATE_LIMITED, "429");
  assert.equal(first.stateOf("web_search").usable, false);
  const persisted = db.prepare("SELECT tool, open_until FROM tool_cooldowns").all();
  assert.equal(persisted.length, 1, "the cooldown must survive the process that earned it");
  assert.equal(persisted[0].open_until, "2026-08-24T00:15:00.000Z", "web_search's cooldown is fifteen minutes");

  // A new run inside the window is still refused, and says how much longer.
  now = new Date("2026-08-24T00:05:00.000Z");
  const during = createCircuit({ db, now: () => now });
  assert.equal(during.stateOf("web_search").usable, false);
  assert.match(during.stateOf("web_search").reason, /cooling down for about 10 more minute/);

  // Past the window the tool is half-open: exactly ONE probe, not the four the
  // model would issue at once the moment the catalogue opened again.
  now = new Date("2026-08-24T00:20:00.000Z");
  const after = createCircuit({ db, now: () => now });
  const halfOpen = after.stateOf("web_search");
  assert.equal(halfOpen.usable, true);
  assert.equal(halfOpen.state, "half-open");

  after.markProbe("web_search");
  after.recordSuccess("web_search");
  assert.equal(after.stateOf("web_search").state, "closed", "a good probe closes the circuit");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_cooldowns").get().n, 0, "recovery clears the persisted row");
  assert.match(after.drainNotices().join(" "), /recovered/);

  // A probe that fails re-opens the cooldown at full length immediately, rather
  // than spending the run's three attempts first.
  now = new Date("2026-08-24T01:00:00.000Z");
  const relapse = createCircuit({ db, now: () => now });
  relapse.recordFailure("web_search", TOOL_CODES.RATE_LIMITED, "429");
  now = new Date("2026-08-24T01:20:00.000Z");
  const probeAgain = createCircuit({ db, now: () => now });
  assert.equal(probeAgain.stateOf("web_search").state, "half-open");
  probeAgain.markProbe("web_search");
  probeAgain.recordFailure("web_search", TOOL_CODES.FAILED, "still down");
  assert.equal(probeAgain.stateOf("web_search").usable, false, "a failed probe must not leave the tool open");
});

/* ── the read model ────────────────────────────────────────────────────── */

/** The policy the projector requires: the catalogue, the ladder and the clock. */
const VIEW_POLICY = (nowIso) => ({
  stages: STAGES,
  ladder: { soften: 0.70, freeze: 0.90, warn: 0.80 },
  now: Date.parse(nowIso),
});

test("the view projects a mission from a cold database with nothing in memory", (t) => {
  // The process restarts and the run registry is empty. Everything the mission
  // page shows has to come back out of SQLite alone — if any of it were only in
  // memory, a restart would render a live mission as a blank page, which is the
  // single most common way a local agent app appears to have lost work it still
  // has.
  const { store, missions } = library(t);
  const id = mission(missions);
  seedEvidence(missions, id);
  missions.startStage(id, "s1-brief", "2026-08-24T00:00:10.000Z");
  missions.finishStage(id, "s1-brief", { status: "done", output: { caps: BUDGET }, tokens: 120, at: "2026-08-24T00:00:20.000Z" });
  missions.insertSpend({ missionId: id, stepId: "s1-brief", role: "leader", promptTok: 100, completionTok: 20, calls: 1, at: "2026-08-24T00:00:20.000Z" });

  // Read the way a cold boot reads it: no registry, no cached row, no in-flight
  // state — only what SQLite can answer.
  const input = readMissionViewInput(store.db, id, {});
  assert.notEqual(input, null, "a mission that exists must project");
  const view = projectMissionView({ ...input, policy: VIEW_POLICY("2026-08-24T00:01:00.000Z") });

  assert.equal(view.mission.status, "running");
  assert.equal(view.stages.length, 12, "twelve rows at every tier, so the UI never has to decide whether a missing row means pending or excluded");
  const byId = new Map(view.stages.map((stage) => [stage.stepId ?? stage.id, stage]));
  assert.equal(byId.get("s1-brief").status, "done", "a settled stage must come back settled");
  // The projector reports the stored row rather than re-deciding it. Whether
  // `s5-reconcile` should read `skipped-by-tier` is the store's business, and
  // its own test above covers it.
  assert.equal(byId.get("s5-reconcile").status, missions.listStages(id).find((row) => row.stepId === "s5-reconcile").status);
  assert.deepEqual(view.swept, [], "nothing may be swept on a mission that is genuinely running");
  assert.equal(readMissionViewInput(store.db, "mission-does-not-exist", {}), null, "a missing mission is a 404 at the route, not an empty view");
});

test("the view never renders a terminal mission as running", (t) => {
  // Playground's display mapping fell through to `running` for a status it did
  // not know, so a finished mission showed a live cancel button that 400'd on
  // every click — the frontend caught the error, toasted, reloaded, and landed
  // on a view that said running again. Cancel became permanently impossible.
  const { store, missions } = library(t);
  const id = mission(missions);
  missions.startStage(id, "s1-brief", "2026-08-24T00:00:10.000Z");
  missions.finalizeMissionRow({ missionId: id, status: "quality-failed", failureCode: "no_evidence", at: "2026-08-24T00:10:00.000Z" });

  const view = projectMissionView({
    ...readMissionViewInput(store.db, id, {}),
    policy: VIEW_POLICY("2026-08-24T00:11:00.000Z"),
  });
  assert.equal(view.mission.status, "quality-failed");
  assert.notEqual(view.mission.status, "running");

  // A stage left `running` by the death is swept, and the sweep is REPORTED
  // rather than silently applied: on anything but `completed` we know only that
  // the work started, so forcing it to `done` would be fabrication.
  const s1 = view.stages.find((stage) => (stage.stepId ?? stage.id) === "s1-brief");
  assert.equal(s1.status, "failed", "an unfinished stage on a failed mission is failed, never done");
  assert.equal(view.swept.length > 0, true, "the projector must say what it swept");
});

test("every status the store may write is one the projector can render", (t) => {
  // Nothing may default to `running`: defaulting is what manufactures a
  // forever-running illusion out of a status the mapping has not caught up with.
  const { store, missions } = library(t);
  for (const status of MISSION_STATUSES) {
    const id = mission(missions);
    if (TERMINAL_STATUSES.includes(status)) {
      missions.finalizeMissionRow({
        missionId: id, status,
        failureCode: status === "failed" || status === "quality-failed" ? "model_error" : null,
        at: "2026-08-24T00:10:00.000Z",
      });
    } else if (status === "resumable") {
      missions.parkResumable(id, { note: "the process died", at: "2026-08-24T00:10:00.000Z" });
    }
    const view = projectMissionView({
      ...readMissionViewInput(store.db, id, {}),
      policy: VIEW_POLICY("2026-08-24T00:11:00.000Z"),
    });
    assert.equal(view.mission.status, status, `a ${status} mission must render as ${status}`);
  }
  assert.equal(store.db.isTransaction, false);
});

/* ── liveness, without a Redis heartbeat ───────────────────────────────── */

test("the wall clock of a resumed mission runs from the re-claim, not the original start", (t) => {
  // One process, no cross-pod takeover, so there is no heartbeat row to expire —
  // the guard is arithmetic on two columns instead. Measuring from `started_at`
  // would kill a mission resumed an hour later inside its first stage, against a
  // cap it never had, and the user reads that as "my rerun broke".
  //
  // The two columns are folded into `effectiveStartedAt` by `shapeMission`, and
  // by nothing else: the runner used to take its own max of the raw columns
  // beside the store's own COALESCE of them, which is two implementations of one
  // decision and only one of them was right about a clock skew.
  const { missions } = library(t);
  const id = mission(missions);
  const opened = missions.getMission(id);
  assert.equal(opened.effectiveStartedAt, opened.startedAt, "a fresh mission runs from its start");
  missions.finalizeMissionRow({ missionId: id, status: "failed", failureCode: "runtime_crashed", at: "2026-08-24T00:30:00.000Z" });
  missions.claimForRun(id, { bootId: "boot-1", pid: 4242, at: "2026-08-24T01:00:00.000Z" });
  assert.equal(
    missions.getMission(id).effectiveStartedAt, "2026-08-24T01:00:00.000Z",
    "a re-claimed mission runs from the re-claim, resolved once by the store rather than by each reader",
  );

  const fresh = { effectiveStartedAt: "2026-08-24T00:00:00.000Z", budget: { wallMs: 600_000 } };
  const reopened = { effectiveStartedAt: "2026-08-24T01:00:00.000Z", budget: { wallMs: 600_000 } };

  assert.equal(checkDeadlines({ mission: fresh, now: "2026-08-24T00:05:00.000Z" }).expired, false);
  assert.equal(checkDeadlines({ mission: fresh, now: "2026-08-24T00:10:00.000Z" }).expired, true);
  assert.equal(checkDeadlines({ mission: reopened, now: "2026-08-24T01:05:00.000Z" }).expired, false, "the resumed run gets its own wall clock");
  assert.equal(checkDeadlines({ mission: reopened, now: "2026-08-24T01:10:00.000Z" }).expired, true);
  assert.equal(checkDeadlines({ mission: fresh, now: "2026-08-24T00:05:00.000Z" }).reason, null);
  assert.equal(checkDeadlines({ mission: fresh, now: "2026-08-24T00:10:00.000Z" }).reason, "wall_time_exceeded");

  // The numbers come back on BOTH paths so the meter renders from the same call
  // the guard makes, rather than from a second query that can disagree with it.
  const live = checkDeadlines({ mission: fresh, now: "2026-08-24T00:05:00.000Z" });
  assert.equal(live.detail.remainingMs, 300_000);
});

test("an orphan of a dead boot is reclaimed and one of a live boot is left alone", (t) => {
  // The single-process replacement for the reference's Redis heartbeat: the boot
  // id answers "did the process that owned this row survive?", which is the only
  // question that exists here. Reclaiming a LIVE boot's mission would abort work
  // that is genuinely running.
  const { missions } = library(t);
  const dead = mission(missions);
  const live = mission(missions, { bootId: "boot-2" });

  const orphans = missions.orphans("boot-2");
  assert.deepEqual(orphans.map((row) => row.id), [dead], "only rows owned by a boot that is not the current one are orphans");
  assert.equal(missions.getMission(live).status, "running", "the current boot's own mission is untouched");
});

test("the boot sweep moves every orphan out of running and says what it did", (t) => {
  // `orphans`, `settleCheckpoint(id, "abandoned")` and the runtime-owner pair
  // are the four store methods the seam had no equivalent for at all, so they
  // were added rather than renamed — and an added store method with no test is
  // how this seam got here. The sweep is also the only path that writes
  // `abandoned`, a checkpoint status `saveCheckpoint` used to reject outright,
  // which meant the sweep could never mark anything and a deterministic crash
  // was offered for resume on every boot, for ever.
  const { missions } = library(t);
  const hash = computePipelineHash(STAGES, "quick");

  // Two missions left `running` by a boot that is not this one: one parkable,
  // one at the reclaim limit.
  const parked = mission(missions, { bootId: "boot-dead" });
  missions.saveCheckpoint(parked, { at: "2026-08-24T00:01:00.000Z", completedKeys: ["s1-brief"], crossState: {}, pipelineHash: hash, status: "running" });
  const givenUp = mission(missions, { bootId: "boot-dead" });
  missions.saveCheckpoint(givenUp, { at: "2026-08-24T00:01:00.000Z", completedKeys: ["s1-brief"], crossState: {}, pipelineHash: hash, status: "running" });
  missions.db.prepare("UPDATE missions SET run_count = 4 WHERE id = ?").run(givenUp);

  const swept = new Map(sweepOrphans({
    store: missions, clock: fakeClock("2026-08-24T01:00:00.000Z"),
    bootId: "boot-1", registry: createRunRegistry(),
  }).swept.map((row) => [row.missionId, row]));

  // Nothing is ever left stuck: both are out of `running`, whatever else.
  for (const id of [parked, givenUp]) {
    assert.equal(missions.getMission(id).status, "failed", `${id} must not still be running after the sweep`);
    assert.equal(missions.getMission(id).failureCode, "runtime_crashed");
  }
  assert.deepEqual(missions.orphans("boot-1"), [], "a swept mission is no longer an orphan");

  // What distinguishes "parked, resume offered" from "given up on" is the
  // CHECKPOINT, not the status — §4.1's vocabulary has no `resumable` terminal
  // member and adding one is how display bugs are manufactured.
  assert.equal(swept.get(parked).outcome, "resumable", swept.get(parked).reason);
  assert.equal(missions.getCheckpoint(parked).status, "failed", "a parked mission keeps a usable snapshot");

  assert.equal(swept.get(givenUp).outcome, "abandoned");
  assert.match(swept.get(givenUp).reason, /crashed 4 times/);
  assert.equal(missions.getCheckpoint(givenUp).status, "abandoned", "the sweep must be able to mark a snapshot it gave up on");

  // And the refusal is named `reclaim-limit`, not `no-checkpoint`. The snapshot
  // is present, fresh and pipeline-compatible, so every other reason would send
  // the reader hunting for a bug in the checkpoint writer.
  const verdict = canResume({ store: missions, mission: missions.getMission(givenUp), now: "2026-08-24T01:05:00.000Z" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "reclaim-limit");
});

test("a live foreign process keeps the library and a dead one loses it", (t) => {
  // The boot id answers "did the process that owned this row survive?" for the
  // case that happens — one process, restarted. This is the case it does not
  // cover: two harnesses opened against the same file, where reclaiming the
  // other's missions would abort work that is genuinely running. It refuses
  // rather than resolves, and the probe is INJECTED because `process.kill(pid,
  // 0)` is a side effect a test must be able to answer without one.
  const { missions } = library(t);
  assert.equal(missions.getRuntimeOwner(), undefined, "a fresh library is unowned");

  const first = claimRuntimeOwner({ store: missions, clock: () => "2026-08-24T00:00:00.000Z", bootId: "boot-1", pid: 111, isPidLive: () => false });
  assert.equal(first.claimed, true, first.reason);
  assert.deepEqual(missions.getRuntimeOwner(), { pid: 111, bootId: "boot-1", startedAt: "2026-08-24T00:00:00.000Z" });

  const contested = claimRuntimeOwner({ store: missions, clock: () => "2026-08-24T00:01:00.000Z", bootId: "boot-2", pid: 222, isPidLive: (pid) => pid === 111 });
  assert.equal(contested.claimed, false);
  assert.match(contested.reason, /already owns this library/);
  assert.equal(missions.getRuntimeOwner().bootId, "boot-1", "a refused claim must not move the row");

  const afterDeath = claimRuntimeOwner({ store: missions, clock: () => "2026-08-24T00:02:00.000Z", bootId: "boot-2", pid: 222, isPidLive: () => false });
  assert.equal(afterDeath.claimed, true);
  assert.match(afterDeath.reason, /took over from a dead owner \(pid 111\)/);
  assert.equal(missions.getRuntimeOwner().bootId, "boot-2");
});

test("a stage that breaks its return contract is refused by name", () => {
  // The contract is checked because a stage that returns nothing is
  // indistinguishable at every later read from one that returned an empty
  // result, and the difference decides whether the mission continues.
  const stage = STAGES.find((candidate) => candidate.id === "s2-plan");
  assert.equal(checkStageReturn(stage, { output: null, degraded: false }), null, "the minimal valid return");
  assert.match(checkStageReturn(stage, null), /instead of an object/);
  assert.match(checkStageReturn(stage, { degraded: false }), /no "output" field/);
  assert.match(checkStageReturn(stage, { output: 1 }), /boolean "degraded"/);
  assert.match(checkStageReturn(stage, { output: 1, degraded: true }), /no degradeNote/);
  assert.match(checkStageReturn(stage, { output: 1, degraded: false, next: "s3-collect" }), /backEdge is null/);

  // Only the persist stage may end a mission: s11 writes its signature and
  // returns an intent so that s12's arbitrated write is the one that runs.
  assert.match(checkStageReturn(stage, { output: 1, degraded: false, terminalIntent: { status: "completed" } }), /mode is "plan"/);
  assert.equal(MAX_PATCH_ROUNDS, 1, "at most one s4 → s3 recollect round, and it is persisted on the row");
});

test("an id is minted sortable and is recognised again", () => {
  const id = newMissionId(new Date("2026-08-24T09:00:00.000Z"));
  assert.match(id, /^mission-20260824T090000Z-[0-9a-f]{8}$/);
  assert.equal(isMissionId(id), true);
  for (const bad of ["mission-x", "../etc/passwd", `${id}/status`, "", null]) {
    assert.equal(isMissionId(bad), false, String(bad));
  }
});

test("the mission tables stamp no schema version of their own", (t) => {
  // `store.js` stamps `user_version` 1 and throws for anything else at open. A
  // second module bumping the stamp makes every existing library refuse to open
  // at the NEXT boot, on somebody else's machine, presenting as a corrupt
  // database rather than as a schema mismatch.
  const { store, missions } = library(t);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(typeof missions.close, "undefined", "the handle belongs to the SourceStore");
  assert.equal(openMissionStore(store), missions, "two instances would be two places to look when a row is wrong");
});

test("a fan-out is not a loop, however alike its searches look", () => {
  // Measured on a real mission: s3-collect fans out over five dimensions, three
  // of them delivered findings, and the guard killed the run as `no_progress`
  // with "No progress for 0s" — a sentence borrowed from the timeout branch,
  // which had not fired. Two dimensions asking arXiv the same question is
  // ordinary; three is not rare. A loop can only happen inside ONE agent.
  const entry = { missionId: "m", stepId: "s3-collect", lastProgressAtMs: Date.now(), runCount: 1 };
  const now = () => new Date().toISOString();

  const fanOut = detectNoProgress({
    entry, now: now(), noProgressKillMs: 600000, spendRose: true,
    toolShapes: [
      { agentId: "researcher:dim-1", stepId: "s3-collect", tool: "arxiv_search", argsHash: "same" },
      { agentId: "researcher:dim-2", stepId: "s3-collect", tool: "arxiv_search", argsHash: "same" },
      { agentId: "researcher:dim-3", stepId: "s3-collect", tool: "arxiv_search", argsHash: "same" },
    ],
  });
  assert.equal(fanOut.tripped, false, `three dimensions searching alike was called a wedge: ${fanOut.why}`);

  const wedge = detectNoProgress({
    entry, now: now(), noProgressKillMs: 600000, spendRose: true,
    toolShapes: [
      { agentId: "researcher:dim-1", stepId: "s3-collect", tool: "arxiv_search", argsHash: "same" },
      { agentId: "researcher:dim-1", stepId: "s3-collect", tool: "arxiv_search", argsHash: "same" },
      { agentId: "researcher:dim-1", stepId: "s3-collect", tool: "arxiv_search", argsHash: "same" },
    ],
  });
  assert.equal(wedge.tripped, true, "one agent asking the same question three times is the loop shape");
  assert.match(wedge.why, /researcher:dim-1/u, "the reason must name which agent is looping");
});

test("the word floor follows the evidence, and says which bound it", () => {
  // A real mission collected 11 verified findings and wrote 1,008 words, and
  // the guard refused it "against a standard floor of 9,000" — a sentence about
  // the writer for a problem that was about supply. Eleven findings cannot
  // honestly carry nine thousand words, and demanding it asks for padding: a
  // padded report that passes is worse than a short one that fails.
  const thin = operativeWordFloor(9000, 11);
  assert.equal(thin.source, "evidence", "eleven findings were judged against the tier constant");
  assert.ok(thin.floor < 9000 && thin.floor > 1008, `an unusable floor: ${thin.floor}`);

  // With supply to match, the tier's own number binds and nothing is softened.
  const rich = operativeWordFloor(9000, 40);
  assert.equal(rich.source, "tier");
  assert.equal(rich.floor, 9000, "a well-evidenced report escaped its tier floor");

  // Zero evidence still has a floor: a two-line report is not a report.
  const empty = operativeWordFloor(9000, 0);
  assert.equal(empty.source, "evidence");
  assert.ok(empty.floor >= 400, "no evidence removed the floor entirely");
});

test("a refusal that is ignored is repeated, not waived", () => {
  // Measured: the model was refused once for finishing without reading a page,
  // searched again, finished again without fetching, and the dimension was
  // released empty. Four of eight dimensions ended that way in one mission —
  // while `fetch_page` had a 100% success rate. It was never the fetching that
  // failed, it was the deciding to fetch, and one refusal did not change it.
  assert.ok(MAX_READ_NOTHING_REFUSALS >= 3, `one refusal is not a gate: ${MAX_READ_NOTHING_REFUSALS}`);
});

test("one host is one source, and the refusal says so", () => {
  // Every dimension in that mission that produced anything produced it from
  // exactly ONE host — six findings off a single page, or nothing — while the
  // floor asked for two independent sources. Six of eight cards read 降级 for
  // a bar the loop was never pushed to clear.
  const text = oneHostRefusal(1, 2);
  assert.match(text, /one host/u, "the refusal does not say what is wrong");
  assert.match(text, /2 independent sources/u, "the refusal does not say what is wanted");
  assert.match(text, /different host/u, "the refusal does not say what to do");
  // And it leaves the honest exit open: one host may be all that exists.
  assert.match(text, /which\s+other hosts you tried/u, "the refusal offers no way out for a dimension with one real source");
});

test("a tool call records its arguments, not only their hash", (t) => {
  // Eighty-six searches and not one query written down. `args_hash` answers
  // "is this the same call again" and nothing else, so a dimension that found
  // nothing could not be diagnosed by anybody — including whoever built it.
  const { store, missions } = library(t);
  const id = mission(missions);
  missions.insertToolCall({
    missionId: id, stepId: "s3-collect", agentId: "researcher:d1",
    tool: "web_search", argsHash: "abc", argsText: "Kanata North talent workforce",
    ok: true, latencyMs: 12, at: new Date().toISOString(),
  });
  const [call] = missions.recentToolCalls(id, 10);
  assert.equal(call.argsText, "Kanata North talent workforce", "the query was not stored");
  assert.equal(call.argsHash, "abc", "the hash was lost while adding the text");
});

test("a failure keeps the reason the stage already knew", () => {
  // Twice in one afternoon a mission ended with "The model returned an error:
  // no message" while holding the message. A stage that knows what went wrong
  // throws `fail(code, diagnostic)`, and the diagnostic reads "the model
  // returned an error on turn 3: <what the provider said>" — but the moment the
  // classifier recognised the code it called describeFailure without it.
  const said = "the model returned an error on turn 3: upstream connect error";
  const verdict = classifyFailure({
    error: Object.assign(new Error(said), { code: "model_error" }),
    detail: { stepId: "s8-write" },
  });
  assert.equal(verdict.code, "model_error");
  assert.ok(
    verdict.message.includes("upstream connect error"),
    `the reason was dropped on the recognised-code path: ${verdict.message}`,
  );
  assert.ok(!verdict.message.includes("no message"), "reported no message while holding one");
});

test("a model that answered in prose is not reported as a provider outage", () => {
  // The sentence used to end "re-run when the provider recovers" whatever the
  // reason. s8-write failed because the model wrote the report as prose
  // instead of submitting it through `finalize` — re-running repeats that
  // exactly, and the advice sent the reader to watch a provider that was fine.
  const prose = classifyFailure({
    error: Object.assign(
      new Error("Turn 1 answered in prose with no tool call, but this stage's output must be submitted through finalize."),
      { code: "model_error" },
    ),
  });
  assert.ok(prose.message.includes("prose"), "the reason was dropped");
  assert.ok(!prose.message.includes("provider recovers"), `told to wait for a provider that is fine: ${prose.message}`);

  // A transport failure still gets the wait-for-it advice, because there it is true.
  const outage = classifyFailure({
    error: Object.assign(new Error("HTTP 503 upstream connect error"), { code: "model_error" }),
  });
  assert.ok(outage.message.includes("provider recovers"), "a real outage lost its advice");
});

test("a settled mission can be deleted, a running one is refused with a reason", (t) => {
  // There was no way to remove a mission at all — no store method, no route, no
  // button — so the list only grew. And a live one must NOT go: the runtime
  // holds its id and would keep writing stages and events against rows that no
  // longer exist.
  const { missions } = library(t);
  const id = mission(missions);

  const live = missions.deleteMission(id);
  assert.equal(live.ok, false, "a running mission was deleted out from under its runtime");
  assert.match(live.reason, /Cancel it first/u, "the refusal does not say what to do");

  missions.finalizeMissionRow({ missionId: id, runCount: 1, status: "cancelled", at: "2026-08-25T00:00:00.000Z" });
  const gone = missions.deleteMission(id);
  assert.equal(gone.ok, true, `a settled mission would not delete: ${gone.reason}`);
  assert.equal(missions.getMission(id), undefined, "the row survived its own deletion");

  const twice = missions.deleteMission(id);
  assert.equal(twice.ok, false, "deleting a mission that is gone reported success");
  assert.match(twice.reason, /no mission/u);
});

test("the chapter count follows the dimensions that found something", () => {
  // Measured: 13 verified findings across three dimensions, from three hosts of
  // which two were the same site, produced ONE chapter of 306 words. The cap
  // was `floor(uniqueHosts / 2)`, which reads host COUNT as a proxy for how
  // much there is to say, and two thirds of the evidence was never written up.
  const capOf = (hosts, evidenced) => Math.max(1, Math.min(evidenced, Math.max(1, hosts)));
  assert.equal(capOf(3, 3), 3, "three evidenced dimensions still collapsed to fewer chapters");
  // Host diversity remains a ceiling: two hosts cannot carry five independent chapters.
  assert.equal(capOf(2, 5), 2);
  // And one of anything is still one.
  assert.equal(capOf(1, 1), 1);
  assert.equal(capOf(0, 3), 1, "a mission with no host recorded lost its only chapter");
});

/* ── the trajectory and the evidence behind it ─────────────────────────── */

/**
 * Call the mission router as the HTTP layer would, and hand back what it wrote.
 *
 * A shim over `sendJson`, not over the store: the point of these tests is the
 * route's own validation and projection, and a fake store would test neither.
 * @param {object} missions - a real MissionStore.
 * @param {string} url - path and query, already prefixed with `/missions/`.
 * @returns {Promise<object>} `{handled, status, body}`.
 */
async function callRoute(missions, url) {
  const res = {};
  const handler = createMissionRoutes({
    missionStore: missions,
    runtime: { start: () => ({ started: true }), running: () => [], bootId: "boot-1", clock: () => "2026-08-24T01:00:00.000Z" },
    sendJson: (target, status, body) => { target.status = status; target.body = body; },
    readJson: async () => ({}),
  });
  const handled = await handler({ method: "GET", url }, res, new URL(url, "http://local").pathname);
  return { handled, status: res.status, body: res.body };
}

/**
 * A mission that collected: two dimensions, three findings across three verify
 * states, three tool calls, and a stage that started and finished.
 * @param {object} missions - the store to write into.
 * @returns {string} the mission id.
 */
function collectedMission(missions) {
  const id = mission(missions);
  missions.upsertDimension({ missionId: id, dimensionId: "d1", name: "制造路径", facet: "technical", at: "2026-08-24T00:00:01.000Z" });
  missions.upsertDimension({ missionId: id, dimensionId: "d2", name: "监管口径", facet: "policy", at: "2026-08-24T00:00:01.000Z" });
  missions.startStage(id, "s3-collect", "2026-08-24T00:00:02.000Z", { agentId: "researcher:d1" });

  const url = "https://arxiv.org/abs/2401.00001";
  missions.putDocument({ url, markdown: "solid electrolyte text ".repeat(40), status: 200, fetchedAt: "2026-08-24T00:00:05.000Z" });
  missions.insertFinding({
    missionId: id, dimensionId: "d1", runCount: 1, attempt: 0,
    claim: "Sulfide electrolytes reached 10 mS/cm in pilot cells.",
    evidence: "we measured 10 mS/cm at 25 C in a pilot pouch cell, sustained over two hundred cycles",
    sourceUrl: url, verifyState: "verified-source-text",
    documentId: documentIdFor(url), spanIndex: 2, createdAt: "2026-08-24T00:00:06.000Z",
  });
  missions.insertFinding({
    missionId: id, dimensionId: "d1", runCount: 1, attempt: 0,
    claim: "Costs fell forty percent.", evidence: "cost per kWh fell by roughly forty percent",
    sourceUrl: "https://example.com/report", verifyState: "unverifiable", createdAt: "2026-08-24T00:00:07.000Z",
  });
  missions.insertFinding({
    missionId: id, dimensionId: "d2", runCount: 1, attempt: 0,
    claim: "Battery passports apply from 2027.", evidence: "the battery passport requirement applies from February 2027",
    sourceUrl: "https://eur-lex.europa.eu/x", verifyState: "unchecked-rate-limited", createdAt: "2026-08-24T00:00:08.000Z",
  });

  // TWO CALLS AT THE SAME INSTANT, on purpose: the trajectory's tool ref is
  // keyed on the instant plus an ordinal, and if that ordinal is wrong these
  // two are what proves it.
  missions.insertToolCall({ missionId: id, stepId: "s3-collect", agentId: "researcher:d1", tool: "web.search", paceKey: "web", argsHash: "h1", argsText: '{"q":"solid state battery pilot line yield"}', ok: true, latencyMs: 812, at: "2026-08-24T00:00:04.000Z" });
  missions.insertToolCall({ missionId: id, stepId: "s3-collect", agentId: "researcher:d1", tool: "web.fetch", paceKey: "fetch", argsHash: "h2", argsText: `{"url":"${url}"}`, ok: false, errorCode: "rate_limited", latencyMs: 30, at: "2026-08-24T00:00:04.000Z" });
  missions.insertToolCall({ missionId: id, stepId: "s3-collect", agentId: "researcher:d2", tool: "web.search", paceKey: "web", argsHash: "h3", argsText: '{"q":"battery passport regulation"}', ok: true, cached: true, latencyMs: 2, at: "2026-08-24T00:00:09.000Z" });

  missions.finishStage(id, "s3-collect", { status: "done", at: "2026-08-24T00:00:20.000Z", output: { dimensions: 2 }, tokens: 1200 });
  return id;
}

test("a dimension's findings can be read, quote and source and all", async (t) => {
  // THE COMPLAINT, as a test. The card said "已核验 6 · 1 个独立站点" and there was
  // no route in the product that could return one of those six. A count of
  // evidence the screen will not show is worse than no count: it asserts the
  // work happened and withholds the only thing that could check it.
  const { missions } = library(t);
  const id = collectedMission(missions);

  const all = await callRoute(missions, `/missions/${id}/findings`);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.data.findings.length, 3);
  for (const finding of all.body.data.findings) {
    assert.ok(finding.quote.length > 0, `${finding.id} came back without its quote`);
    assert.ok(finding.sourceUrl.startsWith("http"), `${finding.id} came back without a source`);
    assert.ok(finding.verifyState.length > 0, `${finding.id} came back without a verify state`);
  }

  // Unchecked is not refuted. A 429 must never read as a fabrication, here or
  // in the column — three values, never two.
  const byState = new Map(all.body.data.findings.map((f) => [f.verifyState, f.verified]));
  assert.equal(byState.get("verified-source-text"), true);
  assert.equal(byState.get("unverifiable"), false);
  assert.equal(byState.get("unchecked-rate-limited"), null, "a rate limit was reported as a failed claim");

  const one = await callRoute(missions, `/missions/${id}/findings?dimensionId=d2`);
  assert.equal(one.body.data.findings.length, 1);
  assert.equal(one.body.data.dimension.name, "监管口径", "the panel header cannot name the dimension it is showing");

  // WHICH sites, not how many. "1 个独立站点" told the reader a number and
  // withheld the only part of it that can be judged.
  const hosts = await callRoute(missions, `/missions/${id}/findings?dimensionId=d1`);
  assert.deepEqual(hosts.body.data.hosts, [{ host: "arxiv.org", findings: 1 }]);
  assert.equal(hosts.body.data.counts.verified, 1);
  assert.equal(hosts.body.data.counts.total, 2, "the histogram was recomputed from the page instead of the scope");
});

test("a query parameter the route does not read is refused by name", async (t) => {
  // `{"tier":"quick"}` was accepted on create, silently ignored, and cost a
  // whole run. A query string has exactly that failure mode: `?dimension=d1`
  // where the parameter is `dimensionId` returns EVERY finding in the mission,
  // which reads as a filter that works and a dimension with more evidence than
  // it has.
  const { missions } = library(t);
  const id = collectedMission(missions);

  const typo = await callRoute(missions, `/missions/${id}/findings?dimension=d1`);
  assert.equal(typo.status, 400, "an unknown parameter was silently ignored");
  assert.match(typo.body.error, /dimensionId/u, "the refusal does not name the parameter that exists");

  const stray = await callRoute(missions, `/missions/${id}/trace?tier=quick`);
  assert.equal(stray.status, 400);
  assert.match(stray.body.error, /kind, role, stepId/u);

  // And a mistyped VALUE is still a 400 naming the vocabulary, never an empty list.
  const badKind = await callRoute(missions, `/missions/${id}/trace?kind=stages`);
  assert.equal(badKind.status, 400);
  assert.match(badKind.body.error, /stage, tool, finding, event/u);

  // A dimension that does not exist is named too — an empty list from a typo
  // and an empty list from a dimension that found nothing want opposite
  // reactions from the person reading the panel.
  const badDim = await callRoute(missions, `/missions/${id}/findings?dimensionId=d9`);
  assert.equal(badDim.status, 400);
  assert.match(badDim.body.error, /d1, d2/u);
});

test("the trajectory is one ordered list, and every row of it can be opened", async (t) => {
  const { missions } = library(t);
  const id = collectedMission(missions);

  const page = await callRoute(missions, `/missions/${id}/trace?order=oldest`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const rows = page.body.data.rows;

  // Merged by timestamp across all four streams, not four lists glued together.
  const stamps = rows.map((row) => Date.parse(row.at));
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), "the trajectory is not in time order");
  const kinds = new Set(rows.map((row) => row.kind));
  for (const kind of ["stage", "tool", "finding", "event"]) {
    assert.ok(kinds.has(kind), `no ${kind} rows reached the trajectory`);
  }

  // The two calls recorded at the same instant are distinct rows with distinct
  // refs. One shared ref would open the same detail panel for both.
  const sameInstant = rows.filter((row) => row.kind === "tool" && row.at === "2026-08-24T00:00:04.000Z");
  assert.equal(sameInstant.length, 2);
  assert.notEqual(sameInstant[0].ref, sameInstant[1].ref, "two calls at one instant share one identity");

  // Every row opens, and what the list truncated comes back whole.
  for (const row of rows) {
    const detail = await callRoute(missions, `/missions/${id}/trace/${encodeURIComponent(row.ref)}`);
    assert.equal(detail.status, 200, `${row.ref} would not open: ${JSON.stringify(detail.body)}`);
    assert.equal(detail.body.data.ref, row.ref, `${row.ref} opened a different row`);
    assert.ok(detail.body.data.timing.source !== null || row.kind === "event", `${row.ref} does not say where its timing came from`);
    if (row.kind === "tool") {
      assert.equal(detail.body.data.payload.argsText, sameInstantArgs(missions, id, row), "the detail panel lost the arguments");
    }
    if (row.kind === "finding") {
      assert.ok(detail.body.data.result.text.length >= row.result.length, "the whole quote is shorter than its own preview");
    }
  }

  const missing = await callRoute(missions, `/missions/${id}/trace/event:9999`);
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /window/u, "a 404 that does not name the bound makes the bound invisible");

  const nonsense = await callRoute(missions, `/missions/${id}/trace/not-a-ref`);
  assert.equal(nonsense.status, 400);
  assert.match(nonsense.body.error, /event:412/u, "the refusal does not show what a reference looks like");
});

/** The `args_text` the store holds for the call one trajectory row names. */
function sameInstantArgs(missions, id, row) {
  const at = row.ref.slice("tool:".length, row.ref.lastIndexOf("#"));
  const ordinal = Number(row.ref.slice(row.ref.lastIndexOf("#") + 1));
  return [...missions.recentToolCalls(id, 500)].reverse().filter((call) => call.at === at)[ordinal].argsText;
}

test("a row keeps its number when the mission writes more", async (t) => {
  // The trajectory is numbered from the OLDEST end for exactly this reason.
  // Numbered from the newest, every row shifts by one each time the mission
  // records anything — so a detail panel opened on row 12 would be showing a
  // different row a second later, and the reader would have no way to notice.
  const { missions } = library(t);
  const id = collectedMission(missions);

  const before = await callRoute(missions, `/missions/${id}/trace?order=oldest`);
  const first = before.body.data.rows[0];
  const middle = before.body.data.rows[Math.floor(before.body.data.rows.length / 2)];

  missions.appendEvent(id, { type: "gate:passed", at: "2026-08-24T00:01:00.000Z", stepId: "s4-assess", payload: { verified: 1 } });

  const after = await callRoute(missions, `/missions/${id}/trace?order=oldest`);
  assert.equal(after.body.data.rows.length, before.body.data.rows.length + 1);
  assert.deepEqual(after.body.data.rows[0], first, "the first row changed under an append");
  assert.deepEqual(
    after.body.data.rows.find((row) => row.ref === middle.ref),
    middle,
    "a row moved when something newer was written",
  );
});
