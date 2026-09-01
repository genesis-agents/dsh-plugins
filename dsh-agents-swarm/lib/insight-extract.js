/**
 * 洞察: the model calls, and the pass that drives them.
 *
 * Everything else in this feature is arithmetic. `insights.js` shingles,
 * clusters, verifies and scores without touching the clock or the network;
 * `insight-store.js` is SQL. This module is where tokens get spent, so it is
 * where the guards live: a cost ceiling that is a setting rather than a hope,
 * a quote check that discards a whole claim rather than repairing it, and a
 * run record that says what happened even when the answer was "nothing".
 *
 * Two model calls, both narrow. Stage ③ asks one cluster of sources for at
 * most three claims with a verbatim quote behind every one. Stage ⑤ asks a
 * one-word question about two statements. Nothing else calls a model, and the
 * per-run count of both is bounded by a number a person can read on the
 * settings page.
 *
 * `chat` and the stores arrive as parameters and no global is imported, the
 * rule podcast.js and translate.js already follow, so the whole pipeline can
 * be exercised with a fake async generator and an in-memory database.
 *
 * ── deliberate deviation from docs/insights.md ──────────────────────────
 * The plan says the pipeline "runs on the collection tick that already
 * exists". It does not: this module starts its OWN 60-second tick with its
 * own interval. Two reasons. The collection tick is hourly and fixed, while
 * the useful insight cadence is a setting somebody tunes in week one; and a
 * pass costs twenty model calls, so it must be armable and disarmable without
 * also turning collection off. The cost is a read/write race with the
 * collection timer over the settings table — both write through `setSetting`,
 * which is one synchronous statement, and they write different keys, so the
 * race is between two unrelated values and neither loses. What it is NOT safe
 * against is a second insight pass: hence the `running` flag in
 * {@link startInsightTimer}, without which one due window launches sixty
 * overlapping passes all reading the same watermark.
 */

import { assembleMaterial, detectLanguage } from "./podcast.js";
import { localDate } from "./publish-schedule.js";
import { EVIDENCE_STANCES, INSIGHT_KINDS } from "./insight-store.js";
import { corroborateOne } from "./insight-corroborate.js";
import {
  MIN_QUOTE_CHARS,
  MIN_QUOTE_CJK_CHARS,
  clusterItems,
  itemForRow,
  nextStatus,
  scoreInsight,
  simhash,
  sourceKeyOf,
  statementsMatch,
  verifyQuote,
} from "./insights.js";

/** How often the clock is consulted for a due pass. */
const TICK_MS = 60_000;

/**
 * Rows `store.query` will return in one page.
 *
 * Not a preference: store.js clamps `take` to 100 and says nothing about it.
 * Asking for 200 returns 100, so a pass configured to read 200 rows past the
 * watermark read half of them, moved the watermark past the newest one, and
 * never came back for the rest — a backlog that grew every day while every
 * number on the status page looked healthy. Hence paging.
 */
const QUERY_PAGE = 100;

/**
 * How stale a stored score may be before the sweep recomputes it.
 *
 * Given its own basis rather than the pass interval, which was the obvious
 * reading and is wrong at both ends. With `insightIntervalMinutes: 0` — the
 * default, and the whole of P1 — a horizon of "now minus the interval" is
 * "now", so every non-dormant insight is due on every manual run and one
 * button press becomes two hundred `listEvidence` round trips. At the other
 * end a daily interval would let novelty decay a whole day between sweeps.
 * A day is the right horizon because novelty decays over `insightWindowDays`,
 * which is measured in days.
 */
const RESCORE_AFTER_MINUTES = 24 * 60;

/** Insights the sweep rescores in one pass, on top of the ones it touched. */
/**
 * How long a claim is left alone after a corroboration attempt.
 *
 * A day. The stage fetches whole pages, and a claim nobody else has
 * written about will find nothing again in an hour — retrying every pass is
 * how a background job becomes a bill for the same negative answer.
 */
const CORROBORATE_AFTER_MINUTES = 24 * 60;

const RESCORE_SWEEP = 200;

/**
 * Characters of extraction answer accepted before the stream is abandoned.
 *
 * Three claims with their quotes is a few thousand characters. The bound is
 * not about long answers but about a model that starts repeating and does not
 * stop, inside a pass that holds no request open to time out — an unbounded
 * accumulation there takes the process down rather than failing one cluster.
 */
const MAX_ANSWER_CHARS = 400_000;

/** Characters of adjudication answer read before the rest is ignored. */
const MAX_VERDICT_CHARS = 8_000;

/** Candidate JSON objects tried before an answer is given up on. */
const MAX_OBJECT_SCANS = 8;

/**
 * Longest statement accepted as "one sentence".
 *
 * Generous — a precise English claim naming an actor, a figure and a date runs
 * to 250 characters — but bounded, because the failure it catches is a model
 * that answers with a paragraph in the statement field. That paragraph would
 * shingle, hash, store and rank exactly like a claim, and only a reader would
 * ever notice the card was an essay.
 */
const MAX_STATEMENT_CHARS = 600;

/** Claims kept from one answer, matching the prompt's own cap. */
const MAX_CLAIMS = 3;

/** New rows a pass needs before it is worth its model calls. */
const MIN_PASS_ROWS = 2;

/**
 * Defaults for every insight field, so an unset store still reads whole.
 *
 * `insightIntervalMinutes: 0` means the pass is OFF until somebody arms it. A
 * pass that starts spending model calls the moment the plugin is updated is a
 * bill nobody agreed to; arming it is a decision.
 *
 * `insightResourceTypes` holds RESOURCE_TYPES values — NEWS, PAPER — and is
 * deliberately not called `insightKinds`: `kind` in this feature means the
 * CLAIM kind (launch, funding, policy, finding, shift), and both vocabularies
 * are plain strings. Wiring the claim kinds in where the resource types belong
 * scores relevance 0 on every card for ever, on a 15% weight, and throws
 * nothing — the ranking stays plausible and is quietly wrong.
 *
 * YOUTUBE_VIDEO IS FIRST, AND IT USED TO BE ABSENT. Nothing here said why —
 * there was no note, no test and no argument, and the rest of the pipeline was
 * plainly built to read them: `sourceMaterial` takes a transcript beside the
 * row and carries its own comment about a video carrying no summary, so the
 * budget has to favour the transcript. The type list simply did not name them,
 * and 523 videos went unread while the pass mined abstracts.
 *
 * It leads the list because a talk is the one source type that can say WHERE a
 * sentence came from. A paper's citation is the paper; a video's is the
 * second, and the second is computable — insight-moment.js matches the quote
 * against the stored cues, so a claim off an interview carries `▶ 38:08` that
 * opens the video where the sentence starts. No other type can do that, which
 * makes videos the type this feature is most worth pointing at, not the one to
 * leave out.
 */
export const INSIGHT_DEFAULTS = {
  insightIntervalMinutes: 0,
  insightResourceTypes: ["YOUTUBE_VIDEO", "NEWS", "BLOG", "PAPER", "REPORT", "POLICY"],
  insightMaxRows: 200,
  insightMaxClusters: 20,
  insightMaxReconcileCalls: 10,
  insightMinIndependent: 2,
  insightWindowDays: 7,
  insightDormantDays: 21,
  insightDuplicateBits: 3,
  insightChinese: false,
  // How many candidate claims go out and search per pass. Zero turns the
  // search stage off entirely; it is the only stage that fetches whole pages,
  // so it is the one worth being able to switch off without switching off the
  // pass.
  insightCorroborateClaims: 3,
};

/**
 * Read the insight section, filling defaults.
 * @param store - the source library.
 * @returns the settings, whole, plus the two run records.
 */
