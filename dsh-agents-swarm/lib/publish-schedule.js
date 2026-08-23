/**
 * The daily episode: what an always-on machine is actually for.
 *
 * Collection already runs hourly, so by morning the library holds a day of
 * material nobody has read. Turning that into something listenable is the
 * step that makes the collection worth having, and it is exactly the step a
 * person will not do by hand every day.
 *
 * Scheduled by LOCAL wall-clock time, not by an interval. "Every 24 hours"
 * drifts with every restart until the episode arrives at three in the morning;
 * "07:00" is what somebody actually means, and it survives a restart because
 * the last run is recorded by date rather than by elapsed time.
 *
 * A run is skipped rather than shortened when there is too little new
 * material. An episode built from two press releases is worse than no episode:
 * it costs the same model call, it takes the same place in the feed, and the
 * listener learns that the feed is not worth opening.
 */

import { generateScript } from "./podcast.js";
import { DEFAULT_HOSTS, concatMp3, synthesizeTurns } from "./tts.js";
import { saveEpisode } from "./episodes.js";

/** How often the wall clock is consulted. */
const TICK_MS = 60_000;

/** `HH:MM` on a 24-hour clock. */
const AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * How late a missed run may still be caught up.
 *
 * A machine that was asleep at 07:00 and wakes at 09:00 should still make the
 * episode — that is most of why the window is a window at all. But an
 * unbounded "any time after" has a second, worse reading: setting a 07:00
 * schedule at three in the afternoon fires an episode on the spot, which is
 * not what anybody types 07:00 to mean.
 */
const GRACE_MINUTES = 6 * 60;

/** Defaults for every scheduling field, so an unset store still reads whole. */
export const PUBLISH_DEFAULTS = {
  publishAt: "",
  publishKinds: ["NEWS", "BLOG", "PAPER", "REPORT", "POLICY", "YOUTUBE_VIDEO"],
  publishSources: 8,
  publishMinutes: 8,
  publishHosts: DEFAULT_HOSTS,
  publishMinSources: 3,
};

/**
 * Read the scheduling section, filling defaults.
 * @param store - the source library.
 * @returns the settings, whole.
 */
export function readPublishConfig(store) {
  return {
    publishAt: store.getSetting("publishAt", PUBLISH_DEFAULTS.publishAt),
    publishKinds: store.getSetting("publishKinds", PUBLISH_DEFAULTS.publishKinds),
    publishSources: store.getSetting("publishSources", PUBLISH_DEFAULTS.publishSources),
    publishMinutes: store.getSetting("publishMinutes", PUBLISH_DEFAULTS.publishMinutes),
    publishHosts: store.getSetting("publishHosts", PUBLISH_DEFAULTS.publishHosts),
    publishMinSources: store.getSetting("publishMinSources", PUBLISH_DEFAULTS.publishMinSources),
    publishLastRun: store.getSetting("publishLastRun", null),
  };
}

