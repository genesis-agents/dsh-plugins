/**
 * The mission tab's HTTP face: open one, watch it, stop it, read what it wrote.
 *
 * Mirrors lib/insight-routes.js deliberately — one factory over the Host half's
 * helpers, returning a handler that either answers or reports that it did not,
 * so index.js keeps one router rather than three competing ones.
 *
 * FOUR THINGS THAT LOOK LIKE STYLE AND ARE NOT:
 *
 * 1. Every route here carries a SECOND segment under `/missions/`. index.js
 *    dispatches with `path.startsWith("/missions/")`, and
 *    `"/missions".startsWith("/missions/")` is false — a route at bare
 *    `/missions` would 404 while this handler sat registered, loaded and
 *    perfectly able to answer it. Adding one later means widening the dispatch
 *    condition in index.js in the same change.
 *
 * 2. A LONG-RUNNING MISSION NEVER HOLDS A REQUEST OPEN. `create`, `resume` and
 *    `rerun` claim the row, dispatch the run WITHOUT awaiting it, and answer
 *    with the id. A `deep` mission runs for three hours; a request that waited
 *    for it would time out somewhere in the middle with the work still going and
 *    the browser reporting a failure that did not happen. Progress is read from
 *    `/view` and streamed from `/events`.
 *
 * 3. A bad parameter is a 400 naming the accepted values, never an empty list.
 *    An empty list from a typo is indistinguishable from an empty list from no
 *    data, which is a filter that looks like it works and shows nothing. On the
 *    routes added for the trajectory tab this goes one step further: a
 *    parameter the route does NOT read is refused too, and the refusal names
 *    the ones it does — see `strayParams`.
 *
 * 4. EXACTLY ONE ROUTE TAKES A FOURTH PATH SEGMENT. `/missions/<id>/trace/<ref>`
 *    is the detail behind one trajectory row; every other action is matched on
 *    its own segment alone, so `splitMissionPath` returns the tail separately
 *    and the handler refuses it everywhere else. Folding it into the action
 *    would make `/missions/<id>/cancel/oops` a cancel.
 *
 * WHAT THE TRAJECTORY ROUTES ARE FOR. `/view` answers "what is this mission
 * doing" in counters, which is the right answer for a page that polls. It is
 * the wrong answer for a person asking "what did it actually do" — the mission
 * tab showed "已核验 6 · 1 个独立站点" and there was no route anywhere that could
 * return one of those six. `/findings` returns them, quote and source and
 * verify state; `/trace` returns everything the mission did as one ordered
 * list; `/trace/<ref>` returns whatever that list had to truncate, whole.
 *
 * The `path` argument arrives already stripped of ROUTE_PREFIX and WITHOUT a
 * query string (index.js hands over `url.pathname`), which is why
 * `path === "/missions/list"` matches a request carrying seven parameters.
 *
 * @see docs/insight-mission.md §9 — the read model and the routes over it.
 */

import {
  DEPTH_TIERS,
  MISSION_STATUSES,
  RESUME_REFUSALS,
  STAGES,
  TERMINAL_STATUSES,
  budgetGate,
  canResume,
  computeWallFloorMs,
  finalize,
} from "./mission-runtime.js";
import { concurrencyCap } from "./mission-handlers.js";
import {
  COUNTING_VERIFY_STATE,
  FETCH_BACKED_VERIFY_STATES,
  FIGURE_MIME_TYPES,
  FINDING_ORDERS,
  MIN_DOCUMENT_CHARS,
  VERIFY_STATES,
  isMissionId,
} from "./mission-store.js";
import {
  INSIGHT_STAGES,
  TRACE_DETAIL_CHARS,
  TRACE_KINDS,
  TRACE_ORDERS,
  TRACE_RESULT_CHARS,
  TRACE_ROLES,
  buildBibliography,
  renderFigureTokens,
  buildMissionTrace,
  parseTraceRef,
  projectDegradeReason,
  projectFinding,
  projectMissionView,
  projectStageInsights,
  readMissionViewInput,
  resolveTraceSource,
  sliceMissionTrace,
  traceVocabulary,
} from "./mission-view.js";
import {
  BUDGET_FIELDS,
  BUDGET_FIELD_LIMITS,
  DEPTH_TIER_BUDGETS,
  LADDER,
  resolveBudget,
} from "./mission-budget.js";

/** An example id, so a rejection says what a correct one looks like. */
const MISSION_ID_EXAMPLE = "mission-20260101T090000Z-1a2b3c4d";

/** Longest topic accepted. Past this it is a document, not a question. */
const MAX_TOPIC_CHARS = 500;

/** How many events one SSE catch-up frame carries. */
const EVENT_PAGE = 200;

/** How often the stream re-reads. One process, one connection: this is a query, not a subscription. */
const EVENT_POLL_MS = 1000;

/** How long a stream stays open with nothing to say before it closes and asks the client to resume. */
const EVENT_IDLE_MS = 10 * 60_000;

/**
 * THE THREE WINDOWS THE TRAJECTORY IS ASSEMBLED FROM, together in one place so
 * they can be read against each other.
 *
 * `/missions/<id>/trace` merges three unbounded tables. A three-hour `deep`
 * mission writes tens of thousands of `mission_events` rows — §4.7 keeps the
 * WRITE unbounded on purpose — and serving all of them would put megabytes
 * through the same blocking connection the mission is writing on, to render a
 * list a person scrolls thirty rows of. So each stream is read newest-end-first
 * to its own cap, the merged list is paged, and the response reports which caps
 * were hit under `window` rather than silently presenting a partial history as
 * a complete one. A trajectory that quietly stops at the thousandth event looks
 * exactly like a mission that stopped doing things.
 *
 * Each cap is at or under the store method's own clamp, so the number here is
 * the number that takes effect: `eventTail` clamps at 1000, `recentToolCalls`
 * at 500, `listFindings` at 2000.
 */
const TRACE_EVENT_WINDOW = 1000;

/** See `TRACE_EVENT_WINDOW`. `recentToolCalls` clamps at this exact value. */
const TRACE_TOOL_WINDOW = 500;

/** See `TRACE_EVENT_WINDOW`. `listFindings` clamps at this exact value. */
const TRACE_FINDING_WINDOW = 2000;

/** Most rows one trajectory page returns. */
const TRACE_PAGE_MAX = 500;

/** Rows per trajectory page when the caller does not say. About three screens of a dense list. */
const TRACE_PAGE_DEFAULT = 100;

/** Most findings one evidence page returns. */
const FINDINGS_PAGE_MAX = 200;

/** Findings per page when the caller does not say. */
const FINDINGS_PAGE_DEFAULT = 50;

/** Longest a filter string may be. Past this it is not a filter, it is a payload. */
const MAX_FILTER_CHARS = 200;

/**
 * Read one query parameter as a bounded integer.
 *
 * Checked rather than coerced: `Number("20 rows")` is NaN, and a NaN carried
 * into the store's clamp stays NaN, which SQLite reads as no LIMIT at all.
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
  if (!Number.isInteger(value) || value < low || value > high) {
    return { error: `${name} must be a whole number between ${low} and ${high}` };
  }
  return { value };
}

/**
 * Read one query parameter constrained to a fixed vocabulary.
 * @param params - the parsed search parameters.
 * @param name - the parameter name.
 * @param allowed - the values this parameter may take.
 * @returns `{ value }` — undefined when absent — or `{ error }`.
 */
function oneOf(params, name, allowed) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return { value: undefined };
  const value = raw.trim();
  if (!allowed.includes(value)) return { error: `${name} must be one of ${allowed.join(", ")}` };
  return { value };
}

/**
 * Read one free-text query parameter, bounded.
 * @param params - the parsed search parameters.
 * @param name - the parameter name.
 * @returns `{ value }` — undefined when absent or empty — or `{ error }`.
 */
function boundedText(params, name) {
  const raw = params.get(name);
  if (raw === null) return { value: undefined };
  const value = raw.trim();
  if (value === "") return { value: undefined };
  if (value.length > MAX_FILTER_CHARS) {
    return { error: `${name} must be at most ${MAX_FILTER_CHARS} characters` };
  }
  return { value };
}

/**
 * Refuse any query parameter the route does not read, naming the ones it does.
 *
 * The same rule `/missions/create` applies to its body, and for the same
 * reason: `{"tier":"quick"}` was accepted, silently ignored, and cost a whole
 * run. A query string has exactly the failure mode — `?dimension=d3` where the
 * parameter is `dimensionId` returns every finding in the mission, which reads
 * as a filter that works and a dimension with far more evidence than it has.
 *
 * Applied to the routes below only. Retrofitting `view`, `events` and
 * `artifact` would be the right thing and is a separate change: the browser
 * half already calls those, and turning a tolerated parameter into a 400 on a
 * route the live tab polls is a change that has to land WITH its caller.
 *
 * @param params - the parsed search parameters.
 * @param known - every parameter this route reads, in the order to print them.
 * @returns null when every parameter is known, or the refusal sentence.
 */
function strayParams(params, known) {
  const stray = [...new Set(params.keys())].filter((key) => !known.includes(key));
  if (stray.length === 0) return null;
  // "It takes ." is not a sentence. A route that reads NO parameters says so,
  // because the reader's next move — drop the parameter — is different from
  // the reader's next move when one of several names was mistyped.
  return known.length === 0
    ? `this route does not read ${stray.join(", ")}, or any other parameter.`
    : `this route does not read ${stray.join(", ")}. It takes ${known.join(", ")}.`;
}

/**
 * The mission id, the action, and the two optional segments beneath it.
 *
 * `/missions/<id>/<action>`, `/missions/<id>/trace/<ref>` and
 * `/missions/<id>/stages/<stepId>/rerun`. The tail segments are returned rather
 * than folded into the action so the handler can REFUSE them everywhere they do
 * not belong: without that check `/missions/<id>/cancel/oops` would match
 * `action === "cancel"` and cancel the mission, which is a route ignoring part
 * of its own path and doing the thing anyway.
 *
 * The fifth segment is a SEGMENT, not a suffix parsed off the fourth. The stage
 * rerun addresses a step id and step ids are `s3-collect`, so reading a trailing
 * verb out of `rest` would make a step id that happens to end in one mean
 * something else entirely.
 *
 * @param path - the already-stripped path.
 * @returns `{ id, action, rest, leaf }` — each tail is null when absent — or null when the shape does not match.
 */
function splitMissionPath(path) {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length < 3 || parts.length > 5 || parts[0] !== "missions") return null;
  let id;
  let rest = null;
  let leaf = null;
  try {
    id = decodeURIComponent(parts[1]);
    if (parts.length >= 4) rest = decodeURIComponent(parts[3]);
    if (parts.length === 5) leaf = decodeURIComponent(parts[4]);
  } catch {
    return null;
  }
  return { id, action: parts[2], rest, leaf };
}

/**
 * Build the mission routes.
 *
 * `chat` and `web` are deliberately NOT taken here even though the contract's
 * factory shape names them: the runner already holds the agent seam and resolves
 * `ctx.get("web")` per tool recall, and a second holder of either would be a
 * second place for them to be wrong. `config` is a FUNCTION rather than a
 * snapshot so a settings change takes effect at the next create rather than at
 * the next restart.
 *
 * @param deps - `{store, missionStore, runtime, logger, sendJson, readJson, config}`.
 * @returns `async (req, res, path) => boolean` — true when this router answered.
 */
