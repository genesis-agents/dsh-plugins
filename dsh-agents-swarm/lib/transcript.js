/**
 * YouTube transcripts through the timedtext API.
 *
 * The route is the one the upstream's `youtube.service.ts` takes first and for
 * the same reason: the watch page carries a `captionTracks` array inside
 * `ytInitialPlayerResponse`, each entry a signed `baseUrl` for the timedtext
 * XML. It costs no API key and no quota, which matters because the swarm reads
 * far more videos than an API allowance would cover. The upstream falls back to
 * `youtube-transcript`, `youtubei.js`, and a paid provider; this package
 * resolves no dependencies, so the fallback here is an honest failure the
 * caller reports rather than a silent empty transcript.
 *
 * A fetched transcript is cached in the library: a published video's captions
 * do not change, and YouTube throttles repeated watch-page fetches.
 */

/** Browser-ish headers; the watch page serves a different shell to bare clients. */
const PAGE_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

/** Language preference order when the caller names none. */
const DEFAULT_LANGUAGES = ["zh-Hans", "zh-CN", "zh", "en", "en-US"];

/** Decode the XML entities timedtext uses in its text nodes. */
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse timedtext XML into ordered cues.
 * @param xml - the timedtext document.
 * @returns `[{ start, duration, text }]` with empty cues dropped.
 */
