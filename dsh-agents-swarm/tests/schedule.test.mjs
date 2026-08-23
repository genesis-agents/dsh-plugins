/**
 * The daily episode's scheduling decisions.
 *
 * Tested here rather than by watching it run, because every way this can be
 * wrong is SILENT. A schedule that never fires looks exactly like one that has
 * not come round yet; a watermark that never advances shows up as a podcast
 * that repeats itself, days later, to whoever subscribed. None of it raises an
 * error, so none of it surfaces without being asked directly.
 *
 * Run with `node --test tests/` from the package root.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { SourceStore } from "../lib/store.js";
import { writeConfig, readConfig } from "../lib/index.js";
import { PUBLISH_DEFAULTS, isDue, localDate, pickSources } from "../lib/publish-schedule.js";

/** A `Date` in the machine's own timezone, which is what the schedule reads. */
const at = (hour, minute, day = 23) => new Date(2026, 7, day, hour, minute);

/** The settings a due-check needs, with the schedule set to 07:00. */
const sevenAm = (lastRun = null) => ({ publishAt: "07:00", publishLastRun: lastRun });

test("localDate reads the local calendar, not UTC", () => {
  // `toISOString().slice(0, 10)` would be a plausible implementation and would
  // put a machine east of UTC onto tomorrow's date for part of every evening —
  // making the schedule believe the next day was already served.
  assert.equal(localDate(at(1, 30)), "2026-08-23");
  assert.equal(localDate(at(23, 30)), "2026-08-23");
});

test("a run is due from its time until the catch-up window closes", () => {
  assert.equal(isDue(sevenAm(), at(6, 59)), false);
  assert.equal(isDue(sevenAm(), at(7, 0)), true);
  assert.equal(isDue(sevenAm(), at(9, 0)), true, "a machine that woke late still makes the episode");
  assert.equal(isDue(sevenAm(), at(13, 0)), true, "the window's last minute");
  assert.equal(isDue(sevenAm(), at(13, 1)), false, "past the window");
  assert.equal(isDue(sevenAm(), at(15, 0)), false, "typing 07:00 in the afternoon must not fire on the spot");
});

test("a day is served once", () => {
  assert.equal(isDue(sevenAm({ date: "2026-08-23" }), at(9, 0)), false);
  assert.equal(isDue(sevenAm({ date: "2026-08-22" }), at(9, 0)), true);
});

test("an unusable time turns the schedule off rather than guessing", () => {
  // Each of these would otherwise be read as "no schedule" by a parser that
  // coerced instead of matching — which is the same outcome, but arrived at
  // without anyone being told. The write path rejects them; this is the
  // second line, for settings written before that check existed.
  for (const publishAt of ["", "7:00", "25:00", "07:60", "0700", "07:00:00", " ", null, undefined, 700]) {
    assert.equal(isDue({ publishAt, publishLastRun: null }, at(23, 0)), false, `publishAt: ${JSON.stringify(publishAt)}`);
  }
});

test("the catch-up window does not reach across midnight", () => {
  assert.equal(isDue({ publishAt: "00:00", publishLastRun: null }, at(0, 5)), true);
  assert.equal(isDue({ publishAt: "23:30", publishLastRun: null }, at(0, 5)), false);
});

/** A library holding four rows across three kinds, at known collection times. */
function stocked() {
  const store = new SourceStore(":memory:");
  const row = (id, type, createdAt) => ({ id, type, title: `t-${id}`, sourceUrl: `https://x.test/${id}`, createdAt });
  store.putMany([
    row("a", "NEWS", "2026-08-20T00:00:00.000Z"),
    row("b", "NEWS", "2026-08-22T00:00:00.000Z"),
    row("c", "BLOG", "2026-08-23T00:00:00.000Z"),
    row("d", "PAPER", "2026-08-23T05:00:00.000Z"),
  ]);
  return store;
}

/** The scheduling settings, with the count raised so nothing is trimmed. */
const roomy = (publishLastRun) => ({ ...PUBLISH_DEFAULTS, publishSources: 10, publishLastRun });

test("the first run takes the newest sources it can find", () => {
  assert.deepEqual(pickSources(stocked(), roomy(null)).map((r) => r.id), ["d", "c", "b", "a"]);
});

test("later runs start where the last one stopped", () => {
  const store = stocked();
  assert.deepEqual(
    pickSources(store, roomy({ watermark: "2026-08-22T00:00:00.000Z" })).map((r) => r.id),
    ["d", "c"],
    "anything already covered is left out",
  );
  assert.deepEqual(
    pickSources(store, roomy({ watermark: "2026-08-23T05:00:00.000Z" })).map((r) => r.id),
    [],
    "a quiet day yields nothing rather than repeating yesterday",
  );
});

test("the watermark can be compared at all", () => {
  // The reason this test exists: `createdAt` is set by `put` as a COLUMN and
  // is absent from the `raw` snapshot that collected rows are rebuilt from.
  // Served without it, every row compares as undefined, the filter above
  // silently keeps everything, and the podcast repeats itself forever.
  for (const row of pickSources(stocked(), roomy(null))) {
    assert.equal(typeof row.createdAt, "string", `${row.id} must carry the time it was collected`);
  }
});

test("the episode is a mix, not whichever kind is loudest", () => {
  const store = stocked();
  assert.deepEqual(pickSources(store, { ...roomy(null), publishKinds: ["NEWS"] }).map((r) => r.id), ["b", "a"]);
  assert.deepEqual(pickSources(store, { ...roomy(null), publishSources: 2 }).map((r) => r.id), ["d", "c"]);
});

test("the schedule is stored whole, and its record is not writable from outside", () => {
  const store = new SourceStore(":memory:");
  assert.deepEqual(writeConfig(store, { publishAt: "07:30", publishSources: 6 }), []);
  assert.equal(readConfig(store).publishAt, "07:30");
  assert.equal(readConfig(store).publishSources, 6);

  // A page that could write `publishLastRun` could tell the timer today was
  // already served, which is a way to turn the schedule off that leaves the
  // time sitting in the field looking switched on.
  writeConfig(store, { publishLastRun: { date: localDate() } });
  assert.equal(readConfig(store).publishLastRun, null);
});

test("a time that cannot work is refused with a reason", () => {
  const store = new SourceStore(":memory:");
  for (const bad of ["7:30", "25:00", "07:60", 730, null]) {
    const problems = writeConfig(store, { publishAt: bad });
    assert.equal(problems.length, 1, `publishAt: ${JSON.stringify(bad)}`);
    assert.match(problems[0], /HH:MM/);
  }
  assert.deepEqual(writeConfig(store, { publishAt: "" }), [], "empty is how the schedule is turned off");
});

test("out-of-range settings are refused rather than clamped", () => {
  const store = new SourceStore(":memory:");
  assert.equal(writeConfig(store, { publishSources: 99 }).length, 1);
  assert.equal(writeConfig(store, { publishMinutes: 1 }).length, 1);
  assert.equal(writeConfig(store, { publishKinds: ["NEWS", "NOPE"] }).length, 1);
  assert.equal(writeConfig(store, { publishHosts: { a: "x" } }).length, 1);
});

test("a rejected collection interval says why", () => {
  // It used to `problems.push()` with no argument: the patch was refused and
  // the page was handed an empty reason to display.
  const problems = writeConfig(new SourceStore(":memory:"), { collectIntervalMinutes: 5 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /at least 15/);
});