export function createMissionRoutes({ missionStore, runtime, logger, sendJson, readJson, config = () => ({}) }) {
  if (typeof missionStore?.getMission !== "function") {
    throw new TypeError("createMissionRoutes needs the MissionStore as `missionStore`. Open it once beside the SourceStore so both faces share one connection.");
  }
  if (typeof runtime?.start !== "function") {
    throw new TypeError("createMissionRoutes needs the mission runner as `runtime` (createMissionRuntime's answer). Routes dispatch missions; they never build a runner of their own, or two of them would each hold a boot id and the sweep would reclaim the other's work.");
  }

  /** The search parameters of the request being answered. */
  const paramsOf = (req) => new URL(req.url ?? "/", "http://localhost").searchParams;

  return async function handleMissions(req, res, path) {
    /** Answer 400 with `error`, and report the request as handled. */
    const bad = (error) => {
      sendJson(res, 400, { success: false, error });
      return true;
    };

    /**
     * The mission named by a path segment, or the answer that says why not.
     *
     * 404 at the ROUTE, never an empty view: a projection over a missing row
     * would render a mission-shaped page full of zeroes and the reader would
     * read it as a mission that did nothing.
     * @param id - the decoded id.
     * @returns the shaped row, or null when this call already answered.
     */
    const missionOr404 = (id) => {
      if (!isMissionId(id)) {
        sendJson(res, 400, { success: false, error: `"${id}" is not a mission id; they look like ${MISSION_ID_EXAMPLE}` });
        return null;
      }
      const mission = missionStore.getMission(id);
      if (mission === undefined) {
        sendJson(res, 404, { success: false, error: `no mission ${id}` });
        return null;
      }
      return mission;
    };

    // ── the list ────────────────────────────────────────────────────────
    if (req.method === "GET" && path === "/missions/list") {
      const params = paramsOf(req);
      const status = oneOf(params, "status", MISSION_STATUSES);
      if (status.error !== undefined) return bad(status.error);
      const depth = oneOf(params, "depth", DEPTH_TIERS);
      if (depth.error !== undefined) return bad(depth.error);
      const take = boundedInteger(params, "take", 1, 100, 20);
      if (take.error !== undefined) return bad(take.error);
      const skip = boundedInteger(params, "skip", 0, 1_000_000, 0);
      if (skip.error !== undefined) return bad(skip.error);
      const search = params.get("search") ?? undefined;
      if (typeof search === "string" && search.length > MAX_TOPIC_CHARS) {
        return bad(`search must be at most ${MAX_TOPIC_CHARS} characters`);
      }

      sendJson(res, 200, {
        success: true,
        data: {
          ...missionStore.listMissions({ status: status.value, depth: depth.value, search, take: take.value, skip: skip.value }),
          // Which of these this process is actually running, as opposed to
          // which rows SAY running. A row left running by a dead process is not
          // a live mission, and the list is where that difference is visible.
          live: runtime.running(),
        },
      });
      return true;
    }

    // ── the tier table, served so the browser holds no copy ──────────────
    if (req.method === "GET" && path === "/missions/budget-tiers") {
      sendJson(res, 200, {
        success: true,
        data: {
          tiers: DEPTH_TIER_BUDGETS,
          depths: DEPTH_TIERS,
          // Served WITH the tiers. Playground centralised its tier values and
          // its frontend still drifted from its backend on the field limits, so
          // a form that validates before it submits has to read them from here.
          limits: BUDGET_FIELD_LIMITS,
          fields: BUDGET_FIELDS,
          ladder: LADDER,
        },
      });
      return true;
    }

    // ── open one ────────────────────────────────────────────────────────
    if (req.method === "POST" && path === "/missions/create") {
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        return bad(String(cause?.message ?? cause));
      }

      const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
      if (topic === "") return bad("topic is required: a mission with no question has nothing to plan");
      if (topic.length > MAX_TOPIC_CHARS) return bad(`topic must be at most ${MAX_TOPIC_CHARS} characters`);

      const settings = config();
      // A field this route does not read is a REFUSAL, not a default.
      //
      // `{"tier":"quick"}` was accepted, silently ignored, and the mission ran
      // at `standard` — then failed its quality gate against a 9,000-word floor
      // it was never meant to be judged by, and the report said so in a
      // sentence about word counts that sent the reader looking at the writer.
      // Costing a full run to learn the field is called `depth` is the kind of
      // help this codebase does not offer.
      const known = new Set(["topic", "depth", "language", "goals", "overrides", "dimensions", "revision"]);
      const stray = Object.keys(body ?? {}).filter((key) => !known.has(key));
      if (stray.length > 0) {
        return bad(`this route does not read ${stray.join(", ")}. It takes ${[...known].join(", ")} — the depth tier is "depth", not "tier".`);
      }
      const depth = typeof body?.depth === "string" && body.depth !== "" ? body.depth : settings.missionDefaultDepth;
      if (!DEPTH_TIERS.includes(depth)) return bad(`depth must be one of ${DEPTH_TIERS.join(", ")}`);
      const language = typeof body?.language === "string" && body.language !== "" ? body.language : settings.missionLanguage;
      if (language !== "zh" && language !== "en") return bad("language must be zh or en");

      // Refused HERE, before a row exists, for the reason §8.2 gives: a plan
      // that cannot fit its own rate limits is not a mission that fails, it is
      // a mission that should never have been opened. s1 recomputes the same
      // gate at run time and throws `budget_exhausted` if the settings changed
      // underneath it — this is the cheap check, not the only one.
      const budget = resolveBudget({ depth, overrides: body?.overrides ?? {} });
      let floor;
      try {
        floor = computeWallFloorMs({
          maxArxiv: budget.maxArxiv,
          maxFetch: budget.maxFetch,
          arxivIntervalMs: settings.missionArxivIntervalMs,
          fetchIntervalMs: settings.missionFetchIntervalMs,
          // Measured in the phase −1 spike, not guessed. `computeWallFloorMs`
          // throws on a missing one on purpose: a floor computed without the
          // parse cost is the same understatement in a new place.
          parseP50Ms: settings.missionParseP50Ms,
        });
      } catch (cause) {
        return bad(String(cause?.message ?? cause));
      }

      const verdict = budgetGate({
        caps: budget,
        floor,
        // The estimate is read from THIS depth's history, never from arithmetic
        // on the ceiling the user just picked. `budgetGate` fails open if it
        // throws, and says the meter was unavailable rather than reporting a
        // pass it did not compute.
        history: () => spendHistory(missionStore, depth),
      });
      if (verdict.refuse === true) {
        // budgetGate's own sentence, verbatim. Two wordings of one refusal is
        // the same defect as two names for one method.
        sendJson(res, 400, { success: false, error: verdict.reason, data: { verdict, floor, budget } });
        return true;
      }

      const running = runtime.running();
      const cap = concurrencyCap(settings);
      if (running.length >= cap) {
        sendJson(res, 409, {
          success: false,
          error: `${running.length} mission(s) are already running and missionMaxConcurrent is ${cap}: ${running.join(", ")}. One process means one pacer, and a second concurrent mission doubles the request rate the pacer exists to hold.`,
          data: { running, cap },
        });
        return true;
      }

      let created;
      try {
        created = missionStore.createMission(
          {
            topic,
            depth,
            language,
            budget,
            retryBelowSeam: body?.retryBelowSeam === true,
            bootId: runtime.bootId,
            pid: process.pid,
            trace: body?.trace === true || settings.missionTrace === true,
            // The whole resolved answer, frozen as revision 1. A rerun re-reads
            // this rather than re-resolving, which is the difference between a
            // rerun that runs the mission you asked for and one that runs
            // whatever the defaults say today.
            config: { budget, gate: verdict, floor, settings: pacingOf(settings) },
          },
          STAGES.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1 })),
        );
      } catch (cause) {
        return bad(String(cause?.message ?? cause));
      }

      // Dispatched, not awaited. See the header.
      const dispatched = runtime.start(created.id);
      if (!dispatched.started) {
        logger?.warn?.(`swarm: mission ${created.id} was created but not started: ${dispatched.reason}`);
      }
      sendJson(res, 200, {
        success: true,
        data: {
          id: created.id,
          revision: created.revision,
          stages: created.stages,
          depth,
          language,
          budget,
          gate: { verdict: verdict.verdict, reason: verdict.reason, floorMs: verdict.floorMs },
          started: dispatched.started,
          // Present whenever `started` is false. A create that answered 200 and
          // quietly did not run is the failure this field exists to name.
          startedReason: dispatched.reason,
        },
      });
      return true;
    }

    const target = splitMissionPath(path);
    if (target === null) return false;
    const { id, action, rest, leaf } = target;
    // Only the trajectory and the stage rerun take a fourth segment, and only
    // the stage rerun takes a fifth. Every other action is matched on `action`
    // alone, so a tail let through here would make `/missions/<id>/cancel/oops`
    // a cancel. Reported as unhandled rather than 400 so the outer router 404s
    // it in the one place that does that.
    if (rest !== null && action !== "trace" && action !== "stages") return false;
    if (leaf !== null && !(action === "stages" && leaf === "rerun")) return false;

    // ── the read model ──────────────────────────────────────────────────
    if (req.method === "GET" && action === "view") {
      const params = paramsOf(req);
      const tail = boundedInteger(params, "tail", 1, 1000, 200);
      if (tail.error !== undefined) return bad(tail.error);
      const since = boundedInteger(params, "since", 0, Number.MAX_SAFE_INTEGER, 0);
      if (since.error !== undefined) return bad(since.error);
      if (missionOr404(id) === null) return true;

      const input = readMissionViewInput(missionStore.db, id, { tail: tail.value, sinceSeq: since.value });
      if (input === null) {
        sendJson(res, 404, { success: false, error: `no mission ${id}` });
        return true;
      }
      sendJson(res, 200, {
        success: true,
        data: projectMissionView({
          ...input,
          policy: { stages: STAGES, ladder: LADDER, now: Date.now() },
        }),
      });
      return true;
    }

    // ── the live stream ─────────────────────────────────────────────────
    if (req.method === "GET" && action === "events") {
      const params = paramsOf(req);
      const since = boundedInteger(params, "since", 0, Number.MAX_SAFE_INTEGER, 0);
      if (since.error !== undefined) return bad(since.error);
      if (missionOr404(id) === null) return true;
      await streamEvents(res, missionStore, id, since.value, runtime);
      return true;
    }

    // ── the evidence, at last ───────────────────────────────────────────
    //
    // THE ROUTE WHOSE ABSENCE WAS THE COMPLAINT. A dimension card printed
    // "已核验 6 · 1 个独立站点" and there was no way, anywhere in the product, to
    // see one of those six. The six rows existed the whole time — claim,
    // verbatim quote, source URL, source host, verify state, all in
    // `mission_findings` — and the screen reported a count of evidence it would
    // not show. Everything below is one call to `listFindings` and one to
    // `listDimensions`; the work was never the query.
    if (req.method === "GET" && action === "findings") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const stray = strayParams(params, ["dimensionId", "verifyState", "sourceHost", "order", "attempt", "runCount", "take", "skip"]);
      if (stray !== null) return bad(stray);

      const verifyState = oneOf(params, "verifyState", VERIFY_STATES);
      if (verifyState.error !== undefined) return bad(verifyState.error);
      // Validated against the vocabulary, exactly as the trajectory validates
      // its own `order` against TRACE_ORDERS. The value never reaches a SQL
      // string: `listFindings` maps a member of FINDING_ORDERS to a literal
      // clause, so this is a closed set on both sides of the call.
      const order = oneOf(params, "order", FINDING_ORDERS);
      if (order.error !== undefined) return bad(order.error);
      const runCount = boundedInteger(params, "runCount", 1, 1_000_000, mission.runCount);
      if (runCount.error !== undefined) return bad(runCount.error);
      const attempt = boundedInteger(params, "attempt", 0, 1000, undefined);
      if (attempt.error !== undefined) return bad(attempt.error);
      const take = boundedInteger(params, "take", 1, FINDINGS_PAGE_MAX, FINDINGS_PAGE_DEFAULT);
      if (take.error !== undefined) return bad(take.error);
      const skip = boundedInteger(params, "skip", 0, 1_000_000, 0);
      if (skip.error !== undefined) return bad(skip.error);
      const dimensionId = boundedText(params, "dimensionId");
      if (dimensionId.error !== undefined) return bad(dimensionId.error);

      const dimensions = missionStore.listDimensions(id, { runCount: runCount.value });
      const scoped = dimensionId.value === undefined
        ? null
        : dimensions.find((row) => row.dimensionId === dimensionId.value) ?? null;
      if (dimensionId.value !== undefined && scoped === null) {
        // 400 naming the dimensions that exist, never an empty list. An empty
        // list from a mistyped id is indistinguishable from an empty list from
        // a dimension that found nothing — and those two want opposite
        // reactions from the person reading the panel.
        const known = dimensions.map((row) => row.dimensionId).join(", ");
        return bad(`mission ${id} has no dimension "${dimensionId.value}" at run ${runCount.value}. It has ${known === "" ? "none yet — s2 has not planned" : known}.`);
      }

      // WHICH HOSTS EXIST, both ways round. `hosts` is the verified-only
      // roll-up this route has always returned — it is the independence
      // number, and counting a host whose only finding failed verification
      // would inflate it. `allHosts` is every host in scope, and it is what
      // `sourceHost` is validated against: refusing `kanatanorth.com` because
      // its one finding is unverified would be a 400 on a host the data holds,
      // which is indistinguishable from a broken route.
      const hosts = missionStore.uniqueHosts(id, { dimensionId: dimensionId.value, runCount: runCount.value });
      const allHosts = missionStore.uniqueHosts(id, { dimensionId: dimensionId.value, runCount: runCount.value, verified: false });
      const sourceHost = boundedText(params, "sourceHost");
      if (sourceHost.error !== undefined) return bad(sourceHost.error);
      if (sourceHost.value !== undefined && !allHosts.some((row) => row.host === sourceHost.value)) {
        // Named, never an empty list — the same rule `dimensionId` follows two
        // blocks up, for the same reason.
        const known = allHosts.map((row) => row.host).join(", ");
        return bad(`mission ${id} read nothing from "${sourceHost.value}" at run ${runCount.value}. It read from ${known === "" ? "no host yet — s3 has not collected" : known}.`);
      }

      // take + 1, then trimmed. `listFindings` returns rows and no count, and
      // the alternative is a second COUNT that can disagree with the page it
      // describes; one extra row cannot.
      const page = missionStore.listFindings({
        missionId: id,
        dimensionId: dimensionId.value,
        runCount: runCount.value,
        verifyState: verifyState.value,
        sourceHost: sourceHost.value,
        attempt: attempt.value,
        order: order.value,
        take: take.value + 1,
        skip: skip.value,
      });
      const hasMore = page.length > take.value;
      const rows = hasMore ? page.slice(0, take.value) : page;
      const names = new Map(dimensions.map((row) => [row.dimensionId, row.name]));

      // Reported as a histogram over the WHOLE scope, never as a ratio and
      // never recomputed from the page: a page of 50 out of 137 whose counts
      // were derived from the page would show the reader a verification rate
      // that changes as they scroll.
      const missionCounts = missionStore.verifyStateCounts(id, runCount.value);
      const { total: missionTotal, ...missionByState } = missionCounts;

      sendJson(res, 200, {
        success: true,
        data: {
          missionId: id,
          runCount: runCount.value,
          // WHICH RUNS HOLD ANYTHING. Every reader on this table scopes to the
          // mission's current run, which is right while it runs and wrong the
          // moment it is re-run. Measured on a real mission: five runs, all
          // fourteen findings in run 1, and eight dimension cards reading "0
          // verified of 0" because run 5 settled without collecting. The
          // evidence was one integer away and the screen said there was none.
          runs: missionStore.findingRuns(id),
          // Per-dimension counts for the run being shown, so a reader who moved
          // off the current run does not sit in front of eight cards still
          // drawing the current run's zeroes.
          byDimension: missionStore.findingCountsByDimension(id, runCount.value),
          scope: {
            dimensionId: dimensionId.value ?? null,
            verifyState: verifyState.value ?? null,
            sourceHost: sourceHost.value ?? null,
            attempt: attempt.value ?? null,
            order: order.value ?? "created",
          },
          dimension: scoped === null ? null : {
            dimensionId: scoped.dimensionId,
            name: scoped.name,
            rationale: scoped.rationale,
            facet: scoped.facet,
            state: scoped.state,
            attempt: scoped.attempt,
            grade: scoped.grade,
            gradeAxes: scoped.gradeAxes,
            summary: scoped.summary,
            failureCode: scoped.failureCode,
            updatedAt: scoped.updatedAt,
          },
          findings: rows.map((finding) => projectFinding(finding, { dimensionName: names.get(finding.dimensionId) ?? null })),
          // `order` is the value the SQL actually sorted by, never a literal:
          // this line said "oldest" regardless of what was asked for, which is
          // the kind of label that survives a change to the thing it describes.
          page: { take: take.value, skip: skip.value, returned: rows.length, hasMore, order: order.value ?? "created" },
          counts: scoped === null
            ? {
              total: missionTotal,
              byState: missionByState,
              verified: missionByState[COUNTING_VERIFY_STATE] ?? 0,
              verifiedAbstract: missionByState["verified-abstract"] ?? 0,
              unchecked: uncheckedTotal(missionByState),
              uniqueHosts: hosts.length,
            }
            : {
              total: scoped.total,
              byState: scoped.byState,
              verified: scoped.verified,
              verifiedAbstract: scoped.verifiedAbstract,
              unchecked: scoped.unchecked,
              uniqueHosts: scoped.uniqueHosts,
            },
          // WHICH sites, not how many. "1 个独立站点" told the reader a number
          // and withheld the only part of it that can be judged.
          hosts,
          // Every host in scope, verified or not — the legal values for
          // `sourceHost`, so a control built from this list cannot offer an
          // option that refuses.
          allHosts,
          vocabulary: {
            verifyStates: VERIFY_STATES,
            countingState: COUNTING_VERIFY_STATE,
            fetchBackedStates: FETCH_BACKED_VERIFY_STATES,
            orders: FINDING_ORDERS,
            sourceHosts: allHosts.map((row) => row.host),
          },
        },
      });
      return true;
    }

    // ── the page as it was when we checked it ───────────────────────────
    //
    // THE READER HAD ONE ANSWER TO TWO QUESTIONS. Opening a quote's source
    // re-fetched the address and extracted it, which answers "does that page
    // still say this" and cannot answer "what did the page say when the span
    // guard ran over it". They come apart exactly where it matters: a page
    // edited, paywalled or pulled since the mission read it re-fetches into
    // something the quote is not in, and the only conclusion left to the
    // person checking that quote is that it was invented.
    //
    // THE TEXT WAS ON DISK THE WHOLE TIME. `mission_documents` holds the
    // markdown every span was matched against, keyed by the `document_id` on
    // the finding itself, and `freezeEvidence` deliberately does not copy it
    // into the artefact — copying tens of thousands of words per version
    // would turn the artefact table into a second corpus. That decision only
    // holds while the corpus is reachable, and nothing served it.
    //
    // SCOPED THROUGH THIS MISSION'S OWN FINDINGS, never by id alone. A
    // document reader keyed on the id and mounted under a mission path hands
    // anyone holding an id the whole fetch cache — every page every other
    // mission ever read, under a URL that says it belongs to this one.
    if (req.method === "GET" && action === "document") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const stray = strayParams(params, ["documentId", "runCount"]);
      if (stray !== null) return bad(stray);

      const runCount = boundedInteger(params, "runCount", 1, 1_000_000, mission.runCount);
      if (runCount.error !== undefined) return bad(runCount.error);
      const documentId = boundedText(params, "documentId");
      if (documentId.error !== undefined) return bad(documentId.error);
      if (documentId.value === undefined) {
        // Named with the place a caller gets one. This route serves ONE page
        // and there is no defensible default: guessing the first would hand a
        // reader a different page from the one their quote came off, which is
        // the failure the whole route exists to end.
        return bad(`documentId is required: this route serves one stored page, and its id is the \`documentId\` a finding carries. /missions/${id}/findings returns it on every row that has one.`);
      }

      // THE SCOPE AND THE MEMBERSHIP TEST, in one read. A page is this
      // mission's when one of this run's findings was checked against it;
      // nothing else is served here.
      const held = missionStore.documentsForMission(id, { runCount: runCount.value });
      const scoped = held.find((row) => row.id === documentId.value) ?? null;
      if (scoped === null) {
        // 404 naming the BOUND, the way `trace/<ref>` does. "This mission
        // stored nothing at that run" and "it stored eleven pages and that is
        // not one of them" are different situations, and one sentence for both
        // is how a stale id becomes indistinguishable from a mission that
        // fetched nothing.
        sendJson(res, 404, {
          success: false,
          error: held.length === 0
            ? `mission ${id} holds no stored page at run ${runCount.value}. Nothing it fetched at that run clears the bar a verified quote rests on — 2xx and at least ${MIN_DOCUMENT_CHARS} normalised characters — so there is no text here to read a quote against.`
            : `mission ${id} holds ${held.length} stored page(s) at run ${runCount.value} and none of them is "${documentId.value}". A page re-fetched into a non-2xx or an empty body leaves this set, and the findings resting on it were re-marked unchecked-stale in the same write.`,
          data: { documentId: documentId.value, runCount: runCount.value, held: held.length },
        });
        return true;
      }

      // Read again by primary key, and the second read is not waste: the scope
      // query returns neither `contentHash` nor `admissible`, and those two are
      // how a later reader tells the text the guard ran over from a re-fetch
      // that replaced it in place.
      const stored = missionStore.getDocument(documentId.value);

      sendJson(res, 200, {
        success: true,
        data: {
          missionId: id,
          runCount: runCount.value,
          document: {
            documentId: stored.id,
            url: stored.url,
            host: stored.host,
            title: stored.title,
            // WHOLE, for the reason `projectFinding` returns the quote whole:
            // this is the only place the text is served, and a body truncated
            // on the way out is a reader who cannot find the quote in it and
            // concludes it was never there.
            markdown: stored.markdown,
            charCount: stored.charCount,
            contentHash: stored.contentHash,
            status: stored.status,
            fetchedAt: stored.fetchedAt,
            admissible: stored.admissible,
          },
        },
      });
      return true;
    }

    // ── the publisher's own figures, and the bytes we kept ──────────────
    //
    // TWO ROUTES BECAUSE THERE ARE TWO ANSWERS. `figures` is the metadata a
    // chapter needs in order to place a picture and credit it; `figure` is the
    // bytes. One route would mean either a megabyte of base64 inside a JSON
    // envelope on every poll, or an `<img>` pointed at an envelope.
    //
    // NEITHER EVER SENDS THE BROWSER TO THE PUBLISHER, and not with a redirect
    // either: a 302 to a CDN is hotlinking with an extra hop, and it puts our
    // readers' addresses in that publisher's logs on every render of a report.
    // This matters more here than the rule makes it sound, because THIS PRODUCT
    // ALREADY HOTLINKS ELSEWHERE — client.js:3182 points an `<img src>` at a
    // publisher's own `og:image` and only falls back to `/proxy/image` after the
    // load fails — so there is no CSP standing behind this rule anywhere. The
    // route is the whole of it.
    //
    // AND NOT `/proxy/image` EITHER, which exists and is not this. That relay
    // (index.js:1395) fetches at REQUEST time — so a publisher who 404s next
    // month is a picture gone out of a report written this month — calls
    // `fetchDocument` outside `paceRead`, is scoped to nothing, and admits any
    // `image/*`, `image/svg+xml` included, which is a document that runs script
    // served from our own origin. This route serves a copy we already hold,
    // from a closed raster list, scoped through the chapter that cites the page.
    //
    // `dimensionId` IS REQUIRED ON THE BYTE ROUTE, in its first version. Rule 3
    // says an image may appear only in a chapter that cites its page; scoped
    // mission-wide, a URL minted for chapter A would serve inside chapter B and
    // the rule would hold by convention in the renderer rather than in SQL. Both
    // routes therefore run ONE query with the same arguments. It is also why the
    // parameter cannot be added later: the byte URL is minted into `path` below
    // and written into a card, so a parameter appended afterwards invalidates
    // every URL already drawn.
    if (req.method === "GET" && action === "figures") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const stray = strayParams(params, ["runCount", "dimensionId"]);
      if (stray !== null) return bad(stray);

      const runCount = boundedInteger(params, "runCount", 1, 1_000_000, mission.runCount);
      if (runCount.error !== undefined) return bad(runCount.error);
      const dimensionId = boundedText(params, "dimensionId");
      if (dimensionId.error !== undefined) return bad(dimensionId.error);

      // WITHOUT A DIMENSION THIS IS AN INVENTORY, NOT A GALLERY. It answers what
      // the run holds and who each figure is credited to, which is what a
      // references pane wants; every row's `path` is null, because a figure is
      // served under the chapter that cites its page and this listing names no
      // chapter. A null path is not a missing feature — it is rule 3 declining
      // to mint a URL that would outlive the scope justifying it.
      const rows = dimensionId.value === undefined
        ? missionStore.figuresForMission(id, { runCount: runCount.value })
        : missionStore.figuresForChapter(id, { runCount: runCount.value, dimensionId: dimensionId.value });

      sendJson(res, 200, {
        success: true,
        data: {
          missionId: id,
          runCount: runCount.value,
          dimensionId: dimensionId.value ?? null,
          figures: rows.map((row) => ({
            figureId: row.id,
            // Handed over whole, WITHOUT this router's own prefix — the client
            // prepends `apiBase()` the way it does for every other mission
            // route. Composed here rather than at the far end so that no caller
            // ever assembles an image address itself, because the one address
            // that must never reach an `<img>` is `sourceUrl` ten lines down.
            path: dimensionId.value === undefined
              ? null
              : `/missions/${encodeURIComponent(id)}/figure?figureId=${encodeURIComponent(row.id)}&runCount=${runCount.value}&dimensionId=${encodeURIComponent(dimensionId.value)}`,
            alt: row.alt,
            caption: row.caption,
            // 0 means UNKNOWN, not small: the page declared no intrinsic size.
            // A layout that treats the two alike will letterbox a chart it could
            // have measured.
            width: row.width,
            height: row.height,
            mime: row.mime,
            byteLength: row.byteLength,
            contentHash: row.contentHash,
            fetchedAt: row.fetchedAt,
            // THE ATTRIBUTION, on every row, never optional and never a second
            // lookup. `page` is JOINed out of `mission_documents` at read time,
            // so a figure whose page row is gone returns no row at all and
            // cannot be drawn uncredited. `sourceUrl` is the publisher's own
            // IMAGE address: it is here to be shown and linked, never fetched.
            page: row.page,
            sourceUrl: row.url,
            sourceHost: row.host,
          })),
        },
      });
      return true;
    }

    if (req.method === "GET" && action === "figure") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const stray = strayParams(params, ["figureId", "runCount", "dimensionId"]);
      if (stray !== null) return bad(stray);

      const runCount = boundedInteger(params, "runCount", 1, 1_000_000, mission.runCount);
      if (runCount.error !== undefined) return bad(runCount.error);
      const figureId = boundedText(params, "figureId");
      if (figureId.error !== undefined) return bad(figureId.error);
      const dimensionId = boundedText(params, "dimensionId");
      if (dimensionId.error !== undefined) return bad(dimensionId.error);
      // BOTH, and refused HERE rather than left to the store. `figuresForChapter`
      // would throw `assertText` on a missing dimension, and a required
      // parameter that arrives as a 500 reads as a broken server rather than as
      // a caller who left something out.
      if (figureId.value === undefined || dimensionId.value === undefined) {
        return bad(`figureId and dimensionId are both required: this route serves one stored image inside the one chapter that cites the page it came off. /missions/${id}/figures?dimensionId=<id> returns both on every row, already spelled out as \`path\`.`);
      }

      // THE SCOPE AND THE MEMBERSHIP TEST IN ONE READ, and it is the SAME read
      // the list route ran — one query, so what a chapter may show and what
      // bytes may go out cannot become two rules free to disagree. A finding
      // demoted to `unchecked-stale` takes its figures off the screen in the
      // same instant it takes its quote off, with no second rule to keep in step.
      const held = missionStore.figuresForChapter(id, { runCount: runCount.value, dimensionId: dimensionId.value });
      const scoped = held.find((row) => row.id === figureId.value) ?? null;
      if (scoped === null) {
        // 404 NAMING THE BOUND, the way `document` and `trace/<ref>` do. "This
        // chapter holds nothing" and "it holds four and that is not one of them"
        // are different situations, and one sentence for both is how a stale id
        // becomes indistinguishable from a chapter that got no pictures.
        sendJson(res, 404, {
          success: false,
          error: held.length === 0
            ? `chapter ${dimensionId.value} of mission ${id} holds no figure at run ${runCount.value}. Either nothing its verified findings cite carried a picture, or the publishers declined them — /missions/${id}/figures?dimensionId=${encodeURIComponent(dimensionId.value)} says which, with a reason on every row.`
            : `chapter ${dimensionId.value} of mission ${id} holds ${held.length} figure(s) at run ${runCount.value} and none of them is "${figureId.value}". A figure belongs to a chapter only while one of that dimension's own verified findings still cites the page it came off.`,
          data: { figureId: figureId.value, dimensionId: dimensionId.value, runCount: runCount.value, held: held.length },
        });
        return true;
      }

      const stored = missionStore.figureBytes(figureId.value);
      // THE SECOND TYPE CHECK, and it is not a copy of the one at the write.
      // That one stops a hole being dug; this one stops a hole dug by an older
      // build from being served by this one — a row written when the allow list
      // was wider must not become servable by an upgrade that widened nothing.
      // Where the two disagree the narrower wins and the picture does not
      // appear, which is the safe direction for a picture.
      if (stored === undefined || !FIGURE_MIME_TYPES.includes(String(stored.mime))) {
        sendJson(res, 404, {
          success: false,
          error: `mission ${id} holds no servable bytes for figure "${figureId.value}"${scoped.reason === null ? "" : `: ${scoped.reason}`}. This route never redirects to the publisher, so a figure we do not hold is a citation with no picture beside it.`,
          data: { figureId: figureId.value, state: scoped.state, reason: scoped.reason, sourceUrl: scoped.url },
        });
        return true;
      }

      // THE COPY WE KEPT, WHICH IS THE WHOLE POINT. Nothing on this path touches
      // the network. The publisher can 404 the image, re-crop it or vanish, and
      // a report written in March still renders in December — the same principle
      // the document reader is built on, one table further out.
      const etag = `"${stored.contentHash}"`;
      if (String(req.headers?.["if-none-match"] ?? "") === etag) {
        // The validator and the caching terms repeated, because a revalidation
        // answered without them tells the browser to ask again in full on the
        // next render of every figure in the report.
        res.writeHead(304, { etag, "cache-control": "private, max-age=600" });
        res.end();
        return true;
      }

      res.writeHead(200, {
        "content-type": stored.mime,
        "content-length": stored.byteLength,
        // A THIRD PARTY CHOSE THIS BODY, which is true of no other response in
        // this file. `nosniff` stops the browser deciding for itself that the
        // bytes are something executable, and the sandbox with an empty
        // `default-src` makes the response inert if anyone navigates straight at
        // it instead of loading it into an `<img>`.
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        // `inline`, not `attachment`: this is loaded into an `<img>` in a report,
        // and an attachment disposition turns every figure into a download prompt.
        "content-disposition": "inline",
        // NO `cross-origin-resource-policy`, and that is measured rather than
        // forgotten. `apiBase()` at client.js:2291 is overridable to another
        // origin and lib/remote.js forwards `/swarm-api/*` to a remote box, so
        // `same-origin` would blank every figure on exactly the deployments that
        // work hardest to serve them.
        //
        // THE ONE ROUTE IN THIS FILE THAT IS NOT `no-store`, argued rather than
        // copied: a long report re-requests every figure on every render, the row
        // id is `(page, image url)` so the bytes under it are stable, and the
        // validator is the content hash — so a re-extract that replaced the image
        // replaces the ETag the browser is already holding. `private` keeps a
        // shared cache from serving one mission's evidence to another reader.
        "cache-control": "private, max-age=600",
        etag,
      });
      res.end(stored.bytes);
      return true;
    }

    // ── the trajectory ──────────────────────────────────────────────────
    //
    // One ordered list a dense row list renders directly: stage transitions,
    // tool calls with the arguments they were made with, findings as they were
    // recorded, and the rest of the event log, merged by timestamp. See
    // `buildMissionTrace` for why stage rows come out of the event log rather
    // than out of `mission_stages`, and `TRACE_EVENT_WINDOW` for what bounds it.
    if (req.method === "GET" && action === "trace" && rest === null) {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const stray = strayParams(params, ["kind", "role", "agentId", "stepId", "dimensionId", "search", "order", "runCount", "take", "skip"]);
      if (stray !== null) return bad(stray);

      const kind = oneOf(params, "kind", TRACE_KINDS);
      if (kind.error !== undefined) return bad(kind.error);
      const role = oneOf(params, "role", TRACE_ROLES);
      if (role.error !== undefined) return bad(role.error);
      // THE REAL AGENT AXIS. `role` is ["STAGE","TOOL","EVIDENCE","GATE",
      // "SYSTEM"] — a provenance chip, nearly the same axis as `kind` — so
      // "show me only what the Leader did" had no filter until this one. Not
      // an `oneOf`: agent ids are minted per dimension (`researcher:d3`), so
      // there is no fixed vocabulary to check against. `vocabulary.agents`
      // below is the legal set, measured from the rows themselves.
      const agentId = boundedText(params, "agentId");
      if (agentId.error !== undefined) return bad(agentId.error);
      const order = oneOf(params, "order", TRACE_ORDERS);
      if (order.error !== undefined) return bad(order.error);
      const runCount = boundedInteger(params, "runCount", 1, 1_000_000, mission.runCount);
      if (runCount.error !== undefined) return bad(runCount.error);
      const take = boundedInteger(params, "take", 1, TRACE_PAGE_MAX, TRACE_PAGE_DEFAULT);
      if (take.error !== undefined) return bad(take.error);
      const skip = boundedInteger(params, "skip", 0, 1_000_000, 0);
      if (skip.error !== undefined) return bad(skip.error);
      const stepId = boundedText(params, "stepId");
      if (stepId.error !== undefined) return bad(stepId.error);
      const dimensionId = boundedText(params, "dimensionId");
      if (dimensionId.error !== undefined) return bad(dimensionId.error);
      const search = boundedText(params, "search");
      if (search.error !== undefined) return bad(search.error);

      const trace = readTrace(missionStore, id, runCount.value);
      const vocabulary = traceVocabulary(trace.rows);
      if (agentId.value !== undefined && !vocabulary.agents.some((row) => row.id === agentId.value)) {
        const known = vocabulary.agents.map((row) => `${row.id} (${row.rows})`).join(", ");
        return bad(`no row in mission ${id}'s trajectory was produced by "${agentId.value}". The agents in it are ${known === "" ? "none — nothing has been recorded yet" : known}.`);
      }
      const slice = sliceMissionTrace(trace.rows, {
        kind: kind.value,
        role: role.value,
        agentId: agentId.value,
        stepId: stepId.value,
        dimensionId: dimensionId.value,
        search: search.value,
        order: order.value ?? "newest",
        take: take.value,
        skip: skip.value,
      });

      sendJson(res, 200, {
        success: true,
        data: {
          missionId: id,
          runCount: runCount.value,
          rows: slice.rows,
          page: {
            order: slice.order,
            take: slice.take,
            skip: slice.skip,
            returned: slice.returned,
            total: slice.total,
            hasMore: slice.hasMore,
            // The whole merged list before filtering, so a search that matches
            // nothing can say "0 of 431" instead of "0", which is the
            // difference between an empty filter and an empty mission.
            unfiltered: trace.rows.length,
          },
          filters: {
            kind: kind.value ?? null,
            role: role.value ?? null,
            agentId: agentId.value ?? null,
            stepId: stepId.value ?? null,
            dimensionId: dimensionId.value ?? null,
            search: search.value ?? null,
          },
          window: trace.window,
          // The banded strip above the list. Already read to annotate the stage
          // rows, so returning it costs nothing and saves the client a request
          // it would otherwise make on every page.
          stages: trace.stages.map((stage) => ({
            stepId: stage.stepId,
            ordinal: stage.ordinal,
            status: stage.status,
            attempts: stage.attempts,
            startedAt: stage.startedAt,
            endedAt: stage.endedAt,
            durationMs: stage.durationMs,
            tokens: stage.tokens,
            degradeNote: stage.degradeNote,
          })),
          dimensions: trace.dimensions.map((dimension) => ({
            dimensionId: dimension.dimensionId,
            name: dimension.name,
            state: dimension.state,
            verified: dimension.verified,
            total: dimension.total,
            uniqueHosts: dimension.uniqueHosts,
          })),
          lastEventSeq: trace.lastEventSeq,
          truncation: { detailChars: TRACE_DETAIL_CHARS, resultChars: TRACE_RESULT_CHARS },
          // `kinds`, `roles` and `orders` are fixed catalogues. `agents` and
          // `dimensions` are MEASURED FROM `trace.rows`, with counts, so a
          // control built from them cannot offer an option that matches zero
          // rows. `data.dimensions` above is the plan's five and is left as it
          // is — it answers "what was planned", which other readers need; this
          // answers "what can be filtered", and on a real mission the two
          // differ by more than half: five planned, three ever recorded, and
          // 158 of 169 rows carrying no dimension at all.
          vocabulary: {
            kinds: TRACE_KINDS,
            roles: TRACE_ROLES,
            orders: TRACE_ORDERS,
            agents: vocabulary.agents,
            dimensions: vocabulary.dimensions,
          },
        },
      });
      return true;
    }

    // ── one row of it, whole ────────────────────────────────────────────
    //
    // `/missions/<id>/trace/<ref>` — the `ref` a list row carries. A bare
    // integer is also accepted and means "the row at that `seq`", because the
    // reference tab this is shaped after is navigated by row number; it is
    // resolved against a freshly built trajectory and the answer echoes the
    // `ref` and `at` it landed on, so a caller that paged a while ago can see
    // that the position moved under it. `ref` is the identity; `seq` is a
    // position in a snapshot. Prefer `ref`.
    if (req.method === "GET" && action === "trace" && rest !== null) {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const stray = strayParams(params, ["runCount"]);
      if (stray !== null) return bad(stray);
      const runCount = boundedInteger(params, "runCount", 1, 1_000_000, mission.runCount);
      if (runCount.error !== undefined) return bad(runCount.error);

      const trace = readTrace(missionStore, id, runCount.value);
      const byPosition = /^[0-9]+$/.test(rest);
      const row = byPosition
        ? trace.rows[Number(rest) - 1]
        : trace.rows.find((candidate) => candidate.ref === rest);

      if (row === undefined) {
        if (!byPosition && parseTraceRef(rest) === null) {
          return bad(`"${rest}" is not a trajectory reference. They look like event:412, stage:s3-collect@118, tool:2026-01-01T09:00:00.000Z#0 or finding:<id>, and every row of /missions/${id}/trace carries its own in \`ref\`.`);
        }
        // 404 that names the BOUND, not just the absence. A row that scrolled
        // out of the window this page reads and a row that never existed are
        // different situations, and one message for both is how a bound
        // becomes invisible.
        sendJson(res, 404, {
          success: false,
          error: byPosition
            ? `mission ${id} has ${trace.rows.length} trajectory row(s) in the window this page reads; there is no row ${rest}.`
            : `no trajectory row ${rest} in the window this page reads. The trajectory is assembled from the newest ${TRACE_EVENT_WINDOW} events, ${TRACE_TOOL_WINDOW} tool calls and ${TRACE_FINDING_WINDOW} findings; an older row is on disk but outside it.`,
          data: { ref: byPosition ? null : rest, window: trace.window },
        });
        return true;
      }

      const parsed = parseTraceRef(row.ref);
      const source = resolveTraceSource(parsed, trace.streams);
      if (source === null) {
        // Reached only if `buildMissionTrace` minted a ref its own inverse
        // cannot read, which is a bug in this file rather than a bad request.
        // Said out loud instead of served as an empty panel.
        sendJson(res, 500, {
          success: false,
          error: `trajectory row ${row.ref} could not be resolved back to the rows it was built from. This is a defect in the ref grammar, not in the request.`,
        });
        return true;
      }
      sendJson(res, 200, { success: true, data: traceDetail({ missionId: id, row, source, trace }) });
      return true;
    }

    // ── what the stages decided ─────────────────────────────────────────
    //
    // THE REASONING, READ BACK. Every judgement the pipeline made is in
    // `mission_stages.output` and has been since the mission ran: the Leader's
    // per-dimension verdict and the words for it, s5's reconciled fact table
    // with its conflicts and gaps, s10's blindspots, s11's signature and the
    // reason it was refused. Until this route the only way to see any of it
    // was to guess the event `seq` a trajectory ref is keyed on and open one
    // row's detail panel.
    //
    // Read-time only. No writes, no migration, nothing new stored: every field
    // below already existed on disk for every mission ever run.
    if (req.method === "GET" && action === "insights") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const stray = strayParams(params, []);
      if (stray !== null) return bad(stray);

      const insights = projectStageInsights(missionStore.listStageOutputs(id));
      sendJson(res, 200, {
        success: true,
        data: {
          missionId: id,
          runCount: mission.runCount,
          ...insights,
          // Which stage each block came from, so a null is a stage that did not
          // run rather than a field this route forgot.
          stages: INSIGHT_STAGES.map((entry) => ({ key: entry.key, stepId: entry.stepId })),
        },
      });
      return true;
    }

    // ── one row per SOURCE ──────────────────────────────────────────────
    //
    // The references screen asks "what did we read", and the findings route
    // answers "what did we learn". Fourteen findings over seven pages is seven
    // rows here and fourteen there; a references list built from the findings
    // route shows the same page six times and makes a mission look far better
    // sourced than it is.
    if (req.method === "GET" && action === "sources") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const stray = strayParams(params, ["runCount", "dimensionId"]);
      if (stray !== null) return bad(stray);

      const runCount = boundedInteger(params, "runCount", 1, 1_000_000, mission.runCount);
      if (runCount.error !== undefined) return bad(runCount.error);
      const dimensionId = boundedText(params, "dimensionId");
      if (dimensionId.error !== undefined) return bad(dimensionId.error);

      // A run this mission never had is a TYPO, not an empty result. It used to
      // answer 200 with `sources: []`, which reads as "this mission collected
      // nothing" — the one sentence this route exists to stop being said
      // wrongly, and every other parameter here already 400s.
      const runs = missionStore.findingRuns(id);
      if (params.has("runCount") && runCount.value > mission.runCount) {
        const held = runs.length === 0
          ? "it has no run holding findings"
          : `runs holding findings: ${runs.map((entry) => entry.runCount).join(", ")}`;
        return bad(`mission ${id} has run ${runCount.value === mission.runCount ? runCount.value : mission.runCount} at most, so runCount=${runCount.value} does not exist. ${held}.`);
      }

      const dimensions = missionStore.listDimensions(id, { runCount: runCount.value });
      if (dimensionId.value !== undefined && !dimensions.some((row) => row.dimensionId === dimensionId.value)) {
        const known = dimensions.map((row) => row.dimensionId).join(", ");
        return bad(`mission ${id} has no dimension "${dimensionId.value}" at run ${runCount.value}. It has ${known === "" ? "none yet — s2 has not planned" : known}.`);
      }

      const sources = missionStore.listSources(id, { runCount: runCount.value, dimensionId: dimensionId.value });
      let findings = 0;
      let verified = 0;
      // `dated` is counted HERE, beside the other three, rather than left for
      // the pane to derive: the references screen reads its figures out of this
      // one object, and a figure computed on the far side of the wire is the
      // pair that drifts. It is also what lets the pane say "not one of these
      // pages carries a publish date" — a fact about the mission — instead of
      // silently omitting the year control.
      let dated = 0;
      const hosts = new Set();
      for (const source of sources) {
        findings += source.findings;
        verified += source.verified;
        if (typeof source.publishedAt === "string" && source.publishedAt !== "") dated += 1;
        hosts.add(source.host);
      }

      sendJson(res, 200, {
        success: true,
        data: {
          missionId: id,
          runCount: runCount.value,
          scope: { dimensionId: dimensionId.value ?? null },
          sources,
          totals: { sources: sources.length, hosts: hosts.size, findings, verified, dated },
          // The SAME run-picker shape the findings route returns, and for the
          // same reason: every reader on this table scopes to the mission's
          // current run, which is right while it runs and wrong the moment it
          // is re-run. Measured on a real mission: five runs, all fourteen
          // findings in run 1, and a references screen that would show none.
          runs: missionStore.findingRuns(id),
          // NAME, STATE AND SUMMARY — not the name alone. The references pane
          // can now arrange by dimension, and a dimension that read pages and
          // verified nothing has NO ROWS to group under: with only a name it
          // would be indistinguishable from a dimension that was never planned,
          // which is the difference between "we tried and it did not land" and
          // "we did not look". The state says which, and the summary is the
          // dimension's own account of it.
          dimensions: dimensions.map((row) => ({
            dimensionId: row.dimensionId,
            name: row.name,
            state: row.state ?? null,
            summary: row.summary ?? "",
          })),
        },
      });
      return true;
    }

    // ── the artefact ────────────────────────────────────────────────────
    if (req.method === "GET" && action === "artifact") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const version = boundedInteger(params, "version", 1, 1_000_000, 0);
      if (version.error !== undefined) return bad(version.error);

      const artifact = version.value === 0
        ? missionStore.latestArtifact(id)
        : missionStore.getArtifact(id, version.value) ?? { kind: "empty-artifact", reason: "no-such-version" };
      sendJson(res, 200, {
        success: true,
        data: {
          artifact: artifact === undefined ? artifact : {
            ...artifact,
            // WHY THIS REPORT IS DEGRADED, on the report. `degraded: true` is a
            // flag with no sentence attached, and the reader of a report is
            // exactly the person who needs the sentence. Derived here rather
            // than written at s12 on purpose: a write-path change would only
            // help artefacts produced after it, and every artefact that exists
            // today would keep saying nothing.
            degradeReason: degradeReasonFor(missionStore, id, mission),
          },
          // The header list, so the reader can move between runs without a
          // second request. Bodies are deliberately not read: a deep report is
          // tens of thousands of words and this renders on every detail view.
          versions: missionStore.listArtifactVersions(id),
        },
      });
      return true;
    }

    // ── the report, as a file ───────────────────────────────────────────
