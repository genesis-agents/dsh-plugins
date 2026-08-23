/**
 * Thumbnail enrichment: find the image a source's own page advertises.
 *
 * Feeds almost never carry one — measured across OpenAI, AWS, and TechCrunch,
 * whose items have no image element at all even though their pages do — so the
 * image has to come from the page. That costs one request per row, which is
 * why this runs as a bounded pass after collection rather than inline, and why
 * every row it looks at is marked so it is never looked at twice.
 *
 * Three things are done differently from the reference:
 *
 *  - Relative image paths resolve against the PAGE, not its origin. The
 *    reference concatenates `origin + path`, so `img/cover.png` on
 *    `https://site.com/blog/2026/post/` becomes `https://site.com/img/cover.png`
 *    and 404s.
 *  - Site-constant images are rejected by noticing the repetition rather than
 *    by naming the sites. The reference keeps a frontend blocklist — `arxiv-logo`,
 *    `placeholder`, `no-image` — which hides a bad value while leaving it in
 *    the database, and only ever covers the sites someone already found.
 *  - A page with no image is recorded as checked. The reference persists no
 *    negative, so it re-fetches those pages forever.
 */

/** Longest page body read while looking for a meta tag. */
const MAX_HTML = 512 * 1024;

/** Milliseconds before a page fetch is abandoned. */
const TIMEOUT_MS = 12_000;

/** Sent upstream so a site serves its ordinary document rather than a bot page. */
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};

/**
 * Types worth looking at.
 *
 * PAPER is absent deliberately. arXiv answers every paper's page with the same
 * `arxiv-logo-fb.png`, so scraping papers yields one image repeated 800 times.
 * The reference reached the same conclusion the hard way and removed its own
 * paper fallback; its papers get a real thumbnail only by rendering the PDF's
 * first page, which needs a PDF renderer this package does not carry.
 * YOUTUBE is absent because its still is derived from the video id already.
 */
export const ENRICHABLE_TYPES = ["BLOG", "NEWS", "REPORT", "POLICY", "PROJECT", "EVENT", "RSS"];

/** Meta and link shapes that name a page's representative image, best first. */
const IMAGE_PATTERNS = [
  /<meta[^>]+property=["']og:image(?::url)?["'][^>]*\bcontent=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*\bproperty=["']og:image(?::url)?["']/i,
  /<meta[^>]+name=["']og:image["'][^>]*\bcontent=["']([^"']+)["']/i,
  /<meta[^>]+(?:name|property)=["']twitter:image(?::src)?["'][^>]*\bcontent=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*\b(?:name|property)=["']twitter:image(?::src)?["']/i,
  /<meta[^>]+name=["']thumbnail["'][^>]*\bcontent=["']([^"']+)["']/i,
  /<link[^>]+rel=["']image_src["'][^>]*\bhref=["']([^"']+)["']/i,
];

/** Decode the entities a meta attribute commonly carries. */
function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Shapes that are never a representative image for one article.
 *
 * A short list of the unambiguous cases only. The general defence is the
 * repetition check in {@link enrichThumbnails} — a blocklist can only name
 * what someone already discovered, so it must not be the thing relied upon.
 */
const NEVER_AN_ARTICLE_IMAGE = [
  /\bfavicon\b/i,
  /\bsprite\b/i,
  /\bplaceholder\b/i,
  /\bno[-_]image\b/i,
  /\bdefault[-_](?:image|thumb|og)\b/i,
  /^data:/i,
  /\.svg(?:[?#]|$)/i,
];

/** Whether a candidate should be rejected on its shape alone. */
export function isNotAnArticleImage(url) {
  return NEVER_AN_ARTICLE_IMAGE.some((pattern) => pattern.test(String(url)));
}

/**
 * The image a page advertises for itself.
 * @param html - the page body.
 * @param pageUrl - the page's own URL, for resolving a relative path.
 * @returns an absolute image URL, or an empty string.
 */
export function extractImage(html, pageUrl) {
  const source = String(html);
  // `<base href>` overrides the document's own URL for relative resolution,
  // and a site that sets one and is resolved against the page URL instead
  // sends every image to the wrong path.
  const base = /<base[^>]+href=["']([^"']+)["']/i.exec(source);
  let resolveAgainst = pageUrl;
  if (base !== null) {
    try {
      resolveAgainst = new URL(decodeEntities(base[1]), pageUrl).toString();
    } catch {
      // A malformed base is ignored rather than fatal.
    }
  }
  for (const pattern of IMAGE_PATTERNS) {
    const match = pattern.exec(source);
    if (match === null) continue;
    const raw = decodeEntities(match[1]);
    if (raw === "" || isNotAnArticleImage(raw)) continue;
    try {
      const resolved = new URL(raw, resolveAgainst);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
      return resolved.toString();
    } catch {
      continue;
    }
  }
  return "";
}

/**
 * Fetch one page and read its image.
 * @param url - the page URL.
 * @returns the image URL, or an empty string.
 */
export async function imageForPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: HEADERS, redirect: "follow", signal: controller.signal });
    if (!response.ok) return "";
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html")) return "";
    // Only the head is needed, and a long article body is pure cost.
    const body = (await response.text()).slice(0, MAX_HTML);
    return extractImage(body, response.url === "" ? url : response.url);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** How many rows a single enrichment pass looks at by default. */
export const DEFAULT_ENRICH_LIMIT = 120;

/** Pages fetched at once. */
const CONCURRENCY = 4;

/**
 * Rows that must already hold an image before it counts as site-constant.
 *
 * Two is deliberately tight: one other row sharing the exact same image is
 * already strong evidence that the site serves one picture for everything,
 * and the cost of being wrong is a missing thumbnail rather than 800 identical
 * ones.
 */
const SHARED_IMAGE_LIMIT = 2;

/**
 * Look at pages for rows that have no image, and record what was found.
 * @param store - the source library.
 * @param options - `{ limit, logger }`.
 * @returns `{ looked, found, shared, empty }`.
 */
export async function enrichThumbnails(store, { limit = DEFAULT_ENRICH_LIMIT, logger } = {}) {
  const rows = store.rowsNeedingThumbnail(limit, ENRICHABLE_TYPES);
  const queue = [...rows];
  let found = 0;
  let shared = 0;
  let empty = 0;

  const worker = async () => {
    for (;;) {
      const row = queue.shift();
      if (row === undefined) return;
      const image = await imageForPage(row.sourceUrl);
      if (image === "") {
        store.markThumbnailChecked(row.id, "");
        empty += 1;
        continue;
      }
      // The repetition check: if this exact image already represents other
      // rows, it represents the site rather than the article.
      if (store.countThumbnailUse(image) >= SHARED_IMAGE_LIMIT) {
        store.markThumbnailChecked(row.id, "");
        shared += 1;
        continue;
      }
      store.markThumbnailChecked(row.id, image);
      found += 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (rows.length > 0) {
    logger?.info?.(`swarm: looked at ${rows.length} page(s) for thumbnails, found ${found}, ${shared} were site-wide, ${empty} had none`);
  }
  return { looked: rows.length, found, shared, empty };
}
