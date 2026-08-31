/**
 * Content proxy: how a source's own document reaches the reader.
 *
 * The upstream serves `/proxy/pdf`, `/proxy/html`, and `/proxy/html-reader`
 * for one reason, and it is the same reason here: a browser cannot put a
 * third-party PDF or page into a frame it controls — the origin refuses the
 * cross-origin request, or answers `X-Frame-Options`/`frame-ancestors` and the
 * frame stays blank. Fetching server-side and handing the bytes back from this
 * origin removes the boundary entirely; the page then builds a same-origin
 * blob URL, which no policy blocks.
 *
 * Everything here is READ-ONLY and bounded: GET only, http(s) only, a size
 * ceiling, and a timeout. It is a reading aid, not an open relay.
 */

/** Largest document the proxy will relay. */
const MAX_BYTES = 40 * 1024 * 1024;

/** Seconds before an upstream fetch is abandoned. */
const TIMEOUT_MS = 30_000;

/** Sent upstream so a site serves its ordinary document rather than a bot page. */
const FETCH_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

/**
 * Whether a URL is safe for the proxy to fetch.
 *
 * Blocking loopback and private ranges keeps the route from being turned into
 * a probe of the host's own network: the page can ask for any public document,
 * and nothing else.
 * @param raw - the requested URL.
 * @returns the parsed URL, or undefined when it must be refused.
 */
export function admissibleUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return undefined;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return undefined;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return undefined;
  if (host === "::1" || host === "[::1]") return undefined;
  return parsed;
}

/**
 * Fetch one document with a bound on time and size.
 * @param url - the admitted URL.
 * @returns `{ status, contentType, body }` where body is a Buffer.
 */
