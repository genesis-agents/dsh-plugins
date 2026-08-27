// A stage doing real work has to say so.
//
// `detectNoProgress` kills a stage that keeps spending while no business event
// lands for 322 seconds. Every business event is stage-level — `stage:started`,
// `stage:done`, the gates — so `s8-write` emitted one at the start and then
// nothing until every chapter was finished. The whole of the writing was one
// silent block.
//
// It only ever beat the threshold by accident. A run with 108 verified findings
// across 8 dimensions crossed it and was killed mid-write, with eight
// dimensions of collected evidence and a finished outline intact behind it —
// `no_progress: No progress for 322s at s8-write while spend kept rising`.
//
// Widening the window would have blinded the guard. The stage reports each
// chapter instead, so a writer stuck on ONE chapter still trips it.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { EVENT_TYPES, detectNoProgress } from "../lib/mission-runtime.js";

test("a written chapter is business, which is what moves the stall clock", () => {
  assert.equal(
    EVENT_TYPES["chapter:written"],
    "business",
    "a written chapter is lifecycle noise again, so it does not reset the stall clock and s8 goes silent for its whole run",
  );
});

test("the writer emits one per chapter, after the chapter lands", () => {
  // After `upsertChapter`, deliberately: the clock resets on work that LANDED,
  // not on a call being made, or a writer looping on one chapter would hold the
  // guard off for ever by starting it again.
  const source = readFileSync(new URL("../lib/mission-stages-middle.js", import.meta.url), "utf8");
  // s7 plans chapter rows through the same call, so the writer's is the last.
  const persist = source.lastIndexOf("store.upsertChapter({");
  assert.ok(persist > 0, "the chapter persist moved; this guard is looking at nothing");
  const after = source.slice(persist, persist + 1_400);
  assert.match(
    after,
    /emit\("chapter:written",\s*\{/,
    "s8 no longer reports a written chapter, so its whole run is one silent block to the watchdog again",
  );
  // And the payload has to name which of how many, or the event says a chapter
  // happened without saying whether the stage is moving.
  for (const field of ["chapterIndex", "of:", "wordCount"]) {
    assert.ok(after.includes(field), `the chapter event carries no ${field}`);
  }
});

test("a stage that reports progress survives; one that hangs still dies", () => {
  // Both directions, against the guard itself. The first is the run that was
  // killed; the second is the hang the guard exists for. One time base for the
  // mark and the clock, or the comparison is between 1970 and 2026.
  const killMs = 322_000;
  const markedAtMs = Date.parse("2026-08-27T00:00:00.000Z");
  const at = (offsetMs) => new Date(markedAtMs + offsetMs).toISOString();
  const entry = { stepId: "s8-write", lastProgressAtMs: markedAtMs };

  const moving = detectNoProgress({
    entry, now: at(20_000), noProgressKillMs: killMs, spendRose: true, toolShapes: [],
  });
  assert.notEqual(
    moving.tripped,
    true,
    "a stage that emitted a business event 20s ago is being killed, so reporting chapters buys nothing",
  );

  const hung = detectNoProgress({
    entry, now: at(killMs + 1_000), noProgressKillMs: killMs, spendRose: true, toolShapes: [],
  });
  assert.equal(hung.tripped, true, "a toolless stage silent past the threshold is no longer killed at all");
  assert.equal(hung.reason, "no_progress");
  assert.equal(hung.detail?.condition, "silent-but-spending");
});