export function readInsightConfig(store) {
  return {
    insightIntervalMinutes: store.getSetting("insightIntervalMinutes", INSIGHT_DEFAULTS.insightIntervalMinutes),
    insightResourceTypes: store.getSetting("insightResourceTypes", INSIGHT_DEFAULTS.insightResourceTypes),
    insightMaxRows: store.getSetting("insightMaxRows", INSIGHT_DEFAULTS.insightMaxRows),
    insightMaxClusters: store.getSetting("insightMaxClusters", INSIGHT_DEFAULTS.insightMaxClusters),
    insightMaxReconcileCalls: store.getSetting("insightMaxReconcileCalls", INSIGHT_DEFAULTS.insightMaxReconcileCalls),
    insightMinIndependent: store.getSetting("insightMinIndependent", INSIGHT_DEFAULTS.insightMinIndependent),
    insightWindowDays: store.getSetting("insightWindowDays", INSIGHT_DEFAULTS.insightWindowDays),
    insightDormantDays: store.getSetting("insightDormantDays", INSIGHT_DEFAULTS.insightDormantDays),
    insightDuplicateBits: store.getSetting("insightDuplicateBits", INSIGHT_DEFAULTS.insightDuplicateBits),
    insightChinese: store.getSetting("insightChinese", INSIGHT_DEFAULTS.insightChinese),
    insightCorroborateClaims: store.getSetting("insightCorroborateClaims", INSIGHT_DEFAULTS.insightCorroborateClaims),
    insightLastRun: store.getSetting("insightLastRun", null),
    insightLastManualRun: store.getSetting("insightLastManualRun", null),
  };
}

/** A configured number, coerced and bounded, falling back when it is not a number at all. */
function bounded(value, low, high, fallback) {
  const asked = Number(value);
  if (!Number.isFinite(asked)) return fallback;
  return Math.max(low, Math.min(high, Math.round(asked)));
}

/**
 * The resource types a pass reads, never empty.
 *
 * An empty list would make every pass skip with "too little material" while
 * the settings page looked correctly configured. index.js rejects an empty
 * array on the way in; this is the second line, for a library written by an
 * older build or edited by hand.
 * @param config - the insight settings.
 * @returns type strings, at least one.
 */
function resourceTypesOf(config) {
  const types = config.insightResourceTypes;
  if (!Array.isArray(types)) return INSIGHT_DEFAULTS.insightResourceTypes;
  const usable = types.filter((type) => typeof type === "string" && type.trim() !== "");
  return usable.length === 0 ? INSIGHT_DEFAULTS.insightResourceTypes : usable;
}

/**
 * An ISO instant shifted by some minutes.
 *
 * Throws rather than falling back to the present when the input does not
 * parse. A fallback here would read the clock inside a function every caller
 * hands a pinned `now`, and the one test that matters — that novelty decays —
 * would pass against a value it never used.
 * @param iso - the base instant.
 * @param minutes - minutes to add; negative goes back.
 * @returns the shifted instant, ISO 8601.
 */
function shiftIso(iso, minutes) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    throw new Error(`insight pass was given an unreadable instant: ${JSON.stringify(iso)}`);
  }
  return new Date(at + minutes * 60_000).toISOString();
}

/**
 * The rows a pass should read, and how many it had to leave behind.
 *
 * Newest first, only rows the library learned about since the last pass, one
 * paged query per configured type. Per-type rather than one query over
 * everything for `pickSources`' reason: a day of NEWS runs to hundreds of rows
 * and would crowd out every paper.
 *
 * The paging is the part that matters. `store.query` clamps a page to 100, so
 * one call per type silently capped the pass at 100 rows per type and then
 * moved the watermark past every row it had not read. Here each type is paged
 * until a row at or below the watermark appears — everything after it is older
 * still, because the query is sorted by `createdAt` descending — or until the
 * pass's own ceiling is reached.
 *
 * `backlog` is what the pass read and then dropped for the ceiling, and
 * `truncated` says the scan stopped before it knew there was no more. Both are
 * reported rather than swallowed: rows below the cap are never read again once
 * the watermark moves past them, which is a deliberate trade copied from
 * `publishOnce`, and a trade nobody can judge from a number that only ever
 * counts what was kept.
 * @param store - the source library.
 * @param config - the insight settings.
 * @returns `{ rows, backlog, truncated }`.
 */
export function collectCandidates(store, config) {
  const types = resourceTypesOf(config);
  // A VIDEO WE HOLD NO TRANSCRIPT FOR IS A TITLE AND A BLURB.
  //
  // `sourceMaterial` builds a video's block out of its transcript — its own
  // comment says a video row carries no summary, which is why the budget has
  // to favour one. Without it the block is the title and whatever the feed
  // put in the description, and the pass is asked to extract a standing
  // claim, with a verbatim quote, out of a blurb. It costs a slot in the
  // ceiling, produces nothing worth keeping, and can carry no moment.
  //
  // Measured on this library: 523 videos, 23 transcripts. Without this the
  // first pass over videos reads 200 rows of which about nine have anything
  // to quote.
  const TIMED = new Set(["YOUTUBE_VIDEO", "YOUTUBE", "VIDEO", "PODCAST"]);
  const quotable = (row) => {
    if (!TIMED.has(String(row?.type ?? "").toUpperCase())) return true;
    if (typeof store.getTranscript !== "function") return true;
    try { return (store.getTranscript(row.id)?.text ?? "") !== ""; } catch { return false; }
  };
  const cap = bounded(config.insightMaxRows, 20, 600, INSIGHT_DEFAULTS.insightMaxRows);
  const since = typeof config.insightLastRun?.watermark === "string" ? config.insightLastRun.watermark : "";

  // OLDEST first, filtered in SQL.
  //
  // The scan used to page newest-first and stop after `cap` rows, then sort and
  // slice. Both halves pointed the same way and the result was that the pass
  // took the NEWEST rows and set its watermark to the newest of those — making
  // every older row `<= since` for ever. Measured on a real 20,708-row library
  // with an empty watermark: 200 rows read, 20,508 never read and no longer
  // readable, reported as `backlog: 800` because backlog counted only what the
  // scan happened to page in, understating the loss twenty-five fold.
  //
  // Draining from the bottom walks forward instead. The backlog empties `cap`
  // rows per pass and the steady state is identical, because a day's hundred
  // rows are the same hundred rows either way.
  // GATHERED PER TYPE, AND KEPT PER TYPE.
  //
  // This gathered by type and then sorted the lot by `createdAt` and sliced
  // to `cap` — which threw the per-type work away entirely, because after
  // that sort the oldest rows win outright whatever type they are.
  //
  // MEASURED, and it is not a rounding error. A transcript is fetched when
  // somebody opens a video, so a transcribed video is recent by
  // construction; this library's 23 of them are from the last fortnight and
  // the watermark is still in December. Sorted globally they land at the end
  // of a 27,839-row queue and are sliced off every single pass — 139 passes
  // before the first one is read. The type list said videos were first and
  // the slice said they were last.
  const byType = new Map();
  let truncated = false;
  for (const type of types) {
    const held = [];
    let taken = 0;
    let skip = 0;
    for (;;) {
      const page = store.query({
        type,
        sortBy: "createdAt",
        sortOrder: "asc",
        createdAfter: since === "" ? undefined : since,
        take: QUERY_PAGE,
        skip,
      });
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        // SKIPPED, NOT COUNTED. A skipped row must not spend the ceiling —
        // otherwise a library of untranscribed videos fills 200 slots with
        // rows the extractor cannot use and the pass reads nothing else.
        if (!quotable(row)) continue;
        held.push(row);
        taken += 1;
        if (taken >= cap) break;
      }
      if (taken >= cap) {
        // Stopped at the ceiling with the query still offering rows: there is
        // more waiting than this pass will look at, and nothing downstream
        // could work that out from the rows it was handed.
        if (page.hasMore) truncated = true;
        break;
      }
      if (!page.hasMore) break;
      skip += page.rows.length;
    }
    if (held.length > 0) byType.set(type, held);
  }

  // AN EVEN SHARE FIRST, THEN THE LEFTOVERS BY AGE.
  //
  // Oldest-first WITHIN a type is what stops a row being stranded for ever,
  // and that is kept — each type hands over its own oldest. Across types the
  // share is equal, so a type with 23 candidates contributes all 23 rather
  // than losing every one of them to a type with twenty thousand.
  //
  // The remainder is filled by age, so a quiet type does not hold slots it
  // has nothing to put in them.
  const byAge = (left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
  for (const held of byType.values()) held.sort(byAge);
  const share = Math.max(1, Math.ceil(cap / Math.max(1, byType.size)));
  const rows = [];
  const rest = [];
  for (const held of byType.values()) {
    rows.push(...held.slice(0, share));
    rest.push(...held.slice(share));
  }
  rows.sort(byAge);
  rest.sort(byAge);
  while (rows.length < cap && rest.length > 0) rows.push(rest.shift());
  rows.length = Math.min(rows.length, cap);
  rows.sort(byAge);
  const fresh = [...rows, ...rest];

  // The true backlog, not the part this scan saw.
  let backlog = Math.max(0, fresh.length - rows.length);
  if (rows.length > 0 && typeof store.countCreatedSince === "function") {
    const edge = String(rows[rows.length - 1].createdAt ?? "");
    try {
      // `countCreatedSince` is `>=`, so rows sharing the edge instant are
      // counted although this pass already took them. Subtracting them keeps
      // the number an answer to "how many are still waiting" rather than "how
      // many are at or after the boundary", which differ by exactly the rows a
      // reader would then watch never disappear.
      const atEdge = rows.filter((row) => String(row.createdAt ?? "") === edge).length;
      const counted = store.countCreatedSince(edge);
      if (Number.isFinite(counted)) backlog = Math.max(0, counted - atEdge);
    } catch {
      // A store without the helper keeps the scan-local estimate, which is a
      // lower bound — `truncated` already says the slice was capped.
    }
  }
  return { rows, backlog, truncated };
}

