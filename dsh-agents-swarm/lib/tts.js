/**
 * Text to speech for the 发布 tab: turning a two-host script into audio.
 *
 * The obvious route was a cloud speech API — Azure, ElevenLabs, OpenAI — and it
 * was rejected because every one of them wants a key. This plugin's whole
 * premise is a library that runs on the user's own machine against sources they
 * already have; asking for a paid credential before the first episode can be
 * heard puts a wall where there should be a button.
 *
 * `msedge-tts` speaks the same protocol Microsoft Edge's Read Aloud uses: a
 * WebSocket to a Bing endpoint, authenticated with the trusted client token the
 * browser itself ships. No key, no quota to sign up for, and the voices are the
 * ordinary Azure neural ones — including eight zh-CN voices, which matters
 * because most of this library is read in Chinese. The cost of the choice is
 * honest and worth naming: it is an undocumented consumer endpoint, so it can
 * change or refuse service, and it is shared. Everything below is written to be
 * a polite client of it — one utterance at a time, one connection per
 * utterance, closed when done.
 *
 * The backend is behind {@link TTS_BACKENDS} rather than being assumed, because
 * the next one is already foreseeable (a local Kokoro model, for people who
 * want no network at all) and callers should not have to change when it lands.
 */

/** Bitrate and sample rate every segment is encoded at. */
const OUTPUT_FORMAT_ID = "audio-24khz-48kbitrate-mono-mp3";

/**
 * How long one utterance may take, end to end, before it is abandoned.
 *
 * The library has no timeout of its own, in either of the two places one is
 * needed. If the service accepts the request and then never sends its turn-end
 * message, the read of the audio stream waits forever; and `setMetadata` opens
 * the WebSocket without passing `ws` a `handshakeTimeout`, so a connection that
 * is accepted and then never upgraded waits on the OS rather than on us. Either
 * way a whole episode stalls on one turn with nothing in the log. The budget
 * below is one deadline spanning both phases, not one per phase. A turn is a
 * few sentences and normally completes in under a second.
 */
const UTTERANCE_TIMEOUT_MS = 60_000;

/** Pause before the single retry, so a momentary refusal has time to pass. */
const RETRY_DELAY_MS = 800;

/**
 * The voices offered in the publish form.
 *
 * A deliberately curated list, not the ~320 in 142 locales the endpoint will
 * actually speak.
 * `getVoices()` returns every Azure neural voice in every locale, which is a
 * scrolling wall nobody can choose from; these are the ones worth putting in
 * front of someone picking two podcast hosts. `synthesize` does not restrict
 * itself to this list, so a caller that knows a voice id can still pass it.
 *
 * `style` records what Microsoft says each voice was tuned for — the news
 * voices read a summary straight, the novel voices carry a conversation, and
 * the two dialect voices are there because a Northeastern or Shaanxi host is a
 * genuinely different episode rather than a novelty.
 */
export const VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 女声 · 新闻/小说", lang: "zh-CN", gender: "female", style: "news, novel" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊 · 女声 · 动画/小说", lang: "zh-CN", gender: "female", style: "cartoon, novel" },
  { id: "zh-CN-YunjianNeural", label: "云健 · 男声 · 体育/小说", lang: "zh-CN", gender: "male", style: "sports, novel" },
  { id: "zh-CN-YunxiNeural", label: "云希 · 男声 · 小说", lang: "zh-CN", gender: "male", style: "novel" },
  { id: "zh-CN-YunxiaNeural", label: "云夏 · 男声 · 动画/小说", lang: "zh-CN", gender: "male", style: "cartoon, novel" },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 男声 · 新闻", lang: "zh-CN", gender: "male", style: "news" },
  { id: "zh-CN-liaoning-XiaobeiNeural", label: "辽宁小北 · 女声 · 东北方言", lang: "zh-CN", gender: "female", style: "dialect" },
  { id: "zh-CN-shaanxi-XiaoniNeural", label: "陕西晓妮 · 女声 · 陕西方言", lang: "zh-CN", gender: "female", style: "dialect" },
  { id: "en-US-AriaNeural", label: "Aria · Female · News", lang: "en-US", gender: "female", style: "news" },
  { id: "en-US-JennyNeural", label: "Jenny · Female · Conversational", lang: "en-US", gender: "female", style: "conversational" },
  { id: "en-US-GuyNeural", label: "Guy · Male · News", lang: "en-US", gender: "male", style: "news" },
  { id: "en-US-ChristopherNeural", label: "Christopher · Male · Conversational", lang: "en-US", gender: "male", style: "conversational" },
];

