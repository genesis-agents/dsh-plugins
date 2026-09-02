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
import { EVIDENCE_STANCES, INSIGHT_KINDS, INSIGHT_LAYERS } from "./insight-store.js";
import { corroborateOne } from "./insight-corroborate.js";
import {
  MIN_QUOTE_CHARS,
  MIN_QUOTE_CJK_CHARS,
  clusterItems,
  earliestPublication,
  itemForRow,
  nextStatus,
  scoreInsight,
  simhash,
  sourceKeyOf,
  statementsMatch,
  verifyQuote,
} from "./insights.js";
// The resource vocabulary a scope may name. Imported rather than re-typed:
// a type this file accepted and store.js did not would filter every row out
// of a scan that reports itself as having read nothing new.
import { RESOURCE_TYPES } from "./store.js";

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

/**
 * Longest accepted attribution.
 *
 * A name and a role — "Jensen Huang, Nvidia" — is about twenty characters, and
 * this is generous against that. It is a CEILING, not a target: a model that
 * answers the speaker field with a sentence has not given a name, and a
 * sentence rendered where a card expects a name breaks the row it sits in.
 * Over the bound the field is dropped rather than truncated, because half an
 * attribution is a different attribution.
 */
const MAX_SPEAKER_CHARS = 80;

/**
 * Longest accepted gloss.
 *
 * One sentence, which is what the prompt asks for. The statement's own ceiling
 * is 600 and this is deliberately under it: a gloss as long as the claim it
 * explains is a second claim, unverified, sitting under a verified one.
 */
const MAX_GLOSS_CHARS = 220;

/** New rows a pass needs before it is worth its model calls. */
const MIN_PASS_ROWS = 2;

/**
 * Shortest insight interval accepted, zero aside.
 *
 * Zero-or-a-minimum rather than a plain range, mirroring the collection
 * interval: a five-minute pass would re-read the same watermark before the
 * previous run had finished recording it, paying for the same clusters twice
 * while reporting two successful runs.
 *
 * LIVES HERE AND IS EXPORTED, because three files need to agree on it and two
 * of them cannot import the third. index.js validates against it, the 洞察
 * router puts it on the wire so the arming control offers what the validator
 * accepts, and this module is the one both of them already import. Typed a
 * second time in either place it becomes a page offering 15 minutes over a
 * validator that refuses them — a control that looks like it works and hands
 * back an error the reader did nothing to earn.
 */
