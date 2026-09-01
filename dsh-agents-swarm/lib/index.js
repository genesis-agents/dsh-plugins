/**
 * Agents, Host half: the local source library and its HTTP face.
 *
 * The page reads THIS harness's own store, not a remote one. `/swarm-api`
 * answers from SQLite; the upstream is reachable only through the explicit
 * `/swarm-api/seed` action, which imports rows into the local library. That
 * keeps the surface working offline, keeps the data ours, and leaves room for
 * the swarm's own collector agents to write into the same store later.
 *
 * A same-origin route is also what makes the fetch possible at all: the page
 * cannot call an external API directly, because a cross-origin GET to the
 * upstream returns 200 with no `access-control-allow-origin` and the browser
 * blocks it. Server-to-server seeding has no such constraint.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { SourceStore, RESOURCE_TYPES } from "./store.js";
import { COLLECTORS, DEFAULT_COLLECT_INTERVAL_MINUTES, runCollector } from "./collect.js";
import { registerLibraryTool } from "./tool.js";
import { resolveTranscript, listCaptionTracks, transcriptFromXml, fetchVideoDetails, supadataKeys } from "./transcript.js";
import { translateBatch, isSupportedLanguage, BATCH_SIZE, TARGET_LANGUAGES } from "./translate.js";
import { admissibleUrl, fetchDocument, readableText, readArticle, displayModeOf, documentUrlOf } from "./proxy.js";
import { sourceFeeds } from "./sources.js";
import { enrichThumbnails, imageForPage, ENRICHABLE_TYPES, DEFAULT_ENRICH_LIMIT } from "./enrich.js";
import { createPublishRoutes } from "./publish-routes.js";
import { PUBLISH_DEFAULTS, readPublishConfig, startPublishTimer } from "./publish-schedule.js";
import { createInsightRoutes } from "./insight-routes.js";
import { MIN_INSIGHT_INTERVAL_MINUTES, isInsightDue, readInsightConfig, runInsightPass } from "./insight-extract.js";
import { openInsightStore } from "./insight-store.js";
import { openMissionStore } from "./mission-store.js";
import { createMissionRuntime } from "./mission-handlers.js";
import { createMissionRoutes } from "./mission-routes.js";
import { MISSION_SETTING_KEYS, readMissionConfig, validateMissionConfig } from "./mission-config.js";
import { createProxyHandler } from "./remote.js";
import { PLUGIN_CHANNEL, PLUGIN_COMMIT, PLUGIN_DIR, PLUGIN_VERSION, versionLabel } from "./version.js";
import { DOCUMENT_FORMATS } from "./documents.js";
import { LIBRARY_ENV, mediaDirs, resolveLibrary, writeLibraryPointer } from "./library.js";

/** Route prefix this plugin owns on the dsh web server. */
const ROUTE_PREFIX = "/swarm-api";

/** Upstream used by the seed action; override with `DSH_SWARM_SEED_BASE`. */
const DEFAULT_SEED_BASE = "https://gens.team/api/v1";

/** Rows one seed request pulls per type, per page. */
const SEED_PAGE = 100;

/**
 * Default ceiling per type for one seed run.
 *
 * Seeding is a MIGRATION window, not a runtime dependency: the upstream is
 * scheduled to be retired, so the local library has to end up holding
 * everything worth keeping before that happens. The default is therefore
 * generous, and `?max=0` lifts the ceiling entirely for a full drain.
 */
const SEED_MAX_PER_TYPE = 5000;

/** A leading `~` followed by either path separator. */
const HOME_PREFIX = /^~[/\\]/;

/** Expand a leading `~` in a path, platform-style. */
function expandHome(path, home = homedir()) {
  if (path === "~") return home;
  if (HOME_PREFIX.test(path)) return join(home, path.slice(2));
  return path;
}

/**
 * Resolve the DSH home directory: the environment override wins, the platform
 * home fallback follows.
 * @param env - process environment to read `DSH_HOME` from.
 * @param home - platform home directory fallback (test seam).
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME;
  if (raw !== undefined && raw.trim() !== "") {
    const expanded = expandHome(raw.trim(), home);
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  }
  return join(home, ".dsh");
}

/**
 * Absolute path of the source library database.
 *
 * Throws when the configuration names a remote: a caller asking for a local
 * path on a machine that proxies has a bug, and answering with a plausible
 * default would hide it behind an empty library.
 * @param env - process environment.
 * @returns the absolute database path.
 */
export function storePath(env = process.env) {
  const library = resolveLibrary(env, homedir());
  if (library.kind !== "local") {
    throw new Error(`no local library on this machine: ${LIBRARY_ENV} names ${library.base}`);
  }
  return library.path;
}

/**
 * Record where the library should live, for later launches.
 * @param value - an absolute path, or an http(s) URL to proxy.
 * @param env - process environment.
 */
export function writeStorePointer(value, env = process.env) {
  writeLibraryPointer(value, env, homedir());
}

/**
 * Where locally held thumbnails live: beside the database, so a library that
 * is copied to another machine carries its images with it.
 * @param env - process environment.
 * @returns the absolute directory path.
 */
export function thumbnailDir(env = process.env) {
  return mediaDirs(storePath(env)).thumbnails;
}

/** Upstream origin for the seed action, without a trailing slash. */
/**
 * The transcript fetcher the insight pass uses to top up what it is missing.
 *
 * INJECTED RATHER THAN IMPORTED BY THE PASS. insight-extract.js is a pure
 * pipeline over a store and a chat entry point; giving it a network client of
 * its own would make every test of the extraction stage reach for one. It is
 * built here because this is where the config and the seed base already live.
 *
 * `resolveTranscript` tries timedtext, then a relay, then gens, and only then
 * Supadata's paid quota — so the common case costs nothing, and the budget in
 * `insightTranscribePerPass` exists to be polite to the free routes rather
 * than to ration money.
 * @param store - the source library, for the configured key and languages.
 * @returns `async (row) => { language, text, cues, via }`, or undefined when
 *   the row is not a video this can fetch for.
 */
function insightTranscriber(store) {
  return async (row) => {
    const videoId = videoIdOf(row?.sourceUrl ?? "");
    // Not a throw: a non-video in the skip list is not a failure to report,
    // it is a row this stage has nothing to offer. The caller records the
    // empty answer and moves on.
    if (videoId === undefined) return { text: "" };
    const config = readConfig(store);
    return resolveTranscript(videoId, {
      apiKey: config.supadataKey,
      gensBase: seedBase(),
      languages: config.transcriptLanguages,
    });
  };
}

function seedBase(env = process.env) {
  const raw = env.DSH_SWARM_SEED_BASE;
  const value = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : DEFAULT_SEED_BASE;
  return value.replace(/\/+$/, "");
}

/** Send one JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/** Attempts a single page gets before the type is reported as failed. */
const SEED_ATTEMPTS = 6;

/** Pause between attempts, in milliseconds. */
function backoffDelay(attempt) {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/** Resolve after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one seed page, retrying through the upstream's rate limiter.
 *
 * A full drain asks for a few hundred pages in a row, which the upstream
 * answers with 429 partway through. The migration has to survive that: the
 * remote service is being retired, so a run that gives up leaves rows behind
 * permanently. `Retry-After` is honoured when sent, exponential backoff
 * otherwise.
 * @param url - the page URL.
 * @param type - resource type, for the error message.
 * @returns the successful response.
 */
async function fetchWithBackoff(url, type) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < SEED_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (response.ok) return response;
    lastStatus = response.status;
    // 429 and 5xx are worth waiting out; a 4xx of any other kind will not
    // become successful by repeating it.
    if (response.status !== 429 && response.status < 500) break;
    const header = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(header) && header > 0 ? header * 1000 : backoffDelay(attempt);
    await sleep(wait);
  }
  throw new Error(`${type}: HTTP ${lastStatus}`);
}

/**
 * Pull one type from the upstream into the local library.
 * @param store - the open source store.
 * @param type - a `ResourceType` value.
 * @param base - upstream origin.
 * @param max - per-type ceiling; 0 lifts it for a full drain.
 * @returns `{ type, written, skipped, fetched }`.
 */
async function seedType(store, type, base, max) {
  let skip = 0;
  let fetched = 0;
  let written = 0;
  let skipped = 0;
  for (;;) {
    const url = `${base}/resources?take=${SEED_PAGE}&skip=${skip}&type=${encodeURIComponent(type)}&sortBy=publishedAt&sortOrder=desc`;
    const response = await fetchWithBackoff(url, type);
    const payload = await response.json();
    const body = payload?.data ?? payload;
    const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    if (rows.length === 0) break;
    const result = store.putMany(rows);
    written += result.written;
    skipped += result.skipped;
    fetched += rows.length;
    skip += rows.length;
    const hasMore = body?.pagination?.hasMore === true;
    if (!hasMore) break;
    if (max > 0 && fetched >= max) break;
  }
  return { type, fetched, written, skipped };
}

/**
 * The collection run used when a caller names no jobs.
 *
 * Deliberately small and general: a deployment's real roster belongs in its own
 * configuration, and a default that pulls half the internet on first click is
 * worse than one that demonstrates the shape. Override per call with
 * `{ jobs: [{ collector, options }] }`.
 */
