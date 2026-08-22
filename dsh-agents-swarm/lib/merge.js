/**
 * Transcript presentation: raw cues become the reading blocks the panel shows.
 *
 * Faithful to the upstream's `mergeTranscriptBySentence`
 * (`frontend/app/explore/youtube/page.tsx:64`), because the block boundaries
 * ARE the layout: a caption track arrives as one short cue every two or three
 * seconds, and rendering those one per row gives a stuttering column nobody
 * reads. Merging to a sentence gives the paragraph-per-timestamp column the
 * reference shows.
 *
 * The cleanup rules are the upstream's too, and each exists for a real artifact
 * of YouTube's auto-captions: `>>` marks a speaker change, a leading `-`
 * survives from the caption format, and runs of whitespace come from line
 * wrapping inside a cue.
 */

/** A block closes at a sentence end in either script's punctuation. */
const SENTENCE_END = /[.!?。！？][\s]*$/;

/** Or when it has grown past this, so one unpunctuated monologue is not one block. */
const MAX_BLOCK_CHARS = 200;

/** Alternating block tints cycle with this period, as the reference does. */
export const BLOCK_TINT_PERIOD = 4;

/**
 * Strip the artifacts YouTube's auto-captions carry.
 * @param text - one cue's text.
 * @returns the cleaned text, possibly empty.
 */
export function cleanCueText(text) {
  return String(text ?? "")
    .trim()
    .replace(/^>\s*>\s*/g, "")
    .replace(/>\s*>\s*/g, " ")
    .replace(/^-\s?/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merge timed cues into sentence-bounded reading blocks.
 * @param cues - `[{ start, duration, text }]` in order.
 * @returns `[{ text, start, duration, blockIndex }]`.
 */
export function mergeBySentence(cues) {
  const source = Array.isArray(cues) ? cues : [];
  const merged = [];
  let text = "";
  let start = 0;
  let duration = 0;
  let held = 0;
  let blockIndex = 0;

  for (const cue of source) {
    if (held === 0) start = Number(cue?.start ?? 0);
    const cleaned = cleanCueText(cue?.text);
    held += 1;
    if (cleaned === "") continue;
    text += (text === "" ? "" : " ") + cleaned;
    duration = Number(cue?.start ?? 0) + Number(cue?.duration ?? 0) - start;
    if (SENTENCE_END.test(cleaned) || text.length > MAX_BLOCK_CHARS) {
      merged.push({ text, start, duration, blockIndex: blockIndex++ });
      text = "";
      held = 0;
    }
  }
  if (text !== "") merged.push({ text, start, duration, blockIndex });
  return merged;
}

/**
 * Format a playback offset the way the reference labels a block: `m:ss`, with
 * hours folded into the minutes rather than shown separately.
 * @param seconds - offset in seconds.
 * @returns the label.
 */
export function formatTime(seconds) {
  const total = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(total / 60);
  const rest = Math.floor(total % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Index of the block covering a playback position.
 * @param blocks - merged blocks in order.
 * @param seconds - current playback offset.
 * @returns the index, or -1 before the first block starts.
 */
export function activeBlockIndex(blocks, seconds) {
  if (!Array.isArray(blocks) || blocks.length === 0) return -1;
  let found = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].start <= seconds) found = index;
    else break;
  }
  return found;
}
