/**
 * The middle four stages: reconcile, synthesize, outline, write.
 *
 * These are the stages between "we collected evidence" and "there is a report",
 * and the one that decides whether the report means anything is `s5`. Its name
 * is the least descriptive in the pipeline: the Reconciler is not a
 * fact-checker and not a summariser, it is the accounting node between N
 * independent researcher streams and everything downstream (design §3.4). It
 * exists because parallel dimension research has four failure modes nobody
 * downstream would otherwise catch — fact conflicts, numeric contradictions,
 * non-MECE overlap, and gaps every dimension assumed somebody else covered.
 *
 * THE EVIDENCE BOUNDARY IS IN THIS FILE, and it is one line: `s5` reads
 * `store.verifiedFindings()` and nothing else out of `mission_findings`.
 * Revision 1 of the design drew the boundary at `s3` and nowhere after it, so a
 * finding whose quote failed verification still earned a fact, an allocation to
 * a chapter and a citation — only the chapter COUNT was bounded by verified
 * supply, the chapter CONTENT came from everything, and every number in the tab
 * stayed green. The unfiltered finding reader appearing anywhere in this file
 * is that defect coming back, and the boundary test greps for its name.
 *
 * A mission with zero verified findings does not quietly write a report here.
 * It emits `evidence:none` carrying the collection census — every failing
 * query, every host tried, every tool refusal — and throws `no_evidence`, which
 * the runtime turns into `quality-failed` rather than `failed`. "We looked and
 * found nothing verifiable" is a useful and cheap answer; a bare failure throws
 * that answer away, and a nine-thousand-word essay dressed as one is worse than
 * both.
 *
 * EVERY GATE IS IN CODE. The phase −1 spike settled this and the measurement is
 * not ambiguous: the same topic produced six fetched pages and six findings on
 * one run, then two searches and a `finish` on the next, with no prompt change
 * between them. A prompt does not hold a loop. So every rule below is a refusal
 * handed back to the model as a targeted critique through the finalize gate,
 * refused a bounded number of times, and then RELEASED in code with the
 * correction applied and the correction named — never a deadlock, never a
 * silent pass. The shape is always: check in code → critique the model →
 * bounded rejects → code fixes it and says so in `degradeNote`.
 *
 * Two things in here are shared, and each is exported for exactly one reason:
 *
 *   `assemble(chapterRows)`  — the ONE assembly function. `s9` and `s12` both
 *      call it rather than reading a second copy of the markdown, because the
 *      assembled document is deterministic from the chapter rows, and a 25,000
 *      word deep report living in `crossState` is that document written into
 *      the checkpoint twelve times, on the connection the mission runs on.
 *   `planChapters(input)` — the deterministic outline planner. `quick` skips
 *      `s7`, so `s8` calls this itself; both paths reach `mission_chapters`
 *      through the same code. A cheap tier that reaches a terminal state by a
 *      path the expensive tiers never take is a tier whose test results mean
 *      nothing.
 *
 * @see design §2 (the evidence boundary), §3.4 (the Reconciler), §3.5 (the
 *   chapter loop), §3.7 (the finalize gate), §4.5, §4.6.
 */

import { createHash } from "node:crypto";

import { CHAPTER_DECISIONS, SECTION_TYPES } from "./mission-store.js";
// ONE prompt loader for all twelve stages. See `systemFor` below for what the
// second, incompatible copy of this dependency actually cost.
// `WORDS_PER_VERIFIED_FINDING` lives beside the tier table because the table's
// `findingTarget` is derived through it; the operative floor reads the same
// constant so a tier's promise and the evidence it plans for cannot disagree.
import { loadRolePrompt, WORDS_PER_VERIFIED_FINDING } from "./mission-stages-front.js";
// Reached through ONE accessor, never as `ctx.tokenMeter`: a Cordis context
// throws on an uninjected service, so the direct read here had the same
// unreachable-fallback bug that killed the first real run at s2-plan.
import { tokenMeterOf } from "./mission-agent.js";

/* ── constants that are policy, not magic ──────────────────────────────── */

/** Character shingle width for the overlap pass. */
const SHINGLE_K = 5;

/** At or above this computed Jaccard, two facts overlap and code says so. */
const OVERLAP_HIGH = 0.75;

/** Below this, two facts are unrelated and the model is never asked about them. */
const OVERLAP_LOW = 0.45;

/**
 * How many facts the O(n²) overlap pass will walk.
 *
 * One process, one heap, one event loop — and the pacers that hold arXiv to one
 * request every four seconds live on it. Three hundred facts is 44,850 pairs of
 * pre-computed shingle sets, which is milliseconds; three thousand is not, and
 * a blocked loop is a blocked pacer for the whole mission.
 */
const MAX_OVERLAP_FACTS = 300;

/** How many overlap pairs are carried in `crossState`, highest score first. */
const MAX_OVERLAP_PAIRS = 60;

/** The unresolved-conflict share `check()` refuses (design §3.4). */
const MAX_UNRESOLVED_SHARE = 0.30;

/**
 * Below this many conflicts the unresolved SHARE measures nothing.
 *
 * One flagged-unresolved conflict out of one is 100% and out of two is 50%; a
 * gate keyed on the ratio down there refuses the honest answer, which is the
 * failure every gate in this file exists to avoid.
 */
const MIN_CONFLICTS_FOR_SHARE = 4;

/** Every value a Reconciler conflict's `resolution` may hold (design §3.4). */
const CONFLICT_RESOLUTIONS = Object.freeze(["kept-both", "preferred-one", "flagged-unresolved"]);

/** Every value a gap's `severity` may hold. `critical` is what `s11`'s G6 reads. */
const GAP_SEVERITIES = Object.freeze(["low", "medium", "critical"]);

/** Every value a hypothesis's `likelihood` may hold. */
const LIKELIHOODS = Object.freeze(["low", "medium", "high"]);

/** Writer attempts per chapter. `attempt < 2`, from the reference's loop. */
const CHAPTER_ATTEMPTS = 2;

/** The landing threshold by attempt: 60 → 50 → 40, floor 40 (design §3.5). */
const SCORE_THRESHOLDS = Object.freeze([60, 50, 40]);

/** A reviewer that failed twice in a row on one chapter is exhausted. */
const REVIEWER_FAIL_LIMIT = 2;

/** Two consecutive rewrites this similar are the same draft. */
const STUCK_JACCARD = 0.9;

/** How many times `stuck` must fire before the chapter lands as it stands. */
const STUCK_REPEATS = 2;

/** The score a failed reviewer is synthesised at. NEVER a pass (design §3.5). */
const REVIEWER_FAILURE_SCORE = 40;

/**
 * The floor under a chapter's delivery target, in words.
 *
 * `minDelivery` is the tier word floor divided by the chapter count, and that
 * division can land somewhere no chapter is worth writing at. This is the
 * bottom of it, applied in the one place the number is computed.
 */
const MIN_CHAPTER_WORDS = 250;

/** Words the front-matter chapter of a `quick` report is held to. */
const MIN_ABSTRACT_WORDS = 120;

/** Where a chapter's machine-readable citation manifest starts. */
const MANIFEST_OPEN = "<!-- mission-citations: ";

/** How a chapter's machine-readable citation manifest ends. */
const MANIFEST_CLOSE = " -->";

/** Finds the manifest at the end of a stored chapter body. */
const MANIFEST_RE = /\n*<!-- mission-citations: (.*?) -->\s*$/su;

/** An inline `[N]` citation marker in chapter prose. */
const MARKER_RE = /\[(\d{1,3})\]/gu;

/** CJK codepoints, for the word count and for nothing else. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/gu;

/** Characters of one quote handed to a model at the widest shrink rung. */
const QUOTE_CHARS = 600;

/* ── small shared helpers ──────────────────────────────────────────────── */

/**
 * Count the words of a report, in a way that survives Chinese.
 *
 * The default mission language is `zh`, and a Chinese chapter contains almost
 * no whitespace: counted the obvious way, a 3,000-character chapter measures
 * about forty "words", every chapter reads as under-delivered, the delivery
 * gate fires on every mission and `contentGuard` refuses every report. CJK
 * codepoints count one each and Latin runs count one each, which is the
 * convention the tier word floors were written against.
 * @param text - the prose.
 * @returns a non-negative integer.
 */
