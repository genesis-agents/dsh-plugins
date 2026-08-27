// The chapter floor is enforced where it can still be acted on.
//
// `minDelivery` was passed into the writer's prompt, recorded afterwards as
// `underDelivered`, and used by `contentGuard` to refuse the whole report — and
// nothing ever sent a short chapter back. It was advice with no gate behind it.
//
// So the writer landed on its own natural size every time, and the target might
// as well not have existed. Measured across two runs: 1246, 1111, 1097, 1065
// and 1182 words against a floor of 1750, and 811 against a floor of 3571. A
// spread of 17% across a target that moved by more than 2x is a number nobody
// is reading.
//
// Every other requirement in this stage that matters has a gate that re-asks —
// citations do, the evidenced-chapter rule does. This one did not, and the
// report was then refused for it twelve stages later.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkChapter, countWords } from "../lib/mission-stages-middle.js";

/** A body of exactly `n` countable words. */
const bodyOf = (n) => "word ".repeat(n).trim();

/** A gate with citations that always resolve, so only length is under test. */
const gate = (minDelivery, { sectionType = "evidenced", zh = false } = {}) =>
  checkChapter({ resolve: (id) => id, sectionType, minDelivery, zh });

const CITED = [{ findingId: "F1", inlineQuote: "q" }];

test("a chapter under its floor is sent back, naming both numbers", () => {
  const issues = gate(1_750)({ body: bodyOf(1_140), citations: CITED });
  const short = issues.filter((issue) => /1140/.test(issue) && /1750/.test(issue));
  assert.equal(
    short.length,
    1,
    `a chapter 610 words under its floor raised no length issue: ${JSON.stringify(issues)}`,
  );
});

test("the correction asks for the material, not for length", () => {
  // The floor is scaled to the evidence precisely because padding is worse than
  // brevity. A gate that asked for words would defeat the thing it enforces.
  const [issue] = gate(1_750)({ body: bodyOf(900), citations: CITED });
  assert.match(issue, /facts|findings|evidence/i, "the correction does not point at the material the chapter was given");
  assert.match(issue, /not pad|Do not pad/i, "the correction does not rule out padding, which is what it will get");
  assert.doesNotMatch(issue, /write (it )?longer/i, "the correction asks for length, which is an instruction to pad");
});

test("a chapter that meets its floor passes", () => {
  assert.deepEqual(gate(1_000)({ body: bodyOf(1_000), citations: CITED }), []);
  assert.deepEqual(gate(1_000)({ body: bodyOf(1_400), citations: CITED }), []);
});

test("no floor means no length issue, so a caller that forgets blocks nothing", () => {
  // `minDelivery` defaults to 0. A stage rerun off a checkpoint that lost the
  // column must not have every chapter refused for missing a floor of NaN.
  for (const floor of [0, undefined, null, Number.NaN]) {
    const issues = checkChapter({ resolve: (id) => id, sectionType: "evidenced", minDelivery: floor, zh: false })(
      { body: bodyOf(10), citations: CITED },
    );
    assert.deepEqual(issues, [], `a floor of ${JSON.stringify(floor)} refused a chapter on length`);
  }
});

test("an empty body is still one issue, not two", () => {
  // The empty-body branch returns early on purpose: telling a model its empty
  // chapter is also 0 words against 1750 is the same fact twice.
  const issues = gate(1_750)({ body: "", citations: [] });
  assert.equal(issues.length, 1, `an empty chapter produced ${issues.length} issues: ${JSON.stringify(issues)}`);
});

test("the writer's gate is given the floor the row carries", () => {
  // The gate can only enforce what the call site hands it, and `minDelivery` is
  // read from the column so that the prompt, the gate and the accounting all
  // use one number.
  const source = readFileSync(new URL("../lib/mission-stages-middle.js", import.meta.url), "utf8");
  assert.match(
    source,
    /checkChapter\(\{\s*resolve: cite\.resolve,\s*sectionType: row\.sectionType,\s*minDelivery: row\.minDelivery,/,
    "s8 builds the chapter gate without the floor, so the floor is advice again",
  );
});

test("the counter agrees with the one the guard judges by", () => {
  // Both sides must count the same way or a chapter can pass the gate and fail
  // the report. Chinese reports are counted by character, which is why this is
  // not obvious.
  assert.equal(countWords("word ".repeat(5).trim()), 5);
  assert.equal(countWords("渥太华科技园"), 6, "CJK is counted by character, and the floors are set against that");
});

test("a chapter is a hole below half its target, not below the target", async () => {
  // Two numbers per chapter, the same pair the whole report has: aim at the
  // floor, refuse below half of it. Conflating them is what made the report the
  // writer was aimed at exactly the report the sign-off penalised.
  const { CONTENT_GUARD_WORD_FRACTION } = await import("../lib/mission-stages-middle.js");
  assert.equal(CONTENT_GUARD_WORD_FRACTION, 0.5, "the fraction moved; the two levels no longer share one relationship");
});

test("the writer records a hole against half the target, where the guard counts it", () => {
  // The computation is inside the s8 closure with no seam, and the word-floor
  // fixtures build their own rows — so reverting this line changed nothing any
  // behavioural test could see. It is the line `contentGuard`'s under-delivered
  // count reads: against the whole target, eight chapters aimed at 3,125 and
  // delivering 2,000 would all be holes and the report would be refused for
  // being written to the standard it was just given.
  const source = readFileSync(new URL("../lib/mission-stages-middle.js", import.meta.url), "utf8");
  assert.match(
    source,
    /underDelivered = wordCount < Math\.floor\(row\.minDelivery \* CONTENT_GUARD_WORD_FRACTION\);/,
    "s8 records a chapter as under-delivered for missing its TARGET rather than for falling under half of it, "
    + "so aiming the writer higher now refuses the reports it aims at",
  );
});
