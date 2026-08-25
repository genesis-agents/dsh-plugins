/**
 * The quality half of the pipeline: `s9-verify`, `s10-critique`, `s11-signoff`
 * and `s12-persist`.
 *
 * These four stages are where a mission stops producing and starts being
 * accountable for what it produced, so every judgement below that can be made
 * by arithmetic IS made by arithmetic. The phase −1 spike measured why: the
 * same topic produced six fetched pages and six findings on one run, and two
 * searches then `finish` on the next. A prompt does not hold a loop, and it
 * certainly does not hold a refusal. Every gate here is code, every refusal is
 * handed back to the model as a critique it can act on, every refusal is
 * bounded, and after the bound the code decides and says so.
 *
 * Four rules the whole file is built on:
 *
 *   - `s9` re-checks every quote in the DRAFTED artefact against its source. A
 *     quote that verified at record time and does not verify in the artefact
 *     means the writer edited it on the way through — that is the failure this
 *     stage exists for, and it is reported as a citation defect rather than by
 *     demoting a finding that is still perfectly good.
 *   - `s11` returns an INTENT and never finalizes. If `s11` wrote the terminal
 *     status, `s12`'s conditional write would lose its own race, `won` would be
 *     false, and the postlude, the terminal event and the checkpoint policy
 *     would never run: a refused mission would get no postmortem.
 *   - `s12` runs `contentGuard` BEFORE `putArtifact`, writes exactly one
 *     artefact version per run, and NEVER takes the success path by default. A
 *     silent return at persist is exactly how the reference produced a fake
 *     completion.
 *   - No handler here calls `finalize`, `startStage`, `finishStage`,
 *     `saveCheckpoint`, `claimForRun`, `touchMission`, `appendEvent` or
 *     `registry.*`. The runtime owns every one of them, and a second caller is
 *     the failure this phase exists to prevent.
 */

import { COUNTING_VERIFY_STATE, MIN_DOCUMENT_CHARS, documentIdFor } from "./mission-store.js";
import { createSqliteLedger } from "./mission-tools.js";
import { finalizeToolFor, readUsage } from "./mission-agent.js";
// `s1` is the one stage that resolves policy and `s7`/`s8` own the one
// assembler, so both live where they are resolved and this file READS them.
// Importing rather than re-deriving is the whole point: a second `assemble`
// would renumber the citations and produce two different `[7]`s, and a second
// tier table would grade the report against a floor it was not written against.
import { TIER_POLICY, loadRolePrompt, spanIndexOf } from "./mission-stages-front.js";
import { assemble } from "./mission-stages-middle.js";
import { verifyQuote } from "./insights.js";
// The ONE block builder (§3.6). `quotableSpans` strips a header only when the
// first paragraph carries a `## ` line and skips a span only on three literal
// markers `podcast.js` writes, so against a FETCHED page both guards fire on
// nothing while `verifyQuote` still answers `ok: true` — the header quote and
// the spliced transcript come straight back with `verified` on them. `blockFor`
// tags what it produces and `s9` asserts the tag before it verifies anything.
// It lives in `mission-blocks.js` rather than in `insights.js` because
// `insights.js`'s `verifyQuote` is shared with the standing-insight pass and
// tightening it there would break that pass.
import { blockFor } from "./mission-blocks.js";

/* ── the vocabularies this file owns ───────────────────────────────────── */

/**
 * The three sign-off bands, ascending.
 *
 * One table, because `verdict` and `score` have to agree and the agreement is
 * checked twice — once as a critique the Leader can fix, and once as a coercion
 * the code performs when it did not. Two copies of these numbers would be two
 * answers to "did this mission pass".
 */
export const VERDICT_BANDS = Object.freeze([
  Object.freeze({ name: "refuse", min: 0, max: 59 }),
  Object.freeze({ name: "qualified", min: 60, max: 79 }),
  Object.freeze({ name: "sign", min: 80, max: 100 }),
]);

/** The verdict names, for the schema, the critique and the coercion message. */
export const VERDICT_NAMES = Object.freeze(VERDICT_BANDS.map((band) => band.name));

/**
 * A citation's status after `s9`.
 *
 * Deliberately NOT `VERIFY_STATES`: those describe the FINDING, and a citation
 * can disagree with the finding behind it. A good finding whose quote the
 * writer edited on the way into a chapter is exactly that disagreement, and
 * collapsing the two vocabularies is how it stops being visible.
 */
export const CITATION_STATUSES = Object.freeze(["verified", "unverified", "unchecked", "contradicted"]);

/**
 * What the Verifier may say about a citation whose quote already verified
 * mechanically.
 *
 * It cannot promote anything — `verifyQuote` promotes, and nothing else — so
 * this vocabulary carries no `verified` member. The model answers the one
 * question code cannot: whether a real, verbatim quote actually supports the
 * claim hung on it.
 */
export const VERIFIER_JUDGEMENTS = Object.freeze(["supports", "contradicts", "unclear"]);

/**
 * The markers a half-written chapter leaves behind (§2's content guard).
 *
 * `{{` catches an unfilled template slot; `TK` is the newsroom placeholder and
 * is matched as a standalone token below so that "TKinter" does not fire it.
 */
export const PLACEHOLDER_MARKERS = Object.freeze(["[TODO]", "[insert citation]", "{{", "TK"]);

/**
 * The fraction of the tier's word floor below which a report is not short, it
 * is broken.
 */
export const CONTENT_GUARD_WORD_FRACTION = 0.5;

/** The share of chapters that may be under-delivered before the report is a hole. */
export const CONTENT_GUARD_UNDER_DELIVERED_SHARE = 1 / 3;

/**
 * How many citations `s9` checks per model call, and how much of the document
 * it shows for each.
 *
 * The LABELS come from `stage.shrinkLadder` — the frozen stage declaration owns
 * the words — and only the numbers live here. `s9` takes the whole assembled
 * report and is the stage a `deep` mission dies at after three hours, so
 * `context_exceeded` here is a ROUTINE outcome (§8.5) whose action is "re-run
 * this stage at a smaller batch size", not an anomaly.
 */
const VERIFY_RUNGS = Object.freeze([
  Object.freeze({ batch: 8, excerpt: 1_200 }),
  Object.freeze({ batch: 4, excerpt: 400 }),
  Object.freeze({ batch: 1, excerpt: 400 }),
]);

/** Excerpt widths the SEAM may shrink to within one call, without dropping a citation. */
const EXCERPT_RUNGS = Object.freeze([1_200, 400, 150]);

/** Duty names in one place, so a rename is one edit rather than seven literals. */
const DUTIES = Object.freeze({
  verify: "verify",
  critic: "critic",
  redTeam: "red-team",
  foreword: "foreword",
  signoff: "signoff",
});

/**
 * The longest run of chapter prose `s10`'s input may share with a chapter body
 * before the stage is defeated.
 */
const CRITIQUE_LEAK_WINDOW = 200;

/** How many assess decisions the sign-off prompt keeps. Plan and foreword: all of them. */
const KEEP_ASSESS_DECISIONS = 15;

/* ── the output schemas the provider enforces before we see anything ───── */

/** `s9`'s verifier: one judgement per citation in the batch. */
const VERIFY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "judgement"],
        properties: {
          index: { type: "integer", minimum: 1 },
          judgement: { type: "string", enum: [...VERIFIER_JUDGEMENTS] },
          reason: { type: "string", maxLength: 600 },
        },
      },
    },
  },
});

/** `s10`'s critic. */
const CRITIC_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["blindspots", "biases"],
  properties: {
    blindspots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement"],
        properties: { statement: { type: "string", minLength: 1, maxLength: 800 }, whyItMatters: { type: "string", maxLength: 800 } },
      },
    },
    biases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement"],
        properties: { statement: { type: "string", minLength: 1, maxLength: 800 }, evidence: { type: "string", maxLength: 800 } },
      },
    },
  },
});

/** `s10`'s red team, over `s6`'s forecasts. */
const RED_TEAM_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["forecastVulnerabilities"],
  properties: {
    forecastVulnerabilities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["forecastId", "vulnerability"],
        properties: {
          forecastId: { type: "string", minLength: 1, maxLength: 120 },
          vulnerability: { type: "string", minLength: 1, maxLength: 800 },
          whatWouldFalsifyItSooner: { type: "string", maxLength: 800 },
        },
      },
    },
  },
});

/** `s11`'s foreword. */
const FOREWORD_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["whatWeAnswered", "whatRemainsUnclear", "howToRead"],
  properties: {
    whatWeAnswered: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "addressed"],
        properties: {
          criterion: { type: "string", minLength: 1, maxLength: 600 },
          addressed: { type: "string", enum: ["yes", "partial", "no"] },
          evidence: { type: "string", maxLength: 800 },
        },
      },
    },
    whatRemainsUnclear: { type: "array", items: { type: "string", minLength: 1, maxLength: 600 } },
    howToRead: { type: "string", minLength: 1, maxLength: 2000 },
    recommendedFollowUp: { type: "array", items: { type: "string", minLength: 1, maxLength: 600 } },
  },
});

/** `s11`'s signature. */
const SIGNOFF_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["signed", "score", "verdict", "accountabilityNote"],
  properties: {
    signed: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 100 },
    verdict: { type: "string", enum: [...VERDICT_NAMES] },
    accountabilityNote: { type: "string", minLength: 50, maxLength: 1500 },
    refusalReason: { type: "string", maxLength: 1000 },
  },
});

/* ── small shared helpers ──────────────────────────────────────────────── */

/**
 * An error carrying a `FAILURE_CODES` member.
 *
 * `classifyFailure` reads `error.code`; a bare throw becomes `model_error` and
 * tells the user to check a provider that was never involved.
 * @param code - a member of FAILURE_CODES.
 * @param message - what happened and what to do about it.
 * @returns the Error, ready to throw.
 */
function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Whether this mission speaks Chinese. Every user-facing string is paired off it. */
function zhOf(mission) {
  return mission?.language !== "en";
}

/** Words, counted the one way, so two call sites cannot disagree about length. */
function wordsOf(text) {
  return String(text ?? "").split(/\s+/u).filter(Boolean).length;
}