const DEFAULT_JOBS = [
  { collector: "arxiv", options: { query: "cat:cs.AI", max: 50 } },
  { collector: "hackernews", options: { query: "AI", max: 50, minPoints: 50 } },
];

// Minutes between automatic collection runs; 0 disables the timer.
//
// Hourly is what the reference uses for news and is comfortably slower than
// any of these feeds publish. It is on by default because a source library
// that only holds what was migrated into it stops being a source library the
// day after the migration.


/** Shortest interval accepted, so a misconfiguration cannot hammer a provider. */
const MIN_COLLECT_INTERVAL_MINUTES = 15;

/**
 * Run every configured collector once, tolerating individual failures.
 *
 * A collector that throws must not stop the others: one dead feed is normal
 * and should cost only its own rows.
 * @param store - the source library.
 * @param logger - Cordis logger, or anything with `info`/`warn`.
 * @returns the per-collector results.
 */
/**
 * Run a list of jobs, naming each in its result.
 * @param store - the source library.
 * @param jobs - `[{ collector, options }]`.
 * @returns one result per job, successes and failures alike.
 */
async function runJobs(store, jobs) {
  const results = [];
  for (const job of jobs) {
    // Name the job in the result, success or failure. A roster of 72 feeds
    // reporting `{collector: "feed", error: "fetch failed"}` says a source is
    // broken without saying which, which is barely better than silence.
    const label = job.options?.name ?? job.options?.url ?? job.collector;
    try {
      results.push({ ...await runCollector(store, job.collector, job.options ?? {}), source: label });
    } catch (cause) {
      results.push({ collector: job.collector, source: label, error: String(cause?.message ?? cause) });
    }
  }
  return results;
}

export async function collectOnce(store, logger) {
  const config = readConfig(store);
  const jobs = config.jobs.concat(config.feeds.map((feed) => ({ collector: "feed", options: feed })));
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const results = await runJobs(store, jobs);
  const written = results.reduce((sum, row) => sum + (row.written ?? 0), 0);
  logger?.info?.(`swarm: collected ${written} new row(s) from ${jobs.length} job(s)`);
  // A bounded enrichment pass rides along with each cycle. Bounded because it
  // costs one request per row against sites that had nothing to do with our
  // schedule; riding along because a separate timer would be a second thing
  // to reason about for no benefit — the rows it works on are the ones the
  // run just wrote.
  let thumbnails;
  try {
    thumbnails = await enrichThumbnails(store, { logger });
  } catch (cause) {
    logger?.warn?.(`swarm: thumbnail pass failed: ${String(cause?.message ?? cause)}`);
  }
  recordCollection(store, {
    startedAt,
    finishedAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - startedMs) / 1000),
    jobs: jobs.length,
    fetched: results.reduce((sum, row) => sum + (row.fetched ?? 0), 0),
    written,
    added: store.countCreatedSince(startedAt),
    thumbnails,
    failures: results
      .filter((row) => row.error !== undefined)
      .map((row) => ({ source: row.source, error: String(row.error).slice(0, 160) })),
  });
  return results;
}

/** Runs kept in the log. Enough to see a pattern, small enough to stay a setting. */
const COLLECTION_LOG_LIMIT = 30;

/**
 * Append one run to the collection log.
 *
 * Written to the store rather than only to `ctx.logger`, because the logger's
 * output does not reach the process stdout in this harness — every run so far
 * left no trace an operator could read, and diagnosing them meant inferring
 * what happened from timestamps on the rows themselves. A log nobody can read
 * is not a log.
 * @param store - the source library.
 * @param entry - the run summary.
 */
export function recordCollection(store, entry) {
  const history = store.getSetting("collectionLog", []);
  const next = [entry, ...(Array.isArray(history) ? history : [])].slice(0, COLLECTION_LOG_LIMIT);
  store.setSetting("collectionLog", next);
}

/**
 * Start the periodic collection timer.
 *
 * Deliberately a plain interval owned by this plugin rather than
 * `dsh-schedule`: that package gives an AGENT session-scoped reminders, keyed
 * to a session's event log, which is the wrong lifetime for host-side intake
 * that must keep running with no session open. `unref` keeps the timer from
 * holding the process alive on shutdown.
 *
 * The 洞察 pass rides this same tick rather than owning a timer of its own.
 * The rows it reads are the rows the collection just wrote, so a second
 * interval would be a second thing to reason about and a race to lose: both
 * would read `insightLastRun.watermark`, and whichever recorded its run second
 * would move the watermark past rows the other had already skipped. Those rows
 * are never read again, and nothing anywhere reports it.
 * @param store - the source library.
 * @param logger - Cordis logger.
 * @param insightStore - the 洞察 store, or undefined to leave the pass unwired.
 * @param chat - streaming chat entry point, or undefined when no model is routed.
 * @param ctx - Cordis context, for the optional `ctx.get("web")` search seam.
 * @returns a disposer stopping the timer.
 */
export function startCollectionTimer(store, logger, insightStore, chat, ctx) {
  let timer;
  let catchUp;
  const configured = Number(readConfig(store).collectIntervalMinutes ?? DEFAULT_COLLECT_INTERVAL_MINUTES);
  if (!Number.isFinite(configured) || configured <= 0) {
    // Collection off turns the insight pass off with it, because the pass runs
    // on this tick. Said out loud rather than left to be discovered: the
    // alternative is a 洞察 tab that stays empty while its own interval is set
    // and `/insights/status` reports a schedule nothing is honouring.
    if (insightStore !== undefined && Number(readInsightConfig(store).insightIntervalMinutes) > 0) {
      logger?.warn?.("swarm: collection is off, so the insight pass will not run either — it rides the collection tick");
    }
    return () => {};
  }
  const minutes = Math.max(MIN_COLLECT_INTERVAL_MINUTES, configured);
  logger?.info?.(`swarm: collecting every ${minutes} minute(s)`);

  /**
   * Whether a pass started by this timer is still going.
   *
   * The guard `startPublishTimer` carries, for the same reason: a pass is up
   * to twenty model calls over minutes and a collection run is itself slow, so
   * two ticks overlap easily. Two overlapping passes read the same watermark,
   * cluster the same rows, and pay twice for them — while both report success.
   */
  let insightRunning = false;

  /** Run the 洞察 pass if it is armed, due, and not already running. */
  const runInsights = async () => {
    if (insightStore === undefined) return;
    if (insightRunning) return;
    // `insightIntervalMinutes` still decides whether this tick is due, so
    // arming the pass stays a decision and zero still means off. It cannot
    // make the pass run more often than collection does, though: 30 under an
    // hourly collection is an hourly pass, not a half-hourly one.
    if (!isInsightDue(readInsightConfig(store))) return;
    insightRunning = true;
    try {
      // Never throws; it settles into a recorded result either way, which is
      // what `/insights/status` reads.
      // `ctx.get`, not `inject`. The search plugin stays optional: injecting
      // "web" would make dsh-agents-swarm refuse to load without it, and the
      // library is worth having on its own. Absent, the pass corroborates from
      // arXiv alone and says so.
      await runInsightPass(store, insightStore, chat, logger, {
        // The scheduled pass tops up transcripts too, and this is where the
        // backlog actually drains: twelve videos an hour, unattended, is what
        // turns "23 of 523" into a library the pass can read.
        transcribe: insightTranscriber(store),
        markSkips: true,
        // `ctx` is a PARAMETER. It was read here as a free variable, which is a
        // ReferenceError on every tick the pass was due — swallowed by the outer
        // catch as "insight pass could not be started: ctx is not defined", so
        // the hourly 洞察 pass never ran at all and the tab simply stayed empty.
        web: typeof ctx?.get === "function" ? ctx.get("web") : undefined,
      });
    } finally {
      insightRunning = false;
    }
  };

  const run = () => {
    void collectOnce(store, logger)
      .catch((cause) => {
        logger?.warn?.(`swarm: collection run failed: ${String(cause?.message ?? cause)}`);
      })
      // AFTER the collection settles, not beside it: the pass reads rows past
      // its own watermark, and starting the two together would leave this
      // run's rows for the next tick. A failed collection still gets a pass —
      // a partial run writes rows, and a pass with nothing new to read skips
      // for the price of one query.
      .then(runInsights)
      .catch((cause) => {
        logger?.warn?.(`swarm: insight pass could not be started: ${String(cause?.message ?? cause)}`);
      });
  };

  // The interval counts from process start, so every restart pushes the next
  // run a full hour out. A box that restarts often therefore collects rarely,
  // and nothing says so — the status page reports an interval that is
  // configured and a last run that is old, and the two look unrelated. Over
  // one afternoon of deployments here the feeds went six hours untouched while
  // the timer reported itself as running every sixty minutes.
  //
  // So the clock is the RECORDED last run, not this process's uptime.
  const runs = store.getSetting("collectionLog", []);
  const last = Array.isArray(runs) && runs.length > 0 ? Date.parse(runs[0]?.startedAt ?? "") : Number.NaN;
  const dueIn = Number.isFinite(last)
    ? Math.max(0, last + minutes * 60_000 - Date.now())
    : 0;

  if (dueIn <= 0) {
    // Not immediately: booting is already the busiest moment, and the plugin
    // tree, the database, and the routes all want the first seconds more than
    // a fetch of 72 feeds does.
    logger?.info?.("swarm: last collection is older than the interval; catching up shortly");
    catchUp = setTimeout(run, 30_000);
    catchUp.unref?.();
  }

  timer = setInterval(run, minutes * 60_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (catchUp !== undefined) clearTimeout(catchUp);
  };
}

