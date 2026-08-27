/**
 * The agent seam: one ReAct loop, and the finalize gate that makes it reliable.
 *
 * Every mission stage that talks to a model talks to it through here. No stage
 * writes its own loop, no stage accumulates a delta, no stage builds a
 * tool-result message. If a file under `lib/mission/` contains the string
 * "tool-call-delta", it is wrong.
 *
 * This is lifted from `spike/insight-spike.mjs`, which measured the following
 * against the real model and the real web, and is being deleted:
 *
 *   1. NATIVE TOOL CALLS WORK. 830 tool-call-deltas, 19 calls, zero unparseable
 *      arguments, zero unknown tools. The action protocol is native `tools` on
 *      `ctx.llm.stream`, not a hand-rolled text envelope. The JSON-parse guard
 *      below is therefore cheap insurance, not the design.
 *
 *   2. DELTAS ARE KEYED BY `chunk.id`, NEVER BY `chunk.index`. Index-keying
 *      works right up until the adapter interleaves two calls, and then it
 *      splices one call's arguments onto another's.
 *
 *   3. ONLY `aborted` AND `error` ARE FAILURES. `tool-calls` is the NORMAL end
 *      of an acting turn, `stop` the normal end of a speaking turn, and
 *      `max-tokens` a truncation. Treating every non-`stop` kind as an outage —
 *      which `lib/index.js`'s `createChat` still does at line 840 — makes a
 *      working tool call read as a dead provider. It cost the spike its first
 *      run and it is the single most expensive line in this repository.
 *
 *   4. A PROMPT DOES NOT HOLD A LOOP. The same topic produced six fetched pages
 *      and six findings on one run, then two searches and a `finish` on the
 *      next, and the difference was not the topic. Only a refusal handed back
 *      to the model as an `isError` tool result made it reliable. Hence: the
 *      finalize gate here is CODE, the stage-specific gates that ride on it are
 *      CODE, and neither is ever a sentence in a SKILL.md.
 *
 *   5. A REFUSAL IS NOT AN EMPTY RESULT. `isError: true` with a sentence saying
 *      what to do instead, versus `{empty:true, reason}` with no `isError`.
 *      Collapsing those two is this repository's signature bug, and
 *      `mission-tools.js`'s door already refuses to.
 *
 * The one shape the spike got WRONG once, and it is worth naming because the
 * failure was silent: a tool result is `toolCallId` plus a `content` ARRAY OF
 * BLOCKS. Anything else and the adapter drops the result, so the model sees a
 * tool it called and never heard back from — which it answers by calling it
 * again, and again, until the turn cap.
 *
 * WHAT THIS MODULE DOES NOT DO: it never touches the store, never emits a
 * mission event, never opens a transaction. The `events` array it returns is
 * LOCAL DIAGNOSTIC DATA whose type strings are deliberately NOT members of
 * `EVENT_TYPES` — handing one of them to a handler's `emit()` throws inside
 * that emit's transaction and rolls back whatever else the transaction held.
 * Fold them into the stage's `output`, never into `emit`.
 *
 * @see design §3.7 — the agent loop and the finalize gate.
 * @see design §8.3, §8.5 — token accounting and the context window.
 */

import { FAILURE_CODES, classifyFailure } from "./mission-runtime.js";
import {
  TOOL_CODES,
  invokeMany,
  recallTools,
  validateArgs,
} from "./mission-tools.js";

/* ── vocabulary ─────────────────────────────────────────────────────────── */

/**
 * How many model turns one agent gets before the loop is cut.
 *
 * 12 is the spike's measured `MAX_TURNS`, not a round number: the researcher
 * that fetched six pages and recorded six findings used nine of them.
 * Overridable per call via `maxTurns`, which is where the `missionTurnCap`
 * setting lands.
 */
export const AGENT_TURN_CAP = 12;

/**
 * How many times a `finalize` candidate may be sent back before it is accepted.
 *
 * Three, and the critiques are CUMULATIVE — every round's issues are re-shown
 * rather than replaced, so the model does not fix issue two by re-introducing
 * issue one. On the fourth the current candidate is force-accepted as
 * `degraded`, because a loop that can refuse for ever is a loop that ends at
 * the turn cap with nothing to show for the whole stage.
 */
export const MAX_FINALIZE_REJECTS = 3;

/**
 * Every reason an agent run can end, most severe first.
 *
 * The order is the reference's and it is load-bearing: when two conditions are
 * true at once, the earlier one is reported. `empty_response` is inserted after
 * `failed_parse` — design §3.7's list predates the sub-classification, and a
 * turn that said nothing is a model-side failure of the same family.
 *
 * THE EXIT REASON IS DECIDED ONCE, AT THE POINT OF DECISION, and carried on the
 * result. Playground has four internal stop reasons, emits five strings, and
 * its own extractor then mis-maps a timeout onto a budget code; the caller
 * there has to scrape the real reason back out of an event array. Never build
 * that.
 */
export const EXIT_REASONS = Object.freeze([
  "cancelled",
  "failed_tool",
  "failed_model",
  "failed_parse",
  "empty_response",
  "budget_exhausted",
  "context_exceeded",
  "wall_time",
  "max_iterations",
  "validation_rejected_max",
  "completed",
]);

/**
 * Exit reason → the `FAILURE_CODES` member a stage should throw with.
 *
 * `null` means "not a mission failure": `max_iterations` and
 * `validation_rejected_max` are DEGRADED outcomes that still carry an output,
 * and `completed` is success. Totality over `EXIT_REASONS` is asserted at
 * import — an exit reason with no entry would fall through to `model_error` and
 * tell the user to check a provider that was never involved.
 *
 * `cancelled` maps to `user_cancelled` only as a floor: when a signal is
 * present, `classifyFailure` reads `signal.reason` and wins, because the abort
 * vocabulary is authoritative and a wall-time abort is not a user cancellation.
 */
export const EXIT_REASON_TO_FAILURE = Object.freeze({
  cancelled: "user_cancelled",
  failed_tool: "tool_unavailable",
  failed_model: "model_error",
  failed_parse: "model_error",
  empty_response: "model_error",
  budget_exhausted: "budget_exhausted",
  context_exceeded: "context_exceeded",
  wall_time: "wall_time_exceeded",
  max_iterations: null,
  validation_rejected_max: null,
  completed: null,
});

/** The three states a run can settle in. `degraded` always carries an output. */
export const AGENT_STATES = Object.freeze(["completed", "degraded", "failed"]);

/**
 * The four reasons a quote can fail verification, and the ONLY four.
 *
 * They are separate values rather than one "bad quote" because a rate-limited
 * fetch and a fabricated quote are different events. Telling a model it
 * invented a quote it did not invent teaches it to distrust its own correct
 * behaviour, and that is a permanent cost paid for a wrong label.
 */
export const QUOTE_FAILURES = Object.freeze({
  TOO_SHORT: "too_short",
  NO_SUCH_SOURCE: "no_such_source",
  NOT_FOUND_IN_SOURCE: "not_found_in_source",
  COULD_NOT_FETCH: "could_not_fetch",
});

/** The wording each quote failure earns. Never an accusation; see QUOTE_FAILURES. */
const QUOTE_FAILURE_SENTENCES = Object.freeze({
  too_short: (quote, source) => `The quote ${quote} attributed to ${source} is too short to identify a passage. Quote a longer continuous run of the source's own words.`,
  no_such_source: (quote, source) => `The quote ${quote} names ${source}, which is not among the sources you have read. Quote from a page you fetched, or fetch that page first.`,
  not_found_in_source: (quote, source) => `The quote ${quote} was not found in ${source}. It may have been paraphrased, or two passages may have been joined; copy one continuous run of text exactly as it appears.`,
  could_not_fetch: (quote, source) => `${source} could not be read, so the quote ${quote} could not be checked. This is not a judgement about the quote — the page was unavailable. Use a source that was fetched successfully.`,
});

/**
 * The spike's measured refusal for a `finish` that read nothing, verbatim.
 *
 * Exported so `s3-collect`'s G1 reuses this string rather than re-wording it.
 * Two wordings of one refusal is the same defect as two names for one method,
 * and this particular wording is the one that was measured to work.
 */
export const READ_NOTHING_REFUSAL =
  "you have not read a single page. A search result is a title and an abstract; "
  + "nothing in it can be quoted. Fetch the most promising candidates and then "
  + "record what they say.";

/**
 * The refusal for a dimension covered from ONE host.
 *
 * Measured: a mission searched eighty-six times, fetched thirteen pages across
 * eight dimensions, and every dimension that produced anything produced it from
 * exactly ONE host — six findings from a single page, or nothing. The
 * researcher treats "I found a good page" as "this dimension is done", and the
 * floor it is held to asks for two independent sources.
 *
 * @param hosts - how many distinct hosts have been read.
 * @param needed - how many independent sources this dimension's floor wants.
 * @returns the refusal text.
 */