/** Collapse whitespace, for comparisons that must survive re-wrapping. */
function flatten(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/** A finite number, or null. Never NaN, which reads downstream as "no failures". */
function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A plain array, whatever arrived. */
function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/** The band a score falls in. */
function bandOfScore(score) {
  const n = Math.max(0, Math.min(100, Number(score) || 0));
  for (const band of VERDICT_BANDS) if (n >= band.min && n <= band.max) return band;
  return VERDICT_BANDS[0];
}

/** The band a verdict names, or null when the model named something else. */
function bandOfVerdict(verdict) {
  const name = String(verdict ?? "").trim().toLowerCase();
  return VERDICT_BANDS.find((band) => band.name === name) ?? null;
}

/** The band one step down. `refuse` has no lower step and stays where it is. */
function bandBelow(band) {
  const at = VERDICT_BANDS.indexOf(band);
  return at <= 0 ? VERDICT_BANDS[0] : VERDICT_BANDS[at - 1];
}

/** A chapter's key wherever chapters and sections have to be joined. */
function chapterKey(dimensionId, chapterIndex) {
  return `${dimensionId}:${chapterIndex}`;
}

/** One user message, in the shape the seam and `shrinkerFor` both expect. */
function briefMessage(id, text) {
  return { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

/**
 * The stage's half of the shrink ladder.
 *
 * The SEAM owns WHEN to shrink — it estimates the whole prompt against
 * `stage.inputBudgetTokens` before every turn and walks `stage.shrinkLadder`
 * rung by rung, naming each one. The STAGE owns WHAT to drop, because only the
 * stage knows which half of its own brief is the expensive half. Returning
 * `null` says the ladder is spent.
 * @param options - `{id, render, rungs}`.
 * @returns the shrink callback, or undefined when the stage declares no ladder.
 */
function shrinkerFor({ id, render, rungs }) {
  if (!Array.isArray(rungs) || rungs.length === 0) return undefined;
  return ({ rung, messages }) => {
    const level = rung + 1;
    if (level > rungs.length) return null;
    return { messages: [briefMessage(id, render(level)), ...messages.slice(1)] };
  };
}

/**
 * This tier's quality floors.
 *
 * `crossState.tierPolicy` is `s1`'s resolution and is what every later stage
 * reads. The fallback is not a second resolver: it is the SAME frozen table
 * `s1` resolved from, reached by name, so a stage rerun that starts after `s1`
 * grades the report against exactly the floors it was written against rather
 * than against a guess or a throw.
 * @param crossState - the accumulated bag.
 * @param tier - the depth tier.
 * @param zh - whether to speak Chinese.
 * @returns `{policy, hydrated}` — `hydrated` says the crossState copy was absent.
 */
function tierPolicyOf(crossState, tier, zh) {
  const carried = crossState?.tierPolicy;
  if (carried !== null && carried !== undefined && typeof carried === "object" && Number(carried.wordFloor) > 0) {
    return { policy: carried, hydrated: false };
  }
  const table = TIER_POLICY[String(tier ?? "")];
  if (table === undefined) {
    throw fail("input_invalid", zh
      ? `crossState.tierPolicy 缺失，且 "${tier}" 不是已知的档位，无法取回本档的质量下限。字数下限与已验证比例下限是内容守卫和强制不签署阶梯共同读取的那两个数字。`
      : `crossState.tierPolicy is missing and "${tier}" is not a known depth tier, so this tier's quality floors cannot be recovered. The word floor and the verified-ratio floor are the two figures the content guard and the forced-unsign ladder both read.`);
  }
  return { policy: table, hydrated: true };
}

/**
 * The `onUsage` hook a stage hands the agent seam.
 *
 * Written per usage chunk rather than once from the run's totals, because a run
 * that throws after its second turn still spent what its first two turns cost,
 * and a ledger that only records complete runs understates every mission that
 * failed — exactly the population somebody is trying to learn from.
 * @param options - `{store, missionId, stage, now, logger}`.
 * @returns a function taking one usage chunk.
 */
function spendRecorder({ store, missionId, stage, now, logger }) {
  return (usage) => {
    // `readUsage` REPORTS a usage shape it did not recognise instead of
    // absorbing it into a silent zero: a mission that cost real money rendering
    // as free is what makes the estimator permanently untunable.
    const counts = readUsage(usage);
    if (counts === null) {
      logger?.warn?.(`mission ${missionId}: ${stage.id} received no usage object, so no spend row was written for that call`);
      return;
    }
    if (counts.source !== "fields") logger?.warn?.(`mission ${missionId}: ${stage.id} usage — ${counts.source}`);
    store.withTx(() => {
      store.insertSpend({
        missionId,
        stepId: stage.id,
        role: stage.agent ?? "code",
        agentId: stage.agent,
        promptTok: counts.prompt,
        completionTok: counts.completion,
        cacheReadTok: counts.cacheRead,
        estimatedTok: 0,
        calls: 1,
        at: now(),
      });
    });
  };
}

/**
 * Every dependency these four stages are closures over.
 *
 * Checked at FACTORY time rather than at call time: a wiring mistake that only
 * surfaces at stage nine of a three-hour `deep` mission has already cost the
 * whole budget, and "the chat seam was never passed" is not a diagnosis anybody
 * should have to make at that point.
 * @param deps - the bag from `createMissionHandlers`.
 * @param who - the factory name, for the message.
 * @returns the same bag with defaults filled in.
 */
function requireDeps(deps, who) {
  const store = deps?.store;
  for (const method of ["listChapters", "verifiedFindings", "getDocument", "setFindingVerifyState",
    "listDimensions", "listStages", "recordSignoff", "putArtifact", "latestConfig", "insertSpend", "withTx"]) {
    if (typeof store?.[method] !== "function") {
      throw new Error(`${who}: dependency "store" is not a MissionStore — it has no ${method}(). Every SQL statement in this feature lives in mission-store.js; read it before inventing a name.`);
    }
  }
  if (typeof deps?.chat !== "function") {
    throw new Error(`${who}: missing dependency "chat" — createMissionChat's runAgent. It is the ONE agent loop, and no stage writes its own.`);
  }
  return {
    ...deps,
    config: deps.config ?? {},
    logger: deps.logger ?? null,
    circuit: deps.circuit ?? null,
    cache: deps.cache ?? null,
    spillDir: deps.spillDir ?? null,
    sourceStore: deps.sourceStore ?? null,
    ctx: deps.ctx ?? null,
    // The injected loader exists for tests; production reads
    // `lib/mission/agents/<role>/SKILL.md` through the one reader.
    prompts: typeof deps.prompts === "function" ? deps.prompts : loadRolePrompt,
  };
}

/**
 * The `ctx` the tool door hands to `tool.execute`.
 *
 * `blocks` is what `quote_verify` checks against, so it is rebuilt per call
 * rather than captured once: a stale block map is a verifier checking this
 * batch's quotes against the previous batch's pages.
 */
function toolContextFor(deps, context, blocks) {
  const { ctx, config, sourceStore, spillDir } = deps;
  return {
    store: sourceStore,
    // Resolved NOW, never captured at apply time. A search plugin that is
    // ABSENT is a different fact from one that FAILED, and the difference
    // belongs in the mission's provenance rather than in a quietly narrower
    // catalogue.
    web: typeof ctx?.get === "function" ? ctx.get("web") : undefined,
    denyHosts: arrayOf(config.missionDenyHosts),
    spillDir,
    blocks: blocks ?? new Map(),
    signal: context.signal,
  };
}

/**
 * Run one agent to completion through the ONE chat seam.
 *
 * Copied into every agent stage in this file and nowhere varied: the stage
 * never inspects chunks, never accumulates deltas and never builds a tool-result
 * message. If a stage file contains the string "tool-call-delta", it is wrong.
 *
 * No `tools` array is built here either. `recallTools` runs INSIDE the seam, per
 * call, and the prompt's tool section is generated from its answer; a catalogue
 * built in the stage as well would be a second builder, and the ACL and the
 * prompt could then disagree.
 * @param deps - the wired dependency bag.
 * @param context - the runtime's handler context.
 * @param options - `{role, duty, brief, render, facet, blocks, schema, description, checkFinalize}`.
 * @returns the agent seam's run result.
 */
async function runDuty(deps, context, { role, duty, brief, render, facet = null, blocks = null, schema, description, checkFinalize }) {
  const { store, chat, prompts, circuit, cache, spillDir, logger } = deps;
  const { missionId, runCount, mission, stage, signal, budget, now } = context;

  const run = await chat({
    agent: role,
    stepId: stage.id,
    missionId,
    runCount,
    duty,
    system: prompts(role, duty),
    messages: [briefMessage(brief, render(0))],
    shrink: shrinkerFor({ id: brief, render, rungs: stage.shrinkLadder }),
    toolContext: toolContextFor(deps, context, blocks),
    spec: { forbiddenTools: [] },
    facet,
    language: mission.language,
    now,
    inputBudgetTokens: stage.inputBudgetTokens,
    shrinkLadder: stage.shrinkLadder,
    maxTokens: stage.maxOutputTokens,
    signal,
    budget,
    circuit,
    cache,
    spillDir,
    ledger: createSqliteLedger(store, { missionId, stepId: stage.id }),
    finalizeTool: finalizeToolFor(schema, { description }),
    checkFinalize,
    onUsage: spendRecorder({ store, missionId, stage, now, logger }),
  });

  // Never silent. The seam reports whether its spend row was written, and a
  // stage that assumed its cost was recorded is a mission that renders as free.
  if (run.spend?.recorded === false && Number(run.tokens?.total ?? 0) > 0) {
    logger?.warn?.(`mission ${missionId} ${stage.id}: ${run.tokens.total} tokens were spent with no ledger row — ${run.spend.why ?? "no reason given"}.`);
  }
  return run;
}

/**
 * Turn a failed run into the throw the runtime expects.
 *
 * `run.failureCode` was chosen at the point of decision — `context_exceeded`
 * from a provider's own `CONTEXT_WINDOW_EXCEEDED`, `user_cancelled` from an
 * abort — so it is carried straight through rather than re-derived from a
 * message.
 */
function throwFromRun(run, stepId) {
  throw fail(run.failureCode ?? "model_error", `${stepId}: ${run.diagnostic ?? "the agent run failed with no diagnostic."}`);
}

/* ══════════════════════════════════════════════════════════════════════════
   s9 · verify
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Check that every section offset resolves against the markdown it indexes.
 *
 * `assemble` asserts this at assembly and throws; this is the SECOND read, and
 * it exists because offset drift is silent and catastrophic and the only way it
 * reaches here is a markdown that was mutated after assembly. `contentGuard`
 * runs the same check a third time before the artefact is written, on purpose.
 * @param markdown - the assembled report.
 * @param sections - assemble()'s section table.
 * @returns `{ok, broken}` — `broken` names each section that does not resolve.
 */
export function checkSectionOffsets(markdown, sections) {
  const text = String(markdown ?? "");
  const broken = [];
  for (const section of arrayOf(sections)) {
    const start = Number(section?.start);
    const end = Number(section?.end);
    const heading = String(section?.heading ?? "");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || end <= start) {
      broken.push({ heading, start: section?.start ?? null, end: section?.end ?? null, reason: "out of range" });
      continue;
    }
    // `assemble` writes `## ${heading}`, so that is the string this compares
    // against — matching its own assertion rather than a second idea of it.
    if (heading !== "" && !text.slice(start, end).startsWith(`## ${heading}`)) {
      broken.push({ heading, start, end, reason: "does not begin with its own heading" });
    }
  }
  return { ok: broken.length === 0, broken };
}

/** An empty per-section-type tally. Counts, never a ratio — 0/0 is not "no failures". */
function emptyTally() {
  return { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 };
}

/**
 * The mechanical scorecard, split by section type and never averaged.
 *
 * `total` is a COUNT, not a denominator: `verified / total` at 0/0 is `NaN` or,
 * worse, reads as "no failures" — a mission with no citations at all presenting
 * as fully verified to the one decision the pipeline converges on. Every ratio
 * downstream is computed only where the count it divides by is positive.
 *
 * "Chapter seven has zero citations" has to stay visible rather than being
 * averaged into a healthy ratio, which is why the split is by section type and
 * why `unplaced` is its own bucket: a citation `assemble` could not attribute
 * to a chapter is an assembly defect, and folding it into `interpretive` would
 * make an assembly bug read as an interpretive chapter doing badly.
 * @param verdicts - one entry per citation, each carrying `status` and `sectionType`.
 * @returns `{evidenced, interpretive, unplaced, total}`.
 */
export function buildScorecard(verdicts) {
  const card = { evidenced: emptyTally(), interpretive: emptyTally(), unplaced: emptyTally(), total: 0 };
  for (const verdict of arrayOf(verdicts)) {
    const bucket = verdict.sectionType === "evidenced" ? card.evidenced
      : verdict.sectionType === "interpretive" ? card.interpretive
        : card.unplaced;
    bucket.total += 1;
    card.total += 1;
    // A status outside CITATION_STATUSES counts as unverified rather than being
    // dropped: an uncounted citation would shrink the denominator the sign-off
    // ladder divides by, which flatters exactly the report that produced it.
    if (verdict.status === "verified") bucket.verified += 1;
    else if (verdict.status === "contradicted") bucket.contradicted += 1;
    else if (verdict.status === "unchecked") bucket.unchecked += 1;
    else bucket.unverified += 1;
  }
  return card;
}

/**
 * The verified share the forced-unsign ladder reads, and WHICH count it is over.
 *
 * `evidenced` is the population the floor is about; when a report has no
 * evidenced sections at all the whole scorecard is used instead, and the name
 * travels with the number because an unnamed ratio is one somebody will read as
 * the other one.
 * @param scorecard - `buildScorecard`'s answer.
 * @returns `{ratio, over, verified, total}` — `ratio` is null when total is 0.
 */
export function verifiedRatioOf(scorecard) {
  const evidenced = scorecard?.evidenced ?? emptyTally();
  if (evidenced.total > 0) {
    return { ratio: evidenced.verified / evidenced.total, over: "evidenced", verified: evidenced.verified, total: evidenced.total };
  }
  const total = Number(scorecard?.total ?? 0);
  if (total <= 0) return { ratio: null, over: "none", verified: 0, total: 0 };
  const verified = (scorecard.evidenced?.verified ?? 0) + (scorecard.interpretive?.verified ?? 0) + (scorecard.unplaced?.verified ?? 0);
  return { ratio: verified / total, over: "all-sections", verified, total };
}

/**
 * `verifyQuote`'s refusal reason, mapped onto a finding's verify state.
 *
 * `misattributed` is NOT reachable from here, on purpose. We check the quote
 * against the source it is attributed to and nothing else, so "it is somewhere
 * else" is a claim we did not test; asserting it would be an accusation the
 * evidence does not support, and telling a model it invented a quote it did not
 * invent teaches it to distrust its own correct behaviour.
 */
function verifyStateForReason(reason) {
  return reason === "too short" ? "too-short" : "unverifiable";
}

/**
 * A window of the document around a quote, for the Verifier to read.
 *
 * A DISPLAY window, located by a flattened `indexOf`. It is never the check —
 * `verifyQuote` is — and this comment is here because a second, looser locator
 * sitting beside a strict one is how the strict one stops being the one that
 * decides.
 */
function excerptAround(text, quote, width) {
  const flatText = flatten(text);
  const needle = flatten(quote);
  const at = needle === "" ? -1 : flatText.indexOf(needle);
  if (at === -1) return flatText.slice(0, width);
  const from = Math.max(0, at - Math.floor(width / 2));
  return flatText.slice(from, from + width + needle.length);
}

/**
 * Stage nine: re-check every citation in the drafted report against its source.
 *
 * @param deps - `{store, sourceStore, chat, circuit, cache, spillDir, config, ctx, logger}`.
 * @returns the `s9-verify` handler.
 */
export function createS9Verify(deps) {
  const wired = requireDeps(deps, "createS9Verify");
  const { store, logger } = wired;

  return async function s9Verify(context) {
    const { missionId, runCount, mission, tier, stage, signal, crossState, now, emit } = context;
    const zh = zhOf(mission);
    const { policy, hydrated } = tierPolicyOf(crossState, tier, zh);

    const chapterRows = store.listChapters(missionId, runCount);
    // `assemble` is deterministic and lives with `s8`. `s9` and `s12` both call
    // it rather than keeping a second copy of the markdown in `crossState`: a
    // 25,000-word document there is that document written into the checkpoint
    // twelve times, and two independent numberings of one report are two
    // different `[7]`s.
    const report = assemble(chapterRows);
    const markdown = report.markdown;
    const citations = report.citations;

    const offsets = checkSectionOffsets(markdown, report.sections);
    if (!offsets.ok) {
      logger?.warn?.(`mission ${missionId} s9-verify: ${offsets.broken.length} section offsets do not resolve, so the assembled document was mutated after assembly.`);
    }
    // The chapter row is the authority on a section's type — `mission_chapters`
    // owns the column — so the citation's carried copy is checked against it
    // rather than trusted.
    const typeByChapter = new Map(chapterRows.map((row) => [chapterKey(row.dimensionId, row.chapterIndex), row.sectionType]));

    /* ── the mechanical pass ─────────────────────────────────────────── */

    const verified = store.verifiedFindings(missionId, { runCount });
    const findingById = new Map(verified.map((row) => [row.id, row]));

    // One parse per document, so a report citing one page forty times reads it
    // once. The blocking cost here is the block build, not the network.
    const documents = new Map();
    const readDocument = (url) => {
      let key;
      try {
        key = documentIdFor(url);
      } catch (cause) {
        // A URL we cannot key is a URL whose cache and whose attribution check
        // both silently stop working, so it is reported rather than shrugged at.
        return { ok: false, kind: "unchecked", reason: String(cause?.message ?? cause), documentId: null, document: null, block: null };
      }
      if (documents.has(key)) return documents.get(key);
      const document = store.getDocument(key);
      let entry;
      if (document === undefined) {
        entry = { ok: false, kind: "unchecked", reason: "no stored document for this url", documentId: key, document: null, block: null };
      } else if (document.admissible !== true) {
        entry = {
          ok: false,
          kind: "unchecked",
          documentId: key,
          document,
          block: null,
          reason: `the stored page is ${document.status} with ${document.charCount} normalised characters, and a verified state needs 2xx with at least ${MIN_DOCUMENT_CHARS}`,
        };
      } else {
        const block = blockFor(document);
        // The tag is the whole point of routing through `blockFor`. An untagged
        // block means the §3.6 guard is not running, and verifying against it
        // would return `ok: true` from a builder that stripped nothing.
        if (typeof block?.tag !== "string" || block.tag === "") {
          throw fail("input_invalid", zh
            ? `mission-blocks.js 的 blockFor() 为 ${document.url} 返回了未打标签的块。s9 在调用 verifyQuote 之前必须断言标签存在——未打标签的块意味着 §3.6 的守卫根本没有运行。`
            : `blockFor() in mission-blocks.js returned an untagged block for ${document.url}. s9 asserts the tag before it verifies anything: an untagged block means the §3.6 guard is not running at all.`);
        }
        entry = { ok: true, kind: "verified", reason: null, documentId: key, document, block };
      }
      documents.set(key, entry);
      return entry;
    };

    /* Pass A — the FINDING's own stored evidence, once per cited finding.
     *
     * First, and separate from pass B, because the two answer different
     * questions. Pass A asks whether the evidence we RECORDED still verifies
     * against the page we recorded it from; if it does not, the finding is
     * genuinely no longer verified. Pass B asks whether the quote the writer put
     * in the chapter verifies; if that is the one that fails, the finding is
     * fine and the writer edited the quote on the way through. Demoting a good
     * finding for a writer's edit would delete real evidence to record a
     * drafting bug. */
    const citedFindingIds = new Set();
    for (const citation of citations) {
      if (typeof citation?.findingId === "string" && citation.findingId !== "") citedFindingIds.add(citation.findingId);
    }

    const findingChecks = new Map();
    for (const findingId of citedFindingIds) {
      const finding = findingById.get(findingId);
      if (finding === undefined) {
        findingChecks.set(findingId, { kind: "not-verified", reason: "the finding is not in this run's verified set" });
        continue;
      }
      const entry = readDocument(finding.sourceUrl);
      if (!entry.ok) {
        findingChecks.set(findingId, { kind: "unchecked", reason: entry.reason, documentId: entry.documentId, document: entry.document, block: null });
        continue;
      }
      // THREE arguments, always. The two-argument form loops every block and
      // returns whichever matched, so a quote given to S1 that appears in S3
      // lands verified with the wrong outlet's name under it and every count
      // still correct. Keyed by the block's own id, so the attribution that ends
      // up stored is the address a reader can open.
      const verdict = verifyQuote(finding.evidence, new Map([[entry.block.id, entry.block.text]]), entry.block.id);
      findingChecks.set(findingId, verdict.ok
        ? { kind: "verified", reason: null, documentId: entry.documentId, document: entry.document, block: entry.block }
        : { kind: "failed", reason: verdict.reason, documentId: entry.documentId, document: entry.document, block: entry.block });
    }

    // One transaction, and no `await` between its open and its close: on one
    // shared connection an await inside lets the hourly collector's inserts
    // execute within this transaction, where a rollback discards them.
    const rewritten = [];
    let demoted = 0;
    let spanless = 0;
    store.withTx(() => {
      for (const [findingId, check] of findingChecks) {
        const finding = findingById.get(findingId);
        if (finding === undefined) continue;
        if (check.kind === "unchecked") {
          // A refusal is not emptiness. `unchecked-fetch-failed` says the page
          // could not back the check; `unverifiable` would read as hallucination.
          store.setFindingVerifyState(findingId, "unchecked-fetch-failed", { reason: `s9: ${check.reason}` });
          rewritten.push({ findingId, state: "unchecked-fetch-failed", reason: check.reason });
          continue;
        }
        if (check.kind === "failed") {
          const state = verifyStateForReason(check.reason);
          store.setFindingVerifyState(findingId, state, { reason: `s9: ${check.reason}` });
          rewritten.push({ findingId, state, reason: check.reason });
          demoted += 1;
          continue;
        }
        if (check.kind !== "verified") continue;
        // A re-affirmation, and normally a no-op write. `setFindingVerifyState`
        // refuses a fetch-backed state without a span index, and `spanIndexOf`
        // is `s3`'s own locator rather than a second implementation of the
        // contiguity rule. When it and `verifyQuote` disagree — verified but no
        // single span found — the disagreement is COUNTED and the row is left
        // exactly as it stands, rather than papered over with a fabricated 0.
        const spanIndex = spanIndexOf(check.block.text, finding.evidence);
        if (spanIndex < 0) {
          spanless += 1;
          rewritten.push({ findingId, state: null, reason: "re-checked and verified, but no single span contained it, so the verify state was left as it stands" });
          continue;
        }
        store.setFindingVerifyState(findingId, COUNTING_VERIFY_STATE, {
          reason: "s9: re-checked against the stored document",
          documentId: check.documentId,
          spanIndex,
        });
        rewritten.push({ findingId, state: COUNTING_VERIFY_STATE, reason: "re-affirmed" });
      }
    });

    /* Pass B — the CITATION's own inline quote, once per citation. */
    const verdicts = [];
    for (const citation of citations) {
      const findingId = typeof citation?.findingId === "string" && citation.findingId !== "" ? citation.findingId : null;
      const sectionType = typeByChapter.get(chapterKey(citation.dimensionId, citation.chapterIndex)) ?? citation.sectionType ?? null;
      const base = {
        index: Number(citation?.index),
        findingId,
        url: citation?.url ?? null,
        sectionType,
        fetchedAt: null,
        status: "unchecked",
        reason: "",
      };

      const check = findingId === null ? undefined : findingChecks.get(findingId);
      if (check === undefined || check.kind === "not-verified") {
        verdicts.push({ ...base, status: "unverified", reason: zh
          ? "该引用没有指向本轮已验证集合中的任何发现。"
          : "the citation names no finding in this run's verified set." });
        continue;
      }
      if (check.kind === "unchecked") {
        verdicts.push({ ...base, status: "unchecked", reason: check.reason });
        continue;
      }
      base.fetchedAt = check.document?.fetchedAt ?? null;

      const quote = String(citation?.inlineQuote ?? "");
      const verdict = verifyQuote(quote, new Map([[check.block.id, check.block.text]]), check.block.id);
      if (verdict.ok) {
        // The evidence boundary holds at the citation as well as at the fact
        // table: a quote can be verbatim in the page and still hang off a
        // finding whose own recorded evidence no longer verifies, and counting
        // that as verified would let a demoted finding keep its green number.
        if (check.kind === "verified") {
          verdicts.push({ ...base, status: "verified", reason: "" });
        } else {
          verdicts.push({ ...base, status: "unverified", reason: zh
            ? `引文本身在来源中逐字存在，但它所依据的发现已不再通过验证（${check.reason}）。`
            : `the quote is verbatim in the source, but the finding it rests on no longer verifies (${check.reason}).` });
        }
        continue;
      }
      if (check.kind === "verified") {
        // The failure this whole stage exists for, named precisely rather than
        // blamed on the model: the recorded evidence still verifies and the
        // rendered quote does not, so it was edited between the finding and the
        // chapter.
        verdicts.push({ ...base, status: "unverified", reason: zh
          ? `章节中的引文与来源不符（${verdict.reason}），而该发现记录的原文仍然可以验证：引文是在写作途中被改动的。`
          : `the chapter's quote does not sit in the source (${verdict.reason}) while the finding's recorded evidence still does: the quote was edited on the way into the chapter.` });
        continue;
      }
      verdicts.push({ ...base, status: "unverified", reason: verdict.reason });
    }

    /* ── the Verifier's pass, over what already verified ─────────────── */

    // Only mechanically-verified citations reach the model, and its vocabulary
    // carries no `verified` member: a quote is promoted by `verifyQuote` and by
    // nothing else. Its only power over the scorecard is to move `verified` to
    // `contradicted`.
    const candidates = verdicts.filter((v) => v.status === "verified");
    let rung = Math.max(0, Math.min(VERIFY_RUNGS.length - 1, Number(crossState?.contextPlan?.shrinkBy?.[stage.id] ?? 0)));
    let tokens = 0;
    let judged = 0;
    let modelNote = null;
    const batchesRun = [];

    let cursor = 0;
    while (cursor < candidates.length) {
      if (signal?.aborted === true) break;
      const settings = VERIFY_RUNGS[rung];
      const batch = candidates.slice(cursor, cursor + settings.batch);
      const blocks = new Map();
      const rows = batch.map((verdict) => {
        const finding = findingById.get(verdict.findingId);
        const check = findingChecks.get(verdict.findingId);
        if (check?.block !== undefined && check.block !== null) blocks.set(check.block.id, check.block.text);
        return { verdict, finding, check };
      });

      // The seam narrows the EXCERPT within one call; it never drops a citation
      // from the batch, because a citation silently missing from a batch is a
      // citation nobody judged and nobody counted. Dropping citations is the
      // stage's job, by moving to a smaller batch on `context_exceeded` below.
      const render = (level) => {
        const width = EXCERPT_RUNGS[Math.min(level, EXCERPT_RUNGS.length - 1)] ?? settings.excerpt;
        return JSON.stringify({
          topic: mission.topic,
          reportTitle: crossState?.report?.title ?? null,
          judgements: VERIFIER_JUDGEMENTS,
          citations: rows.map(({ verdict, finding, check }) => ({
            index: verdict.index,
            claim: finding?.claim ?? "",
            quote: finding?.evidence ?? "",
            sourceTitle: finding?.sourceTitle ?? null,
            sourceUrl: finding?.sourceUrl ?? null,
            fetchedAt: verdict.fetchedAt,
            excerpt: excerptAround(check?.block?.text ?? "", finding?.evidence ?? "", Math.min(width, settings.excerpt)),
          })),
        }, null, 1);
      };

      const wanted = new Set(batch.map((v) => v.index));
      const checkFinalize = (output) => {
        const issues = [];
        const answered = arrayOf(output?.verdicts);
        const named = new Set(answered.map((row) => Number(row?.index)));
        for (const index of wanted) {
          if (!named.has(index)) {
            issues.push(zh
              ? `第 ${index} 条引用没有被裁定。本批每一条都必须给出裁定。`
              : `citation ${index} was not judged. Every citation in this batch needs a judgement.`);
          }
        }
        for (const row of answered) {
          if (String(row?.judgement) === "contradicts" && String(row?.reason ?? "").trim() === "") {
            issues.push(zh
              ? `第 ${row?.index} 条被判为与来源矛盾，却没有说明矛盾在哪里。`
              : `citation ${row?.index} was judged to contradict its source with no statement of where the contradiction is.`);
          }
        }
        return issues;
      };

      // eslint-disable-next-line no-await-in-loop -- batches are sequential on purpose: one process, one pacer, and the rung only narrows on a failure this loop has to observe.
      const run = await runDuty(wired, context, {
        role: stage.agent,
        duty: DUTIES.verify,
        brief: `s9-batch-${cursor}`,
        render,
        blocks,
        schema: VERIFY_SCHEMA,
        description: "Record one judgement per citation in this batch: whether the source supports the claim, contradicts it, or leaves it unclear.",
        checkFinalize,
      });
      tokens += Number(run.tokens?.total ?? 0);

      if (run.state === "failed") {
        if (run.failureCode === "context_exceeded" && rung < VERIFY_RUNGS.length - 1) {
          // ROUTINE, not an anomaly (§8.5). The action for a context overflow at
          // s9 is "re-run this stage at a smaller batch size", so that is
          // literally what happens, and the ladder's own label travels with it.
          rung += 1;
          batchesRun.push({ from: cursor, size: batch.length, rung, label: stage.shrinkLadder[rung] ?? null, outcome: "context_exceeded, narrowed" });
          continue;
        }
        throwFromRun(run, stage.id);
      }
      if (run.state === "degraded") modelNote = run.diagnostic ?? "the verifier run degraded with no diagnostic.";

      for (const row of arrayOf(run.output?.verdicts)) {
        const target = verdicts.find((v) => v.index === Number(row?.index));
        if (target === undefined || target.status !== "verified") continue;
        judged += 1;
        if (String(row?.judgement) === "contradicts") {
          target.status = "contradicted";
          target.reason = String(row?.reason ?? "").trim() || (zh ? "验证者判定来源与该论断矛盾。" : "the verifier judged the source to contradict the claim.");
        }
      }
      batchesRun.push({ from: cursor, size: batch.length, rung, label: stage.shrinkLadder[rung] ?? null, outcome: run.exitReason ?? "completed" });
      cursor += batch.length;
    }

    /* ── the scorecard, and the preflight warning ────────────────────── */

    const scorecard = buildScorecard(verdicts);
    const share = verifiedRatioOf(scorecard);
    const floor = numberOrNull(policy.verifiedRatioFloor);

    if (share.ratio !== null && floor !== null && share.ratio < floor) {
      // Painted as soon as s9 knows it rather than sprung at s11 after forty
      // minutes. It is the same ratio the forced-unsign ladder reads, computed
      // by the same function, so the warning and the refusal cannot disagree.
      emit("gate:soft-warning", {
        gate: "verified-ratio",
        stepId: stage.id,
        over: share.over,
        verified: share.verified,
        total: share.total,
        ratio: share.ratio,
        floor,
        why: zh
          ? `已验证比例 ${(share.ratio * 100).toFixed(0)}%（${share.verified}/${share.total}，按 ${share.over} 统计）低于本档下限 ${(floor * 100).toFixed(0)}%。若不改善，s11 的签署会被代码改写为拒签。`
          : `verified ratio ${(share.ratio * 100).toFixed(0)}% (${share.verified}/${share.total}, over ${share.over}) is below this tier's floor of ${(floor * 100).toFixed(0)}%. Unchanged, the code will overwrite s11's signature to a refusal.`,
      });
    }

    const notes = [];
    if (scorecard.total === 0) {
      notes.push(zh
        ? "报告里没有任何引用可供核验。这不是一份干净的成绩单：s12 的内容守卫会因此拒绝该报告。"
        : "the report carries no citations to check. This is not a clean bill: s12's content guard refuses a report with none.");
    }
    if (!offsets.ok) {
      notes.push(zh
        ? `${offsets.broken.length} 处章节偏移无法在正文中解析，说明这份文档在装配之后被改动过。`
        : `${offsets.broken.length} section offsets do not resolve against the markdown, which means the document was mutated after assembly.`);
    }
    if (report.unresolvedMarkers > 0) {
      notes.push(zh
        ? `装配时发现 ${report.unresolvedMarkers} 个没有对应引用的标记，已被移除。`
        : `${report.unresolvedMarkers} citation markers resolved to nothing at assembly and were removed.`);
    }
    if (demoted > 0) {
      notes.push(zh
        ? `${demoted} 条发现在复核后不再通过验证，已在 mission_findings 中降级。`
        : `${demoted} findings no longer verify on re-check and were demoted in mission_findings.`);
    }
    if (spanless > 0) {
      notes.push(zh
        ? `${spanless} 条发现通过了验证，却找不到唯一的连续片段，验证状态原样保留。`
        : `${spanless} findings verified but no single span contained the quote, so their verify state was left as it stands.`);
    }
    if (scorecard.unplaced.total > 0) {
      notes.push(zh
        ? `${scorecard.unplaced.total} 条引用没有可归属的章节类型。`
        : `${scorecard.unplaced.total} citations could not be attributed to a section type.`);
    }
    if (hydrated) {
      notes.push(zh
        ? "crossState.tierPolicy 缺失，本阶段直接读取了 s1 所用的同一张分级表。"
        : "crossState.tierPolicy was absent, so this stage read the same tier table s1 resolves from.");
    }
    if (modelNote !== null) notes.push(modelNote);

    const degraded = notes.length > 0;
    return {
      output: {
        scorecard,
        verifiedShare: share,
        citations: scorecard.total,
        findingsRewritten: rewritten.length,
        findingsDemoted: demoted,
        judged,
        batches: batchesRun,
        sectionOffsets: offsets.ok ? "resolved" : offsets.broken,
      },
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens: Math.max(0, Math.round(tokens)),
      crossPatch: { verdicts, scorecard },
    };
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   s10 · critique
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every string anywhere in a value, for the independence assertion.
 *
 * Own enumerable properties only: a digest built from `crossState` can carry a
 * key called "constructor", and an inherited property is not something the model
 * was shown.
 */
function stringsIn(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) stringsIn(value[key], out);
  }
  return out;
}

/**
 * Refuse an `s10` input that carries chapter prose.
 *
 * `s10` is an independent reader that never saw the drafting reasoning; handing
 * it the draft defeats the entire stage, and it defeats it INVISIBLY — the
 * output still looks like a critique. So the check is mechanical.
 *
 * Sliding the INPUT over the bodies rather than the other way round is
 * deliberate: the input is bounded by design and the bodies are not, so this
 * costs microseconds on a 25,000-word report instead of scanning it thousands
 * of times.
 *
 * The bound, stated rather than implied: the window is 200 characters and the
 * stride is half of it, so any shared run of 300 characters or more is caught
 * for certain, and a run between 200 and 300 is caught unless it straddles both
 * window boundaries. That is the honest guarantee — what this defends against is
 * a field carrying a paragraph or a whole body, not a sentence appearing twice.
 * @param input - the digest about to be sent.
 * @param chapterRows - `store.listChapters` for this run.
 * @returns `{ok, leak}` — `leak` is the offending excerpt.
 */
export function checkCritiqueIndependence(input, chapterRows) {
  const bodies = flatten(arrayOf(chapterRows).map((row) => row.body ?? "").join("\n\n"));
  if (bodies === "") return { ok: true, leak: null };
  const stride = Math.floor(CRITIQUE_LEAK_WINDOW / 2);
  for (const raw of stringsIn(input)) {
    const text = flatten(raw);
    if (text.length <= CRITIQUE_LEAK_WINDOW) continue;
    for (let at = 0; at + CRITIQUE_LEAK_WINDOW <= text.length; at += stride) {
      const window = text.slice(at, at + CRITIQUE_LEAK_WINDOW);
      if (bodies.includes(window)) return { ok: false, leak: window };
    }
  }
  return { ok: true, leak: null };
}

/**
 * Stage ten: an independent reader, and a pre-mortem on every forecast.
 *
 * @param deps - `{store, chat, circuit, cache, spillDir, config, ctx, logger}`.
 * @returns the `s10-critique` handler.
 */
export function createS10Critique(deps) {
  const wired = requireDeps(deps, "createS10Critique");
  const { store } = wired;

  return async function s10Critique(context) {
    const { missionId, runCount, mission, stage, crossState } = context;
    const zh = zhOf(mission);

    const chapterRows = store.listChapters(missionId, runCount);
    const report = assemble(chapterRows);

    const facts = arrayOf(crossState?.facts);
    const foresight = arrayOf(crossState?.foresight);
    const dimensions = store.listDimensions(missionId, { runCount });

    // Headings and the fact table, never the bodies. The critic gets the
    // headings so it cannot manufacture a gap the report actually covers, and
    // the facts so its criticism is about the evidence rather than about the
    // prose it was deliberately not shown.
    const digest = {
      topic: mission.topic,
      title: crossState?.report?.title ?? null,
      wordCount: Number(crossState?.report?.wordCount ?? report.wordCount),
      headings: report.sections.map((s) => ({ heading: s.heading, sectionType: s.sectionType, wordCount: s.wordCount, citations: s.citationCount })),
      facts: facts.map((f) => ({ factId: f.factId, entity: f.entity, attribute: f.attribute, value: f.value })),
      conflicts: arrayOf(crossState?.conflicts).map((c) => ({ conflictId: c.conflictId, resolution: c.resolution, factIds: c.factIds })),
      gaps: arrayOf(crossState?.gaps),
      dimensions: dimensions.map((d) => ({ dimensionId: d.dimensionId, name: d.name, state: d.state, verified: d.verified, uniqueHosts: d.uniqueHosts })),
    };

    const independence = checkCritiqueIndependence(digest, chapterRows);
    if (!independence.ok) {
      throw fail("input_invalid", zh
        ? `s10 的输入包含了章节正文。它是一个从未看过起草推理的独立读者；把草稿递给它就毁掉了这个阶段。泄漏片段以此开头：「${independence.leak.slice(0, 120)}」`
        : `s10's input carried chapter bodies. It is an independent reader that never saw the drafting reasoning; passing it the draft defeats the stage. The leaked run begins: "${independence.leak.slice(0, 120)}"`);
    }

    const notes = [];
    let tokens = 0;

    /* ── the critic ──────────────────────────────────────────────────── */

    // The ladder `s10` declares is one rung: "summary and headings only".
    const renderCritic = (level) => JSON.stringify(level === 0
      ? digest
      : { topic: digest.topic, title: digest.title, wordCount: digest.wordCount, headings: digest.headings }, null, 1);

    const critic = await runDuty(wired, context, {
      role: stage.agent,
      duty: DUTIES.critic,
      brief: "s10-critic",
      render: renderCritic,
      schema: CRITIC_SCHEMA,
      description: "Record what this report is blind to and where it leans, as an independent reader who never saw it being written.",
      checkFinalize: (output) => {
        const issues = [];
        if (arrayOf(output?.blindspots).length === 0 && arrayOf(output?.biases).length === 0) {
          issues.push(zh
            ? "盲点与偏差都为空。如果这份报告确实两者都没有，请写下你据以判断的依据；空列表不是评审结论。"
            : "both blindspots and biases are empty. If this report genuinely has neither, say what you checked to conclude that; an empty list is not a review.");
        }
        return issues;
      },
    });
    tokens += Number(critic.tokens?.total ?? 0);

    // A failed run DEGRADES the stage; it does not return an empty critique as
    // if nothing were wrong. `s11`'s `whatRemainsUnclear` gate is BINDING when
    // blindspots are non-empty, so an emptiness that is really a swallowed
    // failure quietly unbinds the one honesty gate at sign-off.
    if (critic.state === "failed") {
      if (critic.exitReason === "cancelled") throwFromRun(critic, stage.id);
      notes.push(zh
        ? `评论者一轮失败（${critic.failureCode ?? "未分类"}）：${critic.diagnostic ?? "无诊断"}。本阶段的盲点列表是不完整的，而不是「没有发现问题」。`
        : `the critic run failed (${critic.failureCode ?? "unclassified"}): ${critic.diagnostic ?? "no diagnostic"}. This stage's blindspot list is incomplete, which is not the same as nothing being wrong.`);
    } else if (critic.state === "degraded") {
      notes.push(critic.diagnostic ?? "the critic run degraded with no diagnostic.");
    }

    const blindspots = arrayOf(critic.output?.blindspots);
    const biases = arrayOf(critic.output?.biases);

    /* ── the red team ────────────────────────────────────────────────── */

    const forecastIds = new Set(foresight.map((f) => String(f?.forecastId ?? "")).filter((id) => id !== ""));
    let forecastVulnerabilities = [];

    if (forecastIds.size === 0) {
      // Stated, never silently skipped: an empty pre-mortem because there was
      // nothing to pre-mortem is a different fact from one that failed.
      notes.push(zh
        ? "s6 没有产出任何预测，因此没有可做事前验尸的对象；红队一轮被跳过。"
        : "s6 produced no forecasts, so there was nothing to run a pre-mortem on and the red-team pass was skipped.");
    } else {
      const renderRed = (level) => JSON.stringify(level === 0
        ? { ...digest, foresight }
        : { topic: digest.topic, headings: digest.headings, foresight }, null, 1);

      const red = await runDuty(wired, context, {
        role: stage.agent,
        duty: DUTIES.redTeam,
        brief: "s10-red-team",
        render: renderRed,
        schema: RED_TEAM_SCHEMA,
        description: "Run a pre-mortem on the forecasts this mission made. Name the forecast you are attacking by its own id.",
        checkFinalize: (output) => {
          const issues = [];
          for (const row of arrayOf(output?.forecastVulnerabilities)) {
            const id = String(row?.forecastId ?? "");
            if (!forecastIds.has(id)) {
              issues.push(zh
                ? `forecastVulnerability 指向 "${id}"，而 s6 的预测里没有这个 id。可用的是：${[...forecastIds].join("、")}。一个自己发明预测的红队不是事前验尸。`
                : `a forecastVulnerability names "${id}", which is not one of s6's forecasts. The ids available are: ${[...forecastIds].join(", ")}. A red team that invents its own forecasts is not a pre-mortem.`);
            }
          }
          return issues;
        },
      });
      tokens += Number(red.tokens?.total ?? 0);

      if (red.state === "failed") {
        if (red.exitReason === "cancelled") throwFromRun(red, stage.id);
        notes.push(zh
          ? `红队一轮失败（${red.failureCode ?? "未分类"}）：${red.diagnostic ?? "无诊断"}。预测未经压力测试。`
          : `the red-team run failed (${red.failureCode ?? "unclassified"}): ${red.diagnostic ?? "no diagnostic"}. The forecasts were not stress-tested.`);
      } else if (red.state === "degraded") {
        notes.push(red.diagnostic ?? "the red-team run degraded with no diagnostic.");
      }

      const offered = arrayOf(red.output?.forecastVulnerabilities);
      forecastVulnerabilities = offered.filter((row) => forecastIds.has(String(row?.forecastId ?? "")));
      const dropped = offered.length - forecastVulnerabilities.length;
      if (dropped > 0) {
        // After the finalize gate asked the bounded number of times and was
        // answered badly, code decides — and reports the count rather than
        // absorbing it.
        notes.push(zh
          ? `${dropped} 条预测脆弱点指向了不存在的 forecastId，已丢弃。`
          : `${dropped} forecast vulnerabilities named a forecastId that does not exist and were dropped.`);
      }
    }

    const critique = { blindspots, biases, forecastVulnerabilities };
    const degraded = notes.length > 0;
    return {
      // The same object as the output, so it is durable in
      // `mission_stages.output`: there is no `mission_critique` table, and
      // adding one would mean four parallel groups each adding a migration to
      // the module that owns every statement. `stageOutput()` reads it back on a
      // rehydrate.
      output: critique,
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens: Math.max(0, Math.round(tokens)),
      crossPatch: critique,
    };
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   s11 · sign off
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Trim the Leader's own history for the sign-off prompt.
 *
 * Keeps ALL `plan` and `foreword` decisions and trims only `assess` ones. A
 * naive `slice(-15)` over the whole history truncates the original plan out of
 * the sign-off prompt, and the plan is the one input that makes accountability
 * real rather than asserted: the Leader can only be held to a decision it can
 * still see.
 * @param decisions - `crossState.leaderDecisions`.
 * @param keepAssess - how many assess entries to keep.
 * @returns the trimmed history, in order.
 */
export function trimLeaderHistory(decisions, keepAssess = KEEP_ASSESS_DECISIONS) {
  const rows = arrayOf(decisions);
  const assess = rows.filter((row) => String(row?.phase) === "assess");
  const drop = new Set(assess.slice(0, Math.max(0, assess.length - keepAssess)));
  return rows.filter((row) => !drop.has(row));
}

/**
 * The list of things genuinely still unclear, built from the record.
 *
 * Used only when the Leader was asked for one, refused the bounded number of
 * times, and still returned nothing. It is a repair, and the stage degrades when
 * it fires: a machine-written honesty section is better than a missing one and
 * worse than a real one, and the record has to say which it got.
 */
function machineUnclear(zh, { degradedDimensions, criticalGaps, blindspots }) {
  const rows = [];
  for (const dimension of degradedDimensions) {
    rows.push(zh
      ? `维度「${dimension.name ?? dimension.dimensionId}」以 ${dimension.state} 结束，已验证发现 ${dimension.verified} 条：该主题下的结论证据不足。`
      : `the dimension "${dimension.name ?? dimension.dimensionId}" ended ${dimension.state} with ${dimension.verified} verified findings, so conclusions under it are thinly evidenced.`);
  }
  for (const gap of criticalGaps) {
    rows.push(zh
      ? `${gap.dimensionId} 存在关键缺口：${arrayOf(gap.aspects).join("、") || "未具名"}。`
      : `a critical gap remains in ${gap.dimensionId}: ${arrayOf(gap.aspects).join(", ") || "unnamed"}.`);
  }
  for (const blindspot of blindspots) {
    const text = typeof blindspot === "string" ? blindspot : String(blindspot?.statement ?? "");
    if (text.trim() !== "") rows.push(text.trim());
  }
  return rows;
}

/**
 * Stage eleven: the foreword, the signature, and the forced-unsign ladder.
 *
 * Returns NO `terminalIntent`. `checkStageReturn` rejects one at this mode, and
 * the reason underneath the check is the race: if `s11` wrote the status,
 * `s12`'s conditional write would lose, `won` would be false, and the postlude,
 * the terminal event and the checkpoint policy would never run.
 * @param deps - `{store, chat, circuit, cache, spillDir, config, ctx, logger}`.
 * @returns the `s11-signoff` handler.
 */
export function createS11Signoff(deps) {
  const wired = requireDeps(deps, "createS11Signoff");
  const { store } = wired;

  return async function s11Signoff(context) {
    const { missionId, runCount, mission, tier, stage, crossState, now, emit } = context;
    const zh = zhOf(mission);
    const { policy, hydrated } = tierPolicyOf(crossState, tier, zh);

    /* ── G8: hydrate, never fall back ────────────────────────────────── */

    const goals = crossState?.goals ?? mission.goals ?? null;
    if (goals === null || typeof goals !== "object") {
      throw fail("input_invalid", zh
        ? "crossState.goals 与 missions.goals 都是空的，签署无从进行。s2 写入目标，s11 读取它；用一条通用的质量标准去评判，会因为一个与工作本身无关的结构性原因产生一个 47 分左右的拒签。"
        : "both crossState.goals and missions.goals are empty, so there is no bar to sign against. s2 writes the goals and s11 reads them; grading against a generic bar produces a refusal scoring around 47 for a structural reason unrelated to the work.");
    }

    const scorecard = crossState?.scorecard ?? null;
    if (scorecard === null || typeof scorecard !== "object") {
      throw fail("input_invalid", zh
        ? "crossState.scorecard 缺失。s9 写入成绩单，强制不签署阶梯读取它；没有它，签署就退回到主观判断，而这正是本设计要取代的东西。"
        : "crossState.scorecard is missing. s9 writes it and the forced-unsign ladder reads it; without it the signature falls back to subjective judgement, which is the thing this design exists to replace.");
    }

    const chapterRows = store.listChapters(missionId, runCount);
    const report = assemble(chapterRows);
    const wordCount = report.wordCount;
    const share = verifiedRatioOf(scorecard);
    const ratioFloor = numberOrNull(policy.verifiedRatioFloor);
    const wordFloor = Number(policy.wordFloor);

    const dimensions = store.listDimensions(missionId, { runCount });
    const degradedDimensions = dimensions.filter((d) => d.state === "degraded" || d.state === "failed");
    const criticalGaps = arrayOf(crossState?.gaps).filter((gap) => String(gap?.severity ?? "").toLowerCase() === "critical");
    const blindspots = arrayOf(crossState?.blindspots);

    /* ── G9 and G3: preconditions the Leader must address in writing ──── */

    const preconditions = [];
    if (Number(scorecard.total ?? 0) === 0) {
      preconditions.push(zh
        ? "这份报告一条引用都没有。0/0 不是一个干净的比例，它意味着没有任何东西被核验过；除非你能在书面上说明为什么这仍然构成一份可交付的报告，否则必须拒签。"
        : "this report carries no citations at all. 0/0 is not a clean ratio, it means nothing was checked; refuse unless you can state in writing why this is still a deliverable report.");
    }
    for (const row of store.listStages(missionId)) {
      if (row.stepId === stage.id) continue;
      if (row.status === "done" || row.status === "skipped-by-tier" || row.status === "pending") continue;
      // The Leader alone does not get to accept degraded input for its own
      // call: every upstream state that is not a clean completion becomes a
      // refusal precondition it has to address in writing.
      preconditions.push(zh
        ? `阶段 ${row.stepId} 以 ${row.status} 结束${row.degradeNote ? `：${row.degradeNote}` : ""}。请在问责说明里写明它如何影响这份报告。`
        : `stage ${row.stepId} ended ${row.status}${row.degradeNote ? `: ${row.degradeNote}` : ""}. Say in the accountability note how that affects this report.`);
    }

    const history = trimLeaderHistory(crossState?.leaderDecisions);
    const decisionIds = new Set(history.map((row) => String(row?.id ?? row?.label ?? "")).filter((id) => id !== ""));
    const unclearRequired = degradedDimensions.length > 0 || criticalGaps.length > 0 || blindspots.length > 0;

    const notes = [];
    if (hydrated) {
      notes.push(zh
        ? "crossState.tierPolicy 缺失，本阶段直接读取了 s1 所用的同一张分级表。"
        : "crossState.tierPolicy was absent, so this stage read the same tier table s1 resolves from.");
    }
    let tokens = 0;

    /* ── the foreword ────────────────────────────────────────────────── */

    const brief = {
      topic: mission.topic,
      tier,
      goals,
      history,
      scorecard,
      verifiedShare: share,
      wordCount,
      wordFloor,
      verifiedRatioFloor: ratioFloor,
      dimensions: dimensions.map((d) => ({ dimensionId: d.dimensionId, name: d.name, state: d.state, verified: d.verified, unchecked: d.unchecked, uniqueHosts: d.uniqueHosts })),
      critique: { blindspots, biases: arrayOf(crossState?.biases), forecastVulnerabilities: arrayOf(crossState?.forecastVulnerabilities) },
      gaps: arrayOf(crossState?.gaps),
      foresight: arrayOf(crossState?.foresight),
      headings: report.sections.map((s) => s.heading),
      preconditions,
      // PRECOMPUTED, never left to the model. Never make a model do the
      // arithmetic that decides its own verdict — the highest-leverage prompt
      // lesson in the reference.
      unclearRequired,
    };

    // `s11`'s declared ladder: a bounded digest, then drop the stage outcomes.
    const renderFor = (extra) => (level) => {
      if (level === 0) return JSON.stringify({ ...brief, ...extra }, null, 1);
      const bounded = {
        topic: brief.topic,
        goals: brief.goals,
        history: brief.history,
        scorecard: brief.scorecard,
        verifiedShare: brief.verifiedShare,
        wordCount: brief.wordCount,
        wordFloor: brief.wordFloor,
        unclearRequired: brief.unclearRequired,
        ...(level >= 2 ? {} : { preconditions: brief.preconditions }),
        ...extra,
      };
      return JSON.stringify(bounded, null, 1);
    };

    const forewordRun = await runDuty(wired, context, {
      role: stage.agent,
      duty: DUTIES.foreword,
      brief: "s11-foreword",
      render: renderFor({}),
      schema: FOREWORD_SCHEMA,
      description: "Write the foreword: what this mission answered against its own criteria, what remains unclear, how to read the report, and what to do next.",
      checkFinalize: (output) => {
        const issues = [];
        const answered = arrayOf(output?.whatWeAnswered);
        const criteria = arrayOf(goals?.successCriteria);
        if (answered.length < criteria.length) {
          issues.push(zh
            ? `successCriteria 有 ${criteria.length} 条，whatWeAnswered 只有 ${answered.length} 条。每一条标准都要有对应的回答。`
            : `there are ${criteria.length} success criteria and only ${answered.length} entries in whatWeAnswered. Every criterion needs one.`);
        }
        if (unclearRequired && arrayOf(output?.whatRemainsUnclear).length === 0) {
          issues.push(zh
            ? `whatRemainsUnclear 是空的，但有 ${degradedDimensions.length} 个维度降级、${criticalGaps.length} 处关键缺口、${blindspots.length} 条盲点。请如实写出仍然不清楚的部分。`
            : `whatRemainsUnclear is empty, but ${degradedDimensions.length} dimensions are degraded, ${criticalGaps.length} gaps are critical and the critic flagged ${blindspots.length} blindspots. Say what is genuinely still unclear.`);
        }
        return issues;
      },
    });
    tokens += Number(forewordRun.tokens?.total ?? 0);
    if (forewordRun.state === "failed") throwFromRun(forewordRun, stage.id);
    if (forewordRun.state === "degraded") notes.push(forewordRun.diagnostic ?? "the foreword run degraded with no diagnostic.");

    const foreword = {
      whatWeAnswered: arrayOf(forewordRun.output?.whatWeAnswered),
      whatRemainsUnclear: arrayOf(forewordRun.output?.whatRemainsUnclear),
      howToRead: String(forewordRun.output?.howToRead ?? ""),
      recommendedFollowUp: arrayOf(forewordRun.output?.recommendedFollowUp),
    };

    // G6's repair. The gate asked, was refused the bounded number of times, and
    // now code writes the list — and the stage degrades, because a
    // machine-written honesty section is not the one the Leader owes the reader.
    if (unclearRequired && foreword.whatRemainsUnclear.length === 0) {
      foreword.whatRemainsUnclear = machineUnclear(zh, { degradedDimensions, criticalGaps, blindspots });
      notes.push(zh
        ? "Leader 在被追问后仍未写出「仍不清楚的部分」，该列表由代码根据降级维度、关键缺口与盲点生成。"
        : "the Leader still returned no whatRemainsUnclear after being asked, so the list was generated by code from the degraded dimensions, the critical gaps and the critic's blindspots.");
    }

    /* ── the signature ───────────────────────────────────────────────── */

    const corrections = [];
    const checkSignoff = (output) => {
      const issues = [];
      const verdictBand = bandOfVerdict(output?.verdict);
      const score = numberOrNull(output?.score);
      if (verdictBand === null) {
        issues.push(zh
          ? `verdict 必须是 ${VERDICT_NAMES.join(" / ")} 之一，收到的是 "${output?.verdict}"。`
          : `verdict must be one of ${VERDICT_NAMES.join(" / ")}; "${output?.verdict}" is not.`);
      }
      if (score === null || score < 0 || score > 100) {
        issues.push(zh ? "score 必须是 0 到 100 之间的数字。" : "score must be a number between 0 and 100.");
      } else if (verdictBand !== null && (score < verdictBand.min || score > verdictBand.max)) {
        issues.push(zh
          ? `verdict "${verdictBand.name}" 对应 ${verdictBand.min}–${verdictBand.max} 分，而 score 是 ${score}。两者必须一致。`
          : `verdict "${verdictBand.name}" is the ${verdictBand.min}–${verdictBand.max} band and the score is ${score}. They have to agree.`);
      }
      if (output?.signed === false && String(output?.refusalReason ?? "").trim() === "") {
        issues.push(zh
          ? "signed: false 必须附带 refusalReason。一个没有理由的拒签，读者无从据以行动。"
          : "signed: false requires a refusalReason. A refusal with no reason gives the reader nothing to act on.");
      }
      const note = String(output?.accountabilityNote ?? "");
      if (note.length < 50 || note.length > 1500) {
        issues.push(zh
          ? `accountabilityNote 长度必须在 50 到 1500 字之间，当前 ${note.length}。`
          : `accountabilityNote must be between 50 and 1500 characters; this one is ${note.length}.`);
      } else if (decisionIds.size > 0 && ![...decisionIds].some((id) => note.includes(id))) {
        // Added after a 95-plus score was paired with "略有不足": a note that
        // references nothing the Leader actually decided is not accountability,
        // it is a compliment.
        issues.push(zh
          ? `accountabilityNote 必须引用你自己此前的一项决定。可引用的 id：${[...decisionIds].slice(0, 12).join("、")}。`
          : `accountabilityNote must reference one of your own earlier decisions. The ids available are: ${[...decisionIds].slice(0, 12).join(", ")}.`);
      }
      return issues;
    };

    const signDescription = "Sign, qualify or refuse this report, with a score in the band your verdict names and an accountability note that references your own earlier decisions.";
    let signRun = await runDuty(wired, context, {
      role: stage.agent,
      duty: DUTIES.signoff,
      brief: "s11-signoff",
      render: renderFor({ foreword, verdictBands: VERDICT_BANDS, decisionIds: [...decisionIds] }),
      schema: SIGNOFF_SCHEMA,
      description: signDescription,
      checkFinalize: checkSignoff,
    });
    tokens += Number(signRun.tokens?.total ?? 0);
    if (signRun.state === "failed") throwFromRun(signRun, stage.id);
    if (signRun.state === "degraded") notes.push(signRun.diagnostic ?? "the sign-off run degraded with no diagnostic.");

    let candidate = signRun.output ?? {};
    // Captured HERE, from the first sign-off, and deliberately not refreshed by
    // the forced re-ask below. `leader_score` is the number the Leader reached
    // on its own before anything corrected it; keeping the re-asked figure would
    // make the row say the Leader arrived at the corrected number by itself, and
    // the whole point of the two columns is that the correction stays visible.
    const leaderScore = numberOrNull(candidate.score);

    /* G1 — the word floor. Forced DOWN one band and re-asked exactly once with
     * an explicit instruction to re-sign. A Leader that rated a 50k-word
     * delivery against a 200k-word promise "excellent" is what produced this
     * rung. */
    if (wordCount < wordFloor) {
      const asked = bandOfVerdict(candidate.verdict) ?? bandOfScore(candidate.score);
      const forced = bandBelow(asked);
      if (forced.name !== asked.name) {
        corrections.push({
          id: `force-band:${asked.name}->${forced.name}`,
          phase: "signoff",
          at: now(),
          label: `word-floor ${wordCount}<${wordFloor}`,
          detail: zh
            ? `交付 ${wordCount} 词，低于本档下限 ${wordFloor} 词，verdict 由 ${asked.name} 强制下调为 ${forced.name}。`
            : `${wordCount} words delivered against a floor of ${wordFloor}; verdict forced from ${asked.name} down to ${forced.name}.`,
        });
        const reask = await runDuty(wired, context, {
          role: stage.agent,
          duty: DUTIES.signoff,
          brief: "s11-signoff-reask",
          render: renderFor({
            foreword,
            verdictBands: VERDICT_BANDS,
            decisionIds: [...decisionIds],
            forcedBand: forced.name,
            forcedReason: zh
              ? `交付 ${wordCount} 词，低于本档下限 ${wordFloor} 词。你的判定已被下调到 ${forced.name}（${forced.min}–${forced.max} 分）。请在这个区间内重新签署，并说明这个长度差距。`
              : `${wordCount} words were delivered against a floor of ${wordFloor}. Your verdict has been forced down to ${forced.name} (${forced.min}-${forced.max}). Re-sign inside that band and address the shortfall.`,
          }),
          schema: SIGNOFF_SCHEMA,
          description: signDescription,
          checkFinalize: checkSignoff,
        });
        tokens += Number(reask.tokens?.total ?? 0);
        if (reask.state === "failed") throwFromRun(reask, stage.id);
        if (reask.state === "degraded") notes.push(reask.diagnostic ?? "the re-sign run degraded with no diagnostic.");
        signRun = reask;
        candidate = reask.output ?? candidate;
      }
    }

    /* G4 — band coercion, and it only ever LOWERS.
     *
     * `mission-view.js` asserts `final_score <= leader_score` on the read path:
     * the ladder is defined as a thing that corrects downwards, and a final
     * score above the Leader's own number means the fusion invented confidence.
     * So a score above its verdict's band is clamped DOWN to the band, and a
     * score BELOW its verdict's band moves the VERDICT down to the score rather
     * than raising the score to the verdict. */
    let verdictBand = bandOfVerdict(candidate.verdict) ?? bandOfScore(candidate.score);
    let score = Math.max(0, Math.min(100, numberOrNull(candidate.score) ?? 0));
    if (score > verdictBand.max) {
      corrections.push({
        id: `coerce-score:${score}->${verdictBand.max}`,
        phase: "signoff",
        at: now(),
        label: "band-coercion",
        detail: zh
          ? `score ${score} 高于 verdict "${verdictBand.name}" 的区间上限 ${verdictBand.max}，已下调。`
          : `score ${score} sits above the "${verdictBand.name}" band's ceiling of ${verdictBand.max} and was lowered to it.`,
      });
      score = verdictBand.max;
    } else if (score < verdictBand.min) {
      const lowered = bandOfScore(score);
      corrections.push({
        id: `coerce-verdict:${verdictBand.name}->${lowered.name}`,
        phase: "signoff",
        at: now(),
        label: "band-coercion",
        detail: zh
          ? `score ${score} 低于 verdict "${verdictBand.name}" 的区间下限，判定改为 "${lowered.name}"。分数不会被抬高——这个阶梯只向下修正。`
          : `score ${score} falls below the "${verdictBand.name}" band, so the verdict was moved to "${lowered.name}". The score is never raised to meet a verdict: this ladder only corrects downwards.`,
      });
      verdictBand = lowered;
    }

    let signed = candidate.signed === true;
    let refusalReason = String(candidate.refusalReason ?? "").trim();

    /* G3 — no citations at all is a hard refusal precondition. */
    if (Number(scorecard.total ?? 0) === 0 && signed) {
      signed = false;
      refusalReason = zh
        ? "报告没有任何引用可供核验：0/0 不是一个干净的比例。"
        : "the report carries no citations to check: 0/0 is not a clean ratio.";
      corrections.push({ id: "unsign:no-citations", phase: "signoff", at: now(), label: "forced-unsign", detail: refusalReason });
    }

    /* G2 — the verified ratio. An OVERWRITE, not a consideration: a mechanism
     * the Leader may weigh is a mechanism about a prompt. */
    if (share.ratio !== null && ratioFloor !== null && share.ratio < ratioFloor && signed) {
      signed = false;
      refusalReason = `verified-ratio ${share.ratio.toFixed(2)} below floor ${ratioFloor.toFixed(2)}`;
      corrections.push({
        id: "unsign:verified-ratio",
        phase: "signoff",
        at: now(),
        label: "forced-unsign",
        detail: zh
          ? `已验证比例 ${share.verified}/${share.total}（按 ${share.over} 统计）= ${share.ratio.toFixed(2)}，低于本档下限 ${ratioFloor.toFixed(2)}；签署被代码改写为拒签。`
          : `verified ${share.verified}/${share.total} over ${share.over} = ${share.ratio.toFixed(2)}, below this tier's floor of ${ratioFloor.toFixed(2)}; the signature was overwritten to a refusal.`,
      });
    }

    if (!signed && refusalReason === "") {
      refusalReason = zh ? "Leader 未签署，且未给出理由。" : "the Leader did not sign and gave no reason.";
      corrections.push({ id: "unsign:no-reason", phase: "signoff", at: now(), label: "forced-unsign", detail: refusalReason });
    }

    if (corrections.length > 0) {
      emit("gate:hard-warning", {
        gate: "forced-unsign",
        stepId: stage.id,
        signed,
        score,
        verdict: verdictBand.name,
        corrections: corrections.map((row) => ({ id: row.id, detail: row.detail })),
      });
      notes.push(zh
        ? `签署被代码修正 ${corrections.length} 处：${corrections.map((c) => c.id).join("、")}。`
        : `the signature was corrected in ${corrections.length} places by code: ${corrections.map((c) => c.id).join(", ")}.`);
    }

    const signature = {
      signed,
      score,
      verdict: verdictBand.name,
      accountabilityNote: String(candidate.accountabilityNote ?? ""),
      refusalReason: signed ? null : refusalReason,
      corrections,
    };

    /* ── the one row s11 writes ──────────────────────────────────────── */

    // `leader_score` is the Leader's OWN number, before the ladder; `final_score`
    // is the corrected one and `s12` carries it on the intent. Two score columns
    // with no stated relationship is how two numbers for one thing starts, and
    // the projector asserts final <= leader — which the downward-only ladder
    // above is what makes true.
    const wrote = store.recordSignoff(missionId, { signed, score: leaderScore, verdict: verdictBand.name }, now());
    if (wrote !== true) {
      throw fail("input_invalid", zh
        ? `没有可写入签署的 missions 行（mission ${missionId}）。s12 会据此认为 s11 从未运行。`
        : `there is no missions row to write the signature to (mission ${missionId}). s12 would read that as s11 never having run.`);
    }

    const degraded = notes.length > 0;
    return {
      output: { signature, foreword, leaderScore, corrections: corrections.length },
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens: Math.max(0, Math.round(tokens)),
      crossPatch: {
        foreword,
        signature,
        // APPEND-ONLY, and the whole array, because `crossPatch` is a shallow
        // merge: read, spread, push, return the lot. The synthetic corrections
        // go here so the Leader meets its own corrections in its own history.
        leaderDecisions: [...arrayOf(crossState?.leaderDecisions), ...corrections],
      },
    };
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   s12 · persist
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The seven independent anti-fake-completion checks, as a pure function.
 *
 * Revision 1 named this check four times and specified it zero times, which is
 * exactly how a check that passes while the thing is broken gets built. Every
 * violation is fatal and drives `quality-failed` — never `completed`, never
 * degraded-and-carry-on.
 *
 * `wordFloor` is REQUIRED rather than derived. A guard that cannot compute one
 * of its seven checks refuses to run rather than silently skipping it: skipping
 * violation 1 is precisely the case the check exists for.
 *
 * @param artifact - the record about to be written: `{markdown, sections, citations, wordCount}`.
 * @param scorecard - `s9`'s scorecard.
 * @param tier - the depth tier, for the message.
 * @param options - `{chapters, wordFloor}`.
 * @returns `{ok, violations}` — each violation is `{code, detail}`.
 */
/**
 * Words a chapter can honestly carry per verified finding.
 *
 * Measured, not chosen: a real mission wrote 1,008 words from 11 verified
 * findings — 92 words each — and that is what the writer produces when it has
 * something to say and nothing to pad with. The multiple below is generous
 * against that, because analysis around a fact is legitimate length, but it is
 * anchored to a number a run actually produced.
 */
const WORDS_PER_VERIFIED_FINDING = 250;

/** The floor below which a report is too short whatever its evidence. */
const ABSOLUTE_WORD_FLOOR = 400;

/**
 * The word floor this report is actually judged against.
 *
 * The tier's number is a SEED, not the operative floor. §1 of the design says
 * so and the evidence floor already works that way — `derivedFloor` is computed
 * from measured supply after `s3`. The word floor was left as the constant, and
 * a real mission then failed for being "1,008 words against a standard floor of
 * 9,000" while holding 11 verified findings. Eleven findings cannot honestly
 * carry nine thousand words; demanding it asks the writer to pad, and a padded
 * report that passes is worse than a short one that fails.
 *
 * So the operative floor is whichever is SMALLER: what the tier asked for, or
 * what the evidence can carry. A report that is short because it found little
 * is reported as thin evidence, which is true and actionable; a report that is
 * short while sitting on plenty is reported as a writing failure, which is also
 * true. Collapsing both into the tier constant said the second when it meant
 * the first.
 *
 * @param tierFloor - the tier's seed value.
 * @param verifiedCount - verified findings actually collected.
 * @returns `{floor, source}` — `source` names which of the two bound it.
 */
export function operativeWordFloor(tierFloor, verifiedCount) {
  const seed = Number(tierFloor) > 0 ? Number(tierFloor) : 0;
  const supported = Math.max(ABSOLUTE_WORD_FLOOR, Number(verifiedCount ?? 0) * WORDS_PER_VERIFIED_FINDING);
  if (seed <= 0) return { floor: supported, source: "evidence" };
  return supported < seed
    ? { floor: supported, source: "evidence" }
    : { floor: seed, source: "tier" };
}

export function contentGuard(artifact, scorecard, tier, { chapters = [], wordFloor, verifiedCount = null } = {}) {
  let floor = Number(wordFloor);
  if (!Number.isFinite(floor) || floor <= 0) {
    throw new Error("contentGuard: pass wordFloor — this tier's word floor, resolved once at s1. Without it the word-count violation cannot be evaluated, and a guard that silently skips one of its seven checks is the failure it exists to catch.");
  }

  const violations = [];
  const markdown = String(artifact?.markdown ?? "");
  const wordCount = Number(artifact?.wordCount ?? wordsOf(markdown));
  const rows = arrayOf(chapters);
  const citations = arrayOf(artifact?.citations);

  // 1. Half the promised length is not a short report, it is a broken one.
  const tierFloor = floor;
  const resolved = verifiedCount === null
    ? { floor, source: "tier" }
    : operativeWordFloor(floor, verifiedCount);
  floor = resolved.floor;
  const floorSource = resolved.source;
  const minWords = Math.floor(floor * CONTENT_GUARD_WORD_FRACTION);
  if (wordCount < minWords) {
    violations.push({
      code: "word-count",
      // Names the bound. "Against a standard floor of 9000" sent a reader to
      // the writer when the answer was that eleven findings had been collected.
      detail: floorSource === "evidence"
        ? `${wordCount} words against ${floor}, which is what ${verifiedCount} verified finding(s) can carry — the ${tier} tier asked for ${tierFloor}. The shortfall is evidence, not writing.`
        : `${wordCount} words against the ${tier} floor of ${floor}; the guard refuses anything under ${minWords}.`,
    });
  }

  // 2. The assembly succeeded over a hole.
  //
  // Both halves are needed. A null body is the obvious case; the one that got
  // through is a body that is ONLY its citation manifest — `s8` appends
  // `<!-- mission-citations: … -->` to every chapter, so a chapter with no prose
  // at all still has a body that is a non-empty string. The assembled section's
  // own word count is what actually says whether anything was written.
  const hollow = new Set(rows
    .filter((row) => typeof row?.body !== "string" || row.body.trim() === "")
    .map((row) => String(row.heading ?? chapterKey(row.dimensionId, row.chapterIndex))));
  for (const section of arrayOf(artifact?.sections)) {
    if (Number(section?.wordCount ?? 0) <= 0) hollow.add(String(section?.heading ?? "(untitled)"));
  }
  if (hollow.size > 0) {
    violations.push({ code: "empty-chapter", detail: `${hollow.size} chapters have no body: ${[...hollow].join(", ")}.` });
  }

  // 3. Every escape hatch fired; nothing was actually written.
  if (rows.length > 0) {
    const under = rows.filter((row) => row?.underDelivered === true).length;
    if (under > rows.length * CONTENT_GUARD_UNDER_DELIVERED_SHARE) {
      violations.push({ code: "under-delivered", detail: `${under} of ${rows.length} chapters are under-delivered, over the one third the guard allows.` });
    }
  }

  // 4. A report with no citations.
  if (citations.length === 0) {
    violations.push({ code: "no-citations", detail: "the report carries no citations." });
  }

  // 5. Offset drift, which is silent and catastrophic.
  const offsets = checkSectionOffsets(markdown, artifact?.sections);
  if (!offsets.ok) {
    violations.push({ code: "section-offsets", detail: `${offsets.broken.length} section offsets do not resolve against the markdown: ${offsets.broken.map((row) => `${row.heading || "(untitled)"} ${row.reason}`).join("; ")}.` });
  }

  // 6. A writer placeholder that survived into the delivered document.
  const found = PLACEHOLDER_MARKERS.filter((marker) => (marker === "TK"
    // A standalone token only, so "TKinter" and "ATK" do not fire it.
    ? /(^|[^A-Za-z0-9])TK([^A-Za-z0-9]|$)/u.test(markdown)
    : markdown.includes(marker)));
  if (found.length > 0) {
    violations.push({ code: "placeholder", detail: `the delivered markdown still contains ${found.join(", ")}.` });
  }

  // 7. Zero citations is a violation, not a ratio. `verified/total` at 0/0 is
  //    NaN or, worse, reads as "no failures" — a mission with nothing checked
  //    presenting as fully verified to the one decision the pipeline converges
  //    on.
  if (Number(scorecard?.total ?? 0) === 0) {
    violations.push({ code: "scorecard-empty", detail: "the scorecard counted zero citations, so nothing in this report was verified. That is a violation, not a clean ratio." });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Which trigger this artefact version was written under.
 *
 * Read from the frozen config's own mutation reason rather than inferred from
 * `run_count`: a rerun and a boot recovery both produce a second generation and
 * they are different things to a reader comparing versions.
 */
function triggerFor(store, missionId, runCount) {
  const reason = store.latestConfig(missionId)?.mutationReason ?? null;
  if (reason === "rerun-fresh") return "rerun-fresh";
  if (reason === "rerun-incremental") return "rerun-incremental";
  if (reason === "stage-rerun") return "recovered";
  return runCount > 1 ? "recovered" : "initial";
}

/**
 * The frozen evidence blob.
 *
 * What lets version 1 stay checkable after version 2 is written: the live
 * `mission_findings` and `mission_documents` rows move on, and an artefact with
 * no provenance is a report nobody can check later.
 *
 * The document TEXT is deliberately not copied. The content hash, the fetch
 * stamp and the span index are what a later reader needs in order to tell
 * whether the page still says what it said, and copying tens of thousands of
 * words per version would turn the artefact table into a second corpus.
 */
function freezeEvidence(store, missionId, runCount) {
  const findings = store.verifiedFindings(missionId, { runCount });
  const documents = new Map();
  return findings.map((finding) => {
    let document = null;
    if (typeof finding.documentId === "string" && finding.documentId !== "") {
      if (!documents.has(finding.documentId)) documents.set(finding.documentId, store.getDocument(finding.documentId) ?? null);
      document = documents.get(finding.documentId);
    }
    return {
      findingId: finding.id,
      dimensionId: finding.dimensionId,
      claim: finding.claim,
      quote: finding.evidence,
      sourceUrl: finding.sourceUrl,
      sourceHost: finding.sourceHost,
      sourceTitle: finding.sourceTitle,
      verifyState: finding.verifyState,
      documentId: finding.documentId,
      spanIndex: finding.spanIndex,
      contentHash: document?.contentHash ?? null,
      fetchedAt: document?.fetchedAt ?? null,
      status: document?.status ?? null,
      charCount: document?.charCount ?? null,
    };
  });
}

/**
 * Stage twelve: the content guard, the one artefact write, and the intent.
 *
 * No agent and no model call. It does NOT call `finalize`: the runtime calls it
 * with origin `s12-persist` from the intent this returns, so the terminal write
 * stays arbitrated and everything hanging off `onWon` still runs.
 * @param deps - `{store, logger}`.
 * @returns the `s12-persist` handler.
 */
export function createS12Persist(deps) {
  const wired = requireDeps(deps, "createS12Persist");
  const { store, logger } = wired;

  return async function s12Persist(context) {
    const { missionId, runCount, mission, tier, stage, crossState, now, emit } = context;
    const zh = zhOf(mission);
    const { policy, hydrated } = tierPolicyOf(crossState, tier, zh);

    const chapterRows = store.listChapters(missionId, runCount);
    const report = assemble(chapterRows);
    const scorecard = crossState?.scorecard
      ?? { evidenced: emptyTally(), interpretive: emptyTally(), unplaced: emptyTally(), total: 0 };
    const signature = crossState?.signature ?? null;
    const trigger = triggerFor(store, missionId, runCount);
    const title = String(crossState?.report?.title ?? mission.topic ?? missionId);
    const evidence = freezeEvidence(store, missionId, runCount);

    /* ── the guard, BEFORE the write ─────────────────────────────────── */

    const artifact = {
      markdown: report.markdown,
      sections: report.sections,
      citations: report.citations,
      wordCount: report.wordCount,
    };
    const guard = contentGuard(artifact, scorecard, tier, {
      chapters: chapterRows,
      wordFloor: policy.wordFloor,
      // The supply the report was actually written from. Without it the guard
      // judges every mission against the tier constant, which is the bug this
      // parameter exists to close.
      verifiedCount: store.countVerified(missionId, null, runCount),
    });

    if (!guard.ok) {
      // One emit, one transaction, and `gate:hard-warning` because that is what
      // this is: a hard gate firing. Every violation rides in the payload so
      // "the guard fired, and on what" is countable across missions instead of
      // anecdotal. Inventing a `contentGuard:violation` type would throw inside
      // `#appendEventRow` and roll back whatever else that transaction held.
      emit("gate:hard-warning", {
        gate: "content-guard",
        stepId: stage.id,
        violations: guard.violations,
        wordCount: artifact.wordCount,
        citations: artifact.citations.length,
        scorecardTotal: Number(scorecard.total ?? 0),
      });
    }

    const violated = guard.violations.length > 0;
    const signedOff = signature !== null && signature.signed === true;
    // Degraded whenever the guard fired or the report was not signed, so the
    // partial report is still written and still readable. A mission that dies
    // before this stage has no artefact row at all, and `latestArtifact` then
    // reports `write-failed` on a terminal mission — which is correct, because
    // the write genuinely did not happen.
    const degradedArtifact = violated || !signedOff;

    let version = null;
    let writeError = null;
    try {
      version = store.putArtifact({
        missionId,
        runCount,
        trigger,
        title,
        markdown: artifact.markdown,
        sections: artifact.sections,
        citations: artifact.citations,
        evidence,
        quality: scorecard,
        wordCount: artifact.wordCount,
        degraded: degradedArtifact,
        at: now(),
      });
    } catch (cause) {
      // Reported, never swallowed. A persist stage that returns `completed` over
      // a failed artefact write is the fake completion this stage exists to
      // prevent, so the failure travels into the terminal intent below.
      writeError = String(cause?.message ?? cause);
      logger?.warn?.(`mission ${missionId} s12-persist: the artefact write failed: ${writeError}`);
    }

    /* ── the terminal intent. No defaults anywhere. ──────────────────── */

    const violationText = guard.violations.map((row) => `${row.code}: ${row.detail}`).join(" ");
    let intent;

    if (signature === null) {
      intent = {
        status: "failed",
        failureCode: "stage_contract_violation",
        errorMessage: "s11 wrote no signature into crossState.signature; the mission is not complete and will not be reported as such.",
        leaderSigned: null,
        finalScore: null,
        detail: { violations: guard.violations, artifactVersion: version, writeError },
      };
    } else if (violated || signature.signed === false) {
      intent = {
        status: "quality-failed",
        // Not `no_evidence`. This report may have plenty of evidence and was
        // declined on other grounds; reusing the evidence code would put a lie
        // in the one column §5.5 exists to make learnable.
        failureCode: "quality_refused",
        errorMessage: violated
          ? (zh ? `内容守卫拒绝了这份报告：${violationText}` : `the content guard refused this report: ${violationText}`)
          : String(signature.refusalReason ?? (zh ? "Leader 读过报告后拒绝签署。" : "the Leader read the report and declined to sign.")),
        leaderSigned: signature.signed ?? null,
        finalScore: signature.score ?? null,
        detail: { violations: guard.violations, artifactVersion: version, writeError },
      };
    } else if (writeError !== null) {
      intent = {
        status: "failed",
        failureCode: "runtime_crashed",
        errorMessage: `the report passed every check and the artefact write failed: ${writeError}`,
        leaderSigned: true,
        finalScore: signature.score ?? null,
        detail: { violations: [], artifactVersion: null, writeError },
      };
    } else {
      intent = {
        status: "completed",
        failureCode: null,
        // The score AFTER the forced-unsign ladder. `leader_score` on the row is
        // the Leader's own pre-correction number, and the projector asserts this
        // one never exceeds it.
        finalScore: signature.score ?? null,
        leaderSigned: true,
        detail: { violations: [], artifactVersion: version, writeError: null },
      };
    }

    const notes = [];
    if (violated) {
      notes.push(zh
        ? `内容守卫触发 ${guard.violations.length} 项：${guard.violations.map((row) => row.code).join("、")}。`
        : `the content guard fired ${guard.violations.length} times: ${guard.violations.map((row) => row.code).join(", ")}.`);
    }
    if (signature === null) {
      notes.push(zh ? "crossState.signature 缺失，s11 从未写入签署。" : "crossState.signature is absent; s11 never wrote a signature.");
    } else if (signature.signed === false) {
      notes.push(zh ? `Leader 拒签：${signature.refusalReason ?? "未给出理由"}。` : `the Leader refused to sign: ${signature.refusalReason ?? "no reason given"}.`);
    }
    if (writeError !== null) {
      notes.push(zh ? `产物写入失败：${writeError}` : `the artefact write failed: ${writeError}`);
    }
    if (hydrated) {
      notes.push(zh
        ? "crossState.tierPolicy 缺失，内容守卫读取了 s1 所用的同一张分级表。"
        : "crossState.tierPolicy was absent, so the content guard read the same tier table s1 resolves from.");
    }

    const degraded = notes.length > 0;
    return {
      output: {
        version,
        trigger,
        wordCount: artifact.wordCount,
        citations: artifact.citations.length,
        violations: guard.violations,
        status: intent.status,
      },
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens: 0,
      crossPatch: {
        terminal: {
          status: intent.status,
          failureCode: intent.failureCode,
          violations: guard.violations,
          artifactVersion: version,
        },
      },
      terminalIntent: intent,
    };
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   the four, keyed by stage id
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The back half of the pipeline, ready to spread into `createMissionHandlers`.
 *
 * One factory and one naming convention, so the wiring file cannot key a handler
 * under a name the runtime does not dispatch: these four keys are `STAGE_IDS`
 * members and nothing else.
 * @param deps - `{store, sourceStore, chat, circuit, cache, spillDir, config, ctx, logger}`.
 * @returns `{"s9-verify", "s10-critique", "s11-signoff", "s12-persist"}`.
 */
export function createBackStages(deps) {
  return {
    "s9-verify": createS9Verify(deps),
    "s10-critique": createS10Critique(deps),
    "s11-signoff": createS11Signoff(deps),
    "s12-persist": createS12Persist(deps),
  };
}
