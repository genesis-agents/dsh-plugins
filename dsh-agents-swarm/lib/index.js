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
import { COLLECTORS, runCollector } from "./collect.js";
import { registerLibraryTool } from "./tool.js";
import { resolveTranscript, listCaptionTracks, transcriptFromXml, fetchVideoDetails } from "./transcript.js";
import { translateBatch, isSupportedLanguage, BATCH_SIZE, TARGET_LANGUAGES } from "./translate.js";
import { admissibleUrl, fetchDocument, readableText, readArticle, displayModeOf, documentUrlOf } from "./proxy.js";
import { sourceFeeds } from "./sources.js";
import { enrichThumbnails, imageForPage, ENRICHABLE_TYPES, DEFAULT_ENRICH_LIMIT } from "./enrich.js";

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
 * Pointer file naming where the library lives.
 *
 * The database is not runtime state — it is the surviving copy of a corpus
 * migrated out of a service that is being retired — so it must not be buried
 * in `<dshHome>/storages` beside disposable caches, where a routine cleanup of
 * harness state would take it. The path is therefore a deliberate choice, and
 * the pointer keeps that choice across restarts without requiring an
 * environment variable to be set on every launch.
 */
const LOCATION_POINTER = "swarm-library-location.txt";

/**
 * Absolute path of the source library database.
 *
 * Resolution order: the `DSH_SWARM_DB` environment override, then the pointer
 * file written by whoever chose the location, then the harness home as a last
 * resort so a fresh install still works.
 * @param env - process environment.
 * @returns the absolute database path.
 */
export function storePath(env = process.env) {
  const override = env.DSH_SWARM_DB;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  const pointer = join(resolveDshHome(env), LOCATION_POINTER);
  if (existsSync(pointer)) {
    const recorded = readFileSync(pointer, "utf8").trim();
    if (recorded !== "" && isAbsolute(recorded)) return recorded;
  }
  return join(resolveDshHome(env), "storages", "swarm-sources.sqlite");
}

/**
 * Record where the library should live, for later launches.
 * @param path - absolute database path.
 * @param env - process environment.
 */
export function writeStorePointer(path, env = process.env) {
  writeFileSync(join(resolveDshHome(env), LOCATION_POINTER), `${path}\n`, "utf8");
}

/**
 * Where locally held thumbnails live: beside the database, so a library that
 * is copied to another machine carries its images with it.
 * @param env - process environment.
 * @returns the absolute directory path.
 */
export function thumbnailDir(env = process.env) {
  return join(dirname(storePath(env)), "thumbnails");
}

/** Upstream origin for the seed action, without a trailing slash. */
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
const DEFAULT_COLLECT_INTERVAL_MINUTES = 60;

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
 * @param store - the source library.
 * @param logger - Cordis logger.
 * @returns a disposer stopping the timer.
 */
export function startCollectionTimer(store, logger) {
  let timer;
  const configured = Number(readConfig(store).collectIntervalMinutes ?? DEFAULT_COLLECT_INTERVAL_MINUTES);
  if (!Number.isFinite(configured) || configured <= 0) return () => {};
  const minutes = Math.max(MIN_COLLECT_INTERVAL_MINUTES, configured);
  logger?.info?.(`swarm: collecting every ${minutes} minute(s)`);
  timer = setInterval(() => {
    void collectOnce(store, logger).catch((cause) => {
      logger?.warn?.(`swarm: collection run failed: ${String(cause?.message ?? cause)}`);
    });
  }, minutes * 60_000);
  timer.unref?.();
  return () => { clearInterval(timer); };
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
 */
const ROSTER_VERSION = 2;

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
 * @returns `{ feeds, jobs, transcriptLanguages, supadataKey }`.
 */
export function readConfig(store) {
  return {
    feeds: store.getSetting("feeds", []),
    jobs: store.getSetting("jobs", DEFAULT_JOBS),
    transcriptLanguages: store.getSetting("transcriptLanguages", DEFAULT_TRANSCRIPT_LANGUAGES),
    supadataKey: store.getSetting("supadataKey", ""),
    collectIntervalMinutes: store.getSetting("collectIntervalMinutes", DEFAULT_COLLECT_INTERVAL_MINUTES),
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
      problems.push();
    }
  }
  if (problems.length > 0) return problems;
  for (const key of ["feeds", "jobs", "transcriptLanguages", "supadataKey", "collectIntervalMinutes"]) {
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
      if (chunk.type === "text-delta") yield { text: chunk.text };
      else if (chunk.type === "finish" && chunk.reason?.kind !== "stop") {
        const failure = chunk.reason?.failure;
        yield { error: failure?.message ?? chunk.reason?.kind ?? "model call failed" };
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
      else send({ content: piece.text });
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
export function createHandler(store, logger, chat) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.slice(ROUTE_PREFIX.length) || "/";
    const query = url.searchParams;

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
          supadataKeySet: config.supadataKey !== "",
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
        store.put({ ...row, abstract: details.description });
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

/** Required services: the HTTP carrier, the model runtime, and the default route. */
export const inject = ["webServer", "llm", "agentDefaultModel", "tools"];

/**
 * Open the library and claim the API prefix for as long as this plugin is
 * active.
 * @param ctx - Cordis context carrying the web server service.
 */
export function apply(ctx) {
  const path = storePath();
  const store = new SourceStore(path);
  ctx.logger?.info?.(`swarm: source library at ${path} (${store.count()} rows)`);
  const dispose = ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: createHandler(store, ctx.logger, createChat(ctx)),
  });
  // Agents reach the same library the page reads: one store, two faces.
  registerLibraryTool(ctx, store);
  // Before the timer: a first run with an empty roster would collect nothing
  // and log a success.
  ensureSourceRoster(store, ctx.logger);
  const stopTimer = startCollectionTimer(store, ctx.logger);
  ctx.on("dispose", () => {
    stopTimer();
    dispose();
    store.close();
  });
}
