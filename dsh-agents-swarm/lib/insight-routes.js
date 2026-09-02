/**
 * The 洞察 tab's HTTP face: standing claims, their evidence, and the pass that
 * finds them.
 *
 * Mirrors lib/publish-routes.js deliberately — one factory over the Host
 * half's helpers, returning a handler that either answers or reports that it
 * did not, so index.js keeps one router rather than two competing ones.
 *
 * TWO THINGS THAT LOOK LIKE STYLE AND ARE NOT:
 *
 * 1. Every route here carries a SECOND segment under `/insights/`. index.js
 *    dispatches with `path.startsWith("/insights/")`, and
 *    `"/insights".startsWith("/insights/")` is false — a route at bare
 *    `/insights` would 404 while this handler sat registered, loaded, and
 *    perfectly able to answer it. Adding one later means widening the
 *    dispatch condition in index.js in the same change.
 *
 * 2. A bad parameter is a 400 naming the accepted values, never an empty
 *    list. An empty list from a typo is indistinguishable from an empty list
 *    from no data, which is a filter that looks like it works and shows
 *    nothing — the failure this codebase keeps re-shipping.
 *
 * The `path` argument arrives already stripped of ROUTE_PREFIX and WITHOUT a
 * query string (index.js hands over `url.pathname`), which is why
 * `path === "/insights/list"` matches a request carrying seven parameters.
 * The parameters themselves come from re-parsing `req.url`, exactly as
 * publish-routes.js does for `/publish/documents`.
 */

import { INSIGHT_KINDS, INSIGHT_STATUSES, PASS_STATES, openInsightStore } from "./insight-store.js";
import { RESOURCE_TYPES } from "./store.js";
import { DEFAULT_COLLECT_INTERVAL_MINUTES, MIN_VIDEO_SECONDS } from "./collect.js";
import { MIN_INSIGHT_INTERVAL_MINUTES, pickCandidates, readInsightConfig, rescoreOne, runInsightPass, topUpTranscripts } from "./insight-extract.js";
import { withMoments } from "./insight-moment.js";
import { STRENGTH_BANDS, strengthOf } from "./insights.js";
import { mergeIdenticalEvidence, runReclassifyPass } from "./insight-reclassify.js";

/** The id shape `newInsightId` mints. Checked before an id reaches SQL. */
const INSIGHT_ID = /^insight-[0-9A-Za-z]+-[0-9a-f]{8}$/;

/** An example of that shape, so a rejection says what a correct one looks like. */
const INSIGHT_ID_EXAMPLE = "insight-20260101T090000Z-1a2b3c4d";

/** The four chips: 新出现 / 升温中 / 有分歧 / 已沉寂. */
const FILTERS = ["new", "rising", "contested", "dormant"];

/**
 * The verdict strip: 待判定 / 成立 / 存疑 / 搁置.
 *
 * `pending` FIRST AND IT IS NOT A STATUS. The other three are members of
 * INSIGHT_STATUSES written into `pinned_status`; this one is the ABSENCE of
 * one, and it is the tab's default view. Declared as its own list rather than
 * spread from INSIGHT_STATUSES because "candidate" is a member of that
 * vocabulary and is emphatically not a verdict — a person never decides that a
 * claim is a candidate, the pass does.
 */
const VERDICTS = ["pending", "standing", "contested", "dormant", "expired"];

/**
 * Sorts the list route accepts.
 *
 * Mirrors InsightStore#list's own SORTABLE map. The store falls back to rank
 * for anything unknown; this route rejects instead, because a silent fallback
 * means `?sort=momentun` renders a page sorted by something else entirely and
 * looks completely correct while doing it.
 */
const SORTS = ["rank", "recent", "new", "momentum", "credibility", "sources"];

/** Longest `?q=` accepted, so a pathological search never reaches LIKE. */
const MAX_SEARCH_CHARS = 200;

/** Longest resource id accepted as a path parameter. */
const MAX_RESOURCE_ID_CHARS = 200;

/**
 * Read one query parameter as a bounded integer.
 * @param params - the parsed search parameters.
 * @param name - the parameter name, used in the message.
 * @param low - smallest acceptable value, inclusive.
 * @param high - largest acceptable value, inclusive.
 * @param fallback - the value when the parameter is absent or empty.
 * @returns `{ value }` when acceptable, `{ error }` when not.
 */
function boundedInteger(params, name, low, high, fallback) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return { value: fallback };
  const value = Number(raw);
  // Checked rather than coerced: `Number("20 rows")` is NaN, and a NaN carried
  // into the store's clamp stays NaN, which SQLite reads as no LIMIT at all.
  // A page asking for twenty rows would be handed twenty thousand, and every
  // layer between here and there would report success.
  if (!Number.isInteger(value) || value < low || value > high) {
    return { error: `${name} must be a whole number between ${low} and ${high}` };
  }
  return { value };
}

/**
 * Read one query parameter constrained to a fixed vocabulary.
 * @param params - the parsed search parameters.
 * @param name - the parameter name, used in the message.
 * @param allowed - the values this parameter may take.
 * @param hint - what omitting it means, appended to the message.
 * @returns `{ value }` — undefined when absent — or `{ error }`.
 */
function oneOf(params, name, allowed, hint = "") {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return { value: undefined };
  const value = raw.trim();
  if (!allowed.includes(value)) {
    return { error: `${name} must be one of ${allowed.join(", ")}${hint === "" ? "" : ` — ${hint}`}` };
  }
  return { value };
}

/**
 * The hallucinated-quote rate, derived from a recorded pass.
 *
 * This is the one number to watch in week one: how many extracted claims lost
 * every trace of support to a quote that was not in the source the model
 * attributed it to. Derived here rather than left to the page because two
 * clients would derive it two ways, and because the reason breakdown has to
 * travel with it — "too short" measures the prompt and "not found in the
 * source it is attributed to" measures invention, and a single total answers
 * neither question.
 * @param record - the `insightLastRun` record, or null.
 * @returns `{ claims, dropped, rate, reasons }`, or null when no pass has run.
 */
