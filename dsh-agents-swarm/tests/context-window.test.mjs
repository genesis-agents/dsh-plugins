// A number an operator supplies is not a guess.
//
// `readContextPlan` refuses to default the routed model's context window, and
// it is right to: a guessed window makes every shrink decision downstream wrong
// in the same direction, which is worse than having no plan.
//
// But on the deployment this runs on, none of its three accessors answers —
// `openai/gpt-5.6-luna` reports no window through the route, `llm.modelInfo` or
// `llm.models`, and the plugin only ever calls `llm.stream` and
// `agentDefaultModel.currentSelection()`. So s1-brief degraded on EVERY run of
// this mission, twenty of them, and every stage after it ran at its smallest
// viable input with no way for anybody to say otherwise.
//
// The setting is the last resort, after every accessor. It is not a guess,
// because a person typed it; and leaving it unset still degrades honestly.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { readContextPlan } from "../lib/mission-stages-front.js";
import { MISSION_DEFAULTS, validateMissionConfig } from "../lib/mission-config.js";

/** A ctx whose model answers nothing about itself, like the real one. */
const silent = () => ({
  agentDefaultModel: { currentSelection: () => ({ provider: "openai", model: "gpt-5.6-luna" }) },
  llm: {},
});

test("with nothing configured the window stays null and says why", async () => {
  const plan = await readContextPlan(silent(), null, 0);
  assert.equal(plan.contextWindow, null, "a window was invented from nothing, which is the one thing this must not do");
  assert.equal(plan.source, null);
  assert.match(plan.why, /gpt-5\.6-luna/, "the reason does not name the model that could not be read");
});

test("a configured window is used, and says it came from the setting", async () => {
  const plan = await readContextPlan(silent(), null, 400_000);
  assert.equal(plan.contextWindow, 400_000, "the operator's number was ignored, so the degrade is unfixable");
  assert.equal(plan.source, "setting", "the plan does not record where the number came from");
  assert.equal(plan.why, null, "a resolved plan still carries a failure reason");
});

test("the harness wins over the setting when it can answer", async () => {
  // Preferred, because a harness that grows the metadata should beat a number
  // somebody typed months ago.
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: "openai", model: "m" }) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 128_000 }, defaultMaxTokens: 8_000 }) },
  };
  const plan = await readContextPlan(ctx, null, 400_000);
  assert.equal(plan.contextWindow, 128_000, "a stale setting overrode what the harness actually reported");
  assert.equal(plan.source, "llm.resolveModelInfo");
  assert.equal(plan.defaultMaxTokens, 8_000);
});

test("nonsense in the setting is refused rather than taken literally", async () => {
  // A numeric STRING is not nonsense: `validateMissionConfig` coerces before it
  // bounds, so a settings file may legitimately deliver "400000" here, and
  // refusing it would degrade a mission an operator had correctly configured.
  assert.equal((await readContextPlan(silent(), null, "400000")).contextWindow, 400_000);
  for (const configured of [undefined, null, 0, -1, 2.5, "", "many", Number.NaN]) {
    const plan = await readContextPlan(silent(), null, configured);
    assert.equal(
      plan.contextWindow,
      null,
      `a window of ${JSON.stringify(configured)} was accepted, so a typo silences the degrade while still starving every stage`,
    );
  }
});

test("the setting exists, defaults to unset, and is bounded", async () => {
  assert.equal(MISSION_DEFAULTS.missionContextWindow, 0, "the default is not unset, so it is a guess after all");
  // The validator answers with a list of problems, not an object holding one.
  assert.deepEqual(validateMissionConfig({ missionContextWindow: 400_000 }), []);
  for (const bad of [-1, 1.5, 20_000_000]) {
    const problems = validateMissionConfig({ missionContextWindow: bad });
    assert.ok(
      problems.some((problem) => problem.includes("missionContextWindow")),
      `${bad} was accepted as a context window`,
    );
  }
});

test("the nested shape the design names is read, not only the flat one", async () => {
  // §9: "s1 resolves `LlmResolvedModelInfo.context.contextWindow` and
  // `defaultMaxTokens` for the routed model". The resolver only ever looked at
  // the top level, so a harness answering in the documented shape read as
  // "reported no context window" — and every stage after s1 shrank to its
  // smallest viable input on a mission whose model had told us its size.
  const nested = {
    agentDefaultModel: { currentSelection: () => ({ provider: "openai", model: "m" }) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 200_000, defaultMaxTokens: 16_000 } }) },
  };
  const plan = await readContextPlan(nested, null, 0);
  assert.equal(plan.contextWindow, 200_000, "the documented nested shape still reads as no window at all");
  assert.equal(plan.defaultMaxTokens, 16_000);
  assert.equal(plan.source, "llm.resolveModelInfo");
});

test("a route that carries its own window is still read flat", async () => {
  // Both shapes, because the three accessors are different harness surfaces and
  // nothing says they agree.
  const flat = {
    agentDefaultModel: { currentSelection: () => ({ provider: "openai", model: "m", contextWindow: 128_000 }) },
    llm: {},
  };
  assert.equal((await readContextPlan(flat, null, 0)).contextWindow, 128_000, "the flat shape stopped being read");
  assert.equal((await readContextPlan(flat, null, 0)).source, "route");
});

test("the resolver calls methods the harness actually has", async () => {
  // The reason it never worked. It asked for `llm.modelInfo(provider, model)`
  // and `llm.models()`; the service exposes
  // `async resolveModelInfo(provider, model, signal?)` and
  // `discoverModels(settingsNs, request)`, and the discovered-model list is
  // keyed `id` where the old accessor read `entry.model`. The third accessor,
  // `currentSelection()`, is documented as returning a provider, a model and an
  // optional reasoning selection — nothing about size.
  //
  // Three accessors, none of which could ever answer. The degrade note on every
  // run said so and read as a fact about the model rather than about this code.
  const source = readFileSync(new URL("../lib/mission-stages-front.js", import.meta.url), "utf8");
  const open = source.indexOf("export async function readContextPlan");
  assert.ok(open > 0, "readContextPlan moved or stopped being async; this guard is looking at nothing");
  const body = source.slice(open, source.indexOf("\n}", open));

  assert.match(body, /ctx\.llm\?\.resolveModelInfo\?\.\(route\.provider, route\.model\)/, "the service's own method is not called");
  for (const imagined of ["llm?.modelInfo", "llm?.models?.()", "entry?.model === route.model"]) {
    assert.ok(!body.includes(imagined), `the resolver still calls \`${imagined}\`, which this harness does not have`);
  }
  // Async, because `resolveModelInfo` is. A synchronous read of it yields a
  // Promise, whose `.context` is undefined — which looks exactly like a model
  // that reported nothing.
  assert.match(body, /info = await candidate\.read\(\)/, "the accessor's result is used without awaiting it");
});

test("an accessor that throws is logged and stepped over, not fatal", async () => {
  // `resolveModelInfo` rejects with NO_ADAPTER for a route it does not own, and
  // s1 must degrade rather than take the mission down with it.
  const warned = [];
  const angry = {
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    llm: { resolveModelInfo: async () => { throw new Error("NO_ADAPTER"); } },
  };
  const plan = await readContextPlan(angry, { warn: (line) => warned.push(line) }, 0);
  assert.equal(plan.contextWindow, null);
  assert.ok(warned.some((line) => line.includes("NO_ADAPTER")), "a throwing accessor was swallowed without a word");
});
