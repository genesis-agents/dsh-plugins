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
 * Split the configured Supadata secret into the keys it holds.
 *
 * ONE SETTING, MANY KEYS. A free Supadata key carries a small monthly
 * quota, and a library of a few hundred videos exhausts one in an
 * afternoon — after which every transcript on the tab fails with the same
 * 429 and the only fix is to paste a new key over the old one. Several
 * keys, tried in turn, is the difference between a quota that runs out and
 * one that is a sum.
 *
 * STILL A STRING IN THE STORE. `supadataKey` is a settings value with a
 * validator, a patch route and a redaction rule already written against
 * its type; splitting the string here rather than storing an array keeps
 * all three, and a single key remains a single key with no migration.
 *
 * Separated by newline, comma or whitespace, because a person pasting four
 * keys will use whichever of the three their clipboard produced. Deduped,
 * so the same key pasted twice does not get two turns at a spent quota.
 * @param raw - the stored setting.
 * @returns the keys, in the order they were written, without duplicates.
 */
export function supadataKeys(raw) {
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(/[\s,;]+/u).map((key) => key.trim()).filter((key) => key !== ""))];
}

/**
 * Where the next transcript starts in the key list.
 *
 * ROUND-ROBIN, NOT ALWAYS-FIRST. Trying the list from the top every time
 * spends the first key's whole quota before the second is touched, which
 * is one key with extra steps — and it means the first key is the one that
 * gets rate-limited under a burst while three others sit idle.
 *
 * Module-level and deliberately not persisted: it is a load-spreading hint,
 * not a fact about the library, and a process restart losing it costs
 * nothing. Every key is still tried before the chain gives up, so the
 * cursor can never make a transcript fail that would otherwise have worked.
 */
let supadataCursor = 0;

/**
 * What each Supadata key has actually done, keyed by the key itself.
 *
 * WHY IT EXISTS. The quota is the SUM of the keys, so a list of four with one
 * exhausted behaves exactly like a list of three — and there was no way to
 * learn which one. `resolveTranscript` names the position in its failure
 * string, but that string is only seen by whoever happens to be reading a
 * single failed fetch; a person looking at the settings page saw "已配置 2 把"
 * and nothing else. Which key to replace was unanswerable from the product.
 *
 * KEYED BY THE KEY, NOT BY POSITION. Positions move: editing the textarea to
 * remove a dead key renumbers every one after it, and a tally that survived
 * that edit would attribute the dead key's refusals to its innocent successor.
 *
 * IN MEMORY, DELIBERATELY. This is "what has happened since this host started",
 * which is the question worth asking about a quota — a count persisted across
 * restarts would still be counting a month-old exhaustion after the quota
 * reset. It is a health reading, not a ledger.
 */
const supadataHealth = new Map();

/**
 * Record one key's outcome.
 * @param key - the key used.
 * @param outcome - "ok" | "quota" | "failed".
 * @param error - the scrubbed message, for the two that are not "ok".
 */
/**
 * How long a key that answered 429 is left alone.
 *
 * A QUOTA IS NOT A BLIP. Supadata's resets on its own schedule — daily or
 * monthly, not in ninety seconds — so retrying a refused key on the next video
 * spends a request to be told the same thing, and does it once per video for
 * ever. Six hours is long enough that a day's quota is not re-probed dozens of
 * times, and short enough that a key restored at noon is back in service the
 * same afternoon.
 */
const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Paid requests made since this host started, and the ceiling on them.
 *
 * THE NUMBER NOBODY WAS COUNTING, and its absence is the whole reason five keys
 * emptied. The budget upstream counts VIDEOS — twelve a pass, sixty a drain —
 * and the paid calls those become are two multiplications away: sixty videos
 * against five keys is three hundred requests, and the figure on screen said
 * sixty. Nothing anywhere computed the second number, so nothing could refuse
 * it, report it, or notice it climbing.
 *
 * A CEILING RATHER THAN A WARNING. A meter that only reports is a meter
 * somebody has to be watching, and this ran unattended. Past the ceiling the
 * paid route is simply not taken; the free ones are unaffected, so the library
 * keeps gaining transcripts at no cost while the spend stays where it was put.
 *
 * PER HOST LIFETIME, not per pass. Per-pass is what the video budget already
 * is, and it is exactly the accounting that failed: twenty passes of a
 * "reasonable" per-pass budget is not a reasonable total. This is the total.
 */