// THE OTHER THREE EXPORTS. The reference offers markdown, a facts CSV, a
// citations CSV and JSON from one endpoint; this had markdown alone. All
// three are joins over rows already on the artefact and in
// `mission_findings` — nothing is derived, nothing is recomputed, and a
// report written months ago exports correctly because the work happens
// HERE rather than at write time.
//
// CSV is quoted the one way that survives a spreadsheet: every field in
// double quotes with internal quotes doubled, and a BOM so Excel reads it
// as UTF-8 rather than as the local codepage — which is what turns a
// Chinese report's every heading into mojibake on the machine it is
// opened on.
if (req.method === "GET" && (action === "facts.csv" || action === "citations.csv" || action === "report.json")) {
  const mission = missionOr404(id);
  if (mission === null) return true;
  const params = paramsOf(req);
  const version = boundedInteger(params, "version", 1, 1_000_000, 0);
  if (version.error !== undefined) return bad(version.error);
  const artifact = version.value === 0 ? missionStore.latestArtifact(id) : missionStore.getArtifact(id, version.value);
  if (artifact === undefined || artifact?.kind === "empty-artifact") {
    sendJson(res, 404, {
      success: false,
      error: `mission ${id} has no report to export`,
      data: { reason: artifact?.reason ?? "no-such-version" },
    });
    return true;
  }

  const stamp = artifact.version ? `-v${artifact.version}` : "";
  const send = (body, type, name) => {
    res.writeHead(200, {
      "content-type": type,
      "content-length": Buffer.byteLength(body),
      "content-disposition": `attachment; filename="${id}${stamp}.${name}"`,
      "cache-control": "no-store",
    });
    res.end(body);
    return true;
  };

  if (action === "report.json") {
    return send(JSON.stringify({
      mission: { id, topic: mission.topic, depth: mission.depth, language: mission.language, runCount: artifact.runCount },
      artifact: {
        version: artifact.version, createdAt: artifact.createdAt, trigger: artifact.trigger,
        title: artifact.title, wordCount: artifact.wordCount, degraded: artifact.degraded,
        sections: artifact.sections, citations: artifact.citations, quality: artifact.quality,
      },
      // THE TOKEN STAYS IN THIS ONE, AND THE MANIFEST SHIPS BESIDE IT. This
      // export is "the whole projection of this run, for a machine to read", and
      // the .md rewrites the directive into prose because a PERSON opens that
      // file. Stripping it here would delete the only record of where in the
      // document each figure sits; keeping it without `figures` would ship a
      // document carrying a directive nothing can resolve. Both halves or
      // neither — that pair is what makes an export honest rather than complete.
      markdown: artifact.markdown ?? "",
      figures: artifact.figures ?? [],
    }, null, 2), "application/json; charset=utf-8", "json");
  }

  // A BOM, and every field quoted. Excel reads a bare UTF-8 CSV as the
  // local codepage, and a Chinese report exports as mojibake without it.
  const cell = (value) => `"${String(value ?? "").split('"').join('""')}"`;
  const BOM = String.fromCharCode(0xFEFF);
  const csv = (head, rows) => BOM + [head, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");

  if (action === "citations.csv") {
    const rows = (artifact.citations ?? []).map((entry) => [
      entry.index, entry.url, entry.findingId, entry.dimensionId ?? "", entry.chapterIndex ?? "", entry.inlineQuote ?? "",
    ]);
    return send(csv(["index", "url", "finding_id", "dimension_id", "chapter_index", "quote"], rows),
      "text/csv; charset=utf-8", "citations.csv");
  }

  // ONE OBJECT, and an explicit ceiling: `take` defaults to 200, so a run with
  // more findings than that would export a silently truncated file — which is
  // the worst possible failure for a thing whose whole purpose is to be the
  // complete record.
  const findings = missionStore.listFindings({ missionId: id, runCount: artifact.runCount, take: 100_000 });
  const rows = findings.map((finding) => [
    finding.id, finding.dimensionId, finding.verifyState, finding.claim,
    finding.evidence, finding.sourceUrl, finding.sourceHost, finding.createdAt,
  ]);
  return send(csv(["finding_id", "dimension_id", "verify_state", "claim", "quote", "url", "host", "collected_at"], rows),
    "text/csv; charset=utf-8", "facts.csv");
}

    if (req.method === "GET" && action === "report.md") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const params = paramsOf(req);
      const version = boundedInteger(params, "version", 1, 1_000_000, 0);
      if (version.error !== undefined) return bad(version.error);
      const artifact = version.value === 0 ? missionStore.latestArtifact(id) : missionStore.getArtifact(id, version.value);

      if (artifact === undefined || artifact?.kind === "empty-artifact") {
        // 404 with the REASON. `not-yet-materialized` and `write-failed` want
        // opposite responses from the reader, and a sentinel that means both is
        // a default wearing a costume.
        sendJson(res, 404, {
          success: false,
          error: artifact?.reason === "write-failed"
            ? `mission ${id} is terminal but no artefact was written; the report does not exist`
            : `mission ${id} has not produced a report yet`,
          data: { reason: artifact?.reason ?? "no-such-version" },
        });
        return true;
      }

      const body = typeof artifact.markdown === "string" ? artifact.markdown : "";
      // THE BIBLIOGRAPHY, APPENDED HERE AND NOT IN `assemble`.
      //
      // The export ended mid-prose with eleven numbered references in the text
      // and nothing anywhere saying what `[7]` was. Both halves of the answer
      // are already stored on the artefact row — `citations` carries the index,
      // the url and the finding it came from, and `evidence` carries that
      // finding's verified quote and fetch stamp — so this is a join, not a
      // derivation.
      //
      // Doing it at the ROUTE means every artefact already on disk exports
      // correctly. Doing it in `assemble` would fix only reports written after
      // the change, and would also put the reference list inside the very
      // `markdown` the content guard counts words over, which quietly moves the
      // word-count floor.
      // THE FIGURE BLOCKS COME OUT FIRST, then the bibliography goes on. Both
      // are joins over columns already on the artefact and both are done HERE
      // for the reason the note above gives about the bibliography: every
      // artefact already on disk exports correctly, and neither changes the
      // `markdown` the content guard counted its words over.
      //
      // Order matters. The bibliography is appended after the last chapter, so
      // rewriting the tokens first keeps the rewrite confined to the report's
      // own body and cannot reach into a reference list that never had one.
      const markdown = renderFigureTokens(body, artifact, { language: mission.language })
        + buildBibliography(artifact, { language: mission.language });
      const filename = `${id}${artifact.version ? `-v${artifact.version}` : ""}.md`;
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-length": Buffer.byteLength(markdown),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      });
      res.end(markdown);
      return true;
    }

    // ── stop one ────────────────────────────────────────────────────────
    // DELETE, not POST: this removes rather than starts something, and a
    // route whose verb lies about that is one a reader has to check.
    if (req.method === "DELETE" && action === "delete") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const gone = missionStore.deleteMission(id);
      if (!gone.ok) {
        // 409, not 500: a running mission refusing deletion is a state, not a
        // fault, and the reason names the thing to do about it.
        sendJson(res, 409, { success: false, error: gone.reason });
        return true;
      }
      sendJson(res, 200, { success: true, data: { id, removed: gone.removed } });
      return true;
    }

    if (req.method === "POST" && action === "cancel") {
      const mission = missionOr404(id);
      if (mission === null) return true;

      // ABORT FIRST, THEN WRITE. Never a bare status write: writing `cancelled`
      // while the work keeps spending shows the user a cancelled mission whose
      // compute is still running, and the still-running run's own terminal write
      // then loses the conditional-write race, so every minute of it is
      // discarded with nothing anywhere saying so.
      const aborted = runtime.abort(id, "user_cancelled");
      const result = finalize({
        store: missionStore,
        clock: runtime.clock,
        missionId: id,
        origin: "lifecycle",
        registry: runtime.registry,
        abort: true,
        intent: {
          status: "cancelled",
          runCount: mission.runCount,
          abortReason: "user_cancelled",
          reason: "cancelled from the mission list",
        },
        logger,
      });
      sendJson(res, result.won ? 200 : 409, {
        success: result.won,
        error: result.won ? undefined : result.reason,
        // Both halves reported. `aborted: false` with `won: true` means the row
        // was already terminal or the run belongs to a dead process — different
        // situations, and the caller can tell them apart.
        data: { aborted: aborted.aborted, abortWhy: aborted.why, status: result.status, previousStatus: result.previousStatus },
      });
      return true;
    }

    // ── pick one back up ────────────────────────────────────────────────
    if (req.method === "POST" && action === "resume") {
      const mission = missionOr404(id);
      if (mission === null) return true;

      const check = canResume({ store: missionStore, mission, now: runtime.clock(), stages: STAGES });
      if (!check.ok) {
        // 409 carrying the reason AND the next action. An unnamed refusal
        // reaches the user as "resume did nothing", which is indistinguishable
        // from "resume is broken".
        sendJson(res, 409, {
          success: false,
          error: `${check.reason}: ${check.detail}`,
          data: { reason: check.reason, detail: check.detail, refusals: RESUME_REFUSALS },
        });
        return true;
      }
      const started = runtime.claim(id);
      sendJson(res, started.started ? 200 : 409, {
        success: started.started,
        error: started.started ? undefined : started.reason,
        data: { id, runCount: started.runCount, resumesAt: check.detail, started: started.started },
      });
      return true;
    }

    // ── run it again ────────────────────────────────────────────────────
    if (req.method === "POST" && action === "rerun") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        return bad(String(cause?.message ?? cause));
      }
      const mode = typeof body?.mode === "string" ? body.mode : "fresh";
      if (mode !== "fresh" && mode !== "incremental") return bad('mode must be "fresh" or "incremental"');

      const running = runtime.running();
      const cap = concurrencyCap(config());
      if (running.includes(id)) {
        // Refused rather than superseded. A rerun of a LIVE mission would claim
        // the row out from under the run that is driving it: the old run's
        // terminal write would then lose the conditional-write race and its
        // spend would be discarded, while the new generation started on a
        // connection the old one is still using. Cancel first, then rerun.
        sendJson(res, 409, {
          success: false,
          error: `mission ${id} is still running in this process. Cancel it first — rerunning a live mission would claim the row out from under the run that is driving it and discard everything that run has spent.`,
          data: { running },
        });
        return true;
      }
      if (running.length >= cap) {
        sendJson(res, 409, { success: false, error: `${running.length} mission(s) are already running and missionMaxConcurrent is ${cap}: ${running.join(", ")}`, data: { running, cap } });
        return true;
      }

      // A rerun DELETES NOTHING. `run_count` keys every findings, chapters and
      // artifacts row, so the previous generation stays readable beside the new
      // one and the artefact version list is the history.
      // FRESH MEANS THE STAGE MACHINE STARTS OVER, and it did not. The rows
      // are per step id rather than per generation, so a finished mission's
      // twelve `done` rows made `runMission` skip every stage and die on the
      // s12 contract in seven seconds. Reset before the claim: the claim is
      // what makes the row dispatchable, and a run that becomes dispatchable
      // while its stages still say `done` is exactly the race this ordering
      // removes.
      if (mode === "fresh") missionStore.resetStagesForFreshRerun(id, runtime.clock());
      // THE GENERATION IS THE SLATE, AND ONLY A FRESH RERUN WANTS A NEW ONE.
      //
      // `run_count` is this schema's generation key: `listChapters`,
      // `verifiedFindings`, `listDimensions`, `figuresForChapter` and
      // `freezeEvidence` are all scoped by it, so bumping it means "start over
      // with nothing". A fresh rerun means exactly that, and
      // `resetStagesForFreshRerun` above puts every stage back so they refill
      // it.
      //
      // AN INCREMENTAL RERUN MEANS THE OPPOSITE. It keeps what was done and
      // redoes what was not — stages are deliberately not reset — so bumping
      // the generation left every `done` stage's rows one generation back,
      // invisible to the stages that were redone.
      //
      // MEASURED: eight chapters and 107 citations written in generation 3; an
      // incremental rerun opened generation 4, re-ran s12 alone, found no
      // chapters, and wrote a 413-word stub as the report.
      //
      // The single-stage rerun route below already passes `false` for the same
      // reason in one sentence: it re-runs a step INSIDE the mission that ran
      // it.
      //
      // The crash limit is untouched: `canResume` refuses at `runCount >=
      // RECLAIM_LIMIT && failureCode === "runtime_crashed"`, which counts
      // crashes, and an operator pressing rerun is not a crash.
      const claimed = missionStore.claimForRun(id, { bootId: runtime.bootId, pid: process.pid, newGeneration: mode === "fresh", at: runtime.clock() });
      if (!claimed.claimed) {
        sendJson(res, 409, { success: false, error: claimed.reason, data: { id } });
        return true;
      }
      const previous = missionStore.latestConfig(id);
      missionStore.putConfig(
        id,
        mode === "fresh" ? "rerun-fresh" : "rerun-incremental",
        // The PREVIOUS resolved config, carried forward. Re-resolving here is
        // exactly playground's rerun bug: it could not read its own ceiling,
        // fell back to a default worth about two dollars, and the rerun died
        // instantly with every layer reporting success.
        { ...(previous?.config ?? {}), rerunOf: claimed.runCount - 1, mode },
        runtime.clock(),
      );
      // `startOrPark`, never a bare `start`: the claim above already moved the
      // row to `running`, and a refusal that left it there would show a live
      // mission with nothing driving it until the next boot sweep.
      const started = runtime.startOrPark(id);
      sendJson(res, started.started ? 200 : 409, {
        success: started.started,
        error: started.started ? undefined : started.reason,
        data: { id, runCount: claimed.runCount, mode, started: started.started, parked: started.parked === true },
      });
      return true;
    }

    // -- run ONE stage again ---------------------------------------------
    // A SEPARATE ROUTE, not a third `mode` on `rerun`, because the two do
    // opposite things to the generation: `rerun` opens a new one, this one stays
    // inside the current one. Folding them together would put `newGeneration`
    // behind a field in a request body, and that is the field that decides
    // whether the previous run's findings survive.
    if (req.method === "POST" && action === "stages" && leaf === "rerun") {
      const mission = missionOr404(id);
      if (mission === null) return true;
      const stepId = rest ?? "";

      const running = runtime.running();
      const cap = concurrencyCap(config());
      if (running.includes(id)) {
        // The same refusal the whole-mission rerun gives, for the same reason:
        // claiming a live row out from under the run that is driving it makes
        // that run lose its own terminal write and discards its entire spend.
        sendJson(res, 409, {
          success: false,
          error: `mission ${id} is still running in this process. Cancel it first — re-running a stage of a live mission would claim the row out from under the run that is driving it and discard everything that run has spent.`,
          data: { running },
        });
        return true;
      }
      if (running.length >= cap) {
        sendJson(res, 409, { success: false, error: `${running.length} mission(s) are already running and missionMaxConcurrent is ${cap}: ${running.join(", ")}`, data: { running, cap } });
        return true;
      }

      // RESET BEFORE THE CLAIM. The claim is what makes the row dispatchable,
      // and a run that becomes dispatchable while the stage it was asked to
      // re-run still says `done` starts at the first unsettled stage, walks past
      // the one the user pointed at, and reports success.
      const reset = missionStore.resetStageForRerun(id, stepId, runtime.clock());
      if (!reset.ok) {
        // 409 carrying the reason AND the sentence to act on. `s1-brief` and
        // `s12-persist` each wrote their own `rerunReason` into the pipeline
        // declaration; showing it is the difference between a refusal somebody
        // can do something about and a control that silently does nothing.
        sendJson(res, 409, {
          success: false,
          error: `${reset.reason}: ${reset.detail}`,
          data: { id, stepId, reason: reset.reason, detail: reset.detail },
        });
        return true;
      }

      // NOT A NEW GENERATION, and that is the whole difference from `rerun`.
      // Findings, chapters and artefacts are keyed by `run_count` and the stages
      // BEFORE this one keep theirs; bumping would orphan the very rows the
      // re-run stage reads as its input, so it would open on an empty corpus
      // while every earlier row still said the work was done.
      const claimed = missionStore.claimForRun(id, { bootId: runtime.bootId, pid: process.pid, newGeneration: false, at: runtime.clock() });
      if (!claimed.claimed) {
        sendJson(res, 409, { success: false, error: claimed.reason, data: { id, stepId } });
        return true;
      }
      const previous = missionStore.latestConfig(id);
      missionStore.putConfig(
        id,
        // The reason the vocabulary has carried since the schema was written and
        // no route ever wrote. `s12` reads it back to stamp the artefact version
        // `recovered`, so a version produced by re-running one stage is not
        // filed as though a full rerun had produced it.
        "stage-rerun",
        // The PREVIOUS resolved config, carried forward — re-resolving here is
        // playground's rerun bug, which could not read its own ceiling and fell
        // back to a default worth about two dollars. The revision is still NEW,
        // because a revision is what grants this run a fresh allowance while the
        // mission row's frozen caps stay what it is graded against: run against
        // the residual of a pool the original drained, a stage re-run a month
        // later dies instantly at `budget_exhausted`.
        { ...(previous?.config ?? {}), stageRerunOf: stepId, stageRerunResets: reset.reset },
        runtime.clock(),
      );
      // `startOrPark`, never a bare `start`, for the reason the rerun above
      // gives: the claim has already moved the row to `running`.
      const started = runtime.startOrPark(id);
      sendJson(res, started.started ? 200 : 409, {
        success: started.started,
        error: started.started ? undefined : started.reason,
        // `reset` is the answer to "what did this throw away", reported rather
        // than left for the caller to recompute from the DAG.
        data: { id, stepId, runCount: claimed.runCount, reset: reset.reset, started: started.started, parked: started.parked === true },
      });
      return true;
    }

    // Anything else under `/missions/` is not ours. Reported as unhandled so the
    // outer router 404s it in one place rather than each sub-router inventing
    // its own not-found.
    return false;
  };
}

