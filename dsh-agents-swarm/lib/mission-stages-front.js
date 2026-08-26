/**
 * The research half of the pipeline: `s1-brief`, `s2-plan`, `s3-collect` and
 * `s4-assess`, as four handler factories over one closed-over `deps` bag.
 *
 * These four are the stages with the loop in them. `s3` fans out over the
 * dimensions `s2` named, `s4` grades what came back and may send `s3` round
 * once more. EVERY GATE HERE IS CODE. The phase −1 spike measured what a prompt
 * is worth on this loop: the same topic produced six fetched pages and six
 * findings on one run, and two searches then `finish` on the next. The
 * difference was not the topic and it was not the wording. Refusing the finish
 * in code — with the reason handed back to the model as a tool result — is what
 * made the loop reliable, and every gate below is shaped the same way: refuse
 * in code, say why in the model's own transcript, refuse a bounded number of
 * times, then RELEASE, so an honest failure is still reachable.
 *
 * What this file does NOT do, because `lib/mission-runtime.js` owns it and a
 * second caller is the failure this phase exists to prevent: `finalize`,
 * `openStageRows`, `startStage`, `finishStage`, `saveCheckpoint`,
 * `claimForRun`, `bumpPatchRound`, `touchMission`, `appendEvent`,
 * `evidenceFloorGate`, `evaluateBackEdge`, `recordRecollectOutcome`. The one
 * back-edge round cap — `missions.patch_round` against `MAX_PATCH_ROUNDS` — is
 * `evaluateBackEdge`'s, read from the column inside the runtime's own
 * transaction; `s4` below asks only the question the runtime cannot ask for it
 * (is there a weakest dimension left worth re-collecting?) and never
 * re-implements the other four terminating conditions.
 *
 * It does not contain the model loop either. If a stage file accumulates
 * streaming tool-call deltas itself, it is wrong: `lib/mission-chat.js` owns the stream,
 * the tool-result shape and the finalize gate's mechanics, and arrives here as
 * `deps.chat`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  QUOTE_FAILURES,
  READ_NOTHING_REFUSAL,
  oneHostRefusal,
  finalizeToolFor,
  quoteIssue,
  readUsage,
  readSettlement,
} from "./mission-agent.js";
import { budgetGate, computeWallFloorMs } from "./mission-runtime.js";
import { FACETS, documentIdFor } from "./mission-store.js";
import { createSqliteLedger } from "./mission-tools.js";
import { LADDER } from "./mission-budget.js";
import { verifyQuote } from "./insights.js";

/* ── policy that belongs to stage one ──────────────────────────────────── */

/**
 * The per-tier policy `s1` resolves once and every later stage reads from
 * `crossState.tierPolicy`.
 *
 * `dimensionTarget`, `findingTarget` and `wordFloor` are §1's table verbatim
 * (3/5/8 dimensions, 4/5/6 verified findings per dimension as the INITIAL
 * target, ~3,000 / ~9,000 / ~25,000 words). `findingTarget` is the `tierTarget`
 * in `s3`'s `clamp(2, tierTarget, round(median))` — a seed for the derived
 * floor, never the floor itself, because a floor nothing can reach is how
 * chapters rewrite until wall-time.
 *
 * `verifiedRatioFloor` and `citationFloor` are the two numbers the architecture
 * names without giving a value. ONE number each, at every tier, rather than
 * three invented ones: the citation floor is two sources per chapter, which is
 * already `s7`'s supply contract (`maxChapters = floor(uniqueHosts / 2)`), and
 * the verified-ratio floor is a single bar the forced-unsign ladder reads. They
 * live here because `s1` is the one stage that resolves policy, and they travel
 * by `crossState` so nothing downstream holds a second copy.
 */
export const TIER_POLICY = Object.freeze({
  quick: Object.freeze({ dimensionTarget: 3, findingTarget: 4, wordFloor: 3_000, verifiedRatioFloor: 0.7, citationFloor: 2 }),
  standard: Object.freeze({ dimensionTarget: 5, findingTarget: 5, wordFloor: 9_000, verifiedRatioFloor: 0.7, citationFloor: 2 }),
  deep: Object.freeze({ dimensionTarget: 8, findingTarget: 6, wordFloor: 25_000, verifiedRatioFloor: 0.7, citationFloor: 2 }),
});

/** The resource types the library indexes, for the census `s2` plans against. */
const LIBRARY_TYPES = Object.freeze([
  "PAPER", "BLOG", "REPORT", "YOUTUBE_VIDEO", "NEWS", "PROJECT", "EVENT", "RSS", "POLICY",
]);

/**
 * The Leader's `minCoverage` ceiling.
 *
 * The prompt asks for 60–80 and the model answers 90 — measured, and it is an
 * anchoring effect rather than a judgement, so it is corrected in code and the
 * correction is pushed onto `leaderDecisions` where the Leader sees it again at
 * foreword time.
 */
const MAX_MIN_COVERAGE = 80;

/**
 * How many times `s3` refuses a `finalize` that read nothing, and how many
 * times it refuses one with no verified finding behind it.
 *
 * One and two, then RELEASED. The first is the spike's measured refusal — one
 * was enough, every time. The second is bounded and then released on purpose: a
 * genuinely dead network has to be able to produce an honest empty dimension
 * rather than deadlock, and §2's evidence floor is what stops honest emptiness
 * becoming a report.
 */
// Three, not one. Refused once the model searched again and finished again
// without fetching, and the dimension was released empty — four of eight ended
// that way while fetch_page had a 100% success rate.
export const MAX_READ_NOTHING_REFUSALS = 3;

/** How many distinct hosts a dimension is pushed toward before it may finish. */
const INDEPENDENT_SOURCES_WANTED = 2;

/** One push toward a second host, then released: one host may be all there is. */
const MAX_ONE_HOST_REFUSALS = 1;
const MAX_UNVERIFIED_FINISH_REFUSALS = 2;

/* ── small shared helpers ──────────────────────────────────────────────── */

/**
 * One canonical key for a page, so the model's own citation finds its own fetch.
 *
 * The model does not echo a URL back byte for byte: it drops a fragment, adds
 * or removes a trailing slash, or writes `https` where the search result said
 * `http`. Keying the fetched-page map on the raw string made every one of those
 * a "you never fetched that page" refusal — measured, SIX OF SIX findings lost
 * to bookkeeping rather than to anything the model got wrong.
 *
 * @param url - any URL string.
 * @returns a lowercased, scheme-insensitive key with no fragment and no
 *   trailing slash; the trimmed input when it will not parse.
 */
export function pageKey(url) {
  try {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/\/+$/u, "");
    return `${parsed.hostname.toLowerCase().replace(/^www\./u, "")}${path}${parsed.search}`;
  } catch {
    return String(url ?? "").trim().toLowerCase();
  }
}

/**
 * Which contiguous span of a document a quote sits in.
 *
 * `insights.js` exports `verifyQuote` but not the index it matched at, and
 * `mission_findings.span_index` is not decoration: `insertFinding` REFUSES a
 * fetch-backed verified state that cannot name its span, because a verifier
 * that discards the matching index cannot be re-checked later and "verified"
 * then means "somebody said so once".
 *
 * So the index is computed here, against the same blank-line split
 * `quotableSpans` uses, and this function is EXPORTED so `s9`'s re-verification
 * and `lib/mission-blocks.js` use the one definition rather than a second one.
 * The only thing that can drift is the index, never the verdict — `verifyQuote`
 * remains the sole authority on whether a quote verified, and a disagreement
 * (verified but no span found) is counted and reported rather than papered over
 * with a fabricated 0.
 *
 * @param text - the document body the quote was verified against.
 * @param quote - the model's quote.
 * @returns the 0-based span index, or -1 when no single span contains it.
 */
export function spanIndexOf(text, quote) {
  const needle = normalizeSpace(quote);
  if (needle === "") return -1;
  const spans = String(text ?? "").split(/\n\s*\n/u);
  let index = -1;
  for (const span of spans) {
    const trimmed = span.trim();
    if (trimmed === "") continue;
    index += 1;
    if (normalizeSpace(trimmed).includes(needle)) return index;
  }
  return -1;
}

/** Whitespace-normalised text, the comparison `verifyQuote` makes. */
function normalizeSpace(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/** A stable dimension id: lowercase, hyphenated, bounded. */
function slugOf(value, fallback) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{Nd}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug === "" ? fallback : slug;
}

/** An error the runtime's `classifyFailure` can read, rather than a bare throw. */
function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Nearest-rank quantile over an ascending array. */
function quantile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

