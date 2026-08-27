/**
 * The twelve handlers, assembled once, and the runner that drives them.
 *
 * Two things live here and both are assembly rather than behaviour:
 *
 *   createMissionHandlers  the four stage modules become one object keyed by
 *                          STAGE_IDS. Keyed and CHECKED against STAGE_IDS: a
 *                          misspelt key would otherwise be discovered by
 *                          `runMission`'s missing-handler guard at the moment a
 *                          three-hour deep mission reached that stage.
 *   createMissionRuntime   the boot id, the abort registry, the failure circuit,
 *                          the per-mission budget pool, and `start()` — which
 *                          DISPATCHES a mission and returns, so a route can
 *                          answer in milliseconds while the work runs for hours.
 *
 * The runner owns nothing a handler owns. `finalize`, `startStage`,
 * `finishStage`, `saveCheckpoint`, `claimForRun` and the rest belong to
 * `mission-runtime.js`; this module supplies the store, the clock, the boot id
 * and the pool, and then gets out of the way. A second caller of any of those is
 * the failure the handler contract exists to prevent.
 *
 * @see docs/insight-mission.md §8.2 and §5 — the runner, the sweep, the pool.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import {
  STAGES,
  STAGE_IDS,
  canResume,
  checkDeadlines,
  checkStall,
  claimRuntimeOwner,
  createRunRegistry,
  detectNoProgress,
  finalize,
  runMission,
  sweepOrphans,
} from "./mission-runtime.js";
import { createCircuit, TOOL_COOLDOWN_DDL, assertPacerRegistry, assertRegistry } from "./mission-tools.js";
import { createBudgetPool, LADDER } from "./mission-budget.js";
import { createMissionChat } from "./mission-agent.js";
import { createS1Brief, createS2Plan, createS3Collect, createS4Assess } from "./mission-stages-front.js";
import { createS5Reconcile, createS6Synthesize, createS7Outline, createS8Write } from "./mission-stages-middle.js";
import { createBackStages } from "./mission-stages-back.js";

/**
 * How often the lifecycle watchdog asks its three questions. §5.2 specifies a
 * 30-second no-progress interval, and this is that interval — the wall clock
 * and the stall notice ride it rather than arming timers of their own.
 */
const WATCHDOG_INTERVAL_MS = 30_000;

/**
 * How long a stage may emit no business event, WHILE SPEND IS STILL RISING,
 * before the run is treated as wedged.
 *
 * Both halves matter. A paced arXiv round and a serialised jsdom parse make a
 * long-but-silent stage the normal case here, so silence alone is not evidence
 * of anything; silence with the meter running is.
 */
const NO_PROGRESS_KILL_MS = 300_000;

/**
 * Build the twelve stage handlers over one dependency bag.
 *
 * One factory and one naming convention, so four groups cannot invent three.
 * Every handler is a closure over `store`; the runtime passes no store into the
 * handler context and must not, because a handler that could reach the runtime's
 * own writers would be the second caller of a single-writer operation.
 *
 * `prompts` is OPTIONAL and is one contract in all three stage modules:
 * `(role, duty) => systemText`. Absent, every stage falls back to
 * `loadRolePrompt`, which reads `lib/mission/agents/<role>/SKILL.md`. It is
 * spelled out because `mission-stages-middle.js` briefly read it as an object
 * with a `.system({agent, duty, bindings})` method while the other two read it
 * as a function, and since nothing wired either, the disagreement showed up not
 * as a crash but as four stages calling the model with no system document.
 *
 * `budget` is NOT in this bag. It reaches a handler through the runtime's own
 * per-stage context, because the pool is per mission and this factory runs once
 * per process.
 *
 * @param deps - `{store, sourceStore, chat, circuit, cache, spillDir, config, ctx, logger, prompts?}`.
 * @returns handlers keyed by STAGE_IDS.
 */
