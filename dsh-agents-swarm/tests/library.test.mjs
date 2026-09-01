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
import { SourceStore } from "../lib/store.js";

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

/* ── how long a recording is ───────────────────────────────────────────── */

test("a video's length is stored, not paid for and thrown away", (t) => {
  // `dropShortVideos` asks the watch page for `lengthSeconds` on every NEW
  // video — one request each, deliberately budgeted — used it to apply the
  // twenty-minute floor, and then discarded it. The library enforced a length
  // rule it could not state and no card could show a duration.
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  store.put({
    id: "v1", type: "YOUTUBE_VIDEO", title: "A long interview",
    sourceUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    durationSeconds: 3720,
  });
  assert.equal(store.get("v1").durationSeconds, 3720, "the length did not survive the round trip");
});

test("an unknown length is null, and a length filter keeps it", (t) => {
  // NULL is "nobody ever asked" — every row collected before the column
  // existed, every non-video, and every video whose lookup failed (which
  // `dropShortVideos` keeps on purpose, because a network error is not
  // evidence that something is short). Coerced to 0 they would all fall under
  // any floor, and "only videos over 20 minutes" would silently delete the
  // whole back catalogue while looking like it worked.
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  store.put({ id: "old", type: "YOUTUBE_VIDEO", title: "Collected before the column", sourceUrl: "https://youtu.be/bbbbbbbbbbb" });
  store.put({ id: "short", type: "YOUTUBE_VIDEO", title: "A clip", sourceUrl: "https://youtu.be/ccccccccccc", durationSeconds: 240 });
  store.put({ id: "long", type: "YOUTUBE_VIDEO", title: "A talk", sourceUrl: "https://youtu.be/ddddddddddd", durationSeconds: 3600 });
  assert.equal(store.get("old").durationSeconds, undefined, "an unknown length was coerced to a number");
  const ids = store.query({ minDurationSeconds: 20 * 60, take: 50 }).rows.map((row) => row.id).sort();
  assert.deepEqual(ids, ["long", "old"], "the floor either dropped the unknowns or kept the clip");
});

test("an hourly re-collection does not erase a length it did not fetch", (t) => {
  // The lookup is gated on the row being NEW, so the hourly re-write of a row
  // the library already holds carries no duration at all. Plain assignment
  // would wipe the number on the next poll, and there is no second chance to
  // learn it.
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  const row = { id: "v2", type: "YOUTUBE_VIDEO", title: "A talk", sourceUrl: "https://youtu.be/eeeeeeeeeee" };
  store.put({ ...row, durationSeconds: 4200 });
  store.put(row);
  assert.equal(store.get("v2").durationSeconds, 4200, "the next poll erased the length");
});