/** The median of a list of counts, 0 for an empty list. */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** One user message in the shape the seam seeds a transcript with. */
function briefMessage(id, text) {
  return { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

/**
 * The stage's half of the shrink ladder.
 *
 * The SEAM owns when to shrink — it estimates the whole prompt against
 * `stage.inputBudgetTokens` before every turn and walks `stage.shrinkLadder`
 * rung by rung, naming each one. The STAGE owns what to drop, because only the
 * stage knows which half of its own brief is the expensive half. Returning
 * `null` is how a stage says the ladder is spent; the seam then dispatches
 * over budget on purpose and records that it did, because a conservative
 * chars/4 estimate that reads high would kill a call that would have worked.
 *
 * The first message is the brief and is re-rendered at the next rung. Every
 * later message is the transcript and is KEPT: replacing the whole array would
 * discard the tool results the model is reasoning from, which is a far more
 * expensive loss than the tokens it saves.
 *
 * @param options - `{id, render, rungs, reduceTranscript}`.
 * @returns the reducer the seam calls, or undefined when there is no ladder.
 */
function shrinkerFor({ id, render, rungs, reduceTranscript = null }) {
  if (!Array.isArray(rungs) || rungs.length === 0) return undefined;
  return ({ rung, messages }) => {
    const level = rung + 1;
    if (level > rungs.length) return null;
    const rest = messages.slice(1);
    return {
      messages: [
        briefMessage(id, render(level)),
        ...(reduceTranscript === null ? rest : rest.map((message) => reduceTranscript(message, level))),
      ],
    };
  };
}

/**
 * Which shrink rung a finished run ended on, read from its own events.
 *
 * The seam notes `context:shrunk` with the rung and its name; this is that
 * record rather than a second count kept beside it.
 *
 * @param run - the agent run result.
 * @returns the rung index, 0 when nothing was shrunk.
 */
function shrinkRungOf(run) {
  let rung = 0;
  for (const event of run?.events ?? []) {
    if (event?.type === "context:shrunk" && Number.isInteger(event.rung)) rung = Math.max(rung, event.rung + 1);
  }
  return rung;
}

/** Whether the seam dispatched a prompt it had already measured as over budget. */
function overBudgetOf(run) {
  return (run?.events ?? []).some((event) => event?.type === "context:over-budget");
}

/* ── the prompt seam ───────────────────────────────────────────────────── */

/** Parsed SKILL.md bodies, keyed `role`. One read per role per process. */
const skillCache = new Map();

/**
 * Read one role's soul and one of its duties out of `lib/mission/agents/<role>/SKILL.md`.
 *
 * The soul sits between `<!-- soul:start -->` and `<!-- soul:end -->`, each duty
 * between `<!-- duty:<name>:start -->` and its end marker. A missing file or a
 * missing marker is a THROW naming the exact path and marker, not a silent
 * fallback to a generic prompt: a mission reviewed against a bar it never set
 * is the failure that produces a structural refusal scoring around 47 for a
 * reason unrelated to the work.
 *
 * The tool section of the prompt is NOT built here. `lib/mission-chat.js`
 * generates it from `recallTools`' answer, per call, so a tool cannot exist in
 * the ACL and be missing from the prompt.
 *
 * @param role - the agent role, e.g. "leader".
 * @param duty - the duty name, e.g. "plan".
 * @returns the system prompt: soul, then duty.
 */
export function loadRolePrompt(role, duty) {
  const name = String(role ?? "");
  const dutyName = String(duty ?? "");
  const path = fileURLToPath(new URL(`./mission/agents/${name}/SKILL.md`, import.meta.url));

  let body = skillCache.get(name);
  if (body === undefined) {
    try {
      body = readFileSync(path, "utf8");
    } catch (cause) {
      throw fail("input_invalid", `no skill file for the ${name} role at ${path} (${cause.message}). Every role loads its prompt from lib/mission/agents/<role>/SKILL.md; create it with a soul block and a duty block for each duty the stage names.`);
    }
    skillCache.set(name, body);
  }

  const soul = between(body, "<!-- soul:start -->", "<!-- soul:end -->");
  if (soul === null) {
    throw fail("input_invalid", `${path} has no <!-- soul:start --> / <!-- soul:end --> block. The soul is the part every duty shares; add it rather than repeating it in each duty.`);
  }
  const text = between(body, `<!-- duty:${dutyName}:start -->`, `<!-- duty:${dutyName}:end -->`);
  if (text === null) {
    throw fail("input_invalid", `${path} has no <!-- duty:${dutyName}:start --> block. The stage asked for the "${dutyName}" duty; add that block, or correct the duty name at the call site.`);
  }
  return `${soul}\n\n${text}`;
}

/** The text between two markers, or null when either marker is absent. */
function between(body, open, close) {
  const from = body.indexOf(open);
  if (from === -1) return null;
  const to = body.indexOf(close, from + open.length);
  if (to === -1) return null;
  const text = body.slice(from + open.length, to).trim();
  return text === "" ? null : text;
}

/** The prompt loader a stage uses: the injected one, or this module's reader. */
function promptsOf(deps) {
  return typeof deps?.prompts === "function" ? deps.prompts : loadRolePrompt;
}

/* ── spend, ledger and the one agent call ──────────────────────────────── */

/**
 * The `onUsage` hook a stage hands the agent seam.
 *
 * Written per usage chunk rather than once from the run's totals, because a run
 * that throws after its second turn still spent what its first two turns cost,
 * and a ledger that only records complete runs understates every mission that
 * failed — which is exactly the population somebody is trying to learn from.
 *
 * @param options - `{store, missionId, stage, now}`.
 * @returns a function taking one usage chunk.
 */
function spendRecorder({ store, missionId, stage, now, logger }) {
  return (usage) => {
    // `readSettlement` is mission-agent.js's reader for the RECORD the seam
    // sends, and it REPORTS a shape it did not recognise instead of absorbing it
    // did not recognise instead of absorbing it into a silent zero — a mission
    // that cost real money rendering as free is what makes the estimator
    // permanently untunable.
    const counts = readSettlement(usage);
    if (counts === null) {
      logger?.warn?.(`mission ${missionId}: ${stage.id} received no usage object, so no spend row was written for that call`);
      return;
    }
    if (counts.source !== "settlement record" && counts.source !== "fields") {
      logger?.warn?.(`mission ${missionId}: ${stage.id} usage — ${counts.source}`);
    }
    // A settled call that cost NOTHING is not a discount. Zero survived here
    // for a whole release precisely because nothing said it was strange, and
    // the ledger it lands in is the one the token ceiling is read from.
    if (counts.total === 0) {
      logger?.warn?.(`mission ${missionId}: ${stage.id} settled a model call priced at zero tokens — the ledger will understate this mission and the token ceiling cannot bind on it`);
    }
    store.withTx(() => {
      store.insertSpend({
        missionId,
        stepId: stage.id,
        role: stage.agent ?? "code",
        agentId: stage.agent,
        promptTok: counts.prompt,
        completionTok: counts.completion,
        cacheReadTok: counts.cacheRead,
        estimatedTok: counts.estimated,
        calls: counts.calls,
        at: now(),
      });
    });
  };
}

/**
 * The tool ledger, wrapped so the stage can see which cache entries a run touched.
 *
 * `createSqliteLedger` writes the `mission_tool_calls` row; this adds one
 * in-memory observation. The stage needs it because the tool door hands its
 * observations to the model, not to the stage — see `s3`'s page harvest, which
 * uses `(tool, argsHash)` to find the FULL result in the shared cache rather
 * than re-parsing a transcript entry the seam truncates at 12,000 characters.
 *
 * A throwing base ledger must not take the mission with it: the mission's work
 * is worth more than one audit row, and the loss is reported rather than
 * swallowed.
 *
 * @param options - `{base, onRow, logger}`.
 * @returns the ledger function.
 */
function watchingLedger({ base, onRow, logger }) {
  return (row) => {
    try {
      onRow(row);
    } catch (cause) {
      logger?.warn?.(`mission: tool-call watcher failed: ${cause.message}`);
    }
    try {
      base(row);
    } catch (cause) {
      logger?.warn?.(`mission: tool-call ledger failed: ${cause.message}`);
    }
  };
}

/* ── s1-brief ──────────────────────────────────────────────────────────── */

/**
 * Stage one: freeze nothing, re-resolve nothing, and answer whether this plan
 * can fit before a single model call is made.
 *
 * `resolveBudget` ran once at `createMission` and wrote the six ceilings onto
 * the mission row. This stage READS them. It makes no model call, writes no
 * database row, and — deliberately — does not write stage rows either:
 * `createMission` wrote all twelve through `#validateStageRows` and the runtime
 * opens them on a rehydrate, so a third writer would reset progress on a
 * resume.
 *
 * @param deps - `{store, sourceStore, config, ctx, logger}`.
 * @returns the `s1-brief` handler.
 */
export function createS1Brief(deps) {
  const { store, sourceStore, config = {}, ctx = null, logger = null } = deps ?? {};
  if (typeof store?.listMissions !== "function") {
    throw new TypeError("createS1Brief needs the MissionStore as deps.store; the caps history and the census are read through it.");
  }

  return async function s1Brief(context) {
    const { mission, tier, stage, missionId, now, emit } = context;
    const zh = mission.language !== "en";

    // G2 — caps frozen. The three tool ceilings may legitimately be zero (a
    // machine with no search plugin sets max_web to 0 and `createMission`
    // accepts it), so they are checked as non-negative integers; the three that
    // must be positive are the ones a mission cannot run at all without.
    // `undefined` here is the real defect this guard exists for: reading
    // `mission.max_tokens` instead of `mission.budget.maxTokens` yields
    // undefined, and the runtime already lost a whole outage to that.
    const caps = mission.budget ?? {};
    const positive = ["maxTokens", "maxCalls", "wallMs"];
    const nonNegative = ["maxArxiv", "maxWeb", "maxFetch"];
    for (const field of [...positive, ...nonNegative]) {
      const value = caps[field];
      const bad = !Number.isInteger(value) || value < 0 || (positive.includes(field) && value <= 0);
      if (bad) {
        throw fail("input_invalid", zh
          ? `missions.${field} 未解析（读到 ${JSON.stringify(value)}）：resolveBudget() 必须在 createMission 时运行，之后每个阶段都从行上读取；不要在这里重新解析上限。`
          : `missions.${field} is not resolved for this mission (read ${JSON.stringify(value)}). resolveBudget() runs once at createMission and every later stage reads the row; do not resolve caps here.`);
      }
    }

    // The pacing floor. `computeWallFloorMs` throws on a missing parseP50Ms on
    // purpose — a floor computed without it is the same understatement in a new
    // place — but a bare throw classifies as `model_error` and sends the user
    // to a provider that was never involved, so the setting is checked here and
    // named in the message.
    const parseP50Ms = Number(config.missionParseP50Ms);
    const arxivIntervalMs = Number(config.missionArxivIntervalMs);
    const fetchIntervalMs = Number(config.missionFetchIntervalMs);
    for (const [key, value] of Object.entries({ missionParseP50Ms: parseP50Ms, missionArxivIntervalMs: arxivIntervalMs, missionFetchIntervalMs: fetchIntervalMs })) {
      if (!Number.isFinite(value) || value < 0) {
        throw fail("input_invalid", zh
          ? `设置项 ${key} 缺失或不是非负数字（读到 ${JSON.stringify(value)}）。墙钟下限由它算出：${key} 必须来自实测值，不能在这里猜一个。`
          : `the ${key} setting is missing or not a non-negative number (read ${JSON.stringify(value)}). The wall-clock floor is computed from it, and it must come from the measured value rather than a guess in this file.`);
      }
    }
    const floor = computeWallFloorMs({
      maxArxiv: caps.maxArxiv,
      maxFetch: caps.maxFetch,
      arxivIntervalMs,
      fetchIntervalMs,
      parseP50Ms,
    });

    // G1 / G4 — the gate. `budgetGate` catches an estimator throw itself and
    // returns a `pass` that says the meter was unavailable; a second try/catch
    // here would swallow that difference, so there is not one.
    const verdict = budgetGate({
      caps,
      floor,
      history: costHistory(store, { depth: mission.depth, excludeId: missionId }),
    });

    if (verdict.verdict === "refused") {
      // NEVER returned. `checkGateOutput` turns a refused verdict into
      // `stage_contract_violation`, which is the wrong code for a budget that
      // does not fit, and the reason is `budgetGate`'s own sentence verbatim —
      // two wordings of one refusal is the same defect as two names for one
      // method.
      emit("gate:refused", verdict);
      throw fail("budget_exhausted", verdict.reason);
    }

    // G3 — the context window is read, never defaulted. A guessed window makes
    // every shrink decision downstream wrong in the same direction, which is
    // worse than having no plan at all.
    const plan = readContextPlan(ctx, logger);
    const degraded = plan.contextWindow === null;
    const degradeNote = degraded
      ? (zh
        ? `无法读取所路由模型的上下文窗口（${plan.why}）。contextPlan.contextWindow 记为 null：不猜一个数字，后续阶段按最小可行输入运行。`
        : `the routed model's context window could not be read (${plan.why}). contextPlan.contextWindow is null rather than a guess; later stages run on the smallest input that works.`)
      : undefined;

    emit("mission:started", {
      topic: mission.topic,
      depth: mission.depth,
      tier,
      caps,
      floorMs: floor.floorMs,
      floorTerms: floor.terms,
      verdict: verdict.verdict,
      language: mission.language,
    });

    return {
      // caps / gate / contextPlan are written into crossState BY THE RUNTIME
      // from this output. Returning them in a crossPatch as well would make two
      // writers of one key.
      output: {
        caps: {
          maxTokens: caps.maxTokens,
          maxCalls: caps.maxCalls,
          maxArxiv: caps.maxArxiv,
          maxWeb: caps.maxWeb,
          maxFetch: caps.maxFetch,
          wallMs: caps.wallMs,
        },
        gate: verdict,
        contextPlan: { contextWindow: plan.contextWindow, defaultMaxTokens: plan.defaultMaxTokens, shrinkBy: {} },
        floor,
      },
      degraded,
      degradeNote,
      crossPatch: {
        libraryCensus: libraryCensus(sourceStore, logger),
        // Never a bare []. An empty array and "we have no way to look" are the
        // same value with opposite meanings, and the claim ledger the
        // postmortem corpus would come from does not exist yet.
        postmortems: {
          available: false,
          why: zh
            ? "尚无索赔账本（claim ledger），因此没有可读的历史复盘。这是“无法查看”，不是“查看后为空”。"
            : "there is no claim ledger yet, so no postmortem corpus can be read. This is 'we cannot look', not 'we looked and found none'.",
          entries: [],
        },
        // The one copy of the ladder, so the meter, the warning text and the
        // degrade steps all read the same four numbers.
        ladder: LADDER,
        tierPolicy: TIER_POLICY[tier] ?? TIER_POLICY.standard,
      },
    };
  };
}

/**
 * What work like this has actually cost, from history rather than arithmetic on
 * the ceiling the user just picked.
 *
 * `listMissions` already attaches each row's spend sum in one query over the
 * page, so this is one statement rather than one `spendTotals` per mission —
 * the same N+1 the store's own comment calls out on the list path.
 *
 * @param store - the MissionStore.
 * @param options - `{depth, excludeId}`.
 * @returns a function returning `{p50, p90, n}`, or null when there is no history.
 */
function costHistory(store, { depth, excludeId }) {
  return () => {
    const page = store.listMissions({ depth, take: 100 });
    const samples = page.missions
      .filter((row) => row.id !== excludeId && row.completedAt !== null && (row.spend?.tokens ?? 0) > 0)
      .map((row) => row.spend.tokens)
      .sort((a, b) => a - b);
    if (samples.length === 0) return null;
    return { p50: quantile(samples, 0.5), p90: quantile(samples, 0.9), n: samples.length };
  };
}

/**
 * The routed model's context window, or null with the reason it is null.
 *
 * The harness exposes model metadata differently across builds, so a short,
 * NAMED list of accessors is tried and the answer says which one produced it.
 * What this must never do is default to a number.
 *
 * @param ctx - the Cordis context.
 * @param logger - optional.
 * @returns `{contextWindow, defaultMaxTokens, source, why}`.
 */
function readContextPlan(ctx, logger) {
  const unknown = (why) => ({ contextWindow: null, defaultMaxTokens: null, source: null, why });
  if (ctx === null || ctx === undefined) return unknown("no Cordis context was passed to the handler factory");

  let route;
  try {
    route = ctx.agentDefaultModel?.currentSelection?.();
  } catch (cause) {
    logger?.warn?.(`mission: agentDefaultModel.currentSelection() threw: ${cause.message}`);
    return unknown(`agentDefaultModel.currentSelection() threw: ${cause.message}`);
  }
  if (route === undefined || route === null) return unknown("agentDefaultModel.currentSelection() answered nothing");

  const candidates = [
    { source: "route", read: () => route },
    { source: "llm.modelInfo", read: () => ctx.llm?.modelInfo?.(route.provider, route.model) },
    { source: "llm.models", read: () => ctx.llm?.models?.()?.find?.((entry) => entry?.model === route.model) },
  ];
  for (const candidate of candidates) {
    let info;
    try {
      info = candidate.read();
    } catch {
      continue;
    }
    const window = Number(info?.contextWindow ?? info?.contextLength ?? info?.maxInputTokens);
    if (Number.isInteger(window) && window > 0) {
      const output = Number(info?.defaultMaxTokens ?? info?.maxOutputTokens);
      return {
        contextWindow: window,
        defaultMaxTokens: Number.isInteger(output) && output > 0 ? output : null,
        source: candidate.source,
        why: null,
      };
    }
  }
  return unknown(`neither ${candidates.map((entry) => entry.source).join(", ")} reported a context window for ${route.provider}/${route.model}`);
}

/**
 * What the library already holds, as leads rather than as a corpus.
 *
 * The library stores no body text — its abstracts average a couple of hundred
 * characters — so this is a census of what is worth fetching, never of what can
 * be quoted. `withAbstract` is null with a reason rather than 0 when it cannot
 * be counted, because 0 reads as "nothing has an abstract".
 *
 * @param sourceStore - the SourceStore over the same connection.
 * @param logger - optional.
 * @returns `{rows, byType, withAbstract, why}`.
 */
function libraryCensus(sourceStore, logger) {
  if (typeof sourceStore?.query !== "function") {
    return { rows: 0, byType: {}, withAbstract: null, why: "the source library is not open for this process, so nothing could be counted" };
  }
  const byType = {};
  let rows = 0;
  try {
    rows = sourceStore.query({ take: 1 }).total;
    for (const type of LIBRARY_TYPES) byType[type] = sourceStore.query({ type, take: 1 }).total;
  } catch (cause) {
    logger?.warn?.(`mission: library census failed: ${cause.message}`);
    return { rows, byType, withAbstract: null, why: `the census query failed: ${cause.message}` };
  }
  try {
    const counted = sourceStore.db
      .prepare("SELECT COUNT(*) AS n FROM resources WHERE abstract IS NOT NULL AND TRIM(abstract) != ''")
      .get().n;
    return { rows, byType, withAbstract: counted, why: null };
  } catch (cause) {
    return { rows, byType, withAbstract: null, why: `the abstract count failed: ${cause.message}` };
  }
}

/* ── s2-plan ───────────────────────────────────────────────────────────── */

/** The Leader's plan schema. `finalize`'s parameters IS this, so the provider enforces it first. */
const PLAN_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["dimensions", "goals"],
  properties: {
    dimensions: {
      type: "array",
      minItems: 2,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimensionId", "name", "rationale", "facet"],
        properties: {
          dimensionId: { type: "string", minLength: 2, maxLength: 48, description: "a short hyphenated id, unique among the dimensions" },
          name: { type: "string", minLength: 4, maxLength: 120 },
          rationale: { type: "string", minLength: 20, maxLength: 600, description: "why this slice is worth a researcher's whole budget" },
          facet: { type: "string", enum: [...FACETS] },
        },
      },
    },
    goals: {
      type: "object",
      additionalProperties: false,
      required: ["successCriteria", "qualityBar"],
      properties: {
        successCriteria: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 10, maxLength: 300 } },
        qualityBar: {
          type: "object",
          additionalProperties: false,
          required: ["minVerifiedFindings", "minIndependentSources", "minCoverage"],
          properties: {
            minVerifiedFindings: { type: "integer", minimum: 1, maximum: 20 },
            minIndependentSources: { type: "integer", minimum: 1, maximum: 20 },
            minCoverage: { type: "integer", minimum: 0, maximum: 100 },
          },
        },
      },
    },
    rationale: { type: "string", maxLength: 1200 },
  },
});

