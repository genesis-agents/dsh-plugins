/**
 * The seams between the six modules that were written by five agents who could
 * not talk to each other: `mission-agent.js`, the three stage modules,
 * `index.js` and `client.js`, against the four that already existed.
 *
 * Every failure pinned here was live in the merged tree and NONE of it threw at
 * import, which is why the suite was green while the pipeline could not reach
 * stage two:
 *
 *   - The seven `SKILL.md` prompt files did not exist at all. Front and back
 *     threw `input_invalid` on their first model call; the middle stages, which
 *     loaded prompts through a different and incompatible contract, silently
 *     sent an EMPTY system document and still got schema-valid output back.
 *   - `mission-stages-middle.js` did not pass `language`, so the seam's default
 *     made every s5..s8 diagnostic Chinese on an English mission while the
 *     stages either side spoke English.
 *   - `detectNoProgress` and `checkStall` had no caller anywhere. §5.2 asks for
 *     two timers and the subsystem armed zero, so a run wedged inside a stage
 *     was never terminated by anything.
 *   - `createChat` reported every finish kind other than `stop` as an outage,
 *     so a truncated answer reached the reader as a failure.
 *
 * Run with `npm test` from the package root.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { STAGES } from "../lib/mission-runtime.js";
import { AGENT_GRANTS } from "../lib/mission-tools.js";
import { loadRolePrompt } from "../lib/mission-stages-front.js";
import { createChat } from "../lib/index.js";
import { estimateContext, tokenMeterOf } from "../lib/mission-agent.js";

/* ── the prompt seam ────────────────────────────────────────────────────── */

/**
 * Every (role, duty) pair the twelve stages actually ask for.
 *
 * Written out rather than derived, for the same reason the stage catalogue's
 * `successors` are: a duty added to a stage without a matching anchor in the
 * role's SKILL.md is exactly the failure this list exists to catch, and a
 * derivation that scanned the source for duty names would learn the new name
 * from the same place the bug is.
 */
const DUTY_MATRIX = Object.freeze([
  ["leader", "plan"], ["leader", "assess"], ["leader", "foreword"], ["leader", "signoff"],
  ["researcher", "collect"],
  ["reconciler", "reconcile"],
  ["analyst", "synthesize"], ["analyst", "quickview"],
  ["writer", "mission-outline"], ["writer", "dim-outline"], ["writer", "chapter"],
  ["reviewer", "chapter"], ["reviewer", "critic"], ["reviewer", "red-team"],
  ["verifier", "verify"],
]);

test("every duty a stage asks for resolves to a prompt with a soul and a duty block", () => {
  for (const [role, duty] of DUTY_MATRIX) {
    let text;
    assert.doesNotThrow(
      () => { text = loadRolePrompt(role, duty); },
      `${role}/${duty} does not load. Every role reads its prompt from lib/mission/agents/<role>/SKILL.md; the stage that asks for this duty will throw input_invalid on its first model call.`,
    );
    assert.equal(typeof text, "string");
    assert.ok(text.length > 400, `${role}/${duty} loaded but is ${text.length} characters, which is not a prompt`);
  }
});

test("every stage with an agent has a prompt file for that agent", () => {
  for (const stage of STAGES) {
    if (stage.agent === null) continue;
    assert.ok(
      Object.hasOwn(AGENT_GRANTS, stage.agent),
      `${stage.id} names the agent "${stage.agent}", which has no entry in AGENT_GRANTS`,
    );
    assert.ok(
      DUTY_MATRIX.some(([role]) => role === stage.agent),
      `${stage.id} runs as "${stage.agent}" but no duty in DUTY_MATRIX belongs to that role, so nothing here proves its prompt loads`,
    );
  }
});

test("a duty the role does not declare is refused by name, not answered with an empty prompt", () => {
  assert.throws(
    () => loadRolePrompt("leader", "no-such-duty"),
    /no-such-duty/,
    "an unknown duty must name itself in the error; a silent empty system document is what let the middle stages run with no role at all",
  );
  assert.throws(
    () => loadRolePrompt("no-such-role", "plan"),
    /no-such-role/,
    "an unknown role must name itself and the path it looked in",
  );
});