function quoteDrop(record) {
  if (record === null || typeof record !== "object" || record.ran !== true) return null;
  const claims = Number(record.claims);
  const dropped = Number(record.dropped);
  // A record whose `dropped` is an array rather than a count would divide to
  // NaN and put NaN on the status page. Reported as "no number yet" instead,
  // which is at least true.
  if (!Number.isFinite(claims) || !Number.isFinite(dropped)) return null;
  return {
    claims,
    dropped,
    // null, not 0, when the pass parsed no claims at all: a rate of zero reads
    // as "nothing was invented", while "nothing was extracted" is a different
    // problem with a different fix.
    rate: claims > 0 ? dropped / claims : null,
    reasons: record.droppedReasons ?? {},
  };
}

/**
 * Register the insight routes onto an existing handler chain.
 * @param deps - `{ store, chat, logger, sendJson, readJson }` from the Host half.
 * @returns `async (req, res, path) => boolean` — true when it answered.
 */
export function createInsightRoutes({ store, chat, logger, sendJson, readJson, web, transcribe }) {
  // Once, at creation. Construction runs the DDL, and a second instance would
  // be a second place to look when a statement is wrong. It throws when handed
  // anything but a SourceStore, which fails at plugin start-up rather than on
  // the first request to a tab nobody opened for a week.
  const insights = openInsightStore(store);

  /**
   * Whether a manual pass started HERE is still running.
   *
   * The same guard the timer carries, for the same reason. A pass is up to
   * twenty model calls over minutes, and two of them started by two presses of
   * one button read the same watermark, cluster the same rows and pay twice
   * for it — while both report success. The second press is answered honestly
   * with `started: false` rather than claiming to have launched something it
   * did not.
   *
   * Held in the closure rather than at module scope so it belongs to ONE
   * library: two handlers over two stores in one process are two independent
   * passes, and a shared flag would have one of them refuse a run the other
   * was making.
   */
  let manualRunInFlight = false;
  // The same shape for the transcript drain: one at a time, and its last
  // report kept so `/insights/status` can say what it did. Two drains over one
  // library would spend the budget twice on the same oldest rows.
  let drainInFlight = false;
  let lastDrain = null;
  // The same shape, for the refiling pass: one at a time, and its last
  // report kept so `/insights/status` can say what it did.
  let refileInFlight = false;
  let lastRefile = null;

  /** The search parameters of the request being answered. */
  const paramsOf = (req) => new URL(req.url ?? "/", "http://localhost").searchParams;

  /**
   * Put the moment on every quote that has one.
   *
   * WHERE IN A VIDEO A SENTENCE WAS SAID IS THE SOURCE, for a talk. A link
   * to a ninety-minute interview is not a citation of one sentence — it
   * hands the reader the search problem back. The library already stores
   * the transcript with a start time on every cue, so the second is
   * computable, and see insight-moment.js for why it is computed at read
   * rather than stored: every evidence row already written has no offset
   * column to have filled in.
   *
   * SHAPED FOR BOTH CALLERS. The list route returns `{ insights: [...] }`
   * with an `evidencePreview` on each, and the item route returns one card
   * with `evidence`; the same two lines would otherwise be written twice
   * and drift the first time one of them gained a field.
   * @param payload - what the store answered, or undefined.
   * @returns the same object, its quotes carrying `at` and `atUrl`.
   */
  /**
   * The band a card's score reads in, computed HERE rather than in the page.
   *
   * The alternative is a copy of the thresholds in client.js, and a threshold
   * table that exists twice is a table that disagrees with itself the first
   * time either copy moves — with the symptom being a card labelled 高 on one
   * screen and 中 on another, out of one number, with nothing throwing.
   *
   * It also keeps the cut where the arithmetic is: `strengthOf` sits beside
   * `scoreInsight`, which is what produced the number it bands.
   * @param row - a shaped insight.
   * @returns the row, carrying `strength`.
   */
  const banded = (row) => ({
    ...row,
    // THE CARD'S OWN INDEPENDENCE AND THE LIBRARY'S OWN FLOOR. The blend does
    // not carry either, and without them the band answers "how recently did we
    // ingest this, from how reputable a kind of source" — which put 强 on
    // single-source cards about a 2009 supercomputer.
    strength: strengthOf(row?.rankScore, {
      independentCount: row?.independentCount,
      minIndependent: readInsightConfig(store).insightMinIndependent,
    }),
  });

  const momentise = (payload) => {
    if (payload === undefined || payload === null) return payload;
    const read = (id) => store.getTranscript(id);
    if (Array.isArray(payload.insights)) {
      return {
        ...payload,
        insights: payload.insights.map((row) => banded({
          ...row,
          evidencePreview: withMoments(row.evidencePreview, read),
        })),
      };
    }
    return Array.isArray(payload.evidence)
      ? banded({ ...payload, evidence: withMoments(payload.evidence, read) })
      : payload;
  };

  return async function handleInsights(req, res, path) {
    /** Answer 400 with `error`, and report the request as handled. */
    const bad = (error) => {
      sendJson(res, 400, { success: false, error });
      return true;
    };

    /**
     * Decode and shape-check an insight id taken from the path.
     * @param raw - the still-encoded path segment.
     * @returns `{ value }`, or `{ error }` naming the id that failed.
     */
    const idFrom = (raw) => {
      let value;
      try {
        value = decodeURIComponent(raw);
      } catch {
        // `decodeURIComponent("%")` throws URIError. Left uncaught it is a 500
        // on a malformed link, which reads as a broken server rather than as a
        // bad request.
        return { error: `"${raw}" is not a usable insight id; ids look like ${INSIGHT_ID_EXAMPLE}` };
      }
      if (!INSIGHT_ID.test(value)) {
        return { error: `"${value}" is not a usable insight id; ids look like ${INSIGHT_ID_EXAMPLE}` };
      }
      return { value };
    };

    // ── the tab itself ───────────────────────────────────────────────────
    if (req.method === "GET" && path === "/insights/list") {
      const params = paramsOf(req);

      const status = oneOf(params, "status", INSIGHT_STATUSES, "omit it to see everything except dormant");
      if (status.error !== undefined) return bad(status.error);
      const kind = oneOf(params, "kind", INSIGHT_KINDS, "omit it for every kind");
      if (kind.error !== undefined) return bad(kind.error);
      // `resourceType`, spelled out, NOT "type". The one thing this parameter
      // must never be is confusable with `kind`: launch / funding / policy are
      // what a claim SAYS, NEWS / PAPER / YOUTUBE_VIDEO are where it CAME FROM,
      // both are plain strings, and neither validates as the other. A shared
      // name would make `?type=funding` a legal-looking request that returns
      // an empty page, and `oneOf` naming the accepted list in its rejection
      // is the whole defence.
      const resourceType = oneOf(params, "resourceType", RESOURCE_TYPES, "omit it for every kind of source");
      if (resourceType.error !== undefined) return bad(resourceType.error);
      // WHAT A PERSON DECIDED, which is a different column from what the pass
      // computed. `pending` is in the vocabulary and is NOT one of
      // INSIGHT_STATUSES: it means the verdict is absent, and it is the tab's
      // default view — a claim a reader has judged should leave the inbox.
      const verdict = oneOf(params, "verdict", VERDICTS, "omit it for every card, judged or not");
      if (verdict.error !== undefined) return bad(verdict.error);
      const filter = oneOf(params, "filter", FILTERS, "omit it for the default view");
      if (filter.error !== undefined) return bad(filter.error);
      const sort = oneOf(params, "sort", SORTS, "the default is rank");
      if (sort.error !== undefined) return bad(sort.error);
      const take = boundedInteger(params, "take", 1, 100, 20);
      if (take.error !== undefined) return bad(take.error);
      const skip = boundedInteger(params, "skip", 0, Number.MAX_SAFE_INTEGER, 0);
      if (skip.error !== undefined) return bad(skip.error);

      const search = (params.get("q") ?? "").trim();
      // Refused rather than truncated: a search silently cut to its first two
      // hundred characters answers a question nobody asked, and its results
      // look exactly like results for the question they did ask.
      if (search.length > MAX_SEARCH_CHARS) return bad(`q must be at most ${MAX_SEARCH_CHARS} characters`);

      // `counts` comes back with every row of the list — the full status tally
      // regardless of the active filter — so the page can offer "+N candidates"
      // without a second request, and `evidencePreview` is already on each
      // card. One request per page view, not one per card.
      sendJson(res, 200, {
        success: true,
        data: momentise(insights.list({
          status: status.value,
          kind: kind.value,
          resourceType: resourceType.value,
          verdict: verdict.value,
          filter: filter.value,
          search: search === "" ? undefined : search,
          sortBy: sort.value ?? "rank",
          take: take.value,
          skip: skip.value,
        })),
      });
      return true;
    }

    // ── one card ─────────────────────────────────────────────────────────
    // The status route is matched FIRST. `/insights/item/<id>/status` also
    // starts with `/insights/item/`, so the generic branch would slice an "id"
    // ending in `/status`, fail the pattern, and answer 400 naming an id the
    // caller never sent: a correct request rejected by the wrong branch, with
    // a message that sends whoever reads it looking in the wrong place.
    if (req.method === "POST" && path.startsWith("/insights/item/") && path.endsWith("/status")) {
      const id = idFrom(path.slice("/insights/item/".length, -"/status".length));
      if (id.error !== undefined) return bad(id.error);

      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        return bad(String(cause?.message ?? cause));
      }
      // An absent `status` and an explicit `null` mean different things — leave
      // the pin alone versus clear it — so absence is rejected rather than
      // read as null. `readJson` answers `{}` for an empty body, which would
      // otherwise clear a person's verdict on every request that forgot to
      // send one.
      if (!Object.hasOwn(body ?? {}, "status")) {
        return bad(`send {"status": "…"} naming one of ${INSIGHT_STATUSES.join(", ")}, or null to hand the card back to the pass`);
      }
      const wanted = body.status;
      if (wanted !== null && !INSIGHT_STATUSES.includes(wanted)) {
        return bad(`status must be one of ${INSIGHT_STATUSES.join(", ")}, or null to clear the pin`);
      }

      // setStatus writes `pinned_status`, which the pass reads and leaves
      // alone. Without the pin this route is a button that works until the
      // next tick quietly reverts it, and nothing on the page would say so.
      if (!insights.setStatus(id.value, wanted)) {
        sendJson(res, 404, { success: false, error: "no such insight" });
        return true;
      }
      // Read back rather than echoing the request: the answer is what the row
      // now holds. Echoing would report a success this route has not verified,
      // and all three fields are returned because `status` (what the pass
      // computed) and `pinnedStatus` (what a person decided) are different
      // answers and the page renders `effectiveStatus`.
      const row = insights.get(id.value);
      sendJson(res, 200, {
        success: true,
        data: {
          id: id.value,
          status: row?.status ?? null,
          pinnedStatus: row?.pinnedStatus ?? null,
          effectiveStatus: row?.effectiveStatus ?? null,
        },
      });
      return true;
    }

    if (req.method === "GET" && path.startsWith("/insights/item/")) {
      const id = idFrom(path.slice("/insights/item/".length));
      if (id.error !== undefined) return bad(id.error);
      // Evidence arrives contradictions first, then newest, each row carrying
      // `resource: null` when the library no longer holds the source. The page
      // renders those as the quote with its `sourceKey` and no link — dropping
      // them would make the card disagree with its own `sourceCount`.
      const insight = momentise(insights.getWithEvidence(id.value));
      if (insight === undefined) {
        sendJson(res, 404, { success: false, error: "no such insight" });
        return true;
      }
      sendJson(res, 200, { success: true, data: insight });
      return true;
    }

    if (req.method === "DELETE" && path.startsWith("/insights/item/")) {
      const id = idFrom(path.slice("/insights/item/".length));
      if (id.error !== undefined) return bad(id.error);
      // The hand correction for a merge that was wrong. It takes the evidence
      // and any dangling `supersedes` with it, in one transaction — a
      // `supersedes` left pointing at a deleted row renders as a history entry
      // that cannot be opened.
      //
      // This is the ONLY hand correction on offer today, and it is a blunt
      // one: deleting the card destroys the evidence with it. Splitting a
      // wrong merge — detaching one evidence row, or setting `supersedes` by
      // hand — is DEFERRED and has no route here. Said out loud because
      // `InsightStore#markSuperseded` exists and is written by the pass alone:
      // an exported method with no caller reads as a feature that is present.
      const removed = insights.remove(id.value);
      if (removed) logger?.info?.(`swarm: removed insight ${id.value}`);
      sendJson(res, 200, { success: true, data: { removed } });
      return true;
    }

    // ── what a source ended up supporting ────────────────────────────────
    if (req.method === "GET" && path.startsWith("/insights/for-resource/")) {
      let resourceId;
      try {
        resourceId = decodeURIComponent(path.slice("/insights/for-resource/".length));
      } catch {
        return bad("the resource id in the path is not valid percent-encoding");
      }
      if (resourceId === "" || resourceId.length > MAX_RESOURCE_ID_CHARS) {
        return bad(`for-resource needs a resource id of 1 to ${MAX_RESOURCE_ID_CHARS} characters`);
      }
      const limit = boundedInteger(paramsOf(req), "limit", 1, 50, 20);
      if (limit.error !== undefined) return bad(limit.error);
      // An empty array is 200, not 404: a source that backs no claim is an
      // ordinary source, and a 404 here would make the 信源 reader render an
      // error for the ordinary case.
      sendJson(res, 200, {
        success: true,
        data: { insights: insights.insightsForResource(resourceId, limit.value) },
      });
      return true;
    }

    // ── the pass ─────────────────────────────────────────────────────────
    // ── file the claims already in the table ─────────────────────────────
    //
    // TWO THINGS CHANGED UNDER THE EXISTING ROWS AND NEITHER IS RETROACTIVE:
    // the language a claim is written in, and `layer` — where in the stack it
    // sits — which the extractor was not asked for until now. Re-running the
    // pass does not fix them, because a pass reads the NEXT two hundred
    // sources rather than the ones it has already read. Without this route
    // the pane groups by a field every existing row leaves null, and every
    // one of them lands under 未归层.
    //
    // SEPARATE FROM run-now ON PURPOSE. That one costs model calls to learn
    // something new; this one costs them to re-file what is already known,
    // and a person deciding to spend on the second is making a different
    // decision. It is also idempotent: the rows it would pick are the ones
    // still missing a layer or still in the wrong language, so running it
    // twice does nothing the second time.
    if (req.method === "POST" && path === "/insights/refile") {
      if (chat === undefined) {
        sendJson(res, 503, { success: false, error: "no model routed" });
        return true;
      }
      if (refileInFlight) {
        sendJson(res, 202, { success: true, data: { started: false, running: true } });
        return true;
      }
      refileInFlight = true;
      // Answered immediately, like run-now and for the same reason: forty
      // claims is four model calls and a request held open reads as a hang.
      void runReclassifyPass({
        insights,
        // A TEXT-IN, TEXT-OUT FACE over the streaming chat this file is
        // handed. The reclassifier asks one question and reads one JSON
        // object; giving it the stream would put the same eight lines of
        // accumulation in a second module.
        chat: async (prompt) => {
          let answer = "";
          for await (const chunk of chat({ prompt, context: "" })) {
            if (typeof chunk?.text === "string") answer += chunk.text;
          }
          return answer;
        },
        config: readInsightConfig(store),
        logger,
      })
        .then((report) => { lastRefile = report; })
        .catch((cause) => { logger?.warn?.(`swarm: refiling claims failed: ${String(cause?.message ?? cause)}`); })
        .finally(() => { refileInFlight = false; });
      sendJson(res, 202, { success: true, data: { started: true, running: true } });
      return true;
    }

    if (req.method === "POST" && path === "/insights/run-now") {
      if (chat === undefined) {
        // 503, not 500: the page shows a different thing for "not configured"
        // than for "broken", and telling somebody to read the logs when they
        // have simply not routed a model costs them an afternoon.
        sendJson(res, 503, { success: false, error: "no model routed" });
        return true;
      }
      // WHAT THIS RUN IS ALLOWED TO READ, when the reader said.
      //
      // Optional and absent-means-everything, so a bare POST is exactly the
      // run this route has always made. A body that is present and wrong is a
      // 400 naming what is accepted rather than a run quietly made over the
      // wrong slice — the second rule at the top of this file.
      let scope = {};
      const hasBody = Number(req.headers?.["content-length"] ?? 0) > 0
        || typeof req.headers?.["transfer-encoding"] === "string";
      if (hasBody) {
        let body;
        try {
          body = await readJson(req);
        } catch (cause) {
          sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
          return true;
        }
        const problems = [];
        const asked = body ?? {};
        // A WINDOW IN DAYS, TURNED INTO AN INSTANT HERE. The client sends
        // `days` rather than a timestamp so the boundary is computed against
        // the Host's clock: a browser three hours out would otherwise ask for
        // "the last week" and get six days and twenty-one hours, silently.
        if (asked.days !== undefined && asked.days !== null && asked.days !== "") {
          const days = Number(asked.days);
          if (!Number.isFinite(days) || days <= 0 || days > 365) {
            problems.push("days must be a number of days between 1 and 365, or absent to carry on from the last pass");
          } else {
            scope.since = new Date(Date.now() - days * 86_400_000).toISOString();
            scope.days = days;
          }
        }
        if (asked.search !== undefined && asked.search !== null && String(asked.search).trim() !== "") {
          const search = String(asked.search).trim();
          if (search.length > MAX_SEARCH_CHARS) {
            problems.push(`search must be ${MAX_SEARCH_CHARS} characters or fewer`);
          } else {
            scope.search = search;
          }
        }
        if (Array.isArray(asked.types) && asked.types.length > 0) {
          for (const type of asked.types) {
            if (!RESOURCE_TYPES.includes(type)) problems.push(`types must be drawn from ${RESOURCE_TYPES.join(", ")}`);
          }
          if (problems.length === 0) scope.types = [...asked.types];
        } else if (Array.isArray(asked.types)) {
          // An empty array is a reader who unticked every box. Reading
          // everything instead would be the page doing the opposite of what
          // the form plainly says.
          problems.push("types must name at least one source type");
        }
        // HOW MANY TRANSCRIPTS TO GO AND GET, for this run only. The schedule
        // takes a modest twelve an hour because it runs unattended; somebody
        // sitting in front of a mostly-untranscribed library wants to spend a
        // few minutes draining it, and has no way to say so otherwise.
        if (asked.transcribe !== undefined && asked.transcribe !== null && asked.transcribe !== "") {
          const many = Number(asked.transcribe);
          if (!Number.isInteger(many) || many < 0 || many > 60) {
            problems.push("transcribe must be a whole number from 0 (skip the top-up) to 60");
          } else {
            scope.transcribe = many;
          }
        }
        // HOW OLD A SOURCE MAY BE, for this run. Distinct from `days`, which
        // moves the WATERMARK — where the reader got to. This moves the
        // freshness floor: "read the last quarter" is a different request from
        // "re-read what we already covered", and the two were being confused
        // because both are a number of days.
        if (asked.maxAgeDays !== undefined && asked.maxAgeDays !== null && asked.maxAgeDays !== "") {
          const age = Number(asked.maxAgeDays);
          if (!Number.isInteger(age) || age < 0 || age > 3650) {
            problems.push("maxAgeDays must be a whole number of days from 0 (no floor) to 3650");
          } else {
            scope.maxAgeDays = age;
          }
        }
        // HOW MANY MODEL CALLS THIS RUN MAY MAKE — one per story. The
        // dialog asks for this rather than for rows, because it is the number
        // that bills and rows are the scan working set behind it.
        if (asked.maxClusters !== undefined && asked.maxClusters !== null && asked.maxClusters !== "") {
          const many = Number(asked.maxClusters);
          if (!Number.isInteger(many) || many < 1 || many > 60) {
            problems.push("maxClusters must be a whole number between 1 and 60");
          } else {
            scope.maxClusters = many;
          }
        }
        if (asked.maxRows !== undefined && asked.maxRows !== null && asked.maxRows !== "") {
          const rows = Number(asked.maxRows);
          if (!Number.isInteger(rows) || rows < 20 || rows > 6000) {
            problems.push("maxRows must be a whole number between 20 and 6000");
          } else {
            scope.maxRows = rows;
          }
        }
        if (problems.length > 0) {
          sendJson(res, 400, { success: false, error: problems.join("; ") });
          return true;
        }
      }
      // REFUSED ONLY AFTER THE BODY HAS BEEN READ, and the order is the bug.
      //
      // This answered 202 the moment it saw a pass already running — before
      // touching the request body. The client is still sending one, so the
      // response lands on a connection with an unread stream behind it, the
      // socket is torn down, and the PROXY in front of this reports
      // "fetch failed" as a 502. Measured through the Tailscale hop: a second
      // press of 运行分析 answered 502 while the first pass ran perfectly, so
      // the page reported the library as unreachable at the exact moment it
      // was busiest.
      //
      // A body must be consumed whatever the answer is going to be. Parsing it
      // first also means a malformed scope is still a 400 rather than being
      // swallowed by a 202 that says the run was refused for a different
      // reason entirely.
      if (manualRunInFlight) {
        sendJson(res, 202, {
          success: true,
          data: { started: false, running: true, reason: "a manual pass is already running" },
        });
        return true;
      }
      manualRunInFlight = true;
      // Answered immediately and the work continues: a pass is up to twenty
      // model calls, and a request held open for minutes reads as a hang.
      // `markSkips: false` — a manual run must not advance the watermark and
      // silently cancel the scheduled one, which would leave the rows it
      // skipped unread forever.
      //
      // Not awaited, so nothing here may reject: an unhandled rejection takes
      // the process with it. `runInsightPass` is specified to settle every
      // path into a record, but this file cannot verify that and a catch costs
      // one line.
      // AND THE EVIDENCE-IDENTITY MERGE AFTER IT. The pass's own de-duplication
      // is a simhash over the STATEMENT, which catches the same claim
      // re-extracted in the same words and misses it entirely when the wording
      // moves — a translated claim and a freshly-extracted one are the same
      // fact with two hashes. Two claims resting on an identical set of quotes
      // are one claim whatever they say, and that test needs no threshold.
      void runInsightPass(store, insights, chat, logger, { markSkips: false, web, scope, transcribe })
        .then(() => mergeIdenticalEvidence(insights, logger))
        .catch((cause) => { logger?.warn?.(`swarm: manual insight pass failed: ${String(cause?.message ?? cause)}`); })
        .finally(() => { manualRunInFlight = false; });
      // The outcome arrives on `/insights/status` as `insightLastManualRun`,
      // which `runInsightPass` stamps `running` before it starts and replaces
      // when it settles — a skip carries its reason, a failure carries its
      // error. A pass that finds nothing and says nothing is the exact bug
      // this codebase keeps hitting.
      sendJson(res, 202, { success: true, data: { started: true, running: true } });
      return true;
    }

    // ── rescore every card, with no pass attached ───────────────────────
    //
    // A ROUTE BECAUSE A SCORING CHANGE IS RETROACTIVE AND THE SWEEP IS NOT.
    // Scores are stored, not computed on read — the list orders by them and an
    // ORDER BY over an expression cannot use an index — so changing what
    // novelty MEANS leaves every existing row carrying the old meaning. The
    // rescore sweep repairs them at `RESCORE_SWEEP` per pass on a
    // `RESCORE_AFTER_MINUTES` clock, which is correct for decay and far too
    // patient for a redefinition: until it catches up the tab is sorted by two
    // different formulas at once, with nothing on screen to say which card is
    // which.
    //
    // NO MODEL CALLS. This is arithmetic over rows the library already holds.
    if (req.method === "POST" && path === "/insights/rescore") {
      const config = readInsightConfig(store);
      const now = new Date().toISOString();
      let scored = 0;
      let failed = 0;
      // Synchronous and answered when done, unlike run-now: scoring 72 cards is
      // milliseconds, and a 202 for work that finishes before the response
      // would be a progress display nobody could ever observe.
      for (const row of insights.list({ take: 100, verdict: undefined }).insights) {
        try {
          // `touched: false` — this is a recomputation, not new evidence, so it
          // must not look like the claim was seen again.
          if (rescoreOne(insights, row.id, config, now, false)) scored += 1;
        } catch (cause) {
          failed += 1;
          logger?.warn?.(`swarm: rescoring ${row.id} failed: ${String(cause?.message ?? cause)}`);
        }
      }
      sendJson(res, 200, { success: true, data: { scored, failed } });
      return true;
    }

    // ── empty the board and start again ─────────────────────────────────
    //
    // GUARDED BY A COUNT, NOT A FLAG. `{confirm: true}` is one keystroke from
    // `{confirm: false}` and both are things a script writes by accident; the
    // caller has to send the number of claims it believes it is destroying, and
    // a stale number is refused. Somebody who has not looked cannot supply it.
    //
    // THE WATERMARK GOES WITH THEM. Deleting the claims without resetting it
    // leaves a library that has been read and has nothing to show for it: the
    // next pass carries on from where the old one stopped, re-reads nothing,
    // and the board stays empty until new material arrives.
    if (req.method === "POST" && path === "/insights/purge") {
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return true;
      }
      const held = insights.count();
      const claimed = Number(body?.expect);
      if (!Number.isInteger(claimed) || claimed !== held) {
        sendJson(res, 409, {
          success: false,
          error: `send {"expect": ${held}} to confirm; the board holds ${held} claim(s) and the request said ${body?.expect ?? "nothing"}`,
          held,
        });
        return true;
      }
      const removed = insights.purge();
      // Both records, because either may carry a watermark and the drain reads
      // whichever the scheduled pass wrote. Cleared here rather than through
      // the settings whitelist, which has never allowed these keys to be
      // written from outside and should stay that way.
      store.setSetting("insightLastRun", null);
      store.setSetting("insightLastManualRun", null);
      store.setSetting("insightLastGoodRun", null);
      sendJson(res, 200, { success: true, data: { ...removed, watermark: "reset" } });
      return true;
    }

    // ── fetch transcripts, with no pass attached ────────────────────────
    //
    // A ROUTE OF ITS OWN BECAUSE IT IS A DIFFERENT JOB. The pass tops up as
    // preparation for the reading it is about to do, so it tops up what THIS
    // scan skipped — which is correct, and useless for draining a backlog: a
    // scoped run narrows the scan, so a run scoped to a topic nobody wrote
    // about skips nothing and therefore fetches nothing. That was tried, on
    // the argument that it would drain the backlog at no model cost, and it
    // fetched zero.
    //
    // Draining is not a pass with the reading removed. It is a queue with a
    // budget, and it costs no model calls because no model is involved.
    if (req.method === "POST" && path === "/insights/transcribe") {
      if (transcribe === undefined) {
        sendJson(res, 503, { success: false, error: "no transcript fetcher wired on this host" });
        return true;
      }
      let limit = 20;
      const hasBody = Number(req.headers?.["content-length"] ?? 0) > 0
        || typeof req.headers?.["transfer-encoding"] === "string";
      if (hasBody) {
        // Read whatever the answer is going to be — the lesson from run-now,
        // where returning before draining the stream reset the proxy's
        // connection and surfaced as a 502 blaming the library.
        let body;
        try {
          body = await readJson(req);
        } catch (cause) {
          sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
          return true;
        }
        if (body?.limit !== undefined && body.limit !== null && body.limit !== "") {
          const many = Number(body.limit);
          if (!Number.isInteger(many) || many < 1 || many > 200) {
            sendJson(res, 400, { success: false, error: "limit must be a whole number between 1 and 200" });
            return true;
          }
          limit = many;
        }
      }
      // REFUSED ONLY AFTER THE BODY IS READ — and this route reproduced the
      // exact fault it was written a few minutes after fixing. run-now
      // answered its in-flight 202 before touching the request stream, the
      // socket was torn down with a body still arriving, and the proxy in
      // front reported the library as unreachable. Written fresh, this route
      // put its own guard in the same wrong place.
      //
      // The rule, for every route here that takes a body: consume it first,
      // whatever the answer is going to be. Caught by a probe that sent a
      // deliberately invalid limit and got 202 instead of 400.
      if (drainInFlight) {
        sendJson(res, 202, { success: true, data: { started: false, running: true, reason: "a drain is already running" } });
        return true;
      }
      const waiting = store.videosWithoutTranscript(limit);
      if (waiting.length === 0) {
        sendJson(res, 200, { success: true, data: { started: false, tried: 0, gained: 0, remaining: 0, reason: "every video already has one" } });
        return true;
      }
      drainInFlight = true;
      // Answered immediately, like run-now and for the same reason: 200 fetches
      // against three free endpoints is minutes, and a request held open that
      // long reads as a hang. The outcome arrives on `/insights/status`.
      void topUpTranscripts(store, waiting.map((row) => ({ row, reason: "no transcript stored" })), {
        transcribe,
        limit,
        logger,
      })
        .then((report) => {
          lastDrain = {
            at: new Date().toISOString(),
            tried: report.tried,
            gained: report.gained,
            stopped: report.stopped,
            remaining: store.countVideosWithoutTranscript(),
          };
        })
        .catch((cause) => {
          lastDrain = { at: new Date().toISOString(), tried: 0, gained: 0, stopped: String(cause?.message ?? cause), remaining: null };
          logger?.warn?.(`swarm: transcript drain failed: ${String(cause?.message ?? cause)}`);
        })
        .finally(() => { drainInFlight = false; });
      sendJson(res, 202, { success: true, data: { started: true, running: true, queued: waiting.length } });
      return true;
    }

    // ── what one pass actually did, source by source ────────────────────
    // ── which videos are still waiting on a transcript ──────────────────
    //
    // READ-ONLY, AND IT EXISTS BECAUSE THE QUEUE WAS ONLY EVER VISIBLE AS A
    // COUNT. `/insights/transcribe` walks the same list but fetching is the
    // only thing it will do with it, so anything that wanted to SEE the queue —
    // a person deciding whether to buy quota, a tool fetching captions by some
    // route this Host has no way to reach — had to start a paid drain to find
    // out what was in it.
    //
    // The rows it names are exactly the ones a drain would try, in the order it
    // would try them, so a caller that fills them in from elsewhere and posts
    // them to `/transcript/ingest` is doing the drain's work rather than
    // racing it. Videos proven to publish no captions are already excluded by
    // the store, so nothing here is a video anyone should ask about again.
    if (req.method === "GET" && path === "/insights/awaiting") {
      const take = boundedInteger(params, "take", 1, 200, 50);
      sendJson(res, 200, {
        success: true,
        data: {
          waiting: store.countVideosWithoutTranscript?.() ?? null,
          captionsUnavailable: store.countVideosWithoutCaptions?.() ?? null,
          videos: store.videosWithoutTranscript?.(take) ?? [],
        },
      });
      return true;
    }

    if (req.method === "GET" && path === "/insights/ledger") {
      const params = new URL(req.url, "http://local").searchParams;
      const batch = params.get("batch") ?? undefined;
      const state = params.get("state") ?? undefined;
      // A bad state is a 400 naming the vocabulary, not an empty list. An
      // empty list from a typo is indistinguishable from a pass in which
      // nothing failed, which is the one thing a reader opens this to learn.
      if (state !== undefined && state !== "" && !PASS_STATES.includes(state)) {
        sendJson(res, 400, { success: false, error: `state must be one of ${PASS_STATES.join(", ")}` });
        return true;
      }
      const take = boundedInteger(params, "take", 1, 500, 200);
      if (take.error !== undefined) {
        sendJson(res, 400, { success: false, error: take.error });
        return true;
      }
      const ledger = insights.passLedger(batch, { state: state === "" ? undefined : state, take: take.value });
      sendJson(res, 200, {
        success: true,
        data: {
          ...ledger,
          // Every state the vocabulary holds, so a page can draw a zero rather
          // than omit a column. A missing "取文失败" column and a "取文失败 0"
          // column say different things, and the first one says it by accident.
          states: PASS_STATES,
          // The passes still on record, so a reader can look at the one before
          // this one rather than only at the newest.
          batches: insights.passBatches(),
          // THE PROVENANCE GRADE OF THE RUN THIS LEDGER BELONGS TO. Read off
          // the run record rather than recomputed here: the pass counted it
          // while it had the cues in hand, and a second implementation over a
          // different set of rows would be a second answer to one question.
          //
          // Matched by batch, because the newest ledger and the newest run
          // record are the same pass only until somebody starts another one.
          ...(() => {
            const config = readInsightConfig(store);
            const run = [config.insightLastRun, config.insightLastManualRun]
              .filter((one) => one !== null && one !== undefined)
              .find((one) => one.batch === ledger.batch);
            return run === undefined
              ? {}
              : { spokenQuotes: run.spokenQuotes, locatedQuotes: run.locatedQuotes };
          })(),
        },
      });
      return true;
    }

    if (req.method === "GET" && path === "/insights/status") {
      const config = readInsightConfig(store);
      // `insightLastRun` and `insightLastManualRun` arrive inside `config` and
      // are NOT repeated here under shorter names. Two names for one value
      // drift the moment somebody filters one of them, and the page would then
      // show a stale skip reason beside a fresh success with no way to tell
      // which was which.
      //
      // Each record carries its own verdict: `{ran:true, …}` on a success,
      // `{skipped:"…"}` with the REASON, `{error:"…"}` on a failure, or
      // `{running:true}` while a pass is in flight.
      const waiting = pickCandidates(store, config).length;
      const ceiling = Number(config.insightMaxRows);
      sendJson(res, 200, {
        success: true,
        data: {
          ...config,
          // Whether the refiling pass is running, and what the last one did.
          // A reader who presses 归类 and sees nothing change needs to know
          // whether it is working or whether it found nothing to do.
          insightRefiling: refileInFlight,
          insightLastRefile: lastRefile,
          // HOW MANY VIDEOS ARE HELD WITH NO TRANSCRIPT, which is the number
          // that explains a pass reading 10 sources out of 206. It was
          // computable from the day videos were collected and reported nowhere.
          //
          // Counted over the whole library rather than over the next slice: a
          // reader asking "why is the pass only reading a corner of this" wants
          // the size of the corner, not this tick's share of it.
          awaitingTranscript: store.countVideosWithoutTranscript?.() ?? null,
          // REPORTED BESIDE THE QUEUE, NOT INSIDE IT. These are videos every
          // route has agreed publish no captions at all; they are not waiting
          // for quota, a key, or a faster schedule. Summed into one figure the
          // number lied in the direction that costs money — "97 still have no
          // transcript" reads as 97 fetches to be paid for.
          captionsUnavailable: store.countVideosWithoutCaptions?.() ?? null,
          // HOW OFTEN THE PASS CAN ACTUALLY RUN, which is not what it is set to.
          //
          // The pass is chained after collection and only asks whether it is
          // due; it cannot tick more often than the thing that calls it. The
          // code has said so in a comment since it was written — "30 under an
          // hourly collection is an hourly pass" — and the tab went on
          // reporting 每 30 分钟 regardless, which is a schedule the reader was
          // told they had set and never got. Setting it to 30 today changed
          // nothing at all and nothing said why.
          insightEffectiveIntervalMinutes: (() => {
            const asked = Number(config.insightIntervalMinutes);
            if (!Number.isFinite(asked) || asked <= 0) return 0;
            const driver = Number(store.getSetting("collectIntervalMinutes", DEFAULT_COLLECT_INTERVAL_MINUTES));
            if (!Number.isFinite(driver) || driver <= 0) return asked;
            // The pass runs on a collection tick at which it is also due, so
            // the true cadence is the driver rounded up to cover the ask.
            return Math.max(driver, Math.ceil(asked / driver) * driver);
          })(),
          // Whether a drain is running here, and what the last one did. A
          // number that is not moving and a fetcher that is not running look
          // identical from the count alone.
          transcriptDraining: drainInFlight,
          lastTranscriptDrain: lastDrain,
          // What the NEXT pass would read, so the schedule can be judged
          // before it runs rather than by reading tomorrow's tab.
          waiting,
          // True when the next pass would read its whole allowance, which
          // means there is very likely more behind it. The watermark moves
          // past rows a pass did not read, so a backlog is not merely late —
          // it is dropped, and `waiting` on its own reports a capped number as
          // a healthy one.
          waitingAtCap: Number.isFinite(ceiling) && waiting >= ceiling,
          // Carries the two numbers to watch weekly: the standing-card count
          // for sprawl, and `oldestScoredAt` for a rescore sweep falling
          // behind — a value drifting away from now means the ranking on
          // screen is stale while every route still answers 200.
          stats: insights.stats(),
          quoteDrop: quoteDrop(config.insightLastRun ?? null),
          // THE COLLECTION INTERVAL, BECAUSE THE PASS RIDES ITS TICK.
          //
          // `startCollectionTimer` returns early when collection is off, and
          // the insight pass is inside that timer — so an installation with
          // `insightIntervalMinutes: 60` and `collectIntervalMinutes: 0` has a
          // schedule set, reports it, and never runs. That combination is
          // logged once at boot into a file nobody reading the tab will open.
          // The number goes on the wire so the arming control can say so at
          // the moment somebody arms it.
          //
          // Read straight off the store rather than through `readConfig`:
          // importing index.js here would close a cycle — index.js is what
          // mounts this router.
          // THE SAME FALLBACK index.js USES, imported rather than retyped. This
          // read `0`, so an installation that had never touched the setting —
          // which is every installation collecting happily at the default —
          // reported collection as OFF, and the pane told its reader their
          // schedule would never fire. Unset is not zero; unset is this number.
          collectIntervalMinutes: Number(store.getSetting("collectIntervalMinutes", DEFAULT_COLLECT_INTERVAL_MINUTES)),
          // The floor `writeConfig` enforces, so the picker offers what the
          // validator accepts instead of finding out by being refused. A page
          // that has to guess a bound is a page that guesses it wrong the
          // first time somebody moves it.
          insightMinIntervalMinutes: MIN_INSIGHT_INTERVAL_MINUTES,
          // The freshness floor, so the pane can state the 口径 it is actually
          // reading under. It was reading everything above the watermark and
          // saying nothing about age at all.
          insightMaxAgeDays: Number(readInsightConfig(store).insightMaxAgeDays),
          insightExpireAfterDays: Number(readInsightConfig(store).insightExpireAfterDays),
          // The cuts a strength band is read at, so the pane can STATE them
          // rather than print 高 over a number nobody was shown the scale for.
          // A judgement a reader cannot see is indistinguishable from one
          // invented for the look of it.
          strengthBands: STRENGTH_BANDS,
          // The length floor the collector applies, so the pane's 口径 can name
          // the rule the library is actually enforcing. It has been enforced
          // since videos were first collected and stated nowhere.
          minVideoSeconds: MIN_VIDEO_SECONDS,
          // The source vocabulary a scoped run may name, so the dialog offers
          // the list the route validates against instead of a copy of it.
          resourceTypes: RESOURCE_TYPES,
          // Whether THIS process has a manual pass in flight. Deliberately
          // distinct from the record's own `running` stamp, which survives a
          // crash: a stamp with no process behind it is precisely the "started"
          // that never finishes, and holding both is how the page tells them
          // apart instead of spinning forever.
          manualRunInFlight,
        },
      });
      return true;
    }

    // Anything else under `/insights/` is not ours. Reported as unhandled so
    // the outer router 404s it in one place, rather than each sub-router
    // inventing its own not-found.
    return false;
  };
}
