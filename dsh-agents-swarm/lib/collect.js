/**
 * Collectors: how the swarm fills its own source library.
 *
 * Seeding from the retiring upstream is a one-off. These are the ongoing
 * intake: RSS/Atom feeds, the arXiv Atom API, and Hacker News search — the
 * same three shapes the upstream's `ingestion/crawlers` covers with
 * `rss.service`, `arxiv.service`, and `hackernews.service`.
 *
 * They are deliberately DETERMINISTIC — plain fetch and parse, no model in the
 * loop. A collector that asks an LLM to read a feed costs tokens per item,
 * fails non-reproducibly, and cannot be diffed. The model's place is judging
 * and enriching what has already landed, which is what the assistant and the
 * agent preset do.
 *
 * Rows are written through `SourceStore.putMany`, so normalized-URL dedup
 * applies to collected rows exactly as it does to seeded ones.
 */

import { createHash } from "node:crypto";
import { normalizeUrl } from "./store.js";
// The watch page is the only place a video's length is available: the Atom
// feed carries `media:group`, `media:community`, a star rating and a
// thumbnail, and no duration in any form.
import { fetchVideoDetails } from "./transcript.js";

/** Identifier for a collected row: stable across runs for the same URL. */
export function stableId(url) {
  const basis = normalizeUrl(url) ?? url;
  const digest = createHash("sha256").update(basis).digest("hex");
  // Shaped like a UUID so collected rows sit beside seeded ones without a
  // second id convention.
  return [
    digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16),
    digest.slice(16, 20), digest.slice(20, 32),
  ].join("-");
}

/** Decode the XML entities a feed may carry in text nodes. */
function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/** Strip tags and collapse whitespace, for a title or a name. */
function plainText(html) {
  return decodeEntities(String(html))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Horizontal whitespace only — never a line break. */
const HORIZONTAL_SPACE = /[^\S\r\n]+/g;

/** Three or more consecutive line breaks. */
const BLANK_RUN = /\n{3,}/g;

/**
 * Strip tags but keep the line structure, for a description.
 *
 * A video's description is not a sentence, it is a document: chapter markers,
 * a numbered list of what the episode covers, sections of links. Collapsing
 * `\s+` to a single space — which is what a title wants — destroys all of it
 * and leaves a wall of text where the timestamps are no longer even findable.
 * Every line still gets its own horizontal whitespace collapsed, so the shape
 * survives without the ragged indentation.
 * @param html - the raw field.
 * @returns the text, with its line breaks intact.
 */
function blockText(html) {
  return decodeEntities(String(html))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ")
    .replace(HORIZONTAL_SPACE, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(BLANK_RUN, "\n\n")
    .trim();
}

/** First matching tag's text content within one item block. */
function tagText(block, ...names) {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
    if (match !== null) return decodeEntities(match[1]).trim();
  }
  return "";
}

/** Atom `<link href>` (preferring rel="alternate"), else the RSS `<link>` text. */
function itemLink(block) {
  const alternate = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block);
  if (alternate !== null) return decodeEntities(alternate[1]);
  const href = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
  if (href !== null) return decodeEntities(href[1]);
  return tagText(block, "link");
}

/**
 * Whether a video URL is a Short.
 *
 * A channel's feed mixes Shorts in with its real uploads, and they dominate:
 * 14 of the 15 entries in one podcast's feed were Shorts. They are clips, not
 * sources — no transcript worth reading, nothing to cite — so a library that
 * keeps them buries the material it exists to hold.
 *
 * The reference excludes any video under fifteen minutes, which also catches
 * short ordinary uploads, but it pays for a separate lookup per video to learn
 * the duration; the feed does not carry one. The URL form is what is available
 * for free and it is exact for the case that actually matters.
 * @param url - the item's link.
 * @returns true when the URL names a Short.
 */
export function isShortFormVideo(url) {
  return /^https?:\/\/(?:www\.)?youtube\.com\/shorts\//i.test(String(url));
}

/**
 * How often collection runs when nobody has said otherwise.
 *
 * LIVES HERE AND IS EXPORTED, because two files need to agree on it and one of
 * them cannot import the other. index.js reads it as the fallback for the
 * stored setting and the 洞察 router puts the effective value on the wire so
 * the page can warn when the insight pass has no tick to ride.
 *
 * TYPED A SECOND TIME IT COST A FALSE ALARM. The router wrote its own fallback
 * of 0, so an installation that had simply never touched the setting — which
 * is every installation collecting happily at the default — reported
 * "collectIntervalMinutes: 0", and the pane told its reader that collection was
 * off and their schedule would never fire. The setting was unset, not zero, and
 * unset means this number. A default is a fact about one system; written down
 * twice it is two systems that agree until somebody edits one.
 */
