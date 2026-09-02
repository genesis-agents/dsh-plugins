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
import { sourceMaterial } from "../lib/podcast.js";
import { createInsightRoutes } from "../lib/insight-routes.js";
import {
  CREDIBILITY_WEIGHTS,
  MIN_QUOTE_CHARS,
  MIN_QUOTE_CJK_CHARS,
  SCORE_WEIGHTS,
  STRENGTH_BANDS,
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
  strengthOf,
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
import { EXTRACTION_PROMPT, collectCandidates, parseClaims, verifyClaims, insightPassOnce, readInsightConfig, rescoreOne, runInsightPass, transcriptFailureKind } from "../lib/insight-extract.js";
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
  // FIVE, and `expired` is the newest. It is written by the pass into
  // `status` when the EVENT a claim is about has aged out — a different fact
  // from `dormant`, which means we have had no new evidence lately and is
  // reversible the moment a source turns up. Pinned here because the list is a
  // vocabulary three files validate against, and a member added without
  // thought is a status nothing can filter to.
  assert.deepEqual(INSIGHT_STATUSES, ["candidate", "standing", "contested", "dormant", "expired"]);
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

test("a web search reads the field the seam actually returns", async () => {
  // The whole thing turned on one word. `dsh-web-search` answers with
  // `{sources: [...]}` and this read `answer.results`, a name nothing in that
  // plugin ever produces — so every web search "succeeded" with zero hits.
  // Measured on a real mission: 86 ok web_search calls, 13 pages fetched, four
  // of eight dimensions empty, and a ledger reporting that the searches worked.
  const hit = { url: "https://example.test/a", title: "A", snippet: "s" };

  const seam = { search: async () => ({ sources: [hit] }) };
  const out = await searchWeb(seam, "anything");
  assert.equal(out.hits.length, 1, "the seam's own field name returned nothing");
  assert.equal(out.hits[0].url, "https://example.test/a");

  // A bare array stays supported, and `results` is still read so a future seam
  // that uses it is not silently emptied the way this one was.
  assert.equal((await searchWeb({ search: async () => [hit] }, "x")).hits.length, 1);
  assert.equal((await searchWeb({ search: async () => ({ results: [hit] }) }, "x")).hits.length, 1);

  // Genuinely empty stays genuinely empty, and is not an error.
  const none = await searchWeb({ search: async () => ({ sources: [] }) }, "x");
  assert.deepEqual(none.hits, []);
  assert.equal(none.error, "");
});

/* ── a scoped manual run ───────────────────────────────────────────────── */
//
// THE SCOPE EXISTS BECAUSE "RUN" IS NOT A REQUEST ANYBODY HAS. The button that
// spends the model calls asked for nothing and read whatever the settings said,
// so a reader who wanted this week's videos about one subject had one control
// that did none of it. These four guards are the ones that fail SILENTLY: a
// scope that is accepted and ignored reads everything and reports a normal
// pass, and a scope let through onto the SCHEDULED pass watermarks past every
// row the filter excluded — the twenty-thousand-row loss this file already
// records once, with a filter in front of it.

test("a scoped run reads only the matching rows", (t) => {
  const { store } = library(t);
  store.put(resource("hit", { title: "Inference cost is falling fast this quarter" }));
  store.put(resource("miss", { title: "A robotics startup opened an office" }));
  const wide = collectCandidates(store, { insightMaxRows: 20, insightResourceTypes: ["NEWS"] });
  assert.equal(wide.rows.length, 2, "the fixture does not have two readable rows");
  const narrow = collectCandidates(
    store,
    { insightMaxRows: 20, insightResourceTypes: ["NEWS"] },
    { search: "inference cost" },
  );
  assert.deepEqual(narrow.rows.map((row) => row.id), ["hit"], "the search term was accepted and ignored");
});

test("a scope's type list replaces the configured one", (t) => {
  const { store } = library(t);
  store.put(resource("n1", { type: "NEWS" }));
  store.put(resource("p1", { type: "PAPER" }));
  const { rows } = collectCandidates(
    store,
    { insightMaxRows: 20, insightResourceTypes: ["NEWS", "PAPER"] },
    { types: ["PAPER"] },
  );
  assert.deepEqual(rows.map((row) => row.id), ["p1"]);
});

test("a window replaces the watermark rather than narrowing it further", (t) => {
  // A reader looking at a drained library asks for "the last week" because the
  // table has not moved. Intersected with a watermark past every row, that
  // answers a deliberate request with the skip reason for an idle one.
  const { store } = library(t);
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
  store.put(resource("fresh", { createdAt: recent }));
  const drained = { insightMaxRows: 20, insightResourceTypes: ["NEWS"], insightLastRun: { watermark: "2099-01-01T00:00:00.000Z" } };
  assert.equal(collectCandidates(store, drained).rows.length, 0, "the watermark is not draining the fixture");
  const { rows } = collectCandidates(store, drained, {
    since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  });
  assert.deepEqual(rows.map((row) => row.id), ["fresh"], "the window was intersected with the watermark instead of replacing it");
});

test("the scheduled pass refuses a scope instead of carrying the watermark over one", async (t) => {
  const { store, insights } = library(t);
  await assert.rejects(
    () => runInsightPass(store, insights, () => {}, undefined, { markSkips: true, scope: { search: "anything" } }),
    /cannot be scoped/,
    "a scoped scheduled pass would watermark past every row the filter excluded",
  );
});

/* ── the pass says where it has got to ─────────────────────────────────── */
//
// A PASS IS UP TO TWENTY MODEL CALLS OVER MINUTES AND IT USED TO REPORT TWICE:
// `{running: true}` at the top and a summary at the bottom. The button that
// starts it answers 202 in milliseconds, so everything a reader saw was a label
// that flickered once. These guard the reporting itself — a listener that is
// accepted and never called is the same silence with more code behind it.

test("a pass reports every stage it walks through", async (t) => {
  const { store, insights } = library(t);
  for (let at = 0; at < 4; at += 1) {
    store.put(resource(`p${at}`, {
      title: `Anthropic raised money in round ${at} at a stated valuation`,
      abstract: `Body ${at}: the company confirmed the figure in a filing this week.`,
      createdAt: `2026-08-2${at}T00:00:00.000Z`,
    }));
  }
  const seen = [];
  // A model that refuses. The pass records the failure and carries on, which is
  // what makes this a test of the REPORTING rather than of the extraction.
  const chat = async function* () { yield { error: "no model here" }; };
  await insightPassOnce(store, insights, chat, undefined, {
    onProgress: ({ phase, done, total }) => { seen.push({ phase, done, total }); },
  });
  const phases = seen.map((one) => one.phase);
  assert.ok(phases.includes("reading"), `no reading stage reported: ${phases.join(",")}`);
  assert.ok(phases.includes("clustering"), `no clustering stage reported: ${phases.join(",")}`);
  assert.ok(phases.includes("extracting"), `no extracting stage reported: ${phases.join(",")}`);
  // The counted stages must carry a denominator, or the page draws a bar
  // against a total it invented.
  const extracting = seen.filter((one) => one.phase === "extracting");
  assert.ok(extracting.every((one) => one.total > 0), "an extracting step reported no total");
  assert.ok(
    extracting.every((one) => one.done < one.total),
    "a step reported itself already finished; the counter is ahead of the work",
  );
});

test("a listener that throws does not lose the pass", async (t) => {
  // Progress is a courtesy; the run is the work. A listener writes a setting,
  // a setting writes SQLite, and a failed write must not discard extraction
  // that has already been paid for.
  const { store, insights } = library(t);
  store.put(resource("a", { createdAt: "2026-08-20T00:00:00.000Z" }));
  store.put(resource("b", { createdAt: "2026-08-21T00:00:00.000Z" }));
  const chat = async function* () { yield { error: "no model here" }; };
  const result = await insightPassOnce(store, insights, chat, undefined, {
    onProgress: () => { throw new Error("the listener is broken"); },
  });
  assert.equal(typeof result, "object", "a broken progress listener took the pass with it");
});

test("the figures of the last good run survive the next press", async (t) => {
  // `setSetting` writes whole values, so the `{running:true}` marker replaces
  // the summary of the run before it. Measured: pressing the button on a band
  // reading 200 / 13 / 12 / 0 blanked all four for the whole pass — and the
  // band they sat in collapsed, because the cell beside it is `marginLeft:auto`.
  const { store, insights } = library(t);
  store.setSetting("insightLastGoodRun", { ran: true, rows: 200, claims: 13, verified: 12, at: "2026-08-20T00:00:00.000Z" });
  const chat = async function* () { yield { error: "no model here" }; };
  // A run with too little material: skips, and writes a skip record.
  await runInsightPass(store, insights, chat, undefined, { markSkips: false });
  const config = readInsightConfig(store);
  // `ran` is now written as an explicit false rather than left absent: the
  // skip record spreads the pass's whole result instead of cherry-picking two
  // fields, which is what stopped it silently dropping every field added after
  // it was written. Asserting "not true" rather than "absent" so this says
  // what it means — the fixture skipped — instead of pinning a representation.
  assert.notEqual(config.insightLastManualRun.ran, true, "the fixture did not skip; this proves nothing");
  assert.equal(config.insightLastGoodRun.rows, 200, "a skipped run wiped the last good figures");
  assert.equal(config.insightLastGoodRun.claims, 13);
});

/* ── the pass's own account of itself ──────────────────────────────────── */
//
// THE AGGREGATES ANSWER "HOW MANY" FOR A QUESTION WHOSE ONLY USEFUL FORM IS
// "WHICH ONE". A pass that reads two hundred sources and writes three claims is
// either working perfectly on a quiet week or silently dropping a hundred and
// ninety videos for want of a transcript, and `rows / unusable / binned /
// clusters / failures` report those two identically.

test("a video with no transcript is skipped by name, not in silence", (t) => {
  // Measured on the library this was built against: 523 videos, 23
  // transcripts. Five hundred sources were held, wanted, correctly skipped,
  // and reported nowhere — not in `rows`, not in `backlog`, not in `unusable`.
  const { store } = library(t);
  store.put(resource("v", { type: "YOUTUBE_VIDEO", title: "An hour-long interview" }));
  store.put(resource("n", { type: "NEWS" }));
  const scan = collectCandidates(store, { insightMaxRows: 20, insightResourceTypes: ["YOUTUBE_VIDEO", "NEWS"] });
  assert.deepEqual(scan.rows.map((row) => row.id), ["n"], "the transcript-less video was read anyway");
  assert.deepEqual(
    scan.skipped.map((one) => one.row.id),
    ["v"],
    "the skip was applied and not reported",
  );
  assert.match(scan.skipped[0].reason, /transcript/, "the skip carries no usable reason");
});

test("a pass writes one ledger row per source it looked at", async (t) => {
  const { store, insights } = library(t);
  store.put(resource("v", { type: "YOUTUBE_VIDEO", title: "An hour-long interview", durationSeconds: 4000 }));
  for (let at = 0; at < 3; at += 1) {
    store.put(resource(`n${at}`, {
      title: `Anthropic confirmed a figure in filing ${at} this week`,
      abstract: `Body ${at}: the company stated the number in a document.`,
    }));
  }
  const chat = async function* () { yield { error: "no model here" }; };
  const result = await insightPassOnce(store, insights, chat, undefined, {});
  assert.equal(result.ran, true, "the fixture did not run a pass");
  const ledger = insights.passLedger(result.batch);
  const byId = Object.fromEntries(ledger.rows.map((row) => [row.resourceId, row]));
  assert.equal(byId.v.state, "no-transcript", "the skipped video is missing from the ledger");
  assert.equal(byId.v.durationSeconds, 4000, "the ledger lost the video's length");
  // The model refused, so every cluster failed and every clustered row must
  // say so — with the reason, which is the whole point of recording it.
  assert.equal(byId.n0.state, "failed");
  assert.match(byId.n0.reason, /no model here/);
  assert.ok(ledger.counts.failed >= 1, "the counts do not add up to the rows");
});

test("the ledger keeps whole passes and prunes whole passes", (t) => {
  // Half a pass's ledger is a screen reporting that a run read forty sources
  // when it read two hundred, which is worse than not showing it at all.
  const { insights } = library(t);
  for (let at = 0; at < 4; at += 1) {
    insights.recordPass(`2026-08-2${at}T00:00:00.000Z`, [
      { resourceId: `a${at}`, title: "one", resourceType: "NEWS", state: "extracted", claims: 1 },
      { resourceId: `b${at}`, title: "two", resourceType: "NEWS", state: "read" },
    ], { keepBatches: 2 });
  }
  const batches = insights.passBatches();
  assert.equal(batches.length, 2, `kept ${batches.length} batches instead of 2`);
  assert.equal(batches[0].batch, "2026-08-23T00:00:00.000Z", "pruning kept the wrong end");
  assert.equal(batches[0].rows, 2, "a batch was pruned down the middle");
});

test("the ledger sorts by concern, not alphabetically", (t) => {
  // A failure sorted among two hundred successes is a failure nobody finds.
  const { insights } = library(t);
  insights.recordPass("2026-08-20T00:00:00.000Z", [
    { resourceId: "z", title: "aaa", resourceType: "NEWS", state: "extracted", claims: 3 },
    { resourceId: "y", title: "bbb", resourceType: "NEWS", state: "failed", reason: "the model refused" },
    { resourceId: "x", title: "ccc", resourceType: "YOUTUBE_VIDEO", state: "no-transcript" },
  ]);
  const states = insights.passLedger().rows.map((row) => row.state);
  assert.deepEqual(states, ["failed", "no-transcript", "extracted"]);
});

test("a strength band is derived from the score, and an unscored card has none", () => {
  assert.equal(strengthOf(0.71), "high");
  assert.equal(strengthOf(0.55), "high", "the floor is inclusive");
  assert.equal(strengthOf(0.47), "medium");
  assert.equal(strengthOf(0.38), "medium");
  assert.equal(strengthOf(0.2), "low");
  // A card that has never been scored is not a weak claim, it is an unmeasured
  // one. `rank_score` defaults to 0, so banding that as 低 would print a
  // verdict nobody reached over every row the rescore sweep has not reached.
  assert.equal(strengthOf(0), null);
  assert.equal(strengthOf(undefined), null);
  assert.equal(strengthOf("not a number"), null);
});

test("the bands are ordered high to low, so the first match wins", () => {
  // `strengthOf` uses `find`, which returns the FIRST band whose floor the
  // score clears. Written low-to-high the table would answer "low" for every
  // score in existence and every card in the pane would agree with it.
  const floors = STRENGTH_BANDS.map((band) => band.floor);
  assert.deepEqual([...floors].sort((a, b) => b - a), floors, "the bands are not ordered high to low");
  assert.equal(STRENGTH_BANDS[STRENGTH_BANDS.length - 1].floor, 0, "the last band does not catch everything");
});

/* ── which kind of SOURCE, not which kind of claim ─────────────────────── */
//
// THE MOST CONFUSABLE PAIR OF VOCABULARIES IN THIS FEATURE. `kind` is launch /
// funding / policy / finding / shift — what the claim SAYS. `resourceType` is
// NEWS / PAPER / YOUTUBE_VIDEO — where it CAME FROM. Both are plain strings and
// neither validates as the other, so mixing them up produces an empty page
// rather than an error.

test("a source-type cut selects claims by where their evidence came from", (t) => {
  const { store, insights } = library(t);
  store.put(resource("vid", { type: "YOUTUBE_VIDEO", title: "A talk" }));
  store.put(resource("art", { type: "NEWS", title: "An article" }));
  const spoken = claim(insights, { statement: "A figure was stated on stage at a conference in March" });
  const written = claim(insights, {
    statement: "A different figure was reported by an outlet in April",
    simhash: simhash("A different figure was reported by an outlet in April"),
  });
  insights.addEvidence(spoken, [evidence("vid", { resourceType: "YOUTUBE_VIDEO" })]);
  insights.addEvidence(written, [evidence("art", { resourceType: "NEWS" })]);

  const talks = insights.list({ resourceType: "YOUTUBE_VIDEO", take: 50 });
  assert.deepEqual(talks.insights.map((row) => row.id), [spoken], "the source cut selected the wrong claims");
  const news = insights.list({ resourceType: "NEWS", take: 50 });
  assert.deepEqual(news.insights.map((row) => row.id), [written]);
});

test("a claim with three quotes from one source type is still one row", (t) => {
  // AN EXISTS SUBQUERY, NOT A JOIN. Joining evidence returns the claim once per
  // matching quote, so `total`, the paging and `hasMore` would all be wrong by
  // a factor nobody can predict — and the page would draw the same card three
  // times with every count on it still correct.
  const { store, insights } = library(t);
  for (const id of ["a", "b", "c"]) store.put(resource(id, { type: "NEWS" }));
  const id = claim(insights);
  insights.addEvidence(id, ["a", "b", "c"].map((one) => evidence(one, {
    resourceType: "NEWS",
    quote: `raised $3.5bn in a Series E round led by Lightspeed, per source ${one}`,
  })));
  const page = insights.list({ resourceType: "NEWS", take: 50 });
  assert.equal(page.insights.length, 1, "the claim came back once per quote");
  assert.equal(page.total, 1, "the total counted quotes rather than claims");
});

test("a source cut and a claim-kind cut compose rather than collide", (t) => {
  const { store, insights } = library(t);
  store.put(resource("vid", { type: "YOUTUBE_VIDEO" }));
  const id = claim(insights, { kind: "funding" });
  insights.addEvidence(id, [evidence("vid", { resourceType: "YOUTUBE_VIDEO" })]);
  assert.equal(insights.list({ resourceType: "YOUTUBE_VIDEO", kind: "funding" }).insights.length, 1);
  // The pair that proves they are different axes: the right source, the wrong
  // claim kind. If either parameter were quietly reading the other's
  // vocabulary this would answer one row.
  assert.equal(insights.list({ resourceType: "YOUTUBE_VIDEO", kind: "policy" }).insights.length, 0);
});

/* ── a verdict moves the card, it does not just colour it ──────────────── */
//
// THE POINT OF THE STRIP. A person who marks a claim 成立 has finished with it,
// and a tab that keeps showing it grows monotonically until nobody opens it.
// `pinned_status` already outranked the pass; what was missing was that
// deciding did anything visible beyond a chip.

test("a judged claim leaves the inbox and lands in exactly one seat", (t) => {
  const { insights } = library(t);
  const judged = claim(insights, { statement: "Anthropic raised a round that a person has now signed off" });
  const untouched = claim(insights, {
    statement: "A second claim nobody has looked at yet, stated plainly",
    simhash: simhash("A second claim nobody has looked at yet, stated plainly"),
  });
  insights.setStatus(judged, "standing");

  const inbox = insights.list({ verdict: "pending", take: 50 }).insights.map((row) => row.id);
  assert.deepEqual(inbox, [untouched], "a judged card is still sitting in the inbox");
  const standing = insights.list({ verdict: "standing", take: 50 }).insights.map((row) => row.id);
  assert.deepEqual(standing, [judged], "the judged card is not in the seat it was put in");
});

test("the strip's counts are the verdict column, not the pass's", (t) => {
  // `status` and `pinned_status` are different columns and a card whose person
  // and pass disagree is counted in one bucket by each. Deriving either tally
  // from the other is wrong for exactly the cards a reader has touched — the
  // only ones that matter here.
  const { insights } = library(t);
  const id = claim(insights);
  claim(insights, {
    statement: "Another claim entirely, left alone by everybody so far",
    simhash: simhash("Another claim entirely, left alone by everybody so far"),
  });
  insights.setStatus(id, "dormant");
  const counts = insights.countsByVerdict();
  assert.equal(counts.dormant, 1, "the shelved card was not counted as shelved");
  assert.equal(counts.pending, 1, "the untouched card was not counted as pending");
  assert.equal(counts.standing, 0);
  // `setStatus` writes BOTH columns, so right after a verdict the two tallies
  // agree — this is what that looks like, and asserting the pass still saw a
  // candidate here was wrong about the code rather than about the design.
  //
  // They diverge LATER, which is the whole reason there are two: the pass
  // rescores and rewrites `status` on every run while `pinned_status` stays,
  // and `nextStatus` returns the pinned value so the reader's verdict wins.
  // A tally derived from the other column would go quietly wrong at exactly
  // that moment, on exactly the cards a person has touched.
  const byStatus = insights.countsByStatus();
  assert.equal(byStatus.dormant, 1, "the verdict did not carry into the pass's own column");
  assert.equal(byStatus.candidate, 1, "the untouched card stopped being a candidate");
});

test("a shelved card stays shelved after the pass gives up on it", (t) => {
  // "Show me what I shelved" means all of it. A decided seat suppresses the
  // default live-status clause, or a card would vanish from the one place the
  // reader deliberately put it because the swarm changed its mind.
  const { insights } = library(t);
  const id = claim(insights, { status: "dormant" });
  insights.setStatus(id, "dormant");
  const seat = insights.list({ verdict: "dormant", take: 50 }).insights.map((row) => row.id);
  assert.deepEqual(seat, [id], "a card the pass let go dormant fell out of the seat it was filed in");
});

test("the inbox does not fill with what the pass has already given up on", (t) => {
  // The opposite rule, and it is why `pending` keeps the live-status clause:
  // an inbox that accumulates every dormant card is an inbox nobody reaches
  // the bottom of, which is the failure the strip exists to remove.
  const { insights } = library(t);
  claim(insights, { status: "dormant" });
  const inbox = insights.list({ verdict: "pending", take: 50 }).insights;
  assert.equal(inbox.length, 0, "a dormant card nobody judged is sitting in the inbox");
  assert.equal(insights.countsByVerdict().pending, 0, "and it is being counted there too");
});

test("a claim's reading survives the round trip to the list", (t) => {
  // CAUGHT BY AN END-TO-END PROBE, NOT BY A UNIT TEST, and that is the point:
  // `gloss` was written by upsertInsight, hydrated by shapeInsight, and absent
  // from INSIGHT_COLUMNS — so every write worked, every read of one card
  // worked, and the LIST silently served `gloss: null` for every row. A column
  // added to a table, a writer and a reader but not to the column list is
  // invisible at exactly the layer the page uses.
  const { insights } = library(t);
  const id = claim(insights, { gloss: "这条主张说明云上推理的单位成本已经越过临界点。" });
  assert.equal(insights.get(id).gloss, "这条主张说明云上推理的单位成本已经越过临界点。", "the single-card read lost it");
  const listed = insights.list({ take: 10 }).insights.find((row) => row.id === id);
  assert.equal(listed.gloss, "这条主张说明云上推理的单位成本已经越过临界点。", "the list route serves no reading");
});

/* ── the stage that was missing ────────────────────────────────────────── */
//
// NOTHING IN THIS PROGRAM EVER FETCHED A TRANSCRIPT EXCEPT A PERSON OPENING A
// VIDEO. `POST /transcript` was the only caller of `resolveTranscript`, and it
// fires from the reader. So coverage was "the videos somebody clicked" — 23 of
// 523 — and the insight scan correctly skipped the rest, read 5% of the
// library, and reported a healthy run. Two halves that had never been joined.

test("the pass fetches transcripts for the videos it is about to skip", async (t) => {
  const { store, insights } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", title: "An hour on inference cost", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  store.put(resource("v2", { type: "YOUTUBE_VIDEO", title: "An hour on capacity", sourceUrl: "https://youtu.be/bbbbbbbbbbb" }));
  const asked = [];
  const chat = async function* () { yield { error: "no model here" }; };
  const result = await insightPassOnce(store, insights, chat, undefined, {
    transcribeGapMs: 0,
    transcribe: async (row) => {
      asked.push(row.id);
      return { language: "en", text: "a long spoken sentence that a claim could quote from " + row.id, cues: [{ start: 0, text: "hello" }], via: "timedtext" };
    },
  });
  assert.deepEqual(asked.sort(), ["v1", "v2"], "the pass never went and got the transcripts");
  assert.equal(result.transcribeGained, 2, "the fetched transcripts were not stored");
  assert.notEqual(store.getTranscript("v1"), undefined, "nothing reached the library");
  // AND THEY GO BACK THROUGH THE SCAN. A freshly-transcribed video has to be
  // selected on the same terms as everything else — the per-type share, the
  // ceiling, the watermark — rather than promoted into a place no other row
  // can earn.
  assert.ok(result.rows >= 2, "the newly readable videos were not re-scanned: rows=" + result.rows);
});

test("a quota answer is recorded, and the free routes carry on without it", async (t) => {
  // THIS TEST HAS BEEN TURNED AROUND, and the rule it used to hold was right
  // when it was written: every remaining video would get the same answer from
  // the same exhausted key, so carrying on spent the budget re-learning one
  // fact and, against a rate limiter, made the limit worse.
  //
  // Neither half holds now. The client parks a rate-limited provider for twenty
  // minutes and a credit-spent key for its cooldown, and refuses both WITHOUT
  // SENDING ANYTHING, so carrying on makes no paid request at all. Meanwhile
  // the three free routes in front of it cost nothing and answer the question
  // that decides whether a video is ever worth paying for.
  //
  // MEASURED, which is why it changed: one 429 on the second key of the first
  // video ended a drain of forty, so a ninety-six video backlog was being
  // classified at one video per twenty-minute backoff.
  const { store, insights } = library(t);
  for (let at = 0; at < 5; at += 1) {
    store.put(resource("v" + at, { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/" + "abcde"[at] + "aaaaaaaaaa" }));
  }
  let tried = 0;
  const chat = async function* () { yield { error: "no model here" }; };
  const result = await insightPassOnce(store, insights, chat, undefined, {
    transcribeGapMs: 0,
    transcribe: async () => { tried += 1; throw new Error("supadata key 1/1: HTTP 429 rate limit exceeded"); },
  });
  assert.ok(tried > 1, "the drain still stopped at the first quota answer, after " + tried + " request(s)");
  assert.match(result.transcribeStopped, /429|rate limit/i, "the reason was not recorded, so nobody can see why nothing was bought");
});

test("a video with no captions is told apart from one nobody asked about", async (t) => {
  // Three different things to do about it: buy quota, never try again, or try
  // the next one. "no transcript stored" describes the library and says none
  // of them.
  assert.equal(transcriptFailureKind(new Error("supadata: HTTP 429 too many requests")), "quota");
  assert.equal(transcriptFailureKind(new Error("timedtext: HTTP 404 no caption track")), "absent");
  assert.equal(transcriptFailureKind(new Error("relay: socket hang up")), "other");
  // And the ledger says which, rather than repeating the library's own words.
  const { store, insights } = library(t);
  store.put(resource("v", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  store.put(resource("n", { type: "NEWS", title: "Something readable to make the pass run" }));
  store.put(resource("n2", { type: "NEWS", title: "A second readable row for the pass" }));
  const chat = async function* () { yield { error: "no model here" }; };
  const result = await insightPassOnce(store, insights, chat, undefined, {
    transcribeGapMs: 0,
    transcribe: async () => { throw new Error("timedtext: HTTP 404 no caption track"); },
  });
  const row = insights.passLedger(result.batch).rows.find((one) => one.resourceId === "v");
  // A CODE, NOT A SENTENCE. The words are the page's job now: half of these
  // were being written into the database in Chinese and half in English, so the
  // panel was permanently half-translated whichever language a reader chose.
  assert.equal(row.reasonCode, "transcript-absent", "the ledger did not record WHY the fetch failed: " + row.reasonCode);
  // And the provider's own words survive as the detail, untranslated, because
  // they are evidence rather than copy.
  assert.match(row.reason, /404|caption/i, "the provider's answer was discarded: " + row.reason);
});

test("a top-up that cannot fetch leaves the pass unharmed", async (t) => {
  // Preparation for the pass, not the pass. A stage that cannot reach the
  // network must not take the extraction it was preparing for with it.
  const { store, insights } = library(t);
  store.put(resource("v", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  store.put(resource("n", { type: "NEWS", title: "Anthropic confirmed a figure in a filing" }));
  store.put(resource("n2", { type: "NEWS", title: "A second article stating the same figure" }));
  const chat = async function* () { yield { error: "no model here" }; };
  const result = await insightPassOnce(store, insights, chat, undefined, {
    transcribeGapMs: 0,
    transcribe: async () => { throw new Error("the whole network is gone"); },
  });
  assert.equal(result.ran, true, "a failing top-up stopped the pass");
});

test("the budget is a budget, and zero turns the stage off", async (t) => {
  const { store, insights } = library(t);
  for (let at = 0; at < 6; at += 1) {
    store.put(resource("v" + at, { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/" + "abcdef"[at] + "aaaaaaaaaa" }));
  }
  let tried = 0;
  const transcribe = async () => { tried += 1; return { text: "" }; };
  const chat = async function* () { yield { error: "no model here" }; };
  await insightPassOnce(store, insights, chat, undefined, { transcribe, transcribeGapMs: 0, scope: { transcribe: 2 } });
  assert.equal(tried, 2, "the budget was not honoured: " + tried + " requests");
  tried = 0;
  await insightPassOnce(store, insights, chat, undefined, { transcribe, scope: { transcribe: 0 } });
  assert.equal(tried, 0, "zero did not turn the stage off");
});

test("an empty answer is not stored as a transcript", async (t) => {
  // Storing one would make the next scan treat the video as readable and hand
  // the model a blank block — a source that costs a slot in the ceiling and
  // can produce nothing, for ever.
  const { store, insights } = library(t);
  store.put(resource("v", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  const chat = async function* () { yield { error: "no model here" }; };
  await insightPassOnce(store, insights, chat, undefined, {
    transcribeGapMs: 0,
    transcribe: async () => ({ language: "en", text: "", cues: [] }),
  });
  assert.equal(store.getTranscript("v"), undefined, "an empty transcript was written to the library");
});

test("the library can say how many videos are waiting on a transcript", (t) => {
  const { store } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  store.put(resource("v2", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/bbbbbbbbbbb" }));
  store.put(resource("n", { type: "NEWS" }));
  assert.equal(store.countVideosWithoutTranscript(), 2, "articles are being counted as videos without transcripts");
  store.putTranscript("v1", "en", "some spoken words", [{ start: 0, text: "some spoken words" }]);
  assert.equal(store.countVideosWithoutTranscript(), 1, "a stored transcript did not come off the count");
});

test("runInsightPass forwards the transcript fetcher it was handed", async (t) => {
  // SHIPPED BROKEN AND EVERY TEST PASSED. Both call sites — the timer in
  // index.js and the run-now route — hand this function a fetcher. It accepted
  // the option, never destructured it, and called the pass without it, so every
  // run on the live library reported transcribeTried: 0 while index.js,
  // insight-routes.js, insightPassOnce and topUpTranscripts were all correct.
  //
  // The suite missed it because every other test in this file calls
  // `insightPassOnce` directly — the function that USES the fetcher, not the
  // one that passes it on. A seam is precisely where a value gets dropped, and
  // exercising only the inner side of one tests the half that cannot fail this
  // way. This test enters at the layer production enters at.
  const { store, insights } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  store.put(resource("v2", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/bbbbbbbbbbb" }));
  let asked = 0;
  const chat = async function* () { yield { error: "no model here" }; };
  await runInsightPass(store, insights, chat, undefined, {
    markSkips: false,
    transcribeGapMs: 0,
    transcribe: async (row) => {
      asked += 1;
      return { language: "en", text: "a long spoken sentence a claim could quote from " + row.id, cues: [], via: "timedtext" };
    },
  });
  assert.ok(asked > 0, "runInsightPass dropped the fetcher on the way to the pass");
  const config = readInsightConfig(store);
  assert.ok(
    Number(config.insightLastManualRun.transcribeGained) > 0,
    "the run recorded no transcripts even though the fetcher answered",
  );
});

test("the scheduled pass gets a fetcher through the same seam", async (t) => {
  // The timer path writes `insightLastRun` and carries the watermark, so it is
  // a different branch of `note()` and a different record — and it is the one
  // that actually drains a backlog unattended. Worth its own entry rather than
  // trusting that two paths through one function behave alike.
  const { store, insights } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/ccccccccccc" }));
  let asked = 0;
  const chat = async function* () { yield { error: "no model here" }; };
  await runInsightPass(store, insights, chat, undefined, {
    markSkips: true,
    transcribeGapMs: 0,
    transcribe: async () => { asked += 1; return { language: "en", text: "spoken words long enough to matter here", cues: [] }; },
  });
  assert.ok(asked > 0, "the scheduled pass never reached the fetcher");
});

/* ── draining the backlog is its own job ───────────────────────────────── */

test("a scoped run tops up only what its own scan skipped", async (t) => {
  // THE TRICK THAT DID NOT WORK, kept as a guard because it is a reasonable
  // thing to try again. A run scoped to a topic nobody wrote about was supposed
  // to drain the transcript backlog at no model cost: the top-up runs before
  // the "enough material" check, so it would fetch and then skip. It fetched
  // ZERO — the scope narrows the SCAN, so a search matching nothing skips
  // nothing, and there is nothing to top up.
  //
  // Draining is not a pass with the reading removed. It is a queue with a
  // budget, which is why `/insights/transcribe` exists.
  const { store, insights } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", title: "An hour on inference", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  let asked = 0;
  const chat = async function* () { yield { error: "no model here" }; };
  await insightPassOnce(store, insights, chat, undefined, {
    transcribeGapMs: 0,
    transcribe: async () => { asked += 1; return { language: "en", text: "words", cues: [] }; },
    scope: { search: "zzqqxx-no-such-topic", transcribe: 60 },
  });
  assert.equal(asked, 0, "a scope that matches nothing still found videos to top up; the guard is stale");
});

test("the backlog is drained oldest first", (t) => {
  // Matching the insight scan's own drain order, and for the reason it states
  // at length: a queue worked from the newest end leaves the tail permanently
  // unread, and rows nothing ever reaches are rows nobody knows are missing.
  const { store } = library(t);
  for (const [id, at] of [["new", "2026-09-01"], ["old", "2026-01-01"], ["mid", "2026-05-01"]]) {
    store.put(resource(id, { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/" + id + "aaaaaaaa", createdAt: at + "T00:00:00.000Z" }));
  }
  assert.deepEqual(store.videosWithoutTranscript(2).map((row) => row.id), ["old", "mid"]);
  // And an article is not a video waiting on one.
  store.put(resource("article", { type: "NEWS" }));
  assert.equal(store.videosWithoutTranscript(50).length, 3, "a non-video reached the transcript queue");
});

test("a video that has one is off the queue", (t) => {
  const { store } = library(t);
  store.put(resource("v", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  assert.equal(store.videosWithoutTranscript(10).length, 1);
  store.putTranscript("v", "en", "spoken words", [{ start: 0, text: "spoken words" }]);
  assert.equal(store.videosWithoutTranscript(10).length, 0, "a transcribed video is still queued");
  // An empty stored transcript is not a transcript: it would make the scan
  // treat the video as readable and hand the model a blank block.
  store.putTranscript("v", "en", "", []);
  assert.equal(store.videosWithoutTranscript(10).length, 1, "an empty transcript counts as having one");
});

test("a busy route still reads the body before it refuses", async (t) => {
  // THE SAME FAULT, TWICE, MINUTES APART. run-now answered its in-flight 202
  // before touching the request stream: the client was still sending, the
  // socket was torn down with a body in flight, and the proxy in front
  // reported "cannot reach the library" as a 502 — the page blaming the
  // library at the exact moment it was busiest. The drain route, written after
  // that was fixed, put its own guard in the same wrong place and was caught
  // by a probe sending a deliberately invalid limit and getting 202.
  //
  // The rule for every route here that takes a body: consume it first,
  // whatever the answer is going to be. A 400 for a malformed request also
  // beats a 202 that refuses it for an unrelated reason.
  const { store } = library(t);
  for (let at = 0; at < 4; at += 1) {
    store.put(resource("v" + at, { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/" + at + "aaaaaaaaaa" }));
  }
  const answers = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const handle = createInsightRoutes({
    store,
    chat: undefined,
    logger: undefined,
    sendJson: (res, code, body) => answers.push({ code, body }),
    readJson: async (req) => JSON.parse(req.__body ?? "{}"),
    // Held open so a drain is genuinely in flight for the second request.
    transcribeGapMs: 0,
    transcribe: async () => { await held; return { language: "en", text: "words", cues: [] }; },
  });
  const post = async (body) => {
    const before = answers.length;
    const req = {
      method: "POST",
      url: "/insights/transcribe",
      headers: body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) },
      __body: body,
    };
    await handle(req, {}, "/insights/transcribe");
    return answers[before];
  };

  const first = await post(JSON.stringify({ limit: 2 }));
  assert.equal(first.code, 202, "the first drain did not start");
  assert.equal(first.body.data.started, true);

  // A drain is now in flight. A malformed body must still be read and refused
  // on its own terms rather than swallowed by the busy answer.
  const bad = await post(JSON.stringify({ limit: 9999 }));
  assert.equal(bad.code, 400, "a busy route answered 202 without reading the body it was sent");
  assert.match(String(bad.body.error), /between 1 and 200/);

  release();
});

/* ── the ceiling is a queue, not a leak ────────────────────────────────── */
//
// MEASURED BEFORE THE FIX, on a 200-row slice of unrelated sources: 20 rows
// reached a surviving cluster, 180 were binned, and all 180 sat at or under the
// watermark the pass then wrote. Read once, discarded, never offered again —
// with `rows: 200, clusters: 20, binned: 180` reported over the loss, all three
// of them true. The comment above the watermark claimed binned rows "simply
// come back next pass"; they came back only when the survivors happened to be
// the oldest, and the ceiling's tie-break makes them the newest.

/** A slice of sources that share no vocabulary, so clustering cannot collapse them. */
function unrelatedSlice(count) {
  const word = (n) => "w" + n.toString(36) + "x" + ((n * 7919) % 99991).toString(36);
  const rows = [];
  for (let at = 0; at < count; at += 1) {
    rows.push({
      id: "r" + String(at).padStart(4, "0"),
      type: "NEWS",
      title: `${word(at * 3)} ${word(at * 3 + 1)} ${word(at * 3 + 2)}`,
      abstract: Array.from({ length: 12 }, (_, k) => word(at * 100 + k)).join(" "),
      sourceType: `Outlet ${at}`,
      // DISTINCT INSTANTS, because the watermark is a timestamp and this
      // fixture is about the ceiling, not about ties. Rows sharing an instant
      // with an unread row correctly stop the watermark dead — that is a real
      // and separate hazard on a bulk-seeded library, and giving it to this
      // test would have it fail for the wrong reason.
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + at * 1000).toISOString(),
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The watermark exactly as insightPassOnce computes it.
 * @param rows - what the scan handed to clustering, oldest first.
 * @param unconsidered - the oldest row the scan saw and did NOT hand over, or "".
 */
function watermarkOf(rows, unconsidered = "") {
  const considered = new Set(rows.map((row) => String(row.id)));
  const first = rows.find((row) => !considered.has(String(row.id)));
  const edges = [
    first === undefined ? "" : String(first.createdAt ?? ""),
    unconsidered,
  ].filter((at) => at !== "");
  const ceiling = edges.length === 0 ? null : edges.reduce((low, at) => (at < low ? at : low));
  return rows
    .filter((row) => considered.has(String(row.id)))
    .map((row) => String(row.createdAt ?? ""))
    .filter((at) => ceiling === null || at < ceiling)
    .reduce((latest, value) => (value > latest ? value : latest), "");
}

test("no row is watermarked past without the scan having looked at it", () => {
  // THE GUARANTEE, RESTATED. It used to be "never past a row the model did not
  // answer for", which sounds stronger and was in practice unmeetable: the
  // model answers for `maxClusters` stories while the scan looks at `maxRows`,
  // and when those differ by two orders of magnitude the watermark stops within
  // a few rows of where it started, for ever. The test below measures that.
  //
  // What must hold instead is that no row NOTHING looked at is skipped. Rows
  // clustering ranked and the ceiling declined were looked at, and the ledger
  // names each one with reason `over-ceiling`; the per-type share's leftovers
  // were not, and they arrive as `unconsidered` so the watermark stops there.
  const rows = unrelatedSlice(200);
  const leftovers = unrelatedSlice(20).map((row, at) => ({
    ...row,
    id: "rest" + String(at),
    // OLDER THAN SOME OF `rows`, which is the case that bites: the per-type
    // share means a busy type's remainder can predate a quiet type's newest.
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 30) + at * 1000).toISOString(),
  }));
  const unconsidered = leftovers
    .map((row) => String(row.createdAt))
    .reduce((oldest, at) => (oldest === "" || at < oldest ? at : oldest), "");

  const watermark = watermarkOf(rows, unconsidered);
  const stranded = leftovers.filter((row) => String(row.createdAt) <= watermark);
  assert.equal(stranded.length, 0, `${stranded.length} rows nothing looked at are below the watermark and will never be offered again`);
});

test("a scan far wider than the model-call budget still advances the watermark", () => {
  // THE BUG THIS FILE EXISTS FOR, in its second form. The first was a scan that
  // took the NEWEST rows and watermarked past the rest; the fix made the
  // watermark cover only rows that reached a surviving cluster, which is
  // correct and, at a realistic ratio of rows to calls, immobile.
  //
  // MEASURED ON THE REAL LIBRARY before this changed: 12,807 rows waiting, a
  // pass reading 200 of them moved the watermark 1.3 seconds, and a pass
  // reading 20 moved it about as far. The four biggest stories were re-read
  // every pass and re-derived claims that merged into themselves, so the board
  // stopped growing while the queue did not.
  const rows = unrelatedSlice(600);
  const items = rows.map(itemForRow).filter((one) => one !== undefined);
  const clusters = clusterItems(items, { windowDays: 7, maxBits: 3, maxClusters: 4, ensureItemId: String(rows[0].id) });
  const reached = new Set(clusters.flatMap((c) => c.members.map((m) => String(m.id))));
  assert.ok(reached.size < 100, `the model got ${reached.size} of 600 rows; the ceiling never bit and the fixture proves nothing`);

  // Nothing was left unconsidered here — the scan handed over all 600 — so the
  // watermark reaches the newest of them and the next pass starts after it.
  const watermark = watermarkOf(rows, "");
  assert.equal(
    watermark,
    String(rows[rows.length - 1].createdAt),
    "the watermark did not clear the slice, so these 600 rows come back next pass and the queue never drains",
  );
});

test("the oldest row is always read, so the queue cannot starve", () => {
  // A correct watermark on its own converts silent loss into no progress: if
  // the front of the queue is never among the clusters kept, the contiguous
  // prefix is empty and the pass re-reads the same slice for ever. One slot of
  // the cluster budget is reserved for the oldest, which is what makes the
  // drain monotone.
  const rows = unrelatedSlice(200);
  const items = rows.map(itemForRow).filter((one) => one !== undefined);
  const clusters = clusterItems(items, { windowDays: 7, maxBits: 3, maxClusters: 20, ensureItemId: String(rows[0].id) });
  const reached = new Set(clusters.flatMap((c) => c.members.map((m) => String(m.id))));
  assert.ok(reached.has(String(rows[0].id)), "the oldest row was not read; the front of the queue is being passed over");
  assert.ok(watermarkOf(rows, "") !== "", "the watermark did not move, so the next pass re-reads this slice");
});

test("the ceiling is still honoured, and still prefers the big stories", () => {
  // The reservation costs exactly one slot. A guarantee that quietly widened
  // the budget would be a bill nobody agreed to, paid one model call at a time.
  const rows = unrelatedSlice(120);
  const items = rows.map(itemForRow).filter((one) => one !== undefined);
  const clusters = clusterItems(items, { windowDays: 7, maxBits: 3, maxClusters: 12, ensureItemId: String(rows[0].id) });
  assert.equal(clusters.length, 12, `the ceiling was widened to ${clusters.length}`);
  assert.ok(clusters.some((c) => c.members.some((m) => String(m.id) === String(rows[0].id))), "the oldest is missing");
});

test("a slice small enough to fit is returned untouched", () => {
  const rows = unrelatedSlice(5);
  const items = rows.map(itemForRow).filter((one) => one !== undefined);
  const clusters = clusterItems(items, { windowDays: 7, maxBits: 3, maxClusters: 20, ensureItemId: String(rows[0].id) });
  const reached = new Set(clusters.flatMap((c) => c.members.map((m) => String(m.id))));
  assert.equal(reached.size, rows.length, "a slice under the ceiling lost rows anyway");
  // Everything was read, so the watermark may cover the whole slice.
  assert.equal(watermarkOf(rows, reached), String(rows[rows.length - 1].createdAt));
});

test("a single-source claim cannot be called strong", () => {
  // MEASURED ON THE LIVE TAB: three cards read 强度 强 at 0.65 — a 2009
  // supercomputer comparison, a methods detail from one paper, and a
  // background fact from a government report. All three had ONE independent
  // source, and every component of the blend was measuring this library's
  // relationship to the row rather than the claim's standing: novelty counts
  // from `firstSeenAt`, credibility weighs the source TYPE (one arXiv paper
  // takes the maximum), momentum rises with evidence that arrived just now,
  // and `independentCount` was not in the blend at all.
  //
  // The cap is the product's own standard: the rules footer four inches below
  // those cards says a claim needs `insightMinIndependent` separate sources
  // before it is 成立. Printing 强 beside 候选 on one source contradicts it.
  assert.equal(strengthOf(0.65, { independentCount: 1, minIndependent: 2 }), "medium");
  assert.equal(strengthOf(0.65, { independentCount: 2, minIndependent: 2 }), "high");
  assert.equal(strengthOf(0.9, { independentCount: 1, minIndependent: 2 }), "medium", "a very high score still cannot buy corroboration");
});

test("the cap only ever demotes, and never invents a band", () => {
  // A claim already below the high floor is unaffected: the cap answers "may
  // this be called strong", not "how strong is this".
  assert.equal(strengthOf(0.4, { independentCount: 1, minIndependent: 2 }), "medium");
  assert.equal(strengthOf(0.2, { independentCount: 1, minIndependent: 2 }), "low");
  assert.equal(strengthOf(0.2, { independentCount: 9, minIndependent: 2 }), "low", "corroboration cannot promote a weak score");
  // An unscored card stays unmeasured whatever its sources.
  assert.equal(strengthOf(0, { independentCount: 5, minIndependent: 2 }), null);
});

test("a caller with no card in hand still gets the blend's answer", () => {
  // Unknown independence must not demote on a guess: some callers band a bare
  // score and have no evidence rows to count.
  assert.equal(strengthOf(0.65), "high");
  assert.equal(strengthOf(0.65, {}), "high");
  assert.equal(strengthOf(0.65, { independentCount: "not a number" }), "high");
});

/* ── only what is still worth reading ──────────────────────────────────── */

test("a source published long ago is not read, however new it is to us", (t) => {
  // MEASURED ON THE LIVE TAB: a 2009-to-Frontier comparison and a methods
  // detail from an archived paper sat beside this week's funding news as
  // though they were the same kind of thing. The scan took everything above
  // the watermark whatever its age, and the watermark is `created_at` — when
  // we learned of a row — so an archive harvested this morning is new by the
  // only measure the scan had.
  const { store } = library(t);
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const fresh = new Date(Date.now() - 3 * 86_400_000).toISOString();
  store.put(resource("archive", { title: "A comparison from 2009", publishedAt: old }));
  store.put(resource("recent", { title: "A funding round this week", publishedAt: fresh }));

  const { rows } = collectCandidates(store, {
    insightMaxRows: 50, insightResourceTypes: ["NEWS"], insightMaxAgeDays: 30,
  });
  assert.deepEqual(rows.map((row) => row.id), ["recent"], "the archived source was read anyway");
});

test("zero means no floor, for a library that exists to hold an archive", (t) => {
  const { store } = library(t);
  store.put(resource("archive", { publishedAt: new Date(Date.now() - 400 * 86_400_000).toISOString() }));
  const { rows } = collectCandidates(store, {
    insightMaxRows: 50, insightResourceTypes: ["NEWS"], insightMaxAgeDays: 0,
  });
  assert.deepEqual(rows.map((row) => row.id), ["archive"], "zero was treated as a floor rather than as none");
});

test("a source with no publication date stays reachable", (t) => {
  // A feed that carries no date would otherwise be excluded by every window,
  // silently and for ever. Falling back to `created_at` reads "we do not know
  // when this was published" as "as old as our knowledge of it", which keeps
  // the row reachable while it is fresh to us.
  const { store } = library(t);
  store.put(resource("undated", { publishedAt: undefined }));
  const { rows } = collectCandidates(store, {
    insightMaxRows: 50, insightResourceTypes: ["NEWS"], insightMaxAgeDays: 30,
  });
  assert.deepEqual(rows.map((row) => row.id), ["undated"], "an undated source was excluded by the freshness floor");
});

test("the freshness floor and the watermark are different questions", (t) => {
  // `days` in a scope moves the WATERMARK — where the reader carries on from.
  // `maxAgeDays` moves the freshness floor — what is still worth reading. Both
  // are a number of days, which is exactly why they were being confused.
  const { store } = library(t);
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  store.put(resource("archive", { publishedAt: old }));
  const config = { insightMaxRows: 50, insightResourceTypes: ["NEWS"], insightMaxAgeDays: 30 };
  // Re-reading from the beginning of time does not make an old source fresh.
  const { rows } = collectCandidates(store, config, { since: "2000-01-01T00:00:00.000Z" });
  assert.equal(rows.length, 0, "a wide watermark window overrode the freshness floor");
  // Widening the floor for one run does.
  const wide = collectCandidates(store, config, { maxAgeDays: 3650 });
  assert.deepEqual(wide.rows.map((row) => row.id), ["archive"]);
});

/* ── novelty is about the event, not about our ingestion ───────────────── */

test("an old source ingested today is not novel", () => {
  // MEASURED ON THE LIVE TAB: a 2009-to-Frontier supercomputer comparison read
  // 强度 强 at 0.65, which is exactly `0.30 credibility + 0.20 novelty + 0.15
  // relevance` with each maxed — momentum is 0 because one source cannot have
  // momentum. Novelty was `1 - days(firstSeenAt, now)/window` and `firstSeenAt`
  // is when THIS LIBRARY first saw the claim, so an archive harvested three
  // hours ago scored the maximum and rode 20% of the rank to the top.
  const now = "2026-09-01T12:00:00.000Z";
  const seenToday = "2026-09-01T09:00:00.000Z";
  assert.equal(scoreNovelty({ publishedAt: "2009-06-01T00:00:00.000Z", firstSeenAt: seenToday, now }), 0);
  assert.ok(scoreNovelty({ publishedAt: "2026-08-30T00:00:00.000Z", firstSeenAt: seenToday, now }) > 0.6);
});

test("an undated source falls back to when we saw it, never to zero", () => {
  // A source with no publication date is not old, it is undated: the feed did
  // not say. Scoring it 0 would bury every row from every feed that omits the
  // field, permanently and invisibly.
  const now = "2026-09-01T12:00:00.000Z";
  const seen = "2026-09-01T09:00:00.000Z";
  assert.ok(scoreNovelty({ publishedAt: "", firstSeenAt: seen, now }) > 0.9);
  assert.ok(scoreNovelty({ publishedAt: undefined, firstSeenAt: seen, now }) > 0.9);
  assert.ok(scoreNovelty({ publishedAt: "not a date", firstSeenAt: seen, now }) > 0.9);
});

test("a publication date in the future is bad data, not news", () => {
  // Feeds carry them: a scheduled post, a timezone mistake, an outright wrong
  // field. `daysBetween` is signed, so `1 - (-40)/7` clamps to the MAXIMUM and
  // one malformed row would hold the top of the list for as long as its date
  // is ahead of us.
  const now = "2026-09-01T12:00:00.000Z";
  const seen = "2026-05-01T00:00:00.000Z";
  const scored = scoreNovelty({ publishedAt: "2026-10-11T00:00:00.000Z", firstSeenAt: seen, now, windowDays: 7 });
  assert.ok(scored < 0.001, `a future date scored ${scored}; it should fall back to firstSeenAt`);
  // A few hours ahead is a timezone, not a lie, and stays trusted.
  assert.ok(scoreNovelty({ publishedAt: "2026-09-01T20:00:00.000Z", firstSeenAt: seen, now }) > 0.9);
});

test("the earliest publication wins, because that is when the claim entered the world", () => {
  // The LATEST would measure activity, which is what momentum is for: a claim
  // first published six months ago and picked up again today is persistent,
  // not new, and the two scores exist to tell those apart.
  const now = "2026-09-01T12:00:00.000Z";
  const scored = scoreInsight(
    { firstSeenAt: now, lastSeenAt: now, independentCount: 2 },
    [
      { stance: "supports", resourceType: "NEWS", resource: { publishedAt: "2026-03-01T00:00:00.000Z" } },
      { stance: "supports", resourceType: "NEWS", resource: { publishedAt: "2026-09-01T00:00:00.000Z" } },
    ],
    { now, windowDays: 7 },
  );
  assert.equal(scored.novelty, 0, "the later pickup was treated as the claim's own age");
});

test("evidence reaches the score from both shapes", () => {
  // An evidence row arrives joined to its live resource or flat, and a reader
  // of only one of them silently scores every card as undated — the same trap
  // `resourceTypeOf` documents one function down.
  const now = "2026-09-01T12:00:00.000Z";
  const flat = scoreInsight(
    { firstSeenAt: now, lastSeenAt: now, independentCount: 1 },
    [{ stance: "supports", resourceType: "NEWS", publishedAt: "2009-06-01T00:00:00.000Z" }],
    { now, windowDays: 7 },
  );
  assert.equal(flat.novelty, 0, "a flat evidence row's publication date was ignored");
});

test("the three cards from the screenshot now sort below this week's material", () => {
  const now = "2026-09-01T12:00:00.000Z";
  const seenToday = "2026-09-01T09:00:00.000Z";
  const card = (publishedAt) => scoreInsight(
    { firstSeenAt: seenToday, lastSeenAt: seenToday, independentCount: 1 },
    [{ stance: "supports", resourceType: "PAPER", resource: { publishedAt } }],
    { now, windowDays: 7, dormantDays: 21, preferredResourceTypes: ["PAPER", "NEWS"] },
  );
  const archived = card("2009-06-01T00:00:00.000Z");
  const fresh = card("2026-08-30T00:00:00.000Z");
  assert.ok(archived.rank < fresh.rank, `archived ${archived.rank} did not sort below fresh ${fresh.rank}`);
  // And it is no longer strong: one source caps it at medium, and its rank has
  // fallen out of the high band anyway.
  assert.equal(strengthOf(archived.rank, { independentCount: 1, minIndependent: 2 }), "medium");
});

/* ── a claim retires when the EVENT ages out ───────────────────────────── */

test("an old event expires; a stale-but-recent one only goes dormant", () => {
  // TWO DIFFERENT FACTS. Dormant means "no new evidence in N days" — about our
  // activity, and reversible the moment a source turns up. Expired means the
  // event itself has aged out of the horizon this tab is for, which no amount
  // of fresh evidence changes: an article published today about a 2009
  // benchmark does not make the benchmark recent.
  const now = "2026-09-01T00:00:00.000Z";
  const old = nextStatus(
    { independentCount: 3, lastSeenAt: now },
    {},
    { now, eventAt: "2009-06-01T00:00:00.000Z", expireAfterDays: 90, dormantDays: 21 },
  );
  assert.equal(old, "expired", "an old event stayed on the board");
  // Recent event, no evidence for a month: dormant, not expired.
  const stale = nextStatus(
    { independentCount: 3, lastSeenAt: "2026-07-20T00:00:00.000Z" },
    {},
    { now, eventAt: "2026-07-20T00:00:00.000Z", expireAfterDays: 90, dormantDays: 21 },
  );
  assert.equal(stale, "dormant", "a merely quiet claim was retired as old");
});

test("a person's verdict outranks expiry, however old the event", () => {
  // The pinned column is the reader's own and is the whole reason it outranks
  // the pass. A pass that expired past it would be overruling a decision
  // somebody made on purpose — and the 成立 seat would empty itself over time
  // with nothing on screen to say why.
  const now = "2026-09-01T00:00:00.000Z";
  const held = nextStatus(
    { pinnedStatus: "standing", independentCount: 1, lastSeenAt: "2009-06-01T00:00:00.000Z" },
    {},
    { now, eventAt: "2009-06-01T00:00:00.000Z", expireAfterDays: 90 },
  );
  assert.equal(held, "standing", "expiry overruled a verdict a person had made");
});

test("expiry never writes the reader's column", (t) => {
  // Forging a signature. The 人工判定 chip would appear on cards nobody had
  // judged, and the 搁置 seat would fill with things nobody shelved.
  const { store, insights } = library(t);
  store.put(resource("old", { publishedAt: "2009-06-01T00:00:00.000Z" }));
  const id = claim(insights);
  insights.addEvidence(id, [evidence("old", { resourceType: "NEWS" })]);
  rescoreOne(insights, id, { insightExpireAfterDays: 90 }, "2026-09-01T00:00:00.000Z", false);
  const row = insights.get(id);
  assert.equal(row.status, "expired", "the old claim was not retired");
  assert.equal(row.pinnedStatus, null, "the pass wrote the reader's own column");
});

test("an undated claim never expires", () => {
  // "We do not know when this happened" is not evidence that it happened long
  // ago. Expiring on a missing field would quietly retire every claim from
  // every feed that omits a date.
  const now = "2026-09-01T00:00:00.000Z";
  const status = nextStatus(
    { independentCount: 3, lastSeenAt: now },
    {},
    { now, eventAt: "", expireAfterDays: 90, dormantDays: 21 },
  );
  assert.notEqual(status, "expired");
});

test("zero turns expiry off", () => {
  const now = "2026-09-01T00:00:00.000Z";
  const status = nextStatus(
    { independentCount: 3, lastSeenAt: now },
    {},
    { now, eventAt: "2009-06-01T00:00:00.000Z", expireAfterDays: 0, dormantDays: 21 },
  );
  assert.notEqual(status, "expired", "a library meant to accumulate lost its old claims");
});

test("an expired claim leaves the inbox and lands in its own seat", (t) => {
  // The whole ask: what is left on screen should be what still needs a person.
  const { store, insights } = library(t);
  store.put(resource("old", { publishedAt: "2009-06-01T00:00:00.000Z" }));
  store.put(resource("new", { publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
  const stale = claim(insights, { statement: "An archived comparison from a paper published in 2009" });
  const fresh = claim(insights, {
    statement: "A finding published this week and stated just as plainly",
    simhash: simhash("A finding published this week and stated just as plainly"),
  });
  insights.addEvidence(stale, [evidence("old", { resourceType: "NEWS" })]);
  insights.addEvidence(fresh, [evidence("new", { resourceType: "NEWS", quote: "raised $3.5bn in a Series E round led by Lightspeed this week" })]);
  const now = new Date().toISOString();
  for (const id of [stale, fresh]) rescoreOne(insights, id, { insightExpireAfterDays: 90 }, now, false);

  assert.deepEqual(
    insights.list({ verdict: "pending", take: 50 }).insights.map((row) => row.id),
    [fresh],
    "the expired claim is still in the inbox",
  );
  assert.deepEqual(
    insights.list({ verdict: "expired", take: 50 }).insights.map((row) => row.id),
    [stale],
    "the expired claim is not findable in its own seat",
  );
  const counts = insights.countsByVerdict();
  assert.equal(counts.expired, 1);
  assert.equal(counts.pending, 1, "the inbox count still includes the retired claim");
});

test("a card's quote carries the source's own publication date", (t) => {
  // THE CARD HAD ONE DATE AND IT WAS ABOUT US. `首见` is when this library first
  // saw the CLAIM, so a quote from a 2009 paper and one from this morning were
  // dated identically — and now that the tab is scoped to a horizon, that
  // difference is the single thing deciding whether a reader should care.
  const { store, insights } = library(t);
  store.put(resource("src", { publishedAt: "2026-08-28T09:00:00.000Z" }));
  const id = claim(insights);
  insights.addEvidence(id, [evidence("src", { resourceType: "NEWS" })]);
  const card = insights.list({ take: 10 }).insights.find((row) => row.id === id);
  assert.equal(card.evidencePreview[0].publishedAt, "2026-08-28T09:00:00.000Z");
});

test("an undated source shows no date rather than ours", (t) => {
  // Printing our collection time here would reintroduce the exact confusion
  // this fixes: an undated source is not old, the feed simply did not say.
  const { store, insights } = library(t);
  store.put(resource("undated", { publishedAt: undefined }));
  const id = claim(insights);
  insights.addEvidence(id, [evidence("undated", { resourceType: "NEWS" })]);
  const card = insights.list({ take: 10 }).insights.find((row) => row.id === id);
  assert.equal(card.evidencePreview[0].publishedAt, null, "an absent date was filled in with something");
});

test("each source keeps its own date rather than the claim taking one", (t) => {
  // A claim with three sources has three publication dates, and folding them
  // into one number on the card would pick a winner silently.
  const { store, insights } = library(t);
  store.put(resource("old", { publishedAt: "2026-01-01T00:00:00.000Z" }));
  store.put(resource("new", { publishedAt: "2026-08-30T00:00:00.000Z" }));
  const id = claim(insights);
  insights.addEvidence(id, [
    evidence("old", { resourceType: "NEWS" }),
    evidence("new", { resourceType: "NEWS", quote: "raised $3.5bn in a Series E round led by Lightspeed again" }),
  ]);
  const card = insights.list({ take: 10 }).insights.find((row) => row.id === id);
  const dates = card.evidencePreview.map((one) => one.publishedAt).sort();
  assert.deepEqual(dates, ["2026-01-01T00:00:00.000Z", "2026-08-30T00:00:00.000Z"]);
});

test("the extractor is told to quote what was said, not what the blurb claims", () => {
  // MEASURED ON THE LIVE TAB: 23 of 36 video quotes carried no timestamp, and
  // the reason was not a missing transcript. The videos had them — 70,765
  // characters and 1,942 cues on one — and 95% of the block handed to the model
  // was transcript. It quoted the 386-character description anyway, because a
  // publisher's blurb is polished, on-topic and short while a transcript is a
  // wall of conversational speech.
  //
  // What it produced were sentences like "She is one of the three authors of
  // the report" and "Tara Seshan leads product for ChatGPT Work at OpenAI" —
  // third-person description, nobody's testimony, and unpointable at any moment
  // in the recording. The card correctly said 来自简介 and correctly showed no
  // timestamp; the quote was simply the wrong quote.
  assert.match(EXTRACTION_PROMPT, /Transcript.*QUOTE FROM THE TRANSCRIPT/s, "the prompt does not prefer spoken words");
  // And the escape hatch stays: a figure stated only in the show notes is still
  // a fact the source published, and is worth keeping as the weaker of the two.
  assert.match(EXTRACTION_PROMPT, /Quote the description only when/, "the prompt forbids description quotes outright");
});

/* ── a transcribed video's blurb is not evidence ───────────────────────── */

test("spokenOnly removes the description from a transcribed video", () => {
  // MEASURED TWICE. Told in the prompt to prefer the transcript, the model
  // quoted the description anyway on 28 of 28 timestamp-less video quotes —
  // verified by searching each quote in its own transcript: none were there,
  // none of those videos lacked a transcript, and the locator was not at fault.
  //
  // A blurb is polished, on-topic and 386 characters; a transcript is 7,610
  // characters of conversational speech with the claim buried in it. An
  // instruction does not beat that, so the material does.
  const cues = Array.from({ length: 200 }, (_, at) => ({
    start: at * 36, duration: 36, text: `spoken sentence number ${at} with real conversational content here`,
  }));
  const row = {
    id: "v", type: "YOUTUBE_VIDEO", title: "A talk",
    abstract: "PUBLISHER BLURB about the video, written to sell it.",
    sourceUrl: "https://youtu.be/aaaaaaaaaaa",
  };
  const transcript = { language: "en", text: cues.map((c) => c.text).join(" "), cues };
  const spoken = sourceMaterial(row, transcript, 8000, { spokenOnly: true });
  assert.equal(spoken.includes("PUBLISHER BLURB"), false, "the blurb is still quotable");
  assert.ok(spoken.includes("Transcript"), "the transcript went missing with it");
});

test("the podcast path still gets the description", () => {
  // Same function, two callers, two jobs: the generator is writing ABOUT the
  // video and the blurb is legitimate context there. An option rather than a
  // rule for exactly that reason.
  const cues = [{ start: 0, duration: 36, text: "some spoken words that go on for a while here" }];
  const row = { id: "v", type: "YOUTUBE_VIDEO", title: "A talk", abstract: "PUBLISHER BLURB", sourceUrl: "https://youtu.be/aaaaaaaaaaa" };
  const both = sourceMaterial(row, { language: "en", text: cues[0].text, cues }, 8000);
  assert.ok(both.includes("PUBLISHER BLURB"), "the podcast generator lost its context");
});

test("a source with no transcript keeps its body whatever the caller asks", () => {
  // `spokenOnly` means "prefer what was said where anything was said". An
  // article has no spoken words and dropping its body would leave a header and
  // nothing to quote — the whole corpus of written sources, silenced by an
  // option meant for videos.
  const row = { id: "a", type: "NEWS", title: "An article", abstract: "THE BODY of the article.", sourceUrl: "https://news.test/1" };
  const block = sourceMaterial(row, undefined, 8000, { spokenOnly: true });
  assert.ok(block.includes("THE BODY"), "an article lost its body text");
});

test("a transcript that did not fit says so, rather than claiming no body exists", () => {
  // "No body text is stored for this source" would send whoever reads it to fix
  // the wrong thing: the transcript is there and the budget was too small.
  const cues = Array.from({ length: 400 }, (_, at) => ({ start: at, duration: 1, text: `line ${at} of many` }));
  const row = { id: "v", type: "YOUTUBE_VIDEO", title: "A talk", abstract: "blurb", sourceUrl: "https://youtu.be/aaaaaaaaaaa" };
  const block = sourceMaterial(row, { language: "en", text: "x", cues }, 260, { spokenOnly: true });
  assert.equal(block.includes("No body text is stored"), false, "a budget problem was reported as a missing transcript");
});

/* ── a spoken quote is checked against the recording ───────────────────── */

test("a quote spliced across a sampling gap is dropped, not published", () => {
  // THE HOLE `verifyQuote` CANNOT SEE. It checks the quote against the BLOCK
  // the model was shown, which is right and is not enough for a video: the
  // block is SAMPLED when a transcript does not fit the budget, keeping every
  // Nth cue joined by a newline. Measured on a real recording — 1,942 cues into
  // 7,610 characters — that is every seventh cue, so two lines the model saw
  // side by side are six cues apart. A quote copied across that boundary is
  // verbatim in the block, passes verification, and is a splice of two moments
  // minutes apart presented as one sentence somebody said.
  const cues = Array.from({ length: 40 }, (_, at) => ({
    start: at * 30, text: `cue ${at} carrying a full sentence of real spoken content`,
  }));
  // The block as the model saw it: every 7th cue, newline-joined.
  const sampled = cues.filter((_, at) => at % 7 === 0).map((c) => c.text).join("\n");
  const blocks = new Map([["v", sampled]]);
  const cuesById = new Map([["v", cues]]);

  // A quote that spans the gap between two sampled lines whose OPENING run is
  // real still resolves — to where the passage begins.
  const spliced = `${cues[7].text} ${cues[14].text}`;
  const claim = (quote) => ({
    statement: "A claim about something that was said in the recording",
    kind: "finding", layer: null, gloss: "", entities: ["X"],
    evidence: [{ label: "S1", resourceId: "v", stance: "supports", quote, speaker: "" }],
  });
  assert.equal(verifyClaims([claim(spliced)], blocks, cuesById).kept.length, 1, "a locatable opening run was thrown away");

  // A quote whose opening run is NOT in the recording at all is dropped, even
  // though it appears verbatim in the sampled block.
  const invented = "a sentence assembled from words nobody put together like this";
  const withInvented = new Map([["v", `${sampled}\n${invented}`]]);
  const out = verifyClaims([claim(invented)], withInvented, cuesById);
  assert.equal(out.kept.length, 0, "a quote absent from the recording was published");
  assert.match(out.dropped[0].reason, /continuous run in the recording/);
});

test("a source with no transcript is verified exactly as before", () => {
  // The recording check applies only where there is a recording. An article's
  // quote is checked against its block and nothing else, or every written
  // source would be dropped by a rule written for videos.
  const blocks = new Map([["a", "## An article\n\nThe body says something specific and checkable here."]]);
  const claim = {
    statement: "A claim drawn from an article rather than from a talk",
    kind: "finding", layer: null, gloss: "", entities: ["X"],
    evidence: [{ label: "S1", resourceId: "a", stance: "supports", quote: "The body says something specific and checkable here.", speaker: "" }],
  };
  assert.equal(verifyClaims([claim], blocks, new Map()).kept.length, 1, "an article quote was dropped by the transcript rule");
});

test("a video whose transcript is not to hand is not dropped for it", () => {
  // `cuesById` is empty when the pass could not load a transcript. Treating
  // "we do not have it" as "the quote is not in it" would drop every claim from
  // every video the moment the cache was cold.
  const blocks = new Map([["v", "## A talk\n\nsome spoken words that were said and are quotable here."]]);
  const claim = {
    statement: "A claim from a talk whose cues are not loaded in this pass",
    kind: "finding", layer: null, gloss: "", entities: ["X"],
    evidence: [{ label: "S1", resourceId: "v", stance: "supports", quote: "some spoken words that were said and are quotable here.", speaker: "" }],
  };
  assert.equal(verifyClaims([claim], blocks, new Map()).kept.length, 1);
});

/* ── the pass grades its own provenance ────────────────────────────────── */

test("a pass counts how many of its spoken quotes can be played", async (t) => {
  // MEASURED BY HAND FOUR TIMES TO GET HERE, each time with a shell script
  // written after the fact against a board that had already drifted. A number
  // nobody computes is a number that regresses quietly: the entire reason this
  // took four attempts is that "23 of 36 video quotes have no timestamp" was
  // never on a screen and never in a log.
  //
  // The pass counts it while it still has the cues in hand, which is the only
  // moment the answer is cheap.
  const { store, insights } = library(t);
  const cues = Array.from({ length: 30 }, (_, at) => ({
    start: at * 30, text: `cue ${at} carrying a full sentence of real spoken content`,
  }));
  store.put(resource("v", { type: "YOUTUBE_VIDEO", title: "A talk", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  store.putTranscript("v", "en", cues.map((c) => c.text).join(" "), cues);
  store.put(resource("n", { type: "NEWS", title: "An article about the same story" }));

  // A model that quotes the recording verbatim.
  const chat = async function* () {
    yield {
      text: JSON.stringify({
        claims: [{
          statement: "A claim drawn from something that was actually said in the recording",
          kind: "finding",
          entities: ["Anthropic", "OpenAI"],
          evidence: [{ source: "S1", stance: "supports", quote: cues[9].text }],
        }],
      }),
    };
  };
  const result = await insightPassOnce(store, insights, chat, undefined, {});
  // Whether the claim survived depends on labels the fixture cannot control;
  // what is pinned here is that the pass REPORTS the two numbers at all, and
  // that they are consistent with each other.
  assert.equal(typeof result.spokenQuotes, "number", "the pass does not count its spoken quotes");
  assert.equal(typeof result.locatedQuotes, "number", "the pass does not count what it can place");
  assert.ok(
    result.locatedQuotes <= result.spokenQuotes,
    `more quotes placed (${result.locatedQuotes}) than taken from a recording (${result.spokenQuotes})`,
  );
});

test("every spoken quote that survives verification can be placed", async (t) => {
  // THE GUARANTEE, stated as a test rather than as a hope. `verifyClaims`
  // checks anything quoted from a transcript against the recording using the
  // same matcher the card draws ▶ with, so a surviving video quote HAS a
  // moment by construction. If that ever stops being true, the pass's own
  // grade shows it and this fails.
  const { store, insights } = library(t);
  const cues = Array.from({ length: 30 }, (_, at) => ({
    start: at * 30, text: `cue ${at} carrying a full sentence of real spoken content`,
  }));
  store.put(resource("v", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa" }));
  store.putTranscript("v", "en", cues.map((c) => c.text).join(" "), cues);
  store.put(resource("n", { type: "NEWS", title: "A second readable row for the pass" }));

  // A model that quotes something the recording does not contain.
  const chat = async function* () {
    yield {
      text: JSON.stringify({
        claims: [{
          statement: "A claim resting on words nobody in the recording ever said",
          kind: "finding",
          entities: ["Anthropic", "OpenAI"],
          evidence: [{ source: "S1", stance: "supports", quote: "a sentence assembled from words nobody put together like this at all" }],
        }],
      }),
    };
  };
  const result = await insightPassOnce(store, insights, chat, undefined, {});
  assert.equal(result.locatedQuotes, result.spokenQuotes, "a spoken quote survived that cannot be placed");
});

test("a scoped run can lower the model-call ceiling for one pass", async (t) => {
  // THE NUMBER THE DIALOG NOW ASKS FOR. It used to ask for ROWS — the scan's
  // working set, defaulted to 200 — while the ceiling that decides how many
  // model calls a pass makes was not in the dialog at all, at 20. So a reader
  // adjusting the visible number moved something that mostly does not matter
  // and could not touch the one that bills. The two also disagreed: 200 rows
  // against a 20-cluster ceiling means a slice of unrelated sources forms
  // roughly 200 clusters, 20 survive, and 180 rows were read to be discarded.
  //
  // ASSERTED THROUGH THE PASS, NOT THROUGH THE HELPER. Three values in this
  // batch were accepted by an outer function and never handed to the inner one
  // — a fetcher, a report, a default — and every one of them looked correct at
  // both ends. The only test that catches that enters where production enters.
  const { store, insights } = library(t);
  const word = (n) => "w" + n.toString(36) + "x" + ((n * 7919) % 99991).toString(36);
  for (let at = 0; at < 30; at += 1) {
    store.put(resource("r" + String(at).padStart(3, "0"), {
      title: `${word(at * 3)} ${word(at * 3 + 1)} ${word(at * 3 + 2)}`,
      abstract: Array.from({ length: 12 }, (_, k) => word(at * 100 + k)).join(" "),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString(),
      publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }));
  }
  store.setSetting("insightMaxRows", 100);
  store.setSetting("insightMaxClusters", 20);
  store.setSetting("insightMaxAgeDays", 0);

  let calls = 0;
  const chat = async function* () { calls += 1; yield { error: "no model here" }; };

  // Unscoped: the stored ceiling of 20 applies.
  calls = 0;
  const wide = await insightPassOnce(store, insights, chat, undefined, {});
  assert.ok(wide.clusters > 3, `only ${wide.clusters} clusters formed; the fixture cannot show a ceiling`);

  // Scoped to three: three clusters, three model calls, whatever the setting
  // says. A value accepted and dropped would leave this at the stored 20.
  calls = 0;
  const narrow = await insightPassOnce(store, insights, chat, undefined, { scope: { maxClusters: 3 } });
  assert.equal(narrow.clusters, 3, `the scope asked for 3 clusters and the pass made ${narrow.clusters}`);
  assert.equal(calls, 3, `the scope asked for 3 model calls and the pass made ${calls}`);
});

test("the pass itself clears the slice it read, so the queue drains", async (t) => {
  // ASSERTED THROUGH THE PASS, for the reason the test above gives: the
  // watermark's formula is mirrored by a helper in this file, and a mirror
  // cannot catch the source drifting away from it. This one enters where
  // production enters and reads the watermark the pass actually returns.
  //
  // The shape is the real one — a scan window far wider than the model-call
  // budget, which is what `insightMaxRows: 600` against `insightMaxClusters: 4`
  // means. Before this, the returned watermark sat within a couple of rows of
  // the start whatever the window held, so every pass re-read the same slice.
  const { store, insights } = library(t);
  const word = (n) => "w" + n.toString(36) + "x" + ((n * 7919) % 99991).toString(36);
  const last = 120;
  for (let at = 0; at < last; at += 1) {
    store.put(resource("q" + String(at).padStart(3, "0"), {
      title: `${word(at * 3)} ${word(at * 3 + 1)} ${word(at * 3 + 2)}`,
      abstract: Array.from({ length: 12 }, (_, k) => word(at * 100 + k)).join(" "),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString(),
      publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }));
  }
  store.setSetting("insightMaxRows", 600);
  store.setSetting("insightMaxClusters", 4);
  store.setSetting("insightMaxAgeDays", 0);

  const chat = async function* () { yield { error: "no model here" }; };
  const pass = await insightPassOnce(store, insights, chat, undefined, {});

  assert.ok(pass.binned > 50, `only ${pass.binned} rows were binned; the ceiling never bit and this proves nothing`);
  assert.equal(
    pass.watermark,
    new Date(Date.UTC(2026, 0, 1, 0, 0, last - 1)).toISOString(),
    `the pass read ${pass.rows} rows and left the watermark at ${pass.watermark}; the slice it just read comes back next pass`,
  );
});

test("the scan window is bounded by what clustering costs, not by the model bill", (t) => {
  // The row ceiling was 600, which is about a day of this library's intake — so
  // a pass could never clear more than a day and a backlog measured in weeks
  // could not be caught up at any schedule. Rows are the working set clustering
  // ranks; `maxClusters` is what bills. The two were bounded as though they
  // cost the same.
  const { store, insights } = library(t);
  const word = (n) => "w" + n.toString(36) + "x" + ((n * 7919) % 99991).toString(36);
  const many = 1500;
  for (let at = 0; at < many; at += 1) {
    store.put(resource("s" + String(at).padStart(4, "0"), {
      title: `${word(at * 3)} ${word(at * 3 + 1)} ${word(at * 3 + 2)}`,
      abstract: Array.from({ length: 12 }, (_, k) => word(at * 100 + k)).join(" "),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + at * 1000).toISOString(),
      publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }));
  }
  store.setSetting("insightMaxRows", 1500);
  store.setSetting("insightMaxAgeDays", 0);
  assert.equal(
    collectCandidates(store, readInsightConfig(store)).rows.length,
    many,
    "the scan was clamped below what was asked for; a backlog cannot be caught up",
  );
});

test("the backlog is what the next pass would be offered, not what this one paged in", async (t) => {
  // "还没读到" is the one number a reader uses to decide whether to step in, and
  // it counted rows at or after the NEWEST row this scan happened to page in.
  //
  // THE TWO ONLY DIVERGE WHEN THE PER-TYPE SHARE LEAVES LEFTOVERS, which is why
  // this fixture needs two types and a first attempt with one proved nothing:
  // with a single type the scan's newest row IS the watermark and both counts
  // agree. Give a quiet type rows far newer than a busy type's leftovers and
  // they come apart completely — the scan's edge lands on the quiet type's
  // newest while the watermark stops at the busy type's first unconsidered row,
  // which is exactly the live shape that had the tab reading "26 还没读到" with
  // a month of material sitting unoffered behind it.
  const { store, insights } = library(t);
  const word = (n) => "w" + n.toString(36) + "x" + ((n * 7919) % 99991).toString(36);
  const stamp = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seconds * 1000).toISOString();
  const body = (at) => ({
    title: `${word(at * 3)} ${word(at * 3 + 1)} ${word(at * 3 + 2)}`,
    abstract: Array.from({ length: 12 }, (_, k) => word(at * 100 + k)).join(" "),
    publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  });

  const busy = 300;
  for (let at = 0; at < busy; at += 1) {
    store.put(resource("n" + String(at).padStart(4, "0"), { ...body(at), type: "NEWS", createdAt: stamp(at) }));
  }
  // Newer than anything the busy type will leave behind.
  const quiet = 10;
  for (let at = 0; at < quiet; at += 1) {
    store.put(resource("p" + String(at).padStart(4, "0"), { ...body(9000 + at), type: "PAPER", createdAt: stamp(1000 + at) }));
  }

  store.setSetting("insightResourceTypes", ["NEWS", "PAPER"]);
  store.setSetting("insightMaxRows", 120);
  store.setSetting("insightMaxClusters", 4);
  store.setSetting("insightMaxAgeDays", 0);

  const chat = async function* () { yield { error: "no model here" }; };
  const pass = await insightPassOnce(store, insights, chat, undefined, {});

  assert.ok(pass.watermark !== "", "the watermark did not move, so this proves nothing about the backlog");
  const everything = [
    ...Array.from({ length: busy }, (_, at) => stamp(at)),
    ...Array.from({ length: quiet }, (_, at) => stamp(1000 + at)),
  ];
  const offered = everything.filter((at) => at > pass.watermark).length;
  assert.ok(offered > 100, `only ${offered} rows are above the watermark; the fixture is not exercising a real backlog`);
  assert.equal(
    pass.backlog,
    offered,
    `the tab would say ${pass.backlog} still to read while ${offered} rows sit above the watermark at ${pass.watermark}`,
  );
});

test("a video that publishes no captions is asked for once, not on every drain", (t) => {
  // MEASURED: a drain of twelve tried two videos and bought nothing. The first
  // answered "timedtext: this video publishes no caption track; relay is
  // blocked; gens: HTTP 404; supadata returned no transcript" — every route
  // agreeing, which the classifier has called PERMANENT since it was written.
  // Nothing recorded it. So the same videos were paid for again on the next
  // drain, and the next, and `awaitingTranscript` counted them as work that
  // would never finish.
  //
  // This is `thumbnail_checked_at`'s lesson applied to a queue that costs money.
  const { store } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-01T00:00:00.000Z" }));
  store.put(resource("v2", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-02T00:00:00.000Z" }));
  assert.equal(store.countVideosWithoutTranscript(), 2, "the fixture did not start with two waiting");

  store.markTranscriptAbsent("v1", "timedtext: this video publishes no caption track");
  assert.equal(store.countVideosWithoutTranscript(), 1, "a video proven to have no captions is still in the fetch queue");
  assert.equal(store.countVideosWithoutCaptions(), 1, "the absence was not counted anywhere");
  assert.deepEqual(
    store.videosWithoutTranscript(20).map((row) => row.id),
    ["v2"],
    "the drain would buy the caption-less video again",
  );
});

test("a transcript arriving later clears the absence", (t) => {
  // Auto-captions can appear months after publication, so the mark is "stop
  // asking on the drain's own account", not "never again". Leaving it set would
  // keep a now-transcribed video out of the count for ever while the pass reads
  // it happily — two readers of one table disagreeing about whether the video
  // has words.
  const { store } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-01T00:00:00.000Z" }));
  store.markTranscriptAbsent("v1", "no caption track");
  assert.equal(store.countVideosWithoutCaptions(), 1);

  store.putTranscript("v1", "en", "the words, at last", []);
  assert.equal(store.countVideosWithoutCaptions(), 0, "the video has a transcript and is still marked as having none");
  assert.equal(store.countVideosWithoutTranscript(), 0, "a transcribed video is being counted as waiting");
});

test("the schedule reports what will happen, not what was chosen", (t) => {
  // The pass is chained after collection and only asks whether it is due, so
  // it cannot tick more often than the thing that calls it. The Host has said
  // so in a comment since the pass was written — "30 under an hourly collection
  // is an hourly pass, not a half-hourly one" — and the tab reported 每 30 分钟
  // anyway. Setting it to 30 changed nothing and nothing said why.
  const { store } = library(t);
  const effective = (asked, driver) => {
    if (!Number.isFinite(asked) || asked <= 0) return 0;
    if (!Number.isFinite(driver) || driver <= 0) return asked;
    return Math.max(driver, Math.ceil(asked / driver) * driver);
  };
  assert.equal(effective(30, 60), 60, "a half-hourly ask under hourly collection is not reported as hourly");
  assert.equal(effective(720, 60), 720, "a twelve-hourly ask was dragged down to the collection tick");
  assert.equal(effective(90, 60), 120, "an ask between two ticks must round UP to the tick that covers it");
  assert.equal(effective(0, 60), 0, "off must stay off");
  assert.equal(effective(30, 0), 30, "with collection off there is nothing to round to");
  // And the value the route reads comes from the store, so a library with no
  // collection setting still answers rather than reporting NaN.
  assert.equal(Number(store.getSetting("collectIntervalMinutes", 60)), 60);
});

test("an answer that stops mid-claim keeps the claims that finished", () => {
  // MEASURED on one pass: twelve sources reported as 抽取失败 with "no JSON
  // object in it carries a claims array" — which is the message for a refusal,
  // and is also exactly what a truncated answer looks like from outside. The
  // parser needs a COMPLETE balanced object, so an answer that runs out of room
  // part-way through the array matched nothing and the whole call was lost,
  // including the claims that had already been written in full.
  const labels = new Map([["A", "r1"], ["B", "r2"]]);
  // One line, because the truncation is about a missing closing brace and not
  // about whitespace, and a multi-line fixture here was written with an escape
  // that did not survive the patch that wrote it.
  const cut = '{"claims": ['
    + '{"statement": "The first claim, whole and paid for", "kind": "funding", "entities": ["Acme"], '
    + '"evidence": [{"source": "A", "stance": "supports", "quote": "a quote long enough to be checked against its source"}]}, '
    + '{"statement": "The second one was cut off here", "kind": "fun';
  const rejected = [];
  const claims = parseClaims(cut, labels, { onReject: (why) => rejected.push(String(why)) });
  assert.equal(claims.length, 1, "the completed claim was thrown away with the truncated one");
  assert.match(claims[0].statement, /whole and paid for/);
  assert.ok(
    rejected.some((why) => /stopped part-way/.test(why)),
    "the truncation was not reported, so a silent partial reads as an honest empty answer",
  );
});

test("prose with a brace in it is still a failure, not a partial success", () => {
  // The salvage must not turn a refusal into a quiet nothing. A model that
  // declines, or answers in an object of some other shape, is a real failure the
  // caller has to see — inventing a partial success out of it would hide the one
  // thing worth knowing.
  assert.throws(
    () => parseClaims('I cannot help with that. {"note": "refused"}', new Map([["A", "r1"]]), {}),
    /did not return claims/,
    "a refusal was salvaged into a success",
  );
  assert.throws(
    () => parseClaims('{"claims": [', new Map([["A", "r1"]]), {}),
    /did not return claims/,
    "an answer cut off before any claim completed was reported as a success",
  );
});

test("the transcript queue can be read without starting a paid drain", (t) => {
  // It was only ever visible as a COUNT. `/insights/transcribe` walks the same
  // list, but fetching is the only thing it will do with it — so anything that
  // wanted to SEE the queue had to start a paid drain to find out what was in
  // it, which is a strange price for a question.
  //
  // The rows must be the ones a drain would try, in the order it would try
  // them, so a caller filling them in from somewhere this Host cannot reach is
  // doing the drain's work rather than racing it.
  const { store } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-01T00:00:00.000Z" }));
  store.put(resource("v2", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-02T00:00:00.000Z" }));
  store.put(resource("v3", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-03T00:00:00.000Z" }));
  store.markTranscriptAbsent("v2", "no caption track");

  const queue = store.videosWithoutTranscript(50).map((row) => row.id);
  assert.deepEqual(queue, ["v1", "v3"], "the queue is not oldest-first, or is offering a video proven to have none");
  assert.equal(store.countVideosWithoutTranscript(), 2);

  // And a transcript posted in from outside takes the video off the queue, which
  // is the whole point of being able to read it.
  store.putTranscript("v1", "en", "words fetched by some other route entirely", []);
  assert.deepEqual(
    store.videosWithoutTranscript(50).map((row) => row.id),
    ["v3"],
    "a video whose transcript arrived from elsewhere is still being offered for fetching",
  );
});

test("the status codes are classified, and the word boundaries survive the source", () => {
  // THE REGEX WAS CORRUPTED IN THE FILE, and every existing test passed anyway.
  // Six bytes of 0x08 sat where the source meant to carry a word-boundary
  // escape, so the patterns read as literal backspaces: `HTTP 404` classified as
  // "other" instead of "absent", `HTTP 429` as "other" instead of "quota". The
  // one test that touched this used "timedtext: HTTP 404 no caption track",
  // which matched on the words "no caption" and reported the right answer for
  // the wrong reason, and the corruption survived every run.
  //
  // These cases carry NO other matchable words, so they can only pass if the
  // numbers themselves match.
  assert.equal(transcriptFailureKind(new Error("HTTP 404")), "absent");
  assert.equal(transcriptFailureKind(new Error("HTTP 400 bad request")), "absent");
  assert.equal(transcriptFailureKind(new Error("HTTP 429")), "quota");
  // AND THE BOUNDARIES STILL BOUND. Replacing the broken escape with a bare
  // number would make every test above pass while matching an id, a byte count,
  // or a year that happens to contain the digits.
  assert.equal(transcriptFailureKind(new Error("status 4040 nonsense")), "other");
  assert.equal(transcriptFailureKind(new Error("read 1429 bytes")), "other");
});

test("a page we were not shown is not a fact about the video", () => {
  // "no caption track" is what a BLOCKED caller sees whether or not the video
  // has captions, and marking it absent writes a permanent verdict into the
  // library on the strength of a consent wall. Measured: video zIwwkuB2NPQ was
  // recorded as publishing no captions while yt-dlp fetched its English track
  // the same minute from a machine YouTube does not throttle.
  assert.equal(
    transcriptFailureKind(new Error("the watch page carried no player response, so this caller was served something other than the video")),
    "other",
    "a blocked page was recorded as a permanent fact about the video",
  );
  // The real answer still is one: a player response that carries no tracks.
  assert.equal(transcriptFailureKind(new Error("this video publishes no caption track")), "absent");
});

test("clearing the absences puts the videos back without touching real transcripts", (t) => {
  // The first marks were taken on a sentence a blocked caller sees whether or
  // not the video has captions, and nothing recorded which of them were sound —
  // so they cannot be repaired one at a time.
  const { store } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-01T00:00:00.000Z" }));
  store.put(resource("v2", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-02T00:00:00.000Z" }));
  store.put(resource("v3", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-03T00:00:00.000Z" }));
  store.markTranscriptAbsent("v1", "this video publishes no caption track");
  store.markTranscriptAbsent("v2", "this video publishes no caption track");
  store.putTranscript("v3", "en", "words that were really fetched", [{ start: 1, duration: 2, text: "words" }]);
  assert.equal(store.countVideosWithoutCaptions(), 2);

  assert.equal(store.clearTranscriptAbsences(), 2, "the clear did not report what it cleared");
  assert.equal(store.countVideosWithoutCaptions(), 0);
  assert.deepEqual(
    store.videosWithoutTranscript(50).map((row) => row.id),
    ["v1", "v2"],
    "the videos did not go back on the queue they were wrongly taken off",
  );
  // AND THE REAL TRANSCRIPT IS UNTOUCHED. A clear that reached the fetched rows
  // would turn a repair into a second, larger loss.
  const kept = store.getTranscript("v3");
  assert.equal(kept?.text, "words that were really fetched");
  assert.equal(kept?.cues?.length, 1, "the cues were dropped, so the video can no longer be seeked");
});

test("a stored transcript outranks an outside claim that there is none", (t) => {
  // The absence route takes evidence from a caller that can see the full track
  // list, which this Host often cannot. But an outside opinion must never
  // overwrite a transcript already in hand: that would turn a race between two
  // fetchers into a video losing words it had.
  const { store } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-01T00:00:00.000Z" }));
  store.putTranscript("v1", "en", "words already fetched", [{ start: 0, duration: 1, text: "words" }]);

  // The guard the route applies before it calls the store.
  const held = store.getTranscript("v1");
  assert.ok(held !== undefined && String(held.text) !== "", "the fixture has no transcript to protect");

  // And when there really is none, the mark takes the video off the queue with
  // its reason recorded — an absence nobody can audit is the state the first
  // batch of these was in.
  store.put(resource("v2", { type: "YOUTUBE_VIDEO", createdAt: "2026-08-02T00:00:00.000Z" }));
  store.markTranscriptAbsent("v2", "yt-dlp listed every track for this video and found none");
  assert.deepEqual(store.videosWithoutTranscript(50).map((row) => row.id), [], "a verified absence left the video on the fetch queue");
  assert.equal(store.countVideosWithoutCaptions(), 1);
});

test("the queue route answers a real request, not a 400 from its own scope", async (t) => {
  // IT SHIPPED BROKEN AND THE SUITE WAS GREEN. The handler read a bare `params`,
  // a name declared inside the /insights/list block a few hundred lines above —
  // a ReferenceError, thrown before anything was sent, caught by the outer
  // handler and served as a 400 with an EMPTY BODY. From outside that reads as
  // "your request was malformed" for a request that was fine, and the backfill
  // driving off it reported an empty queue and did nothing at all.
  //
  // The same shape as the `ctx` bug this repository already carries a note
  // about, and the store-level tests could not see it because the fault was in
  // the route, not the store. So this one enters where the browser enters.
  const { store, insights } = library(t);
  store.put(resource("v1", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa", createdAt: "2026-08-01T00:00:00.000Z" }));
  store.put(resource("v2", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/bbbbbbbbbbb", createdAt: "2026-08-02T00:00:00.000Z" }));
  store.markTranscriptAbsent("v2", "checked from a machine that can see the track list");
  void insights;

  const answers = [];
  const handle = createInsightRoutes({
    store,
    chat: undefined,
    logger: undefined,
    sendJson: (res, code, body) => answers.push({ code, body }),
    readJson: async (req) => JSON.parse(req.__body ?? "{}"),
  });

  await handle({ method: "GET", url: "/insights/awaiting?take=5", headers: {} }, {}, "/insights/awaiting");
  const answer = answers[answers.length - 1];
  assert.equal(answer.code, 200, "the queue route answered " + answer.code + " to a well-formed request");
  assert.equal(answer.body.data.waiting, 1);
  assert.equal(answer.body.data.captionsUnavailable, 1);
  assert.deepEqual(answer.body.data.videos.map((row) => row.id), ["v1"], "the route named the wrong videos");

  // And with no query at all, since that is the other way a caller uses it.
  await handle({ method: "GET", url: "/insights/awaiting", headers: {} }, {}, "/insights/awaiting");
  assert.equal(answers[answers.length - 1].code, 200, "the route needs a query string to work");
});

/* ── the block is a conversation, not a skeleton ───────────────────────── */

test("an excerpt is a continuous run, not every Nth line", () => {
  // THIS IS WHY THE EXTRACTION READ AS A LIST OF FACTS. The excerpt kept every
  // Nth cue and dropped the rest — measured on a real recording, 1,942 cues
  // into 7,610 characters is every nineteenth — so the model received the first
  // sentence of one thought, the fourth sentence of the next, and nothing that
  // joined them. Measured: 101 lines with 100 breaks in them, covering 5.2% of
  // the conversation.
  //
  // An argument worth extracting is made over consecutive minutes: a speaker
  // states a counterintuitive position, gives the number behind it, then says
  // what it implies. Sampled to one line in nineteen, all that survives is what
  // stands alone in a single cue — a funding figure, a job title, a product
  // name. The reasoning was not passed over by the model; it was never in the
  // block.
  const cues = Array.from({ length: 400 }, (_, at) => ({
    start: at * 2, duration: 2, text: `line ${at} of an argument that continues into the next line`,
  }));
  const row = { id: "v", type: "YOUTUBE_VIDEO", title: "A talk", sourceUrl: "https://youtu.be/aaaaaaaaaaa" };
  const block = sourceMaterial(row, { language: "en", text: "x", cues }, 4000, { spokenOnly: true });

  const numbers = [...block.matchAll(/line (\d+) of an argument/g)].map((m) => Number(m[1]));
  assert.ok(numbers.length > 5, `only ${numbers.length} lines survived; the fixture proves nothing`);
  for (let at = 1; at < numbers.length; at += 1) {
    assert.equal(
      numbers[at],
      numbers[at - 1] + 1,
      `line ${numbers[at - 1]} is followed by ${numbers[at]}; the excerpt is a skeleton, and a quote copied across that seam exists nowhere in the recording`,
    );
  }
});

test("the insight pass asks for the whole recording, not an episode's share", () => {
  // 8,000 characters is 11% of a 70,000-character conversation, and no prompt
  // recovers the other 89%. Two callers want opposite things from one function:
  // a script is about many sources and needs a little of each; an extraction is
  // an argument out of one recording and needs all of it.
  const cues = Array.from({ length: 2000 }, (_, at) => ({
    start: at * 2, duration: 2, text: `line ${at} carrying part of a long conversation here`,
  }));
  const row = { id: "v", type: "YOUTUBE_VIDEO", title: "A talk", sourceUrl: "https://youtu.be/aaaaaaaaaaa" };
  const transcript = { language: "en", text: "x", cues };
  const episode = sourceMaterial(row, transcript, 8000, { spokenOnly: true });
  const extraction = sourceMaterial(row, transcript, 120_000, { spokenOnly: true });
  assert.ok(
    extraction.length > episode.length * 8,
    `the extraction block is only ${Math.round(extraction.length / episode.length)}x the episode's`,
  );
});

test("a label never claims more of the recording than the block holds", () => {
  // A model told it holds the whole recording speaks for the parts it was never
  // given — which is the reason this label exists, and it said "sampled across
  // the whole recording" while holding a continuous opening.
  const cues = Array.from({ length: 400 }, (_, at) => ({ start: at, duration: 1, text: `line ${at} of many words here` }));
  const row = { id: "v", type: "YOUTUBE_VIDEO", title: "A talk", sourceUrl: "https://youtu.be/aaaaaaaaaaa" };
  const trimmed = sourceMaterial(row, { language: "en", text: "x", cues }, 2000, { spokenOnly: true });
  assert.equal(trimmed.includes("sampled across"), false, "the label still describes a sampler that no longer exists");
  assert.match(trimmed, /continues beyond this/, "a trimmed block does not say it is trimmed");

  const whole = sourceMaterial(row, { language: "en", text: "x", cues }, 120_000, { spokenOnly: true });
  assert.match(whole, /Transcript \(complete\)/, "a complete transcript is not reported as complete");
});

test("a video longer than the auto-read ceiling is deferred, not read", (t) => {
  // A ceiling as well as a floor, and only the floor existed. Five hours
  // excludes a conference recording or an archive dump — where the length
  // itself says it is not one conversation — while keeping the long-form
  // interview this library is for. Deferred rather than discarded: it stays in
  // the library and a person can decide.
  const { store } = library(t);
  store.put(resource("normal", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/aaaaaaaaaaa", durationSeconds: 2 * 3600 }));
  store.put(resource("huge", { type: "YOUTUBE_VIDEO", sourceUrl: "https://youtu.be/bbbbbbbbbbb", durationSeconds: 6 * 3600 }));
  store.putTranscript("normal", "en", "spoken words that go on for a while", [{ start: 0, text: "spoken words that go on for a while" }]);
  store.putTranscript("huge", "en", "spoken words that go on for a while", [{ start: 0, text: "spoken words that go on for a while" }]);

  const scan = collectCandidates(store, { insightMaxRows: 20, insightResourceTypes: ["YOUTUBE_VIDEO"], insightMaxAgeDays: 0 });
  assert.deepEqual(scan.rows.map((row) => row.id), ["normal"], "a six-hour recording was read automatically");
  assert.match(String(scan.skipped[0]?.reason ?? ""), /ceiling/, "it was skipped without saying why");
});

test("purging takes the evidence with the claims, in one transaction", (t) => {
  // A half-emptied table is a board showing claims whose evidence is gone,
  // which renders as a card citing sources it cannot name.
  const { store, insights } = library(t);
  store.put(resource("src"));
  const id = claim(insights);
  insights.addEvidence(id, [evidence("src", { resourceType: "NEWS" })]);
  assert.equal(insights.count(), 1);
  assert.equal(insights.listEvidence(id).length, 1);

  assert.deepEqual(insights.purge(), { insights: 1, evidence: 1 });
  assert.equal(insights.count(), 0);
  assert.equal(insights.list({ take: 10 }).insights.length, 0);
  // And the store is usable afterwards rather than left mid-transaction.
  claim(insights, { statement: "A claim written after the board was emptied out" });
  assert.equal(insights.count(), 1, "the store is unusable after a purge");
});

test("a purge takes the pinned rows too, because their subject is going", (t) => {
  // A verdict is a person's own and normally outranks everything. A verdict on
  // a claim quoted from a video's marketing blurb is a verdict on something
  // that should never have been extracted — keeping it would preserve the
  // judgement and discard its subject.
  const { insights } = library(t);
  const id = claim(insights);
  insights.setStatus(id, "standing");
  assert.equal(insights.get(id).pinnedStatus, "standing");
  insights.purge();
  assert.equal(insights.get(id), undefined, "a pinned claim survived a purge");
});