/**
 * Stage two: the Leader names the dimensions and sets the bar it will later be
 * held to.
 *
 * Every gate below is code around the model rather than a sentence inside it.
 * The facet the Leader guesses is OVERWRITTEN when it is not one this system
 * knows — playground's tag fallback excluded every academic tool for 332
 * consecutive missions, and the lesson taken is not "port the repair" but "do
 * not let a model's guess narrow a catalogue at all".
 *
 * @param deps - `{store, chat, circuit, cache, spillDir, ctx, logger, prompts}`.
 * @returns the `s2-plan` handler.
 */
export function createS2Plan(deps) {
  const { store, chat, circuit = null, cache = null, spillDir = null, ctx = null, logger = null } = deps ?? {};
  if (typeof chat !== "function") throw new TypeError("createS2Plan needs the agent seam as deps.chat; no stage writes its own model loop.");
  if (typeof store?.upsertDimension !== "function") throw new TypeError("createS2Plan needs the MissionStore as deps.store.");
  const prompts = promptsOf(deps);

  return async function s2Plan(context) {
    const { missionId, runCount, mission, tier, stage, signal, crossState, budget, now, logger: runLogger } = context;
    const log = runLogger ?? logger;
    const zh = mission.language !== "en";
    const policy = crossState.tierPolicy ?? TIER_POLICY[tier] ?? TIER_POLICY.standard;
    const target = policy.dimensionTarget;
    // The accepted band, clamped so a two-dimension mission is never demanded
    // to be smaller than something with anything to collect.
    const low = Math.max(2, target - 1);
    const high = target + 1;

    const brief = `u-${stage.id}`;
    const render = (level) => renderPlanInput({ mission, tier, crossState, policy, low, high, zh, level });

    /**
     * The plan's own gate. Returns `issues[]`; the seam turns a non-empty list
     * into a targeted critique the model must answer, cumulatively, three times
     * before the candidate is force-accepted.
     */
    const checkFinalize = (output) => {
      const issues = [];
      const dimensions = Array.isArray(output?.dimensions) ? output.dimensions : [];

      // G1 — no dimensions at all. Fatal after the rejects are spent, and fatal
      // HERE rather than three stages later where the symptom is "the report is
      // empty".
      if (dimensions.length === 0) {
        issues.push(zh
          ? `你没有给出任何维度。没有维度的任务无从收集；请指名 ${low}–${high} 个。`
          : `you named no dimensions. A mission with no dimensions has nothing to collect; name between ${low} and ${high}.`);
        return issues;
      }

      // G2 — the band, with BOTH numbers named. "Too many" without the target
      // is a critique the model can only guess at.
      if (dimensions.length < low || dimensions.length > high) {
        issues.push(zh
          ? `你给了 ${dimensions.length} 个维度，本档位的目标是 ${target} 个，可接受区间是 ${low}–${high}。请增删到区间内。`
          : `you named ${dimensions.length} dimensions; this tier targets ${target} and accepts ${low}–${high}. Add or merge until you are inside that band.`);
      }

      // G3 — duplicate ids. `upsertDimension` would silently MERGE two
      // dimensions into one row and every count downstream would read correct.
      const seen = new Map();
      for (const [index, entry] of dimensions.entries()) {
        const id = slugOf(entry?.dimensionId, `dimension-${index + 1}`);
        if (seen.has(id)) {
          issues.push(zh
            ? `维度 id "${id}" 出现了两次（"${seen.get(id)}" 和 "${entry?.name ?? ""}"）。两个同 id 的维度会被合并成一行，计数看起来仍然正确。请给每个维度一个不同的 id。`
            : `dimension id "${id}" appears twice ("${seen.get(id)}" and "${entry?.name ?? ""}"). Two dimensions under one id merge into a single row and every count still reads correct. Give each one a distinct id.`);
        }
        seen.set(id, entry?.name ?? "");
      }

      const criteria = output?.goals?.successCriteria;
      if (!Array.isArray(criteria) || criteria.length === 0) {
        issues.push(zh
          ? "goals.successCriteria 为空。你会在 s11 按自己写下的标准被问责；不写就等于让终审用一条通用标准来评这份报告。"
          : "goals.successCriteria is empty. You are held to your own criteria at sign-off; leaving them out means the report is graded against a generic bar it never set.");
      }
      return issues;
    };

    const ledgerRows = [];
    const run = await chat({
      agent: stage.agent,
      stepId: stage.id,
      missionId,
      runCount,
      duty: "plan",
      system: prompts(stage.agent, "plan"),
      messages: [briefMessage(brief, render(0))],
      shrink: shrinkerFor({ id: brief, render, rungs: stage.shrinkLadder }),
      language: mission.language,
      now,
      // No `tools` array is built here. `recallTools` runs inside the seam, per
      // call, and the prompt's tool section is generated from its answer; a
      // catalogue built in the stage as well would be a second builder, and the
      // ACL and the prompt could then disagree.
      spec: { forbiddenTools: [] },
      facet: "general",
      inputBudgetTokens: stage.inputBudgetTokens,
      shrinkLadder: stage.shrinkLadder,
      maxTokens: stage.maxOutputTokens,
      signal,
      budget,
      circuit,
      cache,
      spillDir,
      ledger: watchingLedger({
        base: createSqliteLedger(store, { missionId, stepId: stage.id }),
        onRow: (row) => ledgerRows.push(row),
        logger: log,
      }),
      finalizeTool: finalizeToolFor(PLAN_SCHEMA, { description: "Record the plan. The mission is collected against exactly these dimensions, and you are held to the quality bar you set here." }),
      checkFinalize,
      onUsage: spendRecorder({ store, missionId, stage, now, logger: log }),
    });

    if (run.state === "failed") throw Object.assign(new Error(run.diagnostic), { code: run.failureCode });

    const raw = Array.isArray(run.output?.dimensions) ? run.output.dimensions : [];
    // G1, after the release. The seam force-accepts on the fourth rejection and
    // suppresses a poisoned candidate to an EMPTY output, so this is reachable
    // and it is fatal.
    if (raw.length === 0) {
      throw fail("input_invalid", zh
        ? `s2 产出零个维度。没有维度的任务无从收集；请指名 ${low}–${high} 个。`
        : `s2-plan produced no dimensions. A mission with no dimensions has nothing to collect; name between ${low} and ${high}.`);
    }

    const decisions = [...(crossState.leaderDecisions ?? [])];
    const at = now();
    const dimensions = [];
    const usedIds = new Set();
    let facetsOverwritten = 0;

    for (const [index, entry] of raw.entries()) {
      let id = slugOf(entry?.dimensionId, `dimension-${index + 1}`);
      // A duplicate that survived the critiques is disambiguated rather than
      // merged: the merge is silent, and silence is the failure here.
      if (usedIds.has(id)) id = `${id}-${index + 1}`;
      usedIds.add(id);

      // G4 — the facet is overwritten in code, and it is never a failure.
      // `FACET_TOOL_ORDER` decides the recommended tools regardless of what the
      // Leader guessed.
      const guess = String(entry?.facet ?? "").toLowerCase();
      const facet = FACETS.includes(guess) ? guess : "general";
      if (facet !== guess) facetsOverwritten += 1;

      dimensions.push({
        dimensionId: id,
        name: String(entry?.name ?? id).slice(0, 120),
        rationale: typeof entry?.rationale === "string" ? entry.rationale.slice(0, 600) : null,
        facet,
      });
    }

    // G5 — the coverage clamp, recorded where the Leader will read it again.
    const bar = run.output?.goals?.qualityBar ?? {};
    const wanted = Number(bar.minCoverage);
    const minCoverage = Number.isFinite(wanted) ? Math.min(MAX_MIN_COVERAGE, Math.max(0, Math.round(wanted))) : MAX_MIN_COVERAGE;
    if (Number.isFinite(wanted) && wanted > MAX_MIN_COVERAGE) {
      decisions.push({
        phase: "plan",
        at,
        label: `clamp-minCoverage:${Math.round(wanted)}→${MAX_MIN_COVERAGE}`,
        detail: zh
          ? `你把 minCoverage 定在 ${Math.round(wanted)}；提示词要求 60–80，已按上限裁到 ${MAX_MIN_COVERAGE}。这条记录会在你写前言时再次出现。`
          : `you set minCoverage to ${Math.round(wanted)}; the bar accepts 60–80 and it was clamped to ${MAX_MIN_COVERAGE}. This correction is shown to you again at foreword time.`,
      });
    }

    const goals = {
      successCriteria: (Array.isArray(run.output?.goals?.successCriteria) ? run.output.goals.successCriteria : [])
        .slice(0, 8)
        .map((line) => String(line).slice(0, 300)),
      qualityBar: {
        minVerifiedFindings: clampInteger(bar.minVerifiedFindings, 1, 20, policy.findingTarget),
        minIndependentSources: clampInteger(bar.minIndependentSources, 1, 20, policy.citationFloor),
        minCoverage,
      },
    };

    decisions.push({
      phase: "plan",
      at,
      label: `plan:${dimensions.length}-dimensions`,
      detail: dimensions.map((entry) => `${entry.dimensionId} (${entry.facet})`).join(", "),
    });

    // One transaction, no `await` inside it: on one shared connection an await
    // between the open and the close lets the hourly collector's inserts run
    // inside this transaction, where a rollback discards them.
    store.withTx(() => {
      for (const entry of dimensions) {
        store.upsertDimension({ missionId, dimensionId: entry.dimensionId, name: entry.name, rationale: entry.rationale, facet: entry.facet, state: "pending", at });
      }
    });

    // G6 — the goals must persist. A resumed mission with no stored goals is
    // reviewed against a generic bar it never set.
    const stored = store.setGoals(missionId, goals, at);
    if (stored !== true) {
      throw fail("input_invalid", zh
        ? "missions.goals 未能写入（setGoals 返回 false，通常意味着这一行已经不在了）。带着未存目标继续，会让 s11 用一条通用标准评这份报告。"
        : "missions.goals was not written (setGoals returned false, which means the row is gone). Continuing without stored goals would have the sign-off grade this report against a generic bar it never set.");
    }

    const shrunk = shrinkRungOf(run);
    const overBudget = overBudgetOf(run);
    const degraded = run.state === "degraded" || overBudget;
    const notes = [];
    if (run.state === "degraded") notes.push(run.diagnostic);
    if (overBudget) {
      notes.push(zh
        ? `计划输入走完全部 ${stage.shrinkLadder.length} 级收缩后仍高于 ${stage.inputBudgetTokens} 的输入预算，调用照常发出。`
        : `the plan input stayed above the ${stage.inputBudgetTokens} input budget after all ${stage.shrinkLadder.length} shrink rungs, and the call went out anyway.`);
    }

    return {
      output: {
        dimensions,
        goals,
        facetsOverwritten,
        shrinkRung: shrunk === 0 ? null : stage.shrinkLadder[shrunk - 1],
        toolCalls: ledgerRows.length,
      },
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens: run.tokens?.total ?? 0,
      crossPatch: {
        dimensions,
        goals,
        // APPEND-ONLY, and the whole array is returned: crossPatch is a shallow
        // merge, so a sub-key cannot be patched.
        leaderDecisions: decisions,
        contextPlan: withShrink(crossState.contextPlan, stage.id, shrunk),
      },
    };
  };
}