/** Language preference used when the deployment configures none. */
const DEFAULT_TRANSCRIPT_LANGUAGES = ["zh-Hans", "zh-CN", "zh", "en", "en-US"];

/** Extract a YouTube video id from a watch, short, or embed URL. */
export function videoIdOf(url) {
  if (typeof url !== "string") return undefined;
  for (const pattern of [
    /[?&]v=([A-Za-z0-9_-]{11})/, /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/, /\/shorts\/([A-Za-z0-9_-]{11})/,
  ]) {
    const match = pattern.exec(url);
    if (match !== null) return match[1];
  }
  return undefined;
}

/**
 * Version stamp for the shipped roster. Bumping it re-installs the roster over
 * whatever is stored.
 *
 * BUMP IT IN THE SAME COMMIT THAT EDITS `sources.js`, or the edit is inert.
 * Measured: twenty-one channels were added, pushed, deployed, and a collection
 * run afterwards touched four video feeds — the stored roster was still the
 * one installed at version 2, and nothing in the run said so. The feeds are
 * read from the STORE, not from the module, and the store is only written
 * when this number moves.
 *
 * 3 — the venture channels, the long-form interview shows, the Stanford
 *     lecture series, 十字路口 and 张小珺.
 */
const ROSTER_VERSION = 3;

/**
 * Install the shipped source roster the first time, and never again.
 *
 * Seeding on every boot — which is what the reference does — means an operator
 * cannot remove a source: it comes back on restart. Stamping the version makes
 * this a one-time migration, so the roster is a starting point rather than
 * something the plugin keeps re-asserting over the operator's edits.
 * @param store - the source library.
 * @param logger - Cordis logger.
 * @returns true when the roster was installed by this call.
 */
export function ensureSourceRoster(store, logger) {
  if (Number(store.getSetting("rosterVersion", 0)) >= ROSTER_VERSION) return false;
  const feeds = sourceFeeds();
  store.setSetting("feeds", feeds);
  store.setSetting("rosterVersion", ROSTER_VERSION);
  logger?.info?.(`swarm: installed ${feeds.length} source feed(s)`);
  return true;
}

/**
 * Read the plugin's configuration, filling defaults for anything unset.
 * @param store - the source library.
 * @returns the configuration, including the daily-episode schedule.
 */
export function readConfig(store) {
  return {
    feeds: store.getSetting("feeds", []),
    jobs: store.getSetting("jobs", DEFAULT_JOBS),
    transcriptLanguages: store.getSetting("transcriptLanguages", DEFAULT_TRANSCRIPT_LANGUAGES),
    supadataKey: store.getSetting("supadataKey", ""),
    collectIntervalMinutes: store.getSetting("collectIntervalMinutes", DEFAULT_COLLECT_INTERVAL_MINUTES),
    ...readPublishConfig(store),
    ...readInsightConfig(store),
    // 任务. Same shape as the two above: defaults, reader and validator all live
    // in the feature's own module, and this line is the only place index.js
    // knows the section exists.
    ...readMissionConfig(store),
  };
}

/**
 * Validate and persist a configuration patch.
 *
 * Only the keys present are written, so the settings page can save one field
 * without resending a secret it was never shown. An empty-string key is an
 * explicit clear; an absent key leaves the stored one alone.
 * @param store - the source library.
 * @param patch - the incoming partial configuration.
 * @returns validation problems; empty means the patch was written.
 */
export function writeConfig(store, patch) {
  const problems = [];
  if (patch.feeds !== undefined) {
    if (!Array.isArray(patch.feeds)) problems.push("feeds must be an array");
    else {
      for (const [index, feed] of patch.feeds.entries()) {
        if (typeof feed?.url !== "string" || !/^https?:\/\//.test(feed.url)) {
          problems.push(`feeds[${index}].url must be an http(s) URL`);
        }
        if (feed?.type !== undefined && !RESOURCE_TYPES.includes(feed.type)) {
          problems.push(`feeds[${index}].type must be one of ${RESOURCE_TYPES.join(", ")}`);
        }
      }
    }
  }
  if (patch.jobs !== undefined && !Array.isArray(patch.jobs)) problems.push("jobs must be an array");
  if (patch.transcriptLanguages !== undefined && !Array.isArray(patch.transcriptLanguages)) {
    problems.push("transcriptLanguages must be an array");
  }
  if (patch.supadataKey !== undefined && typeof patch.supadataKey !== "string") {
    problems.push("supadataKey must be a string");
  }
  if (patch.collectIntervalMinutes !== undefined) {
    const minutes = Number(patch.collectIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) problems.push("collectIntervalMinutes must be zero or a positive number");
    else if (minutes > 0 && minutes < MIN_COLLECT_INTERVAL_MINUTES) {
      // Was `problems.push()` with no argument, which pushed `undefined`: the
      // patch was rejected and the page was told why in an empty string.
      problems.push(`collectIntervalMinutes must be at least ${MIN_COLLECT_INTERVAL_MINUTES}, or zero to turn collection off`);
    }
  }
  // The daily episode. `publishAt` is checked rather than coerced because a
  // typo there fails SILENTLY: the timer reads an unparseable time as "no
  // schedule" and simply never fires, which looks exactly like a schedule that
  // is set and working until the morning it does not arrive.
  if (patch.publishAt !== undefined && !(typeof patch.publishAt === "string" && (patch.publishAt === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.publishAt)))) {
    problems.push("publishAt must be HH:MM on a 24-hour clock, or empty to turn the daily episode off");
  }
  if (patch.publishKinds !== undefined) {
    if (!Array.isArray(patch.publishKinds)) problems.push("publishKinds must be an array");
    else {
      for (const kind of patch.publishKinds) {
        if (!RESOURCE_TYPES.includes(kind)) problems.push(`publishKinds must be drawn from ${RESOURCE_TYPES.join(", ")}`);
      }
    }
  }
  for (const [key, low, high] of [
    ["publishSources", 1, 20], ["publishMinutes", 2, 20], ["publishMinSources", 1, 20],
    // 洞察. `insightIntervalMinutes` is deliberately absent: 0-or-at-least-30
    // is not a range, and putting it here would accept 5.
    ["insightMaxRows", 20, 600], ["insightMaxClusters", 1, 60], ["insightMaxReconcileCalls", 0, 40],
    // 0 turns the top-up off and is a legitimate choice — on a library with no
    // videos it is the only sensible one. A plain range rather than the
    // zero-or-a-minimum shape the two intervals use: a budget of 1 is not a
    // race with itself, it is just a slow drain.
    ["insightTranscribePerPass", 0, 60],
    ["insightMinIndependent", 2, 5], ["insightWindowDays", 1, 30], ["insightDormantDays", 3, 120],
    ["insightDuplicateBits", 0, 12],
  ]) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    if (!Number.isFinite(value) || value < low || value > high) problems.push(`${key} must be between ${low} and ${high}`);
  }
  if (patch.publishHosts !== undefined && (typeof patch.publishHosts?.a !== "string" || typeof patch.publishHosts?.b !== "string")) {
    problems.push("publishHosts must be { a, b } naming two voices");
  }
  if (patch.publishArtifacts !== undefined) {
    // Validated against what can actually be produced, so arming a format that
    // does not exist fails at the moment somebody asks for it rather than at
    // seven the next morning.
    const known = new Set(["podcast", ...DOCUMENT_FORMATS.map((format) => format.id)]);
    if (!Array.isArray(patch.publishArtifacts)) problems.push("publishArtifacts must be an array");
    else for (const id of patch.publishArtifacts) {
      if (!known.has(id)) problems.push(`publishArtifacts must be drawn from ${[...known].join(", ")}`);
    }
  }
  if (patch.publishChinese !== undefined && typeof patch.publishChinese !== "boolean") {
    problems.push("publishChinese must be true or false");
  }
  // ── 洞察 ─────────────────────────────────────────────────────────────
  // Checked rather than coerced, for `publishSources`' reason. A coerced value
  // is a value nobody agreed to: `Number("thirty")` is NaN, and clamping it to
  // a default would save the patch, answer `{saved: true}`, and run the pass
  // on a schedule the page does not show.
  if (patch.insightIntervalMinutes !== undefined) {
    const minutes = Number(patch.insightIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      problems.push("insightIntervalMinutes must be between 0 and 1440");
    } else if (minutes > 0 && minutes < MIN_INSIGHT_INTERVAL_MINUTES) {
      problems.push(`insightIntervalMinutes must be at least ${MIN_INSIGHT_INTERVAL_MINUTES}, or zero to turn the insight pass off`);
    }
  }
  if (patch.insightResourceTypes !== undefined) {
    // Member by member against RESOURCE_TYPES, exactly as publishKinds is: a
    // mistyped type contributes nothing to every pass afterwards and throws
    // nothing, so the tab simply stays emptier than it should for ever.
    //
    // These are RESOURCE types (NEWS, PAPER), not the claim kinds the tab
    // filters by (launch, funding, …). Both vocabularies are plain strings and
    // neither validates as the other, which is why this check names the list
    // it accepts in the message.
    if (!Array.isArray(patch.insightResourceTypes)) problems.push("insightResourceTypes must be an array");
    else if (patch.insightResourceTypes.length === 0) {
      // Rejected rather than stored: an empty list makes every pass skip with
      // "too little material" while the settings page looks correctly filled
      // in, which is a configuration that reports itself as working.
      problems.push("insightResourceTypes must name at least one type, or the pass reads nothing");
    } else {
      for (const type of patch.insightResourceTypes) {
        if (!RESOURCE_TYPES.includes(type)) problems.push(`insightResourceTypes must be drawn from ${RESOURCE_TYPES.join(", ")}`);
      }
    }
  }
  // Checked rather than coerced, like every other bound here: a value out of
  // range that is quietly clamped is a setting that reports one thing and does
  // another, and this one decides how many pages get fetched per pass.
  if (patch.insightCorroborateClaims !== undefined) {
    const n = Number(patch.insightCorroborateClaims);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      problems.push("insightCorroborateClaims must be a whole number from 0 (off) to 10");
    }
  }
  if (patch.insightChinese !== undefined && typeof patch.insightChinese !== "boolean") {
    problems.push("insightChinese must be true or false");
  }
  // ── 任务 ─────────────────────────────────────────────────────────────
  // Checked key by key, in the feature's own module, for the same reason every
  // bound above is checked rather than coerced — and two of these decide how
  // fast this installation talks to arXiv and to other people's web servers, so
  // a silently clamped value is a promise made to a third party and broken.
  //
  // NOT here, on purpose: the five ceilings and `wallMs`. They are resolved once
  // by `resolveBudget()` at create and read from the mission row thereafter. A
  // ceiling a settings page could move under a running mission is playground's
  // two-dollar rerun with a nicer name.
  problems.push(...validateMissionConfig(patch));
  if (problems.length > 0) return problems;
  for (const key of [
    "feeds", "jobs", "transcriptLanguages", "supadataKey", "collectIntervalMinutes",
    // `publishLastRun` is deliberately absent: it is the schedule's own record
    // of what it did, and a page that could write it could make the timer
    // believe today is already served.
    "publishAt", "publishKinds", "publishSources", "publishMinutes", "publishHosts", "publishMinSources",
    "publishArtifacts", "publishChinese",
    // `insightLastRun` and `insightLastManualRun` are absent for the reason
    // `publishLastRun` is, and it bites harder here: `insightLastRun` carries
    // the watermark, so a page that could write it could tell the pass it had
    // already read rows it never saw. Those rows are never offered again.
    "insightIntervalMinutes", "insightResourceTypes", "insightMaxRows", "insightMaxClusters",
    "insightMaxReconcileCalls", "insightMinIndependent", "insightWindowDays", "insightDormantDays",
    "insightDuplicateBits", "insightChinese", "insightCorroborateClaims", "insightTranscribePerPass",
    // 任务. The whitelist comes from the defaults object, so adding a setting is
    // one edit in one file rather than two that can disagree — the way the three
    // lists above can, and have.
    ...MISSION_SETTING_KEYS,
  ]) {
    if (patch[key] !== undefined) store.setSetting(key, patch[key]);
  }
  return [];
}

