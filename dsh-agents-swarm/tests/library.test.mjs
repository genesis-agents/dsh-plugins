/**
 * Where the library is, and who owns it.
 *
 * Worth testing because every wrong answer here is quiet. A machine that
 * wrongly resolves to "local" does not fail — it opens an empty database and
 * starts collecting into it, so you get two libraries and two podcasts and no
 * error anywhere. A machine that wrongly resolves to "remote" serves someone
 * else's rows as if they were its own.
 *
 * Run with `npm test` from the package root.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join } from "node:path";

import { LIBRARY_ENV, normalizeRemote, resolveLibrary } from "../lib/library.js";

/** A home directory that exists nowhere, so no pointer file is ever found. */
const HOME = process.platform === "win32" ? "C:\\nowhere" : "/nowhere";

/** Resolve with only an environment, never the real machine's. */
const resolve = (value) =>
  resolveLibrary(value === undefined ? { DSH_HOME: HOME } : { DSH_HOME: HOME, [LIBRARY_ENV]: value }, HOME);

test("unset means a library of this machine's own, in its own directory", () => {
  const library = resolve(undefined);
  assert.equal(library.kind, "local");
  assert.equal(library.path, join(HOME, "swarm", "swarm-sources.sqlite"));
  // Specifically NOT under the harness's own `storages/`. The library is a
  // corpus that took months to accumulate and whose paper thumbnails cannot be
  // re-fetched; filed beside session caches it sits in the blast radius of any
  // routine cleanup of harness state.
  assert.ok(!library.path.includes("storages"), library.path);
});

test("an absolute path means this machine owns the library", () => {
  const path = process.platform === "win32" ? "C:\\data\\lib.sqlite" : "/data/lib.sqlite";
  assert.deepEqual(resolve(path), { kind: "local", path });
});

test("a URL means another machine owns it", () => {
  for (const [given, want] of [
    ["https://box.ts.net", "https://box.ts.net/swarm-api"],
    ["https://box.ts.net/", "https://box.ts.net/swarm-api"],
    ["https://box.ts.net/swarm-api", "https://box.ts.net/swarm-api"],
    ["https://box.ts.net/swarm-api/", "https://box.ts.net/swarm-api"],
    ["http://192.168.1.9:3080", "http://192.168.1.9:3080/swarm-api"],
    ["  https://box.ts.net  ", "https://box.ts.net/swarm-api"],
  ]) {
    assert.deepEqual(resolve(given), { kind: "remote", base: want }, given);
  }
});

test("a value meant as a URL is never demoted to a path", () => {
  // The dangerous failure: falling through to "treat it as a path" would open
  // an empty local library named after a typo and start collecting into it,
  // silently, while the real library sat untouched on the other machine.
  assert.throws(() => resolve("https://"), /could not be parsed/);
  assert.throws(() => resolve("http://"), /could not be parsed/);
});

test("a relative path is refused rather than resolved against the cwd", () => {
  // Resolving it would make the library's location depend on where the process
  // happened to be started from — the same machine could hold several.
  for (const bad of ["data/lib.sqlite", "./lib.sqlite", "../lib.sqlite", "lib.sqlite"]) {
    assert.throws(() => resolve(bad), /absolute path or an http\(s\) URL/, bad);
  }
});

test("an unsupported scheme is refused, not treated as a path", () => {
  assert.throws(() => resolve("ftp://box/lib"), /absolute path or an http\(s\) URL/);
  assert.throws(() => resolve("file:///data/lib.sqlite"), /absolute path or an http\(s\) URL/);
});

test("normalizeRemote reports unusable input rather than guessing", () => {
  assert.equal(normalizeRemote("not a url"), undefined);
  assert.equal(normalizeRemote("ftp://box"), undefined);
  assert.equal(normalizeRemote("https://box.ts.net"), "https://box.ts.net/swarm-api");
});

test("the environment beats the pointer file", () => {
  // Both name a library; the environment is the one you can change for a
  // single launch, so it has to win or debugging a wrong pointer means
  // editing a file and restarting.
  const path = process.platform === "win32" ? "C:\\from-env.sqlite" : "/from-env.sqlite";
  const library = resolveLibrary({ DSH_HOME: HOME, [LIBRARY_ENV]: path }, HOME);
  assert.deepEqual(library, { kind: "local", path });
});