export function parseTimedText(xml) {
  const cues = [];
  for (const match of String(xml).matchAll(/<text([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attributes = match[1];
    const text = decodeEntities(match[2]).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (text === "") continue;
    const start = Number(/\bstart="([\d.]+)"/.exec(attributes)?.[1] ?? 0);
    const duration = Number(/\bdur="([\d.]+)"/.exec(attributes)?.[1] ?? 0);
    cues.push({ start, duration, text });
  }
  return cues;
}

/**
 * Read the caption track table out of a watch page.
 * @param html - the watch page body.
 * @returns the parsed tracks, or an empty array when the page carries none.
 */
export function captionTracksOf(html) {
  const match = /"captionTracks":\s*(\[.*?\])/.exec(String(html));
  if (match === null) return [];
  try {
    const tracks = JSON.parse(match[1]);
    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

/**
 * Choose a track by language preference, falling back to the first available.
 * @param tracks - parsed caption tracks.
 * @param languages - preference order.
 * @returns the chosen track, or undefined when there are none.
 */
export function pickTrack(tracks, languages = DEFAULT_LANGUAGES) {
  for (const language of languages) {
    const base = language.split("-")[0];
    const exact = tracks.find((track) => track.languageCode === language);
    if (exact !== undefined) return exact;
    const loose = tracks.find((track) => String(track.languageCode ?? "").startsWith(base));
    if (loose !== undefined) return loose;
  }
  return tracks[0];
}

/**
 * Phrases a relay returns, as a valid transcript, when it is itself blocked.
 *
 * This is the trap that makes a naive chain worse than no chain:
 * `youtubetranscript.com` answers HTTP 200 with well-formed timedtext XML
 * whose only cue is an apology, so a parser that checks only "did it parse"
 * stores the apology as the transcript and every later summary is grounded in
 * it. Measured, not assumed — the service returns exactly this today.
 */
const RELAY_FAILURE_MARKERS = [
  "youtube is currently blocking us",
  "we're working on a fix",
  "no transcript available",
  "subtitles are disabled",
];

/**
 * Whether a transcript body is actually a relay's failure notice.
 * @param text - the joined transcript text.
 * @returns true when the body is an apology rather than captions.
 */
export function isRelayFailure(text) {
  const head = String(text).slice(0, 400).toLowerCase();
  return RELAY_FAILURE_MARKERS.some((marker) => head.includes(marker));
}

/**
 * Fetch a transcript through the public `youtubetranscript.com` relay.
 *
 * Free and key-less, which is why the upstream tries it before paying. It is
 * frequently blocked upstream itself; {@link isRelayFailure} is what keeps a
 * block from being mistaken for content.
 * @param videoId - the video id.
 * @param languages - preference order.
 * @returns `{ language, text, cues }`.
 */
export async function fetchViaRelay(videoId, languages = DEFAULT_LANGUAGES) {
  const failures = [];
  for (const language of languages) {
    const endpoint = `https://youtubetranscript.com/?lang=${encodeURIComponent(language)}&server_vid2=${videoId}`;
    const response = await fetch(endpoint, { headers: PAGE_HEADERS });
    if (!response.ok) {
      failures.push(`${language}: HTTP ${response.status}`);
      continue;
    }
    const cues = parseTimedText(await response.text());
    if (cues.length === 0) {
      failures.push(`${language}: no cues`);
      continue;
    }
    const text = cues.map((cue) => cue.text).join(" ");
    if (isRelayFailure(text)) {
      failures.push(`${language}: relay is blocked by YouTube`);
      continue;
    }
    return { language, text, cues };
  }
  throw new Error(failures.join(", "));
}

/**
 * Read the caption tracks a video publishes, for a browser to fetch.
 *
 * The split exists because the block is asymmetric, which is measurable: a
 * server CAN read the watch page and extract the signed `baseUrl` (this
 * function), but fetching that URL from a server answers 200 with an empty
 * body no matter what headers accompany it — plain, with `Origin`, with
 * `Referer`, all zero bytes. The same URL does carry the captions when a real
 * browser asks, because the endpoint answers
 * `Access-Control-Allow-Origin: <page origin>` with
 * `Access-Control-Allow-Credentials: true` and the browser supplies the
 * visitor's own YouTube session.
 *
 * So the server does the half only it can do, and hands the rest to the page.
 * That keeps new videos readable indefinitely, with no key and no third party,
 * after every relay and the retiring upstream are gone.
 * @param videoId - the video id.
 * @returns `[{ languageCode, name, baseUrl }]`.
 */
export async function listCaptionTracks(videoId) {
  const page = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: PAGE_HEADERS });
  if (!page.ok) throw new Error(`watch page: HTTP ${page.status}`);
  const tracks = captionTracksOf(await page.text());
  return tracks
    .filter((track) => typeof track.baseUrl === "string")
    .map((track) => ({
      languageCode: track.languageCode ?? "unknown",
      name: track.name?.simpleText ?? track.languageCode ?? "unknown",
      baseUrl: track.baseUrl,
    }));
}

/**
 * Turn timedtext XML a browser fetched into a stored transcript shape.
 * @param xml - the raw timedtext document.
 * @param language - the track's language code.
 * @returns `{ language, text, cues }`.
 * @throws when the document is empty or is a block notice.
 */
export function transcriptFromXml(xml, language) {
  const cues = parseTimedText(xml);
  if (cues.length === 0) throw new Error("caption document parsed to zero cues");
  const text = cues.map((cue) => cue.text).join(" ");
  if (isRelayFailure(text)) throw new Error("the caption document is a block notice, not captions");
  return { language, text, cues };
}

/**
 * Fetch a transcript through the gens.team public endpoint.
 *
 * Measured, not assumed: this endpoint returns captions today for videos that
 * are certainly not in its own library (tested with an unrelated 2009 music
 * video), so it is a live route rather than a cache read. The technique behind
 * it is the same watch-page + `baseUrl` walk this module already implements —
 * what differs is the network it runs from. YouTube's block is applied to the
 * caller's path, not to the method, so a host that YouTube does not throttle
 * succeeds where this one gets an empty body.
 *
 * It is included for the same reason seeding exists: the service is scheduled
 * to be retired, and every transcript pulled through it before then is one the
 * local library keeps afterwards. It must never become the steady-state route.
 * @param videoId - the video id.
 * @param base - the endpoint origin.
 * @param language - preferred language code.
 * @returns `{ language, text, cues }`.
 */
export async function fetchViaGens(videoId, base, language = "en") {
  const response = await fetch(`${base}/youtube/transcript/${videoId}?lang=${encodeURIComponent(language)}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const segments = payload?.data?.transcript;
  if (!Array.isArray(segments) || segments.length === 0) throw new Error("no transcript in response");
  const cues = segments
    .map((segment) => ({
      start: Number(segment.start ?? 0),
      duration: Number(segment.duration ?? 0),
      text: String(segment.text ?? "").trim(),
    }))
    .filter((cue) => cue.text !== "");
  if (cues.length === 0) throw new Error("transcript parsed to zero cues");
  const text = cues.map((cue) => cue.text).join(" ");
  if (isRelayFailure(text)) throw new Error("upstream returned a block notice");
  return { language, text, cues };
}

/**
 * Fetch a transcript through Supadata.
 *
 * The paid path, and the one the upstream falls back to for the same reason:
 * YouTube has hardened `timedtext` so that a signed `baseUrl` fetched from a
 * server answers 200 with an empty body — measured, not assumed — because the
 * player now supplies a proof-of-origin token the endpoint requires. The
 * official Data API v3 is not an alternative: `captions.download` authorizes
 * only the video's own channel, so it cannot read third-party videos at all.
 * @param videoId - the video id.
 * @param apiKey - a Supadata key.
 * @param language - preferred language code.
 * @returns `{ language, text, cues }`.
 */
export async function fetchViaSupadata(videoId, apiKey, language = "en") {
  const params = new URLSearchParams({
    url: `https://www.youtube.com/watch?v=${videoId}`,
    lang: language,
  });
  const response = await fetch(`https://api.supadata.ai/v1/transcript?${params.toString()}`, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`supadata: HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload?.content;
  // The provider answers either a cue array or one joined string.
  const cues = Array.isArray(content)
    ? content.map((cue) => ({
      start: Number(cue.offset ?? 0) / 1000,
      duration: Number(cue.duration ?? 0) / 1000,
      text: String(cue.text ?? "").trim(),
    })).filter((cue) => cue.text !== "")
    : [];
  const text = cues.length > 0
    ? cues.map((cue) => cue.text).join(" ")
    : typeof content === "string" ? content.trim() : "";
  if (text === "") throw new Error("supadata returned no transcript");
  return { language: payload?.lang ?? language, text, cues };
}

/**
 * Fetch one video's transcript through the free timedtext route.
 * @param videoId - the eleven-character video id.
 * @param languages - preference order.
 * @returns `{ language, text, cues }`.
 * @throws when the page, the track table, or the track itself is unavailable.
 */
export async function fetchTranscript(videoId, languages = DEFAULT_LANGUAGES) {
  const page = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: PAGE_HEADERS });
  if (!page.ok) throw new Error(`watch page: HTTP ${page.status}`);
  const tracks = captionTracksOf(await page.text());
  if (tracks.length === 0) throw new Error("this video publishes no caption track");
  const track = pickTrack(tracks, languages);
  if (track?.baseUrl === undefined) throw new Error("no usable caption track");
  const captions = await fetch(track.baseUrl, { headers: PAGE_HEADERS });
  if (!captions.ok) throw new Error(`timedtext: HTTP ${captions.status}`);
  const cues = parseTimedText(await captions.text());
  if (cues.length === 0) throw new Error("caption track parsed to zero cues");
  return {
    language: track.languageCode ?? "unknown",
    text: cues.map((cue) => cue.text).join(" "),
    cues,
  };
}

/**
 * Resolve a transcript through the configured chain: free first, paid second.
 *
 * The order is the upstream's and the reason is cost: timedtext charges
 * nothing when it works, so it is always tried, and the provider key is spent
 * only on videos it cannot serve. Results are cached by the caller.
 * @param videoId - the video id.
 * @param options - `{ apiKey, gensBase, languages }`.
 * @returns `{ language, text, cues, via }`.
 * @throws an error naming every route that was tried and why it failed.
 */
export async function resolveTranscript(videoId, { apiKey, gensBase, languages = DEFAULT_LANGUAGES } = {}) {
  const failures = [];
  try {
    return { ...await fetchTranscript(videoId, languages), via: "timedtext" };
  } catch (cause) {
    failures.push(`timedtext: ${String(cause?.message ?? cause)}`);
  }
  try {
    return { ...await fetchViaRelay(videoId, languages), via: "relay" };
  } catch (cause) {
    failures.push(`relay: ${String(cause?.message ?? cause)}`);
  }
  // Ahead of the paid route because it works today and costs nothing; behind
  // the free ones because it is on its way out.
  if (typeof gensBase === "string" && gensBase.trim() !== "") {
    try {
      return { ...await fetchViaGens(videoId, gensBase.trim().replace(/\/+$/, ""), languages[0] ?? "en"), via: "gens" };
    } catch (cause) {
      failures.push(`gens: ${String(cause?.message ?? cause)}`);
    }
  }
  if (typeof apiKey === "string" && apiKey.trim() !== "") {
    try {
      return { ...await fetchViaSupadata(videoId, apiKey.trim(), languages[0] ?? "en"), via: "supadata" };
    } catch (cause) {
      failures.push(`supadata: ${String(cause?.message ?? cause)}`);
    }
  } else {
    failures.push("supadata: no API key configured (Settings → Sources)");
  }
  throw new Error(failures.join("; "));
}