export function countWords(text) {
  const source = typeof text === "string" ? text : "";
  const cjk = source.match(CJK_RE)?.length ?? 0;
  const latin = source.replace(CJK_RE, " ").match(/[A-Za-z0-9][A-Za-z0-9'’_-]*/gu)?.length ?? 0;
  return cjk + latin;
}

/** Hex sha256 of a string. */
function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/** Trim, collapse whitespace, lowercase — the form two spellings of one name share. */
function normalisePart(text) {
  return String(text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * The deterministic id of one fact.
 *
 * Minted in code from the normalised `entity|attribute`, never taken from the
 * model, because it is also the deduplication key: an id and a key that can
 * disagree is a fact table holding two rows the uniqueness check believes are
 * one. There is no `mission_facts` table and therefore no `UNIQUE(mission_id,
 * entity, attribute)` to lean on, so this pair — the minted id, and the Map
 * keyed the same way — IS that constraint.
 * @param entity - the subject.
 * @param attribute - what is being said about it.
 * @returns `fact-<16 hex>`.
 */
export function factIdFor(entity, attribute) {
  return `fact-${sha256Hex(`${normalisePart(entity)}|${normalisePart(attribute)}`).slice(0, 16)}`;
}

/** The deterministic id of one conflict, from the facts it stands between. */
function conflictIdFor(factIds) {
  return `conflict-${sha256Hex([...factIds].sort().join("|")).slice(0, 16)}`;
}

/** The deterministic id of one forecast, from its statement. */
function forecastIdFor(statement) {
  return `forecast-${sha256Hex(normalisePart(statement)).slice(0, 12)}`;
}

/** Character shingles of a text, as a Set. Empty text yields an empty set. */
function shinglesOf(text, k = SHINGLE_K) {
  const flat = normalisePart(text);
  const out = new Set();
  if (flat.length === 0) return out;
  if (flat.length <= k) {
    out.add(flat);
    return out;
  }
  for (let i = 0; i + k <= flat.length; i += 1) out.add(flat.slice(i, i + k));
  return out;
}

/**
 * Jaccard similarity of two shingle sets.
 *
 * The design specified embedding cosine and the reference shipped "estimate
 * 0–1, judge by reading", which is a number the model invented. In one process
 * every claim is already in one heap, so this is plain JS and milliseconds, and
 * `similarityScore` becomes a measurement instead.
 * @param a - a Set of shingles.
 * @param b - a Set of shingles.
 * @returns 0..1; 0 when either side is empty.
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Similarity of two texts, for the stuck-draft check and the nearest-chapter fallback. */
function textSimilarity(a, b) {
  return jaccard(shinglesOf(a), shinglesOf(b));
}

/** Whatever it was, as an array. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Whatever it was, as a trimmed string. */
function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** A non-negative integer, or zero. */
function intOr0(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Head-preserving truncation with the cut marked, so nothing incomplete looks complete. */
function compact(text, limit) {
  const source = asText(text);
  return source.length <= limit ? source : `${source.slice(0, limit)}…`;
}

/** One user message in the shape the adapter expects. */
function userMessage(id, text) {
  return { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

/** A titled block of an input document. */
function block(title, body) {
  return `## ${title}\n${body}\n`;
}

/** `true` when the mission speaks Chinese, which is the default. */
function isZh(mission) {
  return String(mission?.language ?? "zh") !== "en";
}

/** An error the runtime will classify as this code rather than as a dead provider. */
function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Estimate the tokens of an input document.
 *
 * `ctx.tokenMeter` is the honest meter and is used when the host provides one.
 * The fallback is `length / 4`, the same accumulator the spike measured its
 * streams with — an estimate, and named as one, because the usage chunk arrives
 * ONCE at the end of a call and `SUM(mission_spend)` is the only exact number
 * in the system.
 * @param deps - the handler dependencies, for `ctx`.
 * @param text - the document.
 * @returns an estimated token count.
 */
function estimateTokens(deps, text) {
  const meter = tokenMeterOf(deps?.ctx);
  if (meter && typeof meter.estimateMessage === "function") {
    const estimate = meter.estimateMessage(userMessage("estimate", String(text)));
    if (Number.isFinite(estimate)) return Math.round(estimate);
  }
  return Math.ceil(String(text).length / 4);
}

/**
 * Walk a stage's own shrink ladder until the input fits, and name the rung.
 *
 * The generic half of §8.5 — re-asking at a smaller output cap — belongs to the
 * agent seam. This is the half only the stage can do: `stage.shrinkLadder`
 * names CONTENT transformations ("drop quotes, keep claim + source"), and
 * nothing outside the stage knows what a quote is. The rung is returned rather
 * than logged, because "which rung was this written at" is the first question a
 * thin report raises.
 * @param deps - the handler dependencies.
 * @param stage - the frozen stage declaration; `inputBudgetTokens` and `shrinkLadder` are read from it, never from a local constant.
 * @param build - `(rung) => string`, rung 0 being the unshrunk document.
 * @returns `{text, rung, rungName, tokens, over}`; `over` is true when even the last rung did not fit.
 */
function fitInput(deps, stage, build) {
  const ladder = asArray(stage.shrinkLadder);
  const cap = intOr0(stage.inputBudgetTokens);
  let last = null;
  for (let rung = 0; rung <= ladder.length; rung += 1) {
    const text = build(rung);
    const tokens = estimateTokens(deps, text);
    last = { text, rung, rungName: rung === 0 ? null : ladder[rung - 1], tokens, over: cap > 0 && tokens > cap };
    if (cap === 0 || tokens <= cap) return last;
  }
  return last;
}

/* ── the agent seam, used the one way ──────────────────────────────────── */

/**
 * The system document for one agent call: the role's soul plus this duty.
 *
 * ONE loader, `loadRolePrompt`, shared with `mission-stages-front.js` and
 * `mission-stages-back.js`. This function used to read `deps.prompts.system`
 * and call it as `load({agent, duty, bindings})` while the other two stage
 * modules read `deps.prompts` as `(role, duty) => text` — three modules, two
 * incompatible contracts for one dependency, and nothing wired either. The
 * measured consequence was not a crash: `deps.prompts.system` was never a
 * function, so this returned `null` and s5, s6, s7 and s8 called the model with
 * an EMPTY system document. The Reconciler, the Analyst, the Writer and the
 * Reviewer ran with no role, no method and no refusals, and every one of them
 * still returned schema-valid output, so nothing downstream could see it.
 *
 * `bindings` is deliberately not passed to the loader. §3.1: the duty owns
 * every number and every shape, and it owns them through the rendered INPUT and
 * the injected finalize schema — never through a second copy interpolated into
 * the system text, which is the drift that section exists to prevent.
 *
 * @param deps - the handler dependencies; `deps.prompts` overrides the loader.
 * @param agent - the role.
 * @param duty - the duty name inside that role's SKILL.md.
 * @returns the system text.
 */
function systemFor(deps, agent, duty) {
  const load = typeof deps?.prompts === "function" ? deps.prompts : loadRolePrompt;
  return load(agent, duty);
}

/**
 * Write the exact usage of one model call into the spend ledger.
 *
 * The live pool is an estimate and `SUM(mission_spend)` is exact, so this row
 * is the one that matters — but it must be written exactly once. When the seam
 * has already written it (it holds the usage chunk) it says so on the result,
 * and a second row here would double the number `estimateDrift` reconciles
 * against.
 *
 * `role` is the agent that actually ran, not `stage.agent`: two roles run
 * inside `s8`, and filing the Reviewer's tokens under `writer` makes
 * `spendByAgent` a lie in the one place per-role cost is visible.
 * @param deps - the handler dependencies, for `store`.
 * @param context - the stage context, for `missionId`, `stage` and `now`.
 * @param run - the agent run result.
 * @param agent - the role that ran.
 * @returns true when a row was written here, false when the seam had it.
 */
function recordSpend(deps, context, run, agent) {
  if (run?.spendRecorded === true) return false;
  const tokens = run?.tokens ?? {};
  deps.store.insertSpend({
    missionId: context.missionId,
    stepId: context.stage.id,
    role: agent,
    agentId: agent,
    promptTok: intOr0(tokens.prompt),
    completionTok: intOr0(tokens.completion),
    cacheReadTok: intOr0(tokens.cacheRead),
    estimatedTok: intOr0(tokens.estimated),
    calls: intOr0(run?.iterations) || 1,
    at: context.now(),
  });
  return true;
}

/**
 * Run one agent to completion through the one seam, and pay for it.
 *
 * Every stage in this file calls the model exactly this way. No stage inspects
 * a stream chunk, accumulates a delta or builds a tool-result message; if this
 * file ever names one of the seam's chunk types, the file is wrong.
 *
 * `finalize` is a declared tool whose `parameters` IS the output schema, so the
 * provider enforces the shape before we see it, and `check` runs after that as
 * the business gate. A finalize call is not a termination — the seam critiques
 * and re-asks, cumulatively, and force-accepts as `degraded` at the cap.
 * @param deps - the handler dependencies.
 * @param context - the stage context.
 * @param options - `{agent, duty, input, bindings, schema, check, description, messageKey}`.
 * @returns the seam's RunResult.
 */
async function callAgent(deps, context, options) {
  const { agent, duty, input, bindings, schema, check, description } = options;
  const { stage, missionId, runCount, mission, signal, budget, now } = context;
  const finalizeTool = { name: "finalize", description, parameters: schema };
  const spec = { name: `${agent}.${duty}`, schema, check };

  const run = await deps.chat({
    agent,
    stepId: stage.id,
    missionId,
    runCount,
    duty,
    system: systemFor(deps, agent, duty),
    // `language` and `now` are NOT optional decoration, and both were missing
    // here while `mission-stages-front.js` and `mission-stages-back.js` passed
    // them. The seam defaults `language` to "zh", so every diagnostic s5, s6,
    // s7 and s8 produced came back in Chinese on an English mission — the
    // force-accept note, the exit description and the recovery hint — while the
    // stages either side of them spoke English. It is visible in a stage strip
    // as four Chinese rows between eight English ones.
    //
    // `now` is the runtime's INJECTED clock. Without it the seam stamps its own
    // events from the wall clock, so an agent's event tail and the stage row
    // that contains it disagree about when the same run happened.
    language: mission.language,
    now,
    messages: [userMessage(`${stage.id}-${duty}-${runCount}-${options.messageKey ?? "0"}`, input)],
    // These four roles hold no tools at all (AGENT_GRANTS), and that is
    // enforced by the ACL rather than by the prompt. Handing them a catalogue
    // anyway is what burned 3–5k tokens per dimension in the reference
    // rendering ~30 tools that were never called.
    tools: [],
    toolContext: null,
    spec,
    bindings,
    // From the FROZEN declaration, never a local constant: the output cap is
    // stage policy, and a second copy of it is a number that will diverge from
    // the one §8.5 reasons about.
    maxTokens: stage.maxOutputTokens,
    signal,
    budget,
    circuit: deps.circuit ?? null,
    cache: deps.cache ?? null,
    spillDir: deps.spillDir ?? null,
    ledger: deps.ledger ?? null,
    finalizeTool,
    checkFinalize: check,
  });

  recordSpend(deps, context, run, agent);
  return run;
}

/**
 * Turn a failed agent run into the failure code that names what happened.
 *
 * A bare throw becomes `model_error` and tells the user to check a provider
 * that was never involved; the seam already classified this, so the code is
 * carried through rather than re-derived.
 * @param run - the seam's RunResult.
 * @throws when `run.state === "failed"`.
 */
function assertRun(run) {
  if (run?.state === "failed") throw fail(run.failureCode, run.diagnostic ?? `the agent run failed with ${run.exitReason ?? "no stated reason"}.`);
}

/** The total tokens of a run, for the stage's `tokens` field. */
function tokensOf(run) {
  return intOr0(run?.tokens?.total);
}

/* ── assembly: the one function s8, s9 and s12 all use ─────────────────── */

/**
 * Split a stored chapter body into prose and its citation manifest.
 *
 * `mission_chapters` has no citations column and this phase adds no migration,
 * so the resolved citations ride at the end of the body as one machine-readable
 * HTML comment written by CODE — never by the writer. A reader of `report.md`
 * sees clean prose with `[N]` markers; `s9` and `s12` get exact objects.
 * @param body - the stored body.
 * @returns `{prose, citations}`.
 * @throws `input_invalid` when a manifest is present but unreadable.
 */
function splitManifest(body) {
  const source = typeof body === "string" ? body : "";
  const match = MANIFEST_RE.exec(source);
  if (match === null) return { prose: source, citations: [] };
  let parsed = null;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    // Written by code and read by code: a manifest that will not parse means
    // the row was mutated between the two, and guessing past it would present
    // a chapter as uncited when it is not.
    throw fail("input_invalid", `a chapter's citation manifest is not readable JSON (${error.message}). It is written by code at s8; re-run s8-write for this generation rather than reading past it.`);
  }
  return { prose: source.slice(0, match.index), citations: asArray(parsed) };
}

/**
 * Attach a citation manifest to a chapter body.
 * @param prose - the chapter text, with `[N]` markers numbered within the chapter.
 * @param citations - `[{index, url, findingId, inlineQuote}]`, chapter-local indices.
 * @returns the body to store.
 */
function attachManifest(prose, citations) {
  // An empty chapter stays EMPTY. A body carrying only a manifest comment reads
  // as non-empty to `contentGuard`'s "the assembly succeeded over a hole"
  // check, which is the one check standing between a missing chapter and a
  // report that presents as complete.
  if (prose.trim() === "") return "";
  return `${prose.trim()}\n\n${MANIFEST_OPEN}${JSON.stringify(citations)}${MANIFEST_CLOSE}`;
}

/**
 * Assemble the report from its chapter rows. Deterministic, and the only
 * assembler in the pipeline.
 *
 * The model never stitches this. An 81k-character document regenerated by an
 * LLM gets truncated and the truncation is silent, and a generic reviewer put
 * in front of a pure assembly task scored it 53–58 against a 60 threshold and
 * failed five of eight dimensions. There is no judgement in assembly, so there
 * is no judge.
 *
 * Citations are renumbered into ONE report-global sequence here, which is why
 * `s9` and `s12` must both call this rather than each reading the chapter rows:
 * two independent numberings of one report is two different `[7]`s.
 *
 * Every section offset is asserted against the markdown it indexes. Offset
 * drift is silent and catastrophic, and `contentGuard` checks it again for the
 * same reason.
 * @param chapterRows - `store.listChapters(missionId, runCount)`, in report order.
 * @returns `{markdown, sections, citations, wordCount, unresolvedMarkers}`.
 * @throws `input_invalid` on a headingless chapter, an unreadable manifest, or an offset that does not resolve.
 */
export function assemble(chapterRows) {
  const rows = asArray(chapterRows);
  const sections = [];
  const citations = [];
  let markdown = "";
  let wordCount = 0;
  let unresolvedMarkers = 0;

  for (const row of rows) {
    const heading = asText(row?.heading);
    if (heading === "") {
      throw fail("input_invalid", `chapter ${row?.dimensionId ?? "?"}#${row?.chapterIndex ?? "?"} has no heading, so its section would be untitled and every offset after it unanchored. Re-run s7-outline for this generation.`);
    }
    const split = splitManifest(row?.body ?? "");
    const localToGlobal = new Map();
    for (const entry of split.citations) {
      const index = citations.length + 1;
      localToGlobal.set(Number(entry?.index), index);
      citations.push({
        index,
        url: asText(entry?.url),
        findingId: asText(entry?.findingId),
        inlineQuote: asText(entry?.inlineQuote),
        dimensionId: row.dimensionId,
        chapterIndex: row.chapterIndex,
        sectionType: row.sectionType,
      });
    }

    // A marker with nothing behind it is a citation that looks real and
    // resolves to nothing, which is worse than an uncited sentence.
    const prose = split.prose.replace(MARKER_RE, (whole, digits) => {
      const target = localToGlobal.get(Number(digits));
      if (target === undefined) {
        unresolvedMarkers += 1;
        return "";
      }
      return `[${target}]`;
    }).trim();

    const start = markdown.length;
    markdown += `## ${heading}\n\n${prose}\n\n`;
    const end = markdown.length;
    if (!markdown.slice(start, end).startsWith(`## ${heading}`)) {
      throw fail("input_invalid", `the section offset for "${heading}" does not resolve against the assembled markdown. Offset drift is silent and catastrophic; nothing downstream may use this document.`);
    }
    const chapterWords = countWords(prose);
    wordCount += chapterWords;
    sections.push({
      dimensionId: row.dimensionId,
      chapterIndex: row.chapterIndex,
      sectionType: row.sectionType,
      heading,
      start,
      end,
      wordCount: chapterWords,
      citationCount: split.citations.length,
    });
  }

  return { markdown, sections, citations, wordCount, unresolvedMarkers };
}

/* ── the outline planner, shared by s7 and by quick-tier s8 ────────────── */

/**
 * The ONE delivery number, computed once.
 *
 * The most portable lesson in the reference and the one it records twice:
 * every number that appears in a prompt must be the same variable the code
 * enforces. It is computed here, stored in `mission_chapters.min_delivery`, and
 * read from that column by the writer prompt, the reviewer's full-marks line,
 * the send-back gate and the final accounting. A second computation in `s8` is
 * the defect that produced chapters at exactly 728 words and then exactly 612.
 * @param wordFloor - the tier's whole-report SEED, not its operative floor.
 * @param chapterCount - how many chapters the report has.
 * @param verifiedCount - verified findings the report is written from.
 * @returns the per-chapter floor, in words.
 */
function deliveryFloor(wordFloor, chapterCount, verifiedCount) {
  // A CHAPTER'S SHARE OF THE SHORTEST REPORT THE GUARD WILL ACCEPT, which is
  // the only per-chapter number that cannot contradict the whole-report one.
  //
  // It used to be the tier seed divided by the chapter count, and that
  // disagreed with the content guard twice over. The guard scales the floor to
  // the evidence (`operativeWordFloor`) and then accepts half of it
  // (`CONTENT_GUARD_WORD_FRACTION`); this divided the unscaled seed at full
  // rate. A real run measured the gap at 4.8x: 42 verified findings, 7
  // chapters, 5,680 words. The whole-report check wanted 5,250 and passed it —
  // and the same guard then refused the same report because all 7 chapters were
  // under 3,571, a target adding up to a report 4.4x longer than the one it had
  // just accepted. Both numbers now come from one expression, so a report whose
  // chapters all hit their target is exactly a report at the total minimum.
  // `minimum` is character-for-character the guard's own expression, so the
  // share below is a share of the number the report is actually held to.
  const operative = operativeWordFloor(wordFloor, verifiedCount).floor;
  const minimum = Math.floor(operative * CONTENT_GUARD_WORD_FRACTION);
  // Rounded DOWN: rounding to nearest lets the targets sum past the total they
  // are a share of — at 9,000 across 7 chapters that is 4,501 demanded against
  // a 4,500 minimum, and the report that meets every chapter fails as a whole
  // by one word.
  return Math.max(MIN_CHAPTER_WORDS, Math.floor(minimum / Math.max(1, chapterCount)));
}

/** The floor below which a report is too short whatever its evidence. */
const ABSOLUTE_WORD_FLOOR = 400;

/**
 * The fraction of the word floor below which a report is not short, it is
 * broken.
 */
export const CONTENT_GUARD_WORD_FRACTION = 0.5;

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
 * It lives HERE, beside the per-chapter floor that divides it, because the two
 * were computed in different files from different inputs for exactly as long as
 * they were allowed to be. `contentGuard` imports it from here.
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

/**
 * Plan the chapters of a report deterministically, with no model call.
 *
 * `s7` is skipped at `quick`, so `s8` calls this itself and both tiers reach
 * `mission_chapters` through one code path. `s7` also falls back to it when the
 * Writer's outline cannot be used, so a broken outline degrades into a plain
 * report rather than into no report.
 *
 * Supply decides demand: `maxChapters` is `floor(uniqueVerifiedHosts / 2)`,
 * computed by the caller, and this planner never exceeds it. Opening more
 * chapters than the evidence can cite makes the reviewer's citation
 * requirement unsatisfiable and chapters then rewrite until wall-time.
 * @param input - `{dimensions, facts, insights, maxChapters, wordFloor, verifiedCount, language}`.
 * @returns `[{dimensionId, chapterIndex, heading, sectionType, minDelivery, factIds, brief}]`.
 */
export function planChapters(input) {
  const zh = String(input?.language ?? "zh") !== "en";
  const dimensions = asArray(input?.dimensions).filter((d) => asText(d?.dimensionId) !== "");
  const facts = asArray(input?.facts);
  const themes = asArray(input?.insights?.themes).filter((t) => asArray(t?.factIds).length > 0);
  const cap = Math.max(1, intOr0(input?.maxChapters));

  // Evidenced chapters first, best-supplied dimension first: when supply caps
  // the count, the chapters that survive are the ones with something to cite.
  const ordered = [...dimensions].sort((a, b) => intOr0(b?.verified) - intOr0(a?.verified));
  const chapters = [];
  for (const dimension of ordered) {
    if (chapters.length >= cap) break;
    chapters.push({
      dimensionId: dimension.dimensionId,
      chapterIndex: chapters.length,
      heading: asText(dimension.name) === "" ? dimension.dimensionId : asText(dimension.name),
      sectionType: "evidenced",
      factIds: [],
      brief: asText(dimension.rationale),
    });
  }
  // Interpretive chapters only in whatever room is left, and only when they can
  // name the facts they reason from (§1: an interpretive section with no fact
  // behind it is the most trusted unevidenced material in the report).
  for (const theme of themes) {
    if (chapters.length >= cap) break;
    const home = chapters.find((c) => asArray(theme.factIds).some((id) => factHomeOf(facts, id) === c.dimensionId))
      ?? chapters[0]
      ?? null;
    if (home === null) break;
    chapters.push({
      dimensionId: home.dimensionId,
      chapterIndex: chapters.length,
      heading: asText(theme.title) === "" ? (zh ? "综合解读" : "Interpretation") : asText(theme.title),
      sectionType: "interpretive",
      factIds: asArray(theme.factIds),
      brief: compact(theme.argument, 600),
    });
  }

  // `facts` is the supply reading for a caller that did not pass one: they are
  // what survived verification, the same quantity the guard counts. A planner
  // that fell back to the tier constant here would reopen the gap this
  // parameter closes.
  const minDelivery = deliveryFloor(input?.wordFloor, chapters.length, input?.verifiedCount ?? facts.length);
  for (const chapter of chapters) chapter.minDelivery = minDelivery;
  allocateFacts(chapters, facts);
  return chapters;
}

/** Which dimension a fact came from, or null. */
function factHomeOf(facts, factId) {
  const fact = facts.find((f) => f?.factId === factId);
  return asArray(fact?.dimensionIds)[0] ?? null;
}

/**
 * Assign every fact to exactly one chapter, in place.
 *
 * A partition, not a suggestion: a fact allocated twice is written twice and a
 * fact allocated nowhere is dropped from a report that collected it. Facts are
 * allocated BEFORE chapters are written so two chapters cannot both claim or
 * both drop one.
 * @param chapters - the planned chapters; their `factIds` are rewritten.
 * @param facts - `[{factId, entity, attribute, value, dimensionIds}]`.
 * @returns `{allocated, unallocated}` counts.
 */
function allocateFacts(chapters, facts) {
  if (chapters.length === 0) return { allocated: 0, unallocated: facts.length };
  const taken = new Set();
  for (const chapter of chapters) {
    chapter.factIds = asArray(chapter.factIds).filter((id) => {
      if (taken.has(id)) return false;
      if (!facts.some((f) => f?.factId === id)) return false;
      taken.add(id);
      return true;
    });
  }
  let allocated = taken.size;
  for (const fact of facts) {
    if (taken.has(fact?.factId)) continue;
    const home = asArray(fact?.dimensionIds);
    const byDimension = chapters.filter((c) => home.includes(c.dimensionId));
    const pool = byDimension.length > 0 ? byDimension : chapters;
    // Nearest by heading, so an unhomed fact lands where it reads rather than
    // in chapter one by default.
    const text = `${fact?.entity ?? ""} ${fact?.attribute ?? ""} ${fact?.value ?? ""}`;
    let best = pool[0];
    let bestScore = -1;
    for (const chapter of pool) {
      const score = textSimilarity(text, `${chapter.heading} ${chapter.brief ?? ""}`) + (byDimension.includes(chapter) ? 1 : 0) - chapter.factIds.length / 1000;
      if (score > bestScore) {
        bestScore = score;
        best = chapter;
      }
    }
    best.factIds.push(fact.factId);
    taken.add(fact.factId);
    allocated += 1;
  }
  return { allocated, unallocated: 0 };
}

/**
 * The tier policy `s1` resolved, or a refusal that names where it went.
 *
 * Never a default. A guessed word floor makes every delivery decision in `s7`,
 * `s8`, `s11` and `contentGuard` wrong in the same direction, and it makes them
 * wrong silently — which is precisely why `s1`'s G3 refuses to guess a context
 * window rather than picking a plausible number.
 * @param crossState - the accumulated bag.
 * @param mission - the shaped mission row, for the language of the refusal.
 * @returns `{dimensionTarget, wordFloor, verifiedRatioFloor, citationFloor}`.
 * @throws `input_invalid` when `s1` did not write one.
 */
function tierPolicyOf(crossState, mission) {
  const policy = crossState?.tierPolicy;
  if (!policy || intOr0(policy.wordFloor) <= 0) {
    const zh = isZh(mission);
    throw fail("input_invalid", zh
      ? "crossState.tierPolicy.wordFloor 缺失：本档位的字数下限由 s1-brief 解析一次，之后每个阶段都读它。这里不会猜一个数字——猜出来的下限会让 s7、s8、s11 和 contentGuard 全部朝同一个方向出错。请从 s1-brief 重新运行本任务。"
      : "crossState.tierPolicy.wordFloor is missing. The tier's word floor is resolved once by s1-brief and read by every later stage; nothing here will guess one, because a guessed floor makes s7, s8, s11 and contentGuard all wrong in the same direction. Re-run this mission from s1-brief.");
  }
  return policy;
}

/* ── s5-reconcile ──────────────────────────────────────────────────────── */

/** The Reconciler's output schema. It IS `finalize`'s `parameters`. */
const RECONCILE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["facts", "gaps"],
  properties: {
    facts: {
      type: "array",
      description: "one row per distinct entity+attribute; the value is what the evidence says it is",
      items: {
        type: "object",
        required: ["factId", "entity", "attribute", "value", "findingIds"],
        properties: {
          factId: { type: "string", description: "your own local id, used to reference this fact from conflicts and overlaps" },
          entity: { type: "string" },
          attribute: { type: "string" },
          value: { type: "string" },
          findingIds: { type: "array", items: { type: "string" }, description: "the finding ids this value is read from" },
        },
      },
    },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        required: ["factIds", "resolution", "rationale"],
        properties: {
          factIds: { type: "array", items: { type: "string" } },
          resolution: { type: "string", enum: [...CONFLICT_RESOLUTIONS] },
          preferredFactId: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
    overlaps: {
      type: "array",
      description: "your adjudication of the borderline pairs you were shown; the similarity number itself is computed, not yours",
      items: {
        type: "object",
        required: ["aFactId", "bFactId", "relation"],
        properties: {
          aFactId: { type: "string" },
          bFactId: { type: "string" },
          relation: { type: "string", enum: ["duplicate", "related", "distinct"] },
          note: { type: "string" },
        },
      },
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        required: ["dimensionId", "aspects", "severity"],
        properties: {
          dimensionId: { type: "string" },
          aspects: { type: "array", items: { type: "string" } },
          severity: { type: "string", enum: [...GAP_SEVERITIES] },
        },
      },
    },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        required: ["statement", "likelihood", "refutingEvidence"],
        properties: {
          statement: { type: "string" },
          likelihood: { type: "string", enum: [...LIKELIHOODS] },
          refutingEvidence: { type: "array", items: { type: "string" }, description: "what would have to be true for this to be wrong" },
        },
      },
    },
  },
});

/** The model's facts, with a usable local id whatever it sent. */
function readFacts(output) {
  return asArray(output?.facts).map((raw, index) => ({
    localId: asText(raw?.factId) === "" ? `m${index}` : asText(raw.factId),
    entity: asText(raw?.entity),
    attribute: asText(raw?.attribute),
    value: asText(raw?.value),
    findingIds: asArray(raw?.findingIds).map((id) => asText(id)).filter((id) => id !== ""),
  }));
}

/**
 * Every fact pair whose computed similarity is worth a word, highest first.
 *
 * The score is JS, never the model's. The model is only ever asked to
 * adjudicate the borderline band; everything at or above `OVERLAP_HIGH` is
 * recorded as an overlap by code whether it says so or not.
 * @param facts - `[{localId|factId, entity, attribute, value}]`.
 * @returns `{pairs, skipped}`; `skipped` is how many facts the pass refused to walk.
 */
function overlapPairs(facts) {
  const walked = facts.slice(0, MAX_OVERLAP_FACTS);
  const shingles = walked.map((f) => shinglesOf(`${f.entity} ${f.attribute} ${f.value}`));
  const pairs = [];
  for (let i = 0; i < walked.length; i += 1) {
    for (let j = i + 1; j < walked.length; j += 1) {
      const score = jaccard(shingles[i], shingles[j]);
      if (score < OVERLAP_LOW) continue;
      pairs.push({ a: walked[i], b: walked[j], similarityScore: Math.round(score * 1000) / 1000 });
    }
  }
  pairs.sort((x, y) => y.similarityScore - x.similarityScore);
  return { pairs, skipped: facts.length - walked.length };
}

/**
 * The Reconciler's business gate, run after the provider has enforced the shape.
 *
 * Every issue names the thing to change. The seam re-shows the whole cumulative
 * list each round, deliberately, so the model corrects rather than oscillates.
 * @param options - `{verifiedIds, dimensionIds, zh}`.
 * @returns `(output) => string[]`.
 */
function checkReconcile({ verifiedIds, dimensionIds, zh }) {
  return function check(output) {
    const issues = [];
    const facts = readFacts(output);

    if (facts.length === 0) {
      issues.push(zh
        ? "你没有产出任何事实。已核验的发现就在输入里，每一条都必须被某一个事实覆盖，或者在 gaps 里说明为什么不能。"
        : "you produced no facts. The verified findings are in the input; every one of them must be covered by a fact, or accounted for in gaps.");
    }

    const seen = new Set();
    for (const fact of facts) {
      if (fact.entity === "" || fact.attribute === "" || fact.value === "") {
        issues.push(zh
          ? `事实 ${fact.localId}：entity、attribute、value 三项都必须非空。`
          : `fact ${fact.localId}: entity, attribute and value must all be non-empty.`);
      }
      const bad = fact.findingIds.filter((id) => !verifiedIds.has(id));
      if (fact.findingIds.length === 0 || bad.length === fact.findingIds.length) {
        // G3, and the reason it is a critique first: an id typed slightly wrong
        // is a bookkeeping mistake, and the model can fix it if it is told
        // which id and that the finding list is the only source of them.
        issues.push(zh
          ? `事实 ${fact.localId} 的 findingIds ${bad.length === 0 ? "为空" : `（${bad.slice(0, 4).join("、")}）`}不在已核验发现里。只能引用输入中列出的 finding id。`
          : `fact ${fact.localId} cites ${bad.length === 0 ? "no findings" : `finding ids (${bad.slice(0, 4).join(", ")})`} that are not in the verified set. Only the finding ids listed in the input may be cited.`);
      }
      const key = `${normalisePart(fact.entity)}\u0000${normalisePart(fact.attribute)}`;
      if (seen.has(key)) {
        issues.push(zh
          ? `entity「${fact.entity}」+ attribute「${fact.attribute}」出现了两次。同一个属性只能有一行；两个来源说法不同时，写一条 conflict，不要写两行事实。`
          : `entity "${fact.entity}" with attribute "${fact.attribute}" appears twice. One row per attribute — when two sources disagree, record a conflict rather than a second fact.`);
      }
      seen.add(key);
    }

    const localIds = new Set(facts.map((f) => f.localId));
    const conflicts = asArray(output?.conflicts);
    for (const [index, conflict] of conflicts.entries()) {
      const ids = asArray(conflict?.factIds).map(asText).filter((id) => id !== "");
      if (ids.length < 2 || ids.some((id) => !localIds.has(id))) {
        issues.push(zh
          ? `冲突 #${index + 1} 必须引用至少两个你自己产出的 factId。`
          : `conflict #${index + 1} must reference at least two factIds you produced.`);
      }
      if (asText(conflict?.rationale).length < 20) {
        issues.push(zh
          ? `冲突 #${index + 1} 的 rationale 太短，说清楚两个说法差在哪里、你为什么这样处理。`
          : `conflict #${index + 1} has a rationale too short to be one: say what the two claims differ on and why you resolved it that way.`);
      }
      if (conflict?.resolution === "preferred-one" && !ids.includes(asText(conflict?.preferredFactId))) {
        issues.push(zh
          ? `冲突 #${index + 1} 选择了 preferred-one，却没有指出被采信的 factId。`
          : `conflict #${index + 1} resolves as preferred-one but names no preferredFactId from its own factIds.`);
      }
    }

    const unresolved = conflicts.filter((c) => c?.resolution === "flagged-unresolved").length;
    if (conflicts.length >= MIN_CONFLICTS_FOR_SHARE && unresolved / conflicts.length > MAX_UNRESOLVED_SHARE) {
      issues.push(zh
        ? `${conflicts.length} 个冲突里有 ${unresolved} 个悬而未决，超过了三成。把能判的判掉：说明你更相信哪一个来源、为什么。`
        : `${unresolved} of ${conflicts.length} conflicts are flagged-unresolved, over the three-in-ten ceiling. Adjudicate the ones that can be adjudicated and say which source you trust more and why.`);
    }

    // G4: the model is handed only the borderline band, and only to say what
    // the relation IS. The number was never its job.
    const { pairs } = overlapPairs(facts.map((f) => ({ ...f, factId: f.localId })));
    const borderline = pairs.filter((p) => p.similarityScore < OVERLAP_HIGH);
    const adjudicated = new Set(asArray(output?.overlaps).map((o) => `${asText(o?.aFactId)}|${asText(o?.bFactId)}`));
    const missing = borderline.filter((p) => !adjudicated.has(`${p.a.localId}|${p.b.localId}`) && !adjudicated.has(`${p.b.localId}|${p.a.localId}`));
    if (missing.length > 0) {
      const shown = missing.slice(0, 8).map((p) => `${p.a.localId}(${p.a.entity} / ${p.a.attribute}) ↔ ${p.b.localId}(${p.b.entity} / ${p.b.attribute}) = ${p.similarityScore}`);
      issues.push(zh
        ? `下面这些事实对的相似度落在判定区间里，需要你给出 relation（duplicate / related / distinct）：\n${shown.join("\n")}`
        : `these fact pairs fall in the borderline similarity band and need a relation from you (duplicate / related / distinct):\n${shown.join("\n")}`);
    }

    for (const [index, gap] of asArray(output?.gaps).entries()) {
      if (!dimensionIds.has(asText(gap?.dimensionId))) {
        issues.push(zh
          ? `缺口 #${index + 1} 指向的 dimensionId「${asText(gap?.dimensionId)}」不是本任务的维度。`
          : `gap #${index + 1} names dimensionId "${asText(gap?.dimensionId)}", which is not a dimension of this mission.`);
      }
      if (asArray(gap?.aspects).length === 0) {
        issues.push(zh ? `缺口 #${index + 1} 没有写清缺的是什么。` : `gap #${index + 1} does not say what is missing.`);
      }
    }

    for (const [index, hypothesis] of asArray(output?.hypotheses).entries()) {
      if (asArray(hypothesis?.refutingEvidence).length === 0) {
        issues.push(zh
          ? `备择假设 #${index + 1} 没有给出任何可以推翻它的证据。无法被推翻的假设不是假设。`
          : `alternative hypothesis #${index + 1} names nothing that would refute it. A hypothesis that cannot be wrong is not one.`);
      }
    }

    return issues;
  };
}

/**
 * Render the verified findings for the Reconciler, at one shrink rung.
 *
 * The ladder is `stage.shrinkLadder`, read from the frozen declaration. Its
 * last rung is not the declared "batch by entity": entities are the model's
 * OUTPUT, so there is nothing to batch by before this call returns. The last
 * rung caps the findings per dimension instead and says so in the document, in
 * the input the model reads, rather than dropping evidence silently.
 * @param findings - the verified findings.
 * @param rung - 0 unshrunk.
 * @param zh - the language.
 * @returns the rendered evidence block.
 */
function renderFindings(findings, rung, zh) {
  const byDimension = new Map();
  for (const finding of findings) {
    const list = byDimension.get(finding.dimensionId) ?? [];
    list.push(finding);
    byDimension.set(finding.dimensionId, list);
  }
  const perDimensionCap = rung >= 3 ? 12 : Infinity;
  const lines = [];
  for (const [dimensionId, list] of byDimension) {
    const kept = list.slice(0, perDimensionCap);
    lines.push(`### ${dimensionId} (${kept.length}/${list.length})`);
    if (kept.length < list.length) {
      lines.push(zh
        ? `（本维度共 ${list.length} 条已核验发现，因输入预算只列出前 ${kept.length} 条。）`
        : `(this dimension has ${list.length} verified findings; the input budget allowed the first ${kept.length}.)`);
    }
    for (const finding of kept) {
      const head = `- ${finding.id} | ${finding.sourceHost} | ${asText(finding.claim)}`;
      if (rung >= 2) lines.push(head);
      else lines.push(`${head}\n  "${compact(finding.evidence, rung === 1 ? 200 : QUOTE_CHARS)}"\n  ${finding.sourceUrl}`);
    }
  }
  return lines.join("\n");
}

/**
 * Stage five — the accounting node between N researchers and everything after.
 *
 * @param deps - `{store, chat, ctx, prompts, circuit, cache, spillDir, ledger, logger}`.
 * @returns the `s5-reconcile` handler.
 */
export function createS5Reconcile(deps) {
  const { store } = deps;

  return async function s5Reconcile(context) {
    const { missionId, runCount, mission, stage, crossState, emit } = context;
    const zh = isZh(mission);

    // THE EVIDENCE BOUNDARY. One call, and it is the only read of
    // `mission_findings` in this stage.
    const findings = store.verifiedFindings(missionId, { runCount });

    if (findings.length === 0) {
      // Not a bare failure. The census — every failing query, every host, every
      // tool refusal — is the honest answer, and it goes into the event log so
      // the postlude can put it in front of a person instead of a stack trace.
      const census = store.collectionDiagnostics(missionId, { runCount, limit: 20 });
      const hosts = census.hosts.map((h) => h.host);
      emit("evidence:none", { stepId: stage.id, runCount, census });
      throw fail("no_evidence", zh
        ? `没有任何一条发现通过了引文核验，因此没有可以据以写作的证据。已抓取的主机：${hosts.length === 0 ? "无" : hosts.join("、")}；失败的工具调用 ${census.queries.length} 次（${census.queries.slice(0, 6).map((q) => `${q.tool}:${q.errorCode ?? "unknown"}`).join("、") || "无"}）。“查过了，没查到可核验的东西”本身就是结论，会作为简报保留。`
        : `no finding passed quote verification, so there is no evidence to write from. Hosts fetched: ${hosts.length === 0 ? "none" : hosts.join(", ")}; failed tool calls: ${census.queries.length} (${census.queries.slice(0, 6).map((q) => `${q.tool}:${q.errorCode ?? "unknown"}`).join(", ") || "none"}). "We looked and found nothing verifiable" is itself the answer and is kept as the brief.`);
    }

    const dimensions = asArray(crossState?.dimensions).length > 0
      ? asArray(crossState.dimensions)
      // A stage rerun that starts here has no planning crossState; the rows are
      // the same dimensions and reading them beats refusing to run.
      : store.listDimensions(missionId, { runCount }).map((d) => ({ dimensionId: d.dimensionId, name: d.name, rationale: d.rationale, facet: d.facet }));
    const dimensionIds = new Set(dimensions.map((d) => d.dimensionId));
    const verifiedIds = new Set(findings.map((f) => f.id));
    const dimensionOf = new Map(findings.map((f) => [f.id, f.dimensionId]));

    const bindings = {
      findingCount: findings.length,
      dimensionCount: dimensions.length,
      maxUnresolvedShare: MAX_UNRESOLVED_SHARE,
      overlapLow: OVERLAP_LOW,
      overlapHigh: OVERLAP_HIGH,
    };

    const plan = fitInput(deps, stage, (rung) => [
      block(zh ? "任务" : "Mission", `${mission.topic}`),
      block(zh ? "维度" : "Dimensions", dimensions.map((d) => `- ${d.dimensionId}: ${asText(d.name)} — ${compact(d.rationale, 200)}`).join("\n")),
      block(zh ? "已核验的发现（只有这些可以成为事实）" : "Verified findings (the only material that may become a fact)", renderFindings(findings, rung, zh)),
    ].join("\n"));

    const run = await callAgent(deps, context, {
      agent: "reconciler",
      duty: "reconcile",
      input: plan.text,
      bindings: { ...bindings, shrinkRung: plan.rungName },
      schema: RECONCILE_SCHEMA,
      check: checkReconcile({ verifiedIds, dimensionIds, zh }),
      description: zh
        ? "提交本次归并的结果：事实表、冲突、重叠判定、缺口、备择假设。"
        : "Submit the reconciliation: the fact table, the conflicts, the overlap adjudications, the gaps and the alternative hypotheses.",
    });
    assertRun(run);

    /* ── code owns the result from here ───────────────────────────── */

    const notes = [];
    const raw = readFacts(run.output);
    const kept = new Map();
    const idMap = new Map();
    const facts = [];
    const conflicts = [];
    let droppedProvenance = 0;
    let duplicateValues = 0;

    for (const candidate of raw) {
      // G3: provenance is not negotiable. A fact whose every finding id is
      // unresolvable is dropped and COUNTED — never absorbed, because an
      // absorbed drop is a fact table that silently shrank.
      const findingIds = candidate.findingIds.filter((id) => verifiedIds.has(id));
      if (findingIds.length === 0 || candidate.entity === "" || candidate.attribute === "" || candidate.value === "") {
        droppedProvenance += 1;
        continue;
      }
      const key = `${normalisePart(candidate.entity)}\u0000${normalisePart(candidate.attribute)}`;
      const factId = factIdFor(candidate.entity, candidate.attribute);
      const dimensionIdsOf = [...new Set(findingIds.map((id) => dimensionOf.get(id)).filter((d) => d !== undefined))];
      const existing = kept.get(key);

      if (existing === undefined) {
        // `dimensionIds` is carried on the fact so s7 can place it without
        // re-reading mission_findings — the evidence boundary is one query, and
        // a second reader of that table is how it stops being one.
        const fact = { factId, entity: candidate.entity, attribute: candidate.attribute, value: candidate.value, findingIds, dimensionIds: dimensionIdsOf };
        kept.set(key, fact);
        facts.push(fact);
        idMap.set(candidate.localId, factId);
        continue;
      }
      if (normalisePart(existing.value) === normalisePart(candidate.value)) {
        existing.findingIds = [...new Set([...existing.findingIds, ...findingIds])];
        existing.dimensionIds = [...new Set([...existing.dimensionIds, ...dimensionIdsOf])];
        idMap.set(candidate.localId, factId);
        continue;
      }
      // G2. The missing UNIQUE(mission_id, entity, attribute) is this Map; the
      // branch below is the half that mattered anyway. A naive insert loop
      // drops the second, conflicting value and commits the rest, and the
      // mission then reports a clean fact table with the conflict removed —
      // strictly worse than the check it replaces, which at least reported.
      duplicateValues += 1;
      const rejectedId = `${factId}#dup${duplicateValues}`;
      idMap.set(candidate.localId, rejectedId);
      conflicts.push({
        conflictId: conflictIdFor([existing.factId, rejectedId]),
        factIds: [existing.factId, rejectedId],
        resolution: "flagged-unresolved",
        preferredFactId: null,
        rationale: zh
          ? `同一个 entity+attribute（${existing.entity} / ${existing.attribute}）出现了两个不同的取值：保留「${compact(existing.value, 160)}」，被拒的是「${compact(candidate.value, 160)}」。两者都有已核验来源，归并阶段没有判定依据，因此挂起而不是丢弃。`
          : `one entity+attribute (${existing.entity} / ${existing.attribute}) carried two different values: "${compact(existing.value, 160)}" was kept and "${compact(candidate.value, 160)}" was rejected. Both have verified sources and reconciliation had no basis to choose, so it is flagged rather than dropped.`,
        synthetic: true,
      });
    }

    if (droppedProvenance > 0) {
      notes.push(zh
        ? `${droppedProvenance} 条事实因为引用了不存在或未通过核验的 finding 而被丢弃。`
        : `${droppedProvenance} facts were dropped because their findingIds did not resolve to verified findings.`);
    }
    if (duplicateValues > 0) {
      notes.push(zh
        ? `${duplicateValues} 组同一属性的不同取值被记为悬而未决的冲突。`
        : `${duplicateValues} same-attribute value clashes were recorded as flagged-unresolved conflicts.`);
    }

    let droppedConflicts = 0;
    for (const candidate of asArray(run.output?.conflicts)) {
      const ids = [...new Set(asArray(candidate?.factIds).map((id) => idMap.get(asText(id))).filter((id) => id !== undefined))];
      if (ids.length < 2) {
        droppedConflicts += 1;
        continue;
      }
      const resolution = CONFLICT_RESOLUTIONS.includes(candidate?.resolution) ? candidate.resolution : "flagged-unresolved";
      const preferred = idMap.get(asText(candidate?.preferredFactId)) ?? null;
      conflicts.push({
        conflictId: conflictIdFor(ids),
        factIds: ids,
        resolution: resolution === "preferred-one" && preferred === null ? "flagged-unresolved" : resolution,
        preferredFactId: resolution === "preferred-one" ? preferred : null,
        rationale: asText(candidate?.rationale),
        synthetic: false,
      });
    }
    if (droppedConflicts > 0) {
      notes.push(zh
        ? `${droppedConflicts} 条冲突因为引用的事实无法解析而被丢弃。`
        : `${droppedConflicts} conflicts were dropped because the facts they referenced did not resolve.`);
    }

    // G4: the score is ours. The model's relation is carried beside it when it
    // adjudicated that pair, and its absence is `null` rather than a guess.
    const relations = new Map();
    for (const entry of asArray(run.output?.overlaps)) {
      const a = idMap.get(asText(entry?.aFactId));
      const b = idMap.get(asText(entry?.bFactId));
      if (a === undefined || b === undefined) continue;
      relations.set([a, b].sort().join("|"), asText(entry?.relation));
    }
    const computed = overlapPairs(facts);
    const overlaps = computed.pairs.slice(0, MAX_OVERLAP_PAIRS).map((pair) => ({
      aFactId: pair.a.factId,
      bFactId: pair.b.factId,
      similarityScore: pair.similarityScore,
      relation: relations.get([pair.a.factId, pair.b.factId].sort().join("|")) ?? null,
    }));
    if (computed.skipped > 0) {
      notes.push(zh
        ? `事实数量超过 ${MAX_OVERLAP_FACTS}，重叠检测只覆盖了前 ${MAX_OVERLAP_FACTS} 条，${computed.skipped} 条未参与两两比较。`
        : `over ${MAX_OVERLAP_FACTS} facts: the pairwise overlap pass covered the first ${MAX_OVERLAP_FACTS} and ${computed.skipped} facts were not compared.`);
    }

    const factIds = new Set(facts.map((f) => f.factId));
    const gaps = asArray(run.output?.gaps)
      .filter((gap) => dimensionIds.has(asText(gap?.dimensionId)) && asArray(gap?.aspects).length > 0)
      .map((gap) => ({
        dimensionId: asText(gap.dimensionId),
        aspects: asArray(gap.aspects).map(asText).filter((a) => a !== ""),
        severity: GAP_SEVERITIES.includes(gap?.severity) ? gap.severity : "medium",
      }));
    const hypotheses = asArray(run.output?.hypotheses)
      .filter((h) => asText(h?.statement) !== "" && asArray(h?.refutingEvidence).length > 0)
      .map((h) => ({
        statement: asText(h.statement),
        likelihood: LIKELIHOODS.includes(h?.likelihood) ? h.likelihood : "medium",
        refutingEvidence: asArray(h.refutingEvidence).map(asText).filter((e) => e !== ""),
      }));

    if (facts.length === 0) {
      // The findings exist — we read them at the top of this handler — so an
      // empty fact table is a reconciliation failure, not an evidence one, and
      // saying `no_evidence` here would file it under the wrong column.
      throw fail("input_invalid", zh
        ? `归并阶段从 ${findings.length} 条已核验发现里没有产出任何可用的事实（${droppedProvenance} 条因来源无法解析被丢弃）。下游没有可写的材料。`
        : `reconciliation produced no usable facts from ${findings.length} verified findings (${droppedProvenance} were dropped for unresolvable provenance). There is nothing for the downstream stages to write from.`);
    }
    if (plan.rungName !== null) {
      notes.push(zh
        ? `输入按「${plan.rungName}」压缩后发送。`
        : `the input was sent at shrink rung "${plan.rungName}".`);
    }
    if (plan.over) {
      notes.push(zh
        ? "即使在最后一级压缩下，输入仍超过本阶段的输入预算。"
        : "the input still exceeded this stage's input budget at the last shrink rung.");
    }

    const result = { facts, conflicts, overlaps, gaps, hypotheses };
    const degraded = notes.length > 0 || run.state === "degraded";
    if (run.state === "degraded") notes.unshift(run.diagnostic ?? "the agent run ended degraded.");

    return {
      output: {
        ...result,
        counts: {
          verifiedFindings: findings.length,
          facts: facts.length,
          conflicts: conflicts.length,
          unresolved: conflicts.filter((c) => c.resolution === "flagged-unresolved").length,
          overlaps: overlaps.length,
          droppedProvenance,
          droppedConflicts,
          factIds: factIds.size,
        },
      },
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens: tokensOf(run),
      crossPatch: { facts, conflicts, overlaps, gaps, hypotheses },
    };
  };
}

/* ── s6-synthesize ─────────────────────────────────────────────────────── */

/** The Analyst's position and its forecasts. `finalize`'s `parameters`. */
const SYNTHESIZE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["insights", "foresight"],
  properties: {
    insights: {
      type: "object",
      required: ["position", "themes"],
      properties: {
        position: { type: "string", description: "what the evidence as a whole supports, stated so it could be wrong" },
        themes: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "argument", "factIds"],
            properties: {
              title: { type: "string" },
              argument: { type: "string" },
              factIds: { type: "array", items: { type: "string" }, description: "the facts this theme reasons from" },
            },
          },
        },
      },
    },
    foresight: {
      type: "array",
      items: {
        type: "object",
        required: ["statement", "probability", "resolutionCriteria", "factId"],
        properties: {
          statement: { type: "string" },
          probability: { type: "number", minimum: 0, maximum: 1 },
          resolutionCriteria: { type: "string", description: "what observable event would settle this, and by when" },
          factId: { type: "string", description: "the fact this forecast extends" },
        },
      },
    },
  },
});