export const oneHostRefusal = (hosts, needed) =>
  `every page you have read comes from ${hosts === 1 ? "one host" : `${hosts} hosts`}, and this dimension is `
  + `held to ${needed} independent sources. One site agreeing with itself is one source however many `
  + `pages you read on it. Fetch from a different host before finishing, or say in your summary which `
  + `other hosts you tried and why they could not be used.`;

/**
 * How many times a prose answer is sent back before the run gives up.
 *
 * Measured: s8-write answered in prose on turn 1, the run ended there, and the
 * eleven verified findings behind it went nowhere. The same shape as a `finish`
 * that read nothing — the model complies once the refusal reaches it, and
 * killing the run on the first occurrence never let it.
 */
const MAX_PROSE_RETRIES = 2;

/** Estimated completion tokens accumulated before the pool is asked again. */
const ESTIMATE_FLUSH_TOKENS = 200;

/** Characters of a tool result the model is shown before it is truncated. */
const TOOL_RESULT_CHARS = 12_000;

// Boot assertions. A vocabulary that has drifted is discovered here, at import,
// rather than on the one run where the branch fires — the pattern
// `mission-runtime.js` already uses for ABORT_REASONS and FAILURE_CODES.
for (const reason of EXIT_REASONS) {
  if (!Object.hasOwn(EXIT_REASON_TO_FAILURE, reason)) {
    throw new Error(`mission-agent: exit reason "${reason}" has no entry in EXIT_REASON_TO_FAILURE. Add one — an unmapped reason falls through to model_error and blames a provider that was never involved.`);
  }
  const code = EXIT_REASON_TO_FAILURE[reason];
  if (code !== null && !FAILURE_CODES.includes(code)) {
    throw new Error(`mission-agent: exit reason "${reason}" maps to failure code "${code}", which is not in FAILURE_CODES. finalizeMissionRow asserts membership inside its own transaction, so this would roll back the terminal write and leave the row running for ever.`);
  }
}

/* ── message shapes ─────────────────────────────────────────────────────── */

/**
 * One tool result message, in the shape the provider actually expects.
 *
 * `toolCallId` plus a `content` ARRAY OF BLOCKS — read out of `ToolResultBlock`
 * in `@deepseek-ai/dsh-llm` rather than guessed. The spike got this wrong once
 * and the adapter silently dropped every result; the model then saw a tool it
 * called and never heard back from, and answered by calling it again.
 *
 * @param call - the accumulated call, whose `id` is the correlation key.
 * @param value - the observation, JSON-serialised for the model.
 * @param isError - true only for a REFUSAL, which must say what to do instead.
 * @returns a tool message ready to push onto the transcript.
 */
export function toolResult(call, value, isError = false) {
  return {
    id: `t-${call.id}`,
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: call.id,
      content: [{ type: "text", text: safeJson(value).slice(0, TOOL_RESULT_CHARS) }],
      ...(isError ? { isError: true } : {}),
    }],
    source: { kind: "tool" },
  };
}

/**
 * The assistant turn, pushed BEFORE any tool runs.
 *
 * Before, not after: a tool that throws, times out or aborts must still leave a
 * transcript in which the model's own call is present. Otherwise a retry
 * re-sends a history where the assistant never asked for anything, and the
 * model has no idea why it is being shown a result.
 * @param turn - the iteration index, for a stable message id.
 * @param text - the assistant's prose this turn, possibly empty.
 * @param calls - the accumulated tool calls.
 * @returns the assistant message.
 */
function assistantTurn(turn, text, calls) {
  return {
    id: `a-${turn}`,
    role: "assistant",
    content: [
      ...(text === "" ? [] : [{ type: "text", text }]),
      ...calls.map((call) => ({ type: "tool-call", id: call.id, name: call.name, arguments: call.args })),
    ],
    source: { kind: "assistant" },
  };
}

/**
 * A user-role observation, for facts that answer no particular call.
 *
 * The circuit's notices arrive this way rather than folded into the last tool
 * result, because a tool result whose blocks are not all tool-result blocks is
 * the shape the adapter drops — the exact failure at the top of this file.
 * @param turn - a suffix for the message id.
 * @param text - the sentences to show.
 * @returns the user message.
 */