/**
 * The rows a pass should read.
 *
 * The thin array-returning face of {@link collectCandidates}, because
 * `/insights/status` reports `pickCandidates(store, config).length` as what
 * the next pass would read. A status route wanting the backlog as well should
 * call `collectCandidates` and read both from one scan.
 * @param store - the source library.
 * @param config - the insight settings.
 * @returns rows, newest first.
 */
export function pickCandidates(store, config) {
  return collectCandidates(store, config).rows;
}

/**
 * What each detected language is called, in the prompt's own language.
 *
 * A duplicate of the table in documents.js, which keeps its own copy
 * module-private. Duplicated rather than left out because "write in zh" is not
 * an instruction a model follows as reliably as "write in Simplified Chinese",
 * and duplicated rather than imported because there is nothing exported to
 * import. If a language is added there, add it here too: the two tables
 * drifting costs a prompt written in the wrong language, which surfaces as
 * claims a reader cannot match to the sources under them.
 */
const LANGUAGE_NAMES = {
  zh: "Simplified Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
};

/**
 * The stage ③ instruction block, with exactly two placeholders.
 *
 * `{LANGUAGE}` and `{SOURCES}`, and {@link buildExtractionPrompt} asserts that
 * neither survives substitution. A constant rather than a template literal
 * buried in a function so that softening the quote rule shows up as a diff in
 * review — that rule is the only thing standing between provenance and
 * decoration, and it is the line most likely to be relaxed by accident.
 */
export const EXTRACTION_PROMPT = [
  "You are extracting standing CLAIMS from a group of sources that all cover the same story.",
  "",
  "A claim is one sentence that somebody could look up and find to be WRONG. \"AI is advancing rapidly\" is not a claim — nobody can disagree with it, so it tells a reader nothing. \"Anthropic raised $3.5bn at a $61.5bn valuation in March 2025\" is a claim: it names who, what, how much and when, and a reader who knows better can say so. Specific enough to be wrong is the whole test. Apply it to every sentence you are about to write, and delete the ones that fail.",
  "",
  "Rules for the statement:",
  "- One sentence. Name the actor, the thing, and the number or the date wherever the sources give them.",
  "- Write what the sources ESTABLISH, not what they speculate about. Where the only thing on offer is speculation, name who is speculating and say that it is speculation.",
  "- Never assert something no source below says. You are not adding what you already know; nothing you know is evidence here.",
  "- Never round or tidy a figure a source states precisely.",
  "- Write the statement in {LANGUAGE}.",
  "",
  `Return AT MOST ${MAX_CLAIMS} claims, and fewer is normal — most stories carry one. If these sources establish nothing specific enough to be wrong, return {"claims": []}. An empty answer is a correct answer and is far better than a vague one.`,
  "",
  "Every claim must carry its evidence: the sources supporting it, and for each one a quote.",
  "",
  "THE QUOTE RULE, which is not negotiable:",
  "Each quote must be copied CHARACTER FOR CHARACTER out of the source block you attribute it to. Do not translate it. Do not tidy the grammar, expand an abbreviation, correct a typo, or join text from two places with an ellipsis. Copy one continuous run, at least a full clause long.",
  "Copy it out of that source's BODY TEXT — the prose below the header lines. The \"## title\", \"Publication:\", \"Authors:\", \"Date:\" and \"URL:\" lines at the top of each block are labels this program wrote from its own records, not words the source published, so a quote taken from them is rejected.",
  `A quote must be at least ${MIN_QUOTE_CHARS} characters long, or at least ${MIN_QUOTE_CJK_CHARS} characters when it is written in Chinese, Japanese or Korean. Anything shorter is a substring of almost any text and proves nothing, so it is rejected too.`,
  "The program reading your answer checks every quote by searching for it as a literal substring of that source's block. A quote it cannot find there is treated as invented, and THE WHOLE CLAIM IS DISCARDED — not corrected, not partially kept, discarded. A quote that appears in a different source than the one you named is a misattribution and the claim is discarded for that too. So a claim you cannot support with text you actually copied is a claim you should not return.",
  "",
  "Attribute every quote to a source by its bracketed label — [S1], [S2] — exactly as it appears below. Never invent a label, and never identify a source by its title, its URL, or a number of your own.",
  "",
  "Where a source DISAGREES with the claim, include it too, with \"stance\": \"contradicts\" and a quote copied the same way. Two of these sources disagreeing is the most valuable thing you can find here: do not average it away, do not pick a side, and do not leave it out.",
  "",
  "\"kind\" is exactly one of:",
  "  launch  — something shipped, was released, or became available",
  "  funding — money raised, invested, committed, or valued",
  "  policy  — a rule, a law, a regulatory action, an official position",
  "  finding — a measured, benchmarked, or reported result",
  "  shift   — a change of direction, position, or strategy",
  "Pick the closest one.",
  "",
  "\"entities\" — the two to five proper names the claim is about: companies, models, laboratories, agencies, people. Spelled as the sources spell them.",
  "",
  "Return ONE JSON object and nothing else. No prose before it, no prose after it, no code fence:",
  "",
  "{\"claims\":[{\"statement\":\"<one sentence, specific enough to be wrong>\",\"kind\":\"finding\",\"entities\":[\"…\",\"…\"],\"evidence\":[{\"source\":\"S1\",\"stance\":\"supports\",\"quote\":\"<copied character for character out of [S1]>\"},{\"source\":\"S3\",\"stance\":\"contradicts\",\"quote\":\"<copied character for character out of [S3]>\"}]}]}",
  "",
  "--- SOURCES ---",
  "{SOURCES}",
].join("\n");

/**
 * Whether a row carries a title `sourceMaterial` will accept.
 *
 * This is podcast.js's `firstText(row.title) !== ""` rule spelled out, and it
 * has to match it exactly. `String(row.title).trim() !== ""` looks equivalent
 * and is not: a numeric title passes it while `sourceMaterial` still rejects
 * the row, which fires the label/block assertion below on a legitimate
 * cluster — an alarm going off at the one place it was meant to guard.
 * @param row - a stored `Resource`.
 * @returns whether the row will produce a material block.
 */
function hasUsableTitle(row) {
  return typeof row?.title === "string" && row.title.trim() !== "";
}

/**
 * Build the stage ③ prompt for one cluster.
 *
 * `assembleMaterial` is reused rather than reinvented so a cluster of ten
 * sources gets the same evenly-divided per-source budget an episode does and
 * one long paper cannot eat the window.
 *
 * The load-bearing guard is the alignment assertion. `assembleMaterial` DROPS
 * any entry whose row has no usable title, so its `blocks` array is not
 * index-aligned with the entries handed in. Labelling by position across that
 * gap attaches every later quote to the wrong source — the quote still
 * verifies, every count is still right, and the card cites the wrong outlet.
 * So the entries are pre-filtered by `assembleMaterial`'s own rejection rule
 * and then the two lengths are asserted equal. Never `slice` them into
 * agreement: that is the same wrong-source bug with the alarm switched off.
 *
 * `blocks` holds the EXACT labelled text each source went into the prompt as,
 * header included. Stripping the header here — so that a quote lifted from the
 * `## title` line cannot verify against the library's own metadata — was the
 * obvious thing to do and is the wrong place to do it: `verifyQuote` already
 * excludes the header, and only when the block actually looks like one of
 * `sourceMaterial`'s. Cutting at the first blank line here as well would take
 * a second bite out of any body whose own first paragraph is a heading, and
 * every honest quote from it would then read as invented.
 * @param cluster - a cluster from `clusterItems`; `members` is read only to check the entries belong to it.
 * @param options - `{ zh, entries }`, `entries` being `[{ row, transcript }]` for this cluster's members.
 * @returns `{ prompt, labels, blocks }`.
 */