/**
 * How many findings were never checked, from a verify-state histogram.
 *
 * Matched by PREFIX rather than listed, for the reason §4.4 gives: a new
 * `unchecked-*` state added to the vocabulary must land here automatically, not
 * silently in the fabrication bucket. A 429 is not a fabrication.
 * @param byState - `{ [verifyState]: n }`, without `total`.
 * @returns the number of findings in an `unchecked-` state.
 */
function uncheckedTotal(byState) {
  let n = 0;
  for (const [state, count] of Object.entries(byState)) {
    if (state.startsWith("unchecked-")) n += Number(count) || 0;
  }
  return n;
}

/** The one terminal event, whose payload carries the guard's violations as rows. */
const FINALIZED_EVENT = "mission:finalized";

/**
 * Assemble the artefact's `degradeReason` from what is already on disk.
 *
 * Three reads, all indexed: the mission row (already in hand), s11's recorded
 * signature, and the terminal event's payload. The event is preferred over the
 * prose in `error_message` because s12 puts the SAME violations in both — as
 * structured `{code, detail}` rows in the payload and as a joined sentence in
 * the column — and splitting a sentence back apart is a parse, while the
 * payload is a record. `projectDegradeReason` reports which one it used.
 *
 * @param missionStore - the MissionStore.
 * @param missionId - the mission.
 * @param mission - the already-shaped missions row.
 * @returns the degrade reason block.
 */
