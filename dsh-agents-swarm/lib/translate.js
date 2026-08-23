/**
 * Transcript translation.
 *
 * The reference translates one block at a time, on demand, for whichever block
 * is playing right now. That keeps the first result fast and the bill small,
 * but it means every line you have not yet reached is blank — scrolling ahead
 * to read shows nothing, which is most of what a transcript pane is for. It
 * also spends one model round trip per sentence.
 *
 * Here the work is batched: blocks go out in numbered groups and come back as
 * a JSON array carrying the index they answer, so a model that reorders,
 * merges, or drops lines cannot silently shift every subsequent translation
 * onto the wrong block. Anything the model fails to return simply stays
 * untranslated and is retried on the next pass, rather than being backfilled
 * with the source text — the reference writes the English in on failure, which
 * makes a broken translation indistinguishable from a finished one, both to
 * the reader and to the cache.
 */

/** Blocks per model call. Large enough to amortise the round trip, small
 * enough that one bad response costs little and retries stay cheap. */
export const BATCH_SIZE = 20;

/** Target languages offered for a transcript. */
export const TARGET_LANGUAGES = [
  { code: "zh-Hans", label: "中文（简体）", name: "Simplified Chinese" },
  { code: "zh-Hant", label: "中文（繁體）", name: "Traditional Chinese" },
  { code: "en", label: "English", name: "English" },
  { code: "ja", label: "日本語", name: "Japanese" },
  { code: "ko", label: "한국어", name: "Korean" },
];

/**
 * The language a code names, for the prompt.
 * @param code - a target language code.
 * @returns the English name, falling back to the code itself.
 */
export function languageName(code) {
  const hit = TARGET_LANGUAGES.find((entry) => entry.code === code);
  return hit === undefined ? String(code) : hit.name;
}

/** Whether a code is one this plugin will translate into. */
export function isSupportedLanguage(code) {
  return TARGET_LANGUAGES.some((entry) => entry.code === code);
}

/**
 * Pull the first JSON array out of a model answer.
 *
 * Models wrap JSON in prose or a fence often enough that parsing the raw text
 * fails on answers that are otherwise perfectly good. Scanning for the outer
 * brackets recovers those without accepting anything that is not an array.
 * @param text - the model's answer.
 * @returns the parsed array, or undefined when none can be read.
 */
export function extractJsonArray(text) {
  const source = String(text ?? "");
  const start = source.indexOf("[");
  const end = source.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The prompt for one batch.
 * @param batch - `[{ index, text }]` for this group.
 * @param target - the target language's English name.
 * @returns the user prompt.
 */
export function buildPrompt(batch, target) {
  const lines = batch.map((entry) => `${entry.index}: ${entry.text}`).join("\n");
  return [
    `Translate each numbered subtitle line into ${target}.`,
    "",
    'Answer with ONLY a JSON array, each element `{"i": <the line\'s number>, "t": "<translation>"}`.',
    "Rules:",
    "- One element per input line, carrying that line's own number.",
    "- Never merge, split, reorder, or omit lines.",
    "- Translate only; add no commentary, notes, or bracketed explanations.",
    "- Keep proper nouns, product names, and technical terms accurate.",
    "- A line that is already in the target language is returned unchanged.",
    "",
    "Lines:",
    lines,
  ].join("\n");
}

/**
 * Translate one batch of blocks.
 * @param chat - the streaming chat entry point from `createChat`.
 * @param batch - `[{ index, start, text }]`.
 * @param targetCode - the target language code.
 * @returns `[{ start, text }]` for the blocks the model answered.
 */
export async function translateBatch(chat, batch, targetCode) {
  let answer = "";
  let failure = "";
  for await (const chunk of chat({ prompt: buildPrompt(batch, languageName(targetCode)), context: "" })) {
    if (typeof chunk.text === "string") answer += chunk.text;
    if (typeof chunk.error === "string") failure = chunk.error;
  }
  if (failure !== "") throw new Error(failure);

  const parsed = extractJsonArray(answer);
  if (parsed === undefined) throw new Error("the model did not return a JSON array");

  // Reconcile by the index the model echoed back, not by position: an answer
  // that drops one line would otherwise shift every translation after it onto
  // the wrong block, and nothing downstream could detect that.
  const byIndex = new Map(batch.map((entry) => [entry.index, entry]));
  const rows = [];
  for (const item of parsed) {
    const index = typeof item?.i === "number" ? item.i : Number(item?.i);
    const text = typeof item?.t === "string" ? item.t.trim() : "";
    const source = byIndex.get(index);
    if (source === undefined || text === "") continue;
    rows.push({ start: source.start, text });
  }
  return rows;
}

/**
 * Split blocks into batches, nearest to a starting point first.
 *
 * A reader who turns translation on is looking at one place in the recording,
 * so that is where the first finished batch should land. Ordering by distance
 * costs nothing and makes the wait feel like it starts where they are looking
 * rather than at the top of a two-hour video.
 * @param blocks - `[{ index, start, text }]` still needing translation.
 * @param fromSeconds - the playback position to work outwards from.
 * @returns an array of batches.
 */
export function planBatches(blocks, fromSeconds = 0) {
  const ordered = [...blocks].sort((a, b) => Math.abs(a.start - fromSeconds) - Math.abs(b.start - fromSeconds));
  const batches = [];
  for (let at = 0; at < ordered.length; at += BATCH_SIZE) {
    // Each batch reads in recording order, so the numbered lines the model
    // sees run forwards and it has the sentence-to-sentence context that
    // makes a translation coherent rather than a bag of isolated lines.
    batches.push(ordered.slice(at, at + BATCH_SIZE).sort((a, b) => a.start - b.start));
  }
  return batches;
}