export function buildExtractionPrompt(cluster, options = {}) {
  const entries = Array.isArray(options.entries) ? options.entries : undefined;
  if (entries === undefined) {
    throw new Error("buildExtractionPrompt needs options.entries as [{ row, transcript }]; a cluster carries item summaries, not stored rows");
  }

  const usable = entries.filter((entry) => hasUsableTitle(entry?.row));
  if (usable.length === 0) {
    throw new Error("this cluster carries no source with a usable title, so there is nothing to quote from");
  }

  const ids = usable.map((entry) => String(entry.row.id));
  if (new Set(ids).size !== ids.length) {
    // Two entries for one resource give that id two labels, and the second
    // overwrites the first in `labels`. Every quote attributed to the lost
    // label then resolves to whichever source happened to win.
    throw new Error("this cluster lists the same resource twice; each source needs exactly one label");
  }
  if (Array.isArray(cluster?.members) && cluster.members.length > 0) {
    const members = new Set(cluster.members.map((member) => String(member?.id)));
    const stray = ids.find((id) => !members.has(id));
    if (stray !== undefined) {
      throw new Error(`entry ${stray} is not a member of cluster ${cluster.id ?? "(unnamed)"}; the prompt would quote a source this cluster is not about`);
    }
  }

  let assembled;
  try {
    assembled = assembleMaterial(usable);
  } catch (cause) {
    // `assembleMaterial` throws in an episode's vocabulary ("an episode needs
    // at least one source"). Letting that surface from the insight pass sends
    // whoever reads the log to the wrong module entirely.
    throw new Error(`insight extraction could not assemble material: ${String(cause?.message ?? cause)}`);
  }
  const { blocks, material } = assembled;
  if (blocks.length !== usable.length) {
    throw new Error(`source labels and material blocks disagree (${usable.length} vs ${blocks.length}); podcast.js sourceMaterial has started rejecting rows for a new reason`);
  }

  const labels = new Map();
  const blocksForQuotes = new Map();
  const labelled = blocks.map((block, index) => {
    const label = `S${index + 1}`;
    const id = ids[index];
    labels.set(label, id);
    const text = `[${label}]\n${block}`;
    blocksForQuotes.set(id, text);
    return text;
  });

  // Named in full — "Simplified Chinese", never "zh" — exactly as documents.js
  // does, and detected over the MATERIAL rather than the prompt, whose
  // instructions are English and would make every cluster look English.
  const language = options.zh === true
    ? LANGUAGE_NAMES.zh
    : LANGUAGE_NAMES[detectLanguage(material)] ?? LANGUAGE_NAMES.en;

  // Function replacements, not strings: source material contains `$`, and a
  // string replacement reads `$&` or `$'` in it as a back-reference and
  // silently rewrites the very block the quotes are checked against.
  const prompt = EXTRACTION_PROMPT
    .replace("{LANGUAGE}", () => language)
    .replace("{SOURCES}", () => labelled.join("\n\n"));
  if (prompt.includes("{LANGUAGE}") || prompt.includes("{SOURCES}")) {
    throw new Error("EXTRACTION_PROMPT still holds an unsubstituted placeholder; the model would be shown the template instead of the sources");
  }

  return { prompt, labels, blocks: blocksForQuotes };
}

/**
 * The index of the brace closing the one at `start`, honouring string literals.
 *
 * The same technique podcast.js uses and for the same reason: counting braces
 * without tracking strings breaks on the first quote containing one, and a
 * quote copied out of a source about JSON or APIs contains plenty. Written
 * here rather than imported because podcast.js keeps its copy module-private.
 * @param source - the answer being scanned.
 * @param start - index of the opening brace.
 * @returns the closing index, or -1 when the object never closes.
 */
function matchingBrace(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < source.length; at += 1) {
    const char = source[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/**
 * The object carrying the most claims out of a model answer.
 *
 * Not the first parseable object. A model that restates the schema before
 * answering emits the prompt's own example, and that example parses,
 * validates and survives every check downstream — a card whose statement is
 * "<one sentence, specific enough to be wrong>", indistinguishable from a real
 * one until a person reads it. A schema echo is never the long one, so the
 * longest `claims` array wins.
 *
 * The tie-break is `>=`, taking the LAST of equal-length candidates, and it is
 * not cosmetic. The prompt's own example carries one claim and most real
 * answers carry one claim, so the tie is the COMMON case, and a first-wins
 * rule hands it to the echo every time — the pass then throws the real answer
 * away and stores the template. Restating the schema before answering is the
 * shape models produce; appending it afterwards is not.
 * @param text - the model's answer.
 * @returns the parsed object, or undefined when none carries a `claims` array.
 */
function extractClaimsObject(text) {
  const source = String(text ?? "");
  let best;
  let from = 0;
  for (let attempt = 0; attempt < MAX_OBJECT_SCANS; attempt += 1) {
    const start = source.indexOf("{", from);
    if (start === -1) break;
    const end = matchingBrace(source, start);
    if (end !== -1) {
      try {
        const parsed = JSON.parse(source.slice(start, end + 1));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.claims)) {
          if (best === undefined || parsed.claims.length >= best.claims.length) best = parsed;
        }
      } catch {
        // Not the object being looked for; the next candidate may be.
      }
    }
    from = start + 1;
  }
  return best;
}

/** The proper names a claim is about, cleaned, at most six. */
function readEntities(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entity) => typeof entity === "string" && entity.trim() !== "")
    .map((entity) => entity.trim())
    .slice(0, 6);
}

/**
 * Read the claims out of a model answer.
 *
 * Strict in `parseScript`'s spirit — half an answer is worse than none — with
 * one deliberate exception: `{"claims": []}` is a VALID answer and returns [].
 * The prompt promises an empty answer is acceptable, and treating it as a
 * parse failure would teach the model to manufacture claims.
 *
 * An EMPTY answer STRING is not that. It is a stream that yielded nothing,
 * which is what a mis-read chunk shape or a silently refused call looks like,
 * and returning [] for it would report `ran: true, claims: 0` for ever with no
 * error anywhere. So it throws.
 *
 * A single unusable claim is dropped rather than throwing, because one bad
 * claim is no reason to lose the two beside it — but it is reported through
 * `options.onReject`, since a silent drop here is indistinguishable from a
 * model that honestly found nothing.
 * @param answer - the accumulated model answer.
 * @param labels - label → resourceId, from {@link buildExtractionPrompt}.
 * @param options - `{ onReject }`, called with a reason for each dropped claim.
 * @returns claims as `{ statement, kind, entities, evidence: [{ label, resourceId, stance, quote }] }`.
 */