/** The quick-view cards. `finalize`'s `parameters` for the second duty. */
const QUICKVIEW_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "body"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          factIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
});

/**
 * Render the conflicts for the Analyst, and prove every one of them is there.
 *
 * G6, and it is executable rather than prose: `s5`'s whole output is a log if
 * nothing downstream is REQUIRED to consume it, which is exactly what the
 * reference records happening to its predecessor. The assertion is cheap, runs
 * every mission rather than in a test, and throws rather than warns.
 * @param conflicts - `crossState.conflicts`.
 * @param options - `{detail, zh}`; `detail` false keeps ids and resolutions only.
 * @returns the rendered block.
 * @throws `input_invalid` when a conflict id did not reach the rendered text.
 */
function renderConflictBlock(conflicts, { detail, zh }) {
  const list = asArray(conflicts);
  if (list.length === 0) return zh ? "（归并阶段没有记录任何冲突。）" : "(reconciliation recorded no conflicts.)";
  const text = list.map((conflict) => {
    const head = `- ${conflict.conflictId} [${conflict.resolution}] ${conflict.factIds.join(" ↔ ")}`;
    return detail ? `${head}\n  ${compact(conflict.rationale, 400)}` : head;
  }).join("\n");
  for (const conflict of list) {
    if (!text.includes(conflict.conflictId)) {
      throw fail("input_invalid", `conflict ${conflict.conflictId} did not reach the Analyst's input. Reconciliation output that nobody is required to consume degenerates into a log, which is why this is asserted rather than assumed.`);
    }
  }
  return text;
}

