/**
 * The insight pipeline's arithmetic: shingling, simhash, clustering, quote
 * verification, and the four scores.
 *
 * Every function here is pure and total. No store, no fetch, no `Date.now()`,
 * no `new Date()` without an argument: anything that needs the present takes
 * `now` as a parameter. That is not tidiness, it is the only way the one
 * behaviour that matters can be tested — novelty DECAYS, and a scorer that
 * reads the wall clock passes every test that can be written for it while
 * being wrong about the only thing it exists to do.
 *
 * The one import is the three frozen vocabularies from `insight-store.js`, and
 * the direction is fixed: `insights.js` imports from `insight-store.js` and
 * NEVER the other way round. Copying the arrays here instead would let the two
 * lists drift, and a status this module computes that the store rejects is a
 * pass that fails at the write with everything upstream reporting success.
 *
 * Two words in this file mean different things and are deliberately never
 * mixed. A claim's KIND is `launch | funding | policy | finding | shift`. A
 * resource's TYPE is `NEWS | PAPER | ...` from RESOURCE_TYPES. Everything
 * about resources here says `resourceType`, so nothing reads a claim kind
 * against a resource type and quietly scores every card zero.
 */

import { INSIGHT_STATUSES } from "./insight-store.js";

/** Characters of body text an item carries beside its title. */
const MAX_ITEM_BODY_CHARS = 600;

/** A simhash as this module writes and reads it. */
const HEX16 = /^[0-9a-fA-F]{16}$/;

/**
 * The hash of text that produced no tokens at all.
 *
 * Exported because two callers need the same literal: `upsertInsight` rejects
 * it (a validated non-empty statement that hashes to zero is a `tokenize` bug
 * and must surface there, not as a card that near-matches every other card),
 * and the folding below excludes it from banding for the same reason — every
 * text-less item is 0 bits from every other text-less item, so left in they
 * would all fold into one group that is about nothing.
 */
export const ZERO_SIMHASH = "0000000000000000";

/* ── tokens ────────────────────────────────────────────────────────────── */

/**
 * Runs this module treats as one token, plus the ideographs it treats as one
 * token EACH.
 *
 * Han characters are split individually because a Chinese sentence has no
 * spaces: splitting on whitespace makes an entire Chinese title one token,
 * which makes every Chinese story its own cluster, silently, while the
 * pipeline reports itself as working. Kana and Hangul runs are kept as runs
 * (the contract names only Latin and ideographs) for the same failure's sake:
 * a Japanese or Korean row that tokenised to nothing would hash to
 * ZERO_SIMHASH and drop out of clustering entirely, with no error anywhere.
 */
const TOKEN_PATTERN = /[\p{Script=Latin}\p{Nd}]+|[\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{Script=Hangul}]+|\p{Script=Han}/gu;

/** URLs are stripped before tokenising: a shared CDN host is not shared meaning. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/giu;

/** Letters this module counts as CJK when deciding which quote-length floor applies. */
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Split text into the tokens clustering and similarity compare.
 * @param text - any string; anything else is treated as empty.
 * @returns lowercased tokens in order of appearance, duplicates kept.
 */
export function tokenize(text) {
  if (typeof text !== "string" || text === "") return [];
  const cleaned = text.replace(URL_PATTERN, " ");
  const tokens = [];
  for (const match of cleaned.matchAll(TOKEN_PATTERN)) {
    const run = match[0];
    // A single Han character is a word; a single Latin letter is noise, and
    // keeping it would make "a" and "I" the commonest tokens in the corpus.
    if (run.length === 1 && CJK_LETTER.test(run)) {
      CJK_LETTER.lastIndex = 0;
      tokens.push(run);
      continue;
    }
    CJK_LETTER.lastIndex = 0;
    if (run.length >= 2) {
      tokens.push(run.toLowerCase());
      continue;
    }
    // A one-character run is dropped when it is a letter and KEPT when it is a
    // digit. "GPT-5" splits into "gpt" and "5", and discarding the 5 makes
    // "OpenAI ships GPT-5" and "OpenAI ships GPT-4" tokenise identically —
    // identical shingles, identical simhash, and stage 1 folds two different
    // launches into one group whose lead quote comes from the wrong article.
    if (/\p{Nd}/u.test(run)) tokens.push(run);
  }
  return tokens;
}

/**
 * Overlapping n-grams of the tokens, in order.
 * @param tokens - the token list.
 * @param size - the window; defaults to 3.
 * @returns the shingles, duplicates kept because repetition is simhash weight.
 */
export function shingles(tokens, size = 3) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  const width = Number.isFinite(size) && size >= 1 ? Math.floor(size) : 3;
  // Short input falls back to the bare tokens rather than to []. An empty
  // shingle set hashes to the same value for every short title, and every
  // short title would then be a near-duplicate of every other short title —
  // folding unrelated stories together with nothing reporting it.
  if (tokens.length < width) return [...tokens];
  const out = [];
  for (let i = 0; i + width <= tokens.length; i += 1) out.push(tokens.slice(i, i + width).join(" "));
  return out;
}

/* ── simhash ───────────────────────────────────────────────────────────── */

/**
 * FNV-1a, 32 bits, over UTF-16 code units fed low byte first.
 *
 * Named and written out rather than left to "some hash" because the value is
 * STORED: `insights.simhash` is a column, and a different hash function silently
 * stops matching every row written before it. Two code units per character so a
 * CJK string is not flattened to its low bytes, `Math.imul` because the prime
 * multiply overflows 32 bits, `>>> 0` so the result is unsigned everywhere.
 * @param text - the shingle to hash.
 * @param seed - the offset basis; the two halves of a simhash use different ones.
 * @returns an unsigned 32-bit integer.
 */
function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193);
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), 0x01000193);
  }
  return hash >>> 0;
}

/** FNV-1a's own offset basis, for the low 32 bits. */
const FNV_OFFSET_LOW = 0x811c9dc5;

/** The same constant byte-swapped, for the high 32 bits. One hash, two seeds. */
const FNV_OFFSET_HIGH = 0x9dc5811c;