export function parseClaims(answer, labels, options = {}) {
  const source = String(answer ?? "").trim();
  if (source === "") throw new Error("the model returned an empty answer");
  const reject = typeof options.onReject === "function" ? options.onReject : () => {};

  const object = extractClaimsObject(source);
  if (object === undefined) {
    const hint = source.includes("{")
      ? "no JSON object in it carries a \"claims\" array, which is what prose wrapped around a refusal looks like"
      : "it contains no JSON object at all";
    throw new Error(`the model did not return claims: ${hint}`);
  }

  const claims = [];
  for (const [index, raw] of object.claims.entries()) {
    const at = index + 1;
    const statement = typeof raw?.statement === "string" ? raw.statement.trim() : "";
    if (statement === "") { reject(`claim ${at} has no statement`); continue; }
    if (statement.length > MAX_STATEMENT_CHARS) {
      reject(`claim ${at} runs to ${statement.length} characters; a claim is one sentence, so at most ${MAX_STATEMENT_CHARS}`);
      continue;
    }
    const kind = typeof raw?.kind === "string" ? raw.kind.trim().toLowerCase() : "";
    if (!INSIGHT_KINDS.includes(kind)) {
      reject(`claim ${at} names kind ${JSON.stringify(raw?.kind ?? null)}; expected one of ${INSIGHT_KINDS.join(", ")}`);
      continue;
    }
    if (!Array.isArray(raw?.evidence) || raw.evidence.length === 0) {
      reject(`claim ${at} carries no evidence array`);
      continue;
    }

    const evidence = [];
    let fault = "";
    for (const [position, row] of raw.evidence.entries()) {
      const label = typeof row?.source === "string" ? row.source.trim() : "";
      const resourceId = labels.get(label);
      if (resourceId === undefined) {
        // A label the prompt never offered cannot be resolved to a source, and
        // guessing which one was meant is exactly how a quote ends up printed
        // under somebody else's name.
        fault = `claim ${at} evidence ${position + 1} names source ${JSON.stringify(row?.source ?? null)}, which was not in the prompt`;
        break;
      }
      const stance = typeof row?.stance === "string" ? row.stance.trim().toLowerCase() : "";
      if (!EVIDENCE_STANCES.includes(stance)) {
        fault = `claim ${at} evidence ${position + 1} names stance ${JSON.stringify(row?.stance ?? null)}; expected one of ${EVIDENCE_STANCES.join(", ")}`;
        break;
      }
      const quote = typeof row?.quote === "string" ? row.quote.trim() : "";
      if (quote === "") {
        fault = `claim ${at} evidence ${position + 1} carries an empty quote`;
        break;
      }
      evidence.push({ label, resourceId, stance, quote });
    }
    if (fault !== "") { reject(fault); continue; }

    claims.push({ statement, kind, entities: readEntities(raw?.entities), evidence });
    // The prompt asks for at most three. A prompt limit is a request, not a
    // constraint, and a model that returns eleven claims must cost the same
    // downstream as one that returns three.
    if (claims.length >= MAX_CLAIMS) break;
  }
  return claims;
}

/**
 * Stage ④: drop every claim whose quotes are not verbatim.
 *
 * Each quote is checked against the block the model was ACTUALLY SHOWN, not
 * against the full stored source. That is the strict reading and the right
 * one: the model cannot honestly quote text it was never given, so a quote
 * found only outside the block is invention that happened to land, and
 * verifying against the whole source would let it through.
 *
 * If ANY quote on a claim fails, the WHOLE claim goes — exactly as the prompt
 * says it will. Not repaired, not partially kept: a claim with one invented
 * quote had an author willing to invent, and keeping the rest of it puts that
 * willingness on the page under a provenance badge.
 *
 * `dropped` is returned rather than logged and forgotten. The ratio of kept to
 * dropped is the one number that says, in week one, whether extraction quality
 * is good enough to build on.
 * @param claims - claims from {@link parseClaims}.
 * @param blocks - resourceId → the quotable body of the block that source was shown as.
 * @returns `{ kept, dropped }`, `dropped` as `[{ statement, reason }]`.
 */
export function verifyClaims(claims, blocks) {
  const kept = [];
  const dropped = [];
  for (const claim of claims) {
    let reason = "";
    for (const row of claim.evidence) {
      const verdict = verifyQuote(row.quote, blocks, row.resourceId);
      if (verdict.ok) continue;
      reason = verdict.reason ?? "not found in the source it is attributed to";
      break;
    }
    if (reason !== "") { dropped.push({ statement: claim.statement, reason }); continue; }
    // A claim whose only surviving evidence disagrees with it asserts nothing
    // anybody said. It would render as a card with a ✗ row and no ✓ row.
    if (!claim.evidence.some((row) => row.stance === "supports")) {
      dropped.push({ statement: claim.statement, reason: "no surviving support" });
      continue;
    }
    kept.push(claim);
  }
  return { kept, dropped };
}

/**
 * One extraction call for one cluster.
 *
 * The stream is accumulated whole before anything is parsed, because a JSON
 * object cannot be read in pieces. An empty `claims` array is never an error:
 * the prompt promises it is acceptable and the caller counts it.
 *
 * Evidence rows come back carrying `sourceKey` and `resourceType` copied from
 * the stored row. They are denormalised onto the evidence at write time for
 * the reason the DDL gives — the independence count and the credibility score
 * both have to survive the source being pruned — and this is the last place
 * that still holds the claim and the row it came from together.
 * @param chat - the streaming chat entry point from `createChat`.
 * @param cluster - a cluster from `clusterItems`.
 * @param options - `{ zh, entries }`, as {@link buildExtractionPrompt}.
 * @returns `{ claims, dropped, rejected, parsed, chars }`.
 */
export async function extractClaims(chat, cluster, options = {}) {
  const { prompt, labels, blocks } = buildExtractionPrompt(cluster, options);

  let answer = "";
  let failure = "";
  // `context: ""` is not decoration. createChat builds the message as
  // `context === "" ? prompt : context + "\n\n---\n\n" + prompt`, so calling
  // without it prepends the literal string "undefined" to every prompt. And
  // the chunk field is `text`, not `content`: reading the wrong one
  // accumulates nothing, and every pass then reports zero claims and no error.
  for await (const chunk of chat({ prompt, context: "" })) {
    if (typeof chunk.text === "string") answer += chunk.text;
    if (typeof chunk.error === "string") failure = chunk.error;
    if (answer.length > MAX_ANSWER_CHARS) {
      throw new Error(`the model wrote past ${MAX_ANSWER_CHARS} characters without finishing its claims`);
    }
  }
  // The model's own error wins over any complaint about the answer: "context
  // length exceeded" tells the caller what to change, "empty answer" does not.
  if (failure !== "") throw new Error(failure);

  const rejected = [];
  const parsed = parseClaims(answer, labels, { onReject: (reason) => rejected.push(reason) });
  const { kept, dropped } = verifyClaims(parsed, blocks);

  const rows = new Map();
  for (const entry of options.entries ?? []) {
    if (entry?.row?.id !== undefined) rows.set(String(entry.row.id), entry.row);
  }
  const claims = kept.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((row) => {
      const source = rows.get(row.resourceId);
      return {
        ...row,
        sourceKey: sourceKeyOf(source ?? {}),
        resourceType: typeof source?.type === "string" ? source.type : "",
      };
    }),
  }));

  return { claims, dropped, rejected, parsed: parsed.length, chars: answer.length };
}

/**
 * The stage ⑤ question: how does the second claim relate to the first.
 *
 * Deliberately narrow. A prompt asking a model to "merge duplicates" invites
 * it to decide what a duplicate is; this one asks a single question with three
 * answers and says which way to err.
 */
export const RECONCILE_PROMPT = [
  "Two claims. Say how the second relates to the first.",
  "",
  "A: {A}",
  "B: {B}",
  "",
  "Answer with ONE word and nothing else:",
  "same        — B asserts the same thing as A, even if worded differently or carrying one further detail.",
  "contradicts — B asserts something that cannot be true at the same time as A.",
  "unrelated   — anything else, including two claims about the same companies that assert different things.",
  "",
  "\"same\" merges B into A permanently. When you are not sure, answer unrelated: a wrong merge loses a claim and hides it behind another one's history, while a wrong \"unrelated\" only costs a duplicate card that a person can merge later.",
].join("\n");

/** The three answers, searched for by position in the model's reply. */
const VERDICTS = ["same", "contradicts", "unrelated"];

/**
 * Ask how an incoming claim relates to a standing one.
 *
 * Returns "unrelated" — never throws — when the answer is empty, is not one of
 * the three words, or the call fails. The safe direction is a duplicate card:
 * a wrong merge loses a claim behind another one's history, and a thrown error
 * here would abandon the rest of the pass over one ambiguous pair.
 * @param chat - the streaming chat entry point.
 * @param existing - the standing claim's statement (A).
 * @param incoming - the new claim's statement (B).
 * @returns "same", "contradicts" or "unrelated".
 */
export async function judgeRelation(chat, existing, incoming) {
  const prompt = RECONCILE_PROMPT
    .replace("{A}", () => String(existing ?? ""))
    .replace("{B}", () => String(incoming ?? ""));
  let answer = "";
  try {
    for await (const chunk of chat({ prompt, context: "" })) {
      if (typeof chunk.error === "string") return "unrelated";
      if (typeof chunk.text === "string") answer += chunk.text;
      if (answer.length > MAX_VERDICT_CHARS) break;
    }
  } catch {
    return "unrelated";
  }

  // The first of the three words to appear wins, so a model that adds a full
  // stop or a sentence of reasoning is still read. Word boundaries because
  // "same" is a substring of ordinary words, and a stray "sameness" merging
  // two claims destroys one of them with no way back.
  const lower = answer.trim().toLowerCase();
  let best = "unrelated";
  let at = Infinity;
  for (const verdict of VERDICTS) {
    const found = new RegExp(`\\b${verdict}\\b`).exec(lower);
    if (found !== null && found.index < at) {
      at = found.index;
      best = verdict;
    }
  }
  return best;
}