/** The plan prompt at one shrink rung. Rung 1 drops postmortems, rung 2 reduces the census to counts. */
function renderPlanInput({ mission, tier, crossState, policy, low, high, zh, level }) {
  const census = crossState.libraryCensus ?? { rows: 0, byType: {}, withAbstract: null };
  const postmortems = crossState.postmortems ?? { available: false, why: "not read", entries: [] };
  const caps = crossState.caps ?? mission.budget;

  const lines = [
    zh ? `课题：${mission.topic}` : `TOPIC: ${mission.topic}`,
    zh ? `档位：${tier}` : `TIER: ${tier}`,
    zh
      ? `维度数量：目标 ${policy.dimensionTarget} 个，可接受 ${low}–${high} 个。`
      : `DIMENSIONS: target ${policy.dimensionTarget}, accepted range ${low}–${high}.`,
    zh
      ? `每个维度的已验证发现初始目标 ${policy.findingTarget} 条。这只是种子；真正的下限在 s3 之后由实测供给推出。`
      : `Initial target of ${policy.findingTarget} verified findings per dimension. That is a seed only: the operative floor is derived from measured supply after collection.`,
    zh
      ? `上限（已冻结，不要重新协商）：${caps.maxCalls} 次模型调用、${caps.maxTokens} tokens、${caps.maxArxiv} 次 arXiv、${caps.maxWeb} 次网页搜索、${caps.maxFetch} 次抓取、${Math.round(caps.wallMs / 60000)} 分钟墙钟。`
      : `CEILINGS (frozen; do not renegotiate them): ${caps.maxCalls} model calls, ${caps.maxTokens} tokens, ${caps.maxArxiv} arXiv requests, ${caps.maxWeb} web searches, ${caps.maxFetch} page fetches, ${Math.round(caps.wallMs / 60000)} minutes of wall clock.`,
  ];

  if (level === 0) {
    lines.push(zh
      ? `本地文献库存量：${census.rows} 条，其中带出版方摘要 ${census.withAbstract ?? "未知"} 条；按类型：${JSON.stringify(census.byType)}。库里只有线索（标题与摘要），没有正文，任何引语都必须来自抓取的页面。`
      : `LOCAL LIBRARY: ${census.rows} rows, ${census.withAbstract ?? "an unknown number"} with a publisher abstract; by type ${JSON.stringify(census.byType)}. The library holds leads — titles and abstracts — and no body text, so every quote must come from a fetched page.`);
    lines.push(postmortems.available === true
      ? `PRIOR MISSIONS: ${JSON.stringify(postmortems.entries).slice(0, 2000)}`
      : (zh ? `历史复盘：${postmortems.why}` : `PRIOR MISSIONS: ${postmortems.why}`));
  } else if (level === 1) {
    lines.push(zh
      ? `本地文献库存量：${census.rows} 条，其中带出版方摘要 ${census.withAbstract ?? "未知"} 条；按类型：${JSON.stringify(census.byType)}。`
      : `LOCAL LIBRARY: ${census.rows} rows, ${census.withAbstract ?? "an unknown number"} with a publisher abstract; by type ${JSON.stringify(census.byType)}.`);
  } else {
    lines.push(zh ? `本地文献库存量：${census.rows} 条。` : `LOCAL LIBRARY: ${census.rows} rows.`);
  }

  lines.push(zh
    ? "用 finalize 提交计划：维度，以及你为这份报告设下的成功标准和质量线。你将在终审时按自己写下的标准被问责。"
    : "Submit the plan with finalize: the dimensions, and the success criteria and quality bar you set for this report. You are held to your own criteria at sign-off.");
  return lines.join("\n\n");
}

/* ── s3-collect ────────────────────────────────────────────────────────── */

/** The researcher's output schema. `finalize` is refused, in code, until it has earned it. */
const COLLECT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["findings", "summary"],
  properties: {
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "url", "quote"],
        properties: {
          statement: { type: "string", minLength: 20, maxLength: 400, description: "one sentence, specific enough to be wrong" },
          url: { type: "string", minLength: 8, maxLength: 2000, description: "the page you fetched the quote from" },
          quote: { type: "string", minLength: 20, maxLength: 1200, description: "verbatim, from ONE continuous passage; do not join two" },
        },
      },
    },
    summary: { type: "string", minLength: 20, maxLength: 1500 },
    rejected: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "why"],
        properties: { url: { type: "string", maxLength: 2000 }, why: { type: "string", maxLength: 300 } },
      },
    },
  },
});

/**
 * Stage three: one researcher per dimension, sequentially, and the gate that
 * makes the loop reliable.
 *
 * Sequential because there is one process, one connection and one pacer: a
 * second concurrent researcher doubles the request rate the pacer exists to
 * hold, and the jsdom parse behind every fetch is blocking CPU on the shared
 * event loop.
 *
 * Findings live in `mission_findings`, never in `crossState` — the checkpoint is
 * JSON-serialised after every stage, and a run's findings there would be
 * written twelve times on the connection the mission runs on.
 *
 * @param deps - `{store, sourceStore, chat, circuit, cache, spillDir, config, ctx, logger, prompts}`.
 * @returns the `s3-collect` handler.
 */