export const MIN_INSIGHT_INTERVAL_MINUTES = 30;

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
  // VIDEOS TO FETCH A TRANSCRIPT FOR, PER PASS.
  //
  // WHY THIS EXISTS. Until it did, the only thing in this program that ever
  // fetched a transcript was `POST /transcript`, and the only thing that
  // called it was a person opening a video in the reader. So the library's
  // transcript coverage was exactly "the videos somebody happened to click":
  // measured, 523 videos and 23 transcripts. The insight pass then correctly
  // skipped the other five hundred — a title and a blurb cannot produce a
  // checkable quote — and read 5% of the library while reporting a healthy run.
  //
  // Nothing was broken. The two halves had simply never been connected: one
  // fetches on demand, the other needs them in bulk, and no code bridged them.
  //
  // ON BY DEFAULT, UNLIKE THE SCHEDULE. `insightIntervalMinutes: 0` is off
  // because a pass costs model calls nobody agreed to. This costs none:
  // `resolveTranscript` tries timedtext, then the relay, then gens — all free
  // — and reaches Supadata's paid quota only when those refuse. A budget
  // rather than a sweep because the free routes are somebody else's servers.
  //
  // TWELVE, which drains a five-hundred-video backlog in under two days of
  // hourly passes and never makes a pass noticeably longer.
  insightTranscribePerPass: 12,
  // HOW OLD A SOURCE MAY BE AND STILL BE WORTH READING, by publication date.
  //
  // WHY IT EXISTS. The scan took everything above the watermark whatever its
  // age, so a library with a seeded back catalogue spent its model calls on
  // material from years ago — measured on this one, 27,642 unread rows, most
  // of them old — and the tab filled with a 2009 supercomputer comparison and
  // a methods detail from an archived paper, presented beside this week's
  // funding news as though they were the same kind of thing.
  //
  // A DIFFERENT FIELD FROM THE WATERMARK, deliberately. `insightLastRun.watermark`
  // is `created_at` — where the reader got to — and answers "have we read
  // this". This is `published_at` and answers "is it still worth reading".
  // A row can be new by one and old by the other, which is exactly the case
  // that produced the complaint.
  //
  // 0 TURNS IT OFF, for a library whose whole point is an archive. Thirty days
  // is the default because that is the horizon a person watching an industry
  // actually holds; anything older is research, and research is what 主题洞察
  // is for.
  insightMaxAgeDays: 30,
  // HOW LONG A CLAIM STAYS ON THE BOARD AFTER THE EVENT IT IS ABOUT.
  //
  // `insightMaxAgeDays` stops old material being READ; this retires what has
  // already been extracted. Without it the intake floor only holds the line
  // going forward — everything the pass had already pulled in stays on the
  // board for ever, so a tab cleaned up today fills again with last year's
  // archive the moment anything touches those rows.
  //
  // THREE TIMES THE INTAKE FLOOR, not equal to it. A claim entering at 29 days
  // old under a 30-day floor would expire on its second day on the board, which
  // is a tab that discards what it just decided to read. Ninety days is long
  // enough to watch a story develop and short enough that the board is about
  // now.
  //
  // 0 turns it off, for a library meant to accumulate.
  insightExpireAfterDays: 90,
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
    insightTranscribePerPass: store.getSetting("insightTranscribePerPass", INSIGHT_DEFAULTS.insightTranscribePerPass),
    insightMaxAgeDays: store.getSetting("insightMaxAgeDays", INSIGHT_DEFAULTS.insightMaxAgeDays),
    insightExpireAfterDays: store.getSetting("insightExpireAfterDays", INSIGHT_DEFAULTS.insightExpireAfterDays),
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
    // THE LAST RUN THAT ACTUALLY PRODUCED NUMBERS, whichever kind it was.
    //
    // A THIRD KEY, AND IT IS NOT REDUNDANT. `setSetting` writes WHOLE values,
    // so the `{running: true}` marker a pass writes before it starts REPLACES
    // the summary of the run before it — the rows, claims and verified counts
    // are gone from the library the instant somebody presses the button, and
    // they do not come back if that run skips or fails. Measured: pressing
    // 抽取主张 on a library whose figures read 200 / 13 / 12 blanked all four
    // for the whole pass, and the band they were in collapsed with them.
    //
    // Kept for BOTH kinds under one key on purpose. "When did this table last
    // change, and by how much" is one question, and answering it out of two
    // keys means a page that shows the scheduled figures on Tuesday and the
    // manual ones on Wednesday with nothing saying which.
    //
    // NO WATERMARK EVER GOES IN HERE. It is a display fact; `insightLastRun`
    // remains the only record the drain reads.
    insightLastGoodRun: store.getSetting("insightLastGoodRun", null),
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
export function collectCandidates(store, config, scope = {}) {
  // A SCOPE NARROWS THE SCAN AND NOTHING ELSE.
  //
  // It exists for the manual run: "read the last week", "read only the videos",
  // "read what mentions inference cost". The scheduled pass never passes one —
  // it is a drain, and a drain with a filter on it strands whatever the filter
  // excluded behind a watermark that moved anyway.
  //
  // WHICH IS WHY A SCOPED RUN MUST STAY MANUAL. `runInsightPass` writes
  // `insightLastManualRun` for those and never carries a watermark out of them,
  // so narrowing a manual scan cannot make the scheduled one skip rows it has
  // not read. That guarantee is upstream of this function and this comment is
  // the only place both halves are visible at once — do not reach for a scope
  // from the `markSkips: true` path.
  const types = Array.isArray(scope.types) && scope.types.length > 0
    ? scope.types.filter((type) => RESOURCE_TYPES.includes(type))
    : resourceTypesOf(config);
  // A SEARCH TERM, MATCHED THE WAY THE LIBRARY'S OWN SEARCH MATCHES IT — title,
  // abstract and summary, in SQL. Not a post-filter over the page: the scan
  // pages until it has `cap` rows, so filtering afterwards would page in two
  // hundred rows about anything and hand over the four that were about the
  // topic, reporting a full read.
  const search = typeof scope.search === "string" && scope.search.trim() !== ""
    ? scope.search.trim()
    : undefined;
  // THE FRESHNESS FLOOR, in publication time. A scope may widen or narrow it
  // for one run — "read the last quarter about inference cost" is a reasonable
  // thing to ask for — and 0 anywhere means no floor at all.
  const maxAgeDays = bounded(
    scope.maxAgeDays ?? config.insightMaxAgeDays,
    0, 3650, INSIGHT_DEFAULTS.insightMaxAgeDays,
  );
  const publishedAfter = maxAgeDays > 0 ? shiftIso(new Date().toISOString(), -maxAgeDays * 24 * 60) : undefined;
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
  // THE SKIPS ARE COLLECTED, NOT JUST APPLIED.
  //
  // This returned a boolean and the scan dropped the row on the floor. On the
  // library it was built against that is 500 videos a pass — held, wanted,
  // correctly skipped, and reported nowhere: not in `rows`, not in `backlog`,
  // not in `unusable`. A reader asking why an hour-long interview never
  // produced a claim had no answer available anywhere in the system.
  const skipped = [];
  const quotable = (row) => {
    if (!TIMED.has(String(row?.type ?? "").toUpperCase())) return true;
    if (typeof store.getTranscript !== "function") return true;
    let held = "";
    try {
      held = store.getTranscript(row.id)?.text ?? "";
    } catch (cause) {
      skipped.push({ row, reason: `transcript unreadable: ${String(cause?.message ?? cause)}` });
      return false;
    }
    if (held !== "") return true;
    skipped.push({ row, reason: "no transcript stored" });
    return false;
  };
  const cap = Number.isFinite(Number(scope.maxRows)) && Number(scope.maxRows) > 0
    ? bounded(scope.maxRows, 20, 600, INSIGHT_DEFAULTS.insightMaxRows)
    : bounded(config.insightMaxRows, 20, 600, INSIGHT_DEFAULTS.insightMaxRows);
  // A WINDOW REPLACES THE WATERMARK, it does not narrow it further.
  //
  // "Read the last week" from somebody looking at a table that has not moved
  // since December means the last week, not "the last week of whatever is
  // still above the watermark" — which on a drained library is nothing at all,
  // and would answer a deliberate request with the skip reason for an idle one.
  const since = typeof scope.since === "string" && scope.since !== ""
    ? scope.since
    : (typeof config.insightLastRun?.watermark === "string" ? config.insightLastRun.watermark : "");

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
        search,
        publishedAfter,
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
  return { rows, backlog, truncated, skipped };
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
  "\"layer\" is WHERE IN THE STACK the claim sits, and it is a different question from \"kind\". Exactly one of:",
  "  energy      — power, generation, grid, cooling, siting, the electricity a data centre needs",
  "  compute     — chips, interconnect, data centres, capacity, capex, the cost of a unit of compute",
  "  model       — training, architecture, weights, licences, benchmarks, what a model can do",
  "  application — products built on models, adoption, workflows, what somebody uses it for",
  "  cross       — a relationship BETWEEN layers, and only when that relationship is the claim",
  "Use \"cross\" sparingly and only when it is right: \"open weights do not reduce compute demand\" is about the link between the model layer and the compute layer, and filing it under either loses exactly what makes it worth reading. A claim that merely mentions two layers is not cross-layer; pick the one it is ABOUT.",
  "If none of the five fits — the claim is not about this stack at all — omit the field. An omitted layer is honest; a wrong one sends a reader to the wrong section for ever.",
  "",
  "\"entities\" — the two to five proper names the claim is about: companies, models, laboratories, agencies, people. Spelled as the sources spell them.",
  "",
  "\"speaker\" — WHO SAID THE QUOTE, on each piece of evidence, and only when the source block itself makes it plain: an interviewer naming their guest, a speaker introducing themselves, a transcript line attributing a sentence, an article quoting somebody by name. Give the name as the source gives it, and a role after it where the source states one — \"Jensen Huang, Nvidia\". OMIT THE FIELD when the source does not say. A written article speaking in its own voice has no speaker, and an hour of conversation between two people whose names appear nowhere in the block has no speaker either. Do not infer one from the channel, the title, or who you believe was probably talking: a name under a sentence is an attribution, and a wrong attribution is worse than none.",
  "",
  "\"gloss\" — ONE SENTENCE saying what the claim MEANS for somebody following this industry: the consequence, the thing that changes, or what it is evidence of. Not a translation of the statement and not a restatement of it in other words — a reader who has just read the statement learns nothing from either. Write it in {LANGUAGE}. Where the claim's significance genuinely depends on something the sources do not establish, omit the field rather than speculating: an omitted gloss is honest, an invented one is this program asserting something no source says, under a provenance badge.",
  "",
  "Return ONE JSON object and nothing else. No prose before it, no prose after it, no code fence:",
  "",
  "{\"claims\":[{\"statement\":\"<one sentence, specific enough to be wrong>\",\"kind\":\"finding\",\"layer\":\"compute\",\"gloss\":\"<one sentence on what it means; omit if the sources do not support one>\",\"entities\":[\"…\",\"…\"],\"evidence\":[{\"source\":\"S1\",\"stance\":\"supports\",\"quote\":\"<copied character for character out of [S1]>\",\"speaker\":\"<who said it, omit if the block does not say>\"},{\"source\":\"S3\",\"stance\":\"contradicts\",\"quote\":\"<copied character for character out of [S3]>\"}]}]}",
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
    // replaceAll, NOT replace, AND THE GUARD BELOW IS WHY THIS COST ONE LINE
    // RATHER THAN AN AFTERNOON. `{LANGUAGE}` appeared once, so `replace` was
    // correct — until the gloss rule needed the language named a second time.
    // The first was substituted, the second survived, and the model would have
    // been shown the literal text "{LANGUAGE}" inside an instruction about
    // what language to write in. Nothing about the answer would have looked
    // wrong: it would simply have written the gloss in whatever language it
    // felt like, on some passes, for ever.
    //
    // The assertion three lines below caught it on the first run. That is the
    // entire return on a guard whose failure message reads as paranoid.
    .replaceAll("{LANGUAGE}", () => language)
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
      // SPEAKER IS OPTIONAL AND NEVER FATAL, like the layer. An attribution
      // the source did not make is worse than none, so the prompt asks the
      // model to omit it — and a claim must not be discarded for taking that
      // instruction. Bounded because it is rendered inline on a card: a
      // "speaker" that came back as a paragraph is not a name.
      const said = typeof row?.speaker === "string" ? row.speaker.trim() : "";
      const speaker = said !== "" && said.length <= MAX_SPEAKER_CHARS ? said : "";
      evidence.push({ label, resourceId, stance, quote, speaker });
    }
    if (fault !== "") { reject(fault); continue; }

    // THE LAYER IS OPTIONAL AND NEVER FATAL. `kind` is required because a
    // claim with no kind cannot be filed at all; a claim with no layer files
    // under 未归层, which is a true statement about it. Rejecting the claim
    // for a missing layer would throw away the evidence with the label.
    const layer = typeof raw?.layer === "string" ? raw.layer.trim().toLowerCase() : "";
    // THE GLOSS IS OPTIONAL AND NEVER FATAL, for the layer's reason and one
    // more: it is the only field on a claim that is NOT checkable against a
    // quote. The statement is verified, the quote is verified character for
    // character, the speaker is required to be stated in the block — the gloss
    // is a reading, and the card has to present it as one. Rejecting a claim
    // for a missing gloss would throw away verified evidence over the one
    // field that carries no evidence.
    const said = typeof raw?.gloss === "string" ? raw.gloss.trim() : "";
    claims.push({
      statement, kind,
      layer: INSIGHT_LAYERS.includes(layer) ? layer : null,
      gloss: said !== "" && said.length <= MAX_GLOSS_CHARS ? said : "",
      entities: readEntities(raw?.entities), evidence,
    });
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
    // CARRIED, NOT DROPPED. This function is the one place a verified claim
    // becomes rows for the store, so a field the extractor produced and this
    // map does not list is a field that reaches the database on no path at
    // all — silently, with every count still correct.
    speaker: row.speaker,
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
      // THE INCOMING CLAIM'S READING, ON A MERGE. `upsertInsight` COALESCEs
      // both of these, so passing the new one can only FILL a hole: a target
      // that already has a gloss keeps it, and a target that never had one
      // gets the reading the pass just produced rather than staying blank
      // for ever because it happened to be created first.
      //
      // The layer is here for the same reason and was already missing: this
      // call omitted it entirely, so a claim merged into an unplaced target
      // left that target unplaced no matter how many later passes could place
      // it. Under 未归层 for ever, with nothing reporting anything.
      layer: claim.layer ?? undefined,
      gloss: claim.gloss,
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
    layer: claim.layer,
    gloss: claim.gloss,
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
export function rescoreOne(insightStore, id, config, now, recount) {
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
    // THE EVENT'S OWN DATE — the earliest publication among the rows backing
    // the claim, the same instant `scoreNovelty` measures from and for the same
    // reason: a claim's age is a fact about the world, not about when we
    // noticed it.
    eventAt: earliestPublication(evidence),
    expireAfterDays: bounded(config.insightExpireAfterDays, 0, 3650, INSIGHT_DEFAULTS.insightExpireAfterDays),
  });
  return insightStore.applyScores(id, scores, { status, now });
}

