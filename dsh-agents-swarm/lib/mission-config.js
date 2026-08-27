/**
 * The mission section of the plugin's settings.
 *
 * Same shape as `readPublishConfig` and `readInsightConfig`: defaults here,
 * reader here, validator here, and index.js spreads the reader into
 * `readConfig()` and calls the validator from `writeConfig()`. One subject, one
 * file, and no second copy of a default anywhere.
 *
 * WHAT IS DELIBERATELY *NOT* A SETTING: the five ceilings and `wallMs`. They are
 * resolved once by `resolveBudget()` at `createMission`, frozen onto the mission
 * row and into config revision 1, and read from the row thereafter. Playground's
 * rerun builder could not read `maxCredits`, fell back to a value worth about
 * two dollars, and died instantly — with every layer reporting success. A
 * ceiling that can change under a running mission is that bug with a nicer name.
 *
 * Every value here is CHECKED, never coerced. A coerced value is a value nobody
 * agreed to: `Number("thirty")` is NaN, and clamping it to a default would save
 * the patch, answer `{saved: true}`, and run missions on a configuration the
 * settings page does not show.
 */

import { dirname, join } from "node:path";

import { DEPTH_TIERS } from "./mission-runtime.js";
import { pacerFor } from "./mission-tools.js";

/** A bare hostname: labels separated by dots, no scheme, no path, no port. */
const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Where spill files go when nothing is configured: beside the database.
 *
 * Beside it for the same reason the thumbnails are — a library copied to another
 * machine carries its own working files, and there is still exactly one thing to
 * point at.
 * @param dbPath - the resolved library database path.
 * @returns the absolute spill directory.
 */
export function defaultSpillDir(dbPath) {
  return join(dirname(String(dbPath ?? ".")), "mission-spill");
}

/**
 * The mission defaults, with the reason attached to the ones that have one.
 *
 * `missionParseP50Ms` is 849 because that is what the phase −1 spike MEASURED on
 * this machine against real pages, not because it is a round number.
 * `computeWallFloorMs` throws on a missing one on purpose: a floor computed
 * without the parse cost understates the `deep` tier by more than half, which is
 * the exact mistake revision 1 of the design made.
 */
export const MISSION_DEFAULTS = Object.freeze({
  missionParseP50Ms: 849,
  // arXiv asks for one request every three seconds; four gives it jitter.
  missionArxivIntervalMs: 4000,
  missionFetchIntervalMs: 1000,
  missionDefaultDepth: "standard",
  missionLanguage: "zh",
  // One process, one connection, one pacer. A second concurrent mission doubles
  // the request rate the pacer exists to hold.
  missionMaxConcurrent: 1,
  missionDenyHosts: [],
  missionSpillDir: "",
  missionDocumentMaxAgeDays: 30,
  // The spike's measured MAX_TURNS. Overrides AGENT_TURN_CAP.
  missionTurnCap: 12,
  // The routed model's context window, in tokens, when the harness cannot be
  // asked for it. 0 means unset, and unset is honest: `readContextPlan` still
  // refuses to invent a number and every stage still runs at its smallest
  // viable input.
  //
  // It exists because on a real deployment none of the three accessors answers
  // — `openai/gpt-5.6-luna` reports no window through route, `llm.modelInfo` or
  // `llm.models` — so s1 degraded on EVERY run and every stage after it shrank
  // harder than it needed to. A number an operator supplies is not a guess,
  // which is the thing the resolver is right to refuse.
  missionContextWindow: 0,
  missionTrace: false,
  // OFF, and it is the one that must default off. The sweep ALWAYS moves rows
  // out of `running` — that part is not optional and is not a setting. Whether
  // the process then picks them back up is, because a plugin restarts on a
  // settings change and on a harness auto-update, not only on a crash: a `deep`
  // mission with a 4M-token ceiling would otherwise silently resume, unattended,
  // on every restart. Resume is offered; it is not taken.
  missionAutoResume: false,
});

/** Every key `writeConfig` may persist for this feature. */
export const MISSION_SETTING_KEYS = Object.freeze(Object.keys(MISSION_DEFAULTS));

/**
 * Where an open handle's main database file lives.
 *
 * Asked of the CONNECTION rather than of the environment, so this answers
 * correctly for a library opened from a pointer file, from `DSH_SWARM_LIBRARY`,
 * or by a test against a temporary path — and returns "" for `:memory:`, which
 * is the honest answer rather than a plausible directory that does not exist.
 * @param store - the source library.
 * @returns the absolute database path, or "".
 */
function dbPathOf(store) {
  try {
    const row = store?.db?.prepare("PRAGMA database_list").get();
    return typeof row?.file === "string" ? row.file : "";
  } catch {
    return "";
  }
}