export function createS3Collect(deps) {
  const {
    store, sourceStore = null, chat, circuit = null, cache = new Map(),
    spillDir = null, config = {}, ctx = null, logger = null,
  } = deps ?? {};
  if (typeof chat !== "function") throw new TypeError("createS3Collect needs the agent seam as deps.chat; no stage writes its own model loop.");
  if (typeof store?.insertFinding !== "function") throw new TypeError("createS3Collect needs the MissionStore as deps.store.");
  const prompts = promptsOf(deps);

  return async function s3Collect(context) {
    const { missionId, runCount, mission, tier, stage, attempt, signal, crossState, budget, now, logger: runLogger } = context;
    const log = runLogger ?? logger;
    const zh = mission.language !== "en";
    const policy = crossState.tierPolicy ?? TIER_POLICY[tier] ?? TIER_POLICY.standard;

    const planned = Array.isArray(crossState.dimensions) ? crossState.dimensions : [];
    if (planned.length === 0) {
      throw fail("input_invalid", zh
        ? "crossState.dimensions 为空：s3 不知道该收集什么。s2 必须先写出维度。"
        : "crossState.dimensions is empty, so s3-collect has nothing to collect. s2-plan must name the dimensions first.");
    }

    // On a recollect round the target set narrows to the WEAKEST two, chosen by
    // ascending verified count rather than by what the Leader found most
    // interesting: fixing the weakest two while four keep working beats redoing
    // five and having them all collapse. The round CAP is not re-checked here —
    // `evaluateBackEdge` reads `missions.patch_round` against MAX_PATCH_ROUNDS
    // inside the runtime's own transaction, and a second implementation of a
    // termination condition is how a loop acquires two answers.
    const recollecting = crossState.assessment?.decision === "recollect";
    let targets = planned;
    let narrowedTo = null;
    if (recollecting) {
      const weakest = store.weakestDimensions(missionId, {
        limit: 2,
        runCount,
        below: Number.isFinite(mission.derivedFloor) ? mission.derivedFloor : undefined,
      });
      const wanted = new Set(weakest.map((row) => row.dimensionId));
      const narrowed = planned.filter((entry) => wanted.has(entry.dimensionId));
      if (narrowed.length > 0) {
        targets = narrowed;
        narrowedTo = narrowed.map((entry) => entry.dimensionId);
      }
    }

    const perDimension = [];
    const stoppedTools = new Set();
    const decisions = [];
    let tokens = 0;
    let stopReason = null;

    for (const dimension of targets) {
      if (signal.aborted === true) {
        stopReason = "cancelled";
        break;
      }
      if (budget?.isExhausted?.() === true) {
        stopReason = "budget";
        break;
      }
      const outcome = await collectOneDimension({
        deps: { store, sourceStore, chat, circuit, cache, spillDir, config, ctx, logger: log, prompts },
        context,
        dimension,
        policy,
        zh,
      });
      perDimension.push(outcome.summary);
      tokens += outcome.tokens;
      for (const tool of outcome.stoppedTools) stoppedTools.add(tool);
      if (outcome.stopStage !== null) {
        stopReason = outcome.stopStage;
        break;
      }
    }

    // Every dimension writes exactly one terminal state on every path,
    // including the path where the stage stopped before reaching it. A row left
    // `pending` reads as "still working" for ever on the card.
    const reached = new Set(perDimension.map((entry) => entry.dimensionId));
    if (reached.size < targets.length) {
      const at = now();
      const why = stopReason === "cancelled"
        ? (zh ? "任务在轮到这个维度之前被取消。" : "the mission was cancelled before this dimension's turn.")
        : (zh ? `任务在轮到这个维度之前停止：${stopReason ?? "上游维度耗尽了预算或额度"}。` : `collection stopped before this dimension's turn: ${stopReason ?? "an upstream dimension exhausted the budget or an allowance"}.`);
      const code = stopReason === "cancelled" ? "user_cancelled" : "budget_exhausted";
      store.withTx(() => {
        for (const entry of targets) {
          if (reached.has(entry.dimensionId)) continue;
          store.setDimensionState(missionId, entry.dimensionId, "failed", { failureCode: code, summary: why, at });
          perDimension.push({
            dimensionId: entry.dimensionId,
            state: "failed",
            verified: 0,
            attempted: 0,
            pagesFetched: 0,
            hostsTried: [],
            refusals: [],
            failureCode: code,
            note: why,
          });
        }
      });
    }

    // G7 — the derived floor, from measured supply, written BEFORE the stage
    // settles. `evidenceFloorGate` returns outcome "ok" when floorSum <= 0, so
    // an unwritten floor silently disables the thin-evidence check that is the
    // whole point of the gate.
    const counts = store.listDimensions(missionId, { runCount }).map((row) => row.verified);
    const floor = Math.min(policy.findingTarget, Math.max(2, Math.round(median(counts))));
    if (store.setDerivedFloor(missionId, floor, now()) !== true) {
      throw fail("input_invalid", zh
        ? "missions.derived_floor 未能写入。没有下限，证据薄弱检查会静默失效（floorSum <= 0 时闸门直接返回 ok），报告会带着无法支撑它的证据继续写下去。"
        : "missions.derived_floor was not written. Without it the thin-evidence gate silently passes — it returns 'ok' whenever the summed floor is zero — and the report continues on evidence that cannot support it.");
    }

    // G8 — dimension outcomes. All failed is fatal and it is `no_evidence`,
    // which is a true statement about the run rather than a guess about a
    // provider.
    //
    // NOT on a narrowed recollect round. That pass deliberately touches two of
    // five dimensions, so "every dimension in this pass failed" would be
    // `no_evidence` about a mission that already has three dimensions of
    // verified findings — the one message that reads as a fact about the topic
    // rather than as a bug here. On that path the evidence floor gate, which
    // counts across attempts, is the honest judge.
    const failed = perDimension.filter((entry) => entry.state === "failed");
    if (narrowedTo === null && perDimension.length > 0 && failed.length === perDimension.length) {
      throw fail("no_evidence", zh
        ? `全部 ${failed.length} 个维度都失败了：${failed.map((entry) => `${entry.dimensionId}（${entry.failureCode ?? "未知"}）`).join("、")}。没有任何一个维度产出可核验的证据。`
        : `all ${failed.length} dimensions failed: ${failed.map((entry) => `${entry.dimensionId} (${entry.failureCode ?? "unknown"})`).join(", ")}. Not one produced checkable evidence.`);
    }

    // A degraded dimension counts. G8's arithmetic is about FAILED dimensions,
    // but a stage that swallowed a degradation and returned `degraded: false`
    // is the omission the stage contract inverts: "half the dimensions missing,
    // mission looks fine" is what that looks like from outside.
    const thin = perDimension.filter((entry) => entry.state === "degraded");
    const degraded = failed.length * 2 > perDimension.length || thin.length > 0 || stopReason !== null;
    const notes = [];
    if (thin.length > 0) {
      notes.push(zh
        ? `${thin.length}/${perDimension.length} 个维度降级：${thin.map((entry) => `${entry.dimensionId}（${entry.note ?? "原因未记录"}）`).join("；")}。`
        : `${thin.length} of ${perDimension.length} dimensions settled degraded: ${thin.map((entry) => `${entry.dimensionId} (${entry.note ?? "no reason recorded"})`).join("; ")}.`);
    }
    if (failed.length > 0) {
      notes.push(zh
        ? `${failed.length}/${perDimension.length} 个维度失败：${failed.map((entry) => `${entry.dimensionId}（${entry.note ?? entry.failureCode ?? "未知"}）`).join("；")}。`
        : `${failed.length} of ${perDimension.length} dimensions failed: ${failed.map((entry) => `${entry.dimensionId} (${entry.note ?? entry.failureCode ?? "unknown"})`).join("; ")}.`);
    }
    if (stopReason !== null) {
      notes.push(zh
        ? `收集在全部维度完成前停止（${stopReason}）。`
        : `collection stopped before every dimension ran (${stopReason}).`);
    }

    if (narrowedTo !== null) {
      decisions.push({
        phase: "collect",
        at: now(),
        label: `recollect:${narrowedTo.join(",")}`,
        detail: zh
          ? `本轮只重收最薄弱的 ${narrowedTo.length} 个维度；其余维度的既有发现保留在上一轮的 attempt 里。`
          : `this round re-collected only the weakest ${narrowedTo.length} dimensions; every other dimension keeps the findings of its earlier attempt.`,
      });
    }

    return {
      output: {
        derivedFloor: floor,
        attempt,
        perDimension,
        stoppedTools: [...stoppedTools],
        stopReason,
      },
      degraded,
      degradeNote: degraded ? (notes.join(" ") || (zh ? "收集阶段未按计划完成。" : "collection did not complete as planned.")) : undefined,
      tokens,
      crossPatch: {
        derivedFloor: floor,
        collection: { perDimension, stoppedTools: [...stoppedTools], stopReason },
        leaderDecisions: decisions.length === 0
          ? (crossState.leaderDecisions ?? [])
          : [...(crossState.leaderDecisions ?? []), ...decisions],
      },
    };
  };
}

/**
 * One researcher, one dimension, from `collecting` to a terminal state.
 *
 * Returns rather than throws: one dimension failing is a fact about that
 * dimension, and killing the stage for it would discard the four that worked.
 * The stage's own G8 decides what the set of outcomes means.
 *
 * @param options - `{deps, context, dimension, policy, zh}`.
 * @returns `{summary, tokens, stoppedTools, stopStage}`.
 */
