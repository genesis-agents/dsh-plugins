/**
 * Episode storage and the podcast feed.
 *
 * A generated episode is not a cache entry. It costs a model pass to write the
 * script and a text-to-speech pass to voice it, and the operator's reason for
 * making one is usually to listen to it later, away from the machine that
 * produced it. So an episode is written to disk beside the library and
 * described in a feed a podcast client can subscribe to, rather than handed
 * back to the page as a blob that dies with the tab.
 *
 * The rejected alternative was keeping episodes in the SQLite library itself,
 * as a BLOB column beside the sources. That reads well until the first
 * three-megabyte MP3: the database file then grows by the size of every
 * episode ever made, a `VACUUM` rewrites all of them, and — the deciding
 * point — a podcast client fetches audio with a ranged GET, which is one
 * `createReadStream` over a file and an awkward substring over a row. Files on
 * disk, and one small JSON index beside them naming what those files are.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { storePath } from "./index.js";
import { mediaDirs } from "./library.js";

/**
 * Bitrate every episode is encoded at.
 *
 * Speech at 48 kbit/s mono is indistinguishable from a higher rate on a phone
 * speaker and keeps a twenty-minute episode near seven megabytes.
 *
 * This must match what the encoder was actually told, and nothing enforces
 * that: the synthesis side names its format as one opaque string,
 * `audio-24khz-48kbitrate-mono-mp3` in `tts.js`, which no arithmetic here can
 * read the bitrate out of. The two are kept in step by hand. Changing one
 * without the other does not break anything loudly — it just makes every
 * duration in the list and the feed wrong by the ratio between them.
 */
export const BITRATE_BITS_PER_SECOND = 48_000;

/** Name of the record file inside {@link episodeDir}. */
const INDEX_FILE = "index.json";

/**
 * Characters an id may contain. Anything else is refused rather than escaped,
 * because the id becomes both a path segment and a URL segment.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Where generated episodes live: beside the database, for the same reason
 * thumbnails are — a library copied to another machine must carry its episodes
 * with it. An episode whose audio was left behind in a harness cache directory
 * is a feed entry that 404s, which is worse than no feed at all.
 * @param env - process environment.
 * @returns the absolute directory path.
 */
export function episodeDir(env = process.env) {
  return mediaDirs(storePath(env)).episodes;
}

/**
 * Absolute path of one episode's audio file.
 *
 * The id is interpolated into a filesystem path, so an id that is not URL-safe
 * is refused here rather than normalised: this is the traversal guard, and it
 * belongs at the point where the string becomes a path, not at whichever route
 * happens to call it today.
 * @param id - an episode id.
 * @param env - process environment.
 * @returns the absolute `.mp3` path.
 * @throws when the id contains anything outside `[A-Za-z0-9_-]`.
 */
export function episodePath(id, env = process.env) {
  const value = String(id ?? "");
  if (!SAFE_ID.test(value)) throw new Error(`malformed episode id: ${JSON.stringify(value)}`);
  return join(episodeDir(env), `${value}.mp3`);
}

/**
 * Duration of an episode, inferred from its size.
 *
 * This is an ESTIMATE. Nothing here decodes MP3 frame headers, so an ID3 tag
 * or a stretch of variable-rate frames shifts the answer by a second or two.
 * That is acceptable because the number is only ever displayed as a rough
 * length — in the episode list, and in `itunes:duration`, which every podcast
 * client treats as a hint and replaces with the true duration the moment the
 * file is decoded. Carrying a frame parser to win two seconds on a label would
 * be the wrong trade.
 * @param bytes - the MP3's byte length.
 * @returns whole seconds, never less than one — a byte count that is not a
 *   number reads as zero rather than propagating NaN into a duration label.
 */
export function estimateDuration(bytes) {
  const size = Number(bytes);
  return Math.max(1, Math.round(((Number.isFinite(size) ? size : 0) * 8) / BITRATE_BITS_PER_SECOND));
}