/**
 * The evidence rows one claim contributes to an insight.
 *
 * `opposing` is set when the claim was judged to contradict the insight it is
 * landing on. Its supporting evidence supports the OPPOSITE of that insight,
 * so it is recorded as contradicting. Its own contradicting rows stay
 * contradicting: they disagree with a claim that already disagrees, which is
 * genuinely ambiguous, and recording ambiguity as a visible disagreement is
 * the conservative choice — flipping them to "supports" would manufacture
 * support for a claim no source actually made.
 * @param claim - a verified claim with denormalised evidence.
 * @param now - the write stamp.
 * @param opposing - whether this claim contradicts the insight it lands on.
 * @returns rows for `InsightStore#addEvidence`.
 */
function evidenceRowsFor(claim, now, opposing) {
  return claim.evidence.map((row) => ({
    resourceId: row.resourceId,
    stance: opposing && row.stance === "supports" ? "contradicts" : row.stance,
    quote: row.quote,
    sourceKey: row.sourceKey,
    resourceType: row.resourceType,
    addedAt: now,
  }));
}

/**
 * Stage ⑤ for one verified claim: merge it, contest an existing claim, or make a card.
 *
 * Cheap first. Every candidate in the window is compared with
 * `statementsMatch`, which costs no model call, and only near matches are
 * adjudicated — at most `budget.calls` of them across the WHOLE pass, so the
 * ceiling is a setting rather than a hope. The budget is a shared mutable
 * counter for exactly that reason: a per-claim limit multiplies by the number
 * of claims and stops bounding anything.
 *
 * `supersedes` is never set here. Superseding is a judgement about
 * replacement, not about similarity, and this function only ever knows the
 * second.
 * @param insightStore - the insight store.
 * @param chat - the streaming chat entry point.
 * @param claim - a verified claim with denormalised evidence.
 * @param options - `{ now, config, budget }`; `budget` is `{ calls }` and is decremented in place.
 * @returns `{ insightId, action, judged, evidenceAdded, conflicted, statement }`.
 */
export async function reconcileClaim(insightStore, chat, claim, options) {
  const { now, config, budget } = options;
  const windowDays = bounded(config.insightWindowDays, 1, 30, INSIGHT_DEFAULTS.insightWindowDays);
  const hash = simhash(claim.statement);
  const incoming = { statement: claim.statement, simhash: hash, entities: claim.entities };

  // Three windows back rather than one: a claim restated after a fortnight is
  // still the same claim, and matching only against the last week would open a
  // second card for it while the first sat one row below.
  const since = shiftIso(now, -3 * windowDays * 24 * 60);
  const near = [];
  for (const candidate of insightStore.candidatesForMatch({ since })) {
    const match = statementsMatch(candidate, incoming);
    if (match.near) near.push({ candidate, bits: match.bits, overlap: match.overlap });
  }
  // Closest first, so a scarce budget is spent on the pairs most likely to be
  // the same claim rather than on whichever row the store returned first.
  near.sort((left, right) => left.bits - right.bits || right.overlap - left.overlap);

  let judged = false;
  for (const entry of near) {
    if (budget.calls <= 0) break;
    budget.calls -= 1;
    judged = true;
    const verdict = await judgeRelation(chat, entry.candidate.statement, claim.statement);
    if (verdict === "unrelated") continue;

    // Read back in full rather than re-asserting the lean row the prefilter
    // scan returned. `upsertInsight` overwrites `supersedes` from what it is
    // handed, and `candidatesForMatch` does not select that column — so
    // re-asserting the lean row would silently NULL the history pointer of any
    // card that had replaced another, and the detail view would lose the link
    // with no error anywhere.
    const target = insightStore.get(entry.candidate.id);
    // Gone since the scan: fall through and make a card rather than write
    // evidence at an id that no longer exists.
    if (target === undefined) continue;

    // Re-asserting the target's own stored fields leaves every column as it
    // was except `last_seen_at`, whose upsert takes MAX. There is no `touch`
    // method, and inventing one would be a second place that writes this row.
    insightStore.upsertInsight({
      id: target.id,
      statement: target.statement,
      kind: target.kind,
      entities: Array.isArray(target.entities) ? target.entities : [],
      status: target.status,
      simhash: target.simhash,
      supersedes: target.supersedes ?? undefined,
      lastSeenAt: now,
    });
    const opposing = verdict === "contradicts";
    const written = insightStore.addEvidence(target.id, evidenceRowsFor(claim, now, opposing));
    return {
      insightId: target.id,
      action: opposing ? "contested" : "merged",
      judged: true,
      evidenceAdded: written.added ?? 0,
      evidenceUpdated: written.updated ?? 0,
      evidenceSkipped: written.skipped ?? 0,
      conflicted: written.conflicted ?? 0,
      // Carried for the log line, and a known loss: a contested claim's own
      // wording is NOT stored — there is no column for it — so the card shows
      // a ✗ quote without saying what the disagreement asserts. Naming it here
      // is cheaper than a reader discovering it on the page.
      statement: claim.statement,
    };
  }

  const id = insightStore.upsertInsight({
    statement: claim.statement,
    kind: claim.kind,
    entities: claim.entities,
    status: "candidate",
    simhash: hash,
    firstSeenAt: now,
    lastSeenAt: now,
  });
  const written = insightStore.addEvidence(id, evidenceRowsFor(claim, now, false));
  return {
    insightId: id,
    action: "created",
    judged,
    evidenceAdded: written.added ?? 0,
    evidenceUpdated: written.updated ?? 0,
    evidenceSkipped: written.skipped ?? 0,
    conflicted: written.conflicted ?? 0,
    statement: claim.statement,
  };
}

/** Count one reason, so the week-one numbers can be told apart from each other. */
function tally(into, reason) {
  into[reason] = (into[reason] ?? 0) + 1;
}

/**
 * Recompute the four scores and the status for one insight.
 *
 * Split out because the sweep and the touched rows need identical treatment:
 * an insight scored one way when it gains evidence and another way when it
 * merely ages would drift into two populations ranked against each other on
 * the same page.
 * @param insightStore - the insight store.
 * @param id - the insight id.
 * @param config - the insight settings.
 * @param now - the pass instant.
 * @param recount - whether the counts need recomputing first.
 * @returns whether a row changed.
 */
function rescoreOne(insightStore, id, config, now, recount) {
  // Counts before scores: `scoreMomentum` reads `independentCount`, so scoring
  // first ranks the card on the evidence it had before this pass ran.
  // `addEvidence` recounts inside its own transaction, so this is belt and
  // braces — kept because it is one cheap statement and because the failure it
  // covers, a write path that forgets, leaves `source_count` disagreeing with
  // the rows on screen forever and says nothing.
  if (recount) insightStore.recount(id);
  const insight = insightStore.get(id);
  if (insight === undefined) return false;

  // Handed over whole rather than remapped. `listEvidence` rows already carry
  // `stance` and the denormalised `resourceType`, and `scoreCredibility` reads
  // them through its own ladder; a mapping here would be a second place for
  // the field name to drift, and the symptom of that drift is every card
  // scored at the DEFAULT weight with nothing thrown.
  const evidence = insightStore.listEvidence(id);

  const dormantDays = bounded(config.insightDormantDays, 3, 120, INSIGHT_DEFAULTS.insightDormantDays);
  const scores = scoreInsight(insight, evidence, {
    now,
    windowDays: bounded(config.insightWindowDays, 1, 30, INSIGHT_DEFAULTS.insightWindowDays),
    dormantDays,
    // Resource types, NOT claim kinds. Relevance asks what share of the
    // supporting sources are the types this library is set up to publish.
    preferredResourceTypes: resourceTypesOf(config),
  });
  const status = nextStatus(insight, scores, {
    now,
    minIndependent: bounded(config.insightMinIndependent, 2, 5, INSIGHT_DEFAULTS.insightMinIndependent),
    dormantDays,
  });
  return insightStore.applyScores(id, scores, { status, now });
}