async function collectOneDimension({ deps, context, dimension, policy, zh }) {
  const { store, sourceStore, chat, circuit, cache, spillDir, config, ctx, logger: log, prompts } = deps;
  const { missionId, runCount, mission, stage, attempt, signal, crossState, budget, now } = context;

  // Everything the model reads and everything the stage learns about what it
  // read passes through these three.
  const pages = new Map();          // pageKey -> {url, title, markdown}
  const blocks = new Map();         // page url -> markdown, for quote_verify
  const refusals = [];              // {tool, code, error, url}
  const stoppedTools = new Set();
  const touched = [];               // {tool, argsHash, ok} rows from the ledger
  const seenResults = new Set();    // tool-result ids already harvested

  let unreadRefusals = 0;
  let oneHostRefusals = 0;
  let unverifiedRefusals = 0;
  let spanIndexMisses = 0;
  let fetchesSucceeded = 0;
  let unreadableFetches = 0;
  let accepted = null;

  /**
   * Pull every page the model has actually been shown into `pages`, DURING the
   * run, so the finalize gate can refuse on what was really read.
   *
   * NOT from the transcript. `mission-agent.js` copies the seed array rather
   * than mutating it — deliberately, so a stage that retries can re-send the
   * brief it built instead of the transcript of a failed try — so the array
   * this stage passed in never grows and a transcript scan here would see
   * nothing and refuse every finish. The live channel is the tool door itself:
   * the ledger fires once per call with `(tool, argsHash)`, and the shared
   * cache holds the FULL observation for every cacheable tool under
   * `${tool}:${argsHash}`. A fetch that succeeded but whose cache entry cannot
   * be found is COUNTED rather than ignored, because a page the stage cannot
   * see is a quote the stage cannot verify, and that has to surface as a
   * degradation instead of as an empty dimension.
   */
  const syncPages = () => {
    for (const row of touched) {
      if (row.tool !== "fetch_page" || row.ok !== true || row.absorbed === true) continue;
      row.absorbed = true;
      fetchesSucceeded += 1;
      const hit = cache instanceof Map ? cache.get(`fetch_page:${row.argsHash}`) : undefined;
      if (hit === undefined) {
        unreadableFetches += 1;
        continue;
      }
      absorbObservation(hit);
    }
  };

  /**
   * The finished transcript, for the observations the cache never holds.
   *
   * Only successes are cached — caching a refusal would remember a rate limit
   * as though it were an answer — so every refusal reaches the stage from here,
   * after the run. Refusal payloads are small, so the seam's 12,000-character
   * truncation never damages one; a large success that fails to parse is
   * already carried by the cache pass above.
   *
   * @param transcript - `run.messages`.
   */
  const absorbTranscript = (transcript) => {
    for (const message of transcript) {
      if (message?.role !== "tool") continue;
      for (const part of message.content ?? []) {
        if (part?.type !== "tool-result" || seenResults.has(part.toolCallId)) continue;
        seenResults.add(part.toolCallId);
        const text = part.content?.map((block) => block?.text ?? "").join("") ?? "";
        try {
          absorbObservation(JSON.parse(text));
        } catch {
          // A truncated large result; the cache pass already carried it.
        }
      }
    }
  };

  /** One tool observation, classified: a page, a refusal, or nothing. */
  const absorbObservation = (value) => {
    if (value === null || typeof value !== "object") return;
    if (value.ok === false) {
      const code = String(value.code ?? "");
      refusals.push({ tool: String(value.tool ?? ""), code, error: String(value.error ?? ""), url: typeof value.url === "string" ? value.url : null });
      // A refusal is not an empty result. `stopStage` is the tool door's own
      // word for "stop calling me", and it rides on the observation rather than
      // being inferred from a count of zero.
      if (value.stopStage === true || code === "rate_limited" || code.startsWith("budget_exhausted")) {
        stoppedTools.add(String(value.tool ?? ""));
      }
      return;
    }
    if (value.tool !== "fetch_page" || typeof value.url !== "string") return;
    // The tool's own extraction, stored as the document body and used as the
    // verification block. `quotableAgainst` names the string the span rule runs
    // against, and this is that string: a quote checked against a different
    // extraction of the same page is a quote checked against nothing.
    const body = typeof value.text === "string" ? value.text : (typeof value.markdown === "string" ? value.markdown : "");
    if (body.trim() === "") return;
    const key = pageKey(value.url);
    if (pages.has(key)) return;
    pages.set(key, { url: value.url, title: typeof value.title === "string" ? value.title : null, markdown: body });
    blocks.set(value.url, body);
  };

  /**
   * The tool context. `blocks` is a GETTER because the tool door spreads this
   * object (`{...ctx, signal}`) immediately before every call, which makes the
   * spread the one moment a stage can refresh what `quote_verify` checks
   * against without inventing a second dispatch path.
   */
  const toolContext = {
    store: sourceStore,
    // Resolved NOW, never captured at apply time, and it must be HERE as well as
    // in `recallTools`: recall decides whether `web_search` is in the catalogue,
    // but the tool's own `execute` reads `ctx.web` — so a catalogue that offered
    // the tool over a context that omitted it answered every search with "no web
    // search plugin is installed" while one was installed and working. s3 is the
    // only stage that searches, so the omission disabled the seam outright.
    web: typeof ctx?.get === "function" ? ctx.get("web") : undefined,
    denyHosts: Array.isArray(config.missionDenyHosts) ? config.missionDenyHosts : [],
    spillDir,
    get blocks() {
      syncPages();
      return blocks;
    },
  };

  const at = now();
  store.withTx(() => {
    store.setDimensionState(missionId, dimension.dimensionId, "collecting", { countAttempt: true, at });
  });

  let tokens = 0;
  let terminal = "collected";
  let failureCode = null;
  let note = null;
  let stopStage = null;

  try {
    const brief = `u-${dimension.dimensionId}`;
    const render = (level) => renderCollectInput({ mission, dimension, policy, crossState, zh, level });

    /**
     * The gate that matters, and it is CODE.
     *
     * A prompt does not hold this loop: the same topic produced six fetched
     * pages and six findings on one run, and two searches then `finish` on the
     * next. Refusing the finish — once for reading nothing, at most twice for
     * verifying nothing, then RELEASING — is what made it reliable.
     */
    const checkFinalize = (output) => {
      syncPages();
      const issues = [];

      // G1 — refuse a finish that read nothing. The refusal names every page
      // actually fetched, because "you never fetched that" against a page the
      // model did fetch under another spelling is the bookkeeping failure, not
      // a model failure.
      //
      // Refused up to three times, not once. Measured on a real mission: the
      // model was refused once, searched again, finished again without
      // fetching, and the dimension was released empty. Four of eight
      // dimensions ended that way while `fetch_page` had a 100% success rate —
      // it was never the fetching that failed, it was the deciding to fetch.
      if (pages.size === 0) {
        if (unreadRefusals < MAX_READ_NOTHING_REFUSALS) {
          unreadRefusals += 1;
          issues.push(READ_NOTHING_REFUSAL);
          return issues;
        }
        // Released. A dead network must be able to produce an honest empty
        // dimension; §2's evidence floor is what stops honest emptiness
        // becoming a report.
        accepted = { findings: [], summary: String(output?.summary ?? ""), rejected: output?.rejected ?? [], verified: [] };
        return issues;
      }

      // G1b — refuse a dimension covered from ONE host.
      //
      // The same mission: every dimension that produced anything produced it
      // from exactly one host — six findings off a single page, or nothing.
      // The researcher reads "I found a good page" as "this dimension is done",
      // and then the floor it is held to asks for two independent sources and
      // marks it degraded. Six of eight cards said 降级 for a bar the loop was
      // never pushed to clear.
      //
      // Released after one refusal, for the same reason G1 is: one host may be
      // all that exists, and a dimension that says so is more useful than a
      // deadlock.
      const readHosts = new Set([...pages.values()].map((page) => hostOf(page?.url ?? "")).filter((host) => host !== ""));
      if (readHosts.size < INDEPENDENT_SOURCES_WANTED && oneHostRefusals < MAX_ONE_HOST_REFUSALS) {
        oneHostRefusals += 1;
        issues.push(oneHostRefusal(readHosts.size, INDEPENDENT_SOURCES_WANTED));
        return issues;
      }

      const verified = [];
      const list = Array.isArray(output?.findings) ? output.findings : [];
      for (const finding of list) {
        const page = pages.get(pageKey(finding?.url));
        if (page === undefined) {
          // G3 — the canonical key already ran; if it still misses, the model
          // cited something it did not fetch. The seam owns the wording; the
          // list of pages actually fetched is added once, because "you never
          // fetched that" without it is the sentence that cost the spike six
          // findings out of six.
          issues.push(quoteIssue(finding?.quote, finding?.url, QUOTE_FAILURES.NO_SUCH_SOURCE));
          continue;
        }
        // G4 — three arguments, always, and blocks keyed by the page's OWN url,
        // so the stored attribution is the address a reader can open.
        const verdict = verifyQuote(String(finding?.quote ?? ""), new Map([[page.url, page.markdown]]), page.url);
        if (verdict.ok !== true) {
          // Mapped onto the seam's four reasons rather than re-worded. Telling
          // a model it invented a quote it did not invent teaches it to
          // distrust its own correct behaviour, which is a permanent cost paid
          // for a wrong label.
          issues.push(quoteIssue(finding?.quote, page.url, quoteFailureOf(verdict.reason)));
          continue;
        }
        const spanIndex = spanIndexOf(page.markdown, finding.quote);
        if (spanIndex < 0) {
          spanIndexMisses += 1;
          continue;
        }
        verified.push({ ...finding, url: page.url, title: page.title, spanIndex });
      }

      if (issues.length > 0) {
        issues.push(`the pages you have read are: ${[...pages.values()].map((entry) => entry.url).join(", ")}. Every quote must come from one of those.`);
      }

      // G2 — at least one verified finding, refused at most twice, then
      // released.
      if (verified.length === 0 && unverifiedRefusals < MAX_UNVERIFIED_FINISH_REFUSALS) {
        unverifiedRefusals += 1;
        issues.push(`not one finding has a quote that verified against a page you fetched, so this dimension would be recorded as empty. You have read: ${[...pages.values()].map((entry) => entry.url).join(", ")}. Record at least one finding whose quote is copied verbatim from one continuous passage of one of those pages.`);
        return issues;
      }

      // The RELEASE, and it has to be real. Once the refusal budget is spent
      // the candidate is accepted even though issues remain, because a
      // dimension that can never be accepted is a deadlock wearing a release's
      // name — and an honest empty dimension is a useful answer that §2's
      // evidence floor is already there to judge.
      const released = unverifiedRefusals >= MAX_UNVERIFIED_FINISH_REFUSALS;
      if (issues.length === 0 || verified.length > 0 || released) {
        accepted = { findings: list, verified, summary: String(output?.summary ?? ""), rejected: output?.rejected ?? [] };
      }
      return issues;
    };

    const run = await chat({
      agent: stage.agent,
      stepId: stage.id,
      missionId,
      runCount,
      duty: "collect",
      system: prompts(stage.agent, "collect"),
      messages: [briefMessage(brief, render(0))],
      // Rung 2 is "abstract instead of full page", and at s3 the transcript is
      // the expensive half: the brief is a few hundred tokens and the fetched
      // pages are thousands. The full text stays on the record in
      // mission_documents either way, so what the model loses is context, not
      // evidence.
      shrink: shrinkerFor({ id: brief, render, rungs: stage.shrinkLadder, reduceTranscript: trimToolResults }),
      language: mission.language,
      now,
      toolContext,
      spec: { forbiddenTools: [] },
      facet: dimension.facet,
      inputBudgetTokens: stage.inputBudgetTokens,
      shrinkLadder: stage.shrinkLadder,
      maxTokens: stage.maxOutputTokens,
      signal,
      budget,
      circuit,
      cache,
      spillDir,
      ledger: watchingLedger({
        base: createSqliteLedger(store, { missionId, stepId: stage.id }),
        onRow: (row) => { touched.push({ tool: String(row.tool ?? ""), argsHash: String(row.argsHash ?? ""), ok: row.ok === true }); },
        logger: log,
      }),
      finalizeTool: finalizeToolFor(COLLECT_SCHEMA, { description: "Record what this dimension found. Every quote is checked against the page it is attributed to before it is accepted." }),
      checkFinalize,
      onUsage: spendRecorder({ store, missionId, stage, now, logger: log }),
    });

    tokens = run.tokens?.total ?? 0;
    absorbTranscript(run.messages ?? []);
    if (run.state === "failed") {
      terminal = "failed";
      failureCode = run.failureCode ?? "model_error";
      note = run.diagnostic ?? (zh ? "研究员这一轮没有跑完。" : "the researcher run did not complete.");
      if (failureCode === "budget_exhausted" || failureCode === "context_exceeded" || failureCode === "user_cancelled") stopStage = failureCode;
    } else if (accepted === null) {
      // The run ended without the finalize gate ever accepting a candidate.
      // That is a degradation with a reason, never an empty success.
      terminal = "degraded";
      note = zh
        ? `研究员在 ${run.iterations ?? "?"} 轮后结束却没有提交可接受的产出（${run.exitReason ?? "未知"}）。`
        : `the researcher ended after ${run.iterations ?? "?"} turns without a candidate the gate accepted (${run.exitReason ?? "unknown"}).`;
    } else if (run.state === "degraded") {
      terminal = "degraded";
      note = run.diagnostic ?? null;
    }
  } catch (cause) {
    terminal = "failed";
    failureCode = cause?.code ?? "model_error";
    note = String(cause?.message ?? cause);
    log?.warn?.(`mission ${missionId}: dimension ${dimension.dimensionId} threw: ${note}`);
  }

  // Pages are stored on EVERY path, success and failure alike: a fetch that has
  // already been paid for in wall clock and a blocking parse is worth keeping
  // even when the turn it was made in ended badly.
  syncPages();
  const documents = new Map();
  for (const page of pages.values()) {
    try {
      const written = store.putDocument({
        url: page.url,
        title: page.title,
        // The column is `markdown` and the tool's extraction is what goes in
        // it. NOTE, and it is a real one: `fetch_page` returns Readability's
        // plain `text`, while `readArticle` also produces a `markdown`
        // rendering with blank lines between blocks. The contiguous-span rule
        // splits on blank lines, so a page whose text arrives as ONE span makes
        // the splice guard a substring check. `singleSpanPages` below counts
        // exactly that, so the weakening is a number somebody can read rather
        // than a silent loss; the fix belongs in mission-tools.js's fetch_page.
        markdown: page.markdown,
        status: 200,
        fetchedAt: now(),
      });
      documents.set(pageKey(page.url), written);
    } catch (cause) {
      log?.warn?.(`mission ${missionId}: putDocument(${page.url}) failed: ${cause.message}`);
    }
  }

  const singleSpanPages = [...pages.values()].filter((page) => page.markdown.split(/\n\s*\n/u).filter((span) => span.trim() !== "").length <= 1).length;

  // Findings, in one transaction with no await inside it.
  const written = { verified: 0, unchecked: 0, skipped: 0 };
  const stamp = now();
  store.withTx(() => {
    for (const finding of accepted?.verified ?? []) {
      const document = documents.get(pageKey(finding.url));
      if (document === undefined || document.admissible !== true) {
        // G3 / G5 — a document that is missing, non-2xx or under the character
        // floor cannot back a verified state. It is `unchecked-fetch-failed`,
        // which is a fact about the fetch, and never `unverifiable`, which
        // reads as hallucination.
        store.insertFinding({
          missionId,
          dimensionId: dimension.dimensionId,
          runCount,
          attempt,
          claim: finding.statement,
          evidence: finding.quote,
          sourceUrl: finding.url,
          sourceTitle: finding.title ?? null,
          verifyState: "unchecked-fetch-failed",
          verifyReason: `the stored page for ${finding.url} is not admissible as evidence (missing, non-2xx, or under the normalised character floor)`,
          createdAt: stamp,
        });
        written.unchecked += 1;
        continue;
      }
      store.insertFinding({
        missionId,
        dimensionId: dimension.dimensionId,
        runCount,
        // The recollect generation comes free: `startStage` incremented the
        // attempt, so a second round APPENDS rather than replacing, and the
        // union is what the improvement test counts.
        attempt,
        claim: finding.statement,
        evidence: finding.quote,
        // The FETCHED url, never the one the model typed. Otherwise a quote
        // from an arXiv abstract lands attributed to nature.com with every
        // count still correct.
        sourceUrl: finding.url,
        sourceTitle: finding.title ?? null,
        verifyState: "verified-source-text",
        documentId: documentIdFor(finding.url),
        spanIndex: finding.spanIndex,
        createdAt: stamp,
      });
      written.verified += 1;
    }

    // G6 — a refusal is not an emptiness. A fetch the host or the pool refused
    // is recorded as unchecked with the reason, so "4 fetches failed with 429"
    // and "4 quotes were invented" are never the same number in the same place.
    const recorded = new Set();
    for (const refusal of refusals) {
      if (refusal.url === null || recorded.has(refusal.url)) continue;
      const rateLimited = refusal.code === "rate_limited";
      if (!rateLimited && !refusal.code.startsWith("budget_exhausted") && refusal.tool !== "fetch_page") continue;
      recorded.add(refusal.url);
      store.insertFinding({
        missionId,
        dimensionId: dimension.dimensionId,
        runCount,
        attempt,
        claim: zh ? `未能读取来源：${refusal.url}` : `the source could not be read: ${refusal.url}`,
        evidence: refusal.error,
        sourceUrl: refusal.url,
        verifyState: rateLimited ? "unchecked-rate-limited" : "unchecked-fetch-failed",
        verifyReason: refusal.error,
        createdAt: stamp,
      });
      written.unchecked += 1;
    }
  });

  // A fetch the tool door reported as successful whose observation the stage
  // could not read back is a page the model was shown and this code cannot
  // verify a quote against. That is a degradation with a named cause, never an
  // empty dimension: "we read nothing" and "we read it and lost it" require
  // opposite responses and would otherwise be the same number.
  if (terminal !== "failed" && unreadableFetches > 0) {
    terminal = "degraded";
    note = [note, zh
      ? `${fetchesSucceeded} 次成功抓取里有 ${unreadableFetches} 次的结果无法从工具缓存取回，因此这些页面上的引语无法在本阶段核验。`
      : `${unreadableFetches} of ${fetchesSucceeded} successful fetches could not be read back out of the tool cache, so quotes from those pages could not be verified here.`,
    ].filter(Boolean).join(" ");
  }
  if (terminal !== "failed" && spanIndexMisses > 0) {
    note = [note, zh
      ? `另有 ${spanIndexMisses} 条引语通过了核验却无法定位到具体段落，因此没有写入——一条无法复核的“已验证”等于只是有人说过一次。`
      : `${spanIndexMisses} quotes verified but could not be located in a single span, so they were not written: a verified finding that cannot be re-checked means only that somebody said so once.`,
    ].filter(Boolean).join(" ");
  }

  const verifiedCount = store.countVerified(missionId, dimension.dimensionId, runCount);
  if (terminal === "collected" && verifiedCount === 0) {
    // Honest emptiness, stated as such. Not a failure: the researcher's escape
    // hatch is designed to produce exactly this rather than deadlock.
    note = zh
      ? `这个维度读了 ${pages.size} 个页面，没有产出任何通过核验的引语。`
      : `this dimension read ${pages.size} pages and produced no quote that verified.`;
  }

  // The grade is arithmetic on measured supply, computed here rather than asked
  // for: never make a model do the arithmetic that decides its own verdict.
  const floorSeed = policy.findingTarget;
  const hosts = store.uniqueHosts(missionId, { dimensionId: dimension.dimensionId, runCount });
  const score = Math.round(
    100 * Math.min(1, verifiedCount / Math.max(1, floorSeed)) * 0.7
    + 100 * Math.min(1, hosts.length / 2) * 0.3,
  );

  const settledAt = now();
  store.withTx(() => {
    store.setDimensionState(missionId, dimension.dimensionId, terminal, {
      failureCode,
      summary: note ?? undefined,
      at: settledAt,
    });
    store.gradeDimension(missionId, dimension.dimensionId, {
      score,
      axes: { verified: verifiedCount, uniqueHosts: hosts.length, pagesFetched: pages.size, seedTarget: floorSeed },
    }, settledAt);
  });

  return {
    tokens,
    stoppedTools: [...stoppedTools],
    stopStage,
    summary: {
      dimensionId: dimension.dimensionId,
      state: terminal,
      verified: verifiedCount,
      attempted: accepted?.findings?.length ?? 0,
      pagesFetched: pages.size,
      hostsTried: [...new Set([...pages.values()].map((page) => hostOf(page.url)))],
      refusals: refusals.map((refusal) => ({ tool: refusal.tool, code: refusal.code, url: refusal.url })),
      written,
      spanIndexMisses,
      singleSpanPages,
      fetchesSucceeded,
      unreadableFetches,
      failureCode,
      note,
    },
  };
}