/**
 * Mint an episode id: a UTC timestamp, then a short digest of the content.
 *
 * The timestamp makes a directory listing readable and sorts correctly as a
 * string, which matters because the audio files are what an operator will
 * actually browse. The digest is what keeps two episodes minted in the same
 * second distinct — a bare timestamp is a collision waiting for the day
 * someone publishes twice in a row.
 *
 * The digest mixes a per-call nonce into the basis rather than hashing the
 * basis alone, because the basis a caller can offer is not reliably distinct:
 * re-rendering the same script from the same sources produces the same title,
 * the same source ids, and often the same byte count, and a digest over only
 * those would hand the second episode the first one's id — which overwrites
 * its audio and puts two rows with one id in the index, so deleting either
 * deletes both. An id here names an episode; it is not a content hash and
 * nothing dedupes on it.
 * @param createdAt - ISO timestamp.
 * @param basis - anything that differs between two episodes.
 * @returns a URL-safe id.
 */
function mintId(createdAt, basis) {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const digest = createHash("sha256").update(`${basis}\n${randomUUID()}`).digest("hex").slice(0, 8);
  return `${stamp}-${digest}`;
}

/**
 * The MP3 bytes, however the caller happens to hold them.
 *
 * A text-to-speech response that crossed a JSON boundary arrives base64
 * encoded, and one produced in-process arrives as a Buffer. Both are ordinary
 * enough that refusing either would only push the same conversion onto every
 * caller.
 *
 * The string is checked by re-encoding it rather than trusted, because
 * `Buffer.from(text, "base64")` does not fail on text that is not base64 — it
 * discards every character outside the alphabet and returns whatever the rest
 * decoded to. A failed synthesis whose error body arrived as a string would
 * otherwise be stored as a short, non-empty, entirely fictitious MP3 and
 * listed in the feed as a real episode.
 * @param audio - Buffer, Uint8Array, or base64 string.
 * @returns a Buffer.
 * @throws when the value is not bytes, or is a string that is not base64.
 */
function audioBuffer(audio) {
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof Uint8Array) return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (typeof audio === "string") {
    // Whitespace is dropped first (wrapped base64 is ordinary) and the
    // URL-safe alphabet is folded onto the standard one, so the comparison
    // below tests the bytes rather than the spelling.
    const packed = audio.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    const body = Buffer.from(packed, "base64");
    if (packed !== "" && body.toString("base64").replace(/=+$/, "") === packed) return body;
    throw new Error(`saveEpisode was handed a string that is not base64 audio: ${JSON.stringify(audio.slice(0, 80))}`);
  }
  throw new Error("saveEpisode needs the MP3 bytes as a Buffer, a Uint8Array, or a base64 string");
}

/**
 * The turns out of whichever script shape the caller holds.
 * @param script - an array of turns, a `{ turns }` object, or nothing.
 * @returns the turns, empty when there was no script at all.
 * @throws when a script was supplied in a shape this cannot read, since
 *   silently storing no script is indistinguishable from storing one.
 */
function scriptTurns(script) {
  if (script === undefined || script === null) return [];
  if (Array.isArray(script)) return script;
  if (Array.isArray(script.turns)) return script.turns;
  throw new Error("saveEpisode needs `script` as an array of { speaker, text } turns or as a { turns } object");
}

/**
 * Read the record file.
 *
 * A corrupt index throws rather than being swallowed. Returning an empty list
 * would look like a library with no episodes, and the next save would then
 * write a fresh one-entry index over the damaged file and destroy the record of
 * everything before it. The audio is still on disk either way, so an error
 * naming the file is something the operator can act on.
 * @param env - process environment.
 * @returns the stored records, in write order.
 */