function noticeMessage(turn, text) {
  return {
    id: `n-${turn}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

/**
 * Project a registry tool onto the three fields the provider is sent.
 *
 * `getTool` returns `execute`, `capabilities`, `circuit`, `paceKey` and more.
 * Sending those is at best wasted prompt and at worst a serialisation failure
 * on the function. `whenToUse` is folded into the description because it is the
 * field that actually changes tool choice, and it costs one line.
 * @param tool - a registry definition, or an already wire-shaped object.
 * @returns `{name, description, parameters}`.
 */
export function wireTool(tool) {
  const when = typeof tool?.whenToUse === "string" && tool.whenToUse !== "" ? `\n\nWhen to use: ${tool.whenToUse}` : "";
  return {
    name: String(tool?.name ?? ""),
    description: `${String(tool?.description ?? "")}${when}`,
    parameters: tool?.parameters ?? { type: "object", properties: {} },
  };
}

/**
 * Build the `finalize` tool whose `parameters` IS the agent's output schema.
 *
 * Declaring the output as a tool is what makes the provider enforce the shape
 * before we ever see it — the highest-value line in the seam. A finalize CALL
 * is still not a termination: it goes through the gate below.
 * @param schema - the JSON schema of the agent's output.
 * @param options - `{name, description}` overrides.
 * @returns a wire tool.
 */
export function finalizeToolFor(schema, options = {}) {
  return {
    name: String(options.name ?? "finalize"),
    description: String(options.description
      ?? "Submit your finished answer. Call this exactly once, when the work is done. "
      + "Your answer is checked before it is accepted; if something is wrong you will be told what, and you may call this again."),
    parameters: schema ?? { type: "object", properties: {} },
  };
}

/**
 * One quote-verification issue, for the critique design §3.7 calls variant (b).
 * @param quote - the failing quote, verbatim.
 * @param source - the source it was attributed to.
 * @param reason - a `QUOTE_FAILURES` member.
 * @returns an issue object a `checkFinalize` may return.
 */
export function quoteIssue(quote, source, reason) {
  return { kind: "quote", quote: String(quote ?? ""), source: String(source ?? ""), reason: String(reason ?? "") };
}

/* ── the loop ───────────────────────────────────────────────────────────── */

/**
 * Build the agent seam over one Cordis context.
 *
 * @param ctx - the context carrying `llm`, `agentDefaultModel`, optionally
 *   `tokenMeter`, and the `web` seam behind `ctx.get("web")`.
 * @param options - `{logger}`; the logger may be null and is always optional-called.
 * @returns `runAgent(request)` — one agent run to completion.
 */
export function createMissionChat(ctx, { logger = null } = {}) {
  /**
   * Run one agent to completion.
   *
   * @param request - identity, prompt, tool seams, finalize gate and accounting;
   *   every field is documented at the destructuring below.
   * @returns `{output, state, exitReason, failureCode, diagnostic, recoveryHint,
   *   iterations, wallMs, tokens, toolsUsed, messages, events, …}`.
   */
  return async function runAgent(request = {}) {
    const {
      // identity — what is running, for whom, under which duty
      // `agent` is the ROLE and stays the role: prompts are looked up by it and
      // `mission_spend.role` is grouped by it. `agentId` is the INSTANCE — the
      // one researcher of five that this call is — and it is what the tool
      // ledger and the spend row record.
      //
      // THE LOOP RULE DEPENDS ON THIS DISTINCTION AND DID NOT HAVE IT.
      // `detectNoProgress` keys repeats on `agentId::tool::argsHash` and kills a
      // run at three, precisely so that a loop is counted "where a loop can
      // happen, which is inside one agent". The ledger stored the role, so five
      // parallel researchers were ONE agent to that rule and three dimensions
      // fetching the same authoritative page looked like one agent fetching it
      // three times. Measured: a fresh run died forty seconds into s3-collect
      // with "researcher called fetch_page 3 times with identical arguments".
      // The instance id existed only in mission-view.js, synthesised at READ
      // time, so nothing on the write path could tell the five apart.
      agent = "", agentId = null, stepId = "", missionId = "", runCount = 0, duty = "",
      // the prompt
      system = "", messages: seedMessages = [], tools: seedTools, toolContext = {}, spec = {}, facet,
      // the call
      maxTokens, maxTurns = AGENT_TURN_CAP, signal, language = "zh",
      // the seams the tool door needs
      budget, circuit, cache, spillDir, ledger,
      // the finalize gate
      finalizeTool, checkFinalize,
      // context accounting
      inputBudgetTokens = 0, shrinkLadder = [], shrinkFrom = 0, shrink,
      // settlement
      onUsage, now = () => new Date().toISOString(),
    } = request;

    const zh = language !== "en";
    const startedAt = Date.now();
    // The caller's array is never mutated: a stage that retries must be able to
    // re-send the seed it built rather than the transcript of the failed try.
    const messages = seedMessages.map((message) => message);
    const events = [];
    const toolsUsed = [];
    const toolStats = { total: 0, ok: 0, refused: 0, empty: 0, byTool: {} };
    const tokens = { prompt: 0, completion: 0, cacheRead: 0, estimated: 0, total: 0 };
    const critiqueRounds = [];
    let candidate;
    let rejects = 0;
    let iterations = 0;
    let proseRetries = 0;
    let truncations = 0;
    let reAskedAfterTruncation = false;
    let rung = Number.isInteger(shrinkFrom) ? shrinkFrom : 0;
    let didWork = false;
    let stopStage = false;
    let stopReason = null;
    let usageSettled = false;
    let usageWhy = null;

    const finalizeName = finalizeTool === undefined || finalizeTool === null
      ? null
      : String(finalizeTool.name ?? "finalize");
    const note = (type, detail = {}) => { events.push({ at: now(), type, ...detail }); };

    /** Settle the run once, with the reason decided at the point of decision. */
    const settle = (exitReason, { output, diagnostic, failureCode, stateOverride } = {}) => {
      const state = stateOverride ?? stateFor(exitReason, { hasOutput: output !== undefined && output !== null, didWork });
      let code = failureCode ?? EXIT_REASON_TO_FAILURE[exitReason] ?? null;
      // The abort vocabulary outranks the local map: a wall-time abort is not a
      // user cancellation, and `classifyFailure` is the one place that knows.
      if (state === "failed" && (exitReason === "cancelled" || signal?.aborted === true)) {
        code = classifyFailure({ signal, error: null, fallbackCode: code ?? "model_error" }).code;
      }
      tokens.total = tokens.prompt + tokens.completion + tokens.cacheRead;
      return {
        output: output ?? null,
        state,
        exitReason,
        failureCode: code,
        diagnostic: diagnostic ?? describeExit(exitReason, zh),
        recoveryHint: recoveryHintFor(exitReason, zh),
        iterations,
        wallMs: Date.now() - startedAt,
        tokens,
        toolsUsed,
        toolStats,
        messages,
        events,
        stopStage,
        stopReason,
        truncations,
        finalizeRejects: rejects,
        // Never silent: a run whose spend row was not written says so, rather
        // than letting the stage assume its cost was recorded.
        spend: { recorded: usageSettled, why: usageWhy },
      };
    };

    for (; iterations < maxTurns; iterations += 1) {
      // ── the per-iteration ladder, in design §3.7's order ────────────────

      // 1. aborted. Read the reason; never a regex over it.
      if (signal?.aborted === true) {
        const reason = typeof signal.reason === "string" ? signal.reason : "user_cancelled";
        const exit = reason === "wall_time_exceeded" ? "wall_time" : reason === "budget_exhausted" ? "budget_exhausted" : "cancelled";
        return settle(exit, {
          output: candidate,
          stateOverride: "failed",
          diagnostic: zh
            ? `运行在第 ${iterations + 1} 轮开始前被中止：${reason}。`
            : `The run was aborted before turn ${iterations + 1}: ${reason}.`,
        });
      }

      // 2. budget. `isExhausted` uses >= on every dimension and `ratio()` NAMES
      //    the tight one — an unnamed scalar would be tokens-only, so a mission
      //    that burned 100% of max_arxiv at 20% of tokens would never warn and
      //    would just start failing tool calls with no explanation.
      if (budget?.isExhausted?.() === true) {
        const tight = safeRatio(budget);
        note("budget:drained", { turn: iterations, ...tight });
        return settle("budget_exhausted", {
          output: candidate,
          diagnostic: zh
            ? `预算在第 ${iterations + 1} 轮开始前耗尽（${tight.dimension ?? "未知维度"} ${tight.used ?? "?"}/${tight.limit ?? "?"}）。`
            : `The budget drained before turn ${iterations + 1} (${tight.dimension ?? "unknown dimension"} ${tight.used ?? "?"}/${tight.limit ?? "?"}).`,
        });
      }

      // 3. the catalogue, resolved PER CALL. The web seam is answered for right
      //    now, and a tool the circuit banned leaves the list on the very next
      //    turn AND is explained rather than silently withdrawn.
      const catalogue = resolveCatalogue({ ctx, agent, spec, circuit, facet, seedTools });
      for (const sentence of catalogue.notices) note("tool:notice", { sentence });
      if (finalizeName !== null && catalogue.tools.some((tool) => String(tool?.name) === finalizeName)) {
        throw Object.assign(
          new Error(`mission-agent: the finalize tool is named "${finalizeName}", which is also a registry tool in ${agent || "this agent"}'s catalogue. The loop would dispatch the model's own answer through the tool door and it would come back refused. Rename the finalize tool.`),
          { code: "input_invalid" },
        );
      }
      const wire = [
        ...catalogue.tools.map(wireTool),
        ...(finalizeName === null ? [] : [wireTool(finalizeTool)]),
      ];

      // 4. context. Estimate, then run the NAMED shrink ladder rung by rung.
      const fitted = await fitContext({
        ctx, system, messages, wire, inputBudgetTokens, shrinkLadder, rung, shrink, note, logger,
      });
      rung = fitted.rung;

      // 5. the seam. The route is resolved PER CALL — `agentDefaultModel`
      //    exposes a method, not fields, because the settings document can
      //    replace the selection between two calls of one mission.
      const route = ctx.agentDefaultModel.currentSelection();
      const turn = await streamTurnResiliently(
        { ctx, route, system: fitted.system, messages, tools: wire, maxTokens, signal, budget, note },
        { note, signal },
      );

      // 6. usage. ONE chunk, at the end. The live pool is an ESTIMATE and
      //    SUM(mission_spend) is exact; both are recorded, because they are two
      //    different quantities and keeping one makes the estimator untunable.
      tokens.estimated += turn.estimated;
      if (turn.usage !== null) {
        tokens.prompt += turn.usage.prompt;
        tokens.completion += turn.usage.completion;
        tokens.cacheRead += turn.usage.cacheRead;
        budget?.settle?.(turn.usage.raw);
        if (typeof onUsage === "function") {
          try {
            onUsage({
              missionId, stepId, runCount, duty,
              // ROLE stays the role — `spendByAgent` groups on it and a
              // per-dimension role would make the roster five rows of
              // "researcher:…" where it wants one. The INSTANCE goes to
              // `agentId`, which is the column the loop rule and the trajectory
              // read.
              role: agent === "" ? "code" : agent,
              agentId: agentId ?? (agent === "" ? null : agent),
              promptTok: turn.usage.prompt,
              completionTok: turn.usage.completion,
              cacheReadTok: turn.usage.cacheRead,
              estimatedTok: Math.round(turn.estimated),
              calls: 1,
              at: now(),
              usage: turn.usage.raw,
            });
            usageSettled = true;
          } catch (cause) {
            // A ledger write that throws must not take the mission with it —
            // the work is the thing the model produced. It is still not silent:
            // the loss rides back on the result's `spend.why`.
            usageWhy = `onUsage threw: ${String(cause?.message ?? cause)}`;
            logger?.warn?.(`mission-agent: onUsage threw for ${stepId}: ${String(cause?.message ?? cause)}`);
          }
        } else if (usageWhy === null) {
          usageWhy = "no onUsage callback was supplied, so no mission_spend row was written for this run";
        }
      } else if (usageWhy === null) {
        usageWhy = "the provider emitted no usage chunk, so only the character estimate is known for this run";
      }

      // 7. a terminal finish. ONLY `aborted` and `error` are failures.
      if (turn.failure !== null) {
        if (turn.failure.kind === "aborted") {
          return settle("cancelled", {
            output: candidate,
            stateOverride: "failed",
            diagnostic: zh
              ? `模型调用在第 ${iterations + 1} 轮被中止：${turn.failure.message}。`
              : `The model call was aborted on turn ${iterations + 1}: ${turn.failure.message}.`,
          });
        }
        // `failure.code` maps straight through classifyFailure's error-code
        // path, so CONTEXT_WINDOW_EXCEEDED becomes context_exceeded — a ROUTINE
        // outcome per §8.5 whose action is "re-run this stage at a smaller
        // batch size", not an anomaly to page anybody about.
        const carried = classifyFailure({
          signal: null,
          error: Object.assign(new Error(turn.failure.message), { code: turn.failure.code }),
          fallbackCode: "model_error",
        });
        return settle(carried.code === "context_exceeded" ? "context_exceeded" : "failed_model", {
          output: candidate,
          failureCode: carried.code,
          diagnostic: zh
            ? `模型在第 ${iterations + 1} 轮返回错误：${turn.failure.message}${turn.failure.status === null ? "" : `（HTTP ${turn.failure.status}）`}。`
            : `The model returned an error on turn ${iterations + 1}: ${turn.failure.message}${turn.failure.status === null ? "" : ` (HTTP ${turn.failure.status})`}.`,
        });
      }

      // 8. the mid-stream budget break. The pool drained while tokens were
      //    still arriving, so this turn is incomplete and its calls do not run.
      if (turn.brokeOnBudget === true) {
        note("budget:broke-mid-stream", { turn: iterations, ...safeRatio(budget) });
        return settle("budget_exhausted", {
          output: candidate,
          diagnostic: zh
            ? `预算在第 ${iterations + 1} 轮生成途中耗尽，该轮已中断，其中的工具调用没有执行。`
            : `The budget drained mid-generation on turn ${iterations + 1}; the turn was cut and its tool calls were not run.`,
        });
      }

      // 9. truncation. `max-tokens` is a truncation to NOTICE, not a refusal.
      //    Re-ask ONCE at the next rung when nothing actionable came back.
      if (turn.truncated === true) {
        truncations += 1;
        note("model:truncated", { turn: iterations, calls: turn.calls.length });
      }
      if (turn.truncated === true && turn.calls.length === 0) {
        // ONCE, and not conditional on a rung being left. `max-tokens` is an
        // OUTPUT truncation, so the instruction to answer more briefly is the
        // lever that actually addresses it; the input rung is a bonus that
        // `fitContext` takes on the next pass if one remains. Gating the re-ask
        // on `rung < shrinkLadder.length` made a stage that had already spent
        // its input ladder give up without ever asking again — which is the
        // give-up the "re-ask once before giving up" rule exists to prevent.
        if (!reAskedAfterTruncation) {
          reAskedAfterTruncation = true;
          note("model:re-ask", { rung, rungName: rung < shrinkLadder.length ? shrinkLadder[rung] : null });
          messages.push(noticeMessage(iterations, zh
            ? "上一轮输出被长度上限截断，没有产生完整的工具调用。请更简短地作答，并直接调用工具。"
            : "Your last turn was cut off by the output limit and produced no complete tool call. Answer more briefly and call a tool directly."));
          continue;
        }
        return settle("context_exceeded", {
          output: candidate,
          diagnostic: zh
            ? `第 ${iterations + 1} 轮被输出上限截断且没有完整的工具调用；本阶段应以更小的批次重跑。`
            : `Turn ${iterations + 1} was cut off by the output limit with no complete tool call; re-run this stage at a smaller batch size.`,
        });
      }

      // 10. an empty turn.
      if (turn.calls.length === 0) {
        // With no finalize gate in force, prose IS the product: this is the
        // normal end of a speaking turn, and `runAgentTurn` without a schema
        // depends on it. With a gate in force there is no such reading — the
        // stage's output must come through the tool the provider validates.
        if (finalizeName === null && turn.text.trim() !== "") {
          messages.push(assistantTurn(iterations, turn.text, []));
          return settle("completed", { output: turn.text, stateOverride: "completed" });
        }

        // Told, then asked again — not killed on the first occurrence.
        //
        // A model that writes the report as prose instead of submitting it
        // through `finalize` has made a recoverable mistake, and this ended the
        // whole mission over it: measured, s8-write failed at turn 1 and the
        // eleven verified findings behind it went nowhere. It is the same shape
        // as a `finish` that read nothing, and the spike settled that one — the
        // refusal has to reach the model, and once it does the model complies.
        if (turn.text.trim() !== "" && proseRetries < MAX_PROSE_RETRIES) {
          proseRetries += 1;
          note("model:prose-instead-of-tool", { turn: iterations, attempt: proseRetries });
          messages.push(assistantTurn(iterations, turn.text, []));
          messages.push(noticeMessage(iterations,
            zh
              ? `你用散文作答了，但本阶段的产出必须通过 ${finalizeName} 工具提交，否则没有任何内容会被记录。把你刚写的内容原样放进 ${finalizeName} 的参数里再提交一次。`
              : `You answered in prose, but this stage's output is only recorded when it is submitted through the ${finalizeName} tool. Call ${finalizeName} now with what you just wrote.`,
          ));
          continue;
        }

        note("model:empty-turn", { turn: iterations, hadText: turn.text.trim() !== "" });
        return settle("empty_response", {
          output: candidate,
          stateOverride: "failed",
          diagnostic: turn.text.trim() === ""
            ? (zh
              ? `第 ${iterations + 1} 轮既没有文字也没有工具调用：模型返回了空回合。`
              : `Turn ${iterations + 1} produced neither text nor a tool call: the model returned an empty turn.`)
            : (zh
              ? `第 ${iterations + 1} 轮只有散文、没有工具调用，被要求改用 ${finalizeName} 提交 ${proseRetries} 次后仍然如此。`
              : `Turn ${iterations + 1} answered in prose with no tool call, and still did so after being asked ${proseRetries} time(s) to submit through ${finalizeName}.`),
        });
      }

      // The assistant turn goes on the transcript BEFORE any tool runs.
      messages.push(assistantTurn(iterations, turn.text, turn.calls));

      // 11. dispatch. Unparseable arguments never reach the door, and neither
      //     does `finalize`: it is not a registry tool, so the door would
      //     refuse the model's own answer as `no_such_tool`.
      const results = new Array(turn.calls.length);
      const dispatch = [];
      const finalizeCalls = [];
      for (const [index, call] of turn.calls.entries()) {
        let args;
        try {
          args = call.args.trim() === "" ? {} : JSON.parse(call.args);
        } catch {
          note("tool:bad-json", { tool: call.name });
          results[index] = toolResult(call, { error: "your arguments were not valid JSON" }, true);
          continue;
        }
        if (finalizeName !== null && call.name === finalizeName) finalizeCalls.push({ call, index, args });
        else dispatch.push({ call, index, args });
      }

      if (dispatch.length > 0) {
        const observations = await invokeMany(
          dispatch.map((entry) => ({ tool: entry.call.name, args: entry.args, id: entry.call.id })),
          // BOTH, and the distinction is load-bearing: `agent` is the role the
          // tool ACL grants against, `agentId` is the instance the ledger
          // records. An earlier version passed the instance as `agent` and the
          // ACL — which falls back to an EMPTY grant on a miss — forbade every
          // tool in the run.
          { agent, agentId, spec, ctx: toolContext, signal, pool: budget, circuit, cache, ledger, spillDir, missionId, stepId },
        );
        for (const [at, entry] of dispatch.entries()) {
          const observation = observations[at] ?? {
            ok: false, tool: entry.call.name, code: TOOL_CODES.FAILED,
            error: `${entry.call.name} produced no observation. Do not retry it; use another tool.`,
          };
          recordTool(toolStats, toolsUsed, entry.call.name, observation);
          if (observation.ok === true && observation.empty !== true) didWork = true;
          // A refusal carrying `stopStage` is the door saying a seam is spent.
          // The observation still reaches the model, and the STAGE decides what
          // an honest empty outcome looks like; the loop only reports that it
          // stopped and which tool stopped it.
          if (observation.ok === false && observation.stopStage === true && stopReason === null) {
            stopStage = true;
            stopReason = { tool: entry.call.name, code: String(observation.code ?? ""), error: String(observation.error ?? "") };
          }
          results[entry.index] = toolResult(entry.call, observation, observation.ok === false);
        }
      }

      // 12. the finalize gate. A finalize CALL is not a termination.
      let accepted;
      let forced = null;
      for (const entry of finalizeCalls) {
        if (accepted !== undefined || forced !== null) {
          results[entry.index] = toolResult(entry.call, { error: `you called ${finalizeName} twice in one turn; only the first was read` }, true);
          continue;
        }
        const verdict = await gateFinalize({
          args: entry.args, finalizeTool, checkFinalize, spec,
          context: { agent, stepId, duty, iterations, toolsUsed, toolStats, messages },
        });
        candidate = verdict.candidate;
        if (verdict.issues.length === 0) {
          accepted = verdict.candidate;
          results[entry.index] = toolResult(entry.call, { accepted: true });
          continue;
        }
        rejects += 1;
        critiqueRounds.push(verdict.issues);
        note("finalize:rejected", { round: rejects, issues: verdict.issues.length });
        if (rejects > MAX_FINALIZE_REJECTS) {
          // Force-accept, with POISON SUPPRESSION. A broken half-JSON
          // downstream is worse than no output, because it looks like success.
          const poison = poisonOf(verdict.candidate, finalizeTool?.parameters);
          forced = { poison, issues: verdict.issues, output: poison === null ? verdict.candidate : emptyOfSchema(finalizeTool?.parameters) };
          note("finalize:force-accepted", { poison, rounds: rejects });
          results[entry.index] = toolResult(entry.call, { accepted: true, degraded: true });
          continue;
        }
        results[entry.index] = toolResult(entry.call, {
          error: renderCritique(critiqueRounds, finalizeTool?.parameters, finalizeName),
        }, true);
      }

      // Results are pushed in CALL ORDER, so every call the model made has its
      // answer where the model expects it.
      for (const [index, call] of turn.calls.entries()) {
        if (results[index] === undefined) {
          results[index] = toolResult(call, { error: `${call.name} produced no observation. Do not retry it; use another tool.` }, true);
        }
        messages.push(results[index]);
      }

      // Notices owed by the circuit ride on the NEXT observation: a banned tool
      // must be a fact the model can act on, not a silently narrowed catalogue
      // it keeps calling into and keeps being refused by.
      const owed = circuit?.drainNotices?.() ?? [];
      if (owed.length > 0) messages.push(noticeMessage(`c${iterations}`, owed.join(" ")));

      if (forced !== null) {
        return settle("validation_rejected_max", {
          output: forced.output,
          stateOverride: "degraded",
          diagnostic: forced.poison === null
            ? (zh
              ? `${finalizeName} 的产出被退回 ${MAX_FINALIZE_REJECTS} 次仍未通过检查，已按现状接受：${flattenIssues(forced.issues).join("；")}`
              : `${finalizeName} failed its checks after ${MAX_FINALIZE_REJECTS} rejections and was accepted as it stands: ${flattenIssues(forced.issues).join("; ")}`)
            : (zh
              ? `${finalizeName} 的产出被退回 ${MAX_FINALIZE_REJECTS} 次，最后一版是${forced.poison}，已丢弃并返回空产出——半截的 JSON 比没有产出更糟，因为它看起来像成功。`
              : `${finalizeName} was rejected ${MAX_FINALIZE_REJECTS} times and its final candidate was ${forced.poison}; it was discarded and an empty output returned, because broken half-JSON downstream looks like success.`),
        });
      }
      if (accepted !== undefined) {
        return settle("completed", { output: accepted, stateOverride: "completed" });
      }
      if (stopStage === true) {
        // DEGRADED, not failed: the stage must still be able to record honest
        // emptiness — `s3`'s G6 writes unchecked-rate-limited findings on
        // exactly this path. The six-line copy-paste block only throws on
        // `failed`, and the failure code still travels for a stage that wants
        // to escalate.
        const budgetStop = String(stopReason?.code ?? "").startsWith(TOOL_CODES.BUDGET_EXHAUSTED);
        return settle(budgetStop ? "budget_exhausted" : "failed_tool", {
          output: candidate,
          stateOverride: "degraded",
          diagnostic: zh
            ? `工具 ${stopReason?.tool} 让本阶段停止：${stopReason?.error}`
            : `The tool ${stopReason?.tool} stopped this stage: ${stopReason?.error}`,
        });
      }
    }

    // Falling out of the loop. NEVER `completed` — an agent that ran out of
    // turns did not finish, and calling that success is how a broken gate
    // reports a healthy count.
    note("loop:turn-cap", { maxTurns });
    return settle("max_iterations", {
      output: candidate,
      stateOverride: "degraded",
      diagnostic: zh
        ? `代理用满了 ${maxTurns} 轮仍未提交产出${candidate === undefined ? "，没有留下可用的候选结果。" : "，已采用它最后一份候选结果。"}`
        : `The agent used all ${maxTurns} turns without submitting an output${candidate === undefined ? " and left no candidate." : "; its last candidate was taken."}`,
    });
  };
}

