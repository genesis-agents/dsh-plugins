/**
 * The 洞察 pipeline's arithmetic and its storage.
 *
 * Tested here rather than by watching a pass run, because every way this can
 * be wrong is SILENT. A hash that stopped matching yesterday's rows produces
 * duplicate cards, not an error. A clustering stage that folds nothing spends
 * one model call per article and reports the same numbers as one that worked.
 * A quote check that accepts an invented sentence puts a source's name under a
 * claim it never made, with every count on the card still correct. None of it
 * throws, so none of it surfaces without being asked directly.
 *
 * The store tests each open their own `:memory:` library and close it in
 * `t.after`, so no test can see another's rows.
 *
 * Run with `npm test` from the package root.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { SourceStore } from "../lib/store.js";
import {
  CREDIBILITY_WEIGHTS,
  MIN_QUOTE_CHARS,
  MIN_QUOTE_CJK_CHARS,
  SCORE_WEIGHTS,
  ZERO_SIMHASH,
  bucketOf,
  clusterItems,
  daysBetween,
  foldNearDuplicates,
  hammingDistance,
  itemForRow,
  jaccard,
  nextStatus,
  normalizeForQuote,
  quoteIsVerbatim,
  scoreCredibility,
  scoreInsight,
  scoreMomentum,
  scoreNovelty,
  scoreRelevance,
  shingles,
  simhash,
  sourceKeyOf,
  statementsMatch,
  tokenize,
  verifyQuote,
} from "../lib/insights.js";
import {
  EVIDENCE_STANCES,
  INSIGHT_DDL,
  INSIGHT_KINDS,
  INSIGHT_STATUSES,
  InsightStore,
  isInsightId,
  newInsightId,
  openInsightStore,
} from "../lib/insight-store.js";
// The candidate scan lives with the pass, not with the pure helpers: it needs
// the store. Imported here because the drain order is a correctness property,
// not an implementation detail.
import { collectCandidates } from "../lib/insight-extract.js";
import { buildQueries, createPacer, isIndependent, searchArxiv, searchWeb } from "../lib/insight-corroborate.js";

/** Floating point comparison, for scores that are exact only in decimal. */
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "value"}: ${actual} !== ${expected}`);

/* ── tokens, shingles, simhash ─────────────────────────────────────────── */

test("a Chinese sentence is many tokens, not one", () => {
  // A whitespace split makes an entire Chinese title ONE token, which gives it
  // a shingle set of one, a simhash shared with no other row, and its own
  // cluster — silently, on a corpus that is half Chinese, while the pass
  // reports itself as working.
  assert.deepEqual(tokenize("人工智能公司"), ["人", "工", "智", "能", "公", "司"]);
  assert.deepEqual(tokenize("OpenAI ships GPT-5"), ["openai", "ships", "gpt", "5"]);
});

test("a version digit survives tokenising", () => {
  // "GPT-5" splits to ["gpt", "5"]; dropping the lone digit as noise makes
  // "OpenAI ships GPT-5" and "OpenAI ships GPT-4" tokenise identically, so
  // stage 1 folds two different launches into one group and quotes the wrong
  // article for whichever one wins.
  assert.notDeepEqual(tokenize("OpenAI ships GPT-5"), tokenize("OpenAI ships GPT-4"));
  assert.deepEqual(tokenize("a I the"), ["the"], "single Latin letters are noise");
});

test("a URL contributes no tokens", () => {
  assert.deepEqual(tokenize("read https://cdn.example.com/a/b?c=d here"), ["read", "here"]);
});

test("a title shorter than the shingle window keeps its tokens", () => {
  // Returning [] instead would hash every short title to the same value, and
  // every short title would then be a near-duplicate of every other one.
  assert.deepEqual(shingles(["a", "b"], 3), ["a", "b"]);
  assert.deepEqual(shingles(["a", "b", "c", "d"], 3), ["a b c", "b c d"]);
});

test("the stored simhash is pinned to its algorithm", () => {
  // `insights.simhash` is a COLUMN. A change to tokenize, shingles or the hash
  // moves every value, reconciliation stops matching anything written before
  // the change, and the only symptom is duplicate cards appearing forever. If
  // these two move, the column has to be rebuilt — that is what this test is
  // here to make somebody notice.
  assert.equal(simhash("the quick brown fox jumps over the lazy dog"), "5add450e05ab61f7");
  assert.equal(simhash("人工智能公司发布新模型"), "57da5c9286cb8f9f");
  assert.match(simhash("anything at all"), /^[0-9a-f]{16}$/);
});

test("text with no tokens hashes to zero rather than to something plausible", () => {
  assert.equal(simhash(""), ZERO_SIMHASH);
  assert.equal(simhash("!!! ??? ..."), ZERO_SIMHASH);
  assert.equal(simhash(null), ZERO_SIMHASH);
});

/** A wire story, long enough that one changed word is a small hash distance. */
const WIRE = "Anthropic said on Monday that it had raised three and a half billion dollars in a Series E round led by Lightspeed Venture Partners, valuing the company at sixty one and a half billion dollars, and that the money would go towards compute capacity, safety research and international expansion over the next eighteen months.";

test("two tellings of one story hash close together and two stories do not", () => {
  const rewrite = WIRE.replace("said on Monday", "said on Tuesday");
  const other = "Beijing published draft rules for generative video models, requiring provenance labels on synthetic footage and an audit trail for the training data behind it.";
  assert.ok(hammingDistance(simhash(WIRE), simhash(rewrite)) <= 3, "a rewrite is a near-duplicate");
  assert.ok(hammingDistance(simhash(WIRE), simhash(other)) > 20, "a different story is not");
});

test("a near-duplicate is folded even when its simhash prefix differs", () => {
  // The one-band failure: blocking on a single 16-bit prefix, three differing
  // bits fall entirely outside that prefix about 42% of the time, so ~58% of
  // genuine near-duplicates are never COMPARED. Every fold that did happen
  // would still be correct, which is exactly why nothing reports the rest.
  // This pair is 2 bits apart with DIFFERENT leading buckets; banding is the
  // only reason it folds at all.
  const other = `${WIRE} Reuters reported.`;
  assert.notEqual(bucketOf(simhash(WIRE)), bucketOf(simhash(other)), "the fixture must straddle two buckets");
  assert.equal(hammingDistance(simhash(WIRE), simhash(other)), 2);

  const items = [item("a", WIRE, "2026-08-20T09:00:00.000Z"), item("b", other, "2026-08-20T11:00:00.000Z")];
  const groups = foldNearDuplicates(items, { maxBits: 3 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].lead.id, "a", "the earliest telling leads the group");
});

test("an unusable simhash is refused rather than reported as maximally different", () => {
  // Returning 64 for a bad value reads as "completely different", so a
  // comparison that is entirely broken looks exactly like a working one that
  // happened to find no matches.
  for (const bad of ["", "zzzz", "abc", "0123456789abcdef0", 12, null, undefined]) {
    assert.throws(() => hammingDistance(simhash("a real string here"), bad), /16 hex characters/, String(bad));
  }
});

test("text-less items are never folded into one group about nothing", () => {
  // Two empty hashes are 0 bits apart, so left in the bands every unusable row
  // would fold into a single group that looks exactly like a real one.
  const items = [
    { id: "a", tokens: [], simhash: ZERO_SIMHASH, bucket: "0000", at: "2026-08-20T09:00:00.000Z" },
    { id: "b", tokens: [], simhash: ZERO_SIMHASH, bucket: "0000", at: "2026-08-20T10:00:00.000Z" },
  ];
  assert.equal(foldNearDuplicates(items).length, 2);
});

test("jaccard answers 0 for an empty side rather than NaN or a perfect match", () => {
  assert.equal(jaccard([], ["a"]), 0);
  assert.equal(jaccard([], []), 0, "two rows we know nothing about are not the same story");
  near(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
});

/* ── stage 1 and stage 2 ───────────────────────────────────────────────── */

/** An item as `itemForRow` builds one, for tests that do not need a row. */
const item = (id, text, at) => ({ id, text, tokens: tokenize(text), simhash: simhash(text), bucket: bucketOf(simhash(text)), at });

/** Two angles on one funding round, and one unrelated policy story. */
const ANGLES = [
  {
    id: "r1",
    title: "Anthropic raises 3.5 billion dollars at a 61.5 billion valuation",
    aiSummary: "Anthropic said the Series E round was led by Lightspeed Venture Partners and values the company at 61.5 billion dollars.",
    publishedAt: "2026-08-20T09:00:00.000Z",
  },
  {
    id: "r2",
    title: "What Lightspeed sees in Anthropic: inside the 61.5 billion valuation",
    aiSummary: "Investors backing the Series E say Anthropic enterprise revenue growth justifies the price; Lightspeed led the round.",
    publishedAt: "2026-08-21T09:00:00.000Z",
  },
  {
    id: "r3",
    title: "Beijing publishes draft rules for generative video labelling",
    aiSummary: "The Cyberspace Administration would require provenance labels on synthetic video and an audit trail for training data.",
    publishedAt: "2026-08-21T10:00:00.000Z",
  },
];

test("different angles on one event cluster although their simhashes are far apart", () => {
  // The bug this protects against: blocking stage 2 on the simhash bucket, as
  // stage 1 does. Stage 1 and stage 2 are opposite problems — stage 1 folds
  // near-identical text, stage 2 joins DIFFERENT WORDING about one event, and
  // different wording is tens of bits and a different prefix. Bucket-blocked,
  // stage 2 returns stage 1's output, the pass spends one extraction call per
  // ARTICLE, and `clusters` and `extracted` are both still plausible numbers.
  const items = ANGLES.map(itemForRow);
  assert.ok(hammingDistance(items[0].simhash, items[1].simhash) > 12, "the two angles are far apart by hash");
  assert.notEqual(items[0].bucket, items[1].bucket, "and in different buckets");

  const clusters = clusterItems(items);
  assert.deepEqual(clusters.map((c) => c.members.map((m) => m.id)), [["r1", "r2"], ["r3"]]);
  assert.equal(clusters[0].spanDays, 1);
});

test("the clustering window is measured between the sources, never against the clock", () => {
  // Keyed on the present, a pass that ran late would fragment a story it would
  // have clustered on time — and the fragments look like ordinary singletons.
  const items = ANGLES.map(itemForRow);
  const stale = items.map((entry) => (entry.id === "r2" ? { ...entry, at: "2026-09-30T09:00:00.000Z" } : entry));
  const clusters = clusterItems(stale, { windowDays: 7 });
  assert.deepEqual(clusters.map((c) => c.members.map((m) => m.id)).sort(), [["r1"], ["r2"], ["r3"]].sort());
  assert.deepEqual(
    clusterItems(stale, { windowDays: 60 }).map((c) => c.members.map((m) => m.id))[0],
    ["r1", "r2"],
    "a wide enough window joins them again, so it is the window doing the work",
  );
});

test("a row with no usable title is skipped rather than clustered as a blank", () => {
  // Returning a blank item would put a source with no text into a cluster and
  // then into a prompt, where the model would fill the gap from what it
  // remembers. Undefined lets the caller COUNT what it skipped.
  assert.equal(itemForRow({ id: "r", title: "   ", sourceUrl: "https://x.test/1" }), undefined);
  assert.equal(itemForRow({ title: "no id at all" }), undefined);
  assert.equal(itemForRow(null), undefined);
});

test("an item is dated by the event, not by when it was collected", () => {
  const built = itemForRow({ id: "r", title: "A paper from 2024", publishedAt: "2024-03-01T00:00:00.000Z", createdAt: "2026-08-23T00:00:00.000Z" });
  assert.equal(built.at, "2024-03-01T00:00:00.000Z", "a two-year-old paper harvested today is not today's story");
});

test("a runaway cluster drops its excess rather than folding it into a neighbour", () => {
  // Dropped outright, never merged into the next cluster along: a source
  // pushed into a story it is not about would be quoted under a claim it never
  // made, and the card would look exactly like a correct one.
  const many = Array.from({ length: 8 }, (_, index) => item(`r${index}`, WIRE, `2026-08-${20 + index}T09:00:00.000Z`));
  const clusters = clusterItems(many, { windowDays: 60, maxClusterSize: 3 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members.map((m) => m.id), ["r5", "r6", "r7"], "the most recent members are kept");
});

/* ── stage 4: quote verification, the guard the whole design rests on ──── */

/** A material block in the shape `sourceMaterial` produces: header, blank line, body. */
const block = (title, body) => `## ${title}\nPublication: NEWS\nDate: 2026-08-20\nURL: https://news.test/x\n\n${body}`;