/**
 * The two hosts a new episode starts with.
 *
 * A female and a male zh-CN voice, because the point of two hosts is that a
 * listener can tell without effort who is speaking, and pitch does that more
 * reliably than timbre. 晓晓 and 云希 are the pair Microsoft's own samples use
 * for dialogue, and both are tuned for narration rather than headlines.
 */
export const DEFAULT_HOSTS = { a: "zh-CN-XiaoxiaoNeural", b: "zh-CN-YunxiNeural" };

/**
 * The speech backends a caller may choose between.
 *
 * One entry today, and the list exists anyway: a local Kokoro backend is the
 * planned second, and the difference that matters to a user — whether audio
 * leaves the machine, and whether it needs a model download — has to be
 * something the UI can read off the backend rather than something hard-coded
 * beside a single hard-coded backend. Shipping the array now means adding
 * Kokoro is a push to this list plus a branch in `synthesize`, and no change to
 * the form, the endpoint, or any caller.
 */
export const TTS_BACKENDS = [
  {
    id: "edge",
    label: "Edge (免费，无需 Key)",
    local: false,
    note: {
      zh: "使用 Microsoft Edge 朗读服务合成，免费且无需密钥；文本会发送到微软服务器，语音逐句串行生成。",
      en: "Synthesised through the Microsoft Edge read-aloud service: free, no key required. Text is sent to Microsoft's servers, and utterances are generated one at a time.",
    },
  },
];

/**
 * Escape the five XML characters so text cannot break the SSML around it.
 *
 * The library builds its request by interpolating the input straight into an
 * SSML template, with no escaping anywhere on the path. A perfectly ordinary
 * script line — "AT&T 的研究" or "a < b" — therefore produces malformed XML,
 * and the endpoint answers by closing the turn with no audio at all rather than
 * by complaining, so the failure arrives as an empty buffer with no cause
 * attached.
 *
 * The trade-off: a caller cannot smuggle real SSML (a `<break>`, an
 * `<emphasis>`) through `text`, because it will be spoken as literal angle
 * brackets. That is the right way round — a script comes from a language model,
 * and markup it invented is far likelier than markup it meant.
 * @param text - a line of the script.
 * @returns the same line, safe to interpolate into SSML.
 */
function escapeSsmlText(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Reject if a promise has not settled within `ms`.
 *
 * `Promise.race` subscribes to `promise` immediately, so a rejection arriving
 * after the timeout already fired is consumed here rather than escaping as an
 * unhandled rejection.
 * @param promise - the work to bound.
 * @param ms - the remaining budget; treated as expired when not positive.
 * @param message - what to say when the budget runs out.
 */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(message)); }, Math.max(ms, 0));
    }),
  ]).finally(() => { clearTimeout(timer); });
}

/** Sleep, for the pause before a retry. */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Speak one piece of text in one voice.
 *
 * A fresh `MsEdgeTTS` instance and a fresh WebSocket per utterance. Reusing one
 * connection across a whole episode is faster and is what the library allows,
 * but it means a single dropped socket midway invalidates every turn after it;
 * per-utterance connections make a failure local to the turn that caused it,
 * which is what {@link synthesizeTurns} needs in order to retry just that turn.
 *
 * The connection is closed in a `finally`. Without it the socket stays open and
 * holds the event loop, so a script that synthesises and then finishes never
 * exits.
 * @param text - the line to speak. Plain text; XML characters are escaped, so
 *   SSML markup inside it is spoken rather than interpreted.
 * @param voice - a voice id such as `zh-CN-XiaoxiaoNeural`. Any id the endpoint
 *   accepts works; {@link VOICES} is a curated subset, not a constraint.
 * @param options - `{ rate, pitch, volume }`, each an SSML prosody value such
 *   as `"+10%"`, `"-2st"`, or a named level like `"slow"`. These are passed
 *   through to the prosody element, so they genuinely take effect.
 * @returns the MP3 bytes for this utterance.
 */
