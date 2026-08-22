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
export function displayModeOf(row) {
  const sourceUrl = typeof row?.sourceUrl === "string" ? row.sourceUrl : "";
  const pdfUrl = typeof row?.pdfUrl === "string" ? row.pdfUrl : "";
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
  if (displayModeOf(row) === "pdf" && typeof row.pdfUrl === "string" && row.pdfUrl !== "") return row.pdfUrl;
  return typeof row?.sourceUrl === "string" ? row.sourceUrl : "";
}
