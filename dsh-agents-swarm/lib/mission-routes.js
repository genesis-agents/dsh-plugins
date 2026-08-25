/**
 * The mission tab's HTTP face: open one, watch it, stop it, read what it wrote.
 *
 * Mirrors lib/insight-routes.js deliberately — one factory over the Host half's
 * helpers, returning a handler that either answers or reports that it did not,
 * so index.js keeps one router rather than three competing ones.
 *
 * THREE THINGS THAT LOOK LIKE STYLE AND ARE NOT:
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
 *    data, which is a filter that looks like it works and shows nothing.
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
import { isMissionId } from "./mission-store.js";
import { projectMissionView, readMissionViewInput } from "./mission-view.js";
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
 * The mission id and the action from `/missions/<id>/<action>`.
 * @param path - the already-stripped path.
 * @returns `{ id, action }`, or null when the shape does not match.
 */
function splitMissionPath(path) {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length !== 3 || parts[0] !== "missions") return null;
  let id;
  try {
    id = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  return { id, action: parts[2] };
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
    const { id, action } = target;

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

    // ── the artefact ────────────────────────────────────────────────────
    if (req.method === "GET" && action === "artifact") {
      if (missionOr404(id) === null) return true;
      const params = paramsOf(req);
      const version = boundedInteger(params, "version", 1, 1_000_000, 0);
      if (version.error !== undefined) return bad(version.error);

      const artifact = version.value === 0
        ? missionStore.latestArtifact(id)
        : missionStore.getArtifact(id, version.value) ?? { kind: "empty-artifact", reason: "no-such-version" };
      sendJson(res, 200, {
        success: true,
        data: {
          artifact,
          // The header list, so the reader can move between runs without a
          // second request. Bodies are deliberately not read: a deep report is
          // tens of thousands of words and this renders on every detail view.
          versions: missionStore.listArtifactVersions(id),
        },
      });
      return true;
    }

    // ── the report, as a file ───────────────────────────────────────────
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

      const markdown = typeof artifact.markdown === "string" ? artifact.markdown : "";
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
      const claimed = missionStore.claimForRun(id, { bootId: runtime.bootId, pid: process.pid, newGeneration: true, at: runtime.clock() });
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

    // Anything else under `/missions/` is not ours. Reported as unhandled so the
    // outer router 404s it in one place rather than each sub-router inventing
    // its own not-found.
    return false;
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