/** One fact, as one line. */
function factLine(fact, withProvenance) {
  const head = `- ${fact.factId} | ${fact.entity} | ${fact.attribute} | ${compact(fact.value, 400)}`;
  return withProvenance ? `${head}\n  ← ${fact.findingIds.join(", ")}` : head;
}

/**
 * The Analyst's business gate.
 * @param options - `{factIds, zh}`.
 * @returns `(output) => string[]`.
 */
function checkSynthesize({ factIds, zh }) {
  return function check(output) {
    const issues = [];
    if (asText(output?.insights?.position) === "") {
      issues.push(zh ? "insights.position 为空。" : "insights.position is empty.");
    }
    const themes = asArray(output?.insights?.themes);
    if (themes.length === 0) {
      issues.push(zh ? "你没有给出任何主题。" : "you named no themes.");
    }
    for (const [index, theme] of themes.entries()) {
      const named = asArray(theme?.factIds).map(asText).filter((id) => factIds.has(id));
      if (named.length === 0) {
        // G4: a theme with no fact behind it becomes an interpretive chapter,
        // and an interpretive chapter with nothing to cite is the most trusted
        // unevidenced material in the report.
        issues.push(zh
          ? `主题 #${index + 1}「${compact(theme?.title, 60)}」没有指向任何存在的 factId。每个主题都必须说明它是从哪些事实推出来的。`
          : `theme #${index + 1} "${compact(theme?.title, 60)}" names no factId that exists. Every theme must say which facts it reasons from.`);
      }
    }
    for (const [index, forecast] of asArray(output?.foresight).entries()) {
      const probability = Number(forecast?.probability);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        issues.push(zh
          ? `预测 #${index + 1} 的 probability 必须是 0 到 1 之间的数字。`
          : `forecast #${index + 1} needs a probability between 0 and 1.`);
      }
      if (asText(forecast?.resolutionCriteria) === "") {
        // A confident-sounding forecast with no resolution criterion is the
        // most trusted unevidenced material in the report; this is the whole
        // reason the field is required.
        issues.push(zh
          ? `预测 #${index + 1} 没有写明兑现判据：什么事情发生、到什么时候，就算这条预测成立或不成立。`
          : `forecast #${index + 1} states no resolution criteria: say what observable event, and by when, settles it either way.`);
      }
      if (!factIds.has(asText(forecast?.factId))) {
        issues.push(zh
          ? `预测 #${index + 1} 的 factId「${asText(forecast?.factId)}」不在事实表里。预测必须挂在一条事实上。`
          : `forecast #${index + 1} names factId "${asText(forecast?.factId)}", which is not in the fact table. A forecast must extend a fact.`);
      }
    }
    return issues;
  };
}

