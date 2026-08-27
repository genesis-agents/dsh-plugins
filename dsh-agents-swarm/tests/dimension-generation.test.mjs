// The dimension plan belongs to the generation that planned it.
//
// `mission_dimensions` was keyed (mission_id, dimension_id) on a stated
// assumption: one mission, one set of dimensions, for life. A fresh rerun
// replans and the leader names the new dimensions itself, so a rerun did not
// update eight rows — it ADDED eight. One mission reached run 11 holding 37
// dimensions for a plan of 8. Every reader was passed `runCount` and none of
// them could scope by it; `evidenceFloorTarget` said so in a comment and
// discarded the parameter.
//
// `weakestDimensions` is where that stopped being cosmetic. It ranks by
// verified findings IN THIS RUN, so the 29 dimensions belonging to dead
// generations all scored zero and were permanently the weakest — and the s4
// back edge exists to re-collect the weakest two. Every rerun since the first
// spent its one back edge re-collecting dimensions that were not in its plan.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceStore } from "../lib/store.js";
import { openMissionStore, COUNTING_VERIFY_STATE, documentIdFor } from "../lib/mission-store.js";
import { STAGES } from "../lib/mission-runtime.js";

const BUDGET = { maxTokens: 100_000, maxCalls: 200, maxArxiv: 10, maxWeb: 10, maxFetch: 10, wallMs: 3_600_000 };

function mission(t) {
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  const missions = openMissionStore(store);
  const { id } = missions.createMission({
    topic: "t", depth: "deep", bootId: "b", pid: 1, at: "2026-08-27T09:00:00.000Z",
    config: {}, budget: BUDGET,
  }, STAGES.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1, status: "pending" })));
  return { missions, id };
}

/** A stored page and a finding quoting it, which is what "verified" requires. */
function verifiedFinding(missions, { missionId, dimensionId, runCount, n }) {
  const url = `https://example.test/page-${n}`;
  const quote = "the separator coating step remains the throughput bottleneck";
  missions.putDocument({
    url, status: 200, fetchedAt: "2026-08-27T09:00:05.000Z",
    markdown: `A report on the line. ${quote} at roughly nine hundred cells per hour across both of the installed production lines, which the company confirmed in its own disclosure to investors this quarter.`,
  });
  missions.insertFinding({
    missionId, dimensionId, runCount, attempt: 0, agent: "researcher",
    claim: `claim ${n}`, evidence: quote,
    sourceUrl: url, documentId: documentIdFor(url), spanIndex: 0,
    verifyState: COUNTING_VERIFY_STATE, createdAt: "2026-08-27T09:11:00.000Z",
  });
}

/** Move the mission to a new generation the way a fresh rerun does. */
function newGeneration(missions, id, runCount, at) {
  missions.finalizeMissionRow({
    missionId: id, runCount, status: "failed", failureCode: "no_evidence",
    errorMessage: "fixture", at, origin: "lifecycle", reason: null, detail: null,
  });
  const claimed = missions.claimForRun(id, { bootId: "b", pid: 1, newGeneration: true, at });
  assert.ok(claimed.claimed, `fixture could not open a new generation: ${claimed.reason}`);
}

test("a replan opens a new plan instead of growing the old one", (t) => {
  const { missions, id } = mission(t);
  for (const dimensionId of ["d1", "d2"]) {
    missions.upsertDimension({ missionId: id, dimensionId, name: dimensionId, facet: "market", at: "2026-08-27T09:00:01.000Z" });
  }
  assert.equal(missions.listDimensions(id).length, 2);

  newGeneration(missions, id, 1, "2026-08-27T09:10:00.000Z");
  // The leader names its own dimensions, so a replan is new ids, not the old
  // ones again. This is the case the old key could not represent.
  for (const dimensionId of ["k1", "k2", "k3"]) {
    missions.upsertDimension({ missionId: id, dimensionId, name: dimensionId, facet: "market", at: "2026-08-27T09:10:01.000Z" });
  }

  const now = missions.listDimensions(id);
  assert.equal(now.length, 3, `run 2 sees ${now.length} dimensions for a plan of 3: ${now.map((d) => d.dimensionId).join(",")}`);
  assert.deepEqual(now.map((d) => d.dimensionId), ["k1", "k2", "k3"]);

  // And run 1's plan is still readable, the way its findings and chapters are.
  assert.deepEqual(missions.listDimensions(id, { runCount: 1 }).map((d) => d.dimensionId), ["d1", "d2"]);
});

test("the back edge re-collects this run's weakest, not a dead run's", (t) => {
  const { missions, id } = mission(t);
  missions.upsertDimension({ missionId: id, dimensionId: "old-a", name: "a", facet: "market", at: "2026-08-27T09:00:01.000Z" });
  missions.upsertDimension({ missionId: id, dimensionId: "old-b", name: "b", facet: "market", at: "2026-08-27T09:00:01.000Z" });

  newGeneration(missions, id, 1, "2026-08-27T09:10:00.000Z");
  missions.upsertDimension({ missionId: id, dimensionId: "new-strong", name: "s", facet: "market", at: "2026-08-27T09:10:01.000Z" });
  missions.upsertDimension({ missionId: id, dimensionId: "new-weak", name: "w", facet: "market", at: "2026-08-27T09:10:01.000Z" });

  // Only the strong one collected anything this run, so the plan's weakest is
  // `new-weak`. The dead generation's two have zero verified in run 2 as well,
  // and used to tie for weakest and win on id order.
  for (let i = 0; i < 3; i += 1) {
    verifiedFinding(missions, { missionId: id, dimensionId: "new-strong", runCount: 2, n: i });
  }

  const weakest = missions.weakestDimensions(id, { limit: 2 });
  assert.ok(
    weakest.every((row) => row.dimensionId.startsWith("new-")),
    `the back edge would re-collect ${weakest.map((r) => r.dimensionId).join(", ")} — dimensions that are not in this run's plan`,
  );
  assert.equal(weakest[0].dimensionId, "new-weak", "the weakest dimension of this run's plan is not first");
});