/**
 * Read the mission section, filling defaults.
 * @param store - the source library.
 * @param dbPath - the library path, for the spill directory default; derived from the handle when absent.
 * @returns the settings, whole.
 */
export function readMissionConfig(store, dbPath = "") {
  const config = {};
  for (const key of MISSION_SETTING_KEYS) config[key] = store.getSetting(key, MISSION_DEFAULTS[key]);
  // Resolved on the way out rather than stored, so moving the library moves the
  // spill directory with it instead of leaving an absolute path pointing at a
  // machine this database is no longer on.
  if (typeof config.missionSpillDir !== "string" || config.missionSpillDir.trim() === "") {
    const base = dbPath !== "" ? dbPath : dbPathOf(store);
    config.missionSpillDir = base === "" ? "" : defaultSpillDir(base);
  }
  return config;
}

/**
 * Validate a mission settings patch, key by key.
 *
 * Only the keys present are checked, so the settings page can save one field
 * without resending the rest. An absent key leaves the stored one alone; an
 * empty string is an explicit clear where the key accepts one.
 * @param patch - the incoming partial configuration.
 * @returns validation problems; empty means every present key is acceptable.
 */
export function validateMissionConfig(patch) {
  const problems = [];

  for (const [key, low, high] of [
    // 0 is legitimate: a machine with a warm page cache genuinely parses in no
    // measurable time, and the floor it produces is then honest.
    ["missionParseP50Ms", 0, 60_000],
    ["missionArxivIntervalMs", 1000, 30_000],
    ["missionFetchIntervalMs", 0, 30_000],
    ["missionMaxConcurrent", 1, 3],
    ["missionDocumentMaxAgeDays", 1, 365],
    ["missionTurnCap", 3, 40],
    // 0 is unset. Above that, a floor low enough to be useless is more
    // dangerous than none at all, because it silences the degrade note while
    // still starving every stage.
    ["missionContextWindow", 0, 10_000_000],
  ]) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    if (!Number.isInteger(value) || value < low || value > high) {
      problems.push(`${key} must be a whole number between ${low} and ${high}`);
    }
  }

  // The two interval settings feed `computeWallFloorMs`, and the floor is only
  // honest if it is not FASTER than the pacer that actually holds the rate. The
  // real chain is module-private inside insight-corroborate.js; a setting below
  // it does not speed anything up, it just understates the floor, which is how a
  // plan that cannot fit gets accepted at the create route.
  for (const [key, paceKey] of [["missionArxivIntervalMs", "arxiv"], ["missionFetchIntervalMs", "fetch"]]) {
    if (patch[key] === undefined) continue;
    const value = Number(patch[key]);
    const registered = pacerFor(paceKey)?.intervalMs;
    if (Number.isInteger(value) && Number.isFinite(registered) && value < registered) {
      problems.push(`${key} must be at least ${registered}: that is the interval the ${paceKey} pacer actually holds, and a smaller number here only understates the wall-clock floor`);
    }
  }

  if (patch.missionDefaultDepth !== undefined && !DEPTH_TIERS.includes(patch.missionDefaultDepth)) {
    problems.push(`missionDefaultDepth must be one of ${DEPTH_TIERS.join(", ")}`);
  }
  if (patch.missionLanguage !== undefined && patch.missionLanguage !== "zh" && patch.missionLanguage !== "en") {
    // Not cosmetic: every paired user-facing string in the mission pipeline is
    // `zh ? "中文" : "English"`, so an unrecognised value silently makes the
    // whole surface English on a machine that asked for Chinese.
    problems.push('missionLanguage must be "zh" or "en"');
  }
  if (patch.missionDenyHosts !== undefined) {
    if (!Array.isArray(patch.missionDenyHosts)) problems.push("missionDenyHosts must be an array of bare hostnames");
    else {
      for (const [index, host] of patch.missionDenyHosts.entries()) {
        // Bare hostnames, checked. `admissibleUrl` will not catch these: on a
        // machine whose own library is served over a tailnet, the library's host
        // is a perfectly ordinary public-looking name, and a URL pasted here
        // instead of a hostname would never match and would never say so.
        if (typeof host !== "string" || !BARE_HOST.test(host.trim())) {
          problems.push(`missionDenyHosts[${index}] must be a bare hostname like box.tailnet.ts.net, not a URL`);
        }
      }
    }
  }
  if (patch.missionSpillDir !== undefined) {
    if (typeof patch.missionSpillDir !== "string") problems.push("missionSpillDir must be a string; send an empty string to return to the directory beside the database");
  }
  for (const key of ["missionTrace", "missionAutoResume"]) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") problems.push(`${key} must be true or false`);
  }

  return problems;
}