/** Today's date in the machine's own timezone, as `YYYY-MM-DD`. */
export function localDate(now = new Date()) {
  // Not `toISOString().slice(0,10)`: that is UTC, and a schedule set for 07:00
  // in a UTC+8 timezone would then consider the run "already done today" from
  // the previous afternoon onwards.
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Whether the scheduled moment has arrived, is still recent, and has not been
 * served today.
 *
 * A window rather than an exact match, so a minute lost to a busy machine or
 * to being asleep still produces the episode a little late instead of not at
 * all — bounded by {@link GRACE_MINUTES} so "late" cannot mean "eight hours
 * later, the moment you typed the time in".
 *
 * The window does not cross midnight: a 23:30 schedule missed while the
 * machine slept is not caught up at 00:05, because catching it up would mean
 * marking YESTERDAY served and the date stamp is what makes "already ran"
 * answerable at all. Schedules near midnight lose their catch-up; schedules
 * anywhere else keep it.
 * @param config - the scheduling settings.
 * @param now - the current instant.
 * @returns true when a run is due.
 */
export function isDue(config, now = new Date()) {
  const match = AT_PATTERN.exec(String(config.publishAt ?? "").trim());
  if (match === null) return false;
  if (config.publishLastRun?.date === localDate(now)) return false;
  const late = (now.getHours() * 60 + now.getMinutes()) - (Number(match[1]) * 60 + Number(match[2]));
  return late >= 0 && late <= GRACE_MINUTES;
}

/**
 * The sources a scheduled episode should cover.
 *
 * Newest first, and only rows the library learned about since the last
 * episode — an episode that re-covers yesterday's news is worse than a short
 * one. On the first ever run there is no watermark, so it takes the newest
 * rows and starts the sequence from there.
 * @param store - the source library.
 * @param config - the scheduling settings.
 * @returns rows, newest first.
 */
export function pickSources(store, config) {
  const kinds = Array.isArray(config.publishKinds) && config.publishKinds.length > 0
    ? config.publishKinds
    : PUBLISH_DEFAULTS.publishKinds;
  const want = Math.max(1, Math.min(20, Number(config.publishSources) || PUBLISH_DEFAULTS.publishSources));
  const since = typeof config.publishLastRun?.watermark === "string" ? config.publishLastRun.watermark : "";

  const rows = [];
  for (const kind of kinds) {
    // A per-kind query rather than one over everything: a day of NEWS runs to
    // hundreds of rows and would crowd out every paper and policy document,
    // and an episode that is only news is a worse episode than a mixed one.
    const page = store.query({ type: kind, sortBy: "createdAt", take: Math.max(4, Math.ceil(want / kinds.length) + 2), skip: 0 });
    for (const row of page.rows) {
      if (since !== "" && typeof row.createdAt === "string" && row.createdAt <= since) continue;
      rows.push(row);
    }
  }
  rows.sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
  return rows.slice(0, want);
}

/**
 * Build one episode from whatever is new.
 * @param store - the source library.
 * @param chat - the streaming chat entry point, or undefined when none is routed.
 * @param logger - Cordis logger.
 * @returns `{ ran, reason?, episodeId?, sources? }`.
 */
export async function publishOnce(store, chat, logger) {
  const config = readPublishConfig(store);
  if (chat === undefined) return { ran: false, reason: "no model routed" };

  const sources = pickSources(store, config);
  const floor = Math.max(1, Number(config.publishMinSources) || PUBLISH_DEFAULTS.publishMinSources);
  if (sources.length < floor) {
    return { ran: false, reason: `only ${sources.length} new source(s); ${floor} needed` };
  }

  const withTranscripts = sources.map((row) => ({ row, transcript: store.getTranscript(row.id) }));
  const script = await generateScript(chat, withTranscripts, { minutes: config.publishMinutes });
  const hosts = config.publishHosts ?? DEFAULT_HOSTS;
  const { segments } = await synthesizeTurns(script.turns, hosts);
  const episode = await saveEpisode({
    audio: concatMp3(segments),
    title: script.title,
    script,
    sourceIds: sources.map((row) => row.id),
    voices: hosts,
  });

  // The watermark is the newest row this episode covered, so tomorrow's
  // episode starts where this one stopped. Recording the run time instead
  // would re-cover anything collected while the episode was being made.
  //
  // It moves past rows this episode did NOT cover, and that is deliberate: on
  // a day with fifty new NEWS rows, eight of which fit, the other forty-two
  // are yesterday's news by tomorrow morning. A digest that works through a
  // backlog is a digest that falls further behind every day.
  const watermark = sources
    .map((row) => String(row.createdAt ?? ""))
    .reduce((latest, value) => (value > latest ? value : latest), "");
  store.setSetting("publishLastRun", {
    date: localDate(),
    at: new Date().toISOString(),
    episodeId: episode.id,
    sources: sources.length,
    watermark,
  });
  logger?.info?.(`swarm: scheduled episode "${episode.title}" from ${sources.length} source(s)`);
  return { ran: true, episodeId: episode.id, sources: sources.length };
}

/**
 * Run the daily episode and record what happened.
 *
 * Both the timer and the "run now" button come through here so they agree on
 * what a run means. They differ in one thing: `markSkips`. When the TIMER
 * finds too little material it must still mark the day served, or the check
 * would retry every minute until midnight and fire the episode the moment a
 * third source arrived — at whatever hour that happened to be. When a PERSON
 * presses the button and gets the same answer, marking the day served would
 * silently cancel this morning's scheduled run.
 * @param store - the source library.
 * @param chat - the chat entry point.
 * @param logger - Cordis logger.
 * @param options - `{ markSkips }`.
 * @returns the outcome, as `publishOnce` reports it.
 */
export async function runScheduled(store, chat, logger, { markSkips = false } = {}) {
  const stamp = () => ({ date: localDate(), at: new Date().toISOString() });
  try {
    const result = await publishOnce(store, chat, logger);
    if (!result.ran) {
      logger?.info?.(`swarm: scheduled episode skipped — ${result.reason}`);
      if (markSkips) store.setSetting("publishLastRun", { ...stamp(), skipped: result.reason });
    }
    return result;
  } catch (cause) {
    const error = String(cause?.message ?? cause);
    logger?.warn?.(`swarm: scheduled episode failed: ${error}`);
    if (markSkips) store.setSetting("publishLastRun", { ...stamp(), error });
    return { ran: false, reason: error, failed: true };
  }
}

/**
 * Start the daily publish timer.
 *
 * A one-minute tick rather than a timer set to fire at the moment: computing a
 * delay to a wall-clock time has to handle the clock changing under it —
 * daylight saving, a machine waking with a corrected time — and a check
 * that costs nothing a minute is simpler than being right about all of that.
 * @param store - the source library.
 * @param chat - the chat entry point.
 * @param logger - Cordis logger.
 * @returns a disposer stopping the timer.
 */
export function startPublishTimer(store, chat, logger) {
  let running = false;
  const timer = setInterval(() => {
    // Guarded because a render takes minutes and the tick is one: without it
    // the same due window would launch sixty overlapping episodes.
    if (running) return;
    if (!isDue(readPublishConfig(store))) return;
    running = true;
    void runScheduled(store, chat, logger, { markSkips: true })
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  return () => { clearInterval(timer); };
}