/**
 * 64-bit simhash of a text, as 16 lowercase hex characters.
 *
 * Two 32-bit halves rather than BigInt: this runs over every row of every
 * pass, and the value is compared bitwise a few thousand times per run.
 *
 * Regression anchors, so a test can pin the algorithm rather than assert that
 * it merely returns hex:
 *   simhash("the quick brown fox jumps over the lazy dog") === "5add450e05ab61f7"
 *   simhash("人工智能公司发布新模型")                        === "57da5c9286cb8f9f"
 * If a change to `tokenize`, `shingles` or `fnv1a` moves either value, every
 * stored simhash is stale and the column must be REBUILT: reconciliation would
 * otherwise stop matching anything written before the change, and the only
 * symptom would be duplicate cards appearing forever.
 * @param text - the text to hash.
 * @param options - `{ shingleSize }`, default 3.
 * @returns 16 lowercase hex characters; {@link ZERO_SIMHASH} for text with no tokens.
 */
export function simhash(text, options = {}) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return ZERO_SIMHASH;
  const parts = shingles(tokens, options.shingleSize ?? 3);
  if (parts.length === 0) return ZERO_SIMHASH;

  const counters = new Int32Array(64);
  for (const part of parts) {
    const low = fnv1a(part, FNV_OFFSET_LOW);
    const high = fnv1a(part, FNV_OFFSET_HIGH);
    for (let bit = 0; bit < 32; bit += 1) {
      counters[bit] += (low >>> bit) & 1 ? 1 : -1;
      counters[bit + 32] += (high >>> bit) & 1 ? 1 : -1;
    }
  }

  let low = 0;
  let high = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (counters[bit] > 0) low |= 1 << bit;
    if (counters[bit + 32] > 0) high |= 1 << bit;
  }
  return toHex8(high) + toHex8(low);
}

