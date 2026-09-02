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
 * When this HOST was last rate-limited, and how long it then stands down.
 *
 * 429 IS ABOUT THE CALLER, NOT ABOUT THE KEY, and modelling it per-key was the
 * mistake that burned six of them.
 *
 * The evidence is unambiguous and it took a person adding keys one at a time to
 * produce it: a brand-new key, on its second call, answered HTTP 429. A key
 * that has never been used cannot be out of quota. What was being refused was
 * this machine — Too Many Requests is a statement about the rate of the
 * requester, and every key in the list travels from the same IP.
 *
 * So "a spent key yields to the next" — which the code did, which an existing
 * test pins, and which the module's own comment argues for — is right for
 * running out of CREDIT and exactly backwards for being rate-limited: trying
 * the next key is one more request from the address that was just told to slow
 * down. Six keys turned one refusal into six.
 *
 * A 429 now stands the whole client down. Not the key: the client.
 *
 * TWENTY MINUTES, not six hours. A rate limit is a speed complaint and clears
 * on its own; a credit exhaustion is a billing fact and does not. Treating the
 * first like the second would idle a working account for a quarter of a day.
 */
const RATE_LIMIT_BACKOFF_MS = 20 * 60 * 1000;
/**
 * How long to stand down after a rate limit, escalating.
 *
 * A FLAT TWENTY MINUTES TURNED ONE REFUSAL INTO A BLIND DRAIN. Measured: a
 * classification run over ninety-six videos made THREE paid requests. The
 * second took a 429, the provider was parked for twenty minutes, and the
 * remaining ninety-three were attempted with the paid route standing down —
 * so their answers were "we did not ask" rather than anything about the video,
 * and the run learned three facts instead of ninety-six.
 *
 * The first refusal is usually a burst that a minute cures. Twenty minutes is
 * the right answer to the FOURTH one, not the first. Escalating spends a
 * minute finding out which kind this is, and a success puts it back to the
 * start — so a provider that is merely busy is not treated as one that is out.
 */
const BACKOFF_LADDER_MS = [60 * 1000, 5 * 60 * 1000, RATE_LIMIT_BACKOFF_MS];
let rateLimitedAt = 0;
let backoffStep = 0;

/** Whether a 402/403 means this key is out of credit, as opposed to too fast. */
function isCreditExhausted(cause) {
  const status = Number(cause?.status);
  if (status === 402 || status === 403) return true;
  return /out of credit|insufficient|quota exceeded|limit exceeded/i.test(String(cause?.message ?? cause ?? ""));
}

/** Whether an answer is the provider telling this client to slow down. */
function isRateLimited(cause) {
  if (Number(cause?.status) === 429) return true;
  return /\b429\b|too many requests|rate.?limit/i.test(String(cause?.message ?? cause ?? ""));
}

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

/**
 * Minutes of video bought since this host started, and the ceiling on them.
 *
 * THE UNIT THAT ACTUALLY BILLS, and the third one I have had to correct. The
 * budget counted VIDEOS, so sixty videos became three hundred requests. Then it
 * counted REQUESTS, so ten requests became two hundred and fifty credits —
 * measured by the person paying, watching the number drop by 250 inside a
 * second while my meter read "10".
 *
 * Ten requests for 250 credits is 25 each, and 25 is the length of a podcast
 * episode in minutes. A transcript is priced by how much of it there is, which
 * is obvious in hindsight and was never once checked: every ceiling I wrote
 * bounded the number of times we asked, and none of them bounded how much we
 * were asking for.
 *
 * PER-VIDEO AND IN TOTAL. A three-hour recording is three times an hour-long
 * one and there is no request count at which that stops being true, so the
 * per-video cap is the one that prevents a single fetch from being the whole
 * budget.
 */
