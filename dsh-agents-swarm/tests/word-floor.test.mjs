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
import { readFileSync } from "node:fs";
import { planChapters, operativeWordFloor, CONTENT_GUARD_WORD_FRACTION } from "../lib/mission-stages-middle.js";
import { TIER_POLICY, WORDS_PER_VERIFIED_FINDING } from "../lib/mission-stages-front.js";
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

test("the tier number is a seed, and only one function may turn it into a threshold", () => {
  // THE THIRD PLACE. After the per-chapter target and the guard itself, the s11
  // sign-off rung compared the delivered length to `policy.wordFloor` and forced
  // the Leader's verdict down a band when it fell short — and handed the Leader
  // the same raw number as "the floor". A run delivered 6,697 words from 48
  // verified findings, an operative floor of 12,000; the content guard passed
  // it, and the Leader then wrote "delivered only 6,697 words, below the 25,000
  // floor" and refused to sign. Twelve stages of work, refused for missing a
  // number nothing downstream required.
  //
  // Behavioural tests could not reach it: the rung lives inside a stage closure
  // with no seam. So the rule is enforced where it can be — every use of the
  // tier constant must be one of the four that are allowed to exist.
  const ALLOWED = [
    // Scaled to the evidence. This is the ONLY way to a threshold.
    /operativeWordFloor\(\s*policy\??\.?wordFloor/,
    // The per-chapter share, which scales it the same way internally.
    /deliveryFloor\(\s*policy\??\.?wordFloor/,
    // Handed to a callee that takes `verifiedCount` beside it and scales there.
    /wordFloor:\s*policy\??\.?wordFloor\s*,/,
    // Kept under a name that says it is the tier's ask, for a message that
    // shows both numbers.
    /const\s+tierWordFloor\s*=\s*Number\(policy\??\.?wordFloor\)/,
    // A presence check, not a comparison against a delivered length.
    /intOr0\(policy\??\.?wordFloor\)\s*<=\s*0/,
  ];

  for (const file of ["mission-stages-back.js", "mission-stages-middle.js"]) {
    const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/policy\??\.?\.?wordFloor/.test(line)) return;
      if (!/policy\??\.wordFloor/.test(line)) return;
      assert.ok(
        ALLOWED.some((allowed) => allowed.test(line)),
        `${file}:${index + 1} uses the tier's word floor directly:\n  ${line.trim()}\n`
        + "The tier number is a SEED. Pass it through operativeWordFloor so the report is judged "
        + "against what its evidence can carry, or the pipeline gets a fourth opinion about one length.",
      );
    });
  }
});

test("every threshold the sign-off applies comes from the operative floor", () => {
  // Narrower and blunter: inside s11, the comparison that forces a verdict down
  // must be against the scaled floor. Reverting the one assignment above it is
  // the exact regression, and it leaves the comparison itself untouched — so
  // the guard has to look at where `wordFloor` in that scope comes from.
  const source = readFileSync(new URL("../lib/mission-stages-back.js", import.meta.url), "utf8");
  const open = source.indexOf("export function createS11Signoff");
  assert.ok(open > 0, "createS11Signoff moved; this guard is looking at nothing");
  const body = source.slice(open, source.indexOf("export function createS12Persist"));

  assert.match(
    body,
    /const\s+wordFloor\s*=\s*operative\.floor\s*;/,
    "s11's `wordFloor` is no longer the operative floor, so the rung that forces a verdict down "
    + "is comparing a delivered length against the tier constant again",
  );
  assert.match(
    body,
    /operativeWordFloor\(\s*policy\.wordFloor\s*,\s*verifiedForFloor\s*\)/,
    "s11 stopped scaling the tier floor to the evidence it actually collected",
  );
  assert.ok(
    body.includes("wordCount < wordFloor"),
    "the word-floor rung is gone; it exists because a Leader rated a 50k-word delivery against a "
    + "200k-word promise as excellent, and removing it is not the way to stop it misfiring",
  );
  // The Leader has to SEE both numbers, or a report at a correct length for its
  // evidence reads to it as one four times too short. Scoped to the brief
  // OBJECT: a first draft looked at the whole stage, and the bounded digest's
  // own `tierWordFloor: brief.tierWordFloor` kept it green with the brief field
  // deleted — a guard that passes while reading a field that is no longer set.
  const briefOpen = body.indexOf("const brief = {");
  assert.ok(briefOpen > 0, "the sign-off brief moved; this guard is looking at nothing");
  const brief = body.slice(briefOpen, body.indexOf("\n    };", briefOpen));
  for (const field of ["tierWordFloor", "wordFloorSource", "verifiedFindings"]) {
    assert.ok(
      new RegExp(`(^|\\s)${field}\\s*[,:]`, "m").test(brief),
      `the sign-off brief no longer carries ${field}, so the Leader judges the length against one number `
      + "with no way to see that the evidence, not the tier, is what set it",
    );
  }
});