/**
 * Run one agent over one task and stop when a predicate says the work is done.
 *
 * The named front door onto `runAgent`: a system prompt, a task, a tool set and
 * a completion predicate in; what the agent produced and what it spent out. The
 * predicate becomes the finalize gate's check, so "done" is decided by CODE
 * against a provider-validated candidate rather than asserted by the model —
 * which is the whole lesson of the spike in one parameter.
 *
 * @param options - `{chat, system, task, tools, schema, done, finalizeName}`
 *   plus anything else, which is passed straight through to `runAgent`.
 * @returns the same result `runAgent` returns.
 */
export async function runAgentTurn(options = {}) {
  const { chat, system = "", task = "", tools, schema, done, finalizeName = "finalize", ...rest } = options;
  if (typeof chat !== "function") {
    throw Object.assign(
      new Error("runAgentTurn: `chat` must be the runAgent returned by createMissionChat(ctx). Build it once per mission and pass it in — there is one agent seam and this is it."),
      { code: "input_invalid" },
    );
  }
  const messages = [{
    id: `u-${Date.now()}`,
    role: "user",
    content: [{ type: "text", text: String(task) }],
    source: { kind: "user" },
  }];
  return chat({
    ...rest,
    system,
    messages,
    tools,
    ...(schema === undefined ? {} : { finalizeTool: finalizeToolFor(schema, { name: finalizeName }) }),
    ...(typeof done === "function" ? { checkFinalize: done } : {}),
  });
}

