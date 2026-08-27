// A bad second at the provider is not a failed mission.
//
// A twelve-stage deep mission runs for hours across hundreds of model calls.
// One of them came back "Connection error." on turn 3 of s4-assess and the
// whole run ended: `failed_model` propagated out of the agent loop, the mission
// was marked `model_error`, and three hours of collected evidence sat there
// waiting for somebody to press rerun. The diagnostic even said what had
// happened — "re-run when the provider recovers" — which is a thing the process
// can do for itself.
//
// Only TRANSPORT failures are re-issued. A connection error never reached the
// provider and nothing about the request was rejected; a 400 is an ANSWER, and
// re-issuing it spends the same money for the same reply.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMissionChat } from "../lib/mission-agent.js";

const CONNECTION_ERROR = Object.freeze({ message: "Connection error.", code: null, status: null });

const MESSAGES = [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }];

/**
 * A ctx whose model fails `failures` times before answering.
 *
 * `transportBackoffMs` is the documented seam: without it this file would sit
 * out fifteen real seconds to prove three retries.
 */
function stub(failures, { failure = CONNECTION_ERROR, text = "the answer", onAttempt = null, backoff = [1, 1, 1] } = {}) {
  const state = { attempts: 0 };
  const ctx = {
    transportBackoffMs: backoff,
    agentDefaultModel: { currentSelection: () => ({ provider: "stub", model: "stub-1" }) },
    llm: {
      async *stream() {
        state.attempts += 1;
        onAttempt?.();
        if (state.attempts <= failures) {
          yield { type: "finish", reason: { kind: "error", failure } };
          return;
        }
        yield { type: "text-delta", id: "t", text };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  return { state, ctx };
}

/** Run one agent over the stub, the way a stage does. */
const run = (ctx, extra = {}) => createMissionChat(ctx)({
  agent: "researcher", stepId: "s3-collect", system: "sys", messages: MESSAGES, tools: [], ...extra,
});

test("a connection error is re-issued, not turned into a failed mission", async () => {
  const { state, ctx } = stub(2);
  const result = await run(ctx);

  assert.equal(state.attempts, 3, "the turn was not re-issued after a failure that never reached the provider");
  assert.equal(
    result.state,
    "completed",
    `a transient connection error still ended the run: ${result.failureCode} — ${result.diagnostic}`,
  );
  assert.equal(String(result.output), "the answer");
});

test("re-issuing is bounded, so an outage is still reported", async () => {
  // The provider being down for a minute must not become an agent that spins
  // against it until the mission's wall clock runs out.
  const { state, ctx } = stub(99);
  const result = await run(ctx);

  assert.equal(state.attempts, 4, `the loop made ${state.attempts} attempts; the bound is one call and three re-issues`);
  assert.equal(result.state, "failed", "an outage that outlasts the retries has to surface as a failure");
  assert.equal(result.failureCode, "model_error");
});

test("a refusal is an answer, and answers are not re-issued", async () => {
  // 400 means the request landed and was rejected. Sending it again buys the
  // same rejection at the same price.
  for (const status of [400, 401, 403, 404, 422]) {
    const { state, ctx } = stub(99, { failure: { message: "bad request", code: null, status } });
    const result = await run(ctx);
    assert.equal(state.attempts, 1, `HTTP ${status} was re-issued; it is an answer, not an outage`);
    assert.equal(result.state, "failed", `HTTP ${status} must still be reported`);
  }
});

test("the statuses that mean the request never landed are re-issued", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const { state, ctx } = stub(1, { failure: { message: "upstream", code: null, status } });
    const result = await run(ctx);
    assert.equal(state.attempts, 2, `HTTP ${status} was not re-issued, so a routine upstream blip ends the mission`);
    assert.equal(result.state, "completed", `HTTP ${status} recovered but the run still failed`);
  }
});

test("the provider's own interval is honoured over the default ladder", async () => {
  // A 429 that says how long to wait is the one case where guessing is worse
  // than reading, and honouring it is also what keeps the next attempt from
  // being rejected the same way. The ladder here is long enough that ignoring
  // the interval would take a full second.
  const { state, ctx } = stub(1, {
    failure: { message: "slow down", code: null, status: 429, providerRetryAfterMs: 5 },
    backoff: [1_000],
  });
  const started = process.hrtime.bigint();
  await run(ctx);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(state.attempts, 2);
  assert.ok(
    elapsedMs < 500,
    `the retry waited ${Math.round(elapsedMs)}ms, so the provider's 5ms interval was ignored for the default ladder`,
  );
});

test("an abort during the wait stops the loop instead of sleeping through it", async () => {
  // Cancelling a mission has to be felt while the loop is BETWEEN attempts, not
  // only while it is streaming. The ladder here is long enough that a sleep
  // ignoring the signal would hang this test rather than fail it.
  const controller = new AbortController();
  const { state, ctx } = stub(99, { backoff: [30_000], onAttempt: () => controller.abort() });

  const started = process.hrtime.bigint();
  const result = await run(ctx, { signal: controller.signal });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(elapsedMs < 5_000, `the loop slept ${Math.round(elapsedMs)}ms through a cancelled mission`);
  assert.equal(state.attempts, 1, "a cancelled mission kept re-issuing its turn");
  assert.equal(result.state, "failed");
  // And it does not SAY it was retrying. The check that skips the wait and the
  // check that catches an abort arriving during the wait are two different
  // guards, and without the first one a cancelled run still writes a
  // "re-issuing, waiting 30s" line into its own trace before stopping.
  assert.equal(
    (result.events ?? []).filter((event) => event.type === "model:transport-retry").length,
    0,
    "a cancelled run announced a retry it never made",
  );
});

test("the characters an abandoned attempt streamed are still counted", async () => {
  // The pool paid for them. A retry that reported only the winning attempt's
  // estimate would make the meter drift below the truth every time the provider
  // hiccuped, and the estimator is tuned against that number.
  const state = { attempts: 0 };
  const ctx = {
    transportBackoffMs: [1],
    agentDefaultModel: { currentSelection: () => ({ provider: "stub", model: "stub-1" }) },
    llm: {
      async *stream() {
        state.attempts += 1;
        // Both attempts stream text; the first one then fails.
        yield { type: "text-delta", id: "t", text: "x".repeat(400) };
        yield state.attempts === 1
          ? { type: "finish", reason: { kind: "error", failure: CONNECTION_ERROR } }
          : { type: "finish", reason: { kind: "stop" } };
      },
    },
  };

  const oneAttempt = await run({ ...ctx, llm: { async *stream() {
    yield { type: "text-delta", id: "t", text: "x".repeat(400) };
    yield { type: "finish", reason: { kind: "stop" } };
  } } });
  const retried = await run(ctx);

  assert.equal(state.attempts, 2);
  assert.ok(
    retried.tokens.estimated > oneAttempt.tokens.estimated,
    `the retried run estimated ${retried.tokens.estimated} against ${oneAttempt.tokens.estimated} for a single attempt, `
    + "so the abandoned attempt's streamed characters were dropped from the meter",
  );
});