test("a tier can reach its own word floor with the evidence it plans to collect", () => {
  // THE ROOT OF THE CHAIN. Three numbers in a tier row, written by hand, that
  // contradicted each other. `quick` was exactly right — 3 dimensions x 4
  // findings x 250 words is 3,000, its floor to the digit — and the other two
  // rows drifted from the rule the first one follows.
  //
  // `deep` planned 8 x 6 = 48 verified findings, which carry 12,000 words, and
  // demanded 25,000. Unreachable by a factor of two BY ITS OWN COLLECTION
  // TARGET, and no amount of writing could close it. Every dimension of a deep
  // run stopped at exactly 6 — the target is what the researcher prompt asks
  // for and what s3's derived floor is clamped to — so a run ended with 43
  // verified findings, 5,245 words and 88% of its token budget unspent, and was
  // refused for missing a floor its own plan had made impossible.
  for (const [tier, policy] of Object.entries(TIER_POLICY)) {
    const planned = policy.dimensionTarget * policy.findingTarget;
    const carries = planned * WORDS_PER_VERIFIED_FINDING;
    assert.ok(
      carries >= policy.wordFloor,
      `${tier} plans ${policy.dimensionTarget} dimensions x ${policy.findingTarget} findings = ${planned} verified, `
      + `which carry ${carries} words, against a floor of ${policy.wordFloor}. The tier cannot reach its own promise, `
      + "so every run of it is refused for a shortfall its own plan guaranteed.",
    );
  }
});

test("the tier that was already right is untouched", () => {
  // `quick` is the control. The derivation was reverse-engineered from it, so
  // if it ever comes out at anything but 4 the rule was read out of the wrong
  // row and the other two tiers are wrong in a new way.
  assert.equal(
    TIER_POLICY.quick.findingTarget,
    4,
    "the derivation no longer reproduces the one tier row that was internally consistent before it existed",
  );
  assert.equal(TIER_POLICY.quick.dimensionTarget * TIER_POLICY.quick.findingTarget * WORDS_PER_VERIFIED_FINDING, 3_000);
});

test("the collection target is not padded far past what the floor needs", () => {
  // The other direction. Collecting is the expensive half of a mission, and a
  // target that overshoots buys tokens nobody asked for. One dimension's worth
  // of slack is the rounding; more than that is a second invented number.
  for (const [tier, policy] of Object.entries(TIER_POLICY)) {
    const carries = policy.dimensionTarget * policy.findingTarget * WORDS_PER_VERIFIED_FINDING;
    const slack = carries - policy.wordFloor;
    assert.ok(
      slack < policy.dimensionTarget * WORDS_PER_VERIFIED_FINDING,
      `${tier} plans for ${carries} words against a floor of ${policy.wordFloor} — ${slack} words of slack, `
      + "which is more than the rounding needs and is paid for in collection",
    );
  }
});