/** Characters of resource text handed to the model as grounding context. */
const CONTEXT_MAX_CHARS = 12_000;

/**
 * Characters of transcript or article text carried into one request.
 *
 * The reference caps this at 15,000, which for a one-hour podcast is under
 * half the words: ask about the second half and the assistant cannot answer,
 * with nothing in the reply admitting why. That cap was set for a smaller
 * context window than the routed model has, so it is not inherited — the whole
 * transcript is sent whenever it fits, and only a genuinely long one degrades.
 */
const TRANSCRIPT_BUDGET_CHARS = 48_000;

/** Share of the budget spent on verbatim text around the playback position. */
const WINDOW_SHARE = 0.6;

/**
 * Fit a timed transcript into the budget without losing the whole shape.
 *
 * Under budget the transcript goes in complete. Over budget, truncating at the
 * front would leave the model blind to everything after the cut, so the budget
 * is split instead: verbatim lines around wherever the reader is, plus an
 * evenly-sampled skim of the entire recording so the model still knows what
 * the rest covers and can say when something falls outside what it was given.
 * @param lines - `[m:ss] text` lines in order.
 * @param currentTime - playback position in seconds, when known.
 * @param cues - the cues the lines came from, for locating the position.
 * @returns `{ text, complete }`.
 */
export function fitTranscript(lines, currentTime, cues) {
  const whole = lines.join("\n");
  if (whole.length <= TRANSCRIPT_BUDGET_CHARS) return { text: whole, complete: true };

  const windowBudget = Math.floor(TRANSCRIPT_BUDGET_CHARS * WINDOW_SHARE);
  const position = Number.isFinite(currentTime) ? currentTime : 0;
  let centre = cues.findIndex((cue) => Number(cue.start) >= position);
  if (centre < 0) centre = 0;

  // Grow outwards from the reader's position until the window budget is spent.
  let first = centre;
  let last = centre;
  let used = lines[centre]?.length ?? 0;
  while (used < windowBudget && (first > 0 || last < lines.length - 1)) {
    if (first > 0) {
      first -= 1;
      used += lines[first].length + 1;
    }
    if (used < windowBudget && last < lines.length - 1) {
      last += 1;
      used += lines[last].length + 1;
    }
  }
  const windowText = lines.slice(first, last + 1).join("\n");

  // Spend what is left on a skim of the whole, so no region is invisible.
  const skimBudget = TRANSCRIPT_BUDGET_CHARS - windowText.length;
  const step = Math.max(1, Math.ceil(whole.length / Math.max(1, skimBudget)));
  const skim = lines.filter((_, index) => index % step === 0).join("\n").slice(0, skimBudget);

  return {
    text: [
      "Skim of the whole recording (every few lines, so nothing is invisible):",
      skim,
      "",
      "Verbatim around the reader's position:",
      windowText,
    ].join("\n"),
    complete: false,
  };
}

/** Format a playback offset as `m:ss`, matching the transcript's own labels. */
function formatOffset(seconds) {
  const total = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, "0")}`;
}

/**
 * Assemble the grounding context for one resource.
 *
 * The upstream builds this with an `AIContextBuilder`; the fields it feeds the
 * model are reproduced here from the stored row, bounded so a long article
 * cannot crowd out the question.
 * @param row - a stored `Resource`.
 * @returns the context block, or an empty string when the row is unknown.
 */
export function buildResourceContext(row, extras = {}) {
  if (row == null) return "";
  const lines = [`# ${row.title}`];
  if (typeof row.type === "string") lines.push(`Type: ${row.type}`);
  if (typeof row.publishedAt === "string") lines.push(`Published: ${row.publishedAt}`);
  if (typeof row.sourceUrl === "string") lines.push(`URL: ${row.sourceUrl}`);
  const authors = Array.isArray(row.authors)
    ? row.authors.map((author) => author?.name ?? author?.username).filter(Boolean)
    : [];
  if (authors.length > 0) lines.push(`Authors: ${authors.join(", ")}`);
  const categories = Array.isArray(row.categories) ? row.categories : [];
  if (categories.length > 0) lines.push(`Categories: ${categories.join(", ")}`);
  if (typeof row.qualityScore === "string" || typeof row.qualityScore === "number") {
    lines.push(`Quality score: ${row.qualityScore}`);
  }
  // A video's transcript IS its content: a YouTube row carries no abstract and
  // no summary, so a context built from the stored fields alone hands the model
  // nothing but a title and leaves it unable to answer anything. The reference
  // feeds the timed transcript for exactly this reason, with the playback
  // position alongside it so "what are they saying now" has an answer.
  const transcript = extras.transcript;
  if (transcript !== undefined && Array.isArray(transcript.cues) && transcript.cues.length > 0) {
    if (Number.isFinite(extras.currentTime)) {
      lines.push(`Current playback position: ${formatOffset(extras.currentTime)}`);
    }
    const timed = transcript.cues.map((cue) => `[${formatOffset(cue.start)}] ${cue.text}`);
    const fitted = fitTranscript(timed, extras.currentTime, transcript.cues);
    // Say which it is. A model told it holds the complete transcript answers
    // confidently; one told it holds an excerpt can say what it cannot see,
    // instead of inventing the part that was cut.
    lines.push("", fitted.complete ? "Transcript (complete):" : "Transcript (excerpt — not the full recording):", fitted.text);
  } else if (transcript !== undefined && typeof transcript.text === "string" && transcript.text !== "") {
    const text = transcript.text;
    const complete = text.length <= TRANSCRIPT_BUDGET_CHARS;
    lines.push("", complete ? "Transcript (complete):" : "Transcript (excerpt — not the full recording):", text.slice(0, TRANSCRIPT_BUDGET_CHARS));
  }

  if (typeof extras.article === "string" && extras.article.trim() !== "") {
    const article = extras.article;
    const complete = article.length <= TRANSCRIPT_BUDGET_CHARS;
    lines.push("", complete ? "Article text (complete):" : "Article text (excerpt):", article.slice(0, TRANSCRIPT_BUDGET_CHARS));
  }

  const body = [row.aiSummary, row.abstract, row.content]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .join("\n\n");
  if (body !== "") lines.push("", body.slice(0, CONTEXT_MAX_CHARS));
  return lines.join("\n");
}

