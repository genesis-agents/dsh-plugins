/**
 * Written formats: the digest and the report.
 *
 * The podcast was the first thing this library published, and building it
 * produced a pipeline that is not about audio at all — choose sources, gather
 * their substance within a budget, ask a model for one artefact, store it,
 * list it, schedule it. Speech was only the last step. So the written formats
 * reuse everything up to that step and replace what comes after: no synthesis,
 * no concatenation, no duration — a Markdown document instead.
 *
 * Two formats rather than one because they answer different questions and a
 * single prompt asked to do both does neither. A DIGEST answers "what
 * happened" — short, scannable, one entry per source, read in the two minutes
 * before a meeting. A REPORT answers "what does it mean" — it groups sources
 * into themes, says what they agree and disagree on, and is worth the longer
 * read precisely because it does the synthesis a digest deliberately refuses.
 */

import { assembleMaterial, detectLanguage } from "./podcast.js";

/** Formats this module can produce. */
export const DOCUMENT_FORMATS = [
  {
    id: "digest",
    en: "Digest",
    zh: "摘要",
    // A daily brief is skimmed, so brevity is the product rather than a
    // limitation. Anything that needs a paragraph belongs in a report.
    words: 500,
    blurb: { en: "What happened, one entry per source.", zh: "发生了什么，一条信源一段。" },
  },
  {
    id: "report",
    en: "Report",
    zh: "报告",
    words: 1400,
    blurb: { en: "What it means, grouped into themes with the disagreements named.", zh: "这些意味着什么，按主题归并并点出分歧。" },
  },
];

/**
 * What each detected language is called, in the prompt's own language.
 *
 * A code means nothing to the instruction — "write in zh" is not a sentence a
 * model follows as reliably as "write in Simplified Chinese".
 */
const LANGUAGE_NAMES = {
  zh: "Simplified Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
};

/** Characters of model output accepted before the answer is treated as runaway. */
const MAX_ANSWER_CHARS = 400_000;

/** Look up a format by id. */
export function findFormat(id) {
  return DOCUMENT_FORMATS.find((format) => format.id === id);
}

/**
 * Instructions for one format.
 *
 * Written as house style rather than as a schema. A document that has to be
 * parsed back out of the answer would need the model to hit an exact shape,
 * and every retry spent on that is a retry not spent on the content — whereas
 * Markdown is already the artefact, so a model that drifts produces prose that
 * is merely differently arranged rather than unusable.
 * @param format - the format entry.
 * @param zh - whether to write in Chinese.
 * @returns the instruction block.
 */
function instructions(format, language) {

  if (format.id === "digest") {
    return [
      `You are writing a DIGEST of about ${format.words} words. Write it in ${language}, and in ${language} only.`,
      "",
      "Open with a single sentence naming the through-line of the day, or say plainly that there isn't one — a digest that manufactures a theme is worse than one that admits the sources are unrelated.",
      "",
      "Then one short entry per source, in this shape:",
      "",
      "### <the claim the source actually makes, not its headline>",
      "One or two sentences of what it says and why it matters. Name the source and the date inline.",
      "",
      "Rules:",
      "- The heading is the FINDING, not the title. A reader scanning ten headings should learn ten things without opening anything.",
      "- No preamble, no sign-off, no 'in conclusion'.",
      "- If a source turns out to be thin — a press release, an announcement with no substance — say so in one line rather than padding it to match the others.",
      "- Numbers, names, and dates exactly as the source gives them. Never round a figure the source stated precisely.",
    ].join("\n");
  }

  return [
    `You are writing a REPORT of about ${format.words} words. Write it in ${language}, and in ${language} only.`,
    "",
    "Structure:",
    "",
    "## <a title that states the report's own conclusion>",
    "",
    "A two or three sentence abstract: what these sources, taken together, say that none of them says alone.",
    "",
    "### <theme>",
    "For each theme — two to four of them — set out what the sources establish, citing each inline as **<source name>, <date>**. Where two sources disagree, say so explicitly and characterise the disagreement rather than averaging it away.",
    "",
    "### What would change this",
    "Two or three specific developments that would falsify or substantially revise the above. Concrete and checkable, not 'further research is needed'.",
    "",
    "Rules:",
    "- Synthesis is the point. A report that walks the sources one at a time is a digest with longer paragraphs and has failed.",
    "- Say what is NOT established. A gap named is worth more than a gap papered over.",
    "- Never invent a source, a figure, or a date. Everything traceable to the material below.",
  ].join("\n");
}