/**
 * Stage six — the Analyst's position, its forecasts and the quick-view cards.
 *
 * @param deps - the handler dependencies.
 * @returns the `s6-synthesize` handler.
 */
export function createS6Synthesize(deps) {
  return async function s6Synthesize(context) {
    const { mission, stage, crossState } = context;
    const zh = isZh(mission);
    const facts = asArray(crossState?.facts);
    const conflicts = asArray(crossState?.conflicts);

    if (facts.length === 0) {
      throw fail("input_invalid", zh
        ? "crossState.facts 为空：s5-reconcile 是唯一的写入方，没有事实表就没有可以综合的材料。请从 s5-reconcile 重新运行。"
        : "crossState.facts is empty. s5-reconcile is its only writer, and with no fact table there is nothing to synthesize. Re-run from s5-reconcile.");
    }

    const factIds = new Set(facts.map((f) => f.factId));
    const bindings = { factCount: facts.length, conflictCount: conflicts.length };

    const plan = fitInput(deps, stage, (rung) => [
      block(zh ? "任务" : "Mission", mission.topic),
      block(zh ? "事实表" : "Fact table", facts.map((f) => factLine(f, rung === 0)).join("\n")),
      block(zh ? "冲突" : "Conflicts", renderConflictBlock(conflicts, { detail: rung === 0, zh })),
      block(zh ? "缺口" : "Gaps", asArray(crossState?.gaps).map((g) => `- ${g.dimensionId} [${g.severity}] ${g.aspects.join("; ")}`).join("\n") || "-"),
      block(zh ? "备择假设" : "Alternative hypotheses", asArray(crossState?.hypotheses).map((h) => `- [${h.likelihood}] ${h.statement}`).join("\n") || "-"),
    ].join("\n"));

    const run = await callAgent(deps, context, {
      agent: "analyst",
      duty: "synthesize",
      input: plan.text,
      bindings: { ...bindings, shrinkRung: plan.rungName },
      schema: SYNTHESIZE_SCHEMA,
      check: checkSynthesize({ factIds, zh }),
      description: zh ? "提交你的判断与预测。" : "Submit your position and your forecasts.",
      messageKey: "synthesize",
    });
    assertRun(run);

    const notes = [];
    if (run.state === "degraded") notes.push(run.diagnostic ?? "the analyst run ended degraded.");

    // G1 and G2 in code, after the critiques have had their rounds: a forecast
    // that still names no existing fact, or still carries no probability and no
    // resolution criterion, is DROPPED and counted rather than published.
    const foresight = [];
    let droppedForecasts = 0;
    for (const forecast of asArray(run.output?.foresight)) {
      const probability = Number(forecast?.probability);
      const factId = asText(forecast?.factId);
      const statement = asText(forecast?.statement);
      const criteria = asText(forecast?.resolutionCriteria);
      if (statement === "" || criteria === "" || !factIds.has(factId) || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        droppedForecasts += 1;
        continue;
      }
      foresight.push({
        // Minted here so `s10`'s red team and `s11`'s foreword reference an id
        // that survives a re-ask; a model-supplied id changes between rounds.
        forecastId: forecastIdFor(statement),
        statement,
        probability,
        resolutionCriteria: criteria,
        factId,
      });
    }
    if (droppedForecasts > 0) {
      notes.push(zh
        ? `${droppedForecasts} 条预测因为没有挂在已有事实上、或缺少概率与兑现判据而被丢弃。`
        : `${droppedForecasts} forecasts were dropped for naming no existing fact, or for carrying no probability and no resolution criteria.`);
    }

    let droppedThemes = 0;
    const themes = [];
    for (const theme of asArray(run.output?.insights?.themes)) {
      const named = asArray(theme?.factIds).map(asText).filter((id) => factIds.has(id));
      if (named.length === 0 || asText(theme?.title) === "") {
        droppedThemes += 1;
        continue;
      }
      themes.push({ title: asText(theme.title), argument: asText(theme.argument), factIds: named });
    }
    if (droppedThemes > 0) {
      notes.push(zh
        ? `${droppedThemes} 个主题没有指向任何存在的事实，已丢弃；它们本会成为无从引用的解读章节。`
        : `${droppedThemes} themes named no existing fact and were dropped; each would have become an interpretive chapter with nothing to cite.`);
    }

    const insights = { position: asText(run.output?.insights?.position), themes };
    if (insights.position === "" || themes.length === 0) {
      // Poison suppression upstream can hand back an empty candidate, and an
      // empty position returned as if it were an answer is exactly the silence
      // this stage's `degraded` flag exists to break.
      notes.push(zh
        ? "分析阶段没有给出可用的判断或主题；下游的解读章节将没有可依据的材料。"
        : "the analysis produced no usable position or themes, so the interpretive chapters downstream have nothing to reason from.");
    }

    /* ── the quick-view cards, second duty, same agent ─────────────── */

    let cards = [];
    const cardRun = await callAgent(deps, context, {
      agent: "analyst",
      duty: "quickview",
      input: [
        block(zh ? "任务" : "Mission", mission.topic),
        block(zh ? "判断" : "Position", insights.position),
        block(zh ? "主题" : "Themes", themes.map((t) => `- ${t.title}: ${compact(t.argument, 400)} [${t.factIds.join(", ")}]`).join("\n") || "-"),
        block(zh ? "预测" : "Forecasts", foresight.map((f) => `- ${f.forecastId} p=${f.probability} ${f.statement}`).join("\n") || "-"),
      ].join("\n"),
      bindings,
      schema: QUICKVIEW_SCHEMA,
      check: (output) => (asArray(output?.cards).length === 0
        ? [zh ? "你没有给出任何速览卡片。" : "you produced no quick-view cards."]
        : []),
      description: zh ? "提交速览卡片。" : "Submit the quick-view cards.",
      messageKey: "quickview",
    });
    if (cardRun.state === "failed") {
      // The cards are a convenience surface, not evidence. Losing them degrades
      // the stage and says so; failing the mission over them would be the
      // pipeline refusing to deliver a report because its summary card is
      // missing.
      notes.push(zh
        ? `速览卡片未能生成（${cardRun.diagnostic ?? cardRun.failureCode}）。`
        : `the quick-view cards could not be produced (${cardRun.diagnostic ?? cardRun.failureCode}).`);
    } else {
      cards = asArray(cardRun.output?.cards)
        .filter((card) => asText(card?.title) !== "" && asText(card?.body) !== "")
        .map((card) => ({
          title: asText(card.title),
          body: asText(card.body),
          factIds: asArray(card.factIds).map(asText).filter((id) => factIds.has(id)),
        }));
      if (cardRun.state === "degraded") notes.push(cardRun.diagnostic ?? "the quick-view run ended degraded.");
    }

    if (plan.rungName !== null) {
      notes.push(zh ? `输入按「${plan.rungName}」压缩后发送。` : `the input was sent at shrink rung "${plan.rungName}".`);
    }

    const result = { insights, foresight, cards };
    const degraded = notes.length > 0;
    return {
      output: { ...result, counts: { themes: themes.length, forecasts: foresight.length, cards: cards.length, droppedForecasts, droppedThemes } },
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens: tokensOf(run) + tokensOf(cardRun),
      crossPatch: { insights, foresight, cards },
    };
  };
}

/* ── s7-outline ────────────────────────────────────────────────────────── */

/** The report-level outline. `finalize`'s `parameters` for duty `mission-outline`. */
const MISSION_OUTLINE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["title", "chapters"],
  properties: {
    title: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        required: ["dimensionId", "heading", "sectionType", "factIds"],
        properties: {
          dimensionId: { type: "string" },
          heading: { type: "string" },
          sectionType: { type: "string", enum: [...SECTION_TYPES] },
          factIds: { type: "array", items: { type: "string" } },
          brief: { type: "string", description: "what this chapter is for, in one or two sentences" },
        },
      },
    },
  },
});

/** One dimension's chapters, refined. `finalize`'s `parameters` for duty `dim-outline`. */
const DIM_OUTLINE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["chapters"],
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        required: ["chapterIndex", "keyPoints"],
        properties: {
          chapterIndex: { type: "integer" },
          heading: { type: "string" },
          keyPoints: { type: "array", items: { type: "string" } },
          factIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
});