/**
 * Run the whole pipeline once.
 *
 * Writes insights and evidence; writes NO settings. The watermark is returned,
 * not stored, because storing it here would advance it on a manual run too,
 * and a manual run that advances the watermark silently cancels the scheduled
 * pass — the rows it skipped are never read again. {@link runInsightPass} owns
 * that decision and is the only writer.
 *
 * A cluster whose model call fails is recorded and the pass continues, exactly
 * as `publishOnce` keeps going when one artefact fails: a refused extraction
 * is no reason to lose the other nineteen.
 * @param store - the source library.
 * @param insightStore - the insight store over the same handle.
 * @param chat - the chat entry point, or undefined when none is routed.
 * @param logger - Cordis logger.
 * @param options - `{ now }`, pinned by tests.
 * @returns the run summary, or `{ ran: false, reason }`.
 */
export async function insightPassOnce(store, insightStore, chat, logger, options = {}) {
  const now = typeof options.now === "string" && options.now !== ""
    ? options.now
    : new Date().toISOString();
  const config = readInsightConfig(store);
  if (chat === undefined) return { ran: false, reason: "no model routed" };

  const { rows, backlog, truncated } = collectCandidates(store, config);
  if (rows.length < MIN_PASS_ROWS) {
    return {
      ran: false,
      reason: `only ${rows.length} new source(s) since the last pass; ${MIN_PASS_ROWS} needed`,
      backlog,
    };
  }

  const items = [];
  const rowsById = new Map();
  for (const row of rows) {
    const item = itemForRow(row);
    if (item === undefined) continue;
    items.push(item);
    rowsById.set(String(row.id), row);
  }

  const clusters = clusterItems(items, {
    windowDays: bounded(config.insightWindowDays, 1, 30, INSIGHT_DEFAULTS.insightWindowDays),
    maxBits: bounded(config.insightDuplicateBits, 0, 12, INSIGHT_DEFAULTS.insightDuplicateBits),
    maxClusters: bounded(config.insightMaxClusters, 1, 60, INSIGHT_DEFAULTS.insightMaxClusters),
  });

  // The watermark covers the rows that REACHED A SURVIVING CLUSTER, and only
  // those.
  //
  // It used to be computed over every row read, on the argument that anything
  // narrower makes tomorrow re-read today's rejects. The measurement says that
  // argument buys nothing and costs almost everything: `maxClusters` is sized
  // as though clustering collapsed rows ten to one, and a slice of mostly
  // unrelated articles produces roughly one cluster per article. Measured at
  // the defaults, 200 rows produced 200 clusters, 20 survived the ceiling, and
  // the other 180 were watermarked past unread — while the summary reported
  // `rows: 200, unusable: 0, clusters: 20`. Three healthy numbers over a 90%
  // loss is this repository's signature failure, and it was inside the feature
  // built to avoid it.
  //
  // Rows that were binned simply come back next pass. `binned` below reports
  // how many, so the ceiling is a number somebody can watch rather than a
  // silent trade.
  const reached = new Set();
  for (const cluster of clusters) {
    for (const member of cluster.members) reached.add(String(member?.id));
  }
  const watermark = rows
    .filter((row) => reached.has(String(row.id)))
    .map((row) => String(row.createdAt ?? ""))
    .reduce((latest, value) => (value > latest ? value : latest), "");
  const binned = rows.length - reached.size;

  const failures = [];
  const droppedReasons = {};
  const rejectedReasons = {};
  const kept = [];
  let extracted = 0;
  let claimCount = 0;
  let verified = 0;
  let droppedCount = 0;
  let rejectedCount = 0;

  for (const cluster of clusters) {
    const entries = cluster.members
      .map((member) => rowsById.get(String(member?.id)))
      .filter((row) => row !== undefined)
      .map((row) => ({ row, transcript: store.getTranscript(row.id) }));
    if (entries.length === 0) {
      failures.push(`${cluster.id}: none of its members are still in this batch`);
      continue;
    }
    try {
      const result = await extractClaims(chat, cluster, { zh: config.insightChinese === true, entries });
      extracted += 1;
      claimCount += result.parsed;
      verified += result.claims.length;
      droppedCount += result.dropped.length;
      rejectedCount += result.rejected.length;
      for (const entry of result.dropped) tally(droppedReasons, entry.reason);
      for (const reason of result.rejected) tally(rejectedReasons, reason);
      kept.push(...result.claims);
    } catch (cause) {
      failures.push(`${cluster.id}: ${String(cause?.message ?? cause)}`);
    }
  }

  const budget = { calls: bounded(config.insightMaxReconcileCalls, 0, 40, INSIGHT_DEFAULTS.insightMaxReconcileCalls) };
  const touched = new Set();
  let created = 0;
  let merged = 0;
  let contested = 0;
  let evidenceAdded = 0;
  let evidenceUpdated = 0;
  let evidenceSkipped = 0;
  let conflicted = 0;

  for (const claim of kept) {
    try {
      const outcome = await reconcileClaim(insightStore, chat, claim, { now, config, budget });
      touched.add(outcome.insightId);
      evidenceAdded += outcome.evidenceAdded;
      evidenceUpdated += outcome.evidenceUpdated;
      evidenceSkipped += outcome.evidenceSkipped;
      conflicted += outcome.conflicted;
      if (outcome.action === "created") created += 1;
      else if (outcome.action === "merged") merged += 1;
      else contested += 1;
    } catch (cause) {
      failures.push(`reconcile: ${String(cause?.message ?? cause)}`);
    }
  }


  // ── go and look for a second source ──────────────────────────────────────
  //
  // Everything above this line is a closed world: it can only find corroboration
  // that a feed happened to deliver into the same slice. Measured on the real
  // library that produced seven claims, all seven with one source — the tab
  // would have been empty by construction, not for want of evidence but for
  // want of asking.
  //
  // So candidates go out and search. Budgeted hard, because this is the only
  // stage that fetches whole pages: `insightCorroborateClaims` per pass, and a
  // claim is tried once and then left alone for a day whether or not it found
  // anything. Retrying a claim nobody else has written about, every hour, is
  // how a background job turns into a bill.
  let corroborated = 0;
  let corroborationEvidence = 0;
  let rateLimitedRuns = 0;
  const corroborationReasons = {};
  const wantCorroboration = bounded(config.insightCorroborateClaims, 0, 10, INSIGHT_DEFAULTS.insightCorroborateClaims);
  if (wantCorroboration > 0) {
    const web = options.web;
    const stale = shiftIso(now, -CORROBORATE_AFTER_MINUTES);
    const queue = insightStore.dueForCorroboration?.({ before: stale, limit: wantCorroboration }) ?? [];
    for (const id of queue) {
      // One refusal ends the stage for this pass. Carrying on to the next
      // claim sends a second request to the service that just said no, which
      // is the behaviour rate limits exist to stop and the behaviour that gets
      // an anonymous client blocked outright.
      if (rateLimitedRuns > 0) break;
      // `getWithEvidence`, which is what this store calls it. The first draft
      // invented `getInsight(id, { evidence: true })` from the shape of the
      // contract rather than from the file, and it crashed the whole stage on
      // the first real run — after 127 green tests, none of which ever let the
      // corroboration stage touch a store.
      const insight = insightStore.getWithEvidence(id);
      if (insight === undefined) continue;
      const known = (insight.evidence ?? []).map((row) => row.sourceKey ?? "").filter((key) => key !== "");
      let outcome;
      try {
        outcome = await corroborateOne(insight, { web, chat, knownSources: known });
      } catch (cause) {
        failures.push(`corroborate ${id}: ${String(cause?.message ?? cause)}`);
        continue;
      }
      corroborated += 1;
      // Marked when the claim was actually ASKED ABOUT, which a rate-limited
      // request was not. Stamping it anyway would put a claim to sleep for a
      // day over a three-second interval — the search never happened, and the
      // card would then sit as a candidate carrying an answer nobody gave.
      if (outcome.rateLimited === true) {
        rateLimitedRuns += 1;
      } else {
        insightStore.markCorroborated?.(id, now);
      }
      if (outcome.reason !== "") {
        corroborationReasons[outcome.reason] = (corroborationReasons[outcome.reason] ?? 0) + 1;
      }
      for (const found of outcome.evidence) {
        try {
          insightStore.addExternalEvidence?.(id, {
            url: found.url,
            sourceKey: found.host,
            stance: found.stance,
            quote: found.quote,
            addedAt: now,
          });
          corroborationEvidence += 1;
          touched.add(id);
        } catch (cause) {
          failures.push(`corroborate ${id} evidence: ${String(cause?.message ?? cause)}`);
        }
      }
    }
  }
  // Everything touched, plus the sweep, so novelty keeps decaying on cards
  // that gained no new evidence this pass. A card whose novelty was computed a
  // month ago and never again looks exactly like a card that is still new.
  let rescored = 0;
  const due = insightStore.dueForRescore({
    before: shiftIso(now, -RESCORE_AFTER_MINUTES),
    limit: RESCORE_SWEEP,
  });
  for (const id of new Set([...touched, ...due])) {
    try {
      if (rescoreOne(insightStore, id, config, now, touched.has(id))) rescored += 1;
    } catch (cause) {
      failures.push(`rescore ${id}: ${String(cause?.message ?? cause)}`);
    }
  }

  logger?.info?.(
    `swarm: insight pass read ${rows.length} row(s) into ${clusters.length} cluster(s), `
    + `kept ${verified}/${claimCount} claim(s), ${created} new, ${merged} merged, ${contested} contested`
    + (failures.length === 0 ? "" : ` (failed: ${failures.length})`),
  );

  return {
    ran: true,
    rows: rows.length,
    // Rows the clusterer could not use at all — no title, no usable text. A
    // pass reading two hundred rows and clustering nine is not a pass that
    // found nothing to say; it is a pass whose input is broken.
    unusable: rows.length - items.length,
    // Rows that clustered but lost the ceiling, and so were not shown to the
    // model. They are NOT lost — the watermark no longer covers them and they
    // return next pass — but a reader who cannot see this number cannot tell a
    // ceiling that is doing its job from one set far too low.
    binned,
    backlog,
    truncated,
    clusters: clusters.length,
    extracted,
    claims: claimCount,
    verified,
    // A NUMBER, not the array `verifyClaims` returns. `lastRun.dropped /
    // lastRun.claims` is the hallucinated-quote rate and it is the number to
    // watch in week one; an array there makes that division NaN and grows the
    // settings row by every dropped statement on every run, for ever.
    dropped: droppedCount,
    // Broken out because "too short" measures the prompt and "not found in the
    // source it is attributed to" measures invention. Added together they tell
    // you a number is bad without telling you which problem you have.
    droppedReasons,
    // Claims that never reached verification because the answer's own shape
    // was wrong. Counted apart from `dropped` for the same reason: this one
    // measures the model's obedience, not its honesty.
    rejected: rejectedCount,
    rejectedReasons,
    created,
    merged,
    contested,
    evidenceAdded,
    evidenceUpdated,
    // Rows `addEvidence` refused as malformed. The extractor has already
    // verified every quote, so a nonzero here is a bug in THIS module, not in
    // the model — which is exactly why the store counts instead of throwing.
    evidenceSkipped,
    // Evidence rows the store refused to overwrite — a stance flip it would
    // not make. Nonzero means reconciliation is landing contradictions on
    // sources that already support the same card, which would demote it.
    conflicted,
    reconcileCallsLeft: budget.calls,
    rescored,
    // What the search stage did. Reported separately from the extraction
    // counts because "found nothing to corroborate" and "was never asked to"
    // are different states and both render as zero.
    corroborated,
    corroborationEvidence,
    corroborationReasons,
    // Non-zero means the stage stopped early because a service refused us, and
    // the claims it did not reach were NOT marked as tried. Without this a
    // pass that was throttled and a pass that found nothing report the same
    // three zeros.
    corroborationRateLimited: rateLimitedRuns,
    failures,
    watermark,
  };
}

