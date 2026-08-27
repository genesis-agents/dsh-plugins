// One report, one length target.
//
// `contentGuard` judges a report twice: the whole thing against a floor scaled
// to the evidence (`operativeWordFloor`) and then halved
// (`CONTENT_GUARD_WORD_FRACTION`), and chapter by chapter against
// `min_delivery`. Those two numbers were computed in different files from
// different inputs, and they drifted 4.8x apart: the per-chapter target divided
// the raw tier SEED at full rate while the whole-report check divided the
// evidence-scaled floor in half.
//
// A real run hit it exactly. 42 verified findings, 7 chapters, 5,680 words. The
// whole-report check wanted 5,250 and passed it — and the same guard, in the
// same call, refused the report because all 7 chapters were under 3,571, a
// target adding up to a report 4.4x longer than the one it had just accepted.
// Twelve stages of work signed off as `quality_refused` for missing a number
// the guard itself did not require.
//
// The invariant below is the one that was violated, and it is not a threshold
// anybody can tune: a report whose every chapter exactly meets its target is
// exactly a report at the whole-report minimum.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { planChapters, operativeWordFloor, CONTENT_GUARD_WORD_FRACTION } from "../lib/mission-stages-middle.js";
import { contentGuard } from "../lib/mission-stages-back.js";

/** The shortest report the whole-report check accepts. */
const wholeReportMinimum = (tierFloor, verifiedCount) =>
  Math.floor(operativeWordFloor(tierFloor, verifiedCount).floor * CONTENT_GUARD_WORD_FRACTION);

/** `n` dimensions with evidence behind them, so the planner opens `n` chapters. */
const dimensionsOf = (n) => Array.from({ length: n }, (_, i) => ({
  dimensionId: `d${i}`, name: `Dimension ${i}`, verified: 6, rationale: "r",
}));

const factsOf = (n) => Array.from({ length: n }, (_, i) => ({
  factId: `f${i}`, dimensionIds: [`d${i % 4}`], entity: "e", attribute: "a", value: "v",
}));

test("the chapter targets add up to the whole-report floor, never past it", () => {
  // Swept, because the defect was invisible at any single point: both numbers
  // looked defensible on their own and only their RATIO was wrong.
  for (const tierFloor of [3_000, 9_000, 25_000]) {
    for (const verified of [4, 11, 42, 120]) {
      for (const chapterCount of [1, 3, 7, 12]) {
        const chapters = planChapters({
          dimensions: dimensionsOf(chapterCount),
          facts: factsOf(24),
          insights: { themes: [] },
          maxChapters: chapterCount,
          wordFloor: tierFloor,
          verifiedCount: verified,
          language: "en",
        });
        assert.equal(chapters.length, chapterCount, "fixture did not open the chapters it asked for");

        const target = chapters[0].minDelivery;
        for (const chapter of chapters) {
          assert.equal(chapter.minDelivery, target, "chapters of one report were given different targets");
        }

        const demanded = target * chapterCount;
        const minimum = wholeReportMinimum(tierFloor, verified);
        // The one exception is the 250-word clamp under a chapter nobody should
        // write: it can only push the sum UP on a very short report, and it is
        // a floor under the chapter, not a second opinion about the report.
        if (target > 250) {
          assert.ok(
            demanded <= minimum,
            `tier ${tierFloor}, ${verified} verified, ${chapterCount} chapters: the chapters are asked for `
            + `${demanded} words while the report as a whole needs ${minimum}. A report that satisfies every `
            + `chapter is refused as a whole, or one the guard accepts is refused chapter by chapter.`,
          );
        }
      }
    }
  }
});

test("the run that was refused for missing a number nothing required", () => {
  // The measured artefact: 7 chapters, 5,680 words, 34 citations, 42 verified
  // findings from 15 hosts. Kept as numbers a run actually produced, so a
  // future change to either floor has to explain itself against this report.
  const words = [444, 796, 852, 966, 596, 1009, 1017];
  const total = words.reduce((a, b) => a + b, 0);
  assert.equal(total, 5680, "the fixture stopped describing the run it is named for");

  const chapters = planChapters({
    dimensions: dimensionsOf(7),
    facts: factsOf(24),
    insights: { themes: [] },
    maxChapters: 7,
    wordFloor: 25_000,
    verifiedCount: 42,
    language: "en",
  });
  const target = chapters[0].minDelivery;
  assert.ok(
    target < 3_571,
    `the per-chapter target is ${target}, the tier seed divided by the chapter count — the whole-report check `
    + `asks for ${wholeReportMinimum(25_000, 42)} and this asks each of 7 chapters for more than half of it`,
  );

  const rows = words.map((wordCount, chapterIndex) => ({
    dimensionId: `d${chapterIndex}`,
    chapterIndex,
    heading: `Chapter ${chapterIndex}`,
    body: "x ".repeat(wordCount),
    minDelivery: target,
    underDelivered: wordCount < target,
  }));

  const guard = contentGuard(
    {
      markdown: words.map((w, i) => `## Chapter ${i}\n\n${"x ".repeat(w)}`).join("\n\n"),
      sections: words.map((w, i) => ({ heading: `Chapter ${i}`, wordCount: w })),
      citations: Array.from({ length: 34 }, (_, i) => ({ id: `c${i}` })),
      wordCount: total,
    },
    { total: 34, verified: 34 },
    "deep",
    { chapters: rows, wordFloor: 25_000, verifiedCount: 42 },
  );

  const codes = guard.violations.map((v) => v.code);
  assert.ok(
    !codes.includes("under-delivered"),
    `the guard still refuses this report chapter by chapter: ${JSON.stringify(guard.violations)}`,
  );
  assert.ok(
    !codes.includes("word-count"),
    `the guard refuses this report on total length: ${JSON.stringify(guard.violations)}`,
  );
});

test("thin evidence still shortens both floors together", () => {
  // The direction that must NOT break: 11 findings cannot carry 9,000 words,
  // and the per-chapter target has to fall with the whole-report one rather
  // than holding the tier constant on its own.
  const chapters = planChapters({
    dimensions: dimensionsOf(3),
    facts: factsOf(11),
    insights: { themes: [] },
    maxChapters: 3,
    wordFloor: 9_000,
    verifiedCount: 11,
    language: "en",
  });
  assert.equal(operativeWordFloor(9_000, 11).source, "evidence", "the operative floor stopped following the evidence");
  assert.ok(
    chapters[0].minDelivery <= wholeReportMinimum(9_000, 11) / 3 + 1,
    `each of 3 chapters is asked for ${chapters[0].minDelivery} against a report minimum of ${wholeReportMinimum(9_000, 11)}`,
  );
});

test("a planner given no supply reading does not fall back to the tier constant", () => {
  // `verifiedCount` is optional on the input, and the fallback is the fact
  // table — what survived verification — rather than the seed. Passing the seed
  // through here would reopen the whole gap for any caller that forgot it.
  const withCount = planChapters({
    dimensions: dimensionsOf(4), facts: factsOf(12), insights: { themes: [] },
    maxChapters: 4, wordFloor: 25_000, verifiedCount: 12, language: "en",
  });
  const without = planChapters({
    dimensions: dimensionsOf(4), facts: factsOf(12), insights: { themes: [] },
    maxChapters: 4, wordFloor: 25_000, language: "en",
  });
  assert.equal(
    without[0].minDelivery,
    withCount[0].minDelivery,
    "a caller that omitted verifiedCount got a different chapter target, so the fallback is not the fact table",
  );
});