/**
 * The fingerprint of the prompt a chapter was written under.
 *
 * `mission_chapters.input_hash` must cover EVERYTHING that can change the
 * output, including the skill text: revision 1 hashed outline and findings
 * only, so an incremental rerun after a PROMPT fix skipped every chapter and
 * reported success having done nothing — while prompt-editing is the capability
 * the incremental rerun exists for.
 *
 * The SKILL.md loader is the agent seam's, and until it exposes a fingerprint
 * this falls back to the RUN GENERATION, which is the safe direction: chapters
 * never match across runs, so an incremental rerun re-writes them rather than
 * reusing work done under a prompt nobody can identify.
 * @param deps - the handler dependencies.
 * @param agent - the role.
 * @param duty - the duty.
 * @param runCount - the generation, used when no fingerprint is available.
 * @returns a short stable string.
 */
function promptFingerprint(deps, agent, duty, runCount) {
  const fingerprint = deps?.prompts?.fingerprint;
  if (typeof fingerprint === "function") {
    const value = asText(fingerprint(agent, duty));
    if (value !== "") return `${agent}:${duty}:${value}`;
  }
  return `${agent}:${duty}:run${runCount}`;
}

/**
 * The hash that decides whether an incremental rerun may keep a chapter.
 * @param parts - `{heading, sectionType, minDelivery, tier, facts, fingerprint}`.
 * @returns a hex digest.
 */
function chapterInputHash(parts) {
  return sha256Hex(JSON.stringify([
    parts.heading,
    parts.sectionType,
    parts.minDelivery,
    parts.tier,
    parts.fingerprint,
    // Provenance, not just ids: a fact whose value changed must invalidate the
    // chapter that quotes it.
    parts.facts.map((f) => [f.factId, f.value, f.findingIds]),
  ]));
}

/**
 * The chapters an incremental rerun may carry forward, as prior rows to copy.
 *
 * `store.chapterReuse` existed with NO CALLER while `chapterInputHash` was
 * computed and written on every chapter row — a hash stored for a reader that
 * was never built. The consequence is a tab that lies: "Rerun incrementally" is
 * a button, the route writes `rerun-incremental` as the config's mutation
 * reason, and the mission then re-wrote every chapter from scratch exactly like
 * a fresh rerun, at full cost, while the page said the previous run was kept.
 *
 * Fresh reruns and first runs return an empty map with a stated reason rather
 * than an empty map that could mean either "nothing matched" or "nothing was
 * asked" — the caller narrates whichever it was.
 *
 * @param store - the mission store.
 * @param options - `{missionId, rows}` — `rows` are THIS run's planned chapters, carrying the freshly computed hashes.
 * @returns `{keep, why}` — `keep` maps `dimensionId#chapterIndex` to the prior row to copy.
 */
function reusableChapters(store, { missionId, rows }) {
  const config = store.latestConfig(missionId);
  const reason = config?.mutationReason ?? null;
  if (reason !== "rerun-incremental") {
    return { keep: new Map(), why: reason === null ? "first run" : `this run is ${reason}` };
  }
  const fromRunCount = Number(config?.config?.rerunOf);
  if (!Number.isInteger(fromRunCount) || fromRunCount < 1) {
    return { keep: new Map(), why: "the rerun config names no generation to reuse from" };
  }

  const hashes = new Map(rows.map((row) => [`${row.dimensionId}#${row.chapterIndex}`, row.inputHash]));
  const decisions = store.chapterReuse(missionId, { fromRunCount, hashes });
  const prior = new Map(
    store.listChapters(missionId, fromRunCount).map((row) => [`${row.dimensionId}#${row.chapterIndex}`, row]),
  );

  const keep = new Map();
  for (const decision of decisions) {
    if (decision.reusable !== true) continue;
    const key = `${decision.dimensionId}#${decision.chapterIndex}`;
    const row = prior.get(key);
    // `chapterReuse` already refuses an empty body, but the row is read here
    // rather than trusted: a chapter carried forward with nothing in it is the
    // hole the content guard exists to catch, flying a green flag.
    if (row !== undefined && typeof row.body === "string" && row.body.trim() !== "") keep.set(key, row);
  }
  return { keep, why: `run ${fromRunCount}` };
}

/**
 * The Writer's outline gate.
 * @param options - `{factIds, dimensionIds, maxChapters, zh}`.
 * @returns `(output) => string[]`.
 */
function checkMissionOutline({ factIds, dimensionIds, maxChapters, zh }) {
  return function check(output) {
    const issues = [];
    const chapters = asArray(output?.chapters);
    if (asText(output?.title) === "") issues.push(zh ? "报告缺少标题。" : "the report has no title.");
    if (chapters.length === 0) issues.push(zh ? "大纲里没有章节。" : "the outline contains no chapters.");
    if (chapters.length > maxChapters) {
      // Named here so the model can fix it itself; if it does not, code cuts
      // the list and narrates the cut with the real numbers.
      issues.push(zh
        ? `已验证来源只支持 ${maxChapters} 章（每章至少两个来源），你规划了 ${chapters.length} 章。`
        : `the verified sources support at most ${maxChapters} chapters at two sources each; you planned ${chapters.length}.`);
    }
    const seen = new Set();
    for (const [index, chapter] of chapters.entries()) {
      if (!dimensionIds.has(asText(chapter?.dimensionId))) {
        issues.push(zh
          ? `第 ${index + 1} 章的 dimensionId「${asText(chapter?.dimensionId)}」不是本任务的维度。`
          : `chapter ${index + 1} names dimensionId "${asText(chapter?.dimensionId)}", which is not a dimension of this mission.`);
      }
      if (!SECTION_TYPES.includes(chapter?.sectionType)) {
        issues.push(zh
          ? `第 ${index + 1} 章的 sectionType 必须是 ${SECTION_TYPES.join(" 或 ")}。`
          : `chapter ${index + 1} must declare a sectionType of ${SECTION_TYPES.join(" or ")}.`);
      }
      const named = asArray(chapter?.factIds).map(asText);
      const unknown = named.filter((id) => !factIds.has(id));
      if (unknown.length > 0) {
        issues.push(zh
          ? `第 ${index + 1} 章分配了不存在的事实：${unknown.slice(0, 5).join("、")}。`
          : `chapter ${index + 1} allocates facts that do not exist: ${unknown.slice(0, 5).join(", ")}.`);
      }
      // G2: the allocation is a PARTITION. A fact in two chapters is written
      // twice; a fact in none is dropped from a report that collected it.
      for (const id of named) {
        if (seen.has(id)) {
          issues.push(zh
            ? `事实 ${id} 被分配给了不止一章。每条事实只能属于一章。`
            : `fact ${id} is allocated to more than one chapter. Each fact belongs to exactly one.`);
        }
        seen.add(id);
      }
      if (chapter?.sectionType === "interpretive" && named.filter((id) => factIds.has(id)).length === 0) {
        issues.push(zh
          ? `第 ${index + 1} 章是解读章节，必须至少指名一条它据以推理的事实。`
          : `chapter ${index + 1} is interpretive and must name at least one fact it reasons from.`);
      }
    }
    const missing = [...factIds].filter((id) => !seen.has(id));
    if (missing.length > 0) {
      issues.push(zh
        ? `${missing.length} 条事实没有被分配到任何章节（例如 ${missing.slice(0, 5).join("、")}）。`
        : `${missing.length} facts are allocated to no chapter (for example ${missing.slice(0, 5).join(", ")}).`);
    }
    return issues;
  };
}

/**
 * Stage seven — supply decides demand, and the delivery number is minted once.
 *
 * @param deps - the handler dependencies.
 * @returns the `s7-outline` handler.
 */
export function createS7Outline(deps) {
  const { store } = deps;

  return async function s7Outline(context) {
    const { missionId, runCount, mission, tier, stage, crossState, budget, now } = context;
    const zh = isZh(mission);
    const facts = asArray(crossState?.facts);
    const notes = [];

    if (facts.length === 0) {
      throw fail("input_invalid", zh
        ? "crossState.facts 为空：没有事实表就没有可以规划的章节。请从 s5-reconcile 重新运行。"
        : "crossState.facts is empty. With no fact table there are no chapters to plan. Re-run from s5-reconcile.");
    }

    // G1. Supply decides demand, and the number is the count of distinct hosts
    // behind VERIFIED findings — which is what makes "two sources per chapter"
    // mean something stronger than "two URLs".
    const hosts = store.uniqueHosts(missionId, { runCount });
    const uniqueVerifiedSources = hosts.length;
    let maxChapters = Math.floor(uniqueVerifiedSources / 2);
    if (maxChapters < 1) {
      maxChapters = 1;
      notes.push(zh
        ? `唯一已验证来源只有 ${uniqueVerifiedSources} 个，按每章两个来源算不足一章；已按一章下限规划，全文只写一章。`
        : `${uniqueVerifiedSources} unique verified hosts is under the two-per-chapter rule; the report was planned at the one-chapter floor.`);
    }

    const dimensionRows = asArray(crossState?.dimensions);
    const factsPerDimension = new Map();
    for (const fact of facts) {
      for (const dimensionId of asArray(fact.dimensionIds)) {
        factsPerDimension.set(dimensionId, (factsPerDimension.get(dimensionId) ?? 0) + 1);
      }
    }
    const dimensions = dimensionRows.map((d) => ({ ...d, verified: factsPerDimension.get(d.dimensionId) ?? 0 }));
    if (dimensions.length === 0) {
      throw fail("input_invalid", zh
        ? "crossState.dimensions 为空：s2-plan 是唯一的写入方，没有维度就无法规划章节。"
        : "crossState.dimensions is empty. s2-plan is its only writer, and chapters cannot be planned without dimensions.");
    }

    const factIds = new Set(facts.map((f) => f.factId));
    const dimensionIds = new Set(dimensions.map((d) => d.dimensionId));
    const policy = tierPolicyOf(crossState, mission);
    const bindings = {
      uniqueVerifiedSources,
      maxChapters,
      factCount: facts.length,
      dimensionCount: dimensions.length,
      wordFloor: policy.wordFloor,
    };

    /* ── the report arc ───────────────────────────────────────────── */

    let chapters = null;
    let title = mission.topic;

    const plan = fitInput(deps, stage, (rung) => [
      block(zh ? "任务" : "Mission", mission.topic),
      block(zh ? "维度" : "Dimensions", dimensions.map((d) => `- ${d.dimensionId}: ${asText(d.name)} (${d.verified} ${zh ? "条事实" : "facts"})`).join("\n")),
      block(zh ? "事实表" : "Fact table", facts.map((f) => (rung === 0
        ? factLine(f, false)
        : `- ${f.factId} | ${compact(`${f.entity} ${f.attribute}`, 120)}`)).join("\n")),
      block(zh ? "分析主题" : "Analysis themes", asArray(crossState?.insights?.themes).map((t) => `- ${t.title} [${t.factIds.join(", ")}]`).join("\n") || "-"),
      block(zh ? "供给上限" : "Supply ceiling", zh
        ? `唯一已验证来源 ${uniqueVerifiedSources} 个，按每章至少两个来源，最多 ${maxChapters} 章。`
        : `${uniqueVerifiedSources} unique verified hosts allows at most ${maxChapters} chapters at two sources each.`),
    ].join("\n"));

    const run = await callAgent(deps, context, {
      agent: "writer",
      duty: "mission-outline",
      input: plan.text,
      bindings: { ...bindings, shrinkRung: plan.rungName },
      schema: MISSION_OUTLINE_SCHEMA,
      check: checkMissionOutline({ factIds, dimensionIds, maxChapters, zh }),
      description: zh ? "提交报告大纲与事实分配。" : "Submit the report outline and the fact allocation.",
      messageKey: "mission-outline",
    });
    assertRun(run);
    if (run.state === "degraded") notes.push(run.diagnostic ?? "the outline run ended degraded.");

    const planned = asArray(run.output?.chapters)
      .filter((chapter) => dimensionIds.has(asText(chapter?.dimensionId)) && asText(chapter?.heading) !== "")
      .map((chapter, index) => ({
        dimensionId: asText(chapter.dimensionId),
        chapterIndex: index,
        heading: asText(chapter.heading),
        sectionType: SECTION_TYPES.includes(chapter?.sectionType) ? chapter.sectionType : "evidenced",
        factIds: asArray(chapter.factIds).map(asText).filter((id) => factIds.has(id)),
        brief: compact(chapter.brief, 600),
      }));

    if (planned.length === 0) {
      // The same planner `quick` uses, rather than a second fallback path: a
      // broken outline becomes a plain report, not no report.
      chapters = planChapters({
        dimensions, facts, insights: crossState?.insights, maxChapters,
        wordFloor: policy.wordFloor,
        // The same count `contentGuard` reads, from the same query, so the
        // chapter targets and the whole-report floor cannot drift apart.
        verifiedCount: store.countVerified(missionId, null, runCount),
        language: mission.language,
      });
      notes.push(zh
        ? "写作者没有产出可用的大纲，已改用确定性规划（每个维度一章）。"
        : "the Writer produced no usable outline; the deterministic planner (one chapter per dimension) was used instead.");
    } else {
      chapters = planned;
      title = asText(run.output?.title) === "" ? mission.topic : asText(run.output.title);
    }

    // G1 again, in code and with the real numbers. Silently producing fewer
    // chapters is how a citation requirement becomes unsatisfiable and chapters
    // rewrite until wall-time.
    if (chapters.length > maxChapters) {
      const asked = chapters.length;
      chapters = chapters.slice(0, maxChapters);
      notes.push(zh
        ? `唯一已验证来源 ${uniqueVerifiedSources} 个，按每章至少两个来源，最多 ${maxChapters} 章；大纲要了 ${asked} 章，已裁到 ${maxChapters} 章。`
        : `${uniqueVerifiedSources} unique verified hosts allows at most ${maxChapters} chapters at two sources each; the outline asked for ${asked} and was cut to ${maxChapters}.`);
    }
    chapters.forEach((chapter, index) => { chapter.chapterIndex = index; });

    /* ── per-dimension detail ─────────────────────────────────────── */

    for (const dimension of dimensions) {
      const owned = chapters.filter((c) => c.dimensionId === dimension.dimensionId);
      if (owned.length === 0) continue;
      if (budget?.isExhausted?.() === true) {
        notes.push(zh
          ? "预算在逐维度细化大纲的过程中耗尽，其余章节沿用报告级大纲的标题与说明。"
          : "the budget was exhausted part-way through the per-dimension outlines; the remaining chapters kept their report-level headings and briefs.");
        break;
      }
      const dimensionFacts = facts.filter((f) => owned.some((c) => c.factIds.includes(f.factId)) || asArray(f.dimensionIds).includes(dimension.dimensionId));
      const dimRun = await callAgent(deps, context, {
        agent: "writer",
        duty: "dim-outline",
        input: [
          block(zh ? "任务" : "Mission", mission.topic),
          block(zh ? "维度" : "Dimension", `${dimension.dimensionId}: ${asText(dimension.name)} — ${compact(dimension.rationale, 300)}`),
          block(zh ? "本维度的章节" : "Chapters of this dimension", owned.map((c) => `- #${c.chapterIndex} [${c.sectionType}] ${c.heading} — ${compact(c.brief, 200)}`).join("\n")),
          block(zh ? "可用事实" : "Available facts", dimensionFacts.map((f) => factLine(f, false)).join("\n") || "-"),
        ].join("\n"),
        bindings: { ...bindings, chapterCount: owned.length },
        schema: DIM_OUTLINE_SCHEMA,
        check: (output) => (asArray(output?.chapters).length === 0
          ? [zh ? "你没有给出任何章节要点。" : "you returned no chapter key points."]
          : []),
        description: zh ? "提交本维度每一章的要点。" : "Submit the key points for each chapter of this dimension.",
        messageKey: `dim-outline-${dimension.dimensionId}`,
      });
      if (dimRun.state === "failed") {
        // Not fatal: the report-level outline already names the chapter and its
        // purpose, so the writer has something to write from.
        notes.push(zh
          ? `维度 ${dimension.dimensionId} 的细化大纲失败（${dimRun.diagnostic ?? dimRun.failureCode}），沿用报告级大纲。`
          : `the per-dimension outline for ${dimension.dimensionId} failed (${dimRun.diagnostic ?? dimRun.failureCode}); its report-level outline was kept.`);
        continue;
      }
      for (const refined of asArray(dimRun.output?.chapters)) {
        const target = owned.find((c) => c.chapterIndex === Number(refined?.chapterIndex));
        if (target === undefined) continue;
        const heading = asText(refined?.heading);
        if (heading !== "") target.heading = heading;
        const points = asArray(refined?.keyPoints).map(asText).filter((p) => p !== "");
        if (points.length > 0) target.brief = compact(points.map((p) => `- ${p}`).join("\n"), 900);
        const refinedFacts = asArray(refined?.factIds).map(asText).filter((id) => factIds.has(id));
        if (refinedFacts.length > 0) target.factIds = refinedFacts;
      }
    }

    /* ── the partition, the one delivery number, and the rows ─────── */

    const beforeAllocation = new Set(chapters.flatMap((c) => c.factIds));
    allocateFacts(chapters, facts);
    const reassigned = facts.filter((f) => !beforeAllocation.has(f.factId)).length;
    if (reassigned > 0) {
      notes.push(zh
        ? `${reassigned} 条事实没有被大纲分配，已按维度与标题相近程度归入最接近的章节。`
        : `${reassigned} facts were left unallocated by the outline and were assigned to the nearest chapter by dimension and heading.`);
    }

    const minDelivery = deliveryFloor(policy.wordFloor, chapters.length, store.countVerified(missionId, null, runCount));
    const factAllocation = {};
    const sectionTypes = {};
    const at = now();

    for (const chapter of chapters) {
      chapter.minDelivery = minDelivery;
      // G4 once more, after the merge: an interpretive chapter that lost its
      // facts in refinement becomes evidenced rather than becoming a chapter
      // with nothing behind it.
      if (chapter.sectionType === "interpretive" && chapter.factIds.length === 0) {
        chapter.sectionType = "evidenced";
        notes.push(zh
          ? `第 ${chapter.chapterIndex + 1} 章原定为解读章节但没有可引用的事实，已改为证据章节。`
          : `chapter ${chapter.chapterIndex + 1} was planned as interpretive but held no facts, and was recorded as evidenced.`);
      }
      for (const factId of chapter.factIds) {
        factAllocation[factId] = { dimensionId: chapter.dimensionId, chapterIndex: chapter.chapterIndex };
      }
      sectionTypes[`${chapter.dimensionId}:${chapter.chapterIndex}`] = chapter.sectionType;

      store.upsertChapter({
        missionId,
        runCount,
        dimensionId: chapter.dimensionId,
        chapterIndex: chapter.chapterIndex,
        sectionType: chapter.sectionType,
        heading: chapter.heading,
        // Planned, not written. `s8` fills the body; a chapter row with a body
        // here would make `contentGuard`'s "assembly succeeded over a hole"
        // check unable to tell a planned chapter from a written one.
        body: null,
        wordCount: 0,
        minDelivery,
        underDelivered: false,
        decision: null,
        score: null,
        attempts: 0,
        inputHash: chapterInputHash({
          heading: chapter.heading,
          sectionType: chapter.sectionType,
          minDelivery,
          tier,
          fingerprint: promptFingerprint(deps, "writer", "chapter", runCount),
          facts: facts.filter((f) => chapter.factIds.includes(f.factId)),
        }),
        at,
      });
    }

    if (plan.rungName !== null) {
      notes.push(zh ? `输入按「${plan.rungName}」压缩后发送。` : `the input was sent at shrink rung "${plan.rungName}".`);
    }
    const degraded = notes.length > 0;

    return {
      output: {
        title,
        chapterCount: chapters.length,
        uniqueVerifiedSources,
        maxChapters,
        minDelivery,
        chapters: chapters.map((c) => ({ dimensionId: c.dimensionId, chapterIndex: c.chapterIndex, heading: c.heading, sectionType: c.sectionType })),
      },
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens: tokensOf(run),
      crossPatch: {
        outline: chapters.map((c) => ({
          dimensionId: c.dimensionId,
          chapterIndex: c.chapterIndex,
          heading: c.heading,
          sectionType: c.sectionType,
          minDelivery,
          factIds: c.factIds,
          brief: c.brief,
        })),
        factAllocation,
        sectionTypes,
      },
    };
  };
}