const BODY = 'Anthropic said on Monday that it had raised $3.5bn in a Series E round led by Lightspeed, valuing the company at $61.5bn. One investor called it "a decisive moment for the company".';
const S1 = block("Anthropic raises $3.5bn at a $61.5bn valuation", BODY);
const S3 = block("Inside the Lightspeed bet", "Two people familiar with the matter said the term sheet was signed in a fortnight.");

test("a quote copied out of the source is accepted", () => {
  assert.equal(quoteIsVerbatim("raised $3.5bn in a Series E round led by Lightspeed", S1), true);
});

test("re-wrapped lines and typographic quotes are forgiven, and nothing else is", () => {
  // Models re-wrap and substitute curly quotes while otherwise copying
  // faithfully. Those are the only two differences that may ever be normalised
  // away: every further one is another way for an invented quote to pass.
  assert.equal(quoteIsVerbatim("raised $3.5bn in a Series E\n   round led by Lightspeed", S1), true);
  assert.equal(quoteIsVerbatim("One investor called it “a decisive moment for the company”", S1), true);
  assert.equal(normalizeForQuote("  a  b c\n\nd  "), "a b c d");
});

test("an invented quote is rejected", () => {
  assert.equal(quoteIsVerbatim("Anthropic said it would build a data centre in Wales", S1), false);
});

test("a quote that differs by more than whitespace is rejected", () => {
  // Each of these is what a model does when it is copying from memory rather
  // than from the block: it tidies. Accepting any of them makes the check
  // decoration — the claim would carry a source's name under a sentence that
  // source never wrote.
  assert.equal(quoteIsVerbatim("raised $3.5 billion in a Series E round led by Lightspeed", S1), false, "an expanded abbreviation");
  assert.equal(quoteIsVerbatim("raised $3.5bn in a Series E round … valuing the company at $61.5bn", S1), false, "two places joined by an ellipsis");
  assert.equal(quoteIsVerbatim("Anthropic said on Monday it had raised $3.5bn in a Series E", S1), false, "a dropped word");
  assert.equal(quoteIsVerbatim("RAISED $3.5BN IN A SERIES E ROUND LED BY LIGHTSPEED", S1), false, "a case change is not whitespace");
});

test("a quote copied out of the block's header proves nothing and is rejected", () => {
  // `sourceMaterial` opens every block with `## <title>`, `Publication:`,
  // `Date:` and `URL:`. A quote taken from those lines verifies perfectly and
  // is circular: the model is quoting the label we handed it, not the source.
  assert.equal(quoteIsVerbatim("Anthropic raises $3.5bn at a $61.5bn valuation", S1), false);
  assert.equal(quoteIsVerbatim("URL: https://news.test/x", S1), false);
  assert.equal(
    quoteIsVerbatim("plain text with no material header at all here", "plain text with no material header at all here"),
    true,
    "a block with no such header is searched whole, so honest claims are not cut at a blank line",
  );
});

test("a quote attributed to the wrong source is a misattribution, not a match", () => {
  // The quote below is real — it is just in S3. Accepting it puts the wrong
  // outlet's name under the claim on the card, with every count still correct
  // and nothing anywhere reporting an error.
  const blocks = new Map([["s1", S1], ["s3", S3]]);
  const quote = "the term sheet was signed in a fortnight";
  assert.deepEqual(verifyQuote(quote, blocks, "s3"), { ok: true, resourceId: "s3" });
  assert.deepEqual(verifyQuote(quote, blocks, "s1"), { ok: false, reason: "not found in the source it is attributed to" });
});