/**
 * Build the full prompt for one document.
 * @param sources - `[{ row, transcript }]` as the routes assemble them.
 * @param options - `{ format, zh, guidance }`.
 * @returns the prompt text.
 */
export function buildDocumentPrompt(sources, { format, zh = false, guidance = "" } = {}) {
  const { material } = assembleMaterial(sources);
  const extra = String(guidance ?? "").trim();
  // Named, not inferred. "Write in the language most of the sources are
  // written in" reads as a clear instruction and is not one: asked that of
  // three English sources, the model returned a French digest and a German
  // report. The library already detects this for the podcast, so the two
  // formats now agree about what language a given set of sources is in.
  const language = zh ? "Simplified Chinese" : LANGUAGE_NAMES[detectLanguage(material)] ?? "English";
  return [
    instructions(format, language),
    extra === "" ? "" : `\nThe reader asked for this in particular, and it takes precedence over the shape above where they conflict:\n${extra}`,
    "",
    "Return Markdown only — no code fence around the whole document, no commentary before or after it.",
    "",
    "--- SOURCES ---",
    material,
  ].filter((part) => part !== "").join("\n");
}

/**
 * Strip a fence the model wrapped the whole document in.
 *
 * Asking for "Markdown only" gets it most of the time, and the rest of the
 * time gets ```markdown … ``` — which renders as a code block, so the document
 * arrives looking like source code. Cheaper to undo here than to litigate in
 * the prompt.
 * @param answer - the raw model output.
 * @returns the document text.
 */
export function unwrapMarkdown(answer) {
  const text = String(answer ?? "").trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  return (fenced === null ? text : fenced[1]).trim();
}

/**
 * Pull a title out of the document.
 *
 * The first heading, because the model was asked for one and it is what a
 * reader would call the document. Falling back to the first line rather than
 * to a generated title: a list of documents all called "Digest" is a list you
 * cannot navigate.
 * @param text - the document body.
 * @param fallback - used when there is no usable line.
 * @returns the title.
 */
export function titleOf(text, fallback) {
  for (const line of String(text ?? "").split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading !== null && heading[1].trim() !== "") return heading[1].trim().slice(0, 160);
  }
  const first = String(text ?? "").split("\n").map((line) => line.trim()).find((line) => line !== "");
  return first === undefined ? fallback : first.replace(/^[#>*\-\s]+/, "").slice(0, 160);
}

/**
 * Generate one document.
 * @param chat - the streaming chat entry point.
 * @param sources - `[{ row, transcript }]`.
 * @param options - `{ format, zh, guidance }`.
 * @returns `{ title, text, chars, format }`.
 */
export async function generateDocument(chat, sources, options = {}) {
  const format = options.format ?? DOCUMENT_FORMATS[0];
  const prompt = buildDocumentPrompt(sources, { ...options, format });

  let answer = "";
  for await (const chunk of chat({ prompt, context: "" })) {
    if (typeof chunk?.error === "string") throw new Error(chunk.error);
    if (typeof chunk?.text === "string") answer += chunk.text;
    // A model that will not stop is a cost that will not stop. The ceiling is
    // far above any real document, so hitting it means something is wrong
    // rather than that the document was long.
    if (answer.length > MAX_ANSWER_CHARS) throw new Error("the model produced far more than a document; stopped");
  }

  const text = unwrapMarkdown(answer);
  if (text === "") throw new Error("the model returned an empty document");
  return {
    title: titleOf(text, format.en),
    text,
    chars: text.length,
    format: format.id,
  };
}