export async function fetchDocument(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow", signal: controller.signal });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new Error(`document exceeds ${MAX_BYTES} bytes`);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      body: buffer,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Horizontal whitespace only — never a line break. */
const HORIZONTAL_SPACE = /[^\S\r\n]+/g;

/** Three or more consecutive line breaks. */
const BLANK_RUN = /\n{3,}/g;

/**
 * What separates a publisher's figure from the rest of the pictures on a page.
 *
 * Most images in a document are not figures — logos, avatars, sprite sheets,
 * share buttons, tracking pixels, spacer GIFs, cookie-banner art — and a filter
 * written as a list of filenames to reject loses to the first CMS that renames
 * its assets, and to every site nobody thought of. So every rule below is one
 * of exactly two kinds: a POSITIVE signal the publisher emitted (a
 * `<figcaption>`, a declared plate size, a written `alt`, an art-directed
 * `srcset`), or a statement the publisher made that this image is NOT a figure
 * (a declared 1x1 box, a 20:1 strip, a `role="presentation"`).
 *
 * THE FIRST AND LARGEST FILTER IS FREE AND IS NOT HERE. Readability has already
 * discarded the header, the nav, the footer and every aside before any of this
 * runs. Measured on the fixture in `tests/mission.test.mjs`, three of the eight
 * non-figures — the masthead SVG, the share icon, the footer logo — were gone
 * before the rules below saw a single image.
 *
 * THE SECOND-LARGEST FILTER IS NOT HERE EITHER, AND CANNOT BE. The strongest
 * signal that an image is furniture is that the SAME address appears under two
 * or more different documents, which is a statement about the corpus and not
 * about this page — measured rather than guessed, which is what makes it worth
 * more than every rule below. It belongs in the store's `placeableFigures`
 * projection, which can see every document; this function sees exactly one and
 * has no store handle. What it OWES that projection is IDENTITY: the same asset
 * reached from two pages must produce the same `url` string, byte for byte, or
 * the count never reaches two and a measured filter quietly becomes no filter.
 * That is why nothing here decorates an address — no cache-buster is stripped,
 * no query is normalised, no fragment is added.
 */
const FIGURE = Object.freeze({
  /**
   * Below this in a DECLARED dimension, the publisher has said it is not a
   * figure: 1x1 beacons, 16px icons, 32-48px avatars. A declared size is the
   * publisher's own statement about the image, which is why it overrides every
   * positive below — a 48px headshot with a well-written alt is a headshot.
   */
  minEdge: 65,
  /** Both declared dimensions at or over these and it is a plate, not a badge. A 728x90 banner fails on height. */
  keepWidth: 300,
  keepHeight: 150,
  /**
   * An alt this long is a description somebody wrote for a figure. "", "logo"
   * and "icon" never reach it.
   *
   * LENGTH ALONE IS NOT AUTHORSHIP, which is what let two site badges into a
   * report. A publisher who uploads Badge.png without writing an alt leaves
   * the CMS filename in the attribute, and
   * "Influencers By State Badge-white background.jpg" is forty-six
   * characters. `looksWritten` is the other half of this rule.
   */
  keepAltChars: 25,
  /** Under this, a near-square image is a badge, an avatar or an icon. */
  badgeEdge: 220,
  /** Within this of 1:1 is square enough to be one. */
  badgeRatio: 1.35,
  /** A `srcset` candidate this wide is art direction, which publishers buy for photographs and never for chrome. */
  keepSrcsetWidth: 600,
  /** A declared aspect this extreme is a sprite sheet or a rule, whatever else it scores. */
  maxRatio: 10,
  /** The widest rendition worth naming: a report renders under 900 CSS px, so this is already 2x, and a mission fetches hundreds of pages. */
  preferWidth: 1600,
  /** Per page. A gallery must not become the report, and `fetch_page` has a 32,000-character result ceiling above this. */
  max: 8,
  /** Captions run long on papers. Enough to identify a figure, bounded enough to keep a tool result small. */
  captionChars: 300,
  /** Enough preceding prose to find this spot again in any extraction of the same page. */
  anchorChars: 160,
});

/**
 * Where a deferred image keeps its real address, in fallback order.
 *
 * Readability's `_fixLazyImages` already copies a `data-*` value into `src` or
 * `srcset` — but only when the value matches `\.(jpg|jpeg|png|webp)`, so a CDN
 * path like `/i/12345?w=800` and every `.avif` is left where it was, and
 * `_fixRelativeUris` never absolutises it either because it only rewrites
 * `src`, `poster` and `srcset`. Reading these attributes directly is what
 * recovers those figures, and it is the reason every candidate is resolved
 * against `pageUrl` below rather than trusted to be absolute already.
 */
const LAZY_SOURCE_ATTRIBUTES = Object.freeze(["src", "data-src", "data-original", "data-lazy-src"]);

/** A positive integer HTML attribute, or 0 when the markup declared none. Never measured, never guessed. */
function declaredPixels(element, name) {
  const raw = (element.getAttribute(name) ?? "").trim();
  return /^\d{1,5}$/u.test(raw) ? Number(raw) : 0;
}

/** One `srcset` attribute parsed into `{url, width, density}`, in source order. */
function srcsetCandidates(raw) {
  const found = [];
  for (const part of String(raw ?? "").split(",")) {
    const bits = part.trim().split(/\s+/u);
    if (bits[0] === undefined || bits[0] === "") continue;
    const byWidth = /^(\d{1,5})w$/u.exec(bits[1] ?? "");
    const byDensity = /^([\d.]+)x$/u.exec(bits[1] ?? "");
    found.push({
      url: bits[0],
      width: byWidth === null ? 0 : Number(byWidth[1]),
      density: byDensity === null ? 0 : Number(byDensity[1]),
    });
  }
  return found;
}

/**
 * The one URL to keep for an image, and how wide the page said its widest is.
 *
 * `src` is often the SMALLEST rendition — the fallback a `<picture>` offers a
 * phone — so taking it stores a 600px thumbnail of a chart whose axis labels
 * only resolve at 1200. The widest is the wrong end too: a 2400w plate is
 * megabytes and a mission fetches hundreds of pages. So the widest candidate at
 * or under `preferWidth`, and the narrowest above it when every candidate is
 * larger than that.
 *
 * EVERY CANDIDATE IS RESOLVED AGAINST `pageUrl`, the absolute ones included.
 * `new URL(absolute, base)` returns the absolute one, so the resolve costs
 * nothing where `_fixRelativeUris` has already been and is load-bearing where
 * it has not: `data-src`, `data-srcset`, and any lazy attribute whose value
 * carries no image extension.
 *
 * A `data:` URI is SKIPPED rather than fatal, and the reason it is skipped is
 * not that data URIs tend to be beacons: a `data:` image has no fetchable
 * address, so there is nothing to attribute the figure TO, and an image that
 * cannot carry its provenance cannot be evidence. It is skipped rather than
 * fatal because a page that puts a base64 spacer in `src` puts the real address
 * in `data-src`, and refusing at the first candidate loses the figure to its
 * own placeholder.
 *
 * @param image - an `<img>` inside the extracted article.
 * @param pageUrl - the document's own URL.
 * @returns `{ url, width, widest }`; `url` is "" when there is nothing http(s) to keep.
 */
function bestSource(image, pageUrl) {
  const pool = [
    ...srcsetCandidates(image.getAttribute("srcset")),
    ...srcsetCandidates(image.getAttribute("data-srcset")),
  ];
  const picture = image.parentElement?.tagName === "PICTURE" ? image.parentElement : null;
  if (picture !== null) {
    for (const source of picture.querySelectorAll("source")) {
      pool.push(...srcsetCandidates(source.getAttribute("srcset")));
      pool.push(...srcsetCandidates(source.getAttribute("data-srcset")));
    }
  }
  pool.sort((a, b) => (b.width - a.width) || (b.density - a.density));
  const described = pool.filter((candidate) => candidate.width > 0 || candidate.density > 0);
  const widest = described[0]?.width ?? 0;
  const under = described.filter((candidate) => candidate.width > 0 && candidate.width <= FIGURE.preferWidth);
  const pick = under[0] ?? described[described.length - 1];
  // ORDER IS THE DESIGN. A descriptored `srcset` candidate is the publisher
  // choosing a rendition; `src` is its lowest common denominator; a `data-*`
  // attribute is what a lazy loader left behind; a descriptorless `srcset`
  // entry is last because it is worth exactly what `src` is worth and `src` is
  // the attribute the page actually meant.
  const ordered = [];
  if (pick !== undefined) ordered.push({ url: pick.url, width: pick.width });
  for (const name of LAZY_SOURCE_ATTRIBUTES) ordered.push({ url: (image.getAttribute(name) ?? "").trim(), width: 0 });
  for (const candidate of pool) ordered.push({ url: candidate.url, width: 0 });
  for (const candidate of ordered) {
    if (candidate.url === "") continue;
    try {
      const parsed = new URL(candidate.url, pageUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      return { url: parsed.href, width: candidate.width, widest };
    } catch {
      continue;
    }
  }
  return { url: "", width: 0, widest: 0 };
}

/**
 * The publisher's own figures, out of the article body Readability kept.
 *
 * Runs on the extracted subtree BEFORE it is serialised, so nothing is parsed
 * twice — the parse is already the larger term inside `fetch_page`'s 45-second
 * ceiling — and so that nothing about the returned `content` or `textContent`
 * can change. This reads the tree; it does not touch it.
 *
 * IT CANNOT READ THE MARKDOWN, AND THAT IS NOT A PREFERENCE. The `dropImages`
 * rule below strips `img`, `picture` and `figure` before the Markdown exists,
 * so by the time there is a `markdown` string there is no image left in it to
 * harvest. The DOM is the only place the pictures are.
 *
 * `pageUrl` IS COPIED ONTO EVERY RECORD, and the duplication is the point. A
 * figure travels from here through `readHit`, a tool observation, the collect
 * stage's harvest and a store write, and at every one of those hops an array
 * can be sliced, concatenated with another page's, or re-ordered. A figure that
 * has lost its page has lost its attribution, and an image on a screen without
 * attribution is a fabricated figure. Carrying the address makes attribution
 * intrinsic to the record instead of positional.
 *
 * `textOffset` is the number of characters of `articleContent.textContent` that
 * precede the image. That is the exact string this file normalises into `text`,
 * which is the string a quote is verified against, so an offset here addresses
 * the same substrate. `anchorText` is the prose immediately before the image,
 * and it is the field a placer should actually use: an offset survives nothing
 * downstream — not the blank-run collapse, not the 4,000-character budget slice
 * — while a run of the page's own words can be found again in any extraction of
 * the same page.
 *
 * @param root - Readability's article element, captured mid-parse.
 * @param pageUrl - the document's own URL.
 * @returns `[{ url, pageUrl, alt, caption, width, height, srcsetWidth, textOffset, anchorText, score }]`, at most `FIGURE.max`, in article order.
 */
/**
 * Whether an alt attribute is a sentence somebody wrote, or a filename.
 *
 * MEASURED: two site badges reached a published report because their alt
 * attributes are longer than the twenty-five characters the rule treats as
 * authorship — they are filenames, and filenames are long.
 *
 * A written alt has spaces and does not end in an image extension. Both
 * halves are needed: "Influencer Project Badge.png" has a space, and
 * "reid-hoffman-2013-portrait" has none but is still not a sentence.
 * @param alt - the attribute's text, already collapsed and trimmed.
 * @returns true when it reads as prose rather than as a file.
 */
export function looksWritten(alt) {
  const text = String(alt ?? "").trim();
  if (text.length < FIGURE.keepAltChars) return false;
  if (/\.(?:jpe?g|png|gif|webp|avif|svgz?|bmp|tiff?)$/iu.test(text)) return false;
  // A run of words, not a slug. Two spaces is the floor because a two-word
  // alt is a label and a description is a phrase.
  return (text.match(/\s/gu) ?? []).length >= 2;
}

export function articleFigures(root, pageUrl) {
  const kept = [];
  const seen = new Set();
  let offset = 0;
  let tail = "";

  const consider = (image, at, before) => {
    const source = bestSource(image, pageUrl);
    // A repeated URL is a template element — the byline portrait once per
    // section — and not a second figure. The first position wins.
    if (source.url === "" || seen.has(source.url)) return;

    const figure = image.closest("figure");
    // `:scope >` first so a nested figure's caption is not read as this one's;
    // the descendant fallback is for the papers that wrap the caption a level in.
    const captionNode = figure === null
      ? null
      : (figure.querySelector(":scope > figcaption") ?? figure.querySelector("figcaption"));
    const caption = (captionNode?.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, FIGURE.captionChars);
    const alt = (image.getAttribute("alt") ?? "").replace(/\s+/gu, " ").trim();
    const width = declaredPixels(image, "width");
    const height = declaredPixels(image, "height");

    // The publisher saying it is not a figure. These override every positive.
    if ((width > 0 && width < FIGURE.minEdge) || (height > 0 && height < FIGURE.minEdge)) return;
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (ratio >= FIGURE.maxRatio || ratio <= 1 / FIGURE.maxRatio) return;
    }
    // The publisher marking the image as decoration in the accessibility tree.
    // Same class of statement as a declared 1x1, and it catches the one shape
    // nothing else here does: an art-directed, plate-sized, well-described hero
    // that the page itself says is ornament.
    //
    // `role` ONLY, AND NOT `aria-hidden`, WHICH IS MEASURED AND NOT A HUNCH.
    // Readability's `_isProbablyVisible` (Readability.js:2694) already drops
    // every `aria-hidden="true"` node before this runs — EXCEPT one it keeps on
    // purpose, whose own comment reads "check for 'fallback-image' so that
    // wikimedia math images are displayed". So an `aria-hidden` test here is
    // dead for every image it would be right about, and live for exactly the
    // one it would be wrong about: run it and the captioned Wikipedia math
    // render is the single figure it deletes. `role` is the live half —
    // Readability consults `role` only on `<table>` (Readability.js:2276), so
    // an `<img role="presentation">` reaches this line untouched.
    if (image.getAttribute("role") === "presentation") return;
    // SVG is the format of logos, icon systems AND real diagrams, and nothing in
    // the URL tells them apart. A `<figcaption>` does, so an SVG needs one.
    if (/\.svgz?$/u.test(new URL(source.url).pathname.toLowerCase()) && caption === "") return;

    // AN IMAGE THAT IS A LINK TO ANOTHER HOST is an advertisement or a teaser,
    // never the article's own figure. A lightbox link to a larger rendition is
    // same-host and is untouched. This is the rule that drops the 728x200
    // sponsor banner, which otherwise passes on its declared size and its
    // written alt alone — measured: remove this clause and it is admitted.
    const link = image.closest("a");
    let offsite = false;
    if (link !== null) {
      try {
        offsite = new URL(link.getAttribute("href") ?? "", pageUrl).hostname !== new URL(pageUrl).hostname;
      } catch {
        offsite = false;
      }
    }

    // A NEAR-SQUARE IMAGE UNDER 220px IS A BADGE, whatever else it scores.
    // Refused before the three positive signals rather than weighed against
    // them, because the signal that admitted these is exactly the one a badge
    // fakes: 150x154 with a filename for an alt.
    if (width > 0 && height > 0 && width < FIGURE.badgeEdge && height < FIGURE.badgeEdge) {
      const square = width / height;
      if (square <= FIGURE.badgeRatio && square >= 1 / FIGURE.badgeRatio) return;
    }

    const plate = width >= FIGURE.keepWidth && (height === 0 || height >= FIGURE.keepHeight);
    // WRITTEN, NOT MERELY LONG. `alt.length >= 25` counted a filename as a
    // description and put two ballotpedia badges into a report about PayPal.
    const written = looksWritten(alt);
    const art = source.widest >= FIGURE.keepSrcsetWidth;
    // A caption outranks the offsite rule: a syndicated figure credited to
    // another outlet is still a figure, and the caption is the publisher saying
    // so in its own words.
    if (caption === "" && (offsite || (!plate && !written && !art))) return;

    seen.add(source.url);
    kept.push({
      url: source.url,
      pageUrl: String(pageUrl ?? ""),
      alt,
      caption,
      width,
      height,
      srcsetWidth: source.width,
      textOffset: at,
      anchorText: before.replace(/\s+/gu, " ").trim().slice(-FIGURE.anchorChars),
      // WHICH POSITIVES FIRED, as one number. Its first job is local: it is how
      // the cap keeps the captioned chart and drops the eighth stock photograph
      // rather than keeping whichever eight came first. Its second job is why
      // it is RETURNED rather than discarded — `mission_figures.score` exists
      // so that a figure nobody can justify a year later can still be
      // explained, and a column whose only source is a number the store made up
      // is the invented value this codebase refuses. It is an ORDINAL over one
      // page's candidates and nothing else: not a probability, not a quality,
      // not comparable between pages, and never to be rendered as a percentage.
      score: (caption !== "" ? 4 : 0) + (written ? 2 : 0) + (width >= 600 ? 2 : plate ? 1 : 0) + (art ? 1 : 0) + (figure !== null ? 1 : 0),
    });
  };

  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const value = child.nodeValue ?? "";
        offset += value.length;
        tail = (tail + value).slice(-FIGURE.anchorChars * 3);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (child.tagName === "IMG") consider(child, offset, tail);
      visit(child);
    }
  };
  visit(root);

  // SORTED TWICE ON PURPOSE. By score to decide WHICH survive the cap, then
  // back into article order to decide what order they arrive in, because a
  // consumer placing figures beside the prose reads them in the order the page
  // laid them out and never in the order this function ranked them.
  return kept
    .sort((a, b) => (b.score - a.score) || (a.textOffset - b.textOffset))
    .slice(0, FIGURE.max)
    .sort((a, b) => a.textOffset - b.textOffset);
}