/* ── the model seam's finish reasons ────────────────────────────────────── */

/** A ctx whose model emits one finish chunk of the given kind. */
function ctxFinishing(reason, { text = "the answer so far" } = {}) {
  return {
    agentDefaultModel: { currentSelection: () => ({ provider: "stub", model: "stub-1" }) },
    llm: {
      async *stream() {
        yield { type: "text-delta", id: "t", text };
        yield { type: "finish", reason };
      },
    },
  };
}

/** Drain createChat into the pieces it yielded. */
async function drain(ctx) {
  const pieces = [];
  for await (const piece of createChat(ctx)({ prompt: "hello", context: "" })) pieces.push(piece);
  return pieces;
}

test("a truncated answer is kept and marked, not thrown away as an outage", async () => {
  const pieces = await drain(ctxFinishing({ kind: "max-tokens" }));
  assert.equal(pieces.some((p) => p.error !== undefined), false, "`max-tokens` is a truncation, not a failure; reporting it as an error discards an answer the reader already has");
  assert.equal(pieces.map((p) => p.text ?? "").join(""), "the answer so far");
  assert.equal(pieces.some((p) => p.truncated === true), true, "the truncation must still be reported — silently returning a cut-off answer is the other half of this bug");
});

test("the normal end of an acting turn is not an error", async () => {
  for (const kind of ["stop", "tool-calls"]) {
    const pieces = await drain(ctxFinishing({ kind }));
    assert.equal(
      pieces.some((p) => p.error !== undefined), false,
      `"${kind}" is a normal ending. The spike measured 19 native tool calls and zero unparseable arguments; treating every non-stop kind as an outage is what made a working turn read as a dead provider.`,
    );
  }
});

test("only aborted and error are failures, and each carries its own message", async () => {
  const aborted = await drain(ctxFinishing({ kind: "aborted", failure: { message: "the user cancelled" } }));
  assert.equal(aborted.find((p) => p.error !== undefined)?.error, "the user cancelled");

  const errored = await drain(ctxFinishing({ kind: "error", failure: { message: "upstream 503" } }));
  assert.equal(errored.find((p) => p.error !== undefined)?.error, "upstream 503");

  // A failure with no message must still say something actionable rather than
  // yielding `undefined` into the reader's error box.
  const bare = await drain(ctxFinishing({ kind: "error" }));
  assert.equal(typeof bare.find((p) => p.error !== undefined)?.error, "string");
});

/* ── the lifecycle watchdog ─────────────────────────────────────────────── */

/** A runtime over an in-memory library, with a model that is never called. */
async function runtimeFixture(t) {
  const { SourceStore } = await import("../lib/store.js");
  const { openMissionStore } = await import("../lib/mission-store.js");
  const { createMissionRuntime } = await import("../lib/mission-handlers.js");
  const { resolveBudget } = await import("../lib/mission-budget.js");

  const store = new SourceStore(":memory:");
  const missionStore = openMissionStore(store);
  t.after(() => { store.close(); });

  const warnings = [];
  const runtime = createMissionRuntime({
    store,
    missionStore,
    ctx: {
      logger: { info: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: "stub", model: "stub-1" }) },
      get: () => undefined,
      llm: { async *stream() { throw new Error("the watchdog must not call the model"); } },
    },
    config: {},
    logger: { info: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
  });

  const resolved = resolveBudget({ depth: "standard", config: {} });
  const created = missionStore.createMission({
    topic: "watchdog fixture",
    depth: "standard",
    language: "en",
    budget: resolved.budget ?? resolved,
    bootId: runtime.bootId,
    pid: process.pid,
    config: resolved,
  }, STAGES.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1 })));

  // The SHAPED row, not `createMission`'s `{id, revision, stages}`: the wall
  // clock reads `mission.budget.wallMs`, which only the shaped row carries.
  return { store, missionStore, runtime, mission: missionStore.getMission(created.id), warnings };
}