/** The researcher's brief at one shrink rung. */
function renderCollectInput({ mission, dimension, policy, crossState, zh, level }) {
  const caps = crossState.caps ?? mission.budget;
  const lines = [
    zh ? `课题：${mission.topic}` : `TOPIC: ${mission.topic}`,
    zh ? `维度：${dimension.name}` : `DIMENSION: ${dimension.name}`,
  ];
  if (level === 0 && dimension.rationale) {
    lines.push(zh ? `这个维度为什么值得一整份预算：${dimension.rationale}` : `WHY THIS DIMENSION: ${dimension.rationale}`);
  }
  lines.push(zh
    ? `目标：${policy.findingTarget} 条可核验的发现。每条发现都要有一段从你抓取过的页面上逐字复制的引语，且必须来自同一个连续段落——拼接两段不算引语。`
    : `TARGET: ${policy.findingTarget} checkable findings. Every finding needs a quote copied verbatim from a page you fetched, from ONE continuous passage — joining two passages is a splice, not a quote.`);
  lines.push(zh
    ? "本地文献库只有线索：标题和出版方摘要，没有正文。任何引语都必须来自 fetch_page 返回的文本。"
    : "The local library is a lead index: titles and publisher abstracts, no body text. Every quote must come from text fetch_page returned.");
  if (level < 2) {
    lines.push(zh
      ? `本次任务的额度上限：arXiv ${caps.maxArxiv} 次、网页搜索 ${caps.maxWeb} 次、页面抓取 ${caps.maxFetch} 次，全部维度共用。`
      : `MISSION ALLOWANCES, shared across every dimension: ${caps.maxArxiv} arXiv requests, ${caps.maxWeb} web searches, ${caps.maxFetch} page fetches.`);
  }
  lines.push(zh
    ? "读完之后用 finalize 提交：findings（每条含 statement、url、quote）、summary，以及你看过却放弃的来源和原因。"
    : "When you have read enough, submit with finalize: findings (each with statement, url and quote), a summary, and the sources you looked at and rejected with the reason.");
  return lines.join("\n\n");
}

/** Characters of a tool result kept at the "abstract instead of full page" rung. */
const TRIMMED_RESULT_CHARS = 1_200;

/**
 * The transcript at a lower rung: fetched pages become abstracts.
 *
 * Applied from rung 2 only, and never to anything but a tool result. The full
 * text is already in `mission_documents` and every quote is verified against
 * THAT, so this costs the model context and costs the evidence nothing.
 *
 * @param message - one transcript message.
 * @param level - the rung being applied.
 * @returns the message, trimmed or untouched.
 */
function trimToolResults(message, level) {
  if (level < 2 || message?.role !== "tool") return message;
  return {
    ...message,
    content: (message.content ?? []).map((part) => (part?.type !== "tool-result" ? part : {
      ...part,
      content: (part.content ?? []).map((block) => (typeof block?.text !== "string" || block.text.length <= TRIMMED_RESULT_CHARS
        ? block
        : { ...block, text: `${block.text.slice(0, TRIMMED_RESULT_CHARS)}
[trimmed to fit the context budget; the full page is on the record and every quote is checked against it]` })),
    })),
  };
}

/**
 * Which of the four quote failures `verifyQuote`'s reason names.
 *
 * The four are a fixed vocabulary the seam has sentences for, and the mapping
 * is here rather than a re-wording: "could not be read" is not an accusation
 * and must never be delivered as one, and the histogram over these four is what
 * measures the prompt against hallucination.
 *
 * @param reason - `verifyQuote`'s own reason string.
 * @returns a `QUOTE_FAILURES` member.
 */
function quoteFailureOf(reason) {
  if (reason === "too short") return QUOTE_FAILURES.TOO_SHORT;
  if (reason === "no such source") return QUOTE_FAILURES.NO_SUCH_SOURCE;
  return QUOTE_FAILURES.NOT_FOUND_IN_SOURCE;
}

/** The host of a URL, for the hosts-tried list. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./u, "").toLowerCase();
  } catch {
    return "";
  }
}

/* ── s4-assess ─────────────────────────────────────────────────────────── */

/** The Leader's assessment schema. */
const ASSESS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["decision", "rationale", "perDimension"],
  properties: {
    decision: { type: "string", enum: ["accept", "recollect", "abort"] },
    rationale: { type: "string", minLength: 20, maxLength: 1500 },
    perDimension: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimensionId", "action", "critique"],
        properties: {
          dimensionId: { type: "string", minLength: 1, maxLength: 48 },
          action: { type: "string", enum: ["accept", "recollect", "drop"] },
          critique: { type: "string", minLength: 10, maxLength: 600 },
        },
      },
    },
  },
});

/**
 * Stage four: grade what came back, and decide — in code — whether one more
 * collection round is worth taking.
 *
 * The Leader's word is an input to that decision and never the decision itself.
 * Its `abort` is ADVISORY and is recorded: the mission ends on
 * `evidenceFloorGate`, which the runtime runs after this handler returns
 * because `s4` is the stage whose back edge is `s3-collect`.
 *
 * @param deps - `{store, chat, circuit, cache, spillDir, ctx, logger, prompts}`.
 * @returns the `s4-assess` handler.
 */