const PAID_CALL_CEILING = 200;
let paidCalls = 0;

/** How many paid requests have been made, and what is left. */
export function supadataSpend() {
  return { calls: paidCalls, ceiling: PAID_CALL_CEILING, remaining: Math.max(0, PAID_CALL_CEILING - paidCalls) };
}

/** Forget the spend, for a host that has been given fresh quota. */
export function resetSupadataSpend() {
  const spent = paidCalls;
  paidCalls = 0;
  return spent;
}

/**
 * Forget every key's recorded state.
 *
 * TWO CALLERS AND BOTH ARE REAL. A person who has just topped up their quota
 * should not wait out a six-hour cooldown that is now describing a fact about
 * yesterday — the cooldown exists to stop pointless retries, not to punish
 * somebody for fixing the problem. And a module-level cache with no reset is a
 * cache that leaks between tests: two of them here failed on state left behind
 * by a third, which is a suite that reports the order it ran in rather than the
 * behaviour it checks.
 * @returns the number of keys forgotten.
 */
export function resetSupadataHealth() {
  const held = supadataHealth.size;
  supadataHealth.clear();
  return held;
}

/** Whether a key is inside its cooldown after a quota refusal. */
function isExhausted(key, now = Date.now()) {
  const held = supadataHealth.get(key);
  if (held === undefined || held.exhaustedAt === 0) return false;
  return now - held.exhaustedAt < QUOTA_COOLDOWN_MS;
}

function noteSupadataKey(key, outcome, error = "") {
  const held = supadataHealth.get(key) ?? { calls: 0, ok: 0, quota: 0, failed: 0, lastError: "", lastAt: "", exhaustedAt: 0 };
  held.calls += 1;
  held[outcome] += 1;
  held.lastAt = new Date().toISOString();
  if (outcome !== "ok") held.lastError = error;
  else held.lastError = "";
  // A QUOTA REFUSAL STARTS A COOLDOWN; A SUCCESS ENDS ONE. The second half
  // matters as much: a key restored on the provider's side must come back
  // without anybody restarting anything.
  if (outcome === "quota") held.exhaustedAt = Date.now();
  if (outcome === "ok") held.exhaustedAt = 0;
  supadataHealth.set(key, held);
}

/**
 * How each configured key is doing, in the order they are configured.
 *
 * THE KEYS THEMSELVES NEVER LEAVE THIS FUNCTION. This is handed to a browser,
 * and the rule the failure strings already follow — position, never the secret
 * — applies with more force to something drawn on a settings page. A caller
 * gets the ordinal, which is the line number in the textarea and therefore the
 * one thing that lets somebody find the key they need to replace.
 *
 * A key with no calls is reported as untried rather than omitted: "we have not
 * needed it yet" and "it is failing" are different answers, and a list that
 * silently drops the idle ones cannot be counted against the number configured.
 * @param raw - the stored key blob.
 * @returns `[{ position, state, calls, ok, quota, failed, lastError, lastAt }]`.
 */
export function maskSupadataKey(key) {
  const text = String(key ?? "");
  // SHORT KEYS SHOW ALMOST NOTHING. Four trailing characters of a
  // forty-character key is a fingerprint; four of a nine-character key is most
  // of it. The mask has to be a function of what is left to hide.
  if (text.length < 12) return "…" + text.slice(-2);
  return text.slice(0, 3) + "…" + text.slice(-4);
}