/* ── internals ──────────────────────────────────────────────────────────── */

/** How many times a turn is re-issued after a TRANSPORT failure. */
const TRANSPORT_RETRIES = 3;

/**
 * Waits before each re-issue, in ms, when the provider names no interval.
 *
 * `ctx.transportBackoffMs` overrides it. That is the seam the tests drive the
 * loop through — a test that had to sit out five real seconds to prove one
 * retry would be deleted by the third person who ran the suite — and it is
 * equally the knob for a deployment whose link to the provider is worse than
 * this default assumes.
 */
const TRANSPORT_BACKOFF_MS = Object.freeze([1_000, 4_000, 10_000]);

/** The wait ladder in force, which `ctx` may replace. */
function backoffLadder(ctx) {
  const given = ctx?.transportBackoffMs;
  return Array.isArray(given) && given.length > 0 && given.every((ms) => Number.isFinite(Number(ms)))
    ? given.map(Number)
    : TRANSPORT_BACKOFF_MS;
}

/** HTTP statuses that mean "the request never landed"; anything else is an answer. */
const TRANSPORT_STATUSES = Object.freeze([408, 429, 500, 502, 503, 504]);

/**
 * Whether this failure is the provider being unreachable rather than refusing.
 *
 * `status === null` is the important case and the one that cost a mission: a
 * connection error never reached the provider, so there is no status to read
 * and nothing about the request was rejected. A 400 or a content filter is an
 * ANSWER and re-issuing it just spends the same money for the same reply.
 */
function isTransportFailure(failure) {
  if (failure === null || failure === undefined) return false;
  if (failure.kind !== "error") return false;
  if (failure.status === null || failure.status === undefined) return true;
  return TRANSPORT_STATUSES.includes(Number(failure.status));
}

/** A sleep that gives up the moment the mission is cancelled. */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) { resolve(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); resolve(); }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * One turn, re-issued while the provider is merely unreachable.
 *
 * A twelve-stage mission runs for hours across hundreds of model calls, and a
 * single "Connection error." on one of them used to end the whole thing:
 * `failed_model` propagated straight out of the loop, the run was marked
 * `model_error`, and three hours of collected evidence waited for somebody to
 * press rerun. That is the provider having a bad second, not the mission being
 * wrong, and the diagnostic even said so — "re-run when the provider recovers".
 *
 * Only TRANSPORT failures are re-issued, and only a bounded number of times.
 * The estimate from each abandoned attempt is carried into the result rather
 * than dropped: those characters were streamed and the pool paid for them.
 *
 * @param args - what `streamTurn` takes.
 * @param options - `{note, signal}`; `note` puts each re-issue in the trace.
 * @returns the last turn, with `estimated` summed over every attempt.
 */
async function streamTurnResiliently(args, { note, signal }) {
  let spentOnAbandoned = 0;
  for (let attempt = 0; ; attempt += 1) {
    const turn = await streamTurn(args);
    turn.estimated += spentOnAbandoned;
    const retryable = isTransportFailure(turn.failure)
      && attempt < TRANSPORT_RETRIES
      && signal?.aborted !== true;
    if (!retryable) return turn;

    spentOnAbandoned = turn.estimated;
    const ladder = backoffLadder(args?.ctx);
    const waitMs = Number(turn.failure.retryAfterMs) > 0
      ? Number(turn.failure.retryAfterMs)
      : ladder[Math.min(attempt, ladder.length - 1)];
    // In the trace, because a mission that quietly took four times as long as
    // its neighbour should say why.
    note("model:transport-retry", {
      attempt: attempt + 1,
      of: TRANSPORT_RETRIES,
      waitMs,
      status: turn.failure.status ?? null,
      message: turn.failure.message,
    });
    await pause(waitMs, signal);
    if (signal?.aborted === true) return turn;
  }
}

/**
 * Consume one model turn, accumulating deltas by `chunk.id`.
 *
 * The finish-reason branch is the most important thing in this function: only
 * `aborted` and `error` carry a `failure`, and only those two are failures.
 * @param options - the resolved route, the prompt and the seams.
 * @returns `{text, calls, usage, failure, truncated, estimated, brokeOnBudget}`.
 */