/* ── s8-write ──────────────────────────────────────────────────────────── */

/** One chapter, as the Writer submits it. `finalize`'s `parameters`. */
const CHAPTER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["body", "citations"],
  properties: {
    body: { type: "string", description: "the chapter in Markdown, without its heading; cite with [1], [2] in the order of your citations array" },
    citations: {
      type: "array",
      items: {
        type: "object",
        required: ["findingId", "inlineQuote"],
        properties: {
          findingId: { type: "string", description: "the id of the verified finding this citation rests on" },
          inlineQuote: { type: "string", description: "the sentence from that finding you are relying on" },
        },
      },
    },
  },
});

/** One chapter review. `finalize`'s `parameters` for the Reviewer. */
const REVIEW_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["decision", "score"],
  properties: {
    decision: { type: "string", enum: ["pass", "revise"] },
    score: { type: "number", minimum: 0, maximum: 100 },
    issues: { type: "array", items: { type: "string" } },
  },
});

/**
 * Clean a submitted chapter body.
 *
 * Three things only, each because the model does it: a fenced code block
 * wrapping the whole chapter, a repeat of the heading the assembler adds, and
 * an echoed citation manifest — which is written by code and must never be
 * writable by a model, or a chapter could mint its own provenance.
 * @param text - what the writer submitted.
 * @param heading - the chapter heading, to strip if repeated.
 * @returns the body to store.
 */
function sanitizeBody(text, heading) {
  let body = asText(text);
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/u.exec(body);
  if (fenced !== null) body = fenced[1].trim();
  body = body.replace(/<!-- mission-citations:[\s\S]*?-->/gu, "").trim();
  const first = body.split("\n", 1)[0] ?? "";
  if (/^#{1,3}\s/u.test(first) && normalisePart(first.replace(/^#{1,3}\s*/u, "")) === normalisePart(heading)) {
    body = body.slice(first.length).trim();
  }
  return body.replace(/\n{3,}/gu, "\n\n");
}

/**
 * Resolve a chapter's citations against the verified set and renumber its markers.
 *
 * G6, and the url is taken from the FINDING ROW rather than from anything the
 * model typed — the same rule `s3` learned when a quote from an arXiv abstract
 * landed attributed to a publisher with every count still correct. A marker
 * with no citation behind it is removed rather than left in place, because a
 * `[7]` that resolves to nothing reads exactly like one that does.
 * @param prose - the sanitised body.
 * @param candidates - the writer's citations, in its own order.
 * @param verifiedById - Map of finding id → verified finding row.
 * @returns `{prose, citations, dropped, unresolvedMarkers}`.
 */
function bindCitations(prose, candidates, verifiedById) {
  const citations = [];
  const oldToNew = new Map();
  let dropped = 0;
  for (const [index, candidate] of asArray(candidates).entries()) {
    const finding = verifiedById.get(asText(candidate?.findingId));
    if (finding === undefined) {
      dropped += 1;
      continue;
    }
    citations.push({
      index: citations.length + 1,
      url: finding.sourceUrl,
      findingId: finding.id,
      inlineQuote: compact(candidate?.inlineQuote, 400),
    });
    oldToNew.set(index + 1, citations.length);
  }
  let unresolvedMarkers = 0;
  const bound = prose.replace(MARKER_RE, (whole, digits) => {
    const target = oldToNew.get(Number(digits));
    if (target === undefined) {
      unresolvedMarkers += 1;
      return "";
    }
    return `[${target}]`;
  });
  // Trimmed and nothing else: collapsing runs of spaces would eat the leading
  // indentation Markdown uses for nested lists and fenced blocks.
  return { prose: bound.trim(), citations, dropped, unresolvedMarkers };
}

/** A reviewer score, coerced and clamped — local models emit `"3"` and `3.0`. */
function clampScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return REVIEWER_FAILURE_SCORE;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

/**
 * The Writer's per-chapter gate.
 * @param options - `{verifiedById, sectionType, zh}`.
 * @returns `(output) => string[]`.
 */
function checkChapter({ verifiedById, sectionType, zh }) {
  return function check(output) {
    const issues = [];
    const body = asText(output?.body);
    if (body === "") {
      issues.push(zh ? "你提交了空的正文。" : "you submitted an empty body.");
      return issues;
    }
    const citations = asArray(output?.citations);
    const unknown = citations.filter((c) => !verifiedById.has(asText(c?.findingId)));
    if (unknown.length > 0) {
      // Not an accusation: the finding ids are in the input and a mistyped one
      // is bookkeeping, not invention. The wording matters — telling a model it
      // fabricated something it did not teaches it to distrust its own correct
      // behaviour.
      issues.push(zh
        ? `有 ${unknown.length} 条引用指向了输入里没有的 finding id（${unknown.slice(0, 4).map((c) => asText(c?.findingId)).join("、")}）。只能引用「可引用的发现」一节里列出的 id。`
        : `${unknown.length} citations name finding ids that are not in the input (${unknown.slice(0, 4).map((c) => asText(c?.findingId)).join(", ")}). Only the ids listed under the citable findings may be cited.`);
    }
    if (sectionType === "evidenced" && citations.filter((c) => verifiedById.has(asText(c?.findingId))).length === 0) {
      issues.push(zh
        ? "这是证据章节，至少需要一条指向已核验发现的引用。"
        : "this is an evidenced chapter and needs at least one citation to a verified finding.");
    }
    return issues;
  };
}

/**
 * Stage eight — the chapter loop, and the one assembly.
 *
 * @param deps - the handler dependencies.
 * @returns the `s8-write` handler.
 */