export function supadataKeyHealth(raw) {
  return supadataKeys(raw).map((key, at) => {
    const held = supadataHealth.get(key) ?? { calls: 0, ok: 0, quota: 0, failed: 0, lastError: "", lastAt: "", exhaustedAt: 0 };
    // The state is the LAST thing that happened, not a ratio: a key that served
    // a thousand transcripts and is now out of quota is out of quota, and an
    // average would report it as healthy for a long time.
    const state = held.calls === 0
      ? "untried"
      : (held.lastError === "" ? "ok" : (held.quota > 0 && /quota|429|rate.?limit/i.test(held.lastError) ? "quota" : "failing"));
    // MASKED, NEVER WHOLE. Enough to tell one row from another and to match a
    // row against the key in somebody's password manager; not enough to use.
    // This is the same trade every key-holding product makes, and it is what
    // lets the settings page list keys individually at all — the alternative
    // was one opaque box in which the only way to replace the third key was to
    // retype all four.
    return { position: at + 1, masked: maskSupadataKey(key), state, ...held };
  });
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
  if (!response.ok) {
    // THE STATUS RIDES ON THE ERROR. The rotation above has to tell a key
    // that is out of quota (402, 429) from a video Supadata cannot serve to
    // ANY key (400, 404): the first is worth another key and the second is
    // worth stopping, and a message string is not something to branch on.
    const spent = new Error(`supadata: HTTP ${response.status}`);
    spent.status = response.status;
    throw spent;
  }
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
 * @param options - `{ apiKey, gensBase, languages }`. `apiKey` may hold
 *   several keys separated by newlines, commas or spaces; they are tried in
 *   turn, starting one further along the list on each call.
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
  // EVERY KEY, STARTING WHERE THE LAST CALL LEFT OFF. See `supadataKeys`
  // and `supadataCursor`: the quota is the sum of the keys, so a key that
  // answers 429 costs this video one wasted request and nothing more.
  const keys = supadataKeys(apiKey);
  if (keys.length === 0) {
    failures.push("supadata: no API key configured (Settings → Sources)");
  } else {
    // ── EVERY KEY WAS BEING BURNED ON EVERY VIDEO ─────────────────────
    //
    // MEASURED, AFTER IT HAPPENED: five keys, 54 calls, 0 successes, 51 of them
    // 429. The loop below breaks on 400 and 404 — "a video Supadata will not
    // serve is not a key problem" — and does NOT break on 429, so a video whose
    // free routes failed walked the whole list and spent one request per key to
    // be refused five times. At twelve videos a pass that is sixty wasted calls
    // an hour, for ever, and a drain of sixty videos is three hundred in one
    // round. It emptied every key.
    //
    // Continuing past a 429 is right when ONE key is spent and the others are
    // not — that is the entire reason for holding several. It is wrong when the
    // key was already known to be spent, and nothing remembered.
    //
    // So a refused key is skipped for a cooldown, and when every key is inside
    // one the request is not made at all: there is nothing left to ask.
    // THE CEILING IS CHECKED BEFORE THE KEYS ARE, because a key that has quota
    // is not permission to spend without limit — that was the assumption that
    // emptied five of them.
    if (paidCalls >= PAID_CALL_CEILING) {
      failures.push(`supadata: ${paidCalls} paid requests made since this host started, at the ceiling of ${PAID_CALL_CEILING}; not spending more without a reset`);
      throw new Error(failures.join("; "));
    }
    const usable = keys.filter((key) => !isExhausted(key));
    if (usable.length === 0) {
      failures.push(`supadata: all ${keys.length} key(s) are out of quota; not asking again until the cooldown expires`);
      throw new Error(failures.join("; "));
    }
    const start = supadataCursor % usable.length;
    supadataCursor = (start + 1) % usable.length;
    for (let step = 0; step < usable.length; step += 1) {
      const at = (start + step) % usable.length;
      try {
        // COUNTED BEFORE THE AWAIT, not after. A request that throws still
        // reached the provider and still counted against a quota; counting on
        // success would meter only the calls that were worth making.
        paidCalls += 1;
        const got = { ...await fetchViaSupadata(videoId, usable[at], languages[0] ?? "en"), via: "supadata" };
        noteSupadataKey(usable[at], "ok");
        return got;
      } catch (cause) {
        // Recorded before the message is folded into `failures`, so the tally
        // sees the individual answer rather than the joined string every route
        // above it also contributed to.
        noteSupadataKey(
          usable[at],
          /quota|429|rate.?limit|too many requests/i.test(String(cause?.message ?? cause)) ? "quota" : "failed",
          String(cause?.message ?? cause),
        );
        // WHICH key failed, by position. The keys themselves must not reach
        // a log or an error body — this string is handed to the browser —
        // and "key 3 of 4" is what a person needs to know which one to
        // replace without it ever being printed.
        failures.push(`supadata key ${keys.indexOf(usable[at]) + 1}/${keys.length}: ${String(cause?.message ?? cause)}`);
        // A VIDEO SUPADATA WILL NOT SERVE IS NOT A KEY PROBLEM. 400 and 404
        // are the same answer from every key in the list, so trying the
        // other three spends three requests to be told the same thing.
        if (cause?.status === 400 || cause?.status === 404) break;
        // A 429 DOES NOT BREAK, and an existing test says why: holding several
        // keys is pointless if one refusal ends the attempt — the next key may
        // genuinely have quota, and finding that out is the whole reason the
        // list exists.
        //
        // The multiplication is fixed one layer up instead. The refused key is
        // now in a cooldown, so the FIRST video walks the list and learns which
        // keys are spent, and every video after it skips them and makes no call
        // at all. Five wasted requests once, rather than five per video for
        // ever — which is what emptied the quota.
      }
    }
  }
  throw new Error(failures.join("; "));
}