async function streamTurn({ ctx, route, system, messages, tools, maxTokens, signal, budget, note }) {
  const calls = [];
  let text = "";
  let estimated = 0;
  let unflushed = 0;
  let usage = null;
  let failure = null;
  let truncated = false;
  let brokeOnBudget = false;

  const chunks = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    system,
    messages,
    tools,
    ...(maxTokens === undefined || maxTokens === null ? {} : { maxTokens }),
    signal,
  });

  for await (const chunk of chunks) {
    if (chunk.type === "text-delta") {
      text += chunk.text;
      // There is no running token count — usage is one chunk at the end — so
      // the live pool runs on chars/4 and is honestly labelled an estimate.
      const delta = chunk.text.length / 4;
      estimated += delta;
      unflushed += delta;
      if (unflushed >= ESTIMATE_FLUSH_TOKENS) {
        budget?.estimate?.(Math.round(unflushed));
        unflushed = 0;
        if (budget?.isExhausted?.() === true) {
          // Break out of the generator the instant the pool drains. `break`
          // closes the iterator, which cancels the request; the overrun is then
          // bounded to one estimation error rather than one whole response.
          brokeOnBudget = true;
          break;
        }
      }
    } else if (chunk.type === "tool-call-delta") {
      // Keyed by `chunk.id`. Index-keying works until the adapter interleaves
      // two calls, and then it splices one call's arguments onto another's.
      const at = calls.findIndex((call) => call.id === chunk.id);
      if (at === -1) calls.push({ id: chunk.id, name: chunk.name ?? "", args: chunk.argumentsDelta ?? "" });
      else {
        calls[at].args += chunk.argumentsDelta ?? "";
        if (chunk.name) calls[at].name = chunk.name;
      }
    } else if (chunk.type === "usage") {
      usage = readUsage(chunk.usage);
    } else if (chunk.type === "finish") {
      const kind = chunk.reason?.kind;
      if (kind === "aborted" || kind === "error") {
        const raw = chunk.reason?.failure ?? {};
        failure = {
          kind,
          message: String(raw.message ?? kind),
          code: raw.code ?? null,
          status: raw.status ?? null,
          retryAfterMs: raw.providerRetryAfterMs ?? null,
        };
      } else if (kind === "max-tokens") {
        truncated = true;
      }
      // `tool-calls` and `stop` fall through ON PURPOSE. They are the two
      // NORMAL endings and neither of them is an outage.
      note("model:finish", { kind: kind ?? "unknown", calls: calls.length });
    }
  }

  if (unflushed > 0) budget?.estimate?.(Math.round(unflushed));
  return { text, calls, usage, failure, truncated, estimated, brokeOnBudget };
}

/**
 * Read the usage chunk into the four counts `mission_spend` stores.
 *
 * Several field spellings are accepted and the fact that NONE matched is
 * reported rather than absorbed: a silently zero usage row makes the estimator
 * permanently untunable and renders a mission that cost real money as free.
 * @param raw - the adapter's usage object.
 * @returns `{prompt, completion, cacheRead, total, source, raw}`, or null.
 */
export function readUsage(raw) {
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  const pick = (...names) => {
    for (const name of names) {
      if (Number.isFinite(raw[name])) return { value: Math.max(0, Math.round(raw[name])), name };
    }
    return { value: 0, name: null };
  };
  const prompt = pick("promptTokens", "inputTokens", "prompt_tokens", "input_tokens");
  const completion = pick("completionTokens", "outputTokens", "completion_tokens", "output_tokens");
  const cacheRead = pick("cacheReadTokens", "cachedInputTokens", "cache_read_input_tokens");
  const total = pick("totalTokens", "total_tokens");
  const matched = prompt.name !== null || completion.name !== null || total.name !== null;
  return {
    prompt: prompt.value,
    completion: completion.value,
    cacheRead: cacheRead.value,
    total: total.value === 0 ? prompt.value + completion.value + cacheRead.value : total.value,
    source: matched
      ? "fields"
      : "no recognised field: the adapter's usage shape is not one this reader knows, so these counts are zero for that reason and NOT because the call was free",
    raw,
  };
}

/**
 * Read ONE SETTLEMENT — the record the seam hands `onUsage` — into the four
 * counts `mission_spend` stores.
 *
 * WHY THIS EXISTS AND WHAT IT COST NOT TO HAVE IT: the seam calls `onUsage`
 * with a RECORD — `{missionId, stepId, promptTok, completionTok, cacheReadTok,
 * estimatedTok, calls, usage}` — and two of the three recorders passed that
 * record straight to `readUsage`, which looks for `promptTokens` /
 * `inputTokens` and finds neither on a record. Every collection turn was
 * therefore priced at ZERO. Measured on a real mission: 25 researcher calls and
 * 6 leader calls recorded 0 tokens between them, so the token ceiling — the
 * one allowance meant to bound the most expensive stage — could never bind.
 *
 * Three shapes are accepted, in this order, because all three exist in the
 * codebase and picking one and breaking the others is how this was introduced:
 *   1. the settlement record (`promptTok`, …) — what the seam actually sends
 *   2. a record carrying the adapter's own object under `usage`
 *   3. a bare adapter usage object — what `readUsage` was written for
 *
 * @param record - the settlement record, or a raw usage object.
 * @returns `{prompt, completion, cacheRead, estimated, calls, total, source, raw}`, or null.
 */
export function readSettlement(record) {
  if (record === undefined || record === null || typeof record !== "object") return null;
  const counted = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : null);
  const prompt = counted(record.promptTok);
  const completion = counted(record.completionTok);
  const cacheRead = counted(record.cacheReadTok);
  if (prompt !== null || completion !== null || cacheRead !== null) {
    const total = (prompt ?? 0) + (completion ?? 0) + (cacheRead ?? 0);
    return {
      prompt: prompt ?? 0,
      completion: completion ?? 0,
      cacheRead: cacheRead ?? 0,
      estimated: counted(record.estimatedTok) ?? 0,
      calls: counted(record.calls) ?? 1,
      total,
      source: "settlement record",
      raw: record.usage ?? record,
    };
  }
  const inner = readUsage(record.usage ?? record);
  if (inner === null) return null;
  return {
    prompt: inner.prompt,
    completion: inner.completion,
    cacheRead: inner.cacheRead,
    estimated: counted(record.estimatedTok) ?? 0,
    calls: counted(record.calls) ?? 1,
    total: inner.total,
    source: inner.source,
    raw: inner.raw,
  };
}

/**
 * Resolve the tool catalogue for this call.
 *
 * `recallTools` runs PER CALL rather than once at build, because the web seam
 * is answered for right now and a tool the circuit banned mid-run has to leave
 * the list on the very next turn. An explicit `tools` array wins outright —
 * that is how a stage hands an agent a deliberately empty catalogue, which is
 * what the analyst and the reviewer get.
 * @param options - `{ctx, agent, spec, circuit, facet, seedTools}`.
 * @returns `{tools, notices, recommended, exhausted}`.
 */
function resolveCatalogue({ ctx, agent, spec, circuit, facet, seedTools }) {
  if (Array.isArray(seedTools)) {
    return { tools: seedTools, notices: [], recommended: [], exhausted: seedTools.length === 0 };
  }
  let web;
  try {
    web = typeof ctx?.get === "function" ? ctx.get("web") : ctx?.web;
  } catch {
    // A context that refuses the lookup is an ABSENT seam, not a failed one,
    // and `recallTools` already says which of the two it is in its notices.
    web = undefined;
  }
  return recallTools({ agent, spec, web, circuit, facet });
}

/**
 * Estimate the prompt and run the named shrink ladder until it fits.
 *
 * The rung NAME travels with every event, because "the context was shrunk" and
 * "the context was shrunk by dropping quotes" are different facts, and only the
 * second one tells anybody what the report is missing.
 * @param options - the prompt, the budget, the ladder and the stage's reducer.
 * @returns `{system, rung, tokens, method, fits}`.
 */