test("a stage past its stall threshold emits one notice, and only one", async (t) => {
  const { missionStore, runtime, mission } = await runtimeFixture(t);
  const stage = STAGES.find((s) => s.id === "s5-reconcile");

  runtime.registry.register({ missionId: mission.id, runCount: 1, now: new Date().toISOString() });
  // Started long enough ago to be past `stallMs`, which is what the notice is
  // about. The mission is otherwise healthy.
  runtime.registry.setStage(mission.id, stage, new Date(Date.now() - stage.stallMs - 60_000).toISOString());

  runtime.tick();
  const first = missionStore.eventsOfType("stage:stalled", { missionId: mission.id });
  assert.equal(first.length, 1, "a stage past its stallMs must say so; `checkStall` had no caller at all, so this notice never fired");

  runtime.tick();
  const second = missionStore.eventsOfType("stage:stalled", { missionId: mission.id });
  assert.equal(second.length, 1, "the notice is latched per stage — a stalled fan-out must not fill the event log every thirty seconds");

  assert.equal(
    missionStore.getMission(mission.id).status, "running",
    "a stall is a NOTICE, not a kill. The per-stage deadline is the mechanism playground deleted after it killed fan-outs that were demonstrably alive.",
  );
});

test("a silent stage that is still spending is aborted, and a silent one that is not is left alone", async (t) => {
  const { missionStore, runtime, mission } = await runtimeFixture(t);
  const stage = STAGES.find((s) => s.id === "s3-collect");
  const longAgo = new Date(Date.now() - 3_600_000).toISOString();

  runtime.registry.register({ missionId: mission.id, runCount: 1, now: longAgo });
  runtime.registry.setStage(mission.id, stage, longAgo);
  runtime.registry.markProgress(mission.id, longAgo);

  // First tick only takes the spend mark: "is spend rising?" needs two samples,
  // and a guard that tripped on its first observation could never tell a paced
  // fetch from a wedge.
  runtime.tick();
  assert.equal(runtime.registry.hasLiveRun(mission.id), true, "one sample is not a trend");

  // Quiet AND flat: a paced arXiv round or a serialised jsdom parse, which is
  // the normal case here and must never be killed.
  runtime.tick();
  assert.equal(
    runtime.registry.hasLiveRun(mission.id), true,
    "silence with a flat meter is a long stage, not a wedge",
  );

  // Now the meter moves while nothing counts as progress.
  missionStore.insertSpend({ missionId: mission.id, stepId: stage.id, role: "researcher", promptTok: 5000, completionTok: 900 });
  runtime.tick();
  assert.equal(
    runtime.registry.hasLiveRun(mission.id), false,
    "no business event while spend keeps rising is the definition of wedged, and `detectNoProgress` had no caller — nothing terminated a run stuck inside a stage",
  );
});

test("a run past its wall clock is aborted from the interval, not only at a stage boundary", async (t) => {
  const { missionStore, runtime, mission } = await runtimeFixture(t);
  const stage = STAGES.find((s) => s.id === "s3-collect");
  const now = new Date().toISOString();

  runtime.registry.register({ missionId: mission.id, runCount: 1, now });
  runtime.registry.setStage(mission.id, stage, now);
  runtime.registry.markProgress(mission.id, now);

  // Push the mission's own start past its wall cap. `checkDeadlines` measures
  // from `max(started_at, last_reopened_at)`.
  const past = new Date(Date.now() - mission.budget.wallMs - 60_000).toISOString();
  missionStore.db.prepare("UPDATE missions SET started_at = ?, last_reopened_at = ? WHERE id = ?")
    .run(past, past, mission.id);

  runtime.tick();
  assert.equal(
    runtime.registry.hasLiveRun(mission.id), false,
    "the wall clock was only consulted between stages, so a three-hour stage could not be interrupted by the timer that exists to interrupt it",
  );
});