/** Fields the watch page exposes inside `ytInitialPlayerResponse`. */
const DETAIL_KEYS = ["shortDescription", "lengthSeconds", "author", "viewCount", "publishDate"];

/**
 * Read one JSON string field out of a page's embedded script data.
 *
 * Scanned character by character rather than matched with a regular
 * expression. The pattern needed to respect JSON escaping carries four
 * backslashes, and every layer between here and the file — shell, heredoc,
 * tool encoding — has eaten one at some point; the last attempt shipped
 * `[^"\]` and the panel rendered `Unterminated character class` where the
 * description should have been. A scanner has nothing to escape.
 * @param source - the document text.
 * @param key - the field name.
 * @returns the decoded string, or undefined when the field is absent.
 */
export function readJsonStringField(source, key) {
  const marker = `"${key}":"`;
  const start = source.indexOf(marker);
  if (start === -1) return undefined;
  const from = start + marker.length;
  let at = from;
  while (at < source.length) {
    const character = source[at];
    // A backslash escapes whatever follows it, including a quote.
    if (character === "\\") {
      at += 2;
      continue;
    }
    if (character === '"') break;
    at += 1;
  }
  if (at >= source.length) return undefined;
  try {
    // Re-quoting the raw slice lets JSON decode the escapes it already carries.
    return JSON.parse(`"${source.slice(from, at)}"`);
  } catch {
    return undefined;
  }
}

/**
 * Read a video's own description and metadata from its watch page.
 *
 * The page is already fetched for caption tracks, and it carries the
 * description the uploader wrote — which a `Resource` row from a feed does not
 * have, leaving both the card and the assistant with nothing but a title.
 * @param videoId - the video id.
 * @returns `{ description, lengthSeconds, author, viewCount, publishDate }`.
 */
export async function fetchVideoDetails(videoId) {
  const page = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: PAGE_HEADERS });
  if (!page.ok) throw new Error(`watch page: HTTP ${page.status}`);
  const html = await page.text();
  const found = {};
  for (const key of DETAIL_KEYS) {
    const value = readJsonStringField(html, key);
    if (value !== undefined) found[key] = value;
  }
  if (found.shortDescription === undefined) throw new Error("the watch page carries no description");
  return {
    description: found.shortDescription,
    lengthSeconds: Number(found.lengthSeconds ?? 0),
    author: found.author ?? "",
    viewCount: Number(found.viewCount ?? 0),
    publishDate: found.publishDate ?? "",
  };
}
