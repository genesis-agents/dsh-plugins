// The screen reads one generation.
//
// There are TWO readers over this data. `readModelInputs` in mission-store.js
// is the one the model sees; `readMissionViewInput` here is the one the SCREEN
// sees, and it queries the database directly. Scoping the first one by
// `run_count` and calling the pane fixed was wrong twice over — the pane never
// used it.
//
// What the pane showed instead: 63 dimensions for a plan of 8, four ids
// appearing twice, because thirteen leaders had each named the same eight
// concepts differently and every plan the mission ever had was still listed.
// The counts hanging off those rows were already scoped to the run, so this
// run's evidence was draped over whichever old ids happened to match. The cost
// meters had the same shape: ceilings seeded per generation, spend summed over
// the mission's whole life, so a run nine calls in reported "289 of 300".
//
// The structural test at the bottom is the one that would have caught the miss.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SourceStore } from "../lib/store.js";
import { openMissionStore } from "../lib/mission-store.js";
import { readMissionViewInput, projectMissionView } from "../lib/mission-view.js";
import { STAGES } from "../lib/mission-runtime.js";
import { LADDER } from "../lib/mission-budget.js";

const BUDGET = { maxTokens: 100_000, maxCalls: 200, maxArxiv: 10, maxWeb: 10, maxFetch: 10, wallMs: 3_600_000 };

function seeded(t) {
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  const missions = openMissionStore(store);
  const { id } = missions.createMission({
    topic: "t", depth: "deep", bootId: "b", pid: 1, at: "2026-08-27T09:00:00.000Z",
    config: {}, budget: BUDGET,
  }, STAGES.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1, status: "pending" })));
  return { store, missions, id };
}

/** Move to a new generation the way a fresh rerun does. */
function newGeneration(missions, id, runCount, at) {
  missions.finalizeMissionRow({
    missionId: id, runCount, status: "failed", failureCode: "no_evidence",
    errorMessage: "fixture", at, origin: "lifecycle", reason: null, detail: null,
  });
  const claimed = missions.claimForRun(id, { bootId: "b", pid: 1, newGeneration: true, at });
  assert.ok(claimed.claimed, `fixture could not open a new generation: ${claimed.reason}`);
}

/** The view the detail screen renders. */
const viewOf = (store, id) => projectMissionView({
  ...readMissionViewInput(store.db, id, { tail: 50, sinceSeq: 0 }),
  policy: { stages: STAGES, ladder: LADDER, now: Date.parse("2026-08-27T10:00:00.000Z") },
});

test("the pane lists this run's plan, not every plan the mission ever had", (t) => {
  const { store, missions, id } = seeded(t);
  // Two generations naming the same eight concepts differently, which is what
  // a replanning leader actually does.
  for (const dimensionId of ["identity-history", "talent-university", "governance-policy"]) {
    missions.upsertDimension({ missionId: id, dimensionId, name: dimensionId, facet: "market", at: "2026-08-27T09:00:01.000Z" });
  }
  newGeneration(missions, id, 1, "2026-08-27T09:30:00.000Z");
  for (const dimensionId of ["identity-evolution", "talent-ecosystem", "governance-risks"]) {
    missions.upsertDimension({ missionId: id, dimensionId, name: dimensionId, facet: "market", at: "2026-08-27T09:30:01.000Z" });
  }

  const view = viewOf(store, id);
  const ids = view.dimensions.map((d) => d.dimensionId ?? d.id).sort();
  assert.equal(
    view.dimensions.length,
    3,
    `the pane lists ${view.dimensions.length} dimensions for a plan of 3: ${ids.join(", ")}`,
  );
  assert.deepEqual(ids, ["governance-risks", "identity-evolution", "talent-ecosystem"]);
});