/**
 * Reasons a transcript fetch can fail, and what each one means for the pass.
 *
 * CLASSIFIED, NOT JUST RECORDED. A quota that is exhausted, a video that has
 * no captions at all, and a network blip call for three different responses:
 * stop the stage, never try this video again this pass, and try the next one.
 * Left as one opaque string the stage would spend its whole budget re-learning
 * that the quota is gone — twelve requests per pass, every pass, for ever.
 * @param error - what `resolveTranscript` threw.
 * @returns "quota" | "absent" | "other".
 */
export function transcriptFailureKind(error) {
  const text = String(error?.message ?? error ?? "").toLowerCase();
  // 429 and the provider's own wording. Checked before "absent" because a
  // rate-limited request can also mention a missing track in the same string:
  // the free routes are tried first and each appends its own failure, so one
  // message routinely carries four.
  if (/429|rate.?limit|quota|too many requests|limit exceeded/.test(text)) return "quota";
  // 400/404 from every route: the video genuinely has no caption track. Worth
  // separating because it is PERMANENT — no budget and no key will ever change
  // it, and a reader looking at the ledger should not be told to buy quota.
  if (/400|404|no caption|not available|no transcript|no subtitles/.test(text)) return "absent";
  return "other";
}

/**
 * Fetch transcripts for videos the scan is about to skip.
 *
 * THE STAGE THAT WAS MISSING. `collectCandidates` skips a video the library
 * holds no transcript for, correctly and for a stated reason, and nothing
 * anywhere ever went and got one. Transcripts arrived only through
 * `POST /transcript`, which fires when a person opens a video in the reader —
 * so coverage was "the videos somebody clicked", and the pass read whatever
 * fraction of the library that came to. Measured: 23 of 523.
 *
 * SEQUENTIAL, NOT PARALLEL, and that is not caution about our own load. The
 * first three routes are other people's servers — YouTube's timedtext, a
 * relay, gens — and a burst of twelve concurrent requests to a free endpoint
 * is how a client gets blocked outright. One at a time, bounded by the budget.
 *
 * A QUOTA ANSWER ENDS THE STAGE. Every remaining video would get the same
 * answer from the same exhausted key, so carrying on spends the rest of the
 * budget re-learning one fact — and against a rate limiter, spends it making
 * the limit worse.
 *
 * NEVER THROWS. A transcript top-up is preparation for the pass, not the pass:
 * a stage that cannot fetch must leave the extraction it was preparing for
 * completely unharmed.
 * @param store - the source library, for `putTranscript`.
 * @param skipped - `[{ row, reason }]` from {@link collectCandidates}.
 * @param options - `{ transcribe, limit, logger, onStep }`.
 * @returns `{ tried, gained, stopped, outcomes }`; outcomes keyed by resource id.
 */
