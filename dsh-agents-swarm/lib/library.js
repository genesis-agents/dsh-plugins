/**
 * One question, one answer: where is the source library?
 *
 * This used to be three mechanisms answering the same question — an env var
 * for a local path, a pointer file for a local path, and a second env var for
 * a remote URL — which is three places to look when the answer is wrong and
 * three chances for them to disagree. They are now one setting with one value
 * space, and the VALUE decides the mode:
 *
 *     (unset)                              a library of this machine's own
 *     /srv/data/swarm-sources.sqlite       that file, on this machine
 *     https://box.tailnet.ts.net           that machine's library, proxied
 *
 * Nothing is inferred beyond reading the value: a URL means somebody else owns
 * the library, a path means this machine does. That distinction cannot be
 * detected and must not be guessed, because a machine that wrongly believes it
 * owns the library starts its own collection timer — and two collectors fetch
 * all 72 feeds twice into two diverging libraries and publish two podcasts.
 *
 * The default is a directory of the plugin's own rather than the harness's
 * `storages/`. The library is not runtime state: it is a corpus that took
 * months to accumulate and, for the paper thumbnails, cannot be re-fetched at
 * all. Filed beside `workspace.json` and session caches, it sits in the
 * blast radius of any routine cleanup of harness state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Environment variable naming the library — a path or an http(s) URL. */
export const LIBRARY_ENV = "DSH_SWARM_LIBRARY";

/**
 * File recording the same value, for launches that cannot set an environment.
 *
 * A GUI launcher, a `launchd` plist, a service manager — each has its own way
 * of passing an environment and some have none. The file survives all of them,
 * and is the reason choosing a location is a one-time act rather than
 * something to remember at every start.
 */
export const LOCATION_POINTER = "swarm-library-location.txt";

/** Directory under the harness home holding the library and its media. */
export const LIBRARY_DIRNAME = "swarm";

/** Database filename inside that directory. */
export const LIBRARY_FILENAME = "swarm-sources.sqlite";

/**
 * Where the harness keeps its home.
 * @param env - process environment.
 * @param home - the account's home directory.
 * @returns the absolute harness home.
 */
export function resolveDshHome(env, home) {
  const raw = env.DSH_HOME;
  if (raw !== undefined && raw.trim() !== "") {
    const expanded = raw.trim().startsWith("~")
      ? join(home, raw.trim().slice(1))
      : raw.trim();
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  }
  return join(home, ".dsh");
}

/**
 * Normalize a remote value into an origin plus the API prefix.
 *
 * Accepts what a person would actually paste — bare origin, with or without
 * the `/swarm-api` suffix, with or without a trailing slash — because getting
 * this wrong yields 404s from a server that is working perfectly.
 * @param raw - the configured value, already known to look like a URL.
 * @returns the API base with no trailing slash, or undefined if unusable.
 */
export function normalizeRemote(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path.endsWith("/swarm-api") ? path : `${path}/swarm-api`}`;
}

/** Whether a configured value names another machine rather than a file. */
function looksRemote(value) {
  return /^https?:\/\//i.test(value);
}

/**
 * Read the configured value: environment first, then the pointer file.
 * @param env - process environment.
 * @param home - the account's home directory.
 * @returns the raw configured string, or "" when nothing is set.
 */
function configuredValue(env, home) {
  const fromEnv = env[LIBRARY_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  const pointer = join(resolveDshHome(env, home), LOCATION_POINTER);
  if (!existsSync(pointer)) return "";
  try {
    return readFileSync(pointer, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Resolve where the library is and who owns it.
 * @param env - process environment.
 * @param home - the account's home directory.
 * @returns `{ kind: "local", path }` or `{ kind: "remote", base }`.
 */
export function resolveLibrary(env = process.env, home = defaultHome()) {
  const value = configuredValue(env, home);
  if (value === "") {
    return { kind: "local", path: join(resolveDshHome(env, home), LIBRARY_DIRNAME, LIBRARY_FILENAME) };
  }
  if (looksRemote(value)) {
    const base = normalizeRemote(value);
    if (base !== undefined) return { kind: "remote", base };
    // A value that was MEANT to be a URL and is not parseable must not fall
    // through to "treat it as a path" — that would silently open an empty
    // local library named after a typo and start collecting into it.
    throw new Error(`${LIBRARY_ENV} looks like a URL but could not be parsed: ${value}`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${LIBRARY_ENV} must be an absolute path or an http(s) URL, got: ${value}`);
  }
  return { kind: "local", path: value };
}

/** The account's home directory, resolved lazily so tests can substitute one. */
function defaultHome() {
  // Imported here rather than at module scope so a caller passing `home`
  // explicitly never depends on the process's real environment.
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

/**
 * Record the choice for later launches.
 * @param value - an absolute path or an http(s) URL.
 * @param env - process environment.
 * @param home - the account's home directory.
 */
export function writeLibraryPointer(value, env = process.env, home = defaultHome()) {
  const dshHome = resolveDshHome(env, home);
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(join(dshHome, LOCATION_POINTER), `${String(value).trim()}\n`, "utf8");
}

/**
 * Media directories, derived from the database path.
 *
 * Beside the database rather than configured separately, so a library copied
 * to another machine carries its images and episodes with it — and so there is
 * still exactly one thing to point at.
 * @param path - the resolved database path.
 * @returns `{ thumbnails, episodes }` absolute directories.
 */
export function mediaDirs(path) {
  const root = dirname(path);
  return { thumbnails: join(root, "thumbnails"), episodes: join(root, "episodes") };
}