test("the watchdog ignores a registry entry whose row is no longer running", async (t) => {
  const { missionStore, runtime, mission } = await runtimeFixture(t);
  const stage = STAGES.find((s) => s.id === "s3-collect");
  const longAgo = new Date(Date.now() - 3_600_000).toISOString();

  runtime.registry.register({ missionId: mission.id, runCount: 1, now: longAgo });
  runtime.registry.setStage(mission.id, stage, longAgo);
  runtime.registry.markProgress(mission.id, longAgo);
  missionStore.db.prepare("UPDATE missions SET status = 'cancelled' WHERE id = ?").run(mission.id);

  missionStore.insertSpend({ missionId: mission.id, stepId: stage.id, role: "researcher", promptTok: 9000 });
  runtime.tick();
  runtime.tick();

  assert.equal(
    missionStore.eventsOfType("stage:stalled", { missionId: mission.id }).length, 0,
    "a settled mission must not collect notices from a stale in-memory entry",
  );
});

/* ── the language seam across the three stage modules ───────────────────── */

test("a middle stage tells the seam the mission's language, so its diagnostics match the stages either side", async (t) => {
  const { SourceStore } = await import("../lib/store.js");
  const { openMissionStore, documentIdFor } = await import("../lib/mission-store.js");
  const { createS5Reconcile } = await import("../lib/mission-stages-middle.js");

  const store = new SourceStore(":memory:");
  const missions = openMissionStore(store);
  t.after(() => { store.close(); });

  const url = "https://example.test/language-seam";
  missions.putDocument({
    url,
    markdown: "The transmission operator reported four point two gigawatts of installed grid battery capacity in the period, and named interconnection queues as the binding constraint on any further deployment across both of its control areas.",
    status: 200,
    fetchedAt: "2026-08-24T00:00:05.000Z",
  });
  missions.upsertDimension({ missionId: "m1", dimensionId: "d1", name: "capacity", facet: "technical" });
  missions.insertFinding({
    missionId: "m1", dimensionId: "d1", runCount: 1, attempt: 0,
    claim: "installed grid battery capacity reached 4.2 GW",
    evidence: "The transmission operator reported four point two gigawatts of installed grid battery capacity in the period",
    sourceUrl: url, documentId: documentIdFor(url), spanIndex: 0,
    verifyState: "verified-source-text", createdAt: "2026-08-24T00:00:06.000Z",
  });

  const seen = [];
  const handler = createS5Reconcile({
    store: missions,
    // Capture the request and refuse to continue: the assertion is about what
    // the stage TELLS the seam, not about what the model would answer.
    chat: async (request) => {
      seen.push(request);
      throw Object.assign(new Error("stop here"), { code: "model_error" });
    },
  });

  const context = {
    missionId: "m1", runCount: 1,
    mission: { id: "m1", topic: "grid storage", language: "en", depth: "standard" },
    tier: "standard",
    stage: { id: "s5-reconcile", agent: "reconciler", inputBudgetTokens: 90_000, maxOutputTokens: 10_000, shrinkLadder: [] },
    attempt: 1,
    signal: undefined,
    crossState: { tierPolicy: { dimensionTarget: 5, wordFloor: 4000, verifiedRatioFloor: 0.6, citationFloor: 2 }, dimensions: [{ dimensionId: "d1", name: "capacity", rationale: "r", facet: "technical" }] },
    budget: null,
    now: () => "2026-08-24T00:10:00.000Z",
    emit: () => {},
    logger: null,
  };

  await assert.rejects(() => handler(context));
  assert.equal(seen.length, 1, "the stage must have reached the seam for this to test anything");

  assert.equal(
    seen[0].language, "en",
    "s5..s8 passed no `language`, and the seam defaults it to \"zh\" — so every force-accept note, exit description and recovery hint from the middle four stages came back in Chinese on an English mission, between eight stages that spoke English",
  );
  assert.equal(
    typeof seen[0].system, "string",
    "the system document must be a string; `deps.prompts.system` was never a function, so this was `null` and the Reconciler ran with no role at all",
  );
  assert.ok(
    seen[0].system.length > 400,
    `the Reconciler's system document is ${String(seen[0].system).length} characters, which is not a prompt`,
  );
  assert.equal(typeof seen[0].now, "function", "the seam stamps its events from the runtime's injected clock, not the wall clock");
});