/**
 * Extract an article the way a reader mode does, and hand it back as Markdown.
 *
 * The first pass here stripped tags with regular expressions, and it showed:
 * "Skip to Main Content" and the site's nav survived into the article, the
 * title appeared three times, and every heading, list, and code block
 * flattened into indistinguishable paragraphs.
 *
 * Readability is the algorithm that solves precisely that — it scores blocks
 * by text density and link ratio to find the article body and discard the
 * chrome — and it is what the reference uses (`@mozilla/readability` with
 * `jsdom` and `turndown`). Using the real thing rather than approximating it
 * is the whole point: the failure mode of an approximation is silent, and the
 * reader cannot tell a mangled article from a badly written one.
 *
 * Turndown then converts the extracted DOM to Markdown, so structure survives
 * to the page, where the same renderer that formats an assistant's answer
 * formats the article.
 * @param html - the document body.
 * @param url - the document's own URL, which Readability needs to resolve links.
 * @returns `{ title, byline, markdown, text }`.
 */
export async function readArticle(html, url) {
  const { JSDOM } = await import("jsdom");
  const { Readability } = await import("@mozilla/readability");
  const TurndownService = (await import("turndown")).default;

  const dom = new JSDOM(html, { url });
  // A TAP, NOT A CHANGE. Readability's default serializer is exactly
  // `(el) => el.innerHTML` (Readability.js:59-63), so this one returns the same
  // `content` byte for byte; what it adds is a handle on the article element
  // while it still exists. The alternative is re-parsing `article.content` into
  // a second DOM to find the images, which pays for the expensive half of this
  // function twice inside a 45-second tool ceiling.
  //
  // IT CANNOT REACH THE QUOTABLE TEXT, for two independent reasons. Readability
  // reads `var textContent = articleContent.textContent` (Readability.js:2766)
  // BEFORE it calls `this._serializer(articleContent)` (2772), so a serializer
  // that mutated the tree still could not change the string — and this one only
  // records a reference. And `articleFigures` below runs after `.parse()` has
  // returned, by which time `article.textContent` is already a finished string.
  let extracted = null;
  const article = new Readability(dom.window.document, {
    serializer: (node) => { extracted = node; return node.innerHTML; },
  }).parse();
  if (article === null || typeof article.content !== "string" || article.content.trim() === "") {
    throw new Error("no readable article could be extracted from this page");
  }
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // An image carries nothing a reader can use here and would only leave a
  // broken box, since the page cannot load third-party assets.
  turndown.addRule("dropImages", { filter: ["img", "picture", "figure"], replacement: () => "" });
  // An icon-only link loses its icon with the images and would arrive as a
  // bare `[](url)`, which is what a "listen to this article" button left
  // sitting at the top of the first extracted article.
  turndown.addRule("dropEmptyLinks", {
    filter: (node) => node.nodeName === "A" && (node.textContent ?? "").trim() === "",
    replacement: () => "",
  });
  const markdown = turndown.turndown(article.content).replace(BLANK_RUN, "\n\n").trim();
  return {
    title: article.title ?? "",
    byline: article.byline ?? "",
    // The publication, which Readability reads from `og:site_name`. The
    // library's own idea of a source is the first author or the hostname,
    // and neither is the masthead a reader recognises.
    siteName: article.siteName ?? "",
    // Readability's excerpt is the page's own description meta where there is
    // one, and its opening otherwise. The reader shows it as a lead, which is
    // what the reference does — and worth being clear about: it is the
    // publisher's own line, not anything a model wrote.
    excerpt: article.excerpt ?? "",
    markdown,
    text: (article.textContent ?? "").replace(BLANK_RUN, "\n\n").trim(),
    // BESIDE THE TEXT, NEVER INSIDE IT — one sibling key, and `dropImages`
    // above does not move. Its own docblock is right on its terms, and there is
    // a larger reason it must stay: `fetch_page` returns this `text` and
    // `quote_verify` checks a quote as a literal substring of exactly it. Alt
    // text or a caption spliced in would not break one quote; it would
    // retroactively unverify every quote this system has ever recorded.
    //
    // Measured, not assumed: an `alt` is an attribute and is never in
    // `textContent`; a `<figcaption>`'s words ARE in `textContent` and always
    // have been, because the caption is part of the article body Readability
    // keeps — so a caption in a figure record is a COPY of words already in
    // `text`, not an addition to it. (They are absent from `markdown`, because
    // `dropImages` filters `figure` and discards its children.)
    figures: extracted === null ? [] : articleFigures(extracted, url),
  };
}