test("a quote too short to prove anything is rejected, by the floor for its script", () => {
  // A six-character fragment is a literal substring of almost any source: it
  // passes verification and proves nothing. The CJK floor is lower because
  // applying 20 characters to Chinese would discard almost every valid Chinese
  // quote and the pass would report a drop rate that reads as a bad model.
  const zh = block("标题", "该公司表示已完成三十五亿美元融资，估值六百一十五亿美元。");
  assert.equal(MIN_QUOTE_CHARS, 20);
  assert.equal(MIN_QUOTE_CJK_CHARS, 8);
  assert.equal(quoteIsVerbatim("a Series E", S1), false, "ten Latin characters is not evidence");
  assert.equal(quoteIsVerbatim("该公司表示", zh), false, "five CJK characters is below the CJK floor");
  assert.equal(quoteIsVerbatim("该公司表示已完成三十五亿美元融资", zh), true, "a full Chinese clause is");
});

test("verifyQuote reports one of the three fixed reasons", () => {
  // The pass counts these: "too short" measures the prompt and "not found"
  // measures hallucination, and the week-one number is worthless if a fourth
  // reason quietly splits the histogram.
  const blocks = { s1: S1 };
  assert.equal(verifyQuote("too short", blocks, "s1").reason, "too short");
  assert.equal(verifyQuote("raised $3.5bn in a Series E round led by Lightspeed", blocks, "s9").reason, "no such source");
  assert.equal(verifyQuote("Anthropic will open an office in Cardiff next spring", blocks, "s1").reason, "not found in the source it is attributed to");
  assert.equal(verifyQuote("raised $3.5bn in a Series E round led by Lightspeed", {}).reason, "no such source");
});

test("an inherited property of the blocks object is not a source", () => {
  // A block map keyed by resource id is a plain object in the route layer, and
  // `toString` is on every one of them. Reading it as a block would verify a
  // quote against JavaScript's own code.
  assert.equal(verifyQuote("raised $3.5bn in a Series E round led by Lightspeed", { s1: S1 }, "toString").reason, "no such source");
  assert.deepEqual(verifyQuote("raised $3.5bn in a Series E round led by Lightspeed", { constructor: S1 }, "constructor"), {
    ok: true,
    resourceId: "constructor",
  });
});

/* ── independence ──────────────────────────────────────────────────────── */

test("five rewrites of one wire story share one independence key", () => {
  // Independence means DISTINCT SOURCE, not distinct article. Counting five
  // rewrites as five sources is exactly how a system manufactures the
  // confidence this feature exists to avoid.
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `r${index}`,
    type: "NEWS",
    sourceType: "Reuters",
    sourceUrl: `https://www.reuters.com/story-${index}`,
  }));
  assert.equal(new Set(rows.map(sourceKeyOf)).size, 1);
  assert.equal(sourceKeyOf(rows[0]), "reuters");
});

test("a source key falls back rather than throwing on a malformed URL", () => {
  // `store.js` guards `new URL` for the same reason: a malformed URL is
  // stored, not rejected, and a throw here would abandon a whole pass over one
  // bad row.
  assert.equal(sourceKeyOf({ sourceUrl: "https://www.Example.com/a" }), "example.com");
  assert.equal(sourceKeyOf({ sourceUrl: "http://", type: "NEWS" }), "type:NEWS");
  assert.equal(sourceKeyOf({}), "unknown", "every unkeyable source collapses into one key, so ten of them count as one");
});

/* ── stage 6: the four scores ──────────────────────────────────────────── */

test("the weights blend to exactly one", () => {
  // A blend that quietly stops summing to 1 reorders the whole tab without
  // failing anything. The tolerance is deliberate: these four decimals add to
  // 0.9999999999999999 in binary, and an exact check would fail against
  // correct weights and invite somebody to "fix" the weights.
  const sum = Object.values(SCORE_WEIGHTS).reduce((total, weight) => total + weight, 0);
  near(sum, 1, "SCORE_WEIGHTS");
});

test("novelty decays from one to zero across the window", () => {
  const now = "2026-08-23T00:00:00.000Z";
  assert.equal(scoreNovelty({ firstSeenAt: now, now, windowDays: 7 }), 1);
  near(scoreNovelty({ firstSeenAt: "2026-08-19T12:00:00.000Z", now, windowDays: 7 }), 0.5);
  assert.equal(scoreNovelty({ firstSeenAt: "2026-08-16T00:00:00.000Z", now, windowDays: 7 }), 0, "a week old is not news");
  assert.equal(scoreNovelty({ firstSeenAt: "2026-07-01T00:00:00.000Z", now, windowDays: 7 }), 0, "and older does not go negative");
});

test("an unparseable first-seen stamp scores zero novelty, not one", () => {
  // `daysBetween` answers 0 for an unparseable pair, and `1 - 0/7` is the
  // MAXIMUM — one corrupt row would pin itself to the top of the default sort
  // forever and never go dormant.
  assert.equal(scoreNovelty({ firstSeenAt: "yesterday", now: "2026-08-23T00:00:00.000Z" }), 0);
  assert.equal(scoreNovelty({ firstSeenAt: "2026-08-23T00:00:00.000Z", now: "soon" }), 0);
  assert.equal(daysBetween("yesterday", "2026-08-23T00:00:00.000Z"), 0, "the reader's own answer stays 0, not NaN");
});

test("momentum counts independent sources and never articles", () => {
  const now = "2026-08-23T00:00:00.000Z";
  const at = (independentCount) => scoreMomentum({ independentCount, lastSeenAt: now, now, dormantDays: 21 });
  assert.equal(at(1), 0, "one source is not momentum however loudly it repeats itself");
  near(at(2), 1 / 3);
  assert.equal(at(4), 1);
  assert.equal(at(9), 1, "and it is clamped, not unbounded");
  // The false-confidence failure the feature exists to avoid: five rewrites of
  // one wire story are `sourceCount: 5` and `independentCount: 1`, and reading
  // the wrong one scores them as four independent outlets agreeing.
  assert.equal(scoreMomentum({ independentCount: 1, sourceCount: 5, lastSeenAt: now, now }), 0);
});

test("momentum's recency floor keeps a stale claim above zero without keeping it near the top", () => {
  const now = "2026-08-23T00:00:00.000Z";
  near(scoreMomentum({ independentCount: 4, lastSeenAt: "2026-08-12T12:00:00.000Z", now, dormantDays: 21 }), 1 - 10.5 / 21);
  assert.equal(scoreMomentum({ independentCount: 4, lastSeenAt: "2025-01-01T00:00:00.000Z", now, dormantDays: 21 }), 0.15);
  assert.equal(scoreMomentum({ independentCount: 4, lastSeenAt: "not a date", now }), 0.15, "an unreadable stamp takes the floor, not the full mark");
});

test("credibility is max-weighted and mean-blended over supporting evidence only", () => {
  assert.equal(scoreCredibility([]), 0);
  assert.equal(scoreCredibility([{ stance: "contradicts", resourceType: "PAPER" }]), 0, "nothing supports it");
  assert.equal(scoreCredibility([{ stance: "supports", resourceType: "PAPER" }]), CREDIBILITY_WEIGHTS.PAPER);
  // One paper is worth more than four blogs restating it, and four blogs are
  // still worth more than one: 0.6 * max + 0.4 * mean.
  near(scoreCredibility([{ stance: "supports", resourceType: "PAPER" }, { stance: "supports", resourceType: "NEWS" }]), 0.9);
  near(scoreCredibility([{ stance: "supports", resourceType: "BLOG" }, { stance: "supports", resourceType: "BLOG" }]), 0.55);
});

test("credibility reads the denormalised type, so a pruned source cannot re-rank the tab", () => {
  // The evidence row keeps `resourceType` precisely because the library row
  // may be gone. Read through the join instead, a PAPER (1.0) silently becomes
  // an unknown type (0.4) and the claim it backed slides down the list.
  const pruned = [{ stance: "supports", resourceType: "PAPER", resource: null }];
  assert.equal(scoreCredibility(pruned), 1);
  assert.equal(scoreCredibility([{ stance: "supports", resourceType: "" }]), CREDIBILITY_WEIGHTS.DEFAULT);
  assert.equal(scoreCredibility([{ stance: "supports", resourceType: "constructor" }]), CREDIBILITY_WEIGHTS.DEFAULT, "own properties only");
});