function degradeReasonFor(missionStore, missionId, mission) {
  const insights = projectStageInsights(missionStore.listStageOutputs(missionId));
  // Newest first, so a rerun's reason is the reason for the run that ended
  // last rather than for a generation nobody is looking at.
  const finalized = missionStore.eventsOfType(FINALIZED_EVENT, { missionId, limit: 1 })[0] ?? null;
  return projectDegradeReason({
    mission,
    signoff: insights.signoff,
    finalizedPayload: finalized?.payload ?? null,
  });
}

/**
 * Read the three streams the trajectory merges, once, and build it.
 *
 * ONE READ SERVES BOTH TRAJECTORY ROUTES. The detail route resolves its `ref`
 * inside the very streams the list was built from — see `resolveTraceSource` —
 * rather than issuing a second, narrower query. Two reads would be two windows,
 * and a row that the list showed but the detail route's window had already
 * slid past would 404 on a row the reader is looking at.
 *
 * `runCount` narrows the FINDINGS and the dimension tallies and nothing else.
 * `mission_events` and `mission_tool_calls` carry no generation column, so a
 * rerun's trajectory shows both generations' calls in one ordered list — which
 * is what actually happened, and saying so here is cheaper than a reader
 * discovering it from a timestamp that predates the rerun.
 *
 * @param missionStore - the MissionStore.
 * @param missionId - the mission.
 * @param runCount - the generation whose findings and dimensions are read.
 * @returns `{ rows, streams, stages, dimensions, lastEventSeq, window }`.
 */
