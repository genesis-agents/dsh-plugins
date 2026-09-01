/**
 * Where in a video a quoted sentence was said.
 *
 * WHY THIS EXISTS. For a paper or an article, "the source" is the page, and a
 * link to it is the whole of what a reader needs. For a talk it is not: an
 * hour of video is not a citation, and handing somebody a ninety-minute
 * interview as the provenance of one sentence is handing them the search
 * problem back. The source is the MOMENT — which video, at what second, in
 * whose answer — and that is a thing this library can actually compute,
 * because it already stores the transcript with a start time on every cue.
 *
 * IT IS COMPUTED, NOT STORED. `insight_evidence` has no offset column and
 * adding one would leave every row already written without it — eighteen
 * claims whose quotes are already in the table, none of which would ever get a
 * timestamp. Matching at read time gives them one, and costs a single indexed
 * transcript read per evidence row.
 *
 * EXACT MATCH ONLY, AND THAT IS THE POINT. The extraction pass verifies each
 * quote against the block the model was shown, so a quote that cannot be found
 * in the transcript is a quote that came from somewhere else — a paraphrase, a
 * hallucination, or a transcript that has since been refetched and changed.
 * A near-match would put a confident `▶ 38:08` under a sentence nobody said at
 * 38:08, which is worse than no timestamp at all. No match, no link.
 */

/** Only these carry a timeline a second can point into. */
const TIMED_TYPES = new Set(["YOUTUBE_VIDEO", "YOUTUBE", "VIDEO", "PODCAST"]);

/**
 * Normalise for matching, without moving any character's position.
 *
 * A TRANSCRIPT AND A QUOTE DISAGREE ABOUT WHITESPACE AND ABOUT QUOTE MARKS,
 * and about nothing else that matters: the pass copies the words verbatim but
 * the block it was shown had cues joined by a single space, while the stored
 * `text` may carry newlines, and a model that was shown `"` sometimes returns
 * `“`. Lower-casing and folding those to one form makes the match survive
 * that without making it loose.
 *
 * LENGTH IS PRESERVED CHARACTER FOR CHARACTER. The index of a match in the
 * folded text has to be the index in the real text, or the cue walk below
 * lands in the wrong cue — so every substitution is one character for one.
 * @param text - the source or the quote.
 * @returns the folded form, the same length as the input.
 */
function fold(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s ]/gu, " ")
    .replace(/[‘’‛′]/gu, "'")
    .replace(/[“”‟″]/gu, '"')
    .replace(/[‐-―−]/gu, "-");
}

/**
 * The second at which a quote is spoken, or null.
 *
 * @param quote - the verbatim quote, as stored on the evidence row.
 * @param cues - `[{ start, duration, text }]`, as `getTranscript` returns.
 * @returns the cue's start in whole seconds, or null when the quote is not in it.
 */
export function momentOf(quote, cues) {
  const wanted = fold(quote).trim();
  // A HANDFUL OF WORDS IS NOT A LOCATOR. "and so" appears forty times in an
  // hour of speech, and the first match is not the one the claim came from.
  if (wanted.length < 24 || !Array.isArray(cues) || cues.length === 0) return null;

  // THE JOIN HAS TO BE THE ONE THE OFFSETS ARE COMPUTED AGAINST. Building the
  // haystack and the offset table in the same pass is what guarantees that:
  // there is no second place that decides how cues are separated.
  let haystack = "";
  const starts = [];
  for (const cue of cues) {
    const text = fold(cue?.text ?? "").trim();
    if (text === "") continue;
    if (haystack !== "") haystack += " ";
    starts.push({ at: haystack.length, start: Number(cue?.start) });
    haystack += text;
  }
  if (starts.length === 0) return null;

  const found = haystack.indexOf(wanted);
  if (found < 0) return null;

  // THE LAST CUE THAT BEGINS AT OR BEFORE THE MATCH. A quote routinely spans
  // three cues; the one it STARTS in is the moment to link to, because that is
  // where a listener has to be to hear the sentence begin.
  let held = null;
  for (const cue of starts) {
    if (cue.at > found) break;
    held = cue;
  }
  const seconds = Number(held?.start);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
}

/**
 * A watch URL that opens at a given second.
 *
 * ONLY FOR HOSTS WHOSE OWN PLAYER TAKES ONE. `?t=` is YouTube's and `#t=` is
 * the media-fragment syntax a bare video file honours; a news site handed
 * either shows the top of the page, and a link that claims to open at 38:08
 * and does not is worse than one that does not claim it.
 * @param url - the resource's own address.
 * @param seconds - the moment.
 * @returns the address, or null when this host cannot be pointed into.
 */
export function momentUrl(url, seconds) {
  const address = String(url ?? "");
  // COERCED, because a caller that reads the second off a JSON payload has a
  // string and `Number.isFinite("2288")` is false — a guard that rejects the
  // right answer for being the wrong type is a guard that drops the link.
  const at = Number(seconds);
  if (address === "" || !Number.isFinite(at) || at < 0) return null;
  let parsed;
  try { parsed = new URL(address); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    // `t` REPLACES rather than appends: a URL that already carries one from
    // the feed would otherwise get two, and YouTube honours the first.
    parsed.searchParams.set("t", `${Math.floor(at)}s`);
    return parsed.toString();
  }
  return null;
}

/** `1:03:12` over an hour, `38:08` under one — the way a player writes it. */
export function formatMoment(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Attach the moment to every piece of evidence that has one.
 *
 * TAKES A READER RATHER THAN A STORE, so the matching above can be tested
 * against a Map and the caller decides what a transcript lookup costs. One
 * lookup per DISTINCT resource, not per evidence row: a claim with four quotes
 * off one interview reads that interview's transcript once.
 * @param rows - evidence rows, each with `resourceId`, `quote` and `resource`.
 * @param transcriptOf - `(resourceId) => { cues } | undefined`.
 * @returns the same rows, each gaining `at` and `atUrl` (both possibly null).
 */
export function withMoments(rows, transcriptOf) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const seen = new Map();
  return rows.map((row) => {
    // TWO SHAPES, AND ONLY ONE OF THEM WAS READ. The list route's
    // `evidencePreview` is FLAT — `type`, `title`, `sourceUrl` on the row — and
    // the item route's `evidence` nests the resource. Reading only the nested
    // form left the list, which is the shape the pane actually renders, with a
    // null moment on every row; and the unit test happened to use the nested
    // one, so it stayed green while the page stayed empty.
    const type = String(row?.type ?? row?.resourceType ?? row?.resource?.type ?? "").toUpperCase();
    const url = row?.sourceUrl ?? row?.resource?.sourceUrl ?? "";
    // THE TYPE GATE IS FIRST because it is free. Reading a transcript for
    // every arXiv abstract on the page would be one query per row for a
    // column that is empty on all of them.
    if (!TIMED_TYPES.has(type) || url === "") return { ...row, at: null, atUrl: null };
    const id = String(row?.resourceId ?? "");
    if (!seen.has(id)) {
      let held;
      try { held = transcriptOf(id); } catch { held = undefined; }
      seen.set(id, held?.cues ?? null);
    }
    const at = momentOf(row?.quote, seen.get(id));
    return { ...row, at, atUrl: at === null ? null : momentUrl(url, at) };
  });
}