test("the evidence floor counts one plan, not every plan ever made", (t) => {
  const { missions, id } = mission(t);
  missions.setDerivedFloor(id, 2, "2026-08-27T09:00:01.000Z");
  for (const dimensionId of ["d1", "d2", "d3"]) {
    missions.upsertDimension({ missionId: id, dimensionId, name: dimensionId, facet: "market", at: "2026-08-27T09:00:01.000Z" });
  }
  assert.equal(missions.sumDerivedFloors(id), 6, "the target is not floor x this run's dimensions");

  newGeneration(missions, id, 1, "2026-08-27T09:10:00.000Z");
  for (const dimensionId of ["k1", "k2", "k3"]) {
    missions.upsertDimension({ missionId: id, dimensionId, name: dimensionId, facet: "market", at: "2026-08-27T09:10:01.000Z" });
  }
  assert.equal(
    missions.sumDerivedFloors(id),
    6,
    "the target doubled on a rerun because it counted both generations, so a mission's bar rises every time it is rerun",
  );
});

test("state and grade land on the running generation's row", (t) => {
  const { missions, id } = mission(t);
  missions.upsertDimension({ missionId: id, dimensionId: "same", name: "n", facet: "market", at: "2026-08-27T09:00:01.000Z" });
  missions.setDimensionState(id, "same", "collected", { at: "2026-08-27T09:01:00.000Z" });

  newGeneration(missions, id, 1, "2026-08-27T09:10:00.000Z");
  // A dimension id CAN survive a replan. When it does, the two rows are two
  // rows, and this run's writes must not land on the last run's.
  missions.upsertDimension({ missionId: id, dimensionId: "same", name: "n", facet: "market", at: "2026-08-27T09:10:01.000Z" });
  missions.setDimensionState(id, "same", "failed", { failureCode: "no_evidence", at: "2026-08-27T09:11:00.000Z" });
  missions.gradeDimension(id, "same", { score: 41, axes: {} }, "2026-08-27T09:12:00.000Z");

  assert.equal(missions.listDimensions(id, { runCount: 1 })[0].state, "collected", "this run's failure overwrote the last run's record");
  assert.equal(missions.listDimensions(id, { runCount: 2 })[0].state, "failed");
  assert.equal(missions.listDimensions(id, { runCount: 2 })[0].grade, 41);
  assert.equal(missions.listDimensions(id, { runCount: 1 })[0].grade, null, "the grade landed on the wrong generation");
});

test("007 rebuilds an existing database and backfills from its findings", (t) => {
  // The migration runs against real history, so it is exercised against a
  // database shaped the way the deployed one is: the old key, rows from several
  // generations, findings that say which generation each belonged to.
  const dir = mkdtempSync(join(tmpdir(), "dsh-dim-"));
  const path = join(dir, "old.sqlite");

  const built = new SourceStore(path);
  const before = openMissionStore(built);
  before.createMission({
    topic: "t", depth: "deep", bootId: "b", pid: 1, at: "2026-08-27T09:00:00.000Z",
    config: {}, budget: BUDGET,
  }, STAGES.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1, status: "pending" })));
  const id = before.listMissions({ limit: 1 }).missions[0].id;
  built.db.exec(`UPDATE missions SET run_count = 3 WHERE id = '${id}'`);

  // Back to the pre-007 shape, and 007 retracted from the ledger so it runs
  // again on the next open. Everything else about this database is current.
  built.db.exec([
    "DROP TABLE mission_dimensions;",
    "CREATE TABLE mission_dimensions (",
    "  mission_id TEXT NOT NULL, dimension_id TEXT NOT NULL, name TEXT NOT NULL,",
    "  rationale TEXT, facet TEXT NOT NULL, state TEXT NOT NULL,",
    "  attempt INTEGER NOT NULL DEFAULT 0, grade REAL, grade_axes TEXT, summary TEXT,",
    "  failure_code TEXT, updated_at TEXT NOT NULL,",
    "  PRIMARY KEY (mission_id, dimension_id)",
    ") STRICT;",
    "DELETE FROM mission_schema WHERE id = '007-dimension-generation';",
  ].join(" "));

  const row = (dimensionId, state) => `('${id}','${dimensionId}','n','market','${state}','2026-08-27T09:00:00.000Z')`;
  built.db.exec(
    "INSERT INTO mission_dimensions (mission_id, dimension_id, name, facet, state, updated_at) VALUES "
    + [row("cited-in-1", "collected"), row("cited-in-3", "collected"), row("never-cited", "pending")].join(", "),
  );
  for (const [dimensionId, runCount, n] of [["cited-in-1", 1, 1], ["cited-in-3", 1, 2], ["cited-in-3", 3, 3]]) {
    verifiedFinding(before, { missionId: id, dimensionId, runCount, n });
  }
  built.close();

  // Reopening runs 007 against it.
  const store = new SourceStore(path);
  t.after(() => store.close());
  const missions = openMissionStore(store);

  // The LAST generation whose findings cite it, because the row's state, grade
  // and summary are from its last write.
  assert.deepEqual(
    missions.listDimensions(id, { runCount: 1 }).map((d) => d.dimensionId),
    ["cited-in-1"],
  );
  assert.deepEqual(
    missions.listDimensions(id, { runCount: 3 }).map((d) => d.dimensionId).sort(),
    ["cited-in-3", "never-cited"],
    "a dimension no finding ever cited was retired to a generation nobody queries, emptying a live mission's pane",
  );
});
