// The source of a spoken claim is a second, not a video.
//
// For a paper, "the source" is the page and a link to it is the whole of what
// a reader needs. For a talk it is not: an hour of interview is not a citation
// of one sentence — it hands the reader the search problem back. The source is
// which video, at what second, in whose answer.
//
// The library already stores the transcript with a start time on every cue, so
// the second is computable. This file is about the two ways computing it goes
// wrong quietly: a match at the wrong offset, which puts a confident `▶ 38:08`
// under a sentence nobody said there, and a match that should not have been
// made at all.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { formatMoment, momentOf, momentUrl, withMoments } from "../lib/insight-moment.js";
import { INSIGHT_DEFAULTS } from "../lib/insight-extract.js";

/** A transcript as `getTranscript` returns one: cues with a start in seconds. */
const CUES = [
  { start: 0, duration: 4, text: "Welcome back to the show." },
  { start: 745.2, duration: 6, text: "the cost of launch. And with Starship" },
  { start: 751.8, duration: 5, text: "reusability, that goes to under a billion." },
  { start: 757.0, duration: 4, text: "So the economics just instantly flip." },
  { start: 3792.4, duration: 5, text: "for an Nvidia data center you need a $15 billion equity check." },
];

test("a quote that spans cues resolves to the cue it starts in", () => {
  // A QUOTE ROUTINELY SPANS THREE CUES. The one it STARTS in is the moment to
  // link to, because that is where a listener has to be to hear the sentence
  // begin — landing them in the middle of it is landing them in the wrong
  // place while looking right.
  assert.equal(
    momentOf("the cost of launch. And with Starship reusability, that goes to under a billion.", CUES),
    745,
    "a quote spanning two cues did not resolve to the one it starts in",
  );
  assert.equal(momentOf("for an Nvidia data center you need a $15 billion equity check.", CUES), 3792);
});

test("what does not match gets no timestamp, which is the point", () => {
  // THE PASS VERIFIES EVERY QUOTE against the block the model was shown, so a
  // quote that is not in the transcript came from somewhere else — a
  // paraphrase, or a transcript refetched and changed since. A near-match
  // would put a confident second under a sentence nobody said there, which is
  // worse than no timestamp at all.
  assert.equal(momentOf("this sentence was never spoken in this interview", CUES), null);
  // AND A HANDFUL OF WORDS IS NOT A LOCATOR. "and so" occurs forty times in an
  // hour of speech and the first hit is not the one the claim came from.
  assert.equal(momentOf("the cost", CUES), null, "a fragment shorter than a clause was located anyway");
  assert.equal(momentOf("a quote against a video we hold no transcript for", []), null);
  assert.equal(momentOf("a quote against a video we hold no transcript for", null), null);
});

test("the folding survives what a transcript and a model disagree about", () => {
  // THEY DISAGREE ABOUT WHITESPACE AND QUOTE MARKS AND NOTHING ELSE THAT
  // MATTERS: the block was cues joined by one space, the stored text may carry
  // newlines, and a model shown `"` sometimes returns `“`.
  const cues = [{ start: 61, text: "he said “the economics flip” and then\nmoved on to capex" }];
  assert.equal(
    momentOf('he said "the economics flip" and then moved on to capex', cues), 61,
    "a curly quote or a newline lost the match",
  );
  // AND THE FOLD MUST NOT MOVE ANY CHARACTER. If it changed the length, the
  // index of a match would not be the index in the real text and the cue walk
  // would land in the wrong cue — silently, and only for long transcripts.
  const long = [
    { start: 10, text: "aaaa bbbb cccc dddd eeee ffff gggg hhhh" },
    { start: 99, text: "the sentence we are actually looking for here" },
  ];
  assert.equal(momentOf("the sentence we are actually looking for here", long), 99, "the offset walk landed in the wrong cue");
});