const PAID_MINUTE_CEILING = 600;
// FIVE HOURS, matching the collector's own ceiling rather than a second number
// invented here. Two limits on the same quantity are two limits that disagree
// the first time either moves — which this batch has already paid for once,
// with a default written down twice.
const PAID_MINUTES_PER_VIDEO = 5 * 60;
/**
 * What an unknown length is RESERVED at, before the real one is known.
 *
 * IT IS NOT THE PER-VIDEO CAP, and using the cap here is what made the budget
 * unusable. The library stores a duration only for videos whose feed carried
 * one, so most of the untranscribed backlog has none — and pricing every one of
 * them at five hours meant two requests consumed a ten-hour ceiling and the
 * remaining ninety-six could never be bought at all. A budget that blocks the
 * work it was sized for is not a safe budget, it is a broken one.
 *
 * An hour is roughly what these recordings run to. It is a RESERVATION, not a
 * charge: the moment the transcript is in hand its true length is known, and
 * {@link settleMinutes} replaces the estimate with it. Reserve high enough to
 * be safe, settle at what was actually spent.
 */
const UNKNOWN_MINUTES = 60;
let paidMinutes = 0;

/**
 * The least time between two paid requests from this host.
 *
 * "难道不应该一个一个来吗" — and it already was, one `await` after another in a
 * single loop. Sequential is not the same as paced: with no gap, a backlog of
 * ninety-eight videos leaves as fast as the socket allows, and the provider's
 * limit is per MINUTE. Measured: a brand-new key answered 429 on the second
 * request, seconds after the first.
 *
 * SIX SECONDS IS TEN A MINUTE, comfortably under any published limit, and it
 * puts a hundred-video drain at ten minutes — which is the right trade when the
 * alternative has been, four separate times, an emptied quota.
 *
 * IT BELONGS HERE, NOT IN THE DRAIN LOOP. Three callers reach the provider —
 * the scheduled top-up, the manual drain, and a reader opening a video — and a
 * gap enforced in one of them is a gap the other two walk straight past.
 */
const PAID_CALL_GAP_MS = 6_000;
let paidCallGapMs = PAID_CALL_GAP_MS;
let lastPaidCallAt = 0;

/**
 * Change the gap between paid requests.
 *
 * A KNOB RATHER THAN A CONSTANT, for two reasons and only one of them is
 * testing. A drain of a hundred videos at six seconds each takes ten minutes,
 * and somebody sitting in front of it who knows their plan's limit should be
 * able to say so instead of waiting out a number chosen for safety. The suite
 * sets it to 0, because a test that sleeps through the real gap is a test that
 * times out — which this one did, at two minutes, on its first run.
 * @param ms - the gap in milliseconds; negative values are treated as 0.
 * @returns the gap now in force.
 */
export function setSupadataPacing(ms) {
  const asked = Number(ms);
  paidCallGapMs = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0;
  return paidCallGapMs;
}

/**
 * How long to wait before the next paid request may go out.
 *
 * Separated from the waiting so it can be asserted without a test sleeping
 * through it.
 * @param now - the current epoch milliseconds.
 * @returns milliseconds to wait; 0 when the gap has already passed.
 */
export function supadataPacingWait(now = Date.now()) {
  if (lastPaidCallAt === 0 || paidCallGapMs === 0) return 0;
  return Math.max(0, paidCallGapMs - (now - lastPaidCallAt));
}

/**
 * Replace a reservation with what the fetch actually cost.
 *
 * The provider bills the length of the recording, and the transcript says what
 * that is — the last cue's end. Leaving the estimate in place would have the
 * budget drift away from the bill in whichever direction the guess was wrong,
 * and a ceiling measured in a made-up unit stops bounding anything real.
 * @param reserved - the minutes taken before the request.
 * @param got - the transcript, whose cues carry the true length.
 */