/**
 * Run the pass and record what happened.
 *
 * Both the timer and the "run now" button come through here so they agree on
 * what a run means. They differ in which record they write, and that
 * difference is the whole point: `markSkips: true` writes `insightLastRun`,
 * which carries the watermark and is what stops the next tick re-reading the
 * same rows; `markSkips: false` writes `insightLastManualRun`, so pressing the
 * button cannot silently cancel the scheduled pass.
 *
 * Every `insightLastRun` record carries a watermark forward, including a skip
 * and an error. `setSetting` writes whole values, so a skip record without one
 * WIPES the watermark — `collectCandidates` then reads it as absent, decides
 * this is the first ever run, and takes the newest rows again. With a
 * thirty-minute interval most ticks legitimately skip, so the watermark would
 * be erased several times an hour and the pass would re-extract the same
 * material at full model cost, permanently, reporting success each time.
 *
 * A `running` marker is written before the pass starts, because the pass takes
 * minutes while the button answers immediately: without it the page sees the
 * PREVIOUS run's record, which is indistinguishable from a button that did
 * nothing at all. A marker left behind by a crash is still better than
 * silence, and it is stamped so a stale one is visible.
 *
 * Never throws: every path settles into a returned record.
 * @param store - the source library.
 * @param insightStore - the insight store.
 * @param chat - the chat entry point.
 * @param logger - Cordis logger.
 * @param options - `{ markSkips }`.
 * @returns the outcome, as `insightPassOnce` reports it.
 */
export async function runInsightPass(store, insightStore, chat, logger, { markSkips = false, web } = {}) {
  const key = markSkips ? "insightLastRun" : "insightLastManualRun";
  const carried = readInsightConfig(store).insightLastRun?.watermark;
  const stamp = () => ({ date: localDate(), at: new Date().toISOString() });
  const note = (value) => {
    if (!markSkips) { store.setSetting(key, value); return; }
    const watermark = typeof value.watermark === "string" && value.watermark !== "" ? value.watermark : carried;
    store.setSetting(key, watermark === undefined ? value : { ...value, watermark });
  };

  note({ ...stamp(), running: true });
  try {
    const result = await insightPassOnce(store, insightStore, chat, logger, { web });
    if (result.ran) {
      note({ ...stamp(), ...result });
      return result;
    }
    logger?.info?.(`swarm: insight pass skipped — ${result.reason}`);
    note({ ...stamp(), skipped: result.reason, backlog: result.backlog });
    return result;
  } catch (cause) {
    const error = String(cause?.message ?? cause);
    logger?.warn?.(`swarm: insight pass failed: ${error}`);
    note({ ...stamp(), error });
    return { ran: false, reason: error, failed: true };
  }
}

/**
 * Whether an insight pass is due.
 *
 * Timed off the RECORDED last run rather than process uptime, the fix
 * `startCollectionTimer` already carries: an interval counted from boot means
 * a box that restarts more often than the interval never runs the pass at all,
 * while the status page cheerfully reports the interval it is not honouring.
 *
 * Exported so it can be tested without waiting on a timer. A due check only a
 * sixty-second interval can reach is a due check nobody has watched answer.
 * @param config - the insight settings.
 * @param now - milliseconds since the epoch.
 * @returns whether the pass should run.
 */
export function isInsightDue(config, now = Date.now()) {
  const minutes = Number(config.insightIntervalMinutes);
  // Zero is off, and it is the default. Not a fallback to some other number:
  // the whole reason the default is zero is that nobody agreed to the bill.
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  const last = config.insightLastRun?.at;
  if (typeof last !== "string" || last === "") return true;
  const at = Date.parse(last);
  if (!Number.isFinite(at)) return true;
  return now - at >= minutes * 60_000;
}

/**
 * Start the insight timer.
 *
 * The returned disposer MUST be called on dispose. `startPublishTimer`'s is
 * assigned and never called, so the publish timer keeps ticking against a
 * closed database after the plugin is disposed; do not copy that.
 * @param store - the source library.
 * @param insightStore - the insight store.
 * @param chat - the chat entry point.
 * @param logger - Cordis logger.
 * @returns a disposer stopping the timer.
 */
export function startInsightTimer(store, insightStore, chat, logger) {
  let running = false;
  const timer = setInterval(() => {
    // Guarded because a pass takes minutes and the tick is one: without it a
    // single due window launches sixty overlapping passes, all reading the
    // same watermark and all extracting the same clusters.
    if (running) return;
    if (!isInsightDue(readInsightConfig(store))) return;
    running = true;
    void runInsightPass(store, insightStore, chat, logger, { markSkips: true })
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  return () => { clearInterval(timer); };
}