function readTrace(missionStore, missionId, runCount) {
  const events = missionStore.eventTail(missionId, TRACE_EVENT_WINDOW);
  const toolCalls = missionStore.recentToolCalls(missionId, TRACE_TOOL_WINDOW);
  const findings = missionStore.listFindings({ missionId, runCount, take: TRACE_FINDING_WINDOW });
  const stages = missionStore.listStages(missionId);
  const dimensions = missionStore.listDimensions(missionId, { runCount });
  const streams = { events, stages, toolCalls, findings, dimensions };

  return {
    rows: buildMissionTrace(streams),
    streams,
    stages,
    dimensions,
    lastEventSeq: missionStore.lastEventSeq(missionId),
    // Reported, never assumed. `saturated` is the honest answer to "is this the
    // whole history": at the cap, older rows are on disk and outside this page.
    window: {
      events: { taken: events.length, cap: TRACE_EVENT_WINDOW, saturated: events.length >= TRACE_EVENT_WINDOW },
      toolCalls: { taken: toolCalls.length, cap: TRACE_TOOL_WINDOW, saturated: toolCalls.length >= TRACE_TOOL_WINDOW },
      findings: { taken: findings.length, cap: TRACE_FINDING_WINDOW, saturated: findings.length >= TRACE_FINDING_WINDOW },
      note: "Each stream is read from its newest end to its own cap. A saturated stream means older rows exist on disk and are not in this trajectory.",
    },
  };
}