function readIndex(env) {
  const file = join(episodeDir(env), INDEX_FILE);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`episode index at ${file} is not valid JSON, though the audio beside it is intact: ${cause.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`episode index at ${file} is not a JSON array`);
  // Rows are checked here, once, rather than defended against at each of the
  // half-dozen places that read `record.id`. A `null` or a bare string in the
  // array is the same damage as unparseable JSON, and reaching it through
  // `Array.prototype.filter` raises a TypeError that names neither the file
  // nor the row — which is the opposite of what the paragraph above promises.
  const bad = parsed.findIndex((row) => row === null || typeof row !== "object" || Array.isArray(row));
  if (bad !== -1) {
    throw new Error(`episode index at ${file} has a non-record entry at position ${bad}: ${JSON.stringify(parsed[bad])}`);
  }
  return parsed;
}

/**
 * Replace the record file.
 *
 * Written under a temporary name and renamed into place, because rename is
 * atomic within a directory and truncate-then-write is not: a crash between
 * those two steps leaves a half-written index, and the index is the one file
 * here that cannot be reconstructed from what is on disk.
 *
 * The concurrency story is read-modify-write over the whole file, and its
 * failure mode is a lost update — two saves that overlap end with only the
 * second one's record, and the first episode's MP3 sits on disk unlisted. That
 * is acceptable at this scale: one operator, publishing by hand, where
 * producing a single episode costs tens of seconds of synthesis and episodes
 * therefore arrive minutes apart. A lock file would buy nothing anyone here
 * would ever observe, and would introduce a stale-lock failure worse than the
 * one it prevents.
 * @param records - the full list to persist.
 * @param env - process environment.
 */
function writeIndex(records, env) {
  const dir = episodeDir(env);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, INDEX_FILE);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

/**
 * Write one episode's audio and record it.
 *
 * The record carries the script itself, not a pointer to it, so an episode can
 * be re-read as text — which is how someone checks what a host actually said
 * without sitting through twenty minutes of audio, and how an old script could
 * later be re-voiced without paying for the model again.
 *
 * `script` arrives in either shape the rest of this plugin deals in: the bare
 * array of turns, or the `{ title, turns }` object that `generateScript` and
 * `parseScript` return and that the publish route forwards. Accepting only the
 * array and quietly treating the object as an empty script is the failure this
 * function must not have — it stores a record that looks complete, with
 * `turns: 0`, and the script it exists to preserve is gone with nothing said.
 * @param episode - `{ audio, title, script, sourceIds, voices }`, where `audio`
 *   is the MP3 bytes and `script` is the array of `{ speaker, text }` turns, or
 *   a `{ turns }` object wrapping it.
 * @param env - process environment.
 * @returns the stored record.
 * @throws when `script` is neither of those shapes.
 */
export async function saveEpisode({ audio, title, script, sourceIds, voices } = {}, env = process.env) {
  const body = audioBuffer(audio);
  if (body.byteLength === 0) throw new Error("refusing to save an episode with no audio");

  const turns = scriptTurns(script);
  const sources = Array.isArray(sourceIds) ? sourceIds.map(String) : [];
  const createdAt = new Date().toISOString();
  const name = typeof title === "string" && title.trim() !== "" ? title.trim() : `Episode ${createdAt.slice(0, 10)}`;
  const id = mintId(createdAt, `${name}\n${sources.join(",")}\n${body.byteLength}`);

  const dir = episodeDir(env);
  await mkdir(dir, { recursive: true });
  // Audio first, index second. The reverse order can leave a listed episode
  // whose file does not exist, which a podcast client reports to the listener
  // as a failed download; this order can at worst leave an unlisted file,
  // which is inert.
  await writeFile(join(dir, `${id}.mp3`), body);

  const record = {
    id,
    title: name,
    createdAt,
    durationSeconds: estimateDuration(body.byteLength),
    bytes: body.byteLength,
    sourceIds: sources,
    turns: turns.length,
    voices: voices ?? {},
    script: turns,
  };
  writeIndex([...readIndex(env), record], env);
  return record;
}

/**
 * Every stored episode, newest first — the order the page lists them in, and
 * the order a podcast client expects items to arrive.
 * @param env - process environment.
 * @returns the records.
 */
export function listEpisodes(env = process.env) {
  return readIndex(env)
    .slice()
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * One stored episode.
 * @param id - the episode id.
 * @param env - process environment.
 * @returns the record, or undefined when there is none.
 */
export function getEpisode(id, env = process.env) {
  const wanted = String(id ?? "");
  return readIndex(env).find((record) => record.id === wanted);
}

/**
 * Forget one episode and remove its audio.
 * @param id - the episode id.
 * @param env - process environment.
 * @returns true when a record was removed, false when there was nothing to
 *   remove — a caller answering 404 needs to tell those two apart.
 */
export function deleteEpisode(id, env = process.env) {
  const wanted = String(id ?? "");
  const records = readIndex(env);
  const remaining = records.filter((record) => record.id !== wanted);
  // The record goes before the file: an entry pointing at a deleted file is a
  // broken feed item, whereas a file with no entry is only wasted disk.
  if (remaining.length !== records.length) writeIndex(remaining, env);
  // `episodePath` is what refuses a traversal attempt, so removal is only
  // attempted for an id that is safe to turn into a path in the first place.
  if (SAFE_ID.test(wanted)) rmSync(episodePath(wanted, env), { force: true });
  return remaining.length !== records.length;
}

/**
 * Escape one value for inclusion in XML, as text or inside an attribute.
 *
 * Every interpolated value in the feed goes through this one function, because
 * the alternative — remembering to escape at each of fifteen interpolation
 * sites — fails exactly once and then produces a document no reader will parse.
 * A source title containing `&` or `<` is not hypothetical; a large share of
 * the news headlines in this library carry an ampersand.
 *
 * The ampersand is replaced FIRST. Doing it after `<` would re-escape the
 * ampersands that `&lt;` had just introduced and emit `&amp;lt;`.
 * @param value - anything stringifiable.
 * @returns the escaped text.
 */
export function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Control characters have no representation in XML 1.0 at all, not even as
    // a numeric reference, so they are dropped rather than escaped. A stray
    // \x00 or \x1b carried in from a scraped title would otherwise make the
    // document ill-formed in a way no escaping can repair.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    // Unpaired surrogates and the two noncharacters are the same problem
    // arriving by a different road, and the road is real: a title is a
    // JavaScript string of UTF-16 code units, so slicing one to a character
    // budget — as `itemDescription` does at 300 — can cut an emoji in half
    // and leave a surrogate with no mate. A lone surrogate is not a
    // character, and an XML reader rejects the WHOLE document over one: a
    // single broken emoji in a single title would empty every subscriber's
    // feed rather than spoil one item. Dropped, like the controls above.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uFFFE\uFFFF]/g, "");
}

/** Day names as RFC 822 spells them; deliberately not locale-derived. */
const RFC822_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Month names as RFC 822 spells them. */
const RFC822_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Format a date the way RSS 2.0 requires: RFC 822, with a numeric zone.
 *
 * Written out rather than delegated to `toUTCString`, and the difference is
 * worth stating because the two strings look alike. `toUTCString` produces the
 * IMF-fixdate of RFC 7231 — an HTTP date — whose zone field is the fixed
 * literal `GMT`; RSS 2.0 cites RFC 822, whose general zone form is the
 * four-digit offset `+0000`. Today's readers accept both, but that is a
 * coincidence rather than a guarantee: `toUTCString`'s exact output was
 * implementation-defined until ES2018 pinned it, and neither specification
 * promises the two forms stay interchangeable. Twelve month names cost less
 * than the bet.
 * @param date - a Date, or anything the Date constructor accepts.
 * @returns e.g. `Sat, 22 Aug 2026 09:04:00 +0000`, or an empty string when the
 *   input will not parse, since a malformed pubDate is worse than none.
 */
export function rfc822(date) {
  const when = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(when.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${RFC822_DAYS[when.getUTCDay()]}, ${pad(when.getUTCDate())} ${RFC822_MONTHS[when.getUTCMonth()]}`
    + ` ${when.getUTCFullYear()} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())} +0000`;
}