export function createMissionHandlers(deps) {
  const bag = deps ?? {};
  if (typeof bag.store?.getMission !== "function") {
    throw new TypeError("createMissionHandlers needs the MissionStore as deps.store (openMissionStore(sourceStore)), not the SourceStore and not a path.");
  }
  if (typeof bag.chat !== "function") {
    throw new TypeError("createMissionHandlers needs the agent seam as deps.chat — createMissionChat(ctx). No stage writes its own model loop.");
  }

  const handlers = {
    "s1-brief": createS1Brief(bag),
    "s2-plan": createS2Plan(bag),
    "s3-collect": createS3Collect(bag),
    "s4-assess": createS4Assess(bag),
    "s5-reconcile": createS5Reconcile(bag),
    "s6-synthesize": createS6Synthesize(bag),
    "s7-outline": createS7Outline(bag),
    "s8-write": createS8Write(bag),
    ...createBackStages(bag),
  };

  // Checked here, at boot, rather than by `runMission`'s own guard at dispatch.
  // Both directions matter: a MISSING id kills the mission at the stage that
  // needs it, and an EXTRA id is a handler nobody will ever call, which reads
  // like working code for as long as anyone cares to look at it.
  const built = Object.keys(handlers);
  const missing = STAGE_IDS.filter((id) => typeof handlers[id] !== "function");
  const extra = built.filter((id) => !STAGE_IDS.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`createMissionHandlers: the handler set does not match STAGE_IDS.${missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : ""}${extra.length > 0 ? ` Not a stage: ${extra.join(", ")}.` : ""} The stage catalogue in mission-runtime.js is the only list; correct the keys here rather than adding a stage there.`);
  }

  return handlers;
}

/**
 * Assemble the runner: one boot id, one registry, one circuit, one set of
 * handlers, and a `start` that does not block the caller.
 *
 * `ctx.get("web")` rather than `inject`: the search plugin stays optional, and
 * absent is resolved per call so installing it mid-run takes effect at the next
 * tool recall rather than at the next restart.
 *
 * @param options - `{store, missionStore, ctx, config, spillDir, logger}`.
 * @returns `{bootId, registry, clock, handlers, chat, start, abort, sweep, claim, running, stop}`.
 */
