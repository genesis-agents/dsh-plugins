// A rerun gets the ceiling somebody chose for one attempt.
//
// `budgetFor` seeds the pool from the mission's spend, deliberately, so a
// RESUME does not get the whole ceiling again — its comment says so and that
// is right. Neither ledger carried a generation, so the same read made a fresh
// rerun impossible: run 9 of a mission opened with nine runs of spend against a
// cap chosen for one, and s3-collect failed all eight dimensions with
// `budget_exhausted` five milliseconds in. It then reported "0 of 0 dimensions
// returned no verifiable evidence" — a sentence about evidence for a failure
// about money.
//
// One column serves both readings, and this holds both: same generation
// accumulates, new generation starts clean.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SourceStore } from "../lib/store.js";
import { openMissionStore } from "../lib/mission-store.js";
import { STAGES } from "../lib/mission-runtime.js";

const BUDGET = { maxTokens: 100_000, maxCalls: 200, maxArxiv: 10, maxWeb: 10, maxFetch: 10, wallMs: 3_600_000 };

/** A mission with one settled spend row in its current generation. */
function seeded(t) {
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  const missions = openMissionStore(store);
  const { id } = missions.createMission({
    topic: "t", depth: "quick", bootId: "boot-1", pid: 1, at: "2026-08-27T09:00:00.000Z",
    config: {}, budget: BUDGET,
  }, STAGES.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1, status: "pending" })));
  return { missions, id };
}

test("spend belongs to the generation that spent it", (t) => {
  const { missions, id } = seeded(t);
  missions.insertSpend({
    missionId: id, stepId: "s3-collect", role: "researcher",
    promptTok: 1000, completionTok: 500, calls: 3, at: "2026-08-27T09:00:01.000Z",
  });

  const run1 = missions.spendTotals(id, 1);
  assert.equal(run1.tokens, 1500, "the run that spent it cannot see its own spend");
  assert.equal(run1.calls, 3);

  // The next generation opens clean. This is the whole point: without it the
  // cap is a lifetime budget and a mission can only ever be run once.
  const run2 = missions.spendTotals(id, 2);
  assert.equal(run2.tokens, 0, "a fresh rerun inherited the previous generation's spend, so its ceiling is already gone");
  assert.equal(run2.calls, 0);

  // And the lifetime view still exists, for anyone asking what the mission
  // cost in total rather than what this attempt may still spend.
  assert.equal(missions.spendTotals(id).tokens, 1500, "the unscoped read stopped answering what the mission cost");
});

test("tool allowances are per generation too", (t) => {
  const { missions, id } = seeded(t);
  missions.insertToolCall({
    missionId: id, stepId: "s3-collect", agentId: "researcher:d1", tool: "web_search",
    paceKey: "web", argsHash: "h1", argsText: "q", ok: true, cached: false,
    latencyMs: 10, at: "2026-08-27T09:00:01.000Z",
  });

  assert.equal(missions.toolCallTotals(id, 1).web?.charged ?? 0, 1, "the run that made the call cannot see it");
  assert.equal(
    missions.toolCallTotals(id, 2).web?.charged ?? 0,
    0,
    "a fresh rerun opens with the previous generation's web allowance already spent",
  );
});

test("the pool is seeded from the generation, not the lifetime", () => {
  // THE HALF THAT DID NOT LAND. The migration, both writers and both readers
  // went in; the one line that USES them did not, because the script that
  // applied them failed partway and wrote what it had. The column existed, the
  // scoped reads worked, their unit tests passed — and the pool went on asking
  // for the mission's lifetime spend, so run 10 died exactly as run 9 had.
  //
  // Read from the source, because the seeding happens inside a closure built at
  // boot and there is no seam to call.
  const handlers = readFileSync(new URL("../lib/mission-handlers.js", import.meta.url), "utf8");
  const seeding = handlers.slice(handlers.indexOf("const budgetFor ="), handlers.indexOf("createBudgetPool({"));
  assert.match(
    seeding,
    /spendTotals\(mission\.id,\s*mission\.runCount\)/,
    "the pool is seeded with the mission's whole spend again, so every rerun after the first opens over its ceiling",
  );
  assert.match(
    seeding,
    /toolCallTotals\(mission\.id,\s*mission\.runCount\)/,
    "the per-tool allowances are seeded from every generation, so a rerun opens with arXiv and fetch already spent",
  );
});

test("the meters describe the run they are on", (t) => {
  // The pane's ceilings ARE the ones the run is held to, and the pool is seeded
  // per generation — so an unscoped read here says "289 of 300 calls" about a
  // run that has made nine. A meter reporting a cap as nearly spent while the
  // run has barely started is worse than no meter: it invites exactly the
  // wrong action, which on this screen is abandoning a healthy run.
  const { missions, id } = seeded(t);
  missions.insertSpend({
    missionId: id, stepId: "s3-collect", role: "researcher",
    promptTok: 4000, completionTok: 1000, calls: 40, at: "2026-08-27T09:00:01.000Z",
  });

  const before = missions.readModelInputs(id);
  assert.equal(before.spend.calls, 40, "the run cannot see its own spend on the pane it is judged by");

  // A fresh rerun bumps the generation. The pane must follow the pool.
  missions.resetStagesForFreshRerun(id, "2026-08-27T09:10:00.000Z");
  // The claim is what bumps the generation, and it refuses a mission that is
  // still `running` — so the fixture has to end the previous run the way a
  // real one does before asking for a new generation.
  missions.finalizeMissionRow({
    missionId: id, runCount: 1, status: "failed", failureCode: "no_evidence",
    errorMessage: "fixture", at: "2026-08-27T09:09:59.000Z", origin: "lifecycle", reason: null, detail: null,
  });
  const claimed = missions.claimForRun(id, { bootId: "boot-1", pid: 1, newGeneration: true, at: "2026-08-27T09:10:01.000Z" });
  assert.ok(claimed.claimed, `the fixture could not open a new generation: ${claimed.reason}`);
  assert.equal(missions.getMission(id).runCount, 2, "the claim did not bump the generation");

  const after = missions.readModelInputs(id);
  assert.equal(
    after.spend.calls,
    0,
    "the new generation's meters still carry the last one's spend, so the pane and the pool disagree about the same ceiling",
  );
});