test("relevance is the share of support in the types this reader publishes", () => {
  const preferredResourceTypes = ["NEWS", "PAPER"];
  near(scoreRelevance({ evidenceResourceTypes: ["NEWS", "PAPER", "BLOG"], preferredResourceTypes }), 2 / 3);
  assert.equal(scoreRelevance({ evidenceResourceTypes: [], preferredResourceTypes }), 0);
  // 0 and not 1 for an empty preference: an unanswered question is not a
  // perfect match, and scoring it 1 ranks every claim identically.
  assert.equal(scoreRelevance({ evidenceResourceTypes: ["NEWS"], preferredResourceTypes: [] }), 0);
  // The two vocabularies both spelt "kind" upstream. Wiring the CLAIM kinds in
  // here scores every card's relevance zero forever, and nothing throws.
  assert.equal(scoreRelevance({ evidenceResourceTypes: ["NEWS"], preferredResourceTypes: INSIGHT_KINDS }), 0);
});

test("scoring refuses to read the clock for you", () => {
  // A default of `new Date()` here is the one shortcut that makes every
  // scoring test pass while proving nothing about the behaviour the scores
  // exist for.
  assert.throws(() => scoreInsight({ firstSeenAt: "2026-08-23T00:00:00.000Z" }, []), /options\.now/);
});

test("rank is the weighted blend of the four, and nothing else", () => {
  const now = "2026-08-23T00:00:00.000Z";
  const scores = scoreInsight(
    { firstSeenAt: now, lastSeenAt: now, independentCount: 4 },
    [{ stance: "supports", resourceType: "PAPER" }, { stance: "supports", resourceType: "NEWS" }],
    { now, windowDays: 7, dormantDays: 21, preferredResourceTypes: ["PAPER", "NEWS"] },
  );
  assert.deepEqual({ ...scores, rank: undefined }, { novelty: 1, relevance: 1, credibility: 0.9, momentum: 1, rank: undefined });
  near(scores.rank, 0.35 * 1 + 0.30 * 0.9 + 0.20 * 1 + 0.15 * 1);
  for (const [field, value] of Object.entries(scores)) assert.ok(value >= 0 && value <= 1, `${field} is inside 0..1`);
});

/* ── status ────────────────────────────────────────────────────────────── */

test("a person's verdict outranks the pass", () => {
  // Without this, dismiss is a button that works until the next tick quietly
  // undoes it, and nothing on the page says so.
  const now = "2026-08-23T00:00:00.000Z";
  const pinned = { pinnedStatus: "dormant", independentCount: 9, contradictionCount: 3, lastSeenAt: now };
  assert.equal(nextStatus(pinned, {}, { now }), "dormant");
  assert.equal(nextStatus({ ...pinned, pinnedStatus: "nonsense" }, {}, { now }), "contested", "a pin outside the vocabulary is not a verdict");
});

test("promotion to standing waits for a second independent source", () => {
  const now = "2026-08-23T00:00:00.000Z";
  const claim = (independentCount) => ({ independentCount, contradictionCount: 0, lastSeenAt: now });
  assert.equal(nextStatus(claim(1), {}, { now, minIndependent: 2 }), "candidate");
  assert.equal(nextStatus(claim(2), {}, { now, minIndependent: 2 }), "standing");
  assert.equal(nextStatus(claim(2), {}, { now, minIndependent: 3 }), "candidate", "the threshold is the setting, not a constant");
});

test("dormancy wins over contested, so a two-year-old disagreement leaves the front page", () => {
  // Contested first would mean a contested claim can never go dormant, and the
  // default list clause shows every live status — so an old disagreement would
  // sit on the front page forever and be re-scored on every sweep. Nothing is
  // hidden by this: the 有分歧 chip filters on contradiction_count, not status.
  const now = "2026-08-23T00:00:00.000Z";
  const old = { independentCount: 4, contradictionCount: 2, lastSeenAt: "2025-08-23T00:00:00.000Z" };
  assert.equal(nextStatus(old, {}, { now, dormantDays: 21 }), "dormant");
  assert.equal(nextStatus({ ...old, lastSeenAt: now }, {}, { now, dormantDays: 21 }), "contested");
});

/* ── stage 5: the lexical prefilter ────────────────────────────────────── */

test("the prefilter says which of its three tests fired", () => {
  const a = { statement: "Anthropic raised $3.5bn at a $61.5bn valuation in March 2026", simhash: simhash("Anthropic raised $3.5bn at a $61.5bn valuation in March 2026"), entities: ["Anthropic", "Lightspeed"] };
  const b = { statement: "Anthropic closed a $3.5bn round valuing it at $61.5bn in March 2026", simhash: simhash("Anthropic closed a $3.5bn round valuing it at $61.5bn in March 2026"), entities: ["Anthropic", "Lightspeed"] };
  const far = { statement: "Beijing published draft labelling rules for synthetic video", simhash: simhash("Beijing published draft labelling rules for synthetic video"), entities: ["CAC"] };
  assert.equal(statementsMatch(a, b).near, true);
  assert.equal(statementsMatch(a, b).sharedEntities, 2);
  assert.equal(statementsMatch(a, far).near, false);
});

test("the prefilter refuses a JSON string where an entity array belongs", () => {
  // Reading the raw column would count zero shared entities for every pair
  // forever: one of the three tests would simply never fire, with no error, no
  // log, and only fewer merges to show for it.
  const hash = simhash("a statement long enough to hash");
  assert.throws(
    () => statementsMatch({ statement: "x", simhash: hash, entities: '["Anthropic"]' }, { statement: "y", simhash: hash, entities: ["Anthropic"] }),
    /entities as an array/,
  );
});

test("two text-less statements are not the same claim", () => {
  // They are 0 bits apart, so the hash test alone would merge every such row
  // into the first one.
  const empty = { statement: "", simhash: ZERO_SIMHASH, entities: [] };
  assert.equal(statementsMatch(empty, { ...empty }).near, false);
});

/* ── the store ─────────────────────────────────────────────────────────── */

/** A fresh in-memory library with its insight tables, closed when the test ends. */
function library(t) {
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  return { store, insights: openInsightStore(store) };
}

/** A resource row as the collector stores one. */
const resource = (id, overrides = {}) => ({
  id,
  type: "NEWS",
  title: `Story ${id}`,
  sourceUrl: `https://news.test/${id}`,
  sourceType: "Reuters",
  publishedAt: "2026-08-20T00:00:00.000Z",
  ...overrides,
});

/** A claim, with everything the store insists on. */
const claim = (insights, overrides = {}) =>
  insights.upsertInsight({
    statement: "Anthropic raised $3.5bn at a $61.5bn valuation in March 2026",
    kind: "funding",
    entities: ["Anthropic", "Lightspeed"],
    simhash: simhash("Anthropic raised $3.5bn at a $61.5bn valuation in March 2026"),
    firstSeenAt: "2026-08-20T00:00:00.000Z",
    lastSeenAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  });

/** An evidence row, quote long enough to clear the Latin floor. */
const evidence = (resourceId, overrides = {}) => ({
  resourceId,
  stance: "supports",
  quote: "raised $3.5bn in a Series E round led by Lightspeed",
  sourceKey: "reuters",
  addedAt: "2026-08-20T00:00:00.000Z",
  ...overrides,
});

test("the schema stamps no version of its own", (t) => {
  // store.js stamps `user_version` 1 and throws for anything else at open. A
  // second module bumping the stamp makes every existing library refuse to
  // open at the NEXT boot, on somebody else's machine, presenting as a corrupt
  // database rather than as a schema mismatch. Checked as a grep over the DDL
  // because that is how a reviewer checks it too.
  assert.ok(!/pragma/i.test(INSIGHT_DDL), "the insight DDL must contain no directive of that kind, comments included");
  const { store } = library(t);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 1);
});

