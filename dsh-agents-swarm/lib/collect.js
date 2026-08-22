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

/** Strip tags and collapse whitespace, for a summary field. */
function plainText(html) {
  return decodeEntities(String(html))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
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
export function parseFeed(xml, { type = "BLOG", sourceType } = {}) {
  const blocks = [
    ...String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...String(xml).matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  const rows = [];
  for (const [, block] of blocks) {
    const url = itemLink(block);
    const title = plainText(tagText(block, "title"));
    if (url === "" || title === "") continue;
    const summary = plainText(tagText(block, "description", "summary", "content"));
    const author = plainText(tagText(block, "dc:creator", "author", "name"));
    rows.push({
      id: stableId(url),
      type,
      title,
      abstract: summary === "" ? null : summary.slice(0, 4000),
      sourceUrl: url,
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
  return parseFeed(await response.text(), { type, sourceType: sourceType ?? new URL(url).hostname.replace(/^www\./, "") });
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
  return parseFeed(await response.text(), { type: "PAPER", sourceType: "arxiv" });
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
  const result = store.putMany(rows);
  return { collector: name, fetched: rows.length, ...result };
}
