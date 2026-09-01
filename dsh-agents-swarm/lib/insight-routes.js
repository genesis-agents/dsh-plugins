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

import { INSIGHT_KINDS, INSIGHT_STATUSES, openInsightStore } from "./insight-store.js";
import { pickCandidates, readInsightConfig, runInsightPass } from "./insight-extract.js";
import { withMoments } from "./insight-moment.js";
import { mergeIdenticalEvidence, runReclassifyPass } from "./insight-reclassify.js";

/** The id shape `newInsightId` mints. Checked before an id reaches SQL. */
const INSIGHT_ID = /^insight-[0-9A-Za-z]+-[0-9a-f]{8}$/;

/** An example of that shape, so a rejection says what a correct one looks like. */
const INSIGHT_ID_EXAMPLE = "insight-20260101T090000Z-1a2b3c4d";

/** The four chips: 新出现 / 升温中 / 有分歧 / 已沉寂. */
const FILTERS = ["new", "rising", "contested", "dormant"];

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
export function createInsightRoutes({ store, chat, logger, sendJson, readJson, web }) {
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
  const momentise = (payload) => {
    if (payload === undefined || payload === null) return payload;
    const read = (id) => store.getTranscript(id);
    if (Array.isArray(payload.insights)) {
      return {
        ...payload,
        insights: payload.insights.map((row) => ({
          ...row,
          evidencePreview: withMoments(row.evidencePreview, read),
        })),
      };
    }
    return Array.isArray(payload.evidence)
      ? { ...payload, evidence: withMoments(payload.evidence, read) }
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
      void runInsightPass(store, insights, chat, logger, { markSkips: false, web })
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