/**
 * Seconds as `HH:MM:SS`, the form `itunes:duration` is documented to take.
 * @param seconds - whole seconds.
 * @returns the formatted duration.
 */
export function itunesDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/**
 * The blurb a client shows under an episode title.
 *
 * Falls back to the opening of the script, because an item with an empty
 * description renders as a blank row in every client and reads as a broken feed
 * rather than as an episode nobody bothered to describe.
 * @param episode - a stored record.
 * @returns plain text.
 */
function itemDescription(episode) {
  if (typeof episode.description === "string" && episode.description.trim() !== "") {
    return episode.description.trim();
  }
  const opening = (Array.isArray(episode.script) ? episode.script : [])
    .slice(0, 2)
    .map((turn) => String(turn?.text ?? "").trim())
    .filter((text) => text !== "")
    .join(" ");
  if (opening !== "") return opening.length > 300 ? `${opening.slice(0, 300)}…` : opening;
  const count = Array.isArray(episode.sourceIds) ? episode.sourceIds.length : 0;
  return `A two-host conversation generated from ${count} source${count === 1 ? "" : "s"}.`;
}

/**
 * Render the episodes as an RSS 2.0 document carrying the iTunes podcast
 * namespace, so the feed can be subscribed to in Apple Podcasts, Overcast, and
 * 小宇宙 rather than only played back in the tab that produced it.
 *
 * `baseUrl` has a default but is required in practice: a podcast client has no
 * page to resolve a relative enclosure against, so the audio URL must be
 * absolute, and only the caller knows which origin it is serving from.
 * @param episodes - stored records, in the order they should appear.
 * @param options - `{ title, description, language, imageUrl, link, author,
 *   baseUrl, explicit, category }`.
 * @returns the feed XML.
 */