export const DEFAULT_COLLECT_INTERVAL_MINUTES = 60;

/** Below this a video is a clip, a trailer or an announcement. */
export const MIN_VIDEO_SECONDS = 20 * 60;

/**
 * The video id in a YouTube watch URL, or an empty string.
 * @param url - the item's link.
 * @returns the eleven-character id.
 */
export function youtubeVideoId(url) {
  return /[?&]v=([\w-]{11})\b/.exec(String(url))?.[1]
    ?? /youtu\.be\/([\w-]{11})\b/.exec(String(url))?.[1]
    ?? "";
}

/**
 * Drop the videos that are shorter than the floor.
 *
 * THE FEED DOES NOT CARRY A DURATION. Measured on four channels' Atom: it
 * has `media:group`, `media:community`, `media:starRating` and a thumbnail,
 * and no length in any form. So the only way to know is the watch page,
 * which is one request per video — the cost `isShortFormVideo`'s note says
 * the reference pays, and it is why the URL-shape check exists beside this
 * rather than being replaced by it. Shorts are still dropped for free.
 *
 * ONLY FOR VIDEOS THE LIBRARY DOES NOT ALREADY HOLD. A feed answers with
 * its most recent fifteen every poll, so looking each of them up every time
 * would be fifteen requests per channel per tick, forever, to re-learn a
 * number that cannot change. `seen` is what makes the cost proportional to
 * NEW videos.
 *
 * A LOOKUP THAT FAILS KEEPS THE VIDEO. A network error is not evidence that
 * something is short, and silently discarding a source because a request
 * failed is how a library loses material it would have to be told twice to
 * lose.
 * @param rows - parsed feed rows.
 * @param options - `{ seen, details, minSeconds }`; `seen(id)` answers
 *   whether the library already holds a row, `details(videoId)` resolves
 *   `{lengthSeconds}`.
 * @returns the rows to keep, and what was dropped.
 */
export async function dropShortVideos(rows, { seen, details, minSeconds = MIN_VIDEO_SECONDS } = {}) {
  if (typeof details !== "function") return { rows, dropped: [], looked: 0 };
  const kept = [];
  const dropped = [];
  let looked = 0;
  for (const row of rows) {
    const videoId = row?.type === "YOUTUBE_VIDEO" ? youtubeVideoId(row.sourceUrl) : "";
    if (videoId === "") { kept.push(row); continue; }
    if (typeof seen === "function" && seen(row.id) === true) { kept.push(row); continue; }
    try {
      looked += 1;
      const seconds = Number((await details(videoId))?.lengthSeconds ?? 0);
      if (Number.isFinite(seconds) && seconds > 0 && seconds < minSeconds) {
        dropped.push({ url: row.sourceUrl, title: row.title, seconds });
        continue;
      }
      // THE NUMBER IS KEPT NOW, and it was thrown away for as long as this
      // function has existed.
      //
      // The lookup above costs one request per NEW video — a cost this
      // function's own docblock explains, budgets and defends — and it was
      // spent to answer one boolean and then discarded. So the library
      // enforced a length rule it could not state, no card could show how
      // long a talk was, no filter could name a length, and a reader asking
      // "why is this hour-long interview not in here" had nothing to look at.
      //
      // Attached rather than mutated in place: these rows come out of
      // `parseFeed`, which is pure, and a collector that edits its input is a
      // collector whose second caller gets different rows than its first.
      kept.push(Number.isFinite(seconds) && seconds > 0 ? { ...row, durationSeconds: seconds } : row);
    } catch {
      // A LOOKUP THAT FAILED LEAVES NO LENGTH, and that is not the same as
      // zero. `put` stores null for it and the length floor in `query` keeps
      // NULL rows, so a network error costs the video its badge and never its
      // place in the library.
      kept.push(row);
    }
  }
  return { rows: kept, dropped, looked };
}

/**
 * The item's author name.
 *
 * Atom's `<author>` is a CONTAINER holding `<name>` and `<uri>`, not a text
 * node. Reading it as text and stripping the inner tags glues the two
 * together, which is how every YouTube row came to be credited to
 * "Lenny's Podcast https://www.youtube.com/channel/UC6t1...". RSS's `<author>`
 * really is a text node, so both shapes have to be handled rather than one
 * replaced by the other.
 * @param block - one item or entry block.
 * @returns the author's name, or an empty string.
 */