/** System prompt shared by the chat and the quick actions. */
const SYSTEM_PROMPT = [
  "You are the reading assistant of a source library.",
  "Answer only from the supplied source; when it does not contain the answer, say so plainly instead of guessing.",
  "Be concrete and brief. Reply in the language the user writes in.",
].join(" ");

/** Quick actions the detail view offers, each a fixed instruction. */
const QUICK_ACTIONS = {
  summary: "Summarise this source in at most five sentences.",
  insights: "List the three to five most consequential claims this source makes. One line each, no preamble.",
  methodology: "Describe how this source reached its conclusions: method, data, and the limits it acknowledges. If it states none, say so.",
};

/**
 * Build the streaming chat entry point over the harness's own model runtime.
 *
 * The upstream's assistant is not reusable here: its endpoint requires a
 * signed-in account and the service is being retired. The harness already
 * routes a model, so the assistant runs on that instead — which also means the
 * library keeps working after the upstream is gone.
 * @param ctx - Cordis context carrying `llm` and `agentDefaultModel`.
 * @returns an async generator factory yielding text deltas.
 */
export function createChat(ctx) {
  return async function* chat({ prompt, context }) {
    // `agentDefaultModel` exposes the selection through a method, not as
    // fields: the settings document can replace it between calls, so it is
    // read per request rather than captured at registration.
    const route = ctx.agentDefaultModel.currentSelection();
    const messages = [{
      id: `swarm-${Date.now()}`,
      role: "user",
      content: [{ type: "text", text: context === "" ? prompt : `${context}\n\n---\n\n${prompt}` }],
      source: { kind: "user" },
    }];
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      system: SYSTEM_PROMPT,
      messages,
    });
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") { yield { text: chunk.text }; continue; }
      if (chunk.type !== "finish") continue;

      // ONLY `aborted` AND `error` ARE FAILURES. This branch used to read
      // `kind !== "stop"`, which reports every other ending as an outage.
      // `max-tokens` is the one that actually reaches a user here: a long
      // answer runs to the output cap, the reader has the prose in front of
      // them, and the page appends a red error under it saying the model call
      // failed. It did not fail — it was truncated, and the honest thing is to
      // say so once, after the text, rather than to discard the answer's
      // standing. `tool-calls` cannot arise on this seam today because the
      // reading assistant is given no tools, but it is the NORMAL end of an
      // acting turn and must never be an error if tools are ever added here.
      const kind = chunk.reason?.kind;
      if (kind === "aborted" || kind === "error") {
        const failure = chunk.reason?.failure;
        yield { error: failure?.message ?? kind ?? "model call failed" };
      } else if (kind === "max-tokens") {
        yield { truncated: true };
      }
    }
  };
}

/**
 * Stream one chat response as Server-Sent Events.
 *
 * The wire format matches the upstream's (`data: {"content"}` lines closed by
 * `data: [DONE]`) so the browser half has one parser regardless of which
 * backend answered.
 * @param res - the response this handler owns.
 * @param chat - the chat entry point.
 * @param request - `{ prompt, context }`.
 */