export function createS8Write(deps) {
  const { store } = deps;

  return async function s8Write(context) {
    const { missionId, runCount, mission, tier, stage, crossState, budget, signal, now } = context;
    const zh = isZh(mission);
    const notes = [];
    const policy = tierPolicyOf(crossState, mission);
    const findings = store.verifiedFindings(missionId, { runCount });
    const verifiedById = new Map(findings.map((f) => [f.id, f]));
    const facts = asArray(crossState?.facts);
    let tokens = 0;

    /* ── the chapter rows, planned here only when s7 was skipped ──── */

    let rows = store.listChapters(missionId, runCount);
    if (rows.length === 0) {
      // `quick` skips s7, so the plan is made HERE — through the same
      // `planChapters` the other tiers use, so that a cheap tier does not reach
      // a terminal state by a path the expensive tiers never take.
      // One chapter per dimension that HAS evidence, with host diversity as a
      // ceiling rather than the definition.
      //
      // It was floor(uniqueHosts / 2) alone, which reads host COUNT as a proxy
      // for how much there is to say. Measured: 13 verified findings across
      // three dimensions from three hosts produced ONE chapter of 306 words,
      // and two thirds of the evidence was left on the floor because two of
      // the three hosts happened to be the same site. The number of subjects
      // worth a chapter is the number of dimensions that found something.
      const hosts = store.uniqueHosts(missionId, { runCount });
      const evidenced = new Set(findings.map((f) => f.dimensionId)).size;
      const maxChapters = Math.max(1, Math.min(evidenced, Math.max(1, hosts.length)));
      const dimensions = (asArray(crossState?.dimensions).length > 0
        ? asArray(crossState.dimensions)
        : store.listDimensions(missionId, { runCount }))
        .map((d) => ({
          dimensionId: d.dimensionId,
          name: d.name,
          rationale: d.rationale,
          verified: findings.filter((f) => f.dimensionId === d.dimensionId).length,
        }));
      if (dimensions.length === 0) {
        throw fail("input_invalid", zh
          ? "没有任何维度，无法规划章节。s2-plan 是维度的唯一写入方。"
          : "there are no dimensions, so no chapters can be planned. s2-plan is their only writer.");
      }
      const planned = planChapters({
        dimensions, facts, insights: crossState?.insights, maxChapters,
        wordFloor: policy.wordFloor,
        verifiedCount: store.countVerified(missionId, null, runCount),
        language: mission.language,
      });
      const at = now();
      for (const chapter of planned) {
        store.upsertChapter({
          missionId,
          runCount,
          dimensionId: chapter.dimensionId,
          chapterIndex: chapter.chapterIndex,
          sectionType: chapter.sectionType,
          heading: chapter.heading,
          body: null,
          wordCount: 0,
          minDelivery: chapter.minDelivery,
          underDelivered: false,
          decision: null,
          score: null,
          attempts: 0,
          inputHash: chapterInputHash({
            heading: chapter.heading,
            sectionType: chapter.sectionType,
            minDelivery: chapter.minDelivery,
            tier,
            fingerprint: promptFingerprint(deps, "writer", "chapter", runCount),
            facts: facts.filter((f) => chapter.factIds.includes(f.factId)),
          }),
          at,
        });
      }
      rows = store.listChapters(missionId, runCount);
      notes.push(zh
        ? `本档位跳过 s7-outline，章节由确定性规划器在本阶段生成（${rows.length} 章）。`
        : `this tier skips s7-outline, so the ${rows.length} chapters were planned here by the deterministic planner.`);
    }

    if (rows.length === 0) {
      throw fail("input_invalid", zh
        ? "没有任何章节行可写。s7-outline 与本阶段的规划器都没有写出章节。"
        : "there are no chapter rows to write. Neither s7-outline nor this stage's planner produced any.");
    }

    const outline = new Map(asArray(crossState?.outline).map((c) => [`${c.dimensionId}:${c.chapterIndex}`, c]));
    const allocation = crossState?.factAllocation ?? {};
    const written = [];

    // Consulted BEFORE the loop, so one read of the config and one of the prior
    // generation serve every chapter rather than one pair per chapter.
    const reuse = reusableChapters(store, { missionId, rows });
    let reused = 0;

    /* ── the loop, with all five escape hatches ───────────────────── */

    for (const row of rows) {
      // The incremental rerun's whole point: a chapter whose heading, section
      // type, delivery floor, tier, prompt fingerprint and allocated facts are
      // all unchanged cannot produce different prose, so re-writing it spends
      // the mission's budget to arrive back where it started.
      const carried = reuse.keep.get(`${row.dimensionId}#${row.chapterIndex}`);
      if (carried !== undefined) {
        store.upsertChapter({
          missionId,
          runCount,
          dimensionId: row.dimensionId,
          chapterIndex: row.chapterIndex,
          sectionType: row.sectionType,
          heading: row.heading,
          // The stored body already carries its citation manifest, so it is
          // copied whole rather than re-attached — re-attaching would append a
          // second manifest to the same chapter.
          body: carried.body,
          wordCount: carried.wordCount,
          minDelivery: row.minDelivery,
          // Carried, not recomputed: `underDelivered` is a FACT about the
          // delivery that was made, and a chapter that was short in run 2 is
          // still short in run 3. Resetting it would hide the shortfall from
          // the content guard.
          underDelivered: carried.underDelivered,
          decision: carried.decision,
          score: carried.score,
          attempts: carried.attempts,
          inputHash: row.inputHash,
          at: now(),
        });
        written.push({ heading: row.heading, opening: String(carried.body).split("\n\n", 1)[0] ?? "" });
        reused += 1;
        continue;
      }

      if (signal.aborted) {
        // The runtime classifies from the signal; ABORT_REASONS is its
        // vocabulary and nothing here re-derives it from a message.
        throw new Error(zh
          ? `任务在写作第 ${row.chapterIndex + 1} 章时被中止。`
          : `the mission was aborted while writing chapter ${row.chapterIndex + 1}.`);
      }
      if (budget?.isExhausted?.() === true) {
        notes.push(zh
          ? `预算在第 ${row.chapterIndex + 1} 章之前耗尽，共写出 ${written.length}/${rows.length} 章；未写的章节仍是空的，报告会因此被内容守卫拒签。`
          : `the budget was exhausted before chapter ${row.chapterIndex + 1}; ${written.length} of ${rows.length} chapters were written and the rest are still empty, which the content guard will refuse.`);
        break;
      }

      const planEntry = outline.get(`${row.dimensionId}:${row.chapterIndex}`) ?? null;
      // The outline carries the allocation, and `factAllocation` is the same
      // partition indexed the other way round. Reading the second one when the
      // first is absent is what makes an s8 rerun off a checkpoint that lost
      // the outline still write the chapters it was allocated.
      const chapterFacts = planEntry === null
        ? facts.filter((f) => {
          const slot = allocation[f.factId];
          return slot !== undefined && slot.dimensionId === row.dimensionId && slot.chapterIndex === row.chapterIndex;
        })
        : facts.filter((f) => asArray(planEntry.factIds).includes(f.factId));
      const citable = findings.filter((f) => f.dimensionId === row.dimensionId || chapterFacts.some((fact) => fact.findingIds.includes(f.id)));
      const citationFloor = Math.min(2, new Set(citable.map((f) => f.sourceHost)).size);
      const bindings = {
        // Read from the COLUMN, never recomputed: one number, one variable, and
        // the prompt, the gate and the accounting all read this one.
        minDelivery: row.minDelivery,
        citationFloor,
        sectionType: row.sectionType,
      };

      let body = null;
      let citations = [];
      let wordCount = 0;
      let underDelivered = true;
      let score = 0;
      let issues = [];
      let reviewerFails = 0;
      let stuckHits = 0;
      let previous = null;
      let attempts = 0;
      let decision = null;
      let landed = false;

      for (let attempt = 0; attempt < CHAPTER_ATTEMPTS && !landed; attempt += 1) {
        attempts = attempt + 1;
        const plan = fitInput(deps, stage, (rung) => [
          block(zh ? "任务" : "Mission", mission.topic),
          block(zh ? "本章" : "This chapter", `${row.heading}\n[${row.sectionType}] ${compact(planEntry?.brief, 900)}`),
          block(zh ? "本章要用的事实" : "Facts allocated to this chapter", chapterFacts.map((f) => factLine(f, true)).join("\n") || "-"),
          block(zh ? "可引用的发现" : "Citable findings", citable.map((f) => (rung >= 2
            ? `- ${f.id} | ${f.sourceHost} | ${asText(f.claim)}`
            : `- ${f.id} | ${f.sourceHost} | ${asText(f.claim)}\n  "${compact(f.evidence, rung === 1 ? 300 : QUOTE_CHARS)}"`)).join("\n") || "-"),
          block(zh ? "已完成的章节" : "Chapters already written", written.map((c) => (rung >= 2
            ? `- ${c.heading}`
            : `- ${c.heading}: ${compact(c.opening, rung === 1 ? 200 : 500)}`)).join("\n") || "-"),
          issues.length === 0 ? "" : block(zh ? "上一轮评审提出的问题" : "What the review asked for", issues.map((i) => `- ${i}`).join("\n")),
        ].join("\n"));

        const writeRun = await callAgent(deps, context, {
          agent: "writer",
          duty: "chapter",
          input: plan.text,
          bindings: { ...bindings, attempt: attempts, shrinkRung: plan.rungName },
          schema: CHAPTER_SCHEMA,
          check: checkChapter({ verifiedById, sectionType: row.sectionType, zh }),
          description: zh ? "提交本章正文与引用。" : "Submit the chapter body and its citations.",
          messageKey: `chapter-${row.dimensionId}-${row.chapterIndex}-${attempts}`,
        });
        // A writer that cannot write is not a chapter-level degradation: the
        // seam has already classified WHY (context, provider, cancellation),
        // and that code is more useful than a report with a hole in it.
        assertRun(writeRun);
        tokens += tokensOf(writeRun);

        const sanitised = sanitizeBody(writeRun.output?.body, row.heading);
        const bound = bindCitations(sanitised, writeRun.output?.citations, verifiedById);
        if (bound.dropped > 0) {
          notes.push(zh
            ? `第 ${row.chapterIndex + 1} 章有 ${bound.dropped} 条引用无法对应到已核验的发现，已删除。`
            : `chapter ${row.chapterIndex + 1} had ${bound.dropped} citations that resolved to no verified finding; they were dropped.`);
        }
        body = bound.prose;
        citations = bound.citations;
        wordCount = countWords(body);
        // A FACT, written to the column. `lengthFail` below is an ACTION, taken
        // only while retries remain — the reference marked short-but-good
        // chapters as failed and the UI then said "writing failed" for chapters
        // that scored 82.
        underDelivered = wordCount < row.minDelivery;

        if (previous !== null && textSimilarity(previous, body) > STUCK_JACCARD) stuckHits += 1;
        previous = body;

        const reviewRun = await callAgent(deps, context, {
          agent: "reviewer",
          duty: "chapter",
          input: [
            block(zh ? "任务" : "Mission", mission.topic),
            block(zh ? "本章" : "This chapter", `${row.heading}\n[${row.sectionType}]`),
            block(zh ? "正文" : "Body", body),
            block(zh ? "引用" : "Citations", citations.map((c) => `[${c.index}] ${c.findingId} ${c.url}`).join("\n") || "-"),
            block(zh ? "本章要用的事实" : "Facts allocated to this chapter", chapterFacts.map((f) => factLine(f, false)).join("\n") || "-"),
          ].join("\n"),
          bindings,
          schema: REVIEW_SCHEMA,
          check: () => [],
          description: zh ? "提交本章评审结论。" : "Submit the review of this chapter.",
          messageKey: `review-${row.dimensionId}-${row.chapterIndex}-${attempts}`,
        });
        tokens += tokensOf(reviewRun);

        let verdict;
        if (reviewRun.state === "failed" || reviewRun.output === null || reviewRun.output === undefined) {
          // Synthesised as a REVISE, never as a pass. A fake pass is how a
          // broken gate reports success.
          verdict = { decision: "revise", score: REVIEWER_FAILURE_SCORE, issues: [] };
          reviewerFails += 1;
          notes.push(zh
            ? `第 ${row.chapterIndex + 1} 章第 ${attempts} 轮评审失败（${reviewRun.diagnostic ?? reviewRun.failureCode}），按「需修改，40 分」计。`
            : `the review of chapter ${row.chapterIndex + 1} attempt ${attempts} failed (${reviewRun.diagnostic ?? reviewRun.failureCode}) and was recorded as revise at ${REVIEWER_FAILURE_SCORE}.`);
        } else {
          reviewerFails = 0;
          verdict = {
            // Fail-closed on a parse failure, and the score coerced and clamped.
            decision: reviewRun.output?.decision === "pass" ? "pass" : "revise",
            score: clampScore(reviewRun.output?.score),
            issues: asArray(reviewRun.output?.issues).map(asText).filter((i) => i !== ""),
          };
        }
        score = verdict.score;
        // Cumulative, deliberately: every round's issues stay in front of the
        // writer so it corrects rather than oscillates.
        issues = [...issues, ...verdict.issues];

        const threshold = SCORE_THRESHOLDS[Math.min(attempt, SCORE_THRESHOLDS.length - 1)];
        const attemptsExhausted = attempt === CHAPTER_ATTEMPTS - 1;
        const reviewerExhausted = reviewerFails >= REVIEWER_FAIL_LIMIT;
        const stuck = stuckHits >= STUCK_REPEATS;
        const good = verdict.decision === "pass" || score >= threshold;

        if (!underDelivered && (good || attemptsExhausted || reviewerExhausted || stuck)) {
          landed = true;
          decision = good ? "passed" : "fallback-exhausted";
        } else if (attemptsExhausted || reviewerExhausted || stuck) {
          landed = true;
          // The delivery gate owns word count, so a short chapter lands as
          // `fallback-length` — a fact about the delivery, not a verdict on the
          // prose, which may well have scored 82.
          decision = underDelivered ? "fallback-length" : "fallback-exhausted";
        }
      }

      if (decision === null) decision = underDelivered ? "fallback-length" : "fallback-exhausted";
      if (!CHAPTER_DECISIONS.includes(decision)) decision = "fallback-exhausted";
      if (underDelivered) {
        notes.push(zh
          ? `第 ${row.chapterIndex + 1} 章 ${wordCount} 字，低于本章下限 ${row.minDelivery} 字。`
          : `chapter ${row.chapterIndex + 1} came in at ${wordCount} words against its floor of ${row.minDelivery}.`);
      }

      store.upsertChapter({
        missionId,
        runCount,
        dimensionId: row.dimensionId,
        chapterIndex: row.chapterIndex,
        sectionType: row.sectionType,
        heading: row.heading,
        body: attachManifest(body ?? "", citations),
        wordCount,
        minDelivery: row.minDelivery,
        underDelivered,
        decision,
        score,
        attempts,
        inputHash: row.inputHash,
        at: now(),
      });
      written.push({ heading: row.heading, opening: (body ?? "").split("\n\n", 1)[0] ?? "" });
    }

    // Narrated whenever an incremental rerun was asked for, INCLUDING when it
    // kept nothing: "reused 0 of 6 because the prompt changed" and "reused 6 of
    // 6" are both useful, and a silent zero is indistinguishable from a reuse
    // path that is not wired at all — which is what it was.
    if (reuse.why.startsWith("run ")) {
      notes.push(zh
        ? `增量重跑：从${reuse.why.replace("run ", "第 ")} 次运行沿用了 ${reused}/${rows.length} 章，其余重写。`
        : `incremental rerun: ${reused} of ${rows.length} chapters were carried forward from ${reuse.why} and the rest rewritten.`);
    }

    /* ── assembly, by code, on every path ─────────────────────────── */

    const finalRows = store.listChapters(missionId, runCount);
    const report = assemble(finalRows);
    if (report.unresolvedMarkers > 0) {
      notes.push(zh
        ? `装配时删除了 ${report.unresolvedMarkers} 个没有对应引用的 [N] 标记。`
        : `${report.unresolvedMarkers} inline [N] markers with no citation behind them were removed at assembly.`);
    }
    if (report.citations.length === 0) {
      notes.push(zh
        ? "全文没有任何可用引用。内容守卫会因此拒签这份报告。"
        : "the assembled report carries no usable citations at all, which the content guard refuses.");
    }

    const chapters = finalRows.map((c) => ({
      dimensionId: c.dimensionId,
      chapterIndex: c.chapterIndex,
      wordCount: c.wordCount,
      decision: c.decision,
      score: c.score,
      underDelivered: c.underDelivered,
    }));
    const degraded = notes.length > 0;

    return {
      output: {
        chapters: chapters.length,
        wordCount: report.wordCount,
        citations: report.citations.length,
        sections: report.sections.length,
        underDelivered: chapters.filter((c) => c.underDelivered).length,
      },
      degraded,
      degradeNote: degraded ? notes.join(" ") : undefined,
      tokens,
      crossPatch: {
        chapters,
        // Counts and hashes only. The markdown is NEVER in crossState: it is
        // re-derived by `assemble(store.listChapters(...))`, which is
        // deterministic, and a 25,000-word document here is that document
        // written into the checkpoint after every one of the twelve stages.
        report: { title: mission.topic, wordCount: report.wordCount, markdownHash: sha256Hex(report.markdown) },
        sections: { count: report.sections.length, hash: sha256Hex(JSON.stringify(report.sections)) },
        citations: { count: report.citations.length },
      },
    };
  };
}