/* ── the incremental rerun ──────────────────────────────────────────────── */

test("an incremental rerun carries an unchanged chapter forward instead of paying to rewrite it", async (t) => {
  const { SourceStore } = await import("../lib/store.js");
  const { openMissionStore } = await import("../lib/mission-store.js");

  const store = new SourceStore(":memory:");
  const missions = openMissionStore(store);
  t.after(() => { store.close(); });

  const at = "2026-08-24T00:00:00.000Z";
  missions.upsertDimension({ missionId: "m1", dimensionId: "d1", name: "capacity", facet: "technical" });

  // Run 1 wrote two chapters.
  for (const [index, hash, body] of [[0, "hash-unchanged", "The first chapter body."], [1, "hash-will-change", "The second chapter body."]]) {
    missions.upsertChapter({
      missionId: "m1", runCount: 1, dimensionId: "d1", chapterIndex: index,
      sectionType: "evidenced", heading: `Chapter ${index + 1}`,
      body, wordCount: 400, minDelivery: 300, underDelivered: false,
      decision: "passed", score: 80, attempts: 1, inputHash: hash, at,
    });
  }

  const unchanged = missions.chapterReuse("m1", {
    fromRunCount: 1,
    hashes: { "d1#0": "hash-unchanged", "d1#1": "hash-changed-by-a-prompt-edit" },
  });
  const byIndex = new Map(unchanged.map((d) => [d.chapterIndex, d]));

  assert.equal(byIndex.get(0).reusable, true, "an identical input hash means identical prose; rewriting it spends the budget to arrive back where it started");
  assert.equal(byIndex.get(1).reusable, false, "a changed hash must invalidate");
  assert.equal(byIndex.get(1).reason, "inputs-changed", "the reason is narrated, so a rerun that kept nothing can say why");

  // The hash must cover the PROMPT, or an incremental rerun after a prompt fix
  // skips every chapter and reports success having done nothing — while
  // prompt-editing is the capability the incremental rerun exists for.
  const missing = missions.chapterReuse("m1", { fromRunCount: 1, hashes: { "d1#2": "anything" } });
  assert.equal(missing[0].reusable, false);
  assert.equal(missing[0].reason, "not-written");
});

test("a chapter carried forward keeps its under-delivery, so the content guard still sees it", async (t) => {
  const { SourceStore } = await import("../lib/store.js");
  const { openMissionStore } = await import("../lib/mission-store.js");

  const store = new SourceStore(":memory:");
  const missions = openMissionStore(store);
  t.after(() => { store.close(); });

  missions.upsertDimension({ missionId: "m1", dimensionId: "d1", name: "capacity", facet: "technical" });
  missions.upsertChapter({
    missionId: "m1", runCount: 1, dimensionId: "d1", chapterIndex: 0,
    sectionType: "evidenced", heading: "Short one",
    body: "Too short.", wordCount: 40, minDelivery: 300, underDelivered: true,
    decision: "fallback-length", score: 82, attempts: 2, inputHash: "h", at: "2026-08-24T00:00:00.000Z",
  });

  const decisions = missions.chapterReuse("m1", { fromRunCount: 1, hashes: { "d1#0": "h" } });
  assert.equal(decisions[0].reusable, true);

  const prior = missions.listChapters("m1", 1)[0];
  assert.equal(
    prior.underDelivered, true,
    "`underDelivered` is a FACT about the delivery that was made, not an action taken this run. A chapter that was short in run 1 is still short in run 2, and resetting it on carry-forward would hide the shortfall from the content guard.",
  );
});