export function buildFeed(episodes, {
  title = "Swarm",
  description = "Two-host episodes generated from the swarm source library.",
  language = "zh-CN",
  imageUrl = "",
  link = "",
  author = "Swarm",
  baseUrl = "",
  explicit = false,
  category = "Technology",
  audioUrl,
} = {}) {
  const origin = String(baseUrl).replace(/\/+$/, "");
  const home = link === "" ? origin : link;
  // Normalised rather than compared against "" directly: a caller that
  // passes `imageUrl: null` — or the empty string with a stray space, which
  // is what an unset field in a settings form yields — would otherwise take
  // the present branch and emit `href=""`, the broken image the block below
  // says it is avoiding.
  const image = typeof imageUrl === "string" ? imageUrl.trim() : "";
  const rows = Array.isArray(episodes) ? episodes : [];

  const items = rows.map((episode) => {
    // The caller supplies the URL because only it knows the route the audio
    // is served at; this module knowing that would couple a feed writer to a
    // router. The fallback keeps the function usable on its own in a test.
    const url = typeof audioUrl === "function"
      ? audioUrl(episode)
      : `${origin}/episode/${encodeURIComponent(episode.id)}.mp3`;
    const seconds = Number(episode.durationSeconds) || estimateDuration(episode.bytes ?? 0);
    // A record whose `createdAt` will not parse gets no `pubDate` element at
    // all, not an empty one: `rfc822` returns "" on the grounds that a
    // malformed date is worse than none, and `<pubDate></pubDate>` is the
    // malformed date — validators reject it and some clients read the empty
    // string as the epoch, which sorts the episode to the bottom forever.
    const published = rfc822(episode.createdAt);
    return [
      "    <item>",
      `      <title>${xmlEscape(episode.title)}</title>`,
      `      <description>${xmlEscape(itemDescription(episode))}</description>`,
      published === "" ? "" : `      <pubDate>${xmlEscape(published)}</pubDate>`,
      // Not a permalink: the id names a file this server owns, and saying so
      // stops a client from treating the string as a page it can open.
      `      <guid isPermaLink="false">${xmlEscape(episode.id)}</guid>`,
      // `length` is the byte count, which clients use to draw the download
      // progress bar; a wrong one shows a bar that never fills.
      `      <enclosure url="${xmlEscape(url)}" length="${xmlEscape(episode.bytes ?? 0)}" type="audio/mpeg"/>`,
      `      <itunes:duration>${xmlEscape(itunesDuration(seconds))}</itunes:duration>`,
      "    </item>",
    ].filter((line) => line !== "").join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${xmlEscape(title)}</title>`,
    `    <description>${xmlEscape(description)}</description>`,
    `    <language>${xmlEscape(language)}</language>`,
    `    <link>${xmlEscape(home)}</link>`,
    // The self link is how a client handed this XML by some other route learns
    // its own subscription URL, and every feed validator asks for it.
    `    <atom:link href="${xmlEscape(`${origin}/feed.xml`)}" rel="self" type="application/rss+xml"/>`,
    `    <itunes:author>${xmlEscape(author)}</itunes:author>`,
    `    <itunes:summary>${xmlEscape(description)}</itunes:summary>`,
    `    <itunes:explicit>${explicit ? "true" : "false"}</itunes:explicit>`,
    `    <itunes:category text="${xmlEscape(category)}"/>`,
    // The channel image is stated twice on purpose: `itunes:image` is what the
    // podcast clients read, and the plain RSS `<image>` is what everything else
    // reads. Both are omitted when there is no image, because an empty `url` is
    // a broken image rather than a missing one.
    image === "" ? "" : `    <itunes:image href="${xmlEscape(image)}"/>`,
    image === "" ? "" : [
      "    <image>",
      `      <url>${xmlEscape(image)}</url>`,
      `      <title>${xmlEscape(title)}</title>`,
      `      <link>${xmlEscape(home)}</link>`,
      "    </image>",
    ].join("\n"),
    ...items,
    "  </channel>",
    "</rss>",
    // The trailing newline is appended rather than carried as a final empty
    // entry, because the filter above — which is what drops the image block
    // when there is no image — would take that entry with it.
  ].filter((line) => line !== "").join("\n") + "\n";
}