test("the insight store is one per library, and is not opened from a path", (t) => {
  const { store, insights } = library(t);
  assert.ok(insights instanceof InsightStore);
  assert.equal(openInsightStore(store), insights, "two instances would be two places to look when a statement is wrong");
  assert.throws(() => openInsightStore("/tmp/library.sqlite"), /not a path/);
  assert.equal(typeof insights.close, "undefined", "the handle belongs to the SourceStore");
});

test("an id is minted sortable and is recognised again", () => {
  const id = newInsightId(new Date("2026-08-23T09:00:00.000Z"));
  assert.match(id, /^insight-20260823T090000Z-[0-9a-f]{8}$/);
  assert.equal(isInsightId(id), true);
  for (const bad of ["insight-x", "../etc/passwd", `${id}/status`, "", null]) assert.equal(isInsightId(bad), false, String(bad));
});

test("a claim is stored and read back whole", (t) => {
  const { insights } = library(t);
  const id = claim(insights);
  const row = insights.get(id);
  assert.deepEqual(row.entities, ["Anthropic", "Lightspeed"], "entities come back as an array, not as JSON text");
  assert.equal(row.status, "candidate");
  assert.equal(row.pinnedStatus, null);
  assert.equal(row.effectiveStatus, "candidate");
  assert.equal(row.sourceCount, 0);
  assert.equal(insights.get("insight-nope"), undefined);
});

test("a re-extraction of the same claim keeps its history and moves only its last-seen", (t) => {
  // `first_seen_at` is the column that makes "since when" answerable, and it
  // is what novelty decays from. Overwritten on every pass, every standing
  // card would read as brand new forever and the tab would never settle.
  const { insights } = library(t);
  const id = claim(insights);
  claim(insights, { id, firstSeenAt: "2026-08-25T00:00:00.000Z", lastSeenAt: "2026-08-25T00:00:00.000Z" });
  const row = insights.get(id);
  assert.equal(row.firstSeenAt, "2026-08-20T00:00:00.000Z");
  assert.equal(row.lastSeenAt, "2026-08-25T00:00:00.000Z");
  claim(insights, { id, lastSeenAt: "2026-08-21T00:00:00.000Z" });
  assert.equal(insights.get(id).lastSeenAt, "2026-08-25T00:00:00.000Z", "last-seen never goes backwards either");
});

test("a claim the pipeline could not hash is refused at the write", (t) => {
  // The all-zero hash is what `simhash` returns for text it could not
  // tokenize. Two such rows are 0 bits apart, so the prefilter calls them the
  // same claim and every text-less card swallows every other.
  const { insights } = library(t);
  assert.throws(() => claim(insights, { simhash: ZERO_SIMHASH }), /all zeroes/);
  assert.throws(() => claim(insights, { simhash: "ABCDEF0123456789" }), /16 lowercase hex/);
  assert.throws(() => claim(insights, { kind: "NEWS" }), /kind must be one of/, "a resource type is not a claim kind");
  assert.throws(() => claim(insights, { statement: "   " }), /needs a statement/);
});

test("a timestamp SQLite would happily store and every reader would misread is refused", (t) => {
  // STRICT enforces TEXT and nothing more, so "yesterday" is a valid value for
  // a timestamp column — and a row carrying one scores maximum novelty and
  // never goes dormant.
  const { insights } = library(t);
  for (const bad of ["yesterday", "2026-08-20", "2026-08-20 09:00:00", "2026-08-20T09:00:00", 1755648000000]) {
    assert.throws(() => claim(insights, { firstSeenAt: bad }), /ISO 8601/, JSON.stringify(bad));
  }
  // Absent is not malformed: an omitted stamp means "now", which is how the
  // extractor mints a first sighting.
  assert.ok(isInsightId(claim(insights, { firstSeenAt: undefined, lastSeenAt: undefined })));
});

test("evidence attached to nothing is refused rather than written into the dark", (t) => {
  // It is precisely the shape of failure that leaves a card reporting six
  // sources it cannot show.
  const { insights } = library(t);
  assert.throws(() => insights.addEvidence("insight-nope", [evidence("r1")]), /no insight/);
});

test("five rows from one source count as one independent source", (t) => {
  // The promotion rule reads `independentCount`. Counting articles instead
  // promotes a single wire story rewritten five times, which is the
  // manufactured confidence the whole feature exists to avoid.
  const { store, insights } = library(t);
  store.putMany(Array.from({ length: 5 }, (_, index) => resource(`r${index}`)));
  const id = claim(insights);
  const result = insights.addEvidence(id, Array.from({ length: 5 }, (_, index) => evidence(`r${index}`)));
  assert.equal(result.added, 5);
  assert.deepEqual(result.counts, { sourceCount: 5, independentCount: 1, contradictionCount: 0 });
  assert.equal(insights.get(id).independentCount, 1);
});

test("a candidate becomes standing on its second independent source, and not before", (t) => {
  const { store, insights } = library(t);
  const now = "2026-08-21T00:00:00.000Z";
  store.putMany([resource("r1"), resource("r2", { sourceType: "Bloomberg", sourceUrl: "https://bloomberg.test/2" })]);
  const id = claim(insights);

  insights.addEvidence(id, [evidence("r1")]);
  const first = insights.get(id);
  assert.equal(nextStatus(first, {}, { now, minIndependent: 2 }), "candidate");

  insights.addEvidence(id, [evidence("r2", { sourceKey: "bloomberg" })]);
  const second = insights.get(id);
  assert.equal(second.independentCount, 2);
  const scores = scoreInsight(second, insights.listEvidence(id), { now, preferredResourceTypes: ["NEWS"] });
  const status = nextStatus(second, scores, { now, minIndependent: 2 });
  assert.equal(status, "standing");

  assert.equal(insights.applyScores(id, scores, { status, now }), true);
  const stored = insights.get(id);
  assert.equal(stored.status, "standing");
  assert.equal(stored.scoredAt, now, "a stored score with no stamp cannot be told from a fresh one");
  near(stored.rankScore, scores.rank);
  assert.deepEqual(insights.list({ status: "standing", now }).insights.map((row) => row.id), [id]);
});

test("a contradiction is recorded beside the support, not instead of it", (t) => {
  // Two cards saying opposite things is what the tab exists to replace, so the
  // disagreement is stored ON the claim it disagrees with. If it overwrote the
  // support, the card would show a lone ✗ and `sourceCount` would fall with
  // nothing reporting a change.
  const { store, insights } = library(t);
  store.putMany([resource("r1"), resource("r2", { sourceType: "Bloomberg", sourceUrl: "https://bloomberg.test/2" })]);
  const id = claim(insights);
  insights.addEvidence(id, [evidence("r1")]);
  const result = insights.addEvidence(id, [evidence("r2", {
    stance: "contradicts",
    sourceKey: "bloomberg",
    quote: "the round has not closed and no term sheet has been signed",
    addedAt: "2026-08-21T00:00:00.000Z",
  })]);

  assert.deepEqual(result.counts, { sourceCount: 1, independentCount: 1, contradictionCount: 1 });
  const rows = insights.listEvidence(id);
  assert.equal(rows.length, 2, "both rows survive");
  assert.equal(rows[0].stance, "contradicts", "the disagreement is what a reader opened the card for");
  assert.equal(rows[1].stance, "supports");
  assert.equal(nextStatus(insights.get(id), {}, { now: "2026-08-21T00:00:00.000Z" }), "contested");
  assert.deepEqual(insights.list({ filter: "contested", now: "2026-08-21T00:00:00.000Z" }).insights.map((r) => r.id), [id]);
});

test("a later pass cannot flip one source's support into a contradiction", (t) => {
  // Letting any stance overwrite any other lets reconciliation turn an
  // existing `supports` row into `contradicts` on the same card: recount then
  // decrements sourceCount, increments contradictionCount and demotes a
  // standing claim, with no error and no log anywhere.
  const { store, insights } = library(t);
  store.putMany([resource("r1")]);
  const id = claim(insights);
  insights.addEvidence(id, [evidence("r1")]);
  const result = insights.addEvidence(id, [evidence("r1", { stance: "contradicts", quote: "no such round was ever agreed by the board" })]);
  assert.equal(result.conflicted, 1);
  assert.equal(result.updated, 0);
  assert.equal(insights.listEvidence(id)[0].stance, "supports", "the original stance stands");
  assert.deepEqual(result.counts, { sourceCount: 1, independentCount: 1, contradictionCount: 0 });
});