export function createS4Assess(deps) {
  const { store, chat, circuit = null, cache = null, spillDir = null, ctx = null, logger = null } = deps ?? {};
  if (typeof chat !== "function") throw new TypeError("createS4Assess needs the agent seam as deps.chat; no stage writes its own model loop.");
  if (typeof store?.listDimensions !== "function") throw new TypeError("createS4Assess needs the MissionStore as deps.store.");
  const prompts = promptsOf(deps);

  return async function s4Assess(context) {
    const { missionId, runCount, mission, stage, signal, crossState, budget, now, logger: runLogger } = context;
    const log = runLogger ?? logger;
    const zh = mission.language !== "en";

    const floor = mission.derivedFloor;
    if (!Number.isInteger(floor) || floor < 0) {
      throw fail("input_invalid", zh
        ? "missions.derived_floor 没有值。s4 的每一个判断都是拿它和实测供给比较；没有它，评估只能凭印象。s3 必须在结算前写入。"
        : "missions.derived_floor is not set. Every judgement in this stage compares measured supply against it, and without it the assessment is an impression. s3-collect must write it before it settles.");
    }

    // G1 — the arithmetic that decides the verdict is done HERE, not by the
    // model. This is the highest-leverage prompt lesson in the reference, and
    // it is enforced rather than documented: `assertPrecomputed` throws if a
    // row reaches the prompt without its flags.
    const rows = store.listDimensions(missionId, { runCount });
    const perDimension = rows.map((row) => ({
      dimensionId: row.dimensionId,
      name: row.name,
      facet: row.facet,
      state: row.state,
      verified: row.verified,
      verifiedAbstract: row.verifiedAbstract,
      unchecked: row.unchecked,
      uniqueHosts: row.uniqueHosts,
      total: row.total,
      meetsFloor: row.verified >= floor,
      shortfall: Math.max(0, floor - row.verified),
      failureCode: row.failureCode ?? null,
      summary: row.summary ?? null,
    }));
    assertPrecomputed(perDimension);

    const known = new Set(perDimension.map((row) => row.dimensionId));
    const brief = `u-${stage.id}`;
    const render = (level) => renderAssessInput({ mission, crossState, perDimension, floor, zh, level });

    const checkFinalize = (output) => {
      const issues = [];
      const named = new Set((output?.perDimension ?? []).map((entry) => String(entry?.dimensionId ?? "")));

      // G2 — coverage. A verdict that skips a dimension is a verdict about a
      // mission that does not exist.
      const missing = [...known].filter((id) => !named.has(id));
      if (missing.length > 0) {
        issues.push(zh
          ? `你的 perDimension 漏掉了：${missing.join("、")}。每一个维度都要有一条判断。`
          : `your perDimension list does not mention: ${missing.join(", ")}. Every dimension needs a judgement.`);
      }
      const unknown = [...named].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        issues.push(zh
          ? `perDimension 里出现了不存在的维度：${unknown.join("、")}。可用的维度只有：${[...known].join("、")}。`
          : `perDimension names dimensions that do not exist: ${unknown.join(", ")}. The dimensions are: ${[...known].join(", ")}.`);
      }

      // G3 — a recollect must say what to change.
      if (output?.decision === "recollect") {
        const asked = (output.perDimension ?? []).filter((entry) => entry?.action !== "accept");
        if (asked.length === 0) {
          issues.push(zh
            ? "你要求重新收集，却没有指出任何一个维度要改什么。至少指名一个维度，并说明你要它改变什么。"
            : "a recollect whose every action is accept is not a request. Name at least one dimension and what you want changed.");
        }
      }
      return issues;
    };

    const run = await chat({
      agent: stage.agent,
      stepId: stage.id,
      missionId,
      runCount,
      duty: "assess",
      system: prompts(stage.agent, "assess"),
      messages: [briefMessage(brief, render(0))],
      shrink: shrinkerFor({ id: brief, render, rungs: stage.shrinkLadder }),
      language: mission.language,
      now,
      spec: { forbiddenTools: [] },
      facet: "general",
      inputBudgetTokens: stage.inputBudgetTokens,
      shrinkLadder: stage.shrinkLadder,
      maxTokens: stage.maxOutputTokens,
      signal,
      budget,
      circuit,
      cache,
      spillDir,
      ledger: createSqliteLedger(store, { missionId, stepId: stage.id }),
      finalizeTool: finalizeToolFor(ASSESS_SCHEMA, { description: "Record the assessment: one judgement per dimension and one decision for the mission." }),
      checkFinalize,
      onUsage: spendRecorder({ store, missionId, stage, now, logger: log }),
    });

    if (run.state === "failed") throw Object.assign(new Error(run.diagnostic), { code: run.failureCode });

    const decision = ["accept", "recollect", "abort"].includes(run.output?.decision) ? run.output.decision : "accept";
    const judged = new Map((run.output?.perDimension ?? [])
      .filter((entry) => known.has(String(entry?.dimensionId ?? "")))
      .map((entry) => [String(entry.dimensionId), entry]));

    const assessment = {
      decision,
      rationale: String(run.output?.rationale ?? ""),
      derivedFloor: floor,
      perDimension: perDimension.map((row) => ({
        dimensionId: row.dimensionId,
        action: judged.get(row.dimensionId)?.action ?? "accept",
        critique: judged.get(row.dimensionId)?.critique ?? null,
        verified: row.verified,
        meetsFloor: row.meetsFloor,
        shortfall: row.shortfall,
        uniqueHosts: row.uniqueHosts,
      })),
    };

    const at = now();
    store.withTx(() => {
      for (const row of perDimension) {
        store.gradeDimension(missionId, row.dimensionId, {
          score: gradeOf(row, floor),
          axes: { verified: row.verified, floor, uniqueHosts: row.uniqueHosts, unchecked: row.unchecked },
        }, at);
        // Only a dimension that COMPLETED and came in under the floor is moved,
        // and only to `degraded`. A failed dimension keeps its failure: the
        // assessment grades work, it does not relabel a cause.
        if (row.state === "collected" && !row.meetsFloor) {
          store.setDimensionState(missionId, row.dimensionId, "degraded", {
            summary: zh
              ? `已验证 ${row.verified} 条，低于本次任务推出的下限 ${floor}（差 ${row.shortfall} 条）。`
              : `${row.verified} verified findings against this mission's derived floor of ${floor} (short by ${row.shortfall}).`,
            at,
          });
        }
      }
    });

    const decisions = [...(crossState.leaderDecisions ?? []), {
      phase: "assess",
      at,
      label: `assess:${decision}`,
      detail: assessment.rationale.slice(0, 600),
    }];

    // G5 — the Leader's abort is advisory, recorded, and the mission continues.
    // The evidence floor ends missions; a model's say-so does not, and the gate
    // that does is the runtime's, run after this handler returns.
    if (decision === "abort") {
      decisions.push({
        phase: "assess",
        at,
        label: "abort-advisory",
        detail: zh
          ? "你要求中止。这条建议已记录在案；是否中止由证据下限闸门按已验证发现的数量决定，不由这一条决定。"
          : "you asked to abort. The request is on the record; whether the mission ends is decided by the evidence floor gate on counted verified findings, not by this request.",
      });
    }

    // G4 — the back edge is CODE. `weakestDimensions` is the same query the
    // recollect round will narrow to, so "we asked for a round" and "there is
    // something for that round to do" cannot disagree.
    const weakest = decision === "recollect"
      ? store.weakestDimensions(missionId, { limit: 2, runCount, below: floor })
      : [];
    const next = decision === "recollect" && weakest.length > 0 ? "s3-collect" : null;

    const shrunk = shrinkRungOf(run);
    const degraded = run.state === "degraded" || overBudgetOf(run)
      || perDimension.some((row) => !row.meetsFloor);
    const notes = [];
    if (run.state === "degraded") notes.push(run.diagnostic);
    const short = perDimension.filter((row) => !row.meetsFloor);
    if (short.length > 0) {
      notes.push(zh
        ? `${short.length}/${perDimension.length} 个维度低于推出下限 ${floor}：${short.map((row) => `${row.dimensionId}（${row.verified}）`).join("、")}。`
        : `${short.length} of ${perDimension.length} dimensions are under the derived floor of ${floor}: ${short.map((row) => `${row.dimensionId} (${row.verified})`).join(", ")}.`);
    }
    if (decision === "recollect" && next === null) {
      notes.push(zh
        ? "领队要求重收，但已经没有低于下限的维度可重收，任务带着现有证据继续。"
        : "a recollect was requested but no dimension is under the floor to re-collect, so the mission continues with what it has.");
    }

    return {
      output: { ...assessment, weakest, shrinkRung: shrunk === 0 ? null : stage.shrinkLadder[shrunk - 1] },
      degraded,
      degradeNote: degraded ? (notes.join(" ") || (zh ? "评估阶段有降级。" : "the assessment settled degraded.")) : undefined,
      tokens: run.tokens?.total ?? 0,
      next,
      crossPatch: {
        assessment,
        leaderDecisions: decisions,
        contextPlan: withShrink(crossState.contextPlan, stage.id, shrunk),
      },
    };
  };
}

/**
 * Refuse to build an assessment input whose flags were not computed.
 *
 * A model asked to work out whether `4 >= 5` before deciding what to do about it
 * will sometimes get it wrong, and the wrongness is invisible because the
 * verdict reads fine. The flags are computed in code, and their absence is a
 * build-time throw rather than a quieter prompt.
 *
 * @param rows - the per-dimension input rows.
 * @returns nothing; throws with code `input_invalid`.
 */
function assertPrecomputed(rows) {
  for (const row of rows) {
    for (const field of ["meetsFloor", "shortfall", "uniqueHosts"]) {
      if (row[field] === undefined || row[field] === null) {
        throw fail("input_invalid", `s4-assess built an input for ${row.dimensionId} without "${field}". The floor comparison, the shortfall and the host count are computed in code and handed to the Leader already decided; a model must never do the arithmetic that decides its own verdict.`);
      }
    }
  }
}

/** A dimension's grade, from measured supply. Never a number the model supplied. */
function gradeOf(row, floor) {
  const evidence = Math.min(1, row.verified / Math.max(1, floor));
  const independence = Math.min(1, row.uniqueHosts / 2);
  return Math.round(100 * (evidence * 0.7 + independence * 0.3));
}

/** The assessment prompt at one shrink rung. Rung 1 drops the per-dimension prose. */
function renderAssessInput({ mission, crossState, perDimension, floor, zh, level }) {
  const goals = crossState.goals ?? mission.goals ?? null;
  const lines = [
    zh ? `课题：${mission.topic}` : `TOPIC: ${mission.topic}`,
    zh
      ? `本次任务推出的每维度下限：${floor} 条已验证发现。这个数字来自实测供给（各维度已验证数的中位数），不是一个预设常量。`
      : `DERIVED FLOOR: ${floor} verified findings per dimension. It comes from measured supply — the median verified count across the dimensions — and not from a constant.`,
  ];
  if (goals !== null) {
    lines.push(zh
      ? `你在计划阶段自己写下的标准：${JSON.stringify(goals).slice(0, 1200)}`
      : `THE CRITERIA YOU SET AT PLAN TIME: ${JSON.stringify(goals).slice(0, 1200)}`);
  }

  const table = perDimension.map((row) => {
    const head = `${row.dimensionId} | verified ${row.verified} | floor ${floor} | ${row.meetsFloor ? "MEETS FLOOR" : `SHORT BY ${row.shortfall}`} | hosts ${row.uniqueHosts} | unchecked ${row.unchecked} | state ${row.state}${row.failureCode ? ` (${row.failureCode})` : ""}`;
    if (level > 0) return head;
    return row.summary ? `${head}\n    ${row.summary}` : head;
  }).join("\n");
  lines.push(`${zh ? "各维度（判断所需的算术已经替你算好）：" : "PER DIMENSION (the arithmetic that decides the verdict is already done for you):"}\n${table}`);

  lines.push(zh
    ? "用 finalize 提交：每个维度一条 action 与 critique，以及一个整体 decision。要求重收时必须指名要改什么——最多只会重收最薄弱的两个维度，而且只有一轮。"
    : "Submit with finalize: one action and critique per dimension, and one decision for the mission. A recollect must name what you want changed — at most the weakest two dimensions are re-collected, and there is at most one round.");
  return lines.join("\n\n");
}

/* ── shared plumbing ───────────────────────────────────────────────────── */

/**
 * The context plan with one stage's shrink rung recorded.
 *
 * `contextPlan` is written into crossState by the runtime at the gate stage and
 * is a plain top-level key thereafter, so a later stage patches the WHOLE object
 * — crossPatch is a shallow merge and a sub-key cannot be patched.
 *
 * @param plan - the current `crossState.contextPlan`, possibly absent.
 * @param stepId - the stage recording a rung.
 * @param rungIndex - 0 when nothing was shrunk.
 * @returns the new plan object.
 */
function withShrink(plan, stepId, rungIndex) {
  const base = plan ?? { contextWindow: null, defaultMaxTokens: null, shrinkBy: {} };
  return { ...base, shrinkBy: { ...(base.shrinkBy ?? {}), [stepId]: rungIndex } };
}

/** An integer inside a band, with a stated fallback rather than a silent 0. */
function clampInteger(value, low, high, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(high, Math.max(low, Math.round(parsed)));
}