test("only a host whose player takes a second gets a link", () => {
  assert.equal(momentUrl("https://www.youtube.com/watch?v=abc123", 2288), "https://www.youtube.com/watch?v=abc123&t=2288s");
  assert.equal(momentUrl("https://youtu.be/abc123", 2288), "https://youtu.be/abc123?t=2288s");
  // `t` REPLACES rather than appends: a URL that already carries one from the
  // feed would otherwise get two, and YouTube honours the first.
  assert.equal(momentUrl("https://www.youtube.com/watch?v=abc&t=99s", 100), "https://www.youtube.com/watch?v=abc&t=100s");
  // A NEWS SITE HANDED `?t=` SHOWS THE TOP OF THE PAGE. A link that claims to
  // open at 38:08 and does not is worse than one that does not claim it.
  assert.equal(momentUrl("https://fortune.com/article/paypal-mafia/", 100), null);
  assert.equal(momentUrl("not a url at all", 100), null);
});

test("a player writes 38:08 under an hour and 1:03:12 over one", () => {
  assert.equal(formatMoment(2288), "38:08");
  assert.equal(formatMoment(3792), "1:03:12");
  assert.equal(formatMoment(59), "0:59");
  assert.equal(formatMoment(0), "0:00");
});

test("one transcript read per source, and none at all for a paper", () => {
  // THE TYPE GATE IS FIRST BECAUSE IT IS FREE. Reading a transcript for every
  // arXiv abstract on the page is one query per row for a column that is empty
  // on all of them — and a page of claims is sixty rows.
  const reads = [];
  const transcriptOf = (id) => { reads.push(id); return { cues: CUES }; };
  const rows = [
    { resourceId: "v1", resourceType: "YOUTUBE_VIDEO", quote: "So the economics just instantly flip.", resource: { sourceUrl: "https://youtu.be/v1" } },
    { resourceId: "v1", resourceType: "YOUTUBE_VIDEO", quote: "for an Nvidia data center you need a $15 billion equity check.", resource: { sourceUrl: "https://youtu.be/v1" } },
    { resourceId: "p1", resourceType: "PAPER", quote: "However, these models suffer from factual inaccuracy.", resource: { sourceUrl: "https://arxiv.org/abs/1" } },
  ];
  const out = withMoments(rows, transcriptOf);
  assert.deepEqual(reads, ["v1"], `the transcript was read ${reads.length} time(s) for one video and one paper`);
  assert.equal(out[0].at, 757);
  assert.equal(out[0].atUrl, "https://youtu.be/v1?t=757s");
  assert.equal(out[1].at, 3792);
  assert.equal(out[2].at, null, "a paper was given a timestamp");
  assert.equal(out[2].atUrl, null);
});

test("a transcript that cannot be read costs the timestamp and nothing else", () => {
  // A THROW HERE WOULD TAKE THE WHOLE LIST DOWN. One unreadable transcript
  // must cost one link, not the page.
  const out = withMoments(
    [{ resourceId: "v1", resourceType: "YOUTUBE_VIDEO", quote: "So the economics just instantly flip.", resource: { sourceUrl: "https://youtu.be/v1" } }],
    () => { throw new Error("the store is busy"); },
  );
  assert.equal(out[0].at, null);
  assert.equal(out[0].atUrl, null);
});

test("videos are what the pass reads first, not what it leaves out", () => {
  // 523 VIDEOS WENT UNREAD WHILE THE PASS MINED ABSTRACTS. Nothing said why:
  // no note, no test, no argument — and the rest of the pipeline was plainly
  // built to read them, since `sourceMaterial` takes a transcript beside the
  // row and carries its own comment about a video having no summary.
  //
  // A talk is also the one source type that can say WHERE a sentence came
  // from, which is what everything above computes. Leaving it out made this
  // the one feature the library could not demonstrate.
  assert.ok(
    INSIGHT_DEFAULTS.insightResourceTypes.includes("YOUTUBE_VIDEO"),
    "the insight pass excludes videos again, so no claim can ever carry a moment",
  );
  assert.equal(
    INSIGHT_DEFAULTS.insightResourceTypes[0], "YOUTUBE_VIDEO",
    "videos are no longer the type the pass reaches for first",
  );
});