function settleMinutes(reserved, got) {
  // `{ start, duration }`, BOTH IN SECONDS — the shape every fetcher in this
  // file normalises to, not the provider's own `{ offset, duration }` in
  // milliseconds. Reading the raw shape here settled a twelve-minute recording
  // at one minute, because `offset` is absent after normalisation and the sum
  // collapsed to the last cue's own length.
  const cues = Array.isArray(got?.cues) ? got.cues : [];
  const seconds = cues.reduce((latest, cue) => {
    const end = Number(cue?.start ?? 0) + Number(cue?.duration ?? 0);
    return Number.isFinite(end) && end > latest ? end : latest;
  }, 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const truly = Math.ceil(seconds / 60);
  paidMinutes = Math.max(0, paidMinutes - reserved + truly);
}

/** How many paid requests have been made, and what is left. */
export function supadataSpend() {
  return {
    calls: paidCalls,
    ceiling: PAID_CALL_CEILING,
    remaining: Math.max(0, PAID_CALL_CEILING - paidCalls),
    // THE ONE THAT MATTERS. Requests are what this program does; minutes are
    // what the provider charges for, and until now only the first was visible.
    minutes: paidMinutes,
    minuteCeiling: PAID_MINUTE_CEILING,
    minutesRemaining: Math.max(0, PAID_MINUTE_CEILING - paidMinutes),
    perVideoMinutes: PAID_MINUTES_PER_VIDEO,
  };
}

/** Forget the spend, for a host that has been given fresh quota. */
export function resetSupadataSpend() {
  lastPaidCallAt = 0;
  rateLimitedAt = 0;
  backoffStep = 0;
  const spent = { calls: paidCalls, minutes: paidMinutes };
  paidCalls = 0;
  paidMinutes = 0;
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
  // THE CLIENT BACKOFF GOES WITH THEM. It is the third piece of state that
  // stops a request, and leaving it behind makes the reset button work only
  // two thirds of the way — a person who has just sorted out their rate limit
  // would clear the key cooldowns, press the button, and still be stood down.
  //
  // It is also what made six tests fail as a group: one test triggering a 429
  // stood the whole module down for twenty minutes, so every test after it was
  // asserting against a client that had already given up. A suite reporting
  // the order it ran in, again.
  rateLimitedAt = 0;
  return held;
}

/** Whether a key is inside its cooldown after a quota refusal. */
function isExhausted(key, now = Date.now()) {
  const held = supadataHealth.get(key);
  if (held === undefined || held.exhaustedAt === 0) return false;
  return now - held.exhaustedAt < QUOTA_COOLDOWN_MS;
}

function noteSupadataKey(key, outcome, error = "") {
  const held = supadataHealth.get(key) ?? { calls: 0, ok: 0, quota: 0, limited: 0, failed: 0, lastError: "", lastAt: "", exhaustedAt: 0 };
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
    const held = supadataHealth.get(key) ?? { calls: 0, ok: 0, quota: 0, limited: 0, failed: 0, lastError: "", lastAt: "", exhaustedAt: 0 };
    // The state is the LAST thing that happened, not a ratio: a key that served
    // a thousand transcripts and is now out of quota is out of quota, and an
    // average would report it as healthy for a long time.
    // THREE STATES, NOT TWO, AND THE THIRD IS NOT THIS KEY'S FAULT.
    //
    // "limited" is the provider telling THIS MACHINE to slow down, and it was
    // being reported as 配额用尽 on the key that happened to be next in the
    // rotation. A person watching that added a key, watched it turn red on its
    // second call, and added another — six times. Nothing was wrong with any of
    // them.
    //
    // The state is the LAST thing that happened, so a key rate-limited a moment
    // ago and one genuinely out of credit are told apart at a glance.
    const state = held.calls === 0
      ? "untried"
      : (held.lastError === "" ? "ok"
        : (held.limited > 0 && isRateLimited({ message: held.lastError }) ? "limited"
          : (held.quota > 0 ? "quota" : "failing")));

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
  const html = await page.text();
  const tracks = captionTracksOf(html);
  if (tracks.length === 0) {
    // WHICH KIND OF NOTHING THIS IS, and getting it wrong retires a video for
    // ever on the strength of a page we were never shown.
    //
    // No track table can mean the video publishes no captions, OR that YouTube
    // handed this caller a consent wall, a bot check, or any other page without
    // a player response in it. The two are indistinguishable by track count and
    // the message said the first one outright — so a Host that YouTube throttles
    // reported a fact about the VIDEO when the only fact available was about
    // ITSELF.
    //
    // MEASURED, and this is not hypothetical: from this Host the timedtext
    // endpoint answers 200 with an empty body, and video zIwwkuB2NPQ was
    // reported as publishing no captions while yt-dlp on another machine
    // fetched its English track the same minute. That verdict had already been
    // written into the library as a permanent absence.
    //
    // A player response with no captionTracks in it is the real answer. Anything
    // else is a page we should not be drawing conclusions from.
    const sawPlayer = /"streamingData"|"videoDetails"|ytInitialPlayerResponse/.test(html);
    throw new Error(sawPlayer
      ? "this video publishes no caption track"
      : "the watch page carried no player response, so this caller was served something other than the video");
  }
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
/**
 * Whether a local yt-dlp can be used, decided once.
 *
 * A YES IS FOREVER; A NO IS RECHECKED. Present cannot become absent without
 * somebody uninstalling it, so a true answer is kept for the life of the
 * process and no video pays for a second probe.
 *
 * A false answer is different, and caching it was a trap I set and then walked
 * into: the host reported `ytDlp: false`, the fix is to install it, and the
 * status would have gone on saying false until the process restarted — so the
 * one action the reader was told to take would have looked like it did nothing.
 * Ten minutes is long enough that a library of videos costs one probe, and short
 * enough that installing it takes effect while somebody is still watching.
 */
let ytDlpUsable;
let ytDlpProbedAt = 0;
const YTDLP_RECHECK_MS = 10 * 60 * 1000;

/**
 * Set the probe's answer without probing.
 *
 * A TEST SEAM, and it earns its keep the same way `setSupadataPacing` does: the
 * suite runs on a machine where yt-dlp IS installed, so without this every test
 * that resolves a transcript spawns it and waits out a real network fetch. The
 * first run after this route was added did exactly that and was killed at two
 * minutes having finished nothing.
 * @param usable - true to force the route on, false off, undefined to probe again.
 */
export function setYtDlp(usable) {
  ytDlpUsable = usable === undefined ? undefined : usable === true;
  // Far enough in the future that a forced `false` is not re-probed mid-test.
  ytDlpProbedAt = Date.now();
}

/** Reset the cached probe. For tests, which install and uninstall it. */
export function forgetYtDlp() {
  ytDlpUsable = undefined;
}

/**
 * Is yt-dlp on this host's PATH?
 * @returns true when it answers `--version`.
 */
export async function hasYtDlp() {
  if (ytDlpUsable === true) return true;
  if (ytDlpUsable === false && Date.now() - ytDlpProbedAt < YTDLP_RECHECK_MS) return false;
  try {
    const { spawn } = await import("node:child_process");
    ytDlpUsable = await new Promise((settle) => {
      // NO SHELL, EVER, on any path that touches a video id. `spawn` with an
      // argument array cannot be talked into running a second command by a
      // string that looks like one.
      const probe = spawn("yt-dlp", ["--version"], { shell: false, stdio: "ignore" });
      const giveUp = setTimeout(() => { probe.kill(); settle(false); }, 10_000);
      probe.on("error", () => { clearTimeout(giveUp); settle(false); });
      probe.on("close", (code) => { clearTimeout(giveUp); settle(code === 0); });
    });
  } catch {
    ytDlpUsable = false;
  }
  ytDlpProbedAt = Date.now();
  return ytDlpUsable;
}

/**
 * Fetch captions with a local yt-dlp.
 *
 * WHY THIS EXISTS. YouTube applies its block to the CALLER'S PATH, not to the
 * method — the note on the gens route says so and this host proves it: from
 * here the timedtext endpoint answers 200 with an empty body, while the same
 * walk from a machine YouTube does not throttle returns the captions. Measured
 * on this library: 542 of 574 videos were fetched that way, in one afternoon,
 * for nothing, after every built-in route had reported them unavailable.
 *
 * yt-dlp carries the player negotiation this module cannot, so where it is
 * installed the library can fill itself in rather than depending on somebody
 * running a script by hand. Where it is not, nothing changes: the probe fails
 * once and this route is skipped for the life of the process.
 *
 * THE VIDEO ID IS VALIDATED BEFORE IT BECOMES AN ARGUMENT. It is eleven
 * characters of a known alphabet or this throws — an id is not a place to find
 * out whether `spawn` without a shell is really safe.
 * @param videoId - the eleven-character video id.
 * @param languages - preference order.
 * @returns `{ language, text, cues }`.
 */
export async function fetchViaYtDlp(videoId, languages = DEFAULT_LANGUAGES) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId))) throw new Error("not a video id");
  if (!await hasYtDlp()) throw new Error("yt-dlp is not installed on this host");
  const { spawn } = await import("node:child_process");
  const { mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const work = await mkdtemp(join(tmpdir(), "swm-subs-"));
  try {
    // ONE LANGUAGE FAMILY PER RUN. Asking for three in a row took a 429 on the
    // third within a single video: the limit counts requests, not languages.
    for (const language of [...new Set(languages.map((one) => String(one).split("-")[0]))]) {
      const ran = await new Promise((settle) => {
        const child = spawn("yt-dlp", [
          "--skip-download", "--write-auto-subs", "--write-subs",
          "--sub-langs", `${language}.*,${language}`,
          "--sub-format", "srv1", "--no-warnings", "--quiet",
          "-o", join(work, "%(id)s.%(ext)s"),
          `https://www.youtube.com/watch?v=${videoId}`,
        ], { shell: false, stdio: "ignore" });
        const giveUp = setTimeout(() => { child.kill(); settle(false); }, 120_000);
        child.on("error", () => { clearTimeout(giveUp); settle(false); });
        child.on("close", () => { clearTimeout(giveUp); settle(true); });
      });
      if (!ran) continue;
      const written = (await readdir(work)).filter((name) => name.endsWith(".srv1"));
      if (written.length === 0) continue;
      const xml = await readFile(join(work, written[0]), "utf8");
      const stamped = written[0].replace(`${videoId}.`, "").replace(".srv1", "");
      return transcriptFromXml(xml, stamped === "" ? language : stamped);
    }
    throw new Error("yt-dlp found no caption track in any requested language");
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function resolveTranscript(videoId, { apiKey, gensBase, languages = DEFAULT_LANGUAGES, durationSeconds } = {}) {
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
  // AHEAD OF EVERYTHING PAID, because it costs nothing and is the only route
  // that actually works from a host YouTube throttles. Behind the pure-HTTP
  // ones because it spawns a process, which is a bigger thing to do than a
  // fetch and should not be the first thing tried.
  try {
    return { ...await fetchViaYtDlp(videoId, languages), via: "yt-dlp" };
  } catch (cause) {
    failures.push(`yt-dlp: ${String(cause?.message ?? cause)}`);
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
    // THE CLIENT-WIDE BACKOFF IS CHECKED FIRST, ahead of the ceiling and ahead
    // of any key, because it is the only one of the three that is about this
    // machine rather than about an account. While it holds there is nothing to
    // try: every key would travel from the same address that was just refused.
    const cooling = Date.now() - rateLimitedAt;
    // ONE REFUSAL IS THE FIRST RUNG, NOT THE SECOND. `backoffStep` counts
    // refusals, so the wait after the Nth is the Nth rung — index N-1. Reading
    // it as index N skipped 60s entirely and made a single 429 cost five
    // minutes, which is the flat twenty this ladder replaced, only smaller.
    const backoff = BACKOFF_LADDER_MS[Math.min(Math.max(0, backoffStep - 1), BACKOFF_LADDER_MS.length - 1)];
    if (rateLimitedAt !== 0 && cooling < backoff) {
      failures.push(`supadata: rate limited ${Math.round(cooling / 1000)}s ago; standing down for ${Math.round(backoff / 1000)}s`);
      throw new Error(failures.join("; "));
    }

    // ── WHAT THIS ONE VIDEO WILL COST, BEFORE ASKING FOR IT ────────────
    //
    // The provider charges for the length of the transcript, so the price of a
    // request is known before it is made — the library already stores every
    // video's duration, fetched for the length floor and until now used for
    // nothing else. A cost that can be computed and is not is a cost nobody
    // can refuse.
    //
    // UNKNOWN LENGTH IS PRICED AS THE PER-VIDEO CAP, not as free. "We do not
    // know how long this is" is not a reason to buy it blind, and pricing the
    // unknown at zero is precisely how a budget stops bounding anything.
    const known = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0;
    const minutes = known ? Math.ceil(Number(durationSeconds) / 60) : UNKNOWN_MINUTES;
    // ONLY A KNOWN LENGTH CAN BE REFUSED FOR BEING TOO LONG. An unknown one is
    // reserved at an estimate, and refusing on an estimate would decline videos
    // for a length nobody has measured.
    if (known && minutes > PAID_MINUTES_PER_VIDEO) {
      failures.push(`supadata: this video is ${minutes} minutes, over the ${PAID_MINUTES_PER_VIDEO}-minute per-video cap`);
      throw new Error(failures.join("; "));
    }
    if (paidMinutes + minutes > PAID_MINUTE_CEILING) {
      failures.push(`supadata: ${paidMinutes} minute(s) bought since this host started; ${minutes} more would pass the ceiling of ${PAID_MINUTE_CEILING}`);
      throw new Error(failures.join("; "));
    }

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
        // PACED BEFORE THE REQUEST, NOT AFTER THE REFUSAL. Backing off once a
        // 429 has arrived is repair; spacing the requests is prevention, and
        // this provider's limit is per minute.
        const wait = supadataPacingWait();
        if (wait > 0) await new Promise((wake) => setTimeout(wake, wait));
        lastPaidCallAt = Date.now();
        // COUNTED BEFORE THE AWAIT, not after. A request that throws still
        // reached the provider and still counted against a quota; counting on
        // success would meter only the calls that were worth making.
        paidCalls += 1;
        // Counted with the call and before the await, for the same reason: a
        // refused request still asked the provider for that many minutes.
        paidMinutes += minutes;
        const got = { ...await fetchViaSupadata(videoId, usable[at], languages[0] ?? "en"), via: "supadata" };
        noteSupadataKey(usable[at], "ok");
        // A request that got through says the burst is over.
        rateLimitedAt = 0;
        backoffStep = 0;
        // The reservation was a guess; the transcript is the fact.
        settleMinutes(minutes, got);
        return got;
      } catch (cause) {
        // THE RESERVATION GOES BACK, because a refused request delivers no
        // transcript and bills for none. Minutes are charged for CONTENT, and a
        // 429, a spent-credit 402, a 404 and an empty answer all hand back
        // nothing at all.
        //
        // MEASURED: five requests, every one of them refused with 429, consumed
        // THREE HUNDRED of the six-hundred-minute ceiling — half the budget
        // spent on requests that bought nothing. Left alone this ends as the
        // per-video cap did, with the budget blocking the work it exists to
        // permit, and it would have looked like real spending in the tab.
        //
        // THE CALL COUNT STAYS. That request did reach the provider and does
        // count against a per-request allowance; it is the MINUTES that were
        // never sold. The two ceilings measure different things, which is why
        // there are two of them.
        paidMinutes = Math.max(0, paidMinutes - minutes);
        // Recorded before the message is folded into `failures`, so the tally
        // sees the individual answer rather than the joined string every route
        // above it also contributed to.
        // THREE DIFFERENT ANSWERS, AND THEY WERE ALL ONE. "quota" used to mean
        // any of 429, "rate limit" or "quota exceeded", so a speed complaint
        // about this machine was recorded as a fact about a key — and a fresh
        // key inherited the label the moment it was tried.
        const limited = isRateLimited(cause);
        noteSupadataKey(
          usable[at],
          limited ? "limited" : (isCreditExhausted(cause) ? "quota" : "failed"),
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
        // A RATE LIMIT ENDS EVERYTHING, not just this key's turn. Trying the
        // next one is one more request from the address that was just told to
        // slow down — which is how six keys turned a single refusal into six.
        if (limited) {
          rateLimitedAt = Date.now();
          // Each refusal moves one rung up; a success below moves it back to
          // the bottom. Without the reset the ladder only ever climbs, and a
          // provider that was busy once at breakfast is treated as spent for
          // the rest of the day.
          backoffStep = Math.min(backoffStep + 1, BACKOFF_LADDER_MS.length - 1);
          break;
        }
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