export async function synthesize(text, voice, options = {}) {
  const line = String(text ?? "").trim();
  if (line === "") throw new Error("nothing to synthesize: the text is empty");
  const voiceId = String(voice ?? "").trim();
  if (voiceId === "") throw new Error("no voice was chosen for this utterance");
  // The id is interpolated into an SSML attribute (`<voice name="...">`) by the
  // same unescaped template the text goes through, and it arrives from the
  // request body rather than from {@link VOICES}. Measured: malformed SSML makes
  // the endpoint drop the connection before turn.end, which surfaces as "the
  // audio is likely truncated" — a message pointing nowhere near the cause.
  if (/["'<>&]/.test(voiceId)) {
    throw new Error(`the voice id ${JSON.stringify(voiceId)} contains characters no voice name has`);
  }

  // Imported here rather than at module load: this file is pulled in by the
  // route table to expose VOICES and TTS_BACKENDS to the form, and that must
  // not cost a WebSocket client and an HTTP stack on every server start.
  let MsEdgeTTS;
  try {
    ({ MsEdgeTTS } = await import("msedge-tts"));
  } catch (cause) {
    throw new Error("the msedge-tts package is not installed, so speech cannot be synthesized", { cause });
  }

  const tts = new MsEdgeTTS();
  const deadline = Date.now() + UTTERANCE_TIMEOUT_MS;
  try {
    // Bounded: opening the socket is the half of an utterance with no timeout
    // anywhere beneath it. See {@link UTTERANCE_TIMEOUT_MS}.
    await withTimeout(
      tts.setMetadata(voiceId, OUTPUT_FORMAT_ID),
      deadline - Date.now(),
      `the speech service did not open a connection within ${UTTERANCE_TIMEOUT_MS / 1000}s`,
    );
    // Only the prosody values actually supplied are forwarded: the library
    // spreads what it is given over its own defaults, so an explicit
    // `undefined` overwrites the default and is stringified into the SSML
    // attribute as the word "undefined". Each value is escaped for the same
    // reason the text is — it lands in an attribute of a template that does no
    // escaping of its own, and a legitimate value ("+10%", "-2st", "slow")
    // contains none of the five characters, so escaping costs nothing.
    const prosody = {};
    if (options.rate !== undefined && options.rate !== "") prosody.rate = escapeSsmlText(options.rate);
    if (options.pitch !== undefined && options.pitch !== "") prosody.pitch = escapeSsmlText(options.pitch);
    if (options.volume !== undefined && options.volume !== "") prosody.volume = escapeSsmlText(options.volume);

    // Not awaited — `toStream` is synchronous despite the library's own doc
    // comment calling it a Promise.
    const { audioStream } = tts.toStream(escapeSsmlText(line), prosody);
    const buffer = await collectStream(audioStream, deadline - Date.now());
    // Belt and braces. Measured against msedge-tts 2.0.7, this branch does not
    // fire: a rejected voice id or malformed SSML makes the library destroy the
    // stream with "no turn.end received", so the failure arrives as a rejection
    // from `collectStream` instead. The check stays because the alternative to
    // a wrong assumption about an undocumented endpoint is handing back a
    // zero-length "MP3" that only fails later, in a player.
    if (buffer.byteLength === 0) {
      throw new Error(`the speech service returned no audio for voice ${voiceId}`);
    }
    return buffer;
  } finally {
    tts.close();
  }
}

/**
 * Read a readable stream to a Buffer, giving up when the budget runs out.
 * @param stream - the library's audio stream.
 * @param budgetMs - what is left of {@link UTTERANCE_TIMEOUT_MS} once the
 *   connection has been opened.
 * @returns the concatenated bytes.
 */
function collectStream(stream, budgetMs = UTTERANCE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`the speech service sent no end of turn within ${UTTERANCE_TIMEOUT_MS / 1000}s`));
    }, Math.max(budgetMs, 0));
    const settle = (finish) => (value) => { clearTimeout(timer); finish(value); };
    stream.on("data", (chunk) => { chunks.push(chunk); });
    stream.once("end", settle(() => { resolve(Buffer.concat(chunks)); }));
    stream.once("error", settle(reject));
  });
}

/** The part of a line that identifies it in an error, without filling the log. */
function turnExcerpt(text) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/**
 * Speak a whole two-host script, one turn at a time.
 *
 * Sequential on purpose. Synthesising twenty turns in parallel is twenty
 * simultaneous WebSockets to a free consumer endpoint from one address, which
 * is exactly the traffic shape that gets a client cut off — and being cut off
 * costs the whole episode, not just the turns that raced. Serial is slower and
 * it keeps working.
 *
 * Each turn gets one retry. A failure here is usually the socket, not the text:
 * a connection refused or dropped mid-turn succeeds on a second attempt, and
 * losing a finished twenty-turn episode to one flaky connection is the outcome
 * worth spending an extra request to avoid. When the retry also fails the error
 * names the turn — its index, its speaker, and its opening — because "TTS
 * failed" tells the person waiting nothing they can act on, while "turn 7 (b):
 * 那么这篇论文的核心贡献…" tells them which line to shorten or edit.
 * @param turns - `[{ speaker: 'a' | 'b', text }]` in playback order.
 * @param hosts - `{ a, b }` voice ids; defaults to {@link DEFAULT_HOSTS}.
 * @param onProgress - called as `(done, total)` after each finished turn, so a
 *   long episode can report progress instead of appearing hung.
 * @returns `{ segments, bytes }` — one MP3 buffer per turn, and their total size.
 */