test("an empty body is never reusable, however well its hash matches", async (t) => {
  const { SourceStore } = await import("../lib/store.js");
  const { openMissionStore } = await import("../lib/mission-store.js");

  const store = new SourceStore(":memory:");
  const missions = openMissionStore(store);
  t.after(() => { store.close(); });

  missions.upsertDimension({ missionId: "m1", dimensionId: "d1", name: "capacity", facet: "technical" });
  missions.upsertChapter({
    missionId: "m1", runCount: 1, dimensionId: "d1", chapterIndex: 0,
    sectionType: "evidenced", heading: "Never written",
    body: null, wordCount: 0, minDelivery: 300, underDelivered: false,
    decision: null, score: null, attempts: 0, inputHash: "h", at: "2026-08-24T00:00:00.000Z",
  });

  const decisions = missions.chapterReuse("m1", { fromRunCount: 1, hashes: { "d1#0": "h" } });
  assert.equal(
    decisions[0].reusable, false,
    "a matching hash over an empty body is the hole the content guard exists to catch, carried forward under a green flag",
  );
});

/* ── the Cordis service seam ────────────────────────────────────────────── */

/**
 * A stand-in for a real Cordis context: undeclared services THROW.
 *
 * This is the whole point of the double. A Cordis context is a Proxy whose
 * getter raises `cannot get property "x" without inject` for any service the
 * plugin did not list in `inject`, so a plain `{}` — which every other test in
 * this file uses — cannot reproduce the failure. `ctx.get(name)` is the
 * harness's own way to ask for an OPTIONAL service and returns undefined.
 * @param declared - services this fake pretends were injected.
 * @param installed - services the fake host actually provides.
 * @returns a context that throws exactly where a real one throws.
 */
function cordisLikeContext(declared = [], installed = {}) {
  return new Proxy(
    { get: (name) => (Object.hasOwn(installed, name) ? installed[name] : undefined) },
    {
      get(target, property) {
        if (property === "get") return target.get;
        if (typeof property !== "string") return undefined;
        if (!declared.includes(property)) {
          throw new Error(`cannot get property "${property}" without inject`);
        }
        return installed[property];
      },
    },
  );
}

test("the token meter is reached without injecting it, so an uninjected host does not throw", () => {
  // mission-20260824T202707Z-51f970f5's predecessor died 14ms into s2-plan on
  // exactly this: `ctx?.tokenMeter` reads like it degrades to undefined and
  // does not, because `?.` guards a null ctx and not a throwing getter. The
  // chars/4 fallback underneath was unreachable and the whole mission failed
  // on its first model call, with this suite green.
  const ctx = cordisLikeContext([], {});
  assert.throws(() => ctx.tokenMeter, /without inject/, "the double must throw the way Cordis does");

  const measured = estimateContext(ctx, { system: "s".repeat(40), messages: [], tools: [] });
  assert.equal(typeof measured.tokens, "number");
  assert.ok(measured.tokens > 0, "the fallback must produce a number, not zero");
  assert.match(measured.method, /^chars/, "and must SAY it is an estimate rather than claim a measurement");
});

test("a host that installs a meter is measured by it, not by chars/4", () => {
  const meter = { estimateMessage: () => 100 };
  const ctx = cordisLikeContext([], { tokenMeter: meter });
  const measured = estimateContext(ctx, { system: "", messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.equal(measured.method, "meter", "an installed meter must be preferred over the estimate");
});

test("tokenMeterOf answers undefined rather than throwing, for every shape a host can be", () => {
  assert.equal(tokenMeterOf(undefined), undefined);
  assert.equal(tokenMeterOf(null), undefined);
  // A plain object, which is what the rest of this suite passes.
  assert.equal(tokenMeterOf({}), undefined);
  assert.equal(tokenMeterOf(cordisLikeContext([], {})), undefined);
  // A `get` that itself throws must not take the caller down either.
  assert.equal(tokenMeterOf({ get: () => { throw new Error("service registry is closed"); } }), undefined);
});