export function createMissionRuntime({ store, missionStore, ctx, config = {}, spillDir, logger = null }) {
  if (typeof missionStore?.getMission !== "function") {
    throw new TypeError("createMissionRuntime needs the MissionStore as `missionStore`. Open it with openMissionStore(sourceStore) so both faces share one connection and one WAL.");
  }
  if (ctx === null || ctx === undefined) {
    throw new TypeError("createMissionRuntime needs the Cordis context: the agent seam reads ctx.llm and ctx.agentDefaultModel per call, and the optional search seam through ctx.get(\"web\").");
  }

  // The registries are asserted at boot rather than at first use. A tool whose
  // pace key nobody meters, or two pacer chains for one key, is a fact about the
  // build; discovering it at stage three of a deep mission costs an hour.
  assertRegistry();
  assertPacerRegistry();

  // The one table `mission-tools.js` owns and `MISSION_MIGRATIONS` does not.
  // Run here, with the store, so a broken statement is a stack trace at start-up
  // rather than a circuit that silently forgets every rate-limit ban.
  missionStore.db.exec(TOOL_COOLDOWN_DDL);

  // A fresh identity per process. This is what makes the boot sweep exact: every
  // row still `running` under a DIFFERENT boot id is orphaned by definition, in
  // one query, with no threshold and no false positives.
  const bootId = randomUUID();
  const clock = () => new Date().toISOString();
  const registry = createRunRegistry();
  const circuit = createCircuit({ db: missionStore.db });
  const chat = createMissionChat(ctx, { logger });

  // Bounded, and shared across missions on purpose: it is a same-arguments
  // result cache behind the tool door, and two missions on one topic should not
  // pay twice for one arXiv page.
  const cache = new Map();

  if (typeof spillDir === "string" && spillDir !== "") {
    // Created eagerly. `truncateResult` writes here on the first oversized
    // result, and a missing directory turns a large-but-fine observation into a
    // tool failure halfway through a mission.
    try {
      mkdirSync(spillDir, { recursive: true });
    } catch (cause) {
      logger?.warn?.(`swarm: could not create the mission spill directory ${spillDir}: ${String(cause?.message ?? cause)}. Oversized tool results will be truncated without a readable tail.`);
    }
  }

  const handlers = createMissionHandlers({
    store: missionStore,
    sourceStore: store,
    chat,
    circuit,
    cache,
    spillDir,
    config,
    ctx,
    logger,
  });

  /** Missions this process is running right now, so the concurrency cap is a fact rather than a hope. */
  const inFlight = new Map();

  /**
   * Last observed token spend per mission, so "is spend still rising?" is a
   * measurement across two ticks rather than a guess. Cleared with the run.
   */
  const spendMarks = new Map();

  /**
   * The pool for one mission, seeded from the LEDGER rather than from zero.
   *
   * A resumed or re-run mission that started its meter at zero could spend its
   * whole ceiling again on every resume — which is how "resume" becomes an
   * unbounded multiplier on a cap somebody chose once.
   * @param mission - the shaped mission row.
   * @returns a MissionBudgetPool.
   */
  const budgetFor = (mission) => {
    const totals = missionStore.spendTotals(mission.id);
    const tools = missionStore.toolCallTotals(mission.id);
    return createBudgetPool({
      caps: mission.budget,
      used: {
        tokens: totals.tokens,
        calls: totals.calls,
        arxiv: tools.arxiv?.charged ?? 0,
        web: tools.web?.charged ?? 0,
        fetch: tools.fetch?.charged ?? 0,
      },
      // The two columns ARE the once-only mechanism, so these can be called
      // unconditionally: the conditional UPDATE inside the store is what makes
      // the notice fire once, and it needs no in-memory map with an expiry.
      onCross: (rung, state) => {
        if (rung === "warn") {
          missionStore.markSoftWarned(mission.id, clock());
          logger?.warn?.(`swarm: mission ${mission.id} passed ${Math.round(LADDER.warn * 100)}% of its ${state.dimension} ceiling (${state.used} of ${state.limit})`);
        }
        if (rung === "stop") missionStore.markExhausted(mission.id, clock());
      },
    });
  };

  /**
   * Start a mission and RETURN. The promise is deliberately not awaited by any
   * caller: a `deep` mission runs for three hours and a request that waited for
   * it would time out somewhere in the middle with the work still going.
   *
   * @param missionId - a mission already claimed and `running`.
   * @returns `{started, reason}` — `started: false` always says why.
   */
  const start = (missionId) => {
    const mission = missionStore.getMission(missionId);
    if (mission === undefined) return { started: false, reason: `no mission row for ${missionId}` };
    if (mission.status !== "running") {
      return { started: false, reason: `the mission is ${mission.status}, not running. Claim it first — create, resume and rerun all go through the atomic claim, which is what stops two clicks 100ms apart from both starting it.` };
    }
    if (inFlight.has(missionId)) {
      return { started: false, reason: "this process is already running that mission" };
    }
    const cap = concurrencyCap(config);
    if (inFlight.size >= cap) {
      return {
        started: false,
        reason: `${inFlight.size} mission(s) are already running and missionMaxConcurrent is ${cap}: ${[...inFlight.keys()].join(", ")}. One process means one pacer, and a second concurrent mission doubles the request rate the pacer exists to hold.`,
      };
    }

    const budget = budgetFor(mission);
    const promise = runMission({
      store: missionStore,
      clock,
      bootId,
      missionId,
      handlers,
      registry,
      budget,
      logger,
    })
      .then((summary) => {
        if (summary?.ok !== true) logger?.warn?.(`swarm: mission ${missionId} ended: ${summary?.reason ?? "no reason given"}`);
        return summary;
      })
      .catch((cause) => {
        // `runMission` writes its own terminal row on every path it owns. This
        // catch is for the paths it does not — a throw out of the runtime itself
        // — and it must not be silent: a rejected floating promise leaves the row
        // `running` with nothing anywhere saying why until the next boot sweep.
        logger?.warn?.(`swarm: mission ${missionId} threw out of the runtime: ${String(cause?.message ?? cause)}`);
        return { ok: false, missionId, reason: String(cause?.message ?? cause) };
      })
      .finally(() => {
        inFlight.delete(missionId);
        // Or a rerun inherits the previous generation's spend mark and reads
        // its own first tick as "spend did not rise".
        spendMarks.delete(missionId);
      });

    inFlight.set(missionId, promise);
    return { started: true, reason: null };
  };

  /**
   * Dispatch a mission that has just been claimed — and undo the claim if the
   * dispatch is refused.
   *
   * `claimForRun` sets `status = 'running'`. If `start` then refuses, the row
   * sits `running` with NOTHING driving it: the list shows a live mission, the
   * re-entry guard refuses another resume, and nobody finds out until the next
   * boot sweep. Parking it back is the difference between a refusal the user can
   * act on and a mission that is stuck until a restart. Measured here: a rerun
   * issued while the previous generation was still draining left exactly that
   * row behind.
   *
   * @param missionId - a mission already claimed and `running`.
   * @returns `{started, reason, parked}` — `reason` is always populated when `started` is false.
   */
  const startOrPark = (missionId) => {
    const dispatched = start(missionId);
    if (dispatched.started) return { started: true, reason: null, parked: false };
    const parked = missionStore.parkResumable(missionId, { note: dispatched.reason, at: clock() });
    return {
      started: false,
      parked: parked.parked,
      reason: parked.parked
        ? `${dispatched.reason} The mission was parked back to resumable rather than left running with nothing driving it; resume it when the other run has finished.`
        : `${dispatched.reason} It could not be parked back either (${parked.reason}), so check the mission list before retrying.`,
    };
  };

  /**
   * The one interval, asking the three questions `mission-runtime.js` exports
   * predicates for.
   *
   * That module's header says the predicates are "exported here for
   * `lifecycle.js` to drive from the one interval it already owns". There is no
   * `lifecycle.js` in this plugin and nothing else called them, so
   * `detectNoProgress` and `checkStall` had NO caller anywhere and
   * `checkDeadlines` was only reached at stage boundaries. The measured
   * consequence: §5.2 asks for two timers and the subsystem armed zero, so a
   * mission wedged INSIDE a stage — a researcher looping on one tool, a fetch
   * that never returns — was never terminated by anything. The wall clock could
   * not fire until the stage it was meant to interrupt had already finished.
   *
   * This is a NOTICE-and-ABORT loop, never a kill: it aborts through the same
   * registry a user cancel goes through, so the run writes its own terminal row
   * with its own reason. It deliberately does not own a per-stage deadline —
   * that is the mechanism playground deleted on 2026-05-06 after it repeatedly
   * killed fan-outs that were demonstrably alive.
   *
   * @returns nothing; every decision is emitted or aborted, never silent.
   */
  const tick = () => {
    const at = clock();
    for (const entry of registry.list()) {
      const mission = missionStore.getMission(entry.missionId);
      // The row is gone or already settled: drop the stale entry rather than
      // aborting something that is not running.
      if (mission === undefined || mission.status !== "running") continue;

      // 1. The stall NOTICE. One per stage, latched inside `checkStall`.
      const stall = checkStall({ entry, now: at });
      if (stall.stalled) {
        try {
          missionStore.appendEvent(entry.missionId, {
            type: "stage:stalled",
            at,
            stepId: stall.detail.stepId,
            payload: { ...stall.detail, why: stall.why },
          });
        } catch (cause) {
          // A notice that cannot be written must not take down the watchdog
          // that is also holding the two abort conditions below.
          logger?.warn?.(`swarm: could not record stage:stalled for ${entry.missionId}: ${String(cause?.message ?? cause)}`);
        }
      }

      // 2. The wall clock. Checked here as well as at stage boundaries, which
      //    is the whole point: a three-hour stage cannot be interrupted by a
      //    check that only runs when it ends.
      const deadline = checkDeadlines({ mission, now: at });
      if (deadline.expired) {
        logger?.warn?.(`swarm: mission ${entry.missionId} aborted: ${deadline.reason} (${JSON.stringify(deadline.detail)})`);
        // THE SAME SEAM, THE OTHER GUARD. `checkDeadlines` returns which
        // ceiling was hit and by how much, and `describeFailure` reads exactly
        // those fields for `wall_time_exceeded` and `budget_exhausted` — so
        // dropping the detail here reports a mission killed by its wall clock
        // as one killed by nothing in particular.
        registry.abort(entry.missionId, deadline.reason, { runCount: entry.runCount, detail: deadline.detail });
        continue;
      }

      // 3. The no-progress guard. `spendRose` is measured across ticks, and the
      //    tool shapes are narrowed to calls made SINCE the last business
      //    event: fed the whole history, three identical calls from an hour ago
      //    would trip the loop-shape rule against a run that is working fine.
      const tokens = missionStore.spendTotals(entry.missionId).tokens;
      const previous = spendMarks.get(entry.missionId);
      spendMarks.set(entry.missionId, tokens);
      const since = new Date(entry.lastProgressAtMs).toISOString();
      // SCOPED TO THE STAGE THAT IS STUCK, and it was not. `recentToolCalls`
      // reads the whole mission, so a wedge at s4 was judged on rows s3 wrote —
      // measured this afternoon: a mission stalled at s4-assess was killed for
      // a "loop" assembled from s3-collect's fan-out fetches, minutes after s3
      // had finished. Work a finished stage did cannot be evidence that the
      // current one is repeating itself.
      const shapes = missionStore
        .recentToolCalls(entry.missionId, 50)
        .filter((call) => String(call.at) >= since)
        .filter((call) => String(call.stepId ?? "") === String(entry.stepId ?? ""));

      const wedged = detectNoProgress({
        entry,
        now: at,
        noProgressKillMs: NO_PROGRESS_KILL_MS,
        spendRose: previous !== undefined && tokens > previous,
        toolShapes: shapes,
      });
      if (wedged.tripped) {
        logger?.warn?.(`swarm: mission ${entry.missionId} aborted: ${wedged.why}`);
        registry.abort(entry.missionId, wedged.reason, { runCount: entry.runCount, detail: wedged.detail });
      }
    }
  };

  // `unref` so a harness with an idle mission subsystem can still exit. The
  // interval is armed once for the process, not once per mission: one interval
  // asking three questions beats a timer per stage.
  const watchdog = setInterval(tick, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();

  /**
   * Abort a live run, then let the caller write the terminal row.
   *
   * The abort must fire BEFORE the write, never after: writing `cancelled` while
   * the work keeps spending forks reality — the UI shows cancelled, resume is
   * refused by the re-entry guard, and the still-running work's own terminal
   * write loses the race, so every minute of compute is discarded.
   * @param missionId - the mission.
   * @param reason - an ABORT_REASONS member.
   * @returns the registry's own `{aborted, already, why}`.
   */
  // FORWARDS THE DETAIL, rather than being the one door that cannot carry one.
  // Every guard in this file computes a verdict and this helper is how a caller
  // outside it reaches the registry; a passthrough that drops the argument is a
  // dead end that only shows up as a sentence with no facts in it.
  const abort = (missionId, reason, detail = null) => registry.abort(missionId, reason, { detail });

  /**
   * The boot sweep. Always moves rows out of `running`; auto-resume is a
   * separate, opt-in decision (see `missionAutoResume` in index.js) because a
   * plugin process restarts on a settings change and on a harness auto-update,
   * not only on a crash.
   * @returns `{claimed, owner, swept}`.
   */
  const sweep = () => {
    const ownership = claimRuntimeOwner({
      store: missionStore,
      clock,
      bootId,
      pid: process.pid,
      // Injected because `process.kill(pid, 0)` is a side effect. A live pid
      // owned by another harness on the same file means REFUSE, not resolve:
      // reclaiming its missions would abort work that is genuinely running.
      isPidLive: (pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch (cause) {
          return cause?.code === "EPERM";
        }
      },
    });
    if (!ownership.claimed) return { claimed: false, owner: ownership.owner, reason: ownership.reason, swept: [] };
    const { swept } = sweepOrphans({ store: missionStore, clock, bootId, registry, logger, stages: STAGES });
    return { claimed: true, owner: ownership.owner, reason: ownership.reason, swept };
  };

  /**
   * Re-claim a parked mission and start it. The one path resume and auto-resume
   * both take, so a refusal reads identically whoever asked.
   * @param missionId - the mission.
   * @returns `{started, reason, runCount}`.
   */
  const claim = (missionId) => {
    const mission = missionStore.getMission(missionId);
    if (mission === undefined) return { started: false, reason: `no mission row for ${missionId}`, runCount: null };
    const check = canResume({ store: missionStore, mission, now: clock(), stages: STAGES });
    if (!check.ok) return { started: false, reason: `${check.reason}: ${check.detail}`, runCount: null };
    // `claimForRun` stamps `last_reopened_at` in the same UPDATE as
    // `status='running'`. Without it the wall clock runs from the ORIGINAL
    // start and a mission resumed an hour later dies in its first stage against
    // a cap it never had; `runMission` refuses the run for exactly that reason.
    const claimed = missionStore.claimForRun(missionId, { bootId, pid: process.pid, newGeneration: true, at: clock() });
    if (!claimed.claimed) return { started: false, reason: claimed.reason, runCount: null };
    const dispatched = startOrPark(missionId);
    return { started: dispatched.started, reason: dispatched.reason, runCount: claimed.runCount };
  };

  /**
   * Stop every live run and write an honest terminal row for each.
   *
   * `shutdown` rather than `cancelled`: the user did not ask for this, and
   * filing a harness restart under "cancelled on request" is what makes a
   * postmortem corpus useless for finding real failures.
   * @returns the number of missions stopped.
   */
  const stop = () => {
    // Before the terminal writes: a tick that fired between the abort and the
    // write would abort a mission this function is already finalizing.
    clearInterval(watchdog);
    const live = registry.list();
    for (const entry of live) {
      finalize({
        store: missionStore,
        clock,
        missionId: entry.missionId,
        origin: "lifecycle",
        registry,
        abort: true,
        intent: {
          status: "failed",
          runCount: entry.runCount,
          failureCode: "shutdown",
          abortReason: "shutdown",
          detail: { stepId: entry.stepId, resumeArmed: true },
          reason: "the harness shut down",
        },
        logger,
      });
    }
    return live.length;
  };

  return {
    bootId,
    clock,
    registry,
    circuit,
    handlers,
    chat,
    budgetFor,
    start,
    abort,
    sweep,
    claim,
    startOrPark,
    stop,
    // Exported so the watchdog can be driven one tick at a time against an
    // injected clock. A guard that can only be observed by waiting thirty
    // seconds is a guard nobody writes a test for.
    tick,
    /** @returns the ids this process is running right now. */
    running: () => [...inFlight.keys()],
  };
}

/**
 * How many missions this process may run at once.
 *
 * Read per call rather than captured, so raising it in settings takes effect at
 * the next create rather than at the next restart. Clamped here as well as in
 * `writeConfig` because a library written by an older build, or edited by hand,
 * is not covered by the settings route's validation.
 * @param config - the plugin configuration.
 * @returns an integer from 1 to 3.
 */
export function concurrencyCap(config) {
  const asked = Number(config?.missionMaxConcurrent);
  if (!Number.isFinite(asked)) return 1;
  return Math.max(1, Math.min(3, Math.round(asked)));
}