export function itemAuthor(block) {
  const creator = tagText(block, "dc:creator");
  if (creator !== "") return plainText(creator);
  const author = /<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/i.exec(block);
  if (author !== null) {
    const name = tagText(author[1], "name");
    return plainText(name === "" ? author[1] : name);
  }
  return plainText(tagText(block, "name"));
}

/**
 * An image the feed itself supplies.
 *
 * Most feeds carry none — measured across OpenAI, AWS, and TechCrunch, whose
 * items have no image element at all even though their pages have an
 * `og:image`. YouTube's feed does carry one, and taking it costs nothing, so
 * the ones that offer an image are no longer thrown away.
 * @param block - one item or entry block.
 * @param baseUrl - the feed's URL, for resolving a relative image path.
 * @returns an absolute image URL, or an empty string.
 */
export function itemThumbnail(block, baseUrl) {
  const patterns = [
    /<media:thumbnail[^>]*\burl=["']([^"']+)["']/i,
    /<media:content[^>]*\btype=["']image\/[^"']*["'][^>]*\burl=["']([^"']+)["']/i,
    /<media:content[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\/[^"']*["']/i,
    /<enclosure[^>]*\btype=["']image\/[^"']*["'][^>]*\burl=["']([^"']+)["']/i,
    /<enclosure[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\/[^"']*["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(block);
    if (match !== null) return absoluteLink(decodeEntities(match[1]), baseUrl);
  }
  return "";
}

/**
 * Resolve an item's link against the feed it came from.
 *
 * A `<link>` is allowed to be relative, and some feeds use that — Stanford AI
 * Lab publishes `/blog/linkbert/`. Stored verbatim it becomes a row that can
 * never be opened, and the failure is invisible at collection time because
 * there is nothing malformed about the string. Resolution has to be against
 * the feed's own URL, not against its origin: a feed served from a
 * subdirectory would otherwise send every item to the wrong path.
 * @param link - the item's link, possibly relative.
 * @param baseUrl - the feed's URL.
 * @returns an absolute URL, or an empty string when none can be formed.
 */
export function absoluteLink(link, baseUrl) {
  const raw = String(link ?? "").trim();
  if (raw === "") return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (baseUrl === undefined) return "";
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

/** Normalize a feed date to an ISO string, or undefined. */
function isoDate(value) {
  if (value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Parse an RSS 2.0 or Atom document into `Resource`-shaped rows.
 *
 * A regex reader rather than an XML parser: this package resolves no
 * dependencies from outside the checkout, and feed items are a flat, shallow
 * shape that does not need a tree. Malformed items are skipped, never fatal —
 * one bad entry must not cost a whole feed.
 * @param xml - the raw feed document.
 * @param options - `{ type, sourceType }` stamped on every row.
 * @returns the parsed rows.
 */
export function parseFeed(xml, { type = "BLOG", sourceType, baseUrl } = {}) {
  const blocks = [
    ...String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...String(xml).matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  const rows = [];
  for (const [, block] of blocks) {
    const url = absoluteLink(itemLink(block), baseUrl);
    const title = plainText(tagText(block, "title"));
    if (url === "" || title === "") continue;
    if (isShortFormVideo(url)) continue;
    const summary = blockText(tagText(block, "description", "summary", "content", "media:description"));
    const author = itemAuthor(block);
    const thumbnail = itemThumbnail(block, baseUrl);
    rows.push({
      id: stableId(url),
      type,
      title,
      abstract: summary === "" ? null : summary.slice(0, 4000),
      sourceUrl: url,
      thumbnailUrl: thumbnail === "" ? undefined : thumbnail,
      publishedAt: isoDate(tagText(block, "pubDate", "published", "updated", "dc:date")),
      authors: author === "" ? [] : [{ name: author }],
      categories: [],
      sourceType,
      upvoteCount: 0,
      commentCount: 0,
    });
  }
  return rows;
}

/**
 * Fetch and parse one RSS/Atom feed.
 * @param feed - `{ url, type, sourceType }`.
 * @returns the parsed rows.
 */
export async function collectFeed({ url, type = "BLOG", sourceType }) {
  const response = await fetch(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  // `response.url`, not the requested one: a feed that redirects moves the
  // base a relative link has to resolve against.
  return parseFeed(await response.text(), {
    type,
    baseUrl: response.url === "" ? url : response.url,
    sourceType: sourceType ?? new URL(url).hostname.replace(/^www\./, ""),
  });
}

/** arXiv landing page, as its paper. */
const ARXIV_ABS = /^https?:\/\/(?:www\.)?arxiv\.org\/abs\/(.+)$/i;

/**
 * The PDF an arXiv abstract page stands for.
 * @param url - a source URL.
 * @returns the PDF URL, or an empty string when the URL is not an arXiv page.
 */
export function arxivPdfUrl(url) {
  const match = ARXIV_ABS.exec(String(url ?? ""));
  return match === null ? "" : `https://arxiv.org/pdf/${match[1]}`;
}

/**
 * Fetch recent arXiv submissions for a query.
 *
 * arXiv's API answers Atom, so the feed parser handles the body; only the
 * query construction and the PAPER stamp are specific.
 * @param options - `{ query, max }`.
 * @returns the parsed rows.
 */
export async function collectArxiv({ query = "cat:cs.AI", max = 50 } = {}) {
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}`
    + `&sortBy=submittedDate&sortOrder=descending&max_results=${Math.max(1, Math.min(200, max))}`;
  const response = await fetch(url, { headers: { accept: "application/atom+xml" } });
  if (!response.ok) throw new Error(`arxiv: HTTP ${response.status}`);
  const rows = parseFeed(await response.text(), { type: "PAPER", sourceType: "arxiv" });
  // arXiv publishes the landing page as the entry link; the paper itself lives
  // at the matching `/pdf/` path. Recording it here keeps a reader from opening
  // the abstract listing and taking it for the paper.
  for (const row of rows) {
    const derived = arxivPdfUrl(row.sourceUrl);
    if (derived !== "") row.pdfUrl = derived;
  }
  return rows;
}

/**
 * Fetch Hacker News stories through the Algolia search API.
 * @param options - `{ query, max, minPoints }`.
 * @returns `Resource`-shaped rows.
 */
export async function collectHackerNews({ query = "AI", max = 50, minPoints = 50 } = {}) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}`
    + `&tags=story&numericFilters=points>=${Math.max(0, minPoints)}&hitsPerPage=${Math.max(1, Math.min(200, max))}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`hackernews: HTTP ${response.status}`);
  const payload = await response.json();
  const hits = Array.isArray(payload?.hits) ? payload.hits : [];
  const rows = [];
  for (const hit of hits) {
    // A text post carries no external URL; its discussion page is the source.
    const link = typeof hit.url === "string" && hit.url !== ""
      ? hit.url
      : `https://news.ycombinator.com/item?id=${hit.objectID}`;
    const title = typeof hit.title === "string" ? hit.title.trim() : "";
    if (title === "") continue;
    rows.push({
      id: stableId(link),
      type: "NEWS",
      title,
      abstract: typeof hit.story_text === "string" ? plainText(hit.story_text).slice(0, 4000) : null,
      sourceUrl: link,
      publishedAt: isoDate(hit.created_at ?? ""),
      authors: typeof hit.author === "string" ? [{ name: hit.author }] : [],
      categories: [],
      sourceType: "hackernews",
      upvoteCount: Number.isFinite(hit.points) ? hit.points : 0,
      commentCount: Number.isFinite(hit.num_comments) ? hit.num_comments : 0,
    });
  }
  return rows;
}

/** Collectors the run action can dispatch, by name. */
export const COLLECTORS = {
  feed: collectFeed,
  arxiv: collectArxiv,
  hackernews: collectHackerNews,
};

/**
 * Run one collector and write what it returns.
 * @param store - the source library.
 * @param name - a key of {@link COLLECTORS}.
 * @param options - collector-specific options.
 * @returns `{ collector, fetched, written, skipped }`.
 */
export async function runCollector(store, name, options = {}) {
  const collector = COLLECTORS[name];
  if (collector === undefined) throw new Error(`unknown collector: ${name}`);
  const rows = await collector(options);
  // THE LENGTH FLOOR, APPLIED WHERE THE STORE IS IN HAND. It has to be here
  // and not in `parseFeed`: knowing a video's length costs a request, and the
  // only way to make that proportional to NEW videos rather than to every
  // poll is to ask the library what it already holds. `parseFeed` is pure and
  // has no library.
  //
  // Injected rather than imported so a test can drive it without a network,
  // and defaulted so the live collector needs no wiring.
  const gate = await dropShortVideos(rows, {
    seen: (id) => store.get(id) !== undefined,
    details: options.videoDetails ?? fetchVideoDetails,
  });
  const result = store.putMany(gate.rows);
  return {
    collector: name,
    fetched: rows.length,
    ...result,
    // NAMED, NOT SILENT. A collector that quietly discards half a feed is one
    // nobody can tell from a channel that stopped publishing.
    tooShort: gate.dropped.length,
    lookedUp: gate.looked,
  };
}