test("a dimension id that survives a replan appears once, not twice", (t) => {
  // The visible symptom that named the bug: `ai-repositioning` on screen twice,
  // in two different states, in one run's pane.
  const { store, missions, id } = seeded(t);
  missions.upsertDimension({ missionId: id, dimensionId: "ai-repositioning", name: "n", facet: "market", at: "2026-08-27T09:00:01.000Z" });
  missions.setDimensionState(id, "ai-repositioning", "degraded", { at: "2026-08-27T09:01:00.000Z" });

  newGeneration(missions, id, 1, "2026-08-27T09:30:00.000Z");
  missions.upsertDimension({ missionId: id, dimensionId: "ai-repositioning", name: "n", facet: "market", at: "2026-08-27T09:30:01.000Z" });

  const view = viewOf(store, id);
  const shown = view.dimensions.filter((d) => (d.dimensionId ?? d.id) === "ai-repositioning");
  assert.equal(shown.length, 1, `one dimension id rendered ${shown.length} cards in a single run's pane`);
  assert.notEqual(shown[0].state, "degraded", "the card shows the dead generation's state");
});

test("the cost pane describes the run it is on", (t) => {
  // The ceilings on this pane are seeded per generation. Summing spend over the
  // mission's whole life against them reports a cap as nearly gone while the
  // run has barely started, which invites abandoning a healthy run.
  const { store, missions, id } = seeded(t);
  missions.insertSpend({
    missionId: id, stepId: "s3-collect", role: "researcher",
    promptTok: 40_000, completionTok: 10_000, calls: 150, at: "2026-08-27T09:00:01.000Z",
  });
  missions.insertToolCall({
    missionId: id, stepId: "s3-collect", agentId: "researcher:d1", tool: "web_search",
    paceKey: "web", argsHash: "h1", argsText: "q", ok: true, cached: false,
    latencyMs: 10, at: "2026-08-27T09:00:02.000Z",
  });

  const before = viewOf(store, id);
  assert.equal(before.cost.calls.used, 150, "the run cannot see its own spend on the pane it is judged by");
  assert.equal(before.cost.web.used, 1, "the run cannot see its own tool calls");

  newGeneration(missions, id, 1, "2026-08-27T09:30:00.000Z");
  const after = viewOf(store, id);
  assert.equal(
    after.cost.calls.used,
    0,
    `a fresh rerun opened with ${after.cost.calls.used} of its ${after.cost.calls.limit} calls already spent, so the pane and the pool disagree about one ceiling`,
  );
  assert.equal(after.cost.tokens.used, 0, "the new generation opens with the last one's tokens against its budget");
  assert.equal(after.cost.web.used, 0, "the new generation's web allowance opens already spent");
});

test("every generation-keyed table is read by generation on the screen's path", () => {
  // THE TEST THAT WOULD HAVE CAUGHT THE MISS. `readModelInputs` was scoped and
  // shipped as "the pane is fixed"; the pane uses this function instead, and
  // its seven other reads over the same three tables were all unscoped. A
  // behavioural test per pane would not have found the ones no pane asserts on.
  const source = readFileSync(new URL("../lib/mission-view.js", import.meta.url), "utf8");
  const open = source.indexOf("export function readMissionViewInput");
  assert.ok(open > 0, "readMissionViewInput moved; this guard is looking at nothing");
  const body = source.slice(open);

  // These three carry a generation and every row of them belongs to one run.
  // `mission_chapters` and `mission_artifacts` are deliberately read across
  // runs here and filtered in the projection — chapters by `projectChapters`,
  // artefacts because the version list IS the history — so they are not listed.
  const GENERATION_KEYED = ["mission_dimensions", "mission_spend", "mission_tool_calls"];
  for (const table of GENERATION_KEYED) {
    const reads = [...body.matchAll(new RegExp(`FROM ${table}\\b[\\s\\S]{0,400}?\\[missionId[^\\]]*\\]`, "g"))];
    assert.ok(reads.length > 0, `no read of ${table} found; the guard's pattern has gone stale`);
    for (const [read] of reads) {
      assert.ok(
        /run_count\s*=\s*\?/.test(read),
        `a read of ${table} on the screen's path is not scoped to the run:\n${read.slice(0, 260)}`,
      );
    }
  }
});