test("a context row may be upgraded once the pass learns what it was", (t) => {
  const { store, insights } = library(t);
  store.putMany([resource("r1")]);
  const id = claim(insights);
  insights.addEvidence(id, [evidence("r1", { stance: "context" })]);
  const result = insights.addEvidence(id, [evidence("r1", { stance: "contradicts", quote: "no such round was ever agreed by the board" })]);
  assert.equal(result.updated, 1);
  assert.equal(result.conflicted, 0);
  assert.equal(insights.listEvidence(id)[0].stance, "contradicts");
});

test("a caller's bad evidence row is counted rather than silently dropped or thrown over", (t) => {
  const { store, insights } = library(t);
  store.putMany([resource("r1")]);
  const id = claim(insights);
  const result = insights.addEvidence(id, [
    evidence("r1"),
    evidence("r2", { quote: "   " }),
    evidence("r3", { stance: "agrees" }),
    evidence(""),
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 3, "the count is what surfaces a caller bug; throwing would lose the good row beside it");
  assert.deepEqual(EVIDENCE_STANCES, ["supports", "contradicts", "context"]);
});

test("the evidence row carries its source's type, so a prune cannot re-weight the card", (t) => {
  const { store, insights } = library(t);
  store.putMany([resource("r1", { type: "PAPER" })]);
  const id = claim(insights);
  insights.addEvidence(id, [evidence("r1")]);
  store.db.prepare("DELETE FROM resources WHERE id = ?").run("r1");

  const [row] = insights.listEvidence(id);
  assert.equal(row.resource, null, "the library no longer holds it, and the page says so");
  assert.equal(row.resourceType, "PAPER", "but the weight the card was ranked on survives");
  assert.equal(scoreCredibility(insights.listEvidence(id)), 1);
  assert.equal(insights.get(id).sourceCount, 1, "and the count does not quietly fall");
});

test("a pruned source leaves the quote on the card rather than disagreeing with the count", (t) => {
  const { store, insights } = library(t);
  store.putMany([resource("r1")]);
  const id = claim(insights);
  insights.addEvidence(id, [evidence("r1"), evidence("r2", { sourceKey: "ft" })]);
  const [preview] = insights.list({ now: "2026-08-21T00:00:00.000Z" }).insights;
  assert.equal(preview.evidencePreview.length, 2);
  const missing = preview.evidencePreview.find((row) => row.resourceId === "r2");
  assert.deepEqual([missing.title, missing.sourceUrl, missing.type], [null, null, null]);
  assert.equal(missing.sourceKey, "ft", "the key is still shown, so the row is not a blank");
});

test("the card preview is two supports and one contradiction, newest first", (t) => {
  // Fetched with one query over the whole page. The obvious implementation is
  // an N+1: twenty round trips per render that nothing reports.
  const { store, insights } = library(t);
  store.putMany(Array.from({ length: 5 }, (_, index) => resource(`r${index}`)));
  const id = claim(insights);
  insights.addEvidence(id, [
    evidence("r0", { addedAt: "2026-08-20T01:00:00.000Z" }),
    evidence("r1", { addedAt: "2026-08-20T02:00:00.000Z" }),
    evidence("r2", { addedAt: "2026-08-20T03:00:00.000Z" }),
    evidence("r3", { stance: "contradicts", quote: "no such round was ever agreed by the board", addedAt: "2026-08-20T04:00:00.000Z" }),
    evidence("r4", { stance: "context", addedAt: "2026-08-20T05:00:00.000Z" }),
  ]);
  const [row] = insights.list({ now: "2026-08-21T00:00:00.000Z" }).insights;
  assert.deepEqual(row.evidencePreview.map((entry) => [entry.resourceId, entry.stance]), [
    ["r2", "supports"],
    ["r1", "supports"],
    ["r3", "contradicts"],
  ]);
});

test("the default page shows candidates and hides only what has gone dormant", (t) => {
  // Hiding candidates by default gives the first day an empty tab, which reads
  // as a broken feature rather than as a sprawl control.
  const { insights } = library(t);
  const now = "2026-08-21T00:00:00.000Z";
  const a = claim(insights, { statement: "Claim one about Anthropic and Lightspeed" , simhash: simhash("Claim one about Anthropic and Lightspeed") });
  const b = claim(insights, { statement: "Claim two about Beijing and labelling rules", simhash: simhash("Claim two about Beijing and labelling rules") });
  insights.applyScores(b, { novelty: 0, relevance: 0, credibility: 0, momentum: 0, rank: 0 }, { status: "dormant", now });

  const page = insights.list({ now });
  assert.deepEqual(page.insights.map((row) => row.id), [a]);
  assert.equal(page.total, 1);
  assert.equal(page.hasMore, false);
  // The tally is always the whole library, whatever the filter, so the page
  // can offer "+N candidates" without a second request.
  assert.deepEqual(page.counts, { candidate: 1, dormant: 1 });
  assert.deepEqual(insights.list({ status: "dormant", now }).insights.map((row) => row.id), [b]);
});

test("an unknown filter value is refused rather than answered with an empty page", (t) => {
  // An empty list from a typo is indistinguishable from an empty list from no
  // data: a filter that looks like it works and shows nothing.
  const { insights } = library(t);
  assert.throws(() => insights.list({ filter: "recent" }), /filter must be one of/);
  assert.throws(() => insights.list({ status: "pending" }), /status must be one of/);
  assert.throws(() => insights.list({ kind: "NEWS" }), /kind must be one of/);
  assert.deepEqual(INSIGHT_STATUSES, ["candidate", "standing", "contested", "dormant"]);
});

test("a person's pin survives the next pass", (t) => {
  // The failure this repo keeps producing: a control that reports success
  // while the thing it controls reverts at the next tick.
  const { insights } = library(t);
  const now = "2026-08-21T00:00:00.000Z";
  const id = claim(insights);
  assert.equal(insights.setStatus(id, "dormant", now), true);
  assert.equal(insights.get(id).effectiveStatus, "dormant");

  insights.applyScores(id, { novelty: 1, relevance: 1, credibility: 1, momentum: 1, rank: 1 }, { status: "standing", now });
  const row = insights.get(id);
  assert.equal(row.pinnedStatus, "dormant", "the pass never writes the pin");
  assert.equal(row.status, "standing", "its own verdict is still recorded");
  assert.equal(row.effectiveStatus, "dormant", "and the card renders the person's");
  assert.equal(nextStatus(row, {}, { now }), "dormant", "which the next pass then respects");

  assert.equal(insights.setStatus(id, null, now), true);
  assert.equal(insights.get(id).effectiveStatus, "standing", "clearing the pin hands the card back to the pass");
  assert.equal(insights.setStatus("insight-nope", "standing", now), false);
  assert.throws(() => insights.setStatus(id, "binned", now), /status must be one of/);
});

test("a score that is not a number is refused by name", (t) => {
  // A NaN in `rank_score` sorts the whole tab into an arbitrary order, every
  // SELECT still returns rows, and no page reports anything wrong.
  const { insights } = library(t);
  const id = claim(insights);
  const good = { novelty: 1, relevance: 1, credibility: 1, momentum: 1, rank: 1 };
  assert.throws(() => insights.applyScores(id, { ...good, rank: Number.NaN }), /score rank/);
  assert.throws(() => insights.applyScores(id, { ...good, momentum: undefined }), /score momentum/);
  insights.applyScores(id, { ...good, novelty: 4, relevance: -2 }, { now: "2026-08-21T00:00:00.000Z" });
  assert.equal(insights.get(id).novelty, 1, "an out-of-range score is clamped, not stored raw");
  assert.equal(insights.get(id).relevance, 0);
});

test("a claim that has never been scored is the most urgent one to score", (t) => {
  const { insights } = library(t);
  const now = "2026-08-21T00:00:00.000Z";
  const scored = claim(insights, { statement: "Claim one about Anthropic", simhash: simhash("Claim one about Anthropic") });
  const never = claim(insights, { statement: "Claim two about Beijing", simhash: simhash("Claim two about Beijing") });
  const dormant = claim(insights, { statement: "Claim three about Meta", simhash: simhash("Claim three about Meta") });
  const zero = { novelty: 0, relevance: 0, credibility: 0, momentum: 0, rank: 0 };
  insights.applyScores(scored, zero, { now: "2026-08-19T00:00:00.000Z" });
  insights.applyScores(dormant, zero, { status: "dormant", now: "2026-08-01T00:00:00.000Z" });

  assert.deepEqual(insights.dueForRescore({ before: now }), [never, scored]);
  assert.ok(!insights.dueForRescore({ before: now }).includes(dormant), "a dormant card is not swept");
  assert.throws(() => insights.dueForRescore({ before: "yesterday" }), /ISO 8601/);
});

test("superseding refuses to close a loop", (t) => {
  // A cycle makes the detail view's history walk run forever, which presents
  // as one card that never loads — a hang, not an error, in a page that
  // otherwise works.
  const { insights } = library(t);
  const now = "2026-08-21T00:00:00.000Z";
  const first = claim(insights, { statement: "Claim one about Anthropic", simhash: simhash("Claim one about Anthropic") });
  const second = claim(insights, { statement: "Claim two about Anthropic", simhash: simhash("Claim two about Anthropic") });
  assert.equal(insights.markSuperseded(first, second, now), true);
  assert.equal(insights.get(first).status, "dormant");
  assert.equal(insights.get(second).supersedes, first);
  assert.deepEqual({ ...insights.getWithEvidence(second).supersededRow }, { id: first, statement: "Claim one about Anthropic" });
  assert.deepEqual(insights.getWithEvidence(first).supersededBy.map((row) => row.id), [second]);

  assert.throws(() => insights.markSuperseded(second, first, now), /would close a loop/);
  assert.throws(() => insights.markSuperseded(first, first, now), /cannot supersede itself/);
  assert.throws(() => insights.markSuperseded("insight-nope", second, now), /no insight/);
});

test("removing a claim takes its evidence and every reference to it", (t) => {
  // A dangling `supersedes` renders as a history entry that cannot be opened —
  // a link to nothing, in the one view that exists to explain where a claim
  // came from.
  const { store, insights } = library(t);
  const now = "2026-08-21T00:00:00.000Z";
  store.putMany([resource("r1")]);
  const first = claim(insights, { statement: "Claim one about Anthropic", simhash: simhash("Claim one about Anthropic") });
  const second = claim(insights, { statement: "Claim two about Anthropic", simhash: simhash("Claim two about Anthropic") });
  insights.addEvidence(first, [evidence("r1")]);
  insights.markSuperseded(first, second, now);

  assert.equal(insights.remove(first), true);
  assert.equal(insights.get(first), undefined);
  assert.equal(insights.get(second).supersedes, null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM insight_evidence WHERE insight_id = ?").get(first).n, 0);
  assert.equal(insights.remove(first), false, "removing it twice is not an error, it is just false");
});

test("a source's own reader can say what it ended up supporting", (t) => {
  const { store, insights } = library(t);
  store.putMany([resource("r1")]);
  const id = claim(insights);
  insights.addEvidence(id, [evidence("r1")]);
  const [row] = insights.insightsForResource("r1");
  assert.equal(row.id, id);
  assert.equal(row.stance, "supports");
  assert.deepEqual(insights.insightsForResource("r-none"), [], "a source that backs no claim is an ordinary source");
});

test("reconciliation reads entities as an array, not as the raw column", (t) => {
  // Handed the JSON text, `statementsMatch` counts zero shared entities for
  // every pair forever and one of its three tests never fires.
  const { insights } = library(t);
  claim(insights);
  const [candidate] = insights.candidatesForMatch({});
  assert.deepEqual(candidate.entities, ["Anthropic", "Lightspeed"]);
  assert.equal(statementsMatch(candidate, candidate).sharedEntities, 2);
  assert.deepEqual(insights.candidatesForMatch({ since: "2026-08-25T00:00:00.000Z" }), [], "the window is honoured");
});

test("the health record counts what cannot be seen from a card", (t) => {
  // `oldestScoredAt` alone is the check that passes while the thing it checks
  // is broken: MIN() ignores NULLs, so a store where NOTHING has ever been
  // scored reports the healthiest possible value.
  const { insights } = library(t);
  const id = claim(insights);
  insights.addEvidence(id, [evidence("r1", { sourceKey: "" })]);
  const stats = insights.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.oldestScoredAt, null);
  assert.equal(stats.neverScored, 1);
  assert.equal(stats.unkeyedEvidence, 1, "an unkeyable source counts as one independent source however many arrive");
  assert.equal(stats.untypedEvidence, 1);
  assert.deepEqual(stats.byKind, { funding: 1 });
});

// ── the four defects the adversarial pass measured ────────────────────────
//
// Every one of these passed the suite before it was written, because nothing
// asked. They are grouped here rather than scattered so that a later change
// that reintroduces one fails with the reason attached.

test("a quote may not span two sections of a block", () => {
  // A sampled transcript joins non-adjacent cues with a newline and no gap
  // marker; normalisation collapses that to a space, so minutes-apart speech
  // reads as one sentence. Measured: a quote spanning the gap verified, and
  // the stored evidence inverted the speaker's meaning.
  const block = [
    "## Some Panel",
    "",
    "The Federal Reserve will not cut rates this year.",
    "",
    "That is what my colleague believes, and I think he is plainly wrong.",
  ].join("\n");
  const spliced = "The Federal Reserve will not cut rates this year. That is what my colleague believes";
  assert.equal(quoteIsVerbatim(spliced, block), false, "a splice across sections verified");
  assert.equal(
    quoteIsVerbatim("The Federal Reserve will not cut rates this year.", block), true,
    "a genuine contiguous quote was rejected",
  );
});

test("a sampled transcript cannot be quoted at all", () => {
  const block = [
    "## Some Video",
    "",
    "Transcript (excerpt, sampled across the whole recording):",
    "One cue here. Another cue from four minutes later.",
  ].join("\n");
  assert.equal(
    quoteIsVerbatim("One cue here. Another cue from four minutes later.", block), false,
    "a discontinuous transcript stayed quotable",
  );
});

test("our own placeholder sentence is not quotable as the source's words", () => {
  // podcast.js writes this when a row carries no body text at all, which is
  // 19% of blocks. Quoting it verified perfectly and put this program's
  // sentence in quotation marks beside the outlet's name.
  const block = [
    "## Some Article",
    "",
    "No body text is stored for this source. Only the title and the details above are known about it.",
  ].join("\n");
  assert.equal(
    quoteIsVerbatim("Only the title and the details above are known about it.", block), false,
    "the placeholder this program wrote was quotable as the source",
  );
});

test("a first pass drains the oldest rows, not the newest", (t) => {
  // Measured before the fix, on a real 20,708-row store with an empty
  // watermark: the pass took the NEWEST 200 and set the watermark to the
  // newest row in the library, so the other 20,508 were `<= since` for ever
  // after. It reported `backlog: 800` — the loss understated twenty-five fold.
  const { store } = library(t);
  for (let at = 0; at < 40; at += 1) {
    store.put(resource(`r${String(at).padStart(3, "0")}`, {
      createdAt: `2026-08-${String(1 + at).padStart(2, "0")}T00:00:00.000Z`,
    }));
  }
  const { rows, backlog } = collectCandidates(store, { insightMaxRows: 20, insightResourceTypes: ["NEWS"] });
  assert.equal(rows.length, 20);
  const taken = rows.map((row) => String(row.createdAt)).sort();
  assert.ok(taken[0].startsWith("2026-08-01"), `drained from the newest end: first taken ${taken[0]}`);
  assert.ok(backlog >= 20, `backlog under-reported: ${backlog}`);
});

test("rows binned by the cluster ceiling are not watermarked past", () => {
  // The ceiling is sized as though clustering collapsed rows ten to one. A
  // slice of unrelated articles produces roughly one cluster per article, so
  // measured at the defaults 200 rows produced 200 clusters, 20 survived, and
  // 180 were watermarked past unread — while the summary said
  // `rows: 200, unusable: 0, clusters: 20`.
  // Built through itemForRow so the shape is the one the pass really hands the
  // clusterer, simhash included.
  const items = Array.from({ length: 12 }, (_, at) => itemForRow(resource(`r${at}`, {
    title: `Unrelated ${"abcdefghijkl"[at]} story concerning ${"mnopqrstuvwx"[at]} entirely`,
    abstract: `Body ${at} shares no vocabulary ${"zyxwvutsrqpo"[at]} with any other item here`,
    sourceType: `Source ${at}`,
    createdAt: "2026-08-20T00:00:00.000Z",
  })));
  const clusters = clusterItems(items, { windowDays: 7, maxBits: 3, maxClusters: 3 });
  assert.equal(clusters.length, 3, "the ceiling did not bite; this test proves nothing");
  const reached = new Set(clusters.flatMap((c) => c.members.map((m) => String(m.id))));
  assert.ok(reached.size < items.length, "every item survived; adjust the fixture");
  // The pass computes its watermark over `reached` only. Anything else marks
  // the binned rows as read.
  assert.ok(
    items.some((item) => !reached.has(item.id)),
    "no item was binned, so the guard is untested",
  );
});

/* ── going to look for a second source ─────────────────────────────────── */
//
// The pass as first built was a closed world, and measured on the real library
// every one of its seven claims stayed a candidate with one source: the
// momentum test asks whether several independent sources report a thing, and
// that cannot be answered from a slice of what a feed happened to deliver.

test("a query is built from what travels between sources, not the sentence", () => {
  // A claim written to be specific enough to be wrong is a sentence no other
  // outlet wrote; searching for it verbatim returns the one article it came
  // from. Entities and distinctive terms are what another source would share.
  const { web, arxiv } = buildQueries({
    statement: "The VIALS benchmark contains 161 visual question-answering tasks and frontier models could not interpret the images",
    entities: ["VIALS", "frontier vision-language models"],
  });
  assert.ok(web.includes("VIALS"), "the entity is missing");
  assert.ok(web.includes("161"), "numbers are what another source has to agree with");
  assert.ok(!web.includes(" the "), "stopwords survived into the query");
  assert.ok(arxiv.startsWith("all:"), "the arXiv query is not in arXiv's language");
  assert.ok(arxiv.includes(' AND '), "arXiv terms must be ANDed, or the query returns the category");
});

test("independence is judged by host, not by URL", () => {
  // Five rewrites of one wire story are one source. Counting them separately
  // is how the momentum test starts reporting confidence nobody earned.
  const known = ["reuters.com", "arXiv cs.AI"];
  assert.equal(isIndependent("https://www.reuters.com/other-article", known), false);
  assert.equal(isIndependent("https://arxiv.org/abs/2601.00001", known), false, "arXiv cs.AI and arxiv.org are one source");
  assert.equal(isIndependent("https://www.nature.com/articles/x", known), true);
  assert.equal(isIndependent("not a url", known), false, "an unparseable URL is not an independent source");
});

/* ── the services we are a guest of ────────────────────────────────────── */

test("the pacer serialises and spaces, and survives a failure", async () => {
  // arXiv's terms are explicit: one request every three seconds, one
  // connection at a time, counted across every machine you run. The first
  // draft issued one request per claim in a plain loop — three inside a
  // second, hourly, for ever.
  const pace = createPacer(30);
  const started = [];
  const at = () => Date.now();
  const begin = at();
  const jobs = [
    pace(async () => { started.push(at() - begin); return "a"; }),
    pace(async () => { started.push(at() - begin); throw new Error("refused"); }),
    pace(async () => { started.push(at() - begin); return "c"; }),
  ];
  const settled = await Promise.allSettled(jobs);
  assert.equal(settled[0].value, "a");
  assert.equal(settled[1].status, "rejected", "a failure must reach its own caller");
  assert.equal(settled[2].value, "c", "one refusal must not stall the chain for ever");
  assert.ok(started[1] - started[0] >= 25, `second call came ${started[1] - started[0]}ms after the first`);
  assert.ok(started[2] - started[1] >= 25, `third call came ${started[2] - started[1]}ms after the second`);
});

test("a refusal is not an empty result set", async () => {
  // The one that matters. `catch { return [] }` reports a blocked search as
  // "nobody else wrote about this" — a claim about the world drawn from a fact
  // about our own request rate, and the exact shape of every other bug in this
  // repository.
  const limited = await searchArxiv("all:anything", {
    fetchImpl: async () => ({ status: 429, ok: false, headers: { get: (k) => (k === "retry-after" ? "60" : null) }, text: async () => "" }),
  });
  assert.deepEqual(limited.hits, []);
  assert.equal(limited.rateLimited, true, "a 429 was not recognised as a refusal");
  assert.match(limited.error, /rate-limited/u);
  assert.match(limited.error, /60/u, "Retry-After was thrown away");

  const empty = await searchArxiv("all:anything", {
    fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => "<feed></feed>" }),
  });
  assert.deepEqual(empty.hits, []);
  assert.equal(empty.error, "", "an honest empty answer was reported as an error");
  assert.notEqual(empty.rateLimited, true);
});