async function fitContext({ ctx, system, messages, wire, inputBudgetTokens, shrinkLadder, rung, shrink, note, logger }) {
  if (!Number.isInteger(inputBudgetTokens) || inputBudgetTokens <= 0) {
    return { system, rung, tokens: 0, method: "unmeasured: no inputBudgetTokens was declared", fits: true };
  }
  let measured = estimateContext(ctx, { system, messages, tools: wire });
  let at = rung;
  let currentSystem = system;

  while (measured.tokens > inputBudgetTokens && at < shrinkLadder.length && typeof shrink === "function") {
    const rungName = shrinkLadder[at];
    let next;
    try {
      next = await shrink({ rung: at, rungName, system: currentSystem, messages, tools: wire, tokens: measured.tokens, budget: inputBudgetTokens });
    } catch (cause) {
      // A reducer that throws must not decide the mission: the call goes out at
      // the size it is and the provider gives a definitive answer.
      logger?.warn?.(`mission-agent: shrink rung "${rungName}" threw: ${String(cause?.message ?? cause)}`);
      note("context:shrink-failed", { rung: at, rungName, why: String(cause?.message ?? cause) });
      break;
    }
    if (next === undefined || next === null || next === false) {
      note("context:shrink-exhausted", { rung: at, rungName, tokens: measured.tokens, budget: inputBudgetTokens });
      break;
    }
    if (typeof next.system === "string") currentSystem = next.system;
    if (Array.isArray(next.messages)) {
      messages.length = 0;
      messages.push(...next.messages);
    }
    at += 1;
    measured = estimateContext(ctx, { system: currentSystem, messages, tools: wire });
    note("context:shrunk", { rung: at - 1, rungName, tokens: measured.tokens, budget: inputBudgetTokens, method: measured.method });
  }

  if (measured.tokens > inputBudgetTokens) {
    // NOT a pre-emptive termination. A conservative chars/4 estimate that reads
    // high would kill a call that would have worked; the provider's
    // CONTEXT_WINDOW_EXCEEDED is definitive, costs one call to obtain, and §8.5
    // already calls it a routine outcome rather than an anomaly. The numbers go
    // on the record either way, so an over-budget dispatch is never invisible.
    note("context:over-budget", {
      tokens: measured.tokens,
      budget: inputBudgetTokens,
      method: measured.method,
      rungsLeft: Math.max(0, shrinkLadder.length - at),
      shrinkable: typeof shrink === "function",
    });
  }
  return { system: currentSystem, rung: at, tokens: measured.tokens, method: measured.method, fits: measured.tokens <= inputBudgetTokens };
}

/**
 * Reach the harness's token meter WITHOUT declaring it as a dependency.
 *
 * A Cordis context is a Proxy whose property getter THROWS
 * `cannot get property "tokenMeter" without inject` for any service this
 * plugin did not list in `inject`. So `ctx?.tokenMeter` does not degrade to
 * undefined the way it reads — `?.` guards a null `ctx`, not a throwing
 * getter — and the chars/4 fallback below it is unreachable. That is exactly
 * how mission-20260824T201942Z-688983ae died 14ms into s2-plan, on the first
 * model call of the first real run, with every unit test green because no test
 * puts a real Cordis context in front of this.
 *
 * `ctx.get(name)` is the harness's own answer (harness postmortem 0001) and
 * returns undefined for an uninstalled service. Adding "tokenMeter" to
 * `inject` would be the WRONG fix: it is optional, and injecting it makes the
 * whole plugin refuse to load on a host that has no meter — the same trade
 * lib/index.js already made for the `web` search seam.
 * @param ctx - the Cordis context, or any plain object in tests.
 * @returns the meter, or undefined when the host installs none.
 */
export function tokenMeterOf(ctx) {
  if (ctx === null || ctx === undefined) return undefined;
  // Plain objects in tests have no `get`; a real context always does.
  if (typeof ctx.get === "function") {
    try {
      return ctx.get("tokenMeter");
    } catch {
      return undefined;
    }
  }
  try {
    return ctx.tokenMeter;
  } catch {
    return undefined;
  }
}

/**
 * Estimate a prompt in tokens, and NAME the method that produced the number.
 *
 * `ctx.tokenMeter` is the harness's own meter and is preferred. When it is
 * absent or throws, chars/4 answers instead — and says so, because a caller
 * that reads `method: "chars…"` knows its shrink decisions are approximate,
 * whereas a bare number would be trusted exactly as far as a real measurement.
 * @param ctx - the Cordis context, which may carry `tokenMeter`.
 * @param input - `{system, messages, tools}`.
 * @returns `{tokens, method}`.
 */
export function estimateContext(ctx, { system = "", messages = [], tools = [] } = {}) {
  const meter = tokenMeterOf(ctx);
  if (typeof meter?.estimateMessage === "function") {
    try {
      let total = Math.ceil(String(system).length / 4) + Math.ceil(safeJson(tools).length / 4);
      for (const message of messages) total += Number(meter.estimateMessage(message)) || 0;
      return { tokens: Math.round(total), method: "meter" };
    } catch (cause) {
      return {
        tokens: charEstimate(system, messages, tools),
        method: `chars: ctx.tokenMeter.estimateMessage threw (${String(cause?.message ?? cause)})`,
      };
    }
  }
  return { tokens: charEstimate(system, messages, tools), method: "chars: no ctx.tokenMeter is installed" };
}

/** chars/4 over the whole prompt. Approximate, and always labelled as such. */
function charEstimate(system, messages, tools) {
  return Math.round((String(system).length + safeJson(messages).length + safeJson(tools).length) / 4);
}

/**
 * The finalize gate: validate the shape, then check the business rules.
 *
 * TWO checks, not one. `validateArgs` answers "is this the schema" — which the
 * provider has usually already enforced, since the schema IS the tool's
 * parameters — and `check` answers "is this any good", which nothing else can.
 * The second is where every stage's real gate lives.
 * @param options - `{args, finalizeTool, checkFinalize, spec, context}`.
 * @returns `{candidate, issues}`; an empty `issues` means accept.
 */
async function gateFinalize({ args, finalizeTool, checkFinalize, spec, context }) {
  const shaped = validateArgs(finalizeTool?.parameters, args);
  if (shaped.ok === false) {
    return { candidate: args, issues: [{ kind: "schema", message: shaped.error }] };
  }
  const check = typeof checkFinalize === "function"
    ? checkFinalize
    : (typeof spec?.check === "function" ? spec.check : null);
  if (check === null) return { candidate: shaped.value, issues: [] };

  let verdict;
  try {
    verdict = await check(shaped.value, context);
  } catch (cause) {
    // A gate that threw is a gate that did not run, so the candidate is sent
    // back rather than accepted. Accepting because the checker crashed is
    // exactly "reporting success you have not verified".
    return {
      candidate: shaped.value,
      issues: [{ kind: "schema", message: `the check on your answer could not be run: ${String(cause?.message ?? cause)}. Re-send your answer.` }],
    };
  }
  return { candidate: shaped.value, issues: normaliseIssues(verdict) };
}

/**
 * Accept every reasonable shape a `check` might return, and never guess.
 * @param verdict - what the stage's check returned.
 * @returns an array of issue objects; empty means accept.
 */
function normaliseIssues(verdict) {
  if (verdict === undefined || verdict === null || verdict === true) return [];
  if (verdict === false) return [{ kind: "schema", message: "your answer did not pass this stage's check." }];
  if (typeof verdict === "string") return verdict === "" ? [] : [{ kind: "schema", message: verdict }];
  if (Array.isArray(verdict)) return verdict.filter((issue) => issue !== undefined && issue !== null).map(oneIssue);
  if (Array.isArray(verdict.issues)) return verdict.issues.filter((issue) => issue !== undefined && issue !== null).map(oneIssue);
  if (verdict.ok === true) return [];
  if (verdict.ok === false) return [oneIssue(verdict.error ?? verdict.reason ?? "your answer did not pass this stage's check.")];
  return [];
}

/** One issue, from either a sentence or an object. */
function oneIssue(issue) {
  if (typeof issue === "string") return { kind: "schema", message: issue };
  if (issue?.kind === "quote") return issue;
  return { kind: "schema", message: String(issue?.message ?? issue?.error ?? safeJson(issue)) };
}

/** Flatten issues to sentences, for the diagnostic a person reads. */
function flattenIssues(issues) {
  return issues.map((issue) => (issue.kind === "quote" ? renderQuoteIssue(issue) : issue.message));
}

/**
 * One quote issue, in the wording its reason earns. Never an accusation.
 * @param issue - `{quote, source, reason}` from `quoteIssue`.
 * @returns the sentence the model is shown.
 */
function renderQuoteIssue(issue) {
  const build = QUOTE_FAILURE_SENTENCES[issue.reason];
  const quote = `"${String(issue.quote).slice(0, 300)}"`;
  const source = String(issue.source) === "" ? "an unnamed source" : String(issue.source);
  if (build === undefined) {
    // Naming the gap rather than inventing a sentence. A critique that says the
    // wrong thing about a quote is the exact failure this vocabulary exists to
    // prevent, so an unknown reason must not fall back to the harshest wording.
    return `The quote ${quote} attributed to ${source} did not verify, and the reason "${issue.reason}" is not one of the four this loop knows (${Object.values(QUOTE_FAILURES).join(", ")}). Re-check it against the source's own words.`;
  }
  return build(quote, source);
}

/**
 * Render the cumulative critique the model is sent back.
 *
 * CUMULATIVE, not replaced: round one's issues are re-shown in round two, so
 * the model does not fix the second issue by re-introducing the first — the
 * oscillation the reference measured. The schema skeleton is appended whenever
 * a shape issue is present, because a target is a far stronger instruction than
 * a complaint.
 * @param rounds - every round's issues, oldest first.
 * @param schema - the finalize tool's parameters.
 * @param finalizeName - the tool the model must call again.
 * @returns the critique text.
 */
