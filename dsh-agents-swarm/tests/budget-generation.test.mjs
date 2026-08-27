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