/** Block-level tags whose boundaries should become paragraph breaks. */
const BLOCK_TAGS ="address|article|aside|blockquote|div|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul";

/**
 * Extract readable article text from an HTML document.
 *
 * A deliberately small reader: strip the non-content elements, turn block
 * boundaries into breaks, decode entities, and collapse whitespace. It will
 * never match a full readability implementation, and where it fails the page
 * says so and offers the original link rather than showing a mangled article.
 * @param html - the document body.
 * @returns `{ title, text }`.
 */
export function readableText(html) {
  const source = String(html);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const stripped = source
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(new RegExp(`</(?:${BLOCK_TAGS})>`, "gi"), "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  // Trim each line BEFORE collapsing blank runs. A line holding only spaces is
  // not empty until it is trimmed, so collapsing first leaves every one of
  // them standing and the article arrives full of gaps — which is exactly what
  // the first pass produced.
  const text = decodeHtmlEntities(stripped)
    .replace(HORIZONTAL_SPACE, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(BLANK_RUN, "\n\n")
    .trim();
  return {
    title: titleMatch === null ? "" : decodeHtmlEntities(titleMatch[1]).trim(),
    text,
  };
}

/** Decode the entities an article body commonly carries. */
export function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…").replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"').replace(/&ldquo;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Decide how a source should be presented, mirroring the upstream's
 * `getResourceDisplayMode`.
 *
 * The order matters and is the upstream's: YouTube first, because a watch URL
 * can carry `.pdf` in a query string; an explicit `/html/` path next, because
 * a mirror of a paper serves HTML from a PDF-looking id; then the PDF shapes,
 * including the extensionless `/pdf` endpoints that arXiv and OpenReview use.
 * @param row - a stored `Resource`.
 * @returns `'youtube' | 'pdf' | 'html' | 'none'`.
 */
/**
 * The PDF an abstract page stands for, where that mapping is deterministic.
 *
 * arXiv publishes `/abs/<id>` as the landing page and `/pdf/<id>` as the paper,
 * and 84% of the papers in this library arrived as `/abs/` with no `pdfUrl` —
 * so treating them as ordinary web pages opened arXiv's abstract listing and
 * called it the paper. The reference never hits this because its own collector
 * fills `pdfUrl`; rows that arrived without one still need the mapping.
 * @param row - a stored `Resource`.
 * @returns the derived PDF URL, or an empty string when none is implied.
 */
export function derivedPdfUrl(row) {
  const sourceUrl = typeof row?.sourceUrl === "string" ? row.sourceUrl : "";
  const match = /^https?:\/\/(?:www\.)?arxiv\.org\/abs\/(.+)$/i.exec(sourceUrl);
  return match === null ? "" : `https://arxiv.org/pdf/${match[1]}`;
}

export function displayModeOf(row) {
  const sourceUrl = typeof row?.sourceUrl === "string" ? row.sourceUrl : "";
  const stored = typeof row?.pdfUrl === "string" ? row.pdfUrl : "";
  const pdfUrl = stored !== "" ? stored : derivedPdfUrl(row);
  if (row?.type === "YOUTUBE" || row?.type === "YOUTUBE_VIDEO") return "youtube";
  if (sourceUrl.includes("/html/") || pdfUrl.includes("/html/")) return sourceUrl === "" ? "none" : "html";
  const looksPdf = (url) => {
    if (url === "") return false;
    if (url.toLowerCase().endsWith(".pdf")) return true;
    if (url.includes("/pdf/")) return true;
    try {
      const { pathname } = new URL(url);
      return pathname === "/pdf" || pathname.endsWith("/pdf");
    } catch {
      return false;
    }
  };
  if (looksPdf(sourceUrl) || looksPdf(pdfUrl)) return "pdf";
  return sourceUrl === "" ? "none" : "html";
}

/**
 * The URL whose document should be shown for a source.
 * @param row - a stored `Resource`.
 * @returns the document URL, or an empty string when there is none.
 */
export function documentUrlOf(row) {
  if (displayModeOf(row) === "pdf") {
    const stored = typeof row?.pdfUrl === "string" ? row.pdfUrl : "";
    if (stored !== "") return stored;
    const derived = derivedPdfUrl(row);
    if (derived !== "") return derived;
  }
  return typeof row?.sourceUrl === "string" ? row.sourceUrl : "";
}