export async function topUpTranscripts(store, skipped, { transcribe, limit = 0, logger, onStep } = {}) {
  const outcomes = new Map();
  const budget = Math.max(0, Math.floor(Number(limit) || 0));
  if (typeof transcribe !== "function" || budget === 0 || !Array.isArray(skipped)) {
    return { tried: 0, gained: 0, stopped: "", outcomes };
  }
  // Only the ones a fetch could actually help. A row skipped because its
  // stored transcript could not be READ is a different fault and re-fetching
  // it would paper over a broken row rather than fix it.
  const wanted = skipped
    .filter((entry) => entry?.row !== undefined && /no transcript stored/i.test(String(entry.reason ?? "")))
    .slice(0, budget);

  let tried = 0;
  let gained = 0;
  let stopped = "";
  for (const entry of wanted) {
    const id = String(entry.row.id);
    onStep?.(tried, wanted.length);
    tried += 1;
    try {
      const got = await transcribe(entry.row);
      const text = String(got?.text ?? "");
      if (text === "") {
        // A route that answered with nothing is not a success. Storing an
        // empty transcript would make the next scan treat this video as
        // readable and hand the model a blank block.
        outcomes.set(id, { ok: false, kind: "absent", reason: "the transcript came back empty" });
        continue;
      }
      store.putTranscript(id, got.language ?? "", text, Array.isArray(got.cues) ? got.cues : []);
      gained += 1;
      outcomes.set(id, { ok: true, via: got.via ?? "" });
    } catch (cause) {
      const reason = String(cause?.message ?? cause);
      const kind = transcriptFailureKind(cause);
      outcomes.set(id, { ok: false, kind, reason });
      if (kind === "quota") {
        stopped = reason;
        logger?.warn?.(`swarm: transcript top-up stopped — the provider is out of quota or rate limiting`);
        break;
      }
    }
  }
  if (gained > 0) logger?.info?.(`swarm: fetched ${gained} transcript(s) of ${tried} tried`);
  return { tried, gained, stopped, outcomes };
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
 * @param options - `{ now }`, pinned by tests, and `{ onProgress }`.
 * @returns the run summary, or `{ ran: false, reason }`.
 */
export async function insightPassOnce(store, insightStore, chat, logger, options = {}) {
  const now = typeof options.now === "string" && options.now !== ""
    ? options.now
    : new Date().toISOString();
  const config = readInsightConfig(store);
  if (chat === undefined) return { ran: false, reason: "no model routed" };

  // Bounded here rather than inside the stage so a scoped manual run can ask
  // for a bigger top-up than the schedule takes, which is the one thing
  // somebody staring at a mostly-untranscribed library actually wants to do.
  const transcribeBudget = bounded(
    options.scope?.transcribe ?? config.insightTranscribePerPass,
    0, 60, INSIGHT_DEFAULTS.insightTranscribePerPass,
  );

  /**
   * Say where the pass has got to.
   *
   * A pass is five stages and up to twenty model calls over several minutes,
   * and until this existed it reported exactly twice: `running: true` at the
   * top and the summary at the bottom. Everything between was a spinner with
   * no number on it, which is indistinguishable from a button that did
   * nothing — and that is what a reader pressing 立即跑一次 actually saw.
   *
   * NEVER THROWS OUT OF HERE. The listener writes a setting, the setting
   * writes SQLite, and a failed write mid-pass must not lose the extraction
   * that was already paid for. Progress is a courtesy; the run is the work.
   * @param phase - which stage.
   * @param done - units finished in this stage.
   * @param total - units this stage will do, or 0 when it cannot be known yet.
   */
  const say = (phase, done, total) => {
    try {
      options.onProgress?.({ phase, done, total });
    } catch (cause) {
      logger?.warn?.(`swarm: insight progress listener failed: ${String(cause?.message ?? cause)}`);
    }
  };

  say("reading", 0, 0);
  // The scope, when the reader asked for one. Absent on every scheduled pass.
  let { rows, backlog, truncated, skipped } = collectCandidates(store, config, options.scope ?? {});

  // ── GO AND GET THE TRANSCRIPTS THE SCAN JUST SKIPPED ──────────────────
  //
  // The scan is right to skip them and was the end of the story: nothing in
  // this program ever fetched a transcript except a person opening a video.
  // So the pass read whatever fraction of the library somebody had clicked —
  // 23 of 523 — and reported it as a healthy run over 200 rows.
  //
  // BEFORE THE SECOND SCAN, not instead of it. A video that gains a transcript
  // here has to go back through `collectCandidates` to be selected on the same
  // terms as everything else: the per-type share, the ceiling, the watermark.
  // Promoting it directly would give a freshly-transcribed video a place no
  // other row can earn.
  let transcribed = { tried: 0, gained: 0, stopped: "", outcomes: new Map() };
  if (transcribeBudget > 0 && (skipped ?? []).length > 0) {
    say("transcribing", 0, Math.min(transcribeBudget, skipped.length));
    transcribed = await topUpTranscripts(store, skipped, {
      transcribe: options.transcribe,
      limit: transcribeBudget,
      logger,
      onStep: (done, total) => { say("transcribing", done, total); },
    });
    if (transcribed.gained > 0) {
      ({ rows, backlog, truncated, skipped } = collectCandidates(store, config, options.scope ?? {}));
    }
  }

  // THE LEDGER, BUILT AS THE PASS GOES AND WRITTEN ONCE AT THE END.
  //
  // Keyed by resource id so the later, more specific verdict wins: the scan
  // says "no transcript", the clusterer says "unusable", the extractor says
  // "extracted, 2 claims", and a source reaches at most one of the three.
  const ledger = new Map();
  // A CODE AND, WHERE THERE IS ONE, A DETAIL THAT IS NOT OURS TO TRANSLATE.
  // The sentence a reader sees is assembled by the page from the code; the
  // detail is the provider's or the model's own words, which no face table can
  // localise and which are the whole point of recording a failure.
  const note = (row, state, reasonCode, detail, claims) => {
    if (row === undefined || row === null) return;
    ledger.set(String(row.id), {
      resourceId: String(row.id),
      title: String(row.title ?? ""),
      resourceType: String(row.type ?? ""),
      durationSeconds: row.durationSeconds,
      state,
      reasonCode: reasonCode ?? "",
      reason: detail ?? "",
      claims: claims ?? 0,
    });
  };
  for (const entry of skipped ?? []) {
    // THE REAL ANSWER, WHERE THERE IS ONE. "no transcript stored" describes
    // the library; it does not say whether anybody ever asked for one, whether
    // the video HAS captions, or whether the quota ran out — which are three
    // different things to do about it. The top-up's outcome replaces the
    // library's description with the provider's answer.
    const said = transcribed.outcomes.get(String(entry.row?.id));
    note(
      entry.row,
      "no-transcript",
      said === undefined || said.ok === true
        ? "transcript-untried"
        : `transcript-${said.kind}`,
      said === undefined || said.ok === true ? "" : said.reason,
    );
  }
  if (rows.length < MIN_PASS_ROWS) {
    return {
      ran: false,
      reason: `only ${rows.length} new source(s) since the last pass; ${MIN_PASS_ROWS} needed`,
      backlog,
      // THE TOP-UP'S REPORT SURVIVES A SKIP, and this is the case it matters
      // most in. A library of untranscribed videos whose provider is out of
      // quota fetches nothing, therefore has too little to read, therefore
      // skips — and the skip reason says "only 0 new sources", which is true
      // and useless. The one fact that explains it, and the only one anybody
      // can act on, was being discarded on the way out of this branch.
      transcribeTried: transcribed.tried,
      transcribeGained: transcribed.gained,
      transcribeStopped: transcribed.stopped,
    };
  }

  const items = [];
  const rowsById = new Map();
  for (const row of rows) {
    const item = itemForRow(row);
    if (item === undefined) {
      // Counted in `unusable` since this pass was written, and NAMED here for
      // the first time. "17 unusable" is a number nobody can act on; a title
      // beside it is a feed to go and look at.
      note(row, "unusable", "no-usable-text");
      continue;
    }
    items.push(item);
    rowsById.set(String(row.id), row);
  }

  say("clustering", 0, rows.length);
  const clusters = clusterItems(items, {
    windowDays: bounded(config.insightWindowDays, 1, 30, INSIGHT_DEFAULTS.insightWindowDays),
    maxBits: bounded(config.insightDuplicateBits, 0, 12, INSIGHT_DEFAULTS.insightDuplicateBits),
    maxClusters: bounded(config.insightMaxClusters, 1, 60, INSIGHT_DEFAULTS.insightMaxClusters),
    // THE FRONT OF THE QUEUE, IN THIS FUNCTION'S ORDER. `rows` is sorted by
    // `createdAt` ascending and the watermark advances on the same field, so
    // this is the one row that must be read for the drain to move at all.
    // Without it a correct watermark converts silent loss into no progress:
    // the contiguous read prefix would be empty and the pass would re-read the
    // same slice for ever.
    ensureItemId: rows.length === 0 ? undefined : String(rows[0].id),
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
  // THE WATERMARK MAY ONLY COVER ROWS THAT WERE ACTUALLY READ, AND ONLY
  // CONTIGUOUSLY FROM THE OLDEST.
  //
  // It was the MAX createdAt among rows that reached a surviving cluster, on
  // the argument that binned rows "simply come back next pass". They did not.
  // The ceiling keeps the largest clusters and breaks ties NEWEST-first, so on
  // a slice of unrelated sources the survivors are the newest rows — the max
  // therefore lands at the end of the slice and every binned row, all of them
  // older, falls below it. Measured on a 200-row slice: 180 binned, 180 of
  // them at or under the watermark the pass then wrote. Read once, discarded,
  // never offered again, with three healthy-looking numbers over the loss.
  //
  // A watermark is a promise that everything before it has been read, so it
  // may only advance across an unbroken run of read rows. The first row that
  // was NOT read stops it — everything from there on comes back, which is what
  // "comes back next pass" was supposed to mean.
  //
  // STRICTLY BEFORE THE FIRST UNREAD ROW'S TIMESTAMP, not up to it: the scan
  // filters with `created_at > ?`, so two rows sharing an instant where one was
  // binned would see the binned one skipped by a watermark equal to that
  // instant. Rows are already oldest-first here.
  const firstUnread = rows.find((row) => !reached.has(String(row.id)));
  const ceiling = firstUnread === undefined ? null : String(firstUnread.createdAt ?? "");
  const watermark = rows
    .filter((row) => reached.has(String(row.id)))
    .map((row) => String(row.createdAt ?? ""))
    .filter((at) => ceiling === null || at < ceiling)
    .reduce((latest, value) => (value > latest ? value : latest), "");
  const binned = rows.length - reached.size;
  for (const row of rows) {
    if (reached.has(String(row.id))) continue;
    // NOT A LOSS, and the reason says so. The watermark does not cover a
    // binned row, so it comes back next pass — but a reader who cannot see
    // WHICH rows these are cannot tell a ceiling doing its job from one set
    // far too low, which is what `binned`'s own note asks for and could not
    // give.
    note(row, "binned", "over-ceiling");
  }

  const failures = [];
  const droppedReasons = {};
  const rejectedReasons = {};
  const kept = [];
  let extracted = 0;
  let claimCount = 0;
  let verified = 0;
  let droppedCount = 0;
  let rejectedCount = 0;

  // Reported one AHEAD of the model call rather than behind it: each of these
  // takes seconds, and a counter that moves only on completion sits on 0/20
  // for the whole first call — the exact stretch a reader is watching to find
  // out whether anything is happening at all.
  let clusterAt = 0;
  for (const cluster of clusters) {
    say("extracting", clusterAt, clusters.length);
    clusterAt += 1;
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
      // EVERY MEMBER OF THE CLUSTER GETS THE CLUSTER'S VERDICT, and the count
      // is the cluster's, not each row's. A cluster is what the model is shown
      // — several articles about one story, in one call — so "which of these
      // four the sentence came from" is a question this stage does not answer
      // and must not pretend to. `read` for a cluster that produced nothing is
      // the commonest honest outcome on a quiet week and is not a fault.
      for (const entry of entries) {
        note(entry.row, result.claims.length > 0 ? "extracted" : "read", "", "", result.claims.length);
      }
      claimCount += result.parsed;
      verified += result.claims.length;
      droppedCount += result.dropped.length;
      rejectedCount += result.rejected.length;
      for (const entry of result.dropped) tally(droppedReasons, entry.reason);
      for (const reason of result.rejected) tally(rejectedReasons, reason);
      kept.push(...result.claims);
    } catch (cause) {
      const reason = String(cause?.message ?? cause);
      failures.push(`${cluster.id}: ${reason}`);
      for (const entry of entries) note(entry.row, "failed", "extract-failed", reason);
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

  let claimAt = 0;
  for (const claim of kept) {
    say("reconciling", claimAt, kept.length);
    claimAt += 1;
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
    let queueAt = 0;
    for (const id of queue) {
      say("corroborating", queueAt, queue.length);
      queueAt += 1;
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
  const sweep = new Set([...touched, ...due]);
  let sweepAt = 0;
  for (const id of sweep) {
    say("rescoring", sweepAt, sweep.size);
    sweepAt += 1;
    try {
      if (rescoreOne(insightStore, id, config, now, touched.has(id))) rescored += 1;
    } catch (cause) {
      failures.push(`rescore ${id}: ${String(cause?.message ?? cause)}`);
    }
  }

  // THE LEDGER IS COMMITTED LAST, AFTER THE CLAIMS IT ACCOUNTS FOR.
  //
  // And its failure is caught here rather than allowed out. A ledger is a
  // record OF the work, not the work: a broken account of a pass must not
  // discard the claims that pass already wrote and paid for. It is logged
  // rather than swallowed, because a ledger that silently stops being written
  // is a screen that quietly goes stale while every other number stays right.
  const batch = now;
  try {
    insightStore.recordPass?.(batch, [...ledger.values()]);
  } catch (cause) {
    logger?.warn?.(`swarm: recording the pass ledger failed: ${String(cause?.message ?? cause)}`);
  }

  logger?.info?.(
    `swarm: insight pass read ${rows.length} row(s) into ${clusters.length} cluster(s), `
    + `kept ${verified}/${claimCount} claim(s), ${created} new, ${merged} merged, ${contested} contested`
    + (failures.length === 0 ? "" : ` (failed: ${failures.length})`),
  );

  return {
    ran: true,
    // The ledger's key, so the page can ask for THIS pass's account rather
    // than for whatever the newest batch happens to be by the time it asks.
    batch,
    // Sources held and wanted, skipped before the model saw them. Reported
    // beside `rows` because on a video-heavy library it is the larger number,
    // and it was previously invisible at every layer.
    skipped: (skipped ?? []).length,
    // What the top-up did. `transcribeStopped` carries the provider's own
    // words when the quota ended the stage, because "0 gained" and "the key is
    // exhausted" look identical from every number beside them.
    transcribeTried: transcribed.tried,
    transcribeGained: transcribed.gained,
    transcribeStopped: transcribed.stopped,
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
export async function runInsightPass(store, insightStore, chat, logger, { markSkips = false, web, scope, transcribe } = {}) {
  const key = markSkips ? "insightLastRun" : "insightLastManualRun";
  const carried = readInsightConfig(store).insightLastRun?.watermark;
  const stamp = () => ({ date: localDate(), at: new Date().toISOString() });
  const note = (value) => {
    if (!markSkips) { store.setSetting(key, value); return; }
    const watermark = typeof value.watermark === "string" && value.watermark !== "" ? value.watermark : carried;
    store.setSetting(key, watermark === undefined ? value : { ...value, watermark });
  };

  // A SCOPE ON THE SCHEDULED PASS IS REFUSED, NOT IGNORED.
  //
  // The scheduled pass carries the watermark: it reads the rows above it and
  // then declares them read. Narrow that scan and the rows the filter excluded
  // are watermarked past unread and never offered again — the exact loss
  // `collectCandidates` records in its own comment, at 20,508 rows, reported as
  // a success. Silently dropping the scope would leave a caller believing they
  // had scoped a run that drained the library instead, so this throws.
  if (markSkips && scope !== undefined && scope !== null && Object.keys(scope).length > 0) {
    throw new Error("a scheduled insight pass cannot be scoped: it carries the watermark");
  }

  const startedAt = new Date().toISOString();
  // THE SCOPE TRAVELS WITH THE RECORD. A run that read one week of videos about
  // inference cost and found nothing is a different fact from a full pass that
  // found nothing, and the page cannot tell them apart from the numbers.
  const scopeNote = scope === undefined || scope === null || Object.keys(scope).length === 0
    ? undefined
    : scope;
  note({ ...stamp(), running: true, startedAt, scope: scopeNote });

  // WHERE IT HAS GOT TO, WRITTEN WHERE THE PAGE ALREADY LOOKS.
  //
  // Not a second setting and not an event stream: `/insights/status` reads
  // this record every time the tab polls, so a phase written into it is a
  // phase on screen with no new route, no socket and nothing to keep in sync.
  //
  // `startedAt` is carried forward through every stamp rather than re-read,
  // because `stamp()` moves `at` on each write — a reader computing "running
  // for N minutes" against `at` would watch the elapsed time reset to zero
  // every time the pass made progress, which is the opposite of what a
  // progress display is for.
  //
  // THROTTLED, because the rescore sweep can turn over a hundred ids in a
  // second and each stamp is a SQLite write. A phase CHANGE always goes
  // through: those are the four moments a reader is actually waiting on, and
  // dropping one to a timer would hide the whole corroboration stage on a
  // pass that had little to do.
  const PROGRESS_MIN_MS = 750;
  let saidAt = 0;
  let saidPhase = "";
  const onProgress = ({ phase, done, total }) => {
    const at = Date.now();
    if (phase === saidPhase && at - saidAt < PROGRESS_MIN_MS) return;
    saidAt = at;
    saidPhase = phase;
    note({ ...stamp(), running: true, startedAt, scope: scopeNote, phase, done, total });
  };

  try {
    // `transcribe` FORWARDED, AND IT WAS NOT. Both call sites hand this
    // function a transcript fetcher — the timer in index.js and the run-now
    // route — and it accepted the option, never destructured it, and called
    // the pass without it. Every run therefore reported transcribeTried: 0
    // while every layer above looked correctly wired.
    //
    // The unit tests missed it because they call `insightPassOnce` directly,
    // which is the function that USES the fetcher rather than the one that
    // passes it on. A seam is exactly where a value gets dropped, and testing
    // only the inner side of one tests the half that cannot fail this way.
    const result = await insightPassOnce(store, insightStore, chat, logger, { web, onProgress, scope, transcribe });
    if (result.ran) {
      const settled = { ...stamp(), ...result, scope: scopeNote };
      note(settled);
      // THE FIGURES SURVIVE THE NEXT PRESS. Written only on a run that ran, so
      // a skip, a failure and the `running` marker all leave it alone — which
      // is the whole point: those three are what wipe the record they share a
      // key with. `kind` travels with it because "200 rows, an hour ago" reads
      // differently once you know it was a one-week manual slice.
      //
      // Deliberately NOT carrying the watermark: `note`'s merge is what puts
      // one on `insightLastRun`, and this key is never read by the drain.
      store.setSetting("insightLastGoodRun", { ...settled, kind: markSkips ? "scheduled" : "manual" });
      return result;
    }
    logger?.info?.(`swarm: insight pass skipped — ${result.reason}`);
    // THE SKIP RECORD CHERRY-PICKED TWO FIELDS AND DROPPED THE REST, which
    // is how the top-up report vanished a second time after being carefully
    // added to the early return that produces it. `reason` and `backlog` were
    // the only things a skip could carry when this was written; the transcript
    // stage now puts the one actionable fact on that same object — that the
    // provider is out of quota — and a hand-listed field set silently discards
    // every field added after it.
    //
    // Spread the result and name the two overrides, so the next field to be
    // added to a skip arrives on the record without anybody remembering this
    // line exists.
    note({ ...stamp(), ...result, ran: false, skipped: result.reason, backlog: result.backlog, scope: scopeNote });
    return result;
  } catch (cause) {
    const error = String(cause?.message ?? cause);
    logger?.warn?.(`swarm: insight pass failed: ${error}`);
    note({ ...stamp(), error, scope: scopeNote });
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