test("a metered web backend that says no says so", async () => {
  const out = await searchWeb(
    { search: async () => { throw new Error("HTTP 429 Too Many Requests"); } },
    "anything",
  );
  assert.equal(out.rateLimited, true, "an exhausted quota looked like an empty web");
  assert.match(out.error, /429/u);

  const absent = await searchWeb(undefined, "anything");
  assert.deepEqual(absent.hits, []);
  assert.equal(absent.rateLimited, undefined, "no seam installed is a configuration, not a refusal");
});

test("the corroboration stage speaks the store's actual API", async (t) => {
  // It did not. `getInsight(id, { evidence: true })` was invented from the
  // shape of the contract instead of read out of the file, and the whole stage
  // died on the first real run — with 127 green tests, not one of which ever
  // let this stage touch a store. Every method the stage calls is exercised
  // here, against a real one, so a rename cannot pass again.
  const { store, insights } = library(t);
  store.put(resource("r-corrob", { createdAt: "2026-08-24T00:00:00.000Z" }));
  const id = claim(insights, { status: "candidate" });
  insights.addEvidence(id, [evidence("r-corrob")]);

  // Every call the stage makes, in the order it makes them.
  assert.equal(typeof insights.dueForCorroboration, "function");
  const queue = insights.dueForCorroboration({ before: "2030-01-01T00:00:00.000Z", limit: 3 });
  assert.ok(queue.includes(id), "a candidate was not offered for corroboration");

  const loaded = insights.getWithEvidence(id);
  assert.ok(loaded !== undefined, "the stage could not load the claim it was given");
  assert.ok(Array.isArray(loaded.evidence), "evidence did not come back as a list");
  assert.ok(
    loaded.evidence.every((row) => "sourceKey" in row),
    "the stage reads sourceKey off every evidence row to judge independence",
  );

  insights.markCorroborated(id, "2026-08-24T01:00:00.000Z");
  assert.ok(
    !insights.dueForCorroboration({ before: "2026-08-24T00:30:00.000Z", limit: 3 }).includes(id),
    "a claim just asked about was offered again",
  );

  const resourceId = insights.addExternalEvidence(id, {
    url: "https://elsewhere.test/story",
    sourceKey: "elsewhere.test",
    stance: "supports",
    quote: "raised $3.5bn in a Series E round led by Lightspeed",
    addedAt: "2026-08-24T01:00:00.000Z",
  });
  assert.ok(typeof resourceId === "string" && resourceId !== "", "no resource id came back");
  const after = insights.getWithEvidence(id);
  assert.equal(after.evidence.length, 2, "the corroborating page was not attached");
  assert.ok(
    after.evidence.some((row) => row.sourceKey === "elsewhere.test"),
    "the corroborating source was attached without its host, so it counts as the same source",
  );
});