function renderCritique(rounds, schema, finalizeName) {
  const lines = [];
  for (const [index, issues] of rounds.entries()) {
    lines.push(`Round ${index + 1}:`);
    for (const sentence of flattenIssues(issues)) lines.push(`  - ${sentence}`);
  }
  const hasSchemaIssue = rounds.some((issues) => issues.some((issue) => issue.kind !== "quote"));
  const skeleton = hasSchemaIssue ? `\n\nYour answer must have this shape:\n${safeJson(schemaSkeleton(schema))}` : "";
  return `Your answer was not accepted. Every issue found so far is listed, including ones from earlier rounds — fix all of them and call ${finalizeName} again.\n\n${lines.join("\n")}${skeleton}`;
}

/**
 * A JSON skeleton generated from a schema, as the critique's target.
 * @param schema - a JSON schema fragment.
 * @returns a nested example value.
 */
export function schemaSkeleton(schema) {
  const type = schema?.type ?? "object";
  if (type === "object") {
    const out = {};
    for (const [name, spec] of Object.entries(schema?.properties ?? {})) {
      const required = Array.isArray(schema?.required) && schema.required.includes(name);
      out[name] = schemaSkeleton(spec);
      if (!required && typeof out[name] === "string") out[name] = `${out[name]} (optional)`;
    }
    return out;
  }
  if (type === "array") return [schemaSkeleton(schema?.items ?? { type: "string" })];
  if (type === "integer" || type === "number") return schema?.minimum ?? 0;
  if (type === "boolean") return false;
  if (Array.isArray(schema?.enum)) return `one of: ${schema.enum.join(" | ")}`;
  return String(schema?.description ?? "string");
}

/**
 * Name the poison in a force-accepted candidate, or null when it is clean.
 *
 * Two shapes, both measured in the reference: a tool-call envelope the model
 * emitted as its answer, and a string where the schema wanted an object.
 * @param candidate - the last candidate.
 * @param schema - the finalize tool's parameters.
 * @returns a phrase naming the poison, or null.
 */
function poisonOf(candidate, schema) {
  const wanted = schema?.type ?? "object";
  if (candidate === undefined || candidate === null) return "an absent candidate";
  if (typeof candidate === "string" && (wanted === "object" || wanted === "array")) {
    return `a string where the schema wanted ${wanted === "array" ? "an array" : "an object"}`;
  }
  if (typeof candidate !== "object") return null;
  const envelope = (value) => value !== null && typeof value === "object"
    && (value.type === "tool-call" || value.type === "function"
      || (Object.hasOwn(value, "arguments") && Object.hasOwn(value, "name")));
  if (envelope(candidate)) return "a tool-call envelope rather than an answer";
  if (Array.isArray(candidate) && candidate.some(envelope)) return "an array of tool-call envelopes rather than an answer";
  if (Array.isArray(candidate.tool_calls) || Array.isArray(candidate.toolCalls)) return "a tool-call envelope rather than an answer";
  return null;
}

/**
 * The empty value OF THE SCHEMA'S TYPE, so a reader's own gate fires normally.
 *
 * `{}` rather than `null` for an object schema on purpose: a stage that reads
 * `output.dimensions.length` gets `undefined` and refuses through its own G1
 * with its own message, where `null` would throw a bare TypeError and surface
 * as `model_error` — a code that blames the provider for a suppression this
 * loop performed deliberately.
 * @param schema - the finalize tool's parameters.
 * @returns the empty value of that type.
 */
function emptyOfSchema(schema) {
  const type = schema?.type ?? "object";
  if (type === "array") return [];
  if (type === "string") return "";
  if (type === "integer" || type === "number" || type === "boolean") return null;
  return {};
}

/**
 * Fold one observation into the run's tool statistics.
 *
 * `refused`, `empty` and `ok` are counted separately because the door already
 * distinguishes them and collapsing them here would undo that: a stage whose
 * searches were all blocked and a stage whose searches all found nothing would
 * report the same number, which is how a fact about our request rate becomes a
 * claim about the world.
 * @param stats - the accumulator.
 * @param used - the ordered list of tool names used.
 * @param name - the tool.
 * @param observation - the door's answer.
 */
function recordTool(stats, used, name, observation) {
  stats.total += 1;
  const bucket = stats.byTool[name] ?? { calls: 0, ok: 0, refused: 0, empty: 0 };
  bucket.calls += 1;
  if (observation.ok === true) {
    stats.ok += 1;
    bucket.ok += 1;
    if (observation.empty === true) {
      stats.empty += 1;
      bucket.empty += 1;
    }
  } else {
    stats.refused += 1;
    bucket.refused += 1;
  }
  stats.byTool[name] = bucket;
  if (!used.includes(name)) used.push(name);
}

/**
 * The state an exit reason settles in.
 *
 * `degraded` is reserved for a run that produced SOMETHING — a candidate, or at
 * least one non-empty successful tool call. A budget that drained after nine
 * pages were read is a degraded run; one that drained before the first call is
 * a failure, and calling both the same thing hides which of them happened.
 * @param exitReason - an `EXIT_REASONS` member.
 * @param evidence - `{hasOutput, didWork}`.
 * @returns an `AGENT_STATES` member.
 */
function stateFor(exitReason, { hasOutput, didWork }) {
  if (exitReason === "completed") return "completed";
  if (exitReason === "max_iterations" || exitReason === "validation_rejected_max") return "degraded";
  if (exitReason === "cancelled" || exitReason === "failed_model"
    || exitReason === "failed_parse" || exitReason === "empty_response") return "failed";
  return hasOutput === true || didWork === true ? "degraded" : "failed";
}

/** One sentence per exit reason, paired. It reaches the user as the degrade note. */
function describeExit(exitReason, zh) {
  const sentences = {
    cancelled: ["运行被取消。", "The run was cancelled."],
    failed_tool: ["一个工具失败并让本阶段停止。", "A tool failed and stopped this stage."],
    failed_model: ["模型调用失败。", "The model call failed."],
    failed_parse: ["模型的产出无法解析。", "The model's output could not be parsed."],
    empty_response: ["模型返回了空回合。", "The model returned an empty turn."],
    budget_exhausted: ["预算耗尽。", "The budget is spent."],
    context_exceeded: ["输入超出了模型的上下文窗口。", "The input exceeded the model's context window."],
    wall_time: ["超出了挂钟时限。", "The wall-clock limit was reached."],
    max_iterations: ["代理用满了轮次上限。", "The agent used all of its turns."],
    validation_rejected_max: ["产出多次未通过检查，已降级接受。", "The output failed its checks repeatedly and was accepted as degraded."],
    completed: ["完成。", "Completed."],
  };
  const pair = sentences[exitReason] ?? [`未知的退出原因 ${exitReason}。`, `Unknown exit reason ${exitReason}.`];
  return zh ? pair[0] : pair[1];
}

/** What to do about each exit reason. Error messages say what to do. */
function recoveryHintFor(exitReason, zh) {
  const hints = {
    cancelled: ["不需要处理；取消是用户的意图。", "Nothing to do; the cancellation was intended."],
    failed_tool: ["检查该工具是否可用，或用已收集到的证据继续。", "Check that tool's availability, or continue with the evidence already collected."],
    failed_model: ["重跑本阶段；若持续失败，检查所路由的模型。", "Re-run this stage; if it keeps failing, check the routed model."],
    failed_parse: ["重跑本阶段。", "Re-run this stage."],
    empty_response: ["重跑本阶段；若重复出现，缩短输入。", "Re-run this stage; if it repeats, shorten the input."],
    budget_exhausted: ["提高上限后重跑，或接受已有的证据。", "Raise the ceiling and re-run, or accept the evidence already collected."],
    context_exceeded: ["以更小的批次重跑本阶段。", "Re-run this stage at a smaller batch size."],
    wall_time: ["提高 wallMs 后重跑本阶段。", "Raise wallMs and re-run this stage."],
    max_iterations: ["提高 missionTurnCap，或收窄交给该代理的任务。", "Raise missionTurnCap, or narrow the task handed to this agent."],
    validation_rejected_max: ["检查本阶段的门槛是否可满足。", "Check that this stage's gate is satisfiable."],
    completed: ["", ""],
  };
  const pair = hints[exitReason] ?? ["", ""];
  return zh ? pair[0] : pair[1];
}

/** `budget.ratio()` without letting a bug in the pool take the run with it. */
function safeRatio(budget) {
  try {
    const ratio = budget?.ratio?.();
    return ratio === undefined || ratio === null ? {} : ratio;
  } catch {
    return {};
  }
}

/** JSON that cannot throw. A circular observation must still reach the model. */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (cause) {
    return JSON.stringify({ error: `this value could not be serialised (${String(cause?.message ?? cause)})` });
  }
}