/**
 * Everything a detail panel needs about one trajectory row, untruncated.
 *
 * The shape is the SAME for all four kinds — `payload`, `result`, `timing`,
 * `stage`, `dimension` — so the panel has one renderer rather than four, and
 * the kind-specific record (`toolCall`, `finding`, `event`) hangs off the side
 * for anything that wants the raw row. The alternative, a different shape per
 * kind, is four branches in the client that each have to be kept in step with
 * this file by somebody who cannot ask.
 *
 * WHERE THE TIMING CAME FROM IS PART OF THE ANSWER. `timing.source` names the
 * column, and where the number is derived rather than stored it says so. A tool
 * call's `at` is written when the call RETURNS, so its start is `at` minus the
 * measured latency — a derivation, reported as one, because a start time
 * presented as recorded when it was computed is the kind of number people build
 * arguments on.
 *
 * @param input - `{ missionId, row, source, trace }`.
 * @returns the detail record.
 */
function traceDetail({ missionId, row, source, trace }) {
  const { event, stage, toolCall, finding } = source;
  const dimension = row.dimensionId === null
    ? null
    : trace.dimensions.find((entry) => entry.dimensionId === row.dimensionId) ?? null;

  let payload = null;
  let result = { text: null, format: null, note: null };
  let timing = { at: row.at, ms: row.ms, startedAt: null, endedAt: null, source: null };

  if (toolCall !== null) {
    payload = {
      tool: toolCall.tool,
      // WHOLE, as stored. `mission_tool_calls.args_text` is itself capped at
      // 300 characters at insert — an unbounded column on a per-call table is a
      // library that grows without anybody choosing to — so this is everything
      // there is, and `argsTextStoredCap` says so rather than leaving the
      // reader to wonder which layer did the cutting.
      argsText: toolCall.argsText,
      argsTextStoredCap: 300,
      argsHash: toolCall.argsHash,
      paceKey: toolCall.paceKey,
      cached: toolCall.cached,
      stepId: toolCall.stepId,
      agentId: toolCall.agentId === "" ? null : toolCall.agentId,
    };
    result = {
      text: toolCall.ok ? (toolCall.cached ? "cached" : "ok") : String(toolCall.errorCode ?? "failed"),
      format: "text",
      // Said out loud rather than served as an empty Result tab. The ledger
      // records the VERDICT of a call, not its body: storing every fetched page
      // twice — once here and once in `mission_documents` — is the duplication
      // the document cache exists to avoid.
      note: "mission_tool_calls records the verdict of a call, not its body. A fetched page's text is in mission_documents; a finding's quote is on the finding row.",
    };
    const startedMs = Date.parse(String(toolCall.at ?? "")) - Number(toolCall.latencyMs ?? 0);
    timing = {
      at: toolCall.at,
      ms: toolCall.latencyMs,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
      endedAt: toolCall.at,
      source: "mission_tool_calls.at is written when the call returns; startedAt is that instant minus the measured latency_ms, and is derived rather than recorded.",
    };
  } else if (finding !== null) {
    payload = projectFinding(finding, { dimensionName: dimension?.name ?? null });
    result = {
      // The verbatim quote, whole and untouched. The list row clips it; this is
      // the only place the reader can read it, which is the entire point.
      text: finding.evidence,
      format: "text",
      note: finding.verifyReason === null ? null : `verifier: ${finding.verifyReason}`,
    };
    timing = { at: finding.createdAt, ms: null, startedAt: null, endedAt: finding.createdAt, source: "mission_findings.created_at" };
  } else if (event !== null) {
    payload = event.payload;
    const ended = row.kind === "stage" && row.state !== "started";
    result = {
      text: ended && stage?.output != null ? JSON.stringify(stage.output, null, 2) : JSON.stringify(event.payload ?? {}, null, 2),
      format: "json",
      note: ended && stage?.output != null ? "mission_stages.output — what the stage returned, as it was recorded." : null,
    };
    timing = {
      at: event.ts,
      ms: ended ? stage?.durationMs ?? null : null,
      startedAt: stage?.startedAt ?? null,
      endedAt: stage?.endedAt ?? null,
      source: ended
        ? "mission_stages.duration_ms, measured across the stage; the row's own instant is mission_events.ts."
        : "mission_events.ts",
    };
  }

  return {
    missionId,
    ref: row.ref,
    // Echoed so a caller that navigated by position can see whether the
    // position it asked for still names the row it thought it did.
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    at: row.at,
    ok: row.ok,
    state: row.state,
    row,
    payload,
    result,
    timing,
    stepId: row.stepId,
    agentId: row.agentId,
    stage: stage === null || stage === undefined ? null : {
      stepId: stage.stepId,
      ordinal: stage.ordinal,
      status: stage.status,
      attempts: stage.attempts,
      startedAt: stage.startedAt,
      endedAt: stage.endedAt,
      durationMs: stage.durationMs,
      tokens: stage.tokens,
      degradeNote: stage.degradeNote,
    },
    dimension: dimension === null ? null : {
      dimensionId: dimension.dimensionId,
      name: dimension.name,
      facet: dimension.facet,
      state: dimension.state,
      grade: dimension.grade,
      summary: dimension.summary,
      verified: dimension.verified,
      total: dimension.total,
      uniqueHosts: dimension.uniqueHosts,
    },
    // The raw store rows, for anything the uniform shape above flattens away.
    // Exactly one of these is non-null, and which one is `kind`.
    toolCall,
    finding: finding === null ? null : projectFinding(finding, { dimensionName: dimension?.name ?? null }),
    event,
  };
}