async function streamChat(res, chat, request) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (payload) => { res.write(`data: ${JSON.stringify(payload)}\n\n`); };
  try {
    for await (const piece of chat(request)) {
      if (piece.error !== undefined) send({ error: piece.error });
      // A truncation is not an outage. The reader already has everything above
      // it, so this is a note appended to a real answer rather than a red box
      // replacing one — `{content}` keeps the browser's one parser unchanged.
      else if (piece.truncated === true) send({ content: "\n\n[truncated: the model reached its output limit]" });
      else if (piece.text !== undefined) send({ content: piece.text });
    }
  } catch (cause) {
    send({ error: String(cause?.message ?? cause) });
  } finally {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

/** Read and parse a JSON request body, bounded. */
async function readJson(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Build the request handler over one open store.
 * @param store - the source library.
 * @param logger - something with `.info` / `.warn`; the Cordis logger fits.
 * @param chat - streaming chat entry point, or undefined when no model is routed.
 * @returns the node:http handler.
 */
export function createHandler(store, logger, chat, web, ctx, missions) {
  // The publish surface is a separate module because it is a different
  // subject with its own lifecycle — a render is a job, not a request — and
  // folding forty lines of job bookkeeping into this router would bury the
  // library routes it sits beside.
  const publish = createPublishRoutes({ store, chat, logger, sendJson, readJson });
  // 洞察 sits beside it, same dependencies, same shape of answer. Building it
  // here also runs its DDL here, so a broken statement fails while the plugin
  // is loading rather than the first time somebody opens a tab.
  // `web` is the optional search seam, passed in by `apply` because THAT is
  // where a Cordis context exists. Resolving it here reached for a `ctx` this
  // function has never had — the plugin then failed to load entirely, with 122
  // green tests, which is the shape of failure this repository specialises in.
  // `transcribe` for the same reason `web` is here: the routes file is a pure
  // HTTP face over the store and the pass, and a network client of its own
  // would be a second place this plugin reaches the internet from.
  const insight = createInsightRoutes({
    store, chat, logger, sendJson, readJson, web,
    transcribe: insightTranscriber(store),
  });

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.slice(ROUTE_PREFIX.length) || "/";
    const query = url.searchParams;


    if (path.startsWith("/publish/") && await publish(req, res, path)) return;
    // Every insight route carries a second segment, because `"/insights"`
    // does not start with `"/insights/"`: a bare route would 404 while the
    // handler that answers it sat registered, loaded and never reached.
    // Adding one later means widening this condition in the same commit.
    if (path.startsWith("/insights/") && await insight(req, res, path)) return;
    // 任务, beside the other two and with the same second-segment rule: a bare
    // `/missions` would 404 because `"/missions".startsWith("/missions/")` is
    // false, and widening this condition is part of adding such a route, not a
    // follow-up. `missions` is undefined on a host that proxies its library —
    // that machine runs no missions at all, and the proxy handler answers this
    // prefix long before the router does. See `apply`.
    if (missions !== undefined && path.startsWith("/missions/") && await missions(req, res, path)) return;

    // ── what this host is running ───────────────────────────────────────
    // Two halves of this plugin can be different versions: the page is served
    // by the machine you opened, and `/swarm-api` may be proxied to another.
    // They drifted three times in one afternoon of deployments here, each time
    // presenting as a feature that was written, deployed, and apparently
    // absent. Naming both versions is the cheapest possible fix.
    if (req.method === "GET" && path === "/version") {
      sendJson(res, 200, {
        success: true,
        data: {
          version: PLUGIN_VERSION,
          // A release and a checkout both say 0.1.0 while being different
          // code — the number is bumped at release and everything between two
          // releases shares it. The channel is what distinguishes them.
          channel: PLUGIN_CHANNEL,
          commit: PLUGIN_COMMIT,
          label: versionLabel(),
          // Reported so the channel verdict can be checked rather than
          // trusted: it is inferred from this path.
          dir: PLUGIN_DIR,
          node: process.versions.node,
          // Whether this host owns the library or forwards to one. A proxy
          // answers this route itself, so a mismatch is legible from the page.
          library: "local",
          // And where it is. The page had no way to say which machine holds
          // the data — the one setting that decides it lives in a file and an
          // environment variable, neither of which anybody looking at the
          // screen can see. A box proxying to a box that has gone down looked
          // exactly like a box with an empty library.
          libraryPath: storePath(),
        },
      });
      return;
    }

    // ── reads ───────────────────────────────────────────────────────────
    if (req.method === "GET" && path === "/resources") {
      const page = store.query({
        type: query.get("type") ?? undefined,
        search: query.get("search") ?? undefined,
        sortBy: query.get("sortBy") ?? undefined,
        take: Number(query.get("take") ?? 20),
        skip: Number(query.get("skip") ?? 0),
      });
      // The envelope matches the upstream's so the browser half has one shape
      // to parse whichever medium answered.
      sendJson(res, 200, {
        success: true,
        data: { data: page.rows, pagination: { total: page.total, skip: Number(query.get("skip") ?? 0), take: page.rows.length, hasMore: page.hasMore } },
      });
      return;
    }

    if (req.method === "GET" && path === "/resources/search/suggestions") {
      sendJson(res, 200, { success: true, data: store.suggest(query.get("q") ?? "", Number(query.get("limit") ?? 8)) });
      return;
    }

    if (req.method === "GET" && path === "/resources/sources/facets") {
      sendJson(res, 200, { success: true, data: { sources: store.facets(Number(query.get("limit") ?? 20)) } });
      return;
    }

    if (req.method === "GET" && path === "/stats") {
      sendJson(res, 200, {
        success: true,
        data: { total: store.count(), byType: store.countsByType(), database: storePath() },
      });
      return;
    }

    if (req.method === "GET" && path.startsWith("/resources/")) {
      const id = decodeURIComponent(path.slice("/resources/".length));
      const row = store.get(id);
      if (row === undefined) {
        sendJson(res, 404, { success: false, error: "no such resource" });
        return;
      }
      sendJson(res, 200, { success: true, data: row });
      return;
    }

    // ── assistant ───────────────────────────────────────────────────────
    if (req.method === "POST" && (path === "/chat" || path === "/quick-action")) {
      if (chat === undefined) {
        sendJson(res, 503, { success: false, error: "no model routed" });
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }
      const row = typeof body.resourceId === "string" ? store.get(body.resourceId) : undefined;
      const prompt = path === "/quick-action"
        ? QUICK_ACTIONS[body.action]
        : typeof body.message === "string" ? body.message : undefined;
      if (prompt === undefined || prompt.trim() === "") {
        sendJson(res, 400, { success: false, error: "empty prompt" });
        return;
      }
      // Everything the library already holds about this source goes in: the
      // cached transcript for a video, the extracted article for a page. An
      // assistant beside a video that cannot see the captions can only answer
      // from the title, which is what made it useless.
      const extras = { currentTime: Number(body.currentTime) };
      const transcript = store.getTranscript(row.id);
      if (transcript !== undefined) extras.transcript = transcript;
      if (extras.transcript === undefined && displayModeOf(row) === "html") {
        const url = documentUrlOf(row);
        if (url !== "" && admissibleUrl(url) !== undefined) {
          try {
            const fetched = await fetchDocument(url);
            if (fetched.status < 400) {
              try {
                extras.article = (await readArticle(fetched.body.toString("utf8"), url)).text;
              } catch {
                extras.article = readableText(fetched.body.toString("utf8")).text;
              }
            }
          } catch {
            // An unreachable page is not fatal: the model still gets the row's
            // own fields, and the answer says what it could not see.
          }
        }
      }
      await streamChat(res, chat, { prompt, context: buildResourceContext(row, extras) });
      return;
    }

    // ── configuration ───────────────────────────────────────────────────
    if (req.method === "GET" && path === "/config") {
      const config = readConfig(store);
      // The key is write-only over the wire: the settings page needs to know
      // whether one is set, never what it is.
      sendJson(res, 200, {
        success: true,
        data: {
          feeds: config.feeds,
          jobs: config.jobs,
          transcriptLanguages: config.transcriptLanguages,
          collectIntervalMinutes: config.collectIntervalMinutes,
          // WHETHER ONE IS SET, NEVER WHAT IT IS — and now also HOW MANY.
          // The setting holds a list, so "configured" is no longer the whole
          // of what the page needs to say: a person who pasted four keys and
          // sees only 已配置 cannot tell that one of them was dropped by a
          // stray character in the paste. The count is not a secret; the keys
          // are, and they are still not sent.
          supadataKeySet: supadataKeys(config.supadataKey).length > 0,
          supadataKeyCount: supadataKeys(config.supadataKey).length,
          collectors: Object.keys(COLLECTORS),
          resourceTypes: RESOURCE_TYPES,
        },
      });
      return;
    }

    if (req.method === "PUT" && path === "/config") {
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }
      const problems = writeConfig(store, body);
      if (problems.length > 0) {
        sendJson(res, 400, { success: false, error: problems.join("; ") });
        return;
      }
      sendJson(res, 200, { success: true, data: { saved: true } });
      return;
    }

    // ── transcripts ─────────────────────────────────────────────────────
    if (req.method === "POST" && path === "/transcript") {
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }
      const row = typeof body.resourceId === "string" ? store.get(body.resourceId) : undefined;
      if (row === undefined) {
        sendJson(res, 404, { success: false, error: "no such resource" });
        return;
      }
      // A cache entry with no cues predates the timed-segment column, and the
      // reader needs timestamps to seek. An incomplete entry is a miss, not a
      // hit — serving it would show the panel an empty transcript.
      const stored = body.refresh === true ? undefined : store.getTranscript(row.id);
      const cached = stored !== undefined && Array.isArray(stored.cues) && stored.cues.length > 0 ? stored : undefined;
      if (cached !== undefined) {
        sendJson(res, 200, { success: true, data: { ...cached, via: "cache" } });
        return;
      }
      const videoId = videoIdOf(row.sourceUrl);
      if (videoId === undefined) {
        sendJson(res, 400, { success: false, error: "not a YouTube source" });
        return;
      }
      const config = readConfig(store);
      try {
        const result = await resolveTranscript(videoId, {
          apiKey: config.supadataKey,
          gensBase: seedBase(),
          languages: config.transcriptLanguages,
        });
        store.putTranscript(row.id, result.language, result.text, result.cues ?? []);
        sendJson(res, 200, { success: true, data: { language: result.language, text: result.text, cues: result.cues ?? [], via: result.via } });
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    // ── video description ───────────────────────────────────────────────
    //
    // A row collected from a feed carries a title and nothing else, so the
    // detail page had nothing to say about a video and the assistant had
    // nothing to read. The uploader's own description is on the watch page the
    // caption lookup already fetches, and it is written back into the row's
    // `abstract` — the column is empty for every video — so the card, the
    // reader, and the model all gain it at once instead of it living in a
    // side-table only this page knows about.
    if (req.method === "POST" && path === "/video-info") {
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }
      const row = typeof body.resourceId === "string" ? store.get(body.resourceId) : undefined;
      if (row === undefined) {
        sendJson(res, 404, { success: false, error: "no such resource" });
        return;
      }
      const held = typeof row.abstract === "string" ? row.abstract.trim() : "";
      // A long description with no line break in it was flattened on the way
      // in — the feed parser used to collapse all whitespace, which destroyed
      // the chapter index and every list. Those rows cannot heal on their own,
      // because a stored description is exactly what stops this route from
      // looking again, so recognising the damage is the only way back.
      const flattened = held.length > 400 && !held.includes("\n");
      const stale = held !== "" && !flattened;
      if (stale && body.refresh !== true) {
        sendJson(res, 200, { success: true, data: { description: row.abstract, via: "stored" } });
        return;
      }
      const videoId = videoIdOf(row.sourceUrl);
      if (videoId === undefined) {
        sendJson(res, 400, { success: false, error: "not a YouTube source" });
        return;
      }
      try {
        const details = await fetchVideoDetails(videoId);
        // THE LENGTH RIDES ALONG, because this request already paid for it.
        //
        // `fetchVideoDetails` returns `lengthSeconds` whether or not anybody
        // asked, and this route is hit whenever a reader opens a video whose
        // description was never stored — which is most of the back catalogue,
        // collected before `duration_seconds` existed. So opening an old video
        // backfills its length for free, and the column fills in over use
        // rather than needing a sweep that re-fetches thousands of watch pages.
        //
        // `put` COALESCEs the column, so a details call that came back without
        // a length cannot erase one already known.
        const seconds = Number(details?.lengthSeconds);
        store.put({
          ...row,
          abstract: details.description,
          ...(Number.isFinite(seconds) && seconds > 0 ? { durationSeconds: seconds } : {}),
        });
        sendJson(res, 200, { success: true, data: { ...details, via: "watch-page" } });
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    // ── notes ───────────────────────────────────────────────────────────
    if (req.method === "GET" && path === "/notes") {
      sendJson(res, 200, { success: true, data: { notes: store.listNotes(query.get("resourceId") ?? "") } });
      return;
    }

    if (req.method === "POST" && path === "/notes") {
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (typeof body.resourceId !== "string" || text === "") {
        sendJson(res, 400, { success: false, error: "resourceId and a non-empty body are required" });
        return;
      }
      sendJson(res, 200, { success: true, data: store.addNote(body.resourceId, text, Number(body.atSeconds)) });
      return;
    }

    if (req.method === "DELETE" && path === "/notes") {
      const removed = store.deleteNote(query.get("id") ?? "");
      sendJson(res, removed ? 200 : 404, { success: removed, ...(removed ? { data: { deleted: true } } : { error: "no such note" }) });
      return;
    }

    // ── document proxy ──────────────────────────────────────────────────
    //
    // A browser cannot frame a third-party PDF or page: the origin refuses the
    // cross-origin read, or answers X-Frame-Options and the frame stays blank.
    // Relaying the bytes from this origin removes the boundary, and the page
    // builds a same-origin blob URL from them.
    if (req.method === "GET" && (path === "/proxy/pdf" || path === "/proxy/html" || path === "/proxy/reader")) {
      const target = admissibleUrl(query.get("url") ?? "");
      if (target === undefined) {
        sendJson(res, 400, { success: false, error: "url must be a public http(s) address" });
        return;
      }
      try {
        const document = await fetchDocument(target.toString());
        if (document.status >= 400) {
          sendJson(res, 502, { success: false, error: `upstream answered HTTP ${document.status}` });
          return;
        }
        if (path === "/proxy/reader") {
          try {
            const article = await readArticle(document.body.toString("utf8"), target.toString());
            sendJson(res, 200, { success: true, data: article });
          } catch (cause) {
            // The tag-stripping reader is kept as the fallback: Readability
            // declines a page that is a listing rather than an article, and
            // rough text still beats an empty panel.
            const rough = readableText(document.body.toString("utf8"));
            if (rough.text.length < 200) {
              sendJson(res, 422, { success: false, error: String(cause?.message ?? cause) });
              return;
            }
            sendJson(res, 200, { success: true, data: { ...rough, markdown: "", degraded: true } });
          }
          return;
        }
        res.writeHead(200, {
          "content-type": path === "/proxy/pdf" ? "application/pdf" : document.contentType,
          "content-length": document.body.byteLength,
          "cache-control": "private, max-age=3600",
        });
        res.end(document.body);
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    // ── browser-assisted transcripts ────────────────────────────────────
    //
    // The server can read the watch page and extract a signed caption URL, but
    // fetching that URL from a server returns an empty body; a browser fetching
    // the same URL gets the captions, because the endpoint grants the page
    // origin CORS with credentials and the visitor's own YouTube session comes
    // along. These two routes are the halves of that split, and they are what
    // keeps new videos readable once the retiring upstream is gone.
    if (req.method === "GET" && path === "/transcript/tracks") {
      const videoId = query.get("videoId") ?? "";
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        sendJson(res, 400, { success: false, error: "videoId must be an 11-character YouTube id" });
        return;
      }
      try {
        sendJson(res, 200, { success: true, data: { tracks: await listCaptionTracks(videoId) } });
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    if (req.method === "POST" && path === "/transcript/ingest") {
      let body;
      try {
        body = await readJson(req, 4 * 1024 * 1024);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }
      const row = typeof body.resourceId === "string" ? store.get(body.resourceId) : undefined;
      if (row === undefined) {
        sendJson(res, 404, { success: false, error: "no such resource" });
        return;
      }
      try {
        const parsed = transcriptFromXml(String(body.xml ?? ""), String(body.language ?? "unknown"));
        store.putTranscript(row.id, parsed.language, parsed.text, parsed.cues ?? []);
        logger?.info?.(`swarm: stored a browser-fetched transcript for ${row.id}`);
        sendJson(res, 200, { success: true, data: { language: parsed.language, text: parsed.text, cues: parsed.cues ?? [], via: "browser" } });
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    // ── collection log ──────────────────────────────────────────────────
    if (req.method === "GET" && path === "/collect/status") {
      const log = store.getSetting("collectionLog", []);
      const runs = Array.isArray(log) ? log : [];
      const minutes = Number(readConfig(store).collectIntervalMinutes ?? 0);
      const last = runs[0];
      sendJson(res, 200, {
        success: true,
        data: {
          intervalMinutes: minutes,
          // The timer counts from process start, not from the wall clock, so
          // the next run is the last one plus the interval — not the top of
          // the next hour.
          nextExpectedAt: minutes > 0 && last !== undefined
            ? new Date(Date.parse(last.startedAt) + minutes * 60_000).toISOString()
            : null,
          runs,
        },
      });
      return;
    }

    // ── image relay ─────────────────────────────────────────────────────
    //
    // A site that serves its own `og:image` will often refuse it when the
    // request comes from another page — Microsoft Research answered 403 to a
    // direct fetch of the very image its own page advertises. Fetching it
    // server-side carries no page origin to refuse, so the picture arrives.
    // The page only comes here after the direct load has failed, so a site
    // that permits hotlinking is never routed through here.
    if (req.method === "GET" && path === "/proxy/image") {
      const target = admissibleUrl(query.get("url") ?? "");
      if (target === undefined) {
        sendJson(res, 400, { success: false, error: "unusable image URL" });
        return;
      }
      try {
        const upstream = await fetchDocument(target.toString());
        if (upstream.status >= 400 || !upstream.contentType.startsWith("image/")) {
          // 404 rather than a placeholder pixel: the page's own error handler
          // has to fire so the type icon can take over. A 200 with a 1×1
          // transparent PNG is what the reference used to return, and it
          // silently broke every fallback it had.
          sendJson(res, 404, { success: false, error: "not an image" });
          return;
        }
        res.writeHead(200, {
          "content-type": upstream.contentType,
          "content-length": upstream.body.byteLength,
          "cache-control": "public, max-age=86400",
        });
        res.end(upstream.body);
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    // ── thumbnail for one row, on demand ────────────────────────────────
    //
    // The page asks for this when a card it is about to show has no image.
    // Doing it on demand is what makes the cost proportional to what is
    // actually looked at: a library of twenty thousand rows would otherwise
    // mean twenty thousand requests to other people's sites for images nobody
    // ever sees. The answer is stored, so a row is paid for once.
    if (req.method === "GET" && path === "/thumbnail-for") {
      const row = store.get(query.get("resourceId") ?? "");
      if (row === undefined) {
        sendJson(res, 404, { success: false, error: "no such resource" });
        return;
      }
      const existing = typeof row.thumbnailUrl === "string" ? row.thumbnailUrl : "";
      if (existing !== "") {
        sendJson(res, 200, { success: true, data: { url: existing, via: "stored" } });
        return;
      }
      if (!ENRICHABLE_TYPES.includes(row.type)) {
        // Papers and videos are deliberately not scraped: see enrich.js.
        sendJson(res, 200, { success: true, data: { url: "", via: "skipped" } });
        return;
      }
      if (store.thumbnailChecked(row.id)) {
        // Already looked at, and there was nothing. Fetching again would ask
        // the same site the same question and get the same answer.
        sendJson(res, 200, { success: true, data: { url: "", via: "checked" } });
        return;
      }
      try {
        const found = await imageForPage(row.sourceUrl);
        const shared = found !== "" && store.countThumbnailUse(found) >= 2;
        store.markThumbnailChecked(row.id, shared ? "" : found);
        sendJson(res, 200, {
          success: true,
          data: { url: shared ? "" : found, via: shared ? "site-wide" : found === "" ? "none" : "page" },
        });
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    // ── thumbnail backfill ──────────────────────────────────────────────
    //
    // Resumable by construction: every row looked at is marked, so calling
    // this repeatedly walks the backlog rather than repeating the front of it.
    // `limit` is per call so a caller decides how much of the outside world to
    // bother in one go.
    if (req.method === "POST" && path === "/enrich-thumbnails") {
      let body = {};
      try {
        body = await readJson(req);
      } catch {
        // An empty body is a valid request for the default batch.
      }
      const requested = Number(body.limit);
      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(2000, Math.floor(requested)) : DEFAULT_ENRICH_LIMIT;
      try {
        sendJson(res, 200, { success: true, data: await enrichThumbnails(store, { limit, logger }) });
      } catch (cause) {
        sendJson(res, 500, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    // ── locally held thumbnails ─────────────────────────────────────────
    //
    // The upstream stores paper thumbnails in R2 and hands out 7-day SigV4
    // presigned URLs. A migrated library therefore carries links that expire
    // a week after the migration and cannot be re-signed without the bucket's
    // credentials, which we do not have. The images were copied beside the
    // database instead, and this route serves them from there — so the
    // library stays whole on its own, which is the entire point of migrating
    // it off a service that is being retired.
    if (req.method === "GET" && path.startsWith("/thumbnail/")) {
      const id = decodeURIComponent(path.slice("/thumbnail/".length));
      // The id is a path segment, so a traversal attempt has to be refused
      // rather than normalised: `..` here would read outside the store.
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        sendJson(res, 400, { success: false, error: "malformed thumbnail id" });
        return;
      }
      const file = join(thumbnailDir(), `${id}.jpg`);
      if (!existsSync(file)) {
        sendJson(res, 404, { success: false, error: "no such thumbnail" });
        return;
      }
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": body.byteLength,
        // Immutable: the file is named by a resource id and is only ever
        // replaced wholesale.
        "cache-control": "public, max-age=604800, immutable",
      });
      res.end(body);
      return;
    }

    // ── transcript translation ──────────────────────────────────────────
    if (req.method === "GET" && path === "/transcript/translation") {
      const resourceId = query.get("resourceId") ?? "";
      const lang = query.get("lang") ?? "";
      if (!isSupportedLanguage(lang)) {
        sendJson(res, 400, { success: false, error: `unsupported target language: ${lang}` });
        return;
      }
      sendJson(res, 200, {
        success: true,
        data: { lang, rows: store.getTranslations(resourceId, lang) },
      });
      return;
    }

    if (req.method === "POST" && path === "/transcript/translate") {
      if (chat === undefined) {
        sendJson(res, 503, { success: false, error: "no model routed" });
        return;
      }
      let body;
      try {
        body = await readJson(req, 1024 * 1024);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }
      const row = typeof body.resourceId === "string" ? store.get(body.resourceId) : undefined;
      if (row === undefined) {
        sendJson(res, 404, { success: false, error: "no such resource" });
        return;
      }
      const lang = String(body.lang ?? "");
      if (!isSupportedLanguage(lang)) {
        sendJson(res, 400, { success: false, error: `unsupported target language: ${lang}` });
        return;
      }
      const blocks = Array.isArray(body.blocks) ? body.blocks : [];
      const batch = blocks
        .filter((entry) => typeof entry?.start === "number" && typeof entry?.text === "string" && entry.text.trim() !== "")
        .slice(0, BATCH_SIZE)
        .map((entry, index) => ({ index, start: entry.start, text: entry.text.trim() }));
      if (batch.length === 0) {
        sendJson(res, 400, { success: false, error: "no blocks to translate" });
        return;
      }
      try {
        const rows = await translateBatch(chat, batch, lang);
        // Persisted per batch rather than at the end of the run: a reader who
        // closes the panel mid-way keeps what was already paid for, and the
        // next pass asks only for what is still missing.
        store.putTranslations(row.id, lang, rows);
        sendJson(res, 200, { success: true, data: { lang, rows, requested: batch.length } });
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    // ── collect ─────────────────────────────────────────────────────────
    if (req.method === "POST" && path === "/collect") {
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }
      // The full run goes through `collectOnce`, the same path the timer
      // takes. It had a second copy of the loop here, and the copies had
      // already drifted: only one of them recorded the run, so pressing
      // Collect left no entry in the log it was meant to fill.
      const results = Array.isArray(body.jobs) && body.jobs.length > 0
        ? await runJobs(store, body.jobs)
        : await collectOnce(store, logger);
      sendJson(res, 200, { success: true, data: { results, total: store.count() } });
      return;
    }

    if (req.method === "GET" && path === "/collectors") {
      sendJson(res, 200, { success: true, data: { collectors: Object.keys(COLLECTORS), defaults: DEFAULT_JOBS } });
      return;
    }

    // ── seed ────────────────────────────────────────────────────────────
    if (req.method === "POST" && path === "/seed") {
      const requested = query.get("type");
      const types = requested === null || requested === "" ? RESOURCE_TYPES : [requested];
      const base = seedBase();
      const rawMax = query.get("max");
      const max = rawMax === null ? SEED_MAX_PER_TYPE : Math.max(0, Number(rawMax) || 0);
      const results = [];
      for (const type of types) {
        try {
          results.push(await seedType(store, type, base, max));
        } catch (cause) {
          results.push({ type, error: String(cause?.message ?? cause) });
        }
      }
      const written = results.reduce((sum, row) => sum + (row.written ?? 0), 0);
      logger?.info?.(`swarm: seeded ${written} row(s) from ${base}`);
      sendJson(res, 200, { success: true, data: { upstream: base, results, total: store.count() } });
      return;
    }

    sendJson(res, 404, { success: false, error: `no such route: ${req.method} ${path}` });
  };
}

/**
 * The boot sweep, and the separate question of whether to pick anything back up.
 *
 * TWO DECISIONS, DELIBERATELY NOT ONE:
 *
 * The sweep ALWAYS runs. Every mission still `running` under a different boot id
 * is orphaned by definition — in one process no other owner can exist — so it is
 * one synchronous query with no threshold, no grace period and zero false
 * positives, and each row is moved out of `running` with `runtime_crashed` and a
 * checkpoint left behind for resume. Skipping it would leave rows that claim to
 * be working while nothing is, which is the state the whole liveness apparatus
 * exists to make impossible.
 *
 * AUTO-RESUME DOES NOT, unless `missionAutoResume` is on, and it ships off. A
 * plugin process restarts on a settings change and on a harness auto-update, not
 * only on a crash — so a `deep` mission with a 4M-token ceiling would otherwise
 * silently resume, unattended, on every restart, and each restart would start it
 * again. Resume is OFFERED (the mission list shows it, `/resume` takes it); it is
 * not taken on the machine's own initiative.
 *
 * @param runtime - the mission runner.
 * @param config - the plugin configuration.
 * @param logger - Cordis logger.
 * @returns `{ swept, resumed, refused }` — never a silent nothing.
 */
export function sweepMissionsOnBoot(runtime, config, logger) {
  const result = runtime.sweep();
  if (!result.claimed) {
    // Refused, not resolved. Another live harness owns this library file, and
    // reclaiming its missions would abort work that is genuinely running.
    logger?.warn?.(`swarm: not sweeping missions — ${result.reason}`);
    return { swept: [], resumed: [], refused: result.reason };
  }
  for (const row of result.swept) {
    logger?.info?.(`swarm: mission ${row.missionId} ${row.outcome}: ${row.reason}`);
  }

  const resumed = [];
  if (config.missionAutoResume === true) {
    for (const row of result.swept) {
      if (row.outcome !== "resumable") continue;
      const started = runtime.claim(row.missionId);
      // Reported either way. A resume that quietly did not happen is
      // indistinguishable from a resume that is broken.
      if (started.started) resumed.push(row.missionId);
      else logger?.warn?.(`swarm: auto-resume declined ${row.missionId}: ${started.reason}`);
    }
    if (resumed.length > 0) logger?.info?.(`swarm: auto-resumed ${resumed.length} mission(s): ${resumed.join(", ")}`);
  } else if (result.swept.some((row) => row.outcome === "resumable")) {
    const waiting = result.swept.filter((row) => row.outcome === "resumable").length;
    logger?.info?.(`swarm: ${waiting} mission(s) can be resumed from the mission list; missionAutoResume is off, so nothing was restarted on its own`);
  }
  return { swept: result.swept, resumed, refused: null };
}

/** Required services: the HTTP carrier, the model runtime, and the default route. */
export const inject = ["webServer", "llm", "agentDefaultModel", "tools"];

/**
 * Open the library and claim the API prefix for as long as this plugin is
 * active.
 * @param ctx - Cordis context carrying the web server service.
 */
export function apply(ctx) {
  // Proxy mode short-circuits everything below. Deliberately first and
  // deliberately total: a machine serving someone else's library must not open
  // a database of its own, and must not run the timers. Two collectors would
  // fetch all 72 feeds twice into two diverging libraries.
  //
  // MISSIONS ARE PART OF "EVERYTHING BELOW". A machine that proxies has no
  // mission tables, no boot id and no runner: it forwards `/swarm-api/missions/*`
  // to the machine that owns the library, exactly as it forwards every other
  // route. That is not an optimisation — a second runner over a database it does
  // not own would claim a boot id, sweep the owner's live missions as orphans
  // and finalize them mid-flight. Which machine owns the library is a decision,
  // not something to detect.
  const library = resolveLibrary(process.env, homedir());
  if (library.kind === "remote") {
    ctx.logger?.info?.(`swarm: proxying the source library from ${library.base}; no missions run on this host`);
    const disposeProxy = ctx.webServer.register({
      kind: "prefix",
      path: ROUTE_PREFIX,
      handler: createProxyHandler(library.base, ctx.logger, ROUTE_PREFIX),
    });
    ctx.on("dispose", disposeProxy);
    return;
  }

  const path = library.path;
  const store = new SourceStore(path);
  // The 洞察 tables are created here, over the library's own handle — one
  // file, one connection, one WAL. Opened with the store rather than lazily on
  // the first request so a DDL that cannot run is a stack trace at start-up
  // rather than an empty tab a week later; `openInsightStore` memoises, so the
  // routes below get this same instance.
  const insightStore = openInsightStore(store);
  // The 任务 tables, for the same reason and over the same handle: the migration
  // ledger runs at open, so a statement that cannot run is a stack trace here
  // rather than a tab that 500s the first time somebody starts a mission.
  // `openMissionStore` memoises on the SourceStore, so the runner and the routes
  // below get this same instance.
  const missionStore = openMissionStore(store);
  const chat = createChat(ctx);
  ctx.logger?.info?.(`swarm: source library at ${path} (${store.count()} rows, ${insightStore.count()} insight(s), ${missionStore.stats().missions} mission(s))`);

  // The runner: one boot id, one abort registry, one failure circuit, one set of
  // twelve handlers. It resolves `ctx.llm` and `ctx.agentDefaultModel` per model
  // call — the settings document can replace the route between calls — and the
  // optional search seam through `ctx.get("web")`, never `inject`, so
  // dsh-web-search staying uninstalled costs corroboration rather than the whole
  // plugin's ability to load.
  const bootConfig = readConfig(store);
  const missionRuntime = createMissionRuntime({
    store,
    missionStore,
    ctx,
    config: bootConfig,
    spillDir: bootConfig.missionSpillDir,
    logger: ctx.logger,
  });

  const dispose = ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    // `ctx.get`, not `inject`. Injecting "web" would make this plugin refuse to
    // load without dsh-web-search, and the library is worth having on its own;
    // absent, corroboration searches arXiv alone and says so.
    handler: createHandler(
      store, ctx.logger, chat,
      typeof ctx.get === "function" ? ctx.get("web") : undefined,
      ctx,
      createMissionRoutes({
        store,
        missionStore,
        runtime: missionRuntime,
        logger: ctx.logger,
        sendJson,
        readJson,
        // A FUNCTION, not a snapshot. `missionDefaultDepth`, the two pacing
        // intervals and the concurrency cap are read at the moment a mission is
        // created, so saving a setting takes effect at the next create rather
        // than at the next restart.
        config: () => readConfig(store),
      }),
    ),
  });
  // Agents reach the same library the page reads: one store, two faces.
  registerLibraryTool(ctx, store);
  // Before the timer: a first run with an empty roster would collect nothing
  // and log a success.
  ensureSourceRoster(store, ctx.logger);
  // The insight pass rides this timer; it has none of its own.
  const stopTimer = startCollectionTimer(store, ctx.logger, insightStore, chat, ctx);
  const stopPublish = startPublishTimer(store, chat, ctx.logger);
  sweepMissionsOnBoot(missionRuntime, bootConfig, ctx.logger);
  ctx.on("dispose", () => {
    // Missions FIRST, and this is an ordering, not a list. A live run holds the
    // same connection the store below is about to close, so a mission still in a
    // stage when `store.close()` lands writes into a closed handle — and the row
    // it was about to settle stays `running` with nothing anywhere saying why
    // until the next boot sweep finds it. `stop()` aborts each run and writes an
    // honest `shutdown` row for it.
    const stopped = missionRuntime.stop();
    if (stopped > 0) ctx.logger?.info?.(`swarm: stopped ${stopped} running mission(s) for shutdown; resume is armed for each`);
    stopTimer();
    // `stopPublish` was assigned and never called here, so the publish timer
    // kept ticking against a closed database after dispose — a plugin that
    // reports itself as gone while a job it owns wakes every minute to query a
    // handle that is not there. Both timers stop before the store closes.
    stopPublish();
    dispose();
    store.close();
  });
}
