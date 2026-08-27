// Turns are a work allowance, not just a runaway guard.
//
// Two defects, one symptom. `missionTurnCap` was offered in settings, bounded
// to 3..40, echoed back by the settings route — and passed to nothing. Every
// agent used the hard-coded `AGENT_TURN_CAP`. The recovery hint printed when a
// run dies of `max_iterations` says "raise missionTurnCap", so the product's
// own printed remedy was to change a number with no effect.
//
// And the cap stayed at 12 while `findingTarget` went from 6 to 13, when the
// tier table was made able to reach its own word floor. Two dimensions of one
// run and three of the next ended `max_iterations` holding ZERO verified
// findings — a whole dimension lost, and with it a chapter of the report,
// because the researcher ran out of turns partway to a quota nobody had
// checked it could reach.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createMissionChat, AGENT_TURN_CAP } from "../lib/mission-agent.js";
import { TIER_POLICY } from "../lib/mission-stages-front.js";

const MESSAGES = [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }];

/**
 * Run one agent that never finalises, and report how many turns it got.
 *
 * The turn always calls a tool that does not exist, which is what keeps the
 * loop going: an answer with no tool call is a normal ending and settles.
 */
async function turnsTaken({ turnCap, maxTurns } = {}) {
  const state = { turns: 0 };
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: "stub", model: "stub-1" }) },
    llm: {
      async *stream() {
        state.turns += 1;
        yield { type: "tool-call-delta", id: `c${state.turns}`, name: "no_such_tool", argumentsDelta: "{}" };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      },
    },
  };
  const request = { agent: "researcher", stepId: "s3-collect", system: "s", messages: MESSAGES, tools: [] };
  const result = await createMissionChat(ctx, { turnCap })(
    maxTurns === undefined ? request : { ...request, maxTurns },
  );
  return { ...state, result };
}

test("the setting the product offers actually reaches the loop", async () => {
  const { turns, result } = await turnsTaken({ turnCap: 5 });
  assert.equal(turns, 5, `the agent took ${turns} turns under a configured cap of 5, so the setting reaches nothing`);
  assert.equal(result.exitReason, "max_iterations");

  const raised = await turnsTaken({ turnCap: 26 });
  assert.equal(raised.turns, 26, "raising the cap — the remedy the failure hint prints — did nothing");
});

test("an unset or nonsensical cap falls back to the constant", async () => {
  // The handler passes a raw config object through. A cap of 0 would turn every
  // agent into one that never runs, and that must not be reachable from a
  // settings file.
  for (const turnCap of [undefined, null, 0, -3, 2.5, "12"]) {
    const { turns } = await turnsTaken({ turnCap });
    assert.equal(turns, AGENT_TURN_CAP, `a cap of ${JSON.stringify(turnCap)} was taken literally instead of rejected`);
  }
});

test("a per-call allowance still wins over the setting", async () => {
  // s3 scales its researchers with the finding target, and that has to survive
  // a deployment whose global cap is lower.
  const { turns } = await turnsTaken({ turnCap: 12, maxTurns: 26 });
  assert.equal(turns, 26, "the per-call maxTurns was overridden by the global setting, so s3 cannot size its own work");
});

test("the researcher gets turns in proportion to the findings it is asked for", () => {
  // Read from the source: the call is inside a per-dimension closure with no
  // seam, and the regression is a one-line revert to the bare constant.
  const source = readFileSync(new URL("../lib/mission-stages-front.js", import.meta.url), "utf8");
  const open = source.indexOf("async function collectOneDimension");
  assert.ok(open > 0, "collectOneDimension moved; this guard is looking at nothing");
  const body = source.slice(open, source.indexOf("\n}", open));

  assert.match(
    body,
    /maxTurns:\s*Math\.max\(turnCapOf\(deps\),\s*2 \* \(Number\(policy\?\.findingTarget\) \|\| 0\)\)/,
    "the researcher's turn allowance no longer scales with the findings it is asked to collect, so raising a tier's "
    + "target silently starves it again",
  );
});

test("the deep tier's quota does not fit inside the default cap", () => {
  // The reason the scaling has to exist at all, stated as arithmetic rather
  // than as a story: if this ever stops being true the scaling is dead weight
  // and should be deleted rather than left looking load-bearing.
  const deep = TIER_POLICY.deep;
  assert.ok(
    2 * deep.findingTarget > AGENT_TURN_CAP,
    `deep asks for ${deep.findingTarget} findings, which fits in the default cap of ${AGENT_TURN_CAP} turns — `
    + "the per-call scaling is now a no-op and should be removed rather than kept as decoration",
  );
  // Two turns per finding is the ratio that WORKED: at a target of 6, the cap
  // of 12 was never reached. Anchored here so the multiple is not quietly tuned.
  assert.equal(2 * 6, AGENT_TURN_CAP, "the ratio this scaling was derived from no longer matches the default cap");
});