export async function synthesizeTurns(turns, hosts = DEFAULT_HOSTS, onProgress) {
  const list = Array.isArray(turns) ? turns : [];
  if (list.length === 0) throw new Error("the script has no turns to speak");
  const voiceFor = { a: hosts?.a ?? DEFAULT_HOSTS.a, b: hosts?.b ?? DEFAULT_HOSTS.b };

  const segments = [];
  let bytes = 0;
  for (const [index, turn] of list.entries()) {
    // An unknown speaker label is host A rather than a hard failure: the script
    // is model-written, and one stray 'A' or 'host_a' should not cost the
    // episode when the intent is unambiguous. Comparing against the exact
    // string 'b' was worse than a hard failure would have been: 'B' and
    // 'host_b' both fell through to host A, so a script that labelled its hosts
    // in capitals was spoken end to end in one voice — two hosts, one voice,
    // nothing in the log. The label is folded to lower case and read from its
    // trailing a/b, which is the part every convention agrees on.
    const label = String(turn?.speaker ?? "").trim().toLowerCase();
    const speaker = label === "b" || /[^a-z]b$/.test(label) ? "b" : "a";
    const text = String(turn?.text ?? "").trim();
    if (text === "") {
      throw new Error(`turn ${index} (${speaker}) has no text to speak`);
    }
    let audio;
    try {
      audio = await synthesize(text, voiceFor[speaker], turn?.options ?? {});
    } catch (first) {
      await delay(RETRY_DELAY_MS);
      try {
        audio = await synthesize(text, voiceFor[speaker], turn?.options ?? {});
      } catch (second) {
        throw new Error(
          `turn ${index} (${speaker}) failed twice: "${turnExcerpt(text)}" — ${second.message}`,
          { cause: first },
        );
      }
    }
    segments.push(audio);
    bytes += audio.byteLength;
    if (typeof onProgress === "function") onProgress(segments.length, list.length);
  }
  return { segments, bytes };
}

/**
 * Join per-turn MP3 segments into one episode file.
 *
 * This is naive frame concatenation — the bytes are appended and nothing is
 * rewritten. That is sound here and only here: every segment comes from the
 * same encoder at the same constant bitrate and sample rate
 * (`audio-24khz-48kbitrate-mono-mp3`), so the frames are uniform and a decoder
 * reading straight through them never meets a format change. Edge's output
 * carries no ID3 tag — a segment begins directly with a frame sync — so there
 * is no metadata block to strip out of the middle of the file.
 *
 * The limitation, stated plainly: the resulting file has no container-level
 * duration for the whole episode. There is no Xing/VBR header to correct, and a
 * player that estimates length from the first frames plus the file size gets it
 * right, but a strict player that trusts a declared duration will believe the
 * episode is as long as its first turn — seeking past that point may misbehave.
 * Browsers, ffmpeg, and podcast apps all play the result correctly. Producing a
 * properly indexed file would mean a real MP3 muxer or an ffmpeg dependency,
 * and neither is worth it before someone reports a player that stumbles.
 * A segment that is not playable audio throws rather than being skipped. The
 * earlier version filtered them out, which meant a caller handing over a bare
 * `Uint8Array` — the same bytes, just not a `Buffer` — got a shorter episode
 * with a turn missing from the middle and no error anywhere. The file still
 * played, so nothing downstream could tell it was wrong.
 * @param segments - the per-turn buffers, in playback order.
 * @returns one MP3 buffer; empty only when `segments` is itself empty.
 * @throws if `segments` is not an array, or a segment carries no audio.
 */
export function concatMp3(segments) {
  if (!Array.isArray(segments)) {
    throw new TypeError("concatMp3 needs an array of segments in playback order");
  }
  const usable = segments.map((segment, index) => {
    const bytes = Buffer.isBuffer(segment)
      ? segment
      : segment instanceof Uint8Array
        ? Buffer.from(segment.buffer, segment.byteOffset, segment.byteLength)
        : null;
    if (bytes === null || bytes.byteLength === 0) {
      throw new Error(`segment ${index} of ${segments.length} carries no audio, so the episode would be missing a turn`);
    }
    return bytes;
  });
  return Buffer.concat(usable);
}