/**
 * The p50 / p90 token cost of prior missions at one depth.
 *
 * Computed in JS over the terminal rows rather than in SQL, because SQLite has
 * no percentile function and a hand-rolled one in a string is a statement
 * nobody can read. The sample is small by construction — one row per mission
 * somebody asked for.
 * @param missionStore - the MissionStore.
 * @param depth - the tier to estimate for.
 * @returns `{p50, p90, n}`; `p50` is NaN when there is no history, which is what budgetGate reads.
 */
export function spendHistory(missionStore, depth) {
  const { missions } = missionStore.listMissions({ depth, take: 100 });
  const costs = missions
    .filter((mission) => mission.completedAt !== null && mission.completedAt !== undefined)
    .map((mission) => Number(mission.spend?.tokens ?? 0))
    .filter((tokens) => Number.isFinite(tokens) && tokens > 0)
    .sort((a, b) => a - b);
  if (costs.length === 0) return { p50: Number.NaN, p90: Number.NaN, n: 0 };
  const at = (share) => costs[Math.min(costs.length - 1, Math.floor(share * costs.length))];
  return { p50: at(0.5), p90: at(0.9), n: costs.length };
}

/** The pacing settings frozen into a mission's config revision, so a rerun knows what it ran under. */
function pacingOf(settings) {
  return {
    missionParseP50Ms: settings.missionParseP50Ms,
    missionArxivIntervalMs: settings.missionArxivIntervalMs,
    missionFetchIntervalMs: settings.missionFetchIntervalMs,
    missionDocumentMaxAgeDays: settings.missionDocumentMaxAgeDays,
    missionTurnCap: settings.missionTurnCap,
    // Frozen with the rest: a rerun that shrank harder than its predecessor
    // because somebody cleared this number should be able to say so.
    missionContextWindow: settings.missionContextWindow,
  };
}

/**
 * Stream a mission's events as Server-Sent Events, resumable from a cursor.
 *
 * The wire format matches index.js's existing `data: {...}` / `data: [DONE]`
 * lines so the browser half keeps one parser regardless of which route answered.
 *
 * Polled rather than subscribed, on purpose: this is one process on one
 * synchronous connection, and `readEvents` with a `seq > ?` index is a few
 * microseconds. An event bus here would be a second source of truth about what
 * happened, and the table is already the first.
 *
 * @param res - the response this function owns.
 * @param missionStore - the MissionStore.
 * @param missionId - the mission.
 * @param since - the last `seq` the client saw.
 * @param runtime - the runner, for the terminal check.
 */
async function streamEvents(res, missionStore, missionId, since, runtime) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  let cursor = since;
  let closed = false;
  let idleMs = 0;
  res.on("close", () => { closed = true; });

  try {
    for (;;) {
      if (closed) return;
      const page = missionStore.readEvents(missionId, { since: cursor, limit: EVENT_PAGE });
      for (const event of page.events) send(event);
      if (page.events.length > 0) {
        cursor = page.nextSeq;
        idleMs = 0;
      } else {
        idleMs += EVENT_POLL_MS;
      }
      if (page.hasMore) continue;

      const mission = missionStore.getMission(missionId);
      // Terminal AND drained. Checking the status first would close the stream
      // before the terminal event itself had been sent, so the last thing the
      // reader saw would be whatever happened just before the end.
      if (mission === undefined || (isTerminalStatus(mission.status) && !runtime.running().includes(missionId))) return;
      if (idleMs >= EVENT_IDLE_MS) {
        // Closed deliberately, with the cursor, rather than held open for ever.
        // A stream that never ends is a file descriptor that never closes, and
        // the client already knows how to resume from `since`.
        send({ idle: true, since: cursor, reason: "no events for ten minutes; reconnect with ?since to continue" });
        return;
      }
      await new Promise((resolve) => { setTimeout(resolve, EVENT_POLL_MS).unref?.(); });
    }
  } catch (cause) {
    if (!closed) send({ error: String(cause?.message ?? cause) });
  } finally {
    if (!closed) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

/** Whether a status means the mission is over. From the runtime's vocabulary, never a local list. */
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}