/** One 32-bit half as 8 lowercase hex characters. */
function toHex8(value) {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** Both halves of a simhash, validated. */
function halvesOf(hex) {
  const text = assertSimhash(hex);
  return [Number.parseInt(text.slice(0, 8), 16) >>> 0, Number.parseInt(text.slice(8), 16) >>> 0];
}

/**
 * Reject anything that is not a simhash, loudly.
 *
 * The alternative — returning a large distance for an unparseable value — is
 * the failure this repo keeps shipping: 64 bits apart reads as "completely
 * different", so a comparison that is entirely broken looks exactly like a
 * working one that happened to find no matches.
 */
function assertSimhash(hex) {
  if (typeof hex !== "string" || !HEX16.test(hex)) {
    throw new Error(`simhash must be 16 hex characters, got ${JSON.stringify(hex)}`);
  }
  return hex.toLowerCase();
}

/** Set bits in a 32-bit word. */
function popcount(value) {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return Math.imul(v, 0x01010101) >>> 24;
}

/**
 * Bits differing between two simhashes.
 * @param a - 16 hex characters.
 * @param b - 16 hex characters.
 * @returns 0..64.
 */
export function hammingDistance(a, b) {
  const [aHigh, aLow] = halvesOf(a);
  const [bHigh, bLow] = halvesOf(b);
  return popcount(aHigh ^ bHigh) + popcount(aLow ^ bLow);
}

/**
 * The leading hex characters of a simhash: the coarse block stage 1 compares within.
 * @param hex - 16 hex characters.
 * @param hexChars - how many to keep; defaults to 4, i.e. a 16-bit prefix.
 * @returns the prefix, lowercased.
 */
export function bucketOf(hex, hexChars = 4) {
  const text = assertSimhash(hex);
  const width = Number.isFinite(hexChars) ? Math.max(1, Math.min(16, Math.floor(hexChars))) : 4;
  return text.slice(0, width);
}

/**
 * How many disjoint bands a simhash is cut into for near-duplicate blocking,
 * given the distance being asked for.
 *
 * Blocking on a SINGLE 16-bit prefix — which is what `bucketOf` alone would
 * be — misses most of what it is looking for: with `maxBits: 3` the odds that
 * all three differing bits fall outside the prefix are C(48,3)/C(64,3) ~=
 * 0.415, so ~58% of genuine near-duplicates are never COMPARED. Every fold
 * that did happen would still be correct, which is exactly why nothing would
 * report the other 58%.
 *
 * Bands fix it by pigeonhole: `maxBits` differing bits can dirty at most
 * `maxBits` bands, so with more than `maxBits` bands at least one is always
 * clean and the pair is always compared. Four bands cover `maxBits <= 3`;
 * `insightDuplicateBits` goes to 12, so past 3 the count rises to eight
 * (8-bit bands), which holds the guarantee to 7.
 *
 * Measured over 3000 random pairs per distance. Four bands throughout: 100% at
 * 1-3, 88.8% at 4, 57.6% at 6, 7.9% at 12 — i.e. the top half of the setting's
 * range would have done almost nothing while looking like a tuning knob. As
 * shipped: 100% through 6 (and through 7 by construction), 86.1% at 12. The
 * extra candidates cost nothing measurable — 600 rows cluster in ~10ms.
 *
 * Recall is the only thing bands affect. Every candidate is still verified
 * with an exact `hammingDistance`, so a wider net never folds a wrong pair.
 * @param maxBits - the distance the caller is folding at.
 * @returns 4 or 8, both of which divide 16 hex characters evenly.
 */
function bandCountFor(maxBits) {
  return maxBits <= 3 ? 4 : 8;
}

/** The blocking keys of one simhash: `<band index>:<the band's hex>`. */
function bandsOf(hex, bandCount) {
  const text = assertSimhash(hex);
  const width = 16 / bandCount;
  const keys = [];
  for (let band = 0; band < bandCount; band += 1) keys.push(`${band}:${text.slice(band * width, band * width + width)}`);
  return keys;
}

/* ── sets and time ─────────────────────────────────────────────────────── */

/**
 * Jaccard similarity of two token collections.
 * @param a - any iterable of strings.
 * @param b - any iterable of strings.
 * @returns |A n B| / |A u B|, 0..1.
 */
export function jaccard(a, b) {
  const left = a instanceof Set ? a : new Set(a ?? []);
  const right = b instanceof Set ? b : new Set(b ?? []);
  // 0 rather than NaN, and 0 rather than 1: two empty token sets are not the
  // same story, they are two rows we know nothing about.
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const value of small) if (large.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Fractional days from one ISO timestamp to another.
 * @param fromIso - the earlier instant, as an ISO 8601 string.
 * @param toIso - the later instant.
 * @returns days, negative when `toIso` is earlier; 0 when either fails to parse.
 */
export function daysBetween(fromIso, toIso) {
  const from = Date.parse(String(fromIso ?? ""));
  const to = Date.parse(String(toIso ?? ""));
  // 0, not Infinity and not NaN. A date that read as infinitely old would
  // auto-dormant a live card; a NaN would poison every score derived from it
  // while every SELECT still returned rows. Callers that must NOT treat an
  // unparseable date as "right now" — scoreNovelty, scoreMomentum — check
  // parseability themselves rather than inferring it from a 0 here.
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return (to - from) / 86_400_000;
}

/** Whether a value parses as a date at all. */
function parsesAsDate(value) {
  return !Number.isNaN(Date.parse(String(value ?? "")));
}

/** Milliseconds for ordering; an unparseable stamp sorts LAST, never first. */
function timeOf(iso) {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** Oldest first, ties broken by id, so a lead is the same on every run. */
function byEarliest(a, b) {
  const left = timeOf(a.at);
  const right = timeOf(b.at);
  if (left !== right) return left < right ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** The first of several fields that actually carries text, mirroring podcast.js. */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/** Clamp to the 0..1 every stored score lives in. */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Union-find, the spine of both single-link passes below. */
function makeUnionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (start) => {
    let node = start;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // Always attach the higher index to the lower, so the component's root is
    // its lowest member and grouping is identical on every run.
    if (rootA < rootB) parent[rootB] = rootA;
    else parent[rootA] = rootB;
  };
  return { find, union };
}

/* ── items ─────────────────────────────────────────────────────────────── */

/**
 * Turn a stored resource into the shape stages 1 and 2 work on.
 * @param row - a stored `Resource`, as `SourceStore#query` returns it.
 * @returns `{ id, text, tokens, simhash, bucket, at }`, or undefined when unusable.
 */
export function itemForRow(row) {
  if (row == null || typeof row !== "object") return undefined;
  const title = firstText(row.title);
  // Same rejection rule as podcast.js's `sourceMaterial`: a non-empty trimmed
  // string title or nothing. Returning undefined rather than a blank item lets
  // the caller COUNT what it skipped, which is the difference between "the
  // pass read 200 rows and clustered 40" and a quiet shortfall.
  if (title === "") return undefined;
  const id = firstText(row.id);
  // An item with no id cannot be named in a cluster, in a log line, or in an
  // evidence row. Skipped for the same reason and counted the same way.
  if (id === "") return undefined;

  // Title alone is too short to cluster on; a whole abstract lets one long
  // source dominate the shingle set and drag unrelated rows into its cluster.
  const body = firstText(row.aiSummary, row.abstract).slice(0, MAX_ITEM_BODY_CHARS);
  const text = body === "" ? title : `${title} ${body}`;
  // `publishedAt || createdAt`: the clustering window is about when the EVENT
  // happened. Keyed on collection time, a two-year-old paper harvested this
  // morning would be folded into today's story.
  const at = firstText(row.publishedAt, row.createdAt);
  const hash = simhash(text);
  return { id, text, tokens: tokenize(text), simhash: hash, bucket: bucketOf(hash), at };
}

/* ── stage 1: near-duplicate folding ───────────────────────────────────── */

/**
 * Fold near-identical items into groups: the same telling of the same story.
 * @param items - items from {@link itemForRow}.
 * @param options - `{ maxBits }`, default 3 (~ the >80% similarity threshold).
 * @returns `[{ lead, members }]`, oldest lead first; every item in exactly one group.
 */
export function foldNearDuplicates(items, options = {}) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item != null);
  if (list.length === 0) return [];
  const maxBits = Number.isFinite(options.maxBits) ? Math.max(0, Math.min(64, Math.floor(options.maxBits))) : 3;

  // Validate every hash up front rather than where it is compared: a bad hash
  // discovered mid-pass would already have produced groups built on the ones
  // before it, and the error would name a stage that is not the culprit.
  for (const item of list) assertSimhash(item.simhash);

  const { find, union } = makeUnionFind(list.length);
  const bandCount = bandCountFor(maxBits);
  const bands = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const hash = list[index].simhash.toLowerCase();
    // A text-less item is 0 bits from every other text-less item. Left in the
    // bands they would all fold into one group about nothing, and the group
    // would look exactly like a real one.
    if (hash === ZERO_SIMHASH) continue;
    for (const key of bandsOf(hash, bandCount)) {
      const bucket = bands.get(key);
      if (bucket === undefined) {
        bands.set(key, [index]);
        continue;
      }
      for (const other of bucket) {
        if (find(other) === find(index)) continue;
        if (hammingDistance(hash, list[other].simhash) <= maxBits) union(index, other);
      }
      bucket.push(index);
    }
  }

  const byRoot = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const root = find(index);
    const members = byRoot.get(root);
    if (members === undefined) byRoot.set(root, [list[index]]);
    else members.push(list[index]);
  }

  const groups = [...byRoot.values()].map((members) => {
    const ordered = [...members].sort(byEarliest);
    // The earliest telling is the lead: it is the one worth quoting, and
    // "earliest, ties by smallest id" is decidable without the clock.
    return { lead: ordered[0], members: ordered };
  });
  groups.sort((a, b) => byEarliest(a.lead, b.lead));
  return groups;
}

/* ── stage 2: clustering ───────────────────────────────────────────────── */

/**
 * Share of the slice a token may appear in and still be worth blocking on.
 *
 * A token in most of the day's rows ("ai", "model", "公司") pairs everything with
 * everything and turns the blocking pass back into the quadratic scan it
 * exists to avoid. Rare tokens are the ones that mean "these two rows are
 * about the same thing".
 */
const RARE_TOKEN_SHARE = 0.2;

/** Hard ceiling on one token's postings list, whatever the share works out to. */
const MAX_POSTINGS = 40;

/**
 * Cluster groups covering the same event, within a time window.
 *
 * The blocking key here is NOT the simhash bucket, and that is the whole
 * design. Stage 1 and stage 2 are opposite problems: stage 1 folds
 * near-IDENTICAL text, where simhash is exactly right, while stage 2 joins
 * DIFFERENT ANGLES on one event — different wording, therefore simhashes far
 * more than a few bits apart, therefore almost never a shared prefix. Blocking
 * stage 2 on `bucketOf` would exclude every pair the Jaccard test exists to
 * catch, leave the output equal to stage 1's, and make the pass spend one
 * extraction call PER ARTICLE while `clusters` and `extracted` both still
 * looked like plausible numbers. So candidate pairs come from an inverted
 * index over rare tokens: two groups are compared when they share at least one
 * token that is not common across the slice.
 * @param items - items from {@link itemForRow}.
 * @param options - `{ windowDays, maxBits, minOverlap, maxClusterSize, maxClusters, maxBlockingDf }`.
 * @returns `[{ id, members, bucket, spanDays }]`, largest cluster first.
 */
export function clusterItems(items, options = {}) {
  const windowDays = Number.isFinite(options.windowDays) ? Math.max(0, options.windowDays) : 7;
  const minOverlap = Number.isFinite(options.minOverlap) ? Math.max(0, options.minOverlap) : 0.18;
  const maxClusterSize = Number.isFinite(options.maxClusterSize) ? Math.max(1, Math.floor(options.maxClusterSize)) : 12;
  const maxClusters = Number.isFinite(options.maxClusters) ? Math.max(1, Math.floor(options.maxClusters)) : 40;

  const groups = foldNearDuplicates(items, { maxBits: options.maxBits });
  if (groups.length === 0) return [];

  const nodes = groups.map((group) => ({
    lead: group.lead,
    members: group.members,
    tokens: new Set(group.members.flatMap((member) => member.tokens ?? [])),
  }));

  // Inverted index: token -> the groups holding it.
  const postings = new Map();
  for (let index = 0; index < nodes.length; index += 1) {
    for (const token of nodes[index].tokens) {
      const list = postings.get(token);
      if (list === undefined) postings.set(token, [index]);
      else list.push(index);
    }
  }

  const blockingLimit = Number.isFinite(options.maxBlockingDf)
    ? Math.max(2, Math.floor(options.maxBlockingDf))
    // The floor of 4 matters on small slices: with six groups, a share-based
    // limit would be 2, and a token shared by three of them — which is exactly
    // the signal wanted — would block nothing.
    : Math.max(4, Math.min(MAX_POSTINGS, Math.ceil(nodes.length * RARE_TOKEN_SHARE)));

  const { find, union } = makeUnionFind(nodes.length);
  const compared = new Set();
  for (const list of postings.values()) {
    if (list.length < 2 || list.length > blockingLimit) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const key = `${a}:${b}`;
        if (compared.has(key)) continue;
        compared.add(key);
        if (find(a) === find(b)) continue;
        // The window is measured BETWEEN the two items, never against the
        // present: a pass that runs late must not fragment a story it would
        // have clustered on time.
        if (Math.abs(daysBetween(nodes[a].lead.at, nodes[b].lead.at)) > windowDays) continue;
        if (jaccard(nodes[a].tokens, nodes[b].tokens) < minOverlap) continue;
        union(a, b);
      }
    }
  }

  const byRoot = new Map();
  for (let index = 0; index < nodes.length; index += 1) {
    const root = find(index);
    const bucket = byRoot.get(root);
    if (bucket === undefined) byRoot.set(root, [nodes[index]]);
    else bucket.push(nodes[index]);
  }

  const clusters = [...byRoot.values()].map((component) => {
    const all = component.flatMap((node) => node.members).sort(byEarliest);
    // A runaway cluster is truncated to its most RECENT members and the excess
    // is dropped outright — never folded into a neighbour, which would put
    // sources into a story they are not about.
    const members = all.length <= maxClusterSize ? all : all.slice(all.length - maxClusterSize);
    const lead = members[0];
    return {
      id: `c-${bucketOf(lead.simhash)}-${lead.id}`,
      members,
      bucket: bucketOf(lead.simhash),
      spanDays: Math.abs(daysBetween(members[0].at, members[members.length - 1].at)),
    };
  });

  // Largest first, ties broken by the lead's date newest-first, then by id.
  // Without the tie-break the twenty clusters that get the model calls would
  // be chosen by whatever order `sort` happened to leave — and a run that
  // spent its budget on an arbitrary subset reports the same numbers as one
  // that spent it on the biggest stories.
  clusters.sort((a, b) => {
    if (a.members.length !== b.members.length) return b.members.length - a.members.length;
    const left = timeOf(a.members[0].at);
    const right = timeOf(b.members[0].at);
    if (left !== right) return left > right ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  // THE CALLER'S FRONT-OF-QUEUE ITEM IS ALWAYS KEPT, WHATEVER ITS CLUSTER'S SIZE.
  //
  // Largest-first spends the budget on the biggest stories, which is right —
  // and on its own it strands the tail for ever. The caller advances a
  // watermark past what it read, and a slice of mostly-unrelated sources
  // produces roughly one cluster per source, so the kept clusters are
  // singletons and the tie-break makes them the NEWEST ones. Measured on a
  // 200-row slice: 20 rows reached a cluster, 180 were binned, and every one of
  // those 180 was older than the watermark the pass then wrote. Read once,
  // discarded, never offered again, under three true-looking numbers.
  //
  // BY ID, CHOSEN BY THE CALLER, and that is not fussiness. An item's `at` is
  // `publishedAt || createdAt` — deliberately, since the clustering window is
  // about when the EVENT happened — while the watermark advances on
  // `createdAt`, which is when this library learned of it. A two-year-old paper
  // harvested this morning is old by one and new by the other. Reserving "the
  // oldest cluster" by the field this function happens to hold would guarantee
  // the wrong row, so the caller names the one row that must be read: the front
  // of ITS queue, in ITS order.
  //
  // One slot of the budget, and it is the difference between a queue and a leak.
  const wanted = firstText(options.ensureItemId);
  if (clusters.length <= maxClusters || wanted === "") return clusters.slice(0, maxClusters);
  const kept = clusters.slice(0, maxClusters);
  const holds = (cluster) => cluster.members.some((member) => firstText(member?.id) === wanted);
  if (kept.some(holds)) return kept;
  const home = clusters.find(holds);
  // The item may have been dropped before clustering — no usable title, or
  // trimmed out of a runaway cluster. Nothing to reserve, and inventing a slot
  // for a row that is not there would just shrink the budget.
  if (home === undefined) return kept;
  // Drop the last of the largest-first selection to make room: the smallest and
  // newest of the kept set, which is the cheapest slot to spend on the
  // guarantee. The ceiling itself is not widened — a guarantee that quietly
  // bought another model call would be a bill nobody agreed to.
  return [home, ...kept.slice(0, maxClusters - 1)];
}

/* ── stage 4: quote verification ───────────────────────────────────────── */

/**
 * Normalise a quote and its source for comparison, and nothing more.
 * @param text - the quote or the block.
 * @returns the normalised text.
 */
export function normalizeForQuote(text) {
  return String(text ?? "")
    // Models re-wrap lines and substitute typographic quotes while otherwise
    // copying faithfully. Those two are the ONLY forgiven differences.
    .replace(/[‘’‚‛′]/gu, "'")
    .replace(/[“”„‟″]/gu, '"')
    .replace(/[–—−]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
  // Do NOT extend this. Not case folding, not punctuation stripping, not
  // diacritics. Every extra normalisation is another way for an invented quote
  // to pass, and this check is the only thing standing between provenance and
  // decoration.
}

/** Characters below which a Latin quote proves nothing and is not evidence. */
export const MIN_QUOTE_CHARS = 20;

/** The floor for a majority-CJK quote, where eight characters is a full clause. */
export const MIN_QUOTE_CJK_CHARS = 8;

/**
 * Which length floor a quote must clear.
 *
 * Applying MIN_QUOTE_CHARS to Chinese would discard almost every valid Chinese
 * quote, and the pass would report a drop rate that reads as a bad model when
 * it is a bad threshold.
 */
function quoteFloor(normalized) {
  const letters = (normalized.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return MIN_QUOTE_CHARS;
  const cjk = (normalized.match(CJK_LETTER) ?? []).length;
  return cjk / letters > 0.5 ? MIN_QUOTE_CJK_CHARS : MIN_QUOTE_CHARS;
}

/**
 * The part of a material block a quote may honestly come from.
 *
 * `sourceMaterial` opens every block with `## <title>`, `Publication:`,
 * `Date:`, `URL:`. A quote copied out of the title line verifies perfectly and
 * proves nothing — circular provenance sailing through the highest-value guard
 * in the design. So the header is excluded, but ONLY when the block actually
 * looks like one of those blocks: for anything else the whole text is
 * searched, because a body wrongly cut at its first blank line would drop
 * honest claims, and a dropped claim is silent too.
 * @param block - the labelled material block the model was shown.
 * @returns the body portion, or the whole block when it carries no such header.
 */
/**
 * Text this program did not write, and did not splice.
 *
 * A block is what the model was SHOWN. Treating that as what the source
 * PUBLISHED is where the guarantee breaks, and it broke twice:
 *
 * - When a transcript exceeds the budget, `sampleLines` keeps every nth cue
 *   and joins the survivors with a newline and no gap marker. Normalisation
 *   collapses that to a space, so speech minutes apart reads as one sentence
 *   and a quote spanning the gap verifies. The stored evidence is then a
 *   sentence nobody said -- in one measured case with the speaker’s meaning
 *   inverted -- shown in quotation marks beside the outlet’s name.
 * - When a row has no summary, no abstract and no transcript, the only prose
 *   in the block is a sentence THIS PROGRAM wrote (“No body text is stored
 *   for this source…”). Quoting it verifies perfectly and attributes our own
 *   words to the source.
 *
 * So the quotable region is narrower than the block: the model may read all of
 * it and may quote only what a reader could find at the far end.
 */
const UNQUOTABLE_MARKERS = [
  // podcast.js sourceMaterial writes these. They are ours, not the source’s.
  "No body text is stored for this source",
  "Body text is stored for this source but did not fit",
  // A sampled transcript is discontinuous by construction.
  "Transcript (excerpt, sampled",
];

/**
 * The spans of a block a quote may legitimately come from.
 * @param block - one labelled source block.
 * @returns contiguous strings; a needle must sit inside ONE of them.
 */
function quotableSpans(block) {
  const text = String(block ?? "");
  const split = text.indexOf("\n\n");
  let body = text;
  if (split !== -1) {
    const header = text.slice(0, split);
    if (header.split("\n").some((line) => line.startsWith("## "))) body = text.slice(split + 2);
  }

  // Split on blank lines: sourceMaterial separates its sections that way, so a
  // section boundary is also the end of a contiguous run. A needle spanning
  // two sections is not a quote, it is a splice.
  const spans = [];
  for (const section of body.split(/\n\s*\n/)) {
    const trimmed = section.trim();
    if (trimmed === "") continue;
    if (UNQUOTABLE_MARKERS.some((marker) => trimmed.includes(marker))) continue;
    spans.push(trimmed);
  }
  return spans;
}

/** Whether a normalised needle sits inside one contiguous span of a block. */
function quoteSitsInBlock(needle, block) {
  return quotableSpans(block).some((span) => normalizeForQuote(span).includes(needle));
}

/**
 * Whether a quote is a literal substring of a haystack, after whitespace normalisation.
 * @param quote - the model's quote.
 * @param haystack - the text it claims to come from.
 * @returns true when it is verbatim and clears the floor for its script.
 */
export function quoteIsVerbatim(quote, haystack) {
  const needle = normalizeForQuote(quote);
  if (needle === "" || needle.length < quoteFloor(needle)) return false;
  // Through the same span rule as verifyQuote, not a plain substring: this is
  // the exported helper, and two verifiers with different ideas of what counts
  // is how a guarantee ends up holding in one call site and not the other.
  return quoteSitsInBlock(needle, haystack);
}

/** Accept either a Map or a plain object of blocks; own properties only. */
function blocksAsMap(blocks) {
  if (blocks instanceof Map) return blocks;
  if (blocks == null || typeof blocks !== "object") return new Map();
  // Own entries only: a block map keyed by resource id can carry the key
  // "constructor", and inherited properties are not sources.
  return new Map(Object.entries(blocks));
}

/**
 * Check one quote against the blocks the model was actually shown.
 * @param quote - the model's quote.
 * @param blocks - `Map<resourceId, block>` or the same as a plain object.
 * @param resourceId - the source the model attributed it to, when it named one.
 * @returns `{ ok, resourceId }` or `{ ok: false, reason }`.
 */
export function verifyQuote(quote, blocks, resourceId) {
  const map = blocksAsMap(blocks);
  const needle = normalizeForQuote(quote);
  if (needle === "" || needle.length < quoteFloor(needle)) return { ok: false, reason: "too short" };
  const attributed = typeof resourceId === "string" && resourceId !== "" ? resourceId : undefined;

  if (attributed !== undefined) {
    if (!map.has(attributed)) return { ok: false, reason: "no such source" };
    // ONLY the attributed block. A quote given to S1 that happens to appear in
    // S3 is a misattribution, and accepting it puts the wrong outlet's name
    // under the claim on the card, with every count still correct.
    return quoteSitsInBlock(needle, map.get(attributed))
      ? { ok: true, resourceId: attributed }
      : { ok: false, reason: "not found in the source it is attributed to" };
  }

  if (map.size === 0) return { ok: false, reason: "no such source" };
  for (const [id, block] of map) {
    if (quoteSitsInBlock(needle, block)) return { ok: true, resourceId: id };
  }
  // The three reasons are a fixed vocabulary: the pass counts them, and
  // "too short" measures the prompt while "not found" measures hallucination.
  // Adding a fourth here would split that histogram silently.
  return { ok: false, reason: "not found in the source it is attributed to" };
}

/* ── independence ──────────────────────────────────────────────────────── */

/** The host of a URL, or "" when it will not parse. */
function hostOf(url) {
  if (typeof url !== "string" || url.trim() === "") return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    // `store.js` guards `new URL` for exactly this reason: a malformed URL is
    // stored, not rejected, and a throw here would abandon a whole pass over
    // one bad row.
    return "";
  }
}

/**
 * The independence key stored on every evidence row.
 *
 * Independence means DISTINCT SOURCE, not distinct article: five rewrites of
 * one wire story are one source, and counting them as five is precisely how a
 * system manufactures the confidence this feature exists to avoid.
 *
 * The last fallback, "unknown", collapses every unkeyable source into ONE key,
 * so ten of them count as one and no card built on them ever promotes. That is
 * the safe direction — under-confidence rather than over — but it is invisible
 * from the card, which is why `stats()` reports how many evidence rows carry it.
 * @param row - a stored `Resource`.
 * @returns the source key; never empty.
 */
export function sourceKeyOf(row) {
  const sourceType = typeof row?.sourceType === "string" ? row.sourceType.trim().toLowerCase() : "";
  if (sourceType !== "") return sourceType;
  const host = hostOf(row?.sourceUrl);
  if (host !== "") return host;
  const type = firstText(row?.type);
  if (type !== "") return `type:${type}`;
  return "unknown";
}

/* ── stage 6: the four scores ──────────────────────────────────────────── */

/**
 * How much one source type is worth to a claim's credibility.
 *
 * `DEFAULT` covers anything unlisted, including an evidence row whose resource
 * type was never denormalised — which is the reason `insight_evidence` stores
 * `resource_type` beside `source_key` rather than joining back to `resources`:
 * a pruned library row would otherwise drop a PAPER-backed claim to 0.4 and
 * re-rank the tab with nothing reporting a change.
 */
export const CREDIBILITY_WEIGHTS = Object.freeze({
  PAPER: 1.0,
  POLICY: 1.0,
  REPORT: 0.8,
  PROJECT: 0.6,
  BLOG: 0.55,
  NEWS: 0.5,
  EVENT: 0.45,
  RSS: 0.4,
  YOUTUBE_VIDEO: 0.4,
  DEFAULT: 0.4,
});

/**
 * The blend behind `rank_score`.
 *
 * Sums to 1 so a rank is comparable across rows and across passes, and a test
 * asserts that sum: a blend that quietly stops summing to 1 reorders the whole
 * tab without failing anything.
 *
 * Assert it with a tolerance — `Math.abs(sum - 1) < 1e-9`. These four decimals
 * add up to 0.9999999999999999 in binary floating point, and an exact
 * `assert.equal(sum, 1)` would fail against correct weights, which invites
 * somebody to "fix" the weights instead of the test.
 */
export const SCORE_WEIGHTS = Object.freeze({ momentum: 0.35, credibility: 0.30, novelty: 0.20, relevance: 0.15 });

/** The resource type of one evidence row, whatever shape the caller has. */
function resourceTypeOf(row) {
  // `resourceType` is the denormalised column and the answer that survives a
  // prune; `type` is the flat shape; `resource.type` is the joined row. The
  // ladder exists so no caller silently scores every card at DEFAULT.
  const value = firstText(row?.resourceType, row?.type, row?.resource?.type);
  return value.toUpperCase();
}

/** The weight for a type, by own-property lookup only. */
function credibilityWeight(type) {
  return Object.hasOwn(CREDIBILITY_WEIGHTS, type) ? CREDIBILITY_WEIGHTS[type] : CREDIBILITY_WEIGHTS.DEFAULT;
}

/**
 * How new a claim is: 1 the day it is first seen, 0 a window later.
 * @param input - `{ firstSeenAt, now, windowDays }`, windowDays default 7.
 * @returns 0..1.
 */
export function scoreNovelty(input = {}) {
  const { firstSeenAt, now } = input;
  // 0, not 1, when a stamp will not parse. `daysBetween` answers 0 for an
  // unparseable pair, and `1 - 0/7` is the MAXIMUM — a corrupt row would pin
  // itself to the top of the default sort forever and never go dormant.
  if (!parsesAsDate(firstSeenAt) || !parsesAsDate(now)) return 0;
  const windowDays = Number.isFinite(input.windowDays) && input.windowDays > 0 ? input.windowDays : 7;
  return clamp01(1 - daysBetween(firstSeenAt, now) / windowDays);
}

/**
 * How much a claim's support looks like what this reader publishes.
 * @param input - `{ evidenceResourceTypes, preferredResourceTypes }`, both RESOURCE_TYPES.
 * @returns the share of supporting evidence in the preferred types, 0..1.
 */
export function scoreRelevance(input = {}) {
  const evidence = Array.isArray(input.evidenceResourceTypes) ? input.evidenceResourceTypes : [];
  const preferred = Array.isArray(input.preferredResourceTypes) ? input.preferredResourceTypes : [];
  if (evidence.length === 0) return 0;
  // 0, not 1, for an empty preference: an unanswered question is not a perfect
  // match, and scoring it 1 would rank every claim identically.
  if (preferred.length === 0) return 0;
  const wanted = new Set(preferred.map((type) => String(type ?? "").trim().toUpperCase()).filter((type) => type !== ""));
  if (wanted.size === 0) return 0;
  let hits = 0;
  for (const type of evidence) if (wanted.has(String(type ?? "").trim().toUpperCase())) hits += 1;
  return clamp01(hits / evidence.length);
}

/**
 * How much the sources backing a claim are worth.
 * @param evidence - evidence rows; only `stance === "supports"` counts.
 * @returns `0.6 * max(weight) + 0.4 * mean(weight)`, 0..1.
 */
export function scoreCredibility(evidence) {
  const supporting = (Array.isArray(evidence) ? evidence : []).filter((row) => row?.stance === "supports");
  if (supporting.length === 0) return 0;
  const weights = supporting.map((row) => credibilityWeight(resourceTypeOf(row)));
  // Max-weighted because one paper backing a claim is worth more than four
  // blogs restating it; mean-blended so four blogs still beat one.
  const max = Math.max(...weights);
  const mean = weights.reduce((sum, weight) => sum + weight, 0) / weights.length;
  return clamp01(0.6 * max + 0.4 * mean);
}

/**
 * Whether independent sources are still reporting this.
 * @param input - `{ independentCount, lastSeenAt, now, dormantDays }`, dormantDays default 21.
 * @returns 0..1.
 */
export function scoreMomentum(input = {}) {
  // `independentCount`, NEVER `sourceCount`. Momentum asks "are multiple
  // INDEPENDENT sources reporting this", and answering it with an article
  // count is the false-confidence failure the whole feature exists to avoid.
  const independent = Number.isFinite(input.independentCount) ? input.independentCount : 0;
  const base = clamp01((independent - 1) / 3);
  if (base === 0) return 0;
  const dormantDays = Number.isFinite(input.dormantDays) && input.dormantDays > 0 ? input.dormantDays : 21;
  // An unparseable stamp takes the FLOOR rather than the full 1: we cannot
  // tell that such a row is fresh, and the safe direction is the one that does
  // not park a corrupt card at the top of the list.
  const recency = parsesAsDate(input.lastSeenAt) && parsesAsDate(input.now)
    ? Math.min(1, Math.max(0.15, 1 - daysBetween(input.lastSeenAt, input.now) / dormantDays))
    : 0.15;
  return clamp01(base * recency);
}

/**
 * All four scores and their weighted blend.
 * @param insight - `{ firstSeenAt, lastSeenAt, independentCount }`.
 * @param evidence - evidence rows, `{ stance, resourceType }`.
 * @param options - `{ now, windowDays, dormantDays, preferredResourceTypes }`; `now` is required.
 * @returns `{ novelty, relevance, credibility, momentum, rank }`, every value 0..1.
 */
export function scoreInsight(insight, evidence, options = {}) {
  // Required, and it throws. Defaulting to the current instant here is the one
  // shortcut that would make every scoring test pass while proving nothing
  // about the behaviour the scores exist for — pass the pass's own `now`.
  if (typeof options.now !== "string" || options.now === "") {
    throw new Error("scoreInsight needs options.now as an ISO 8601 string: pass the pass's own instant so novelty decay is testable");
  }
  const rows = Array.isArray(evidence) ? evidence : [];
  const supporting = rows.filter((row) => row?.stance === "supports");

  const novelty = scoreNovelty({
    firstSeenAt: insight?.firstSeenAt,
    now: options.now,
    windowDays: options.windowDays,
  });
  const relevance = scoreRelevance({
    evidenceResourceTypes: supporting.map((row) => resourceTypeOf(row)),
    preferredResourceTypes: options.preferredResourceTypes,
  });
  const credibility = scoreCredibility(rows);
  const momentum = scoreMomentum({
    independentCount: insight?.independentCount,
    lastSeenAt: insight?.lastSeenAt,
    now: options.now,
    dormantDays: options.dormantDays,
  });

  const rank = clamp01(
    SCORE_WEIGHTS.momentum * momentum
    + SCORE_WEIGHTS.credibility * credibility
    + SCORE_WEIGHTS.novelty * novelty
    + SCORE_WEIGHTS.relevance * relevance,
  );
  return { novelty, relevance, credibility, momentum, rank };
}

/**
 * The status a pass would give a claim, before a person's own verdict is applied.
 * @param insight - `{ pinnedStatus, contradictionCount, independentCount, lastSeenAt }`.
 * @param scores - the freshly computed scores; deliberately unused, see below.
 * @param options - `{ now, minIndependent, dormantDays }`; `now` is required.
 * @returns a member of INSIGHT_STATUSES.
 */
export function nextStatus(insight, scores, options = {}) {
  if (typeof options.now !== "string" || options.now === "") {
    throw new Error("nextStatus needs options.now as an ISO 8601 string: dormancy is a question about the clock and must be pinnable in a test");
  }
  // `scores` is part of the signature and is not read: status is decided by
  // counts and dates, not by the blend. Deriving it from `rank` would make a
  // weight change silently re-promote and re-dormant half the tab.
  void scores;

  // A person's verdict outranks the pass, always and first. Without this the
  // dismiss button is a control that works until the next tick quietly undoes
  // it, and nothing on the page would say so.
  const pinned = insight?.pinnedStatus;
  if (typeof pinned === "string" && INSIGHT_STATUSES.includes(pinned)) return pinned;

  const dormantDays = Number.isFinite(options.dormantDays) && options.dormantDays > 0 ? options.dormantDays : 21;
  const minIndependent = Number.isFinite(options.minIndependent) && options.minIndependent > 0 ? options.minIndependent : 2;

  // Dormancy is tested BEFORE contested, deliberately. Contested first would
  // mean a contested claim can never go dormant, and since the default list
  // clause is `status != 'dormant'`, a two-year-old disagreement would sit on
  // the front page forever and be re-scored on every sweep. Nothing is hidden
  // by this: the `contested` chip filters on `contradiction_count > 0`, not on
  // the status, so a dormant disagreement is still one click away.
  if (parsesAsDate(insight?.lastSeenAt) && daysBetween(insight.lastSeenAt, options.now) >= dormantDays) return "dormant";
  if (Number(insight?.contradictionCount ?? 0) > 0) return "contested";
  if (Number(insight?.independentCount ?? 0) >= minIndependent) return "standing";
  return "candidate";
}

/* ── stage 5: the lexical prefilter ────────────────────────────────────── */

/** Entities, normalised for comparison; throws rather than reading a string as empty. */
function entitySet(value, side) {
  if (value === undefined || value === null) return new Set();
  // A JSON string arriving here instead of an array would compare as zero
  // shared entities for every pair, forever, and one of the three tests below
  // would simply never fire — no error, no log, just fewer merges.
  if (!Array.isArray(value)) {
    throw new TypeError(`statementsMatch needs ${side}.entities as an array, got ${typeof value}: parse the JSON column before calling`);
  }
  return new Set(value.map((entity) => String(entity ?? "").trim().toLowerCase()).filter((entity) => entity !== ""));
}

/**
 * Whether two claims are close enough to be worth ONE model call.
 *
 * This decides worth-asking, never same-claim. The gate is deliberately loose:
 * a false positive costs one cheap call, a false negative costs a duplicate
 * card that stays on the tab forever.
 * @param a - `{ statement, simhash, entities }`, the standing claim.
 * @param b - `{ statement, simhash, entities }`, the incoming claim.
 * @param options - `{ maxBits, minOverlap }`, defaults 12 and 0.34.
 * @returns `{ near, bits, overlap, sharedEntities }` — the components too, so a log line can say which test fired.
 */
export function statementsMatch(a, b, options = {}) {
  const maxBits = Number.isFinite(options.maxBits) ? options.maxBits : 12;
  const minOverlap = Number.isFinite(options.minOverlap) ? options.minOverlap : 0.34;

  const bits = hammingDistance(a?.simhash, b?.simhash);
  const overlap = jaccard(tokenize(a?.statement), tokenize(b?.statement));
  const left = entitySet(a?.entities, "a");
  const right = entitySet(b?.entities, "b");
  let sharedEntities = 0;
  for (const entity of left) if (right.has(entity)) sharedEntities += 1;

  // Two text-less statements are 0 bits apart, so the hash test alone would
  // call them the same claim and merge every such row into the first one. The
  // store rejects a zero simhash on write; this is the second lock.
  const hashUsable = a?.simhash?.toLowerCase() !== ZERO_SIMHASH && b?.simhash?.toLowerCase() !== ZERO_SIMHASH;
  const near = (hashUsable && bits <= maxBits) || overlap >= minOverlap || sharedEntities >= 2;
  return { near, bits, overlap, sharedEntities };
}

/**
 * The bands a rank score is read in, and what separates them.
 *
 * WHY A BAND AND NOT A NUMBER. Every card in the pane carried its rank as a
 * bare `0.47` in the corner, and a bare 0.47 is not information: it has no
 * scale a reader was shown, no comparison, and no unit. Asked what it meant,
 * nobody using the tab could say — which makes it decoration on a screen whose
 * entire argument is that it does not decorate.
 *
 * WHY IT IS DERIVED AND NOT ASKED FOR. The obvious alternative is to have the
 * extractor return a strength, the way the reference radar does. It is the
 * wrong trade here: a model asked "how important is this" answers from
 * everything it knows, which for this pipeline is exactly the thing every
 * other rule forbids — the quote rule, the "never assert what no source says"
 * rule, and the verifier all exist to keep the model's own opinions out of the
 * table. A band over `rank_score` is computed from four measured quantities
 * (momentum, credibility, novelty, relevance), it moves when the evidence
 * moves, and a reader who disagrees can be shown the arithmetic.
 *
 * THE THRESHOLDS ARE STATED ON THE SCREEN. They are a judgement, and a
 * judgement a reader cannot see is indistinguishable from a number invented
 * for the look of it — which is what this replaces. The pane's 口径 footer
 * names them.
 *
 * Measured against the library this was built on: a fresh multi-source claim
 * lands around 0.55-0.7, a single-source candidate around 0.4-0.5, and a
 * dormant one under 0.3. The cuts sit between those clusters rather than at
 * round numbers chosen for tidiness.
 */
export const STRENGTH_BANDS = Object.freeze([
  { id: "high", floor: 0.55 },
  { id: "medium", floor: 0.38 },
  { id: "low", floor: 0 },
]);

/**
 * Which band a score falls in.
 * @param score - a rank score, 0..1.
 * @returns "high" | "medium" | "low", or null when there is no score to band.
 */
export function strengthOf(score) {
  const value = Number(score);
  // NULL, NOT "low". A card that has never been scored — `scored_at` is NULL
  // and `rank_score` defaults to 0 — is not a weak claim, it is an unmeasured
  // one, and a page that prints 低 over it reports a verdict nobody reached.
  if (!Number.isFinite(value) || value <= 0) return null;
  return STRENGTH_BANDS.find((band) => value >= band.floor)?.id ?? "low";
}
