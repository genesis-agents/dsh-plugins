/**
 * Episode scripts: turning selected sources into a two-host conversation.
 *
 * The obvious way to build this is the wrong one. Ask the model for a summary
 * of each source, concatenate the summaries, then split the prose into
 * alternating speaker turns afterwards. What comes out is a summary read aloud
 * by two people: every three minutes the episode restarts on a new source,
 * nobody ever asks anything, and the second voice exists only to relieve the
 * first. That is what a per-source pipeline can produce, and no amount of
 * post-processing recovers a conversation from it.
 *
 * So the whole episode is one model call that returns the dialogue already in
 * turns. The model sees every source at once, which is the only way it can
 * connect them, question one using another, and carry a through-line from the
 * hook to the closing takeaway. Returning structured turns rather than prose
 * is what makes the later speech stage possible at all — one voice per turn,
 * decided by a role field, never by parsing "Host A:" out of a line that might
 * itself contain a colon.
 *
 * This module holds no state and touches neither the store nor `ctx`. It takes
 * the same `chat` generator that `createChat` returns, exactly as
 * `translate.js` does, so it can be exercised with a fake generator and no
 * database.
 */

/**
 * Characters of material fed to the model for ONE source.
 *
 * Roughly two thousand English words: a full abstract with room left for a
 * substantial transcript sample. The single-source chat budget in `index.js`
 * is 48,000 characters, and it is right to be that generous there — one
 * source, one question. An episode trades depth per source for breadth across
 * them, because a host who can quote one paper at length and nothing else
 * produces a lecture with interruptions.
 */
export const MAX_SOURCE_CHARS = 8_000;

/**
 * Characters of material across ALL sources in one episode.
 *
 * The ceiling that actually matters, because the per-source budget alone
 * multiplies: twenty sources at 8,000 characters is 160,000, which no routed
 * model handles alongside the instructions and a long answer. 60,000 is the
 * conservative reading of a 128k-token window — the worst case is Chinese,
 * where a character costs about a token, so this is some 60k tokens of
 * material, leaving the instructions and a twenty-minute script (about 6,000
 * characters) comfortable headroom. A twenty-source episode therefore gets
 * 3,000 characters each, about one long abstract, which is the right shape for
 * a survey episode anyway.
 */
export const MAX_TOTAL_SOURCE_CHARS = 60_000;

/**
 * Below this, a transcript excerpt is not worth its budget.
 *
 * A few hundred sampled characters of speech is not concrete detail, it is
 * noise that displaces the summary already carrying the source's argument.
 */
const MIN_TRANSCRIPT_CHARS = 800;

/**
 * The same floor when the transcript is the ONLY body the source has.
 *
 * Far lower, because the reason above does not apply: nothing is being
 * displaced. A short excerpt of a video's own words beats the alternative,
 * which is a block saying the source has no body at all.
 */
const MIN_SOLE_TRANSCRIPT_CHARS = 200;

/** Characters per synthetic line when a cached transcript has no cues. */
const TEXT_CHUNK_CHARS = 400;

/**
 * Speaking rates, and the mapping from a target duration to a script length.
 *
 * Conversational Chinese runs about 300 characters a minute and conversational
 * English about 180 words a minute; both are ordinary podcast pacing rather
 * than news-reading pace, which is faster. So a twelve-minute Chinese episode
 * is roughly 3,600 characters of spoken text, and a twelve-minute English one
 * roughly 2,160 words.
 *
 * Japanese and Korean reuse the Chinese rate. It is an approximation — Korean
 * syllable blocks are not Han characters, and kana carry less meaning per
 * character than kanji — but the number only sizes a request, so being fifteen
 * percent out costs a slightly long or slightly short episode and nothing more.
 *
 * The default host names keep the A/B mnemonic in the script language. A
 * caller should pass its own for Japanese or Korean, where a Latin-script name
 * in otherwise Japanese dialogue reads as a foreign guest rather than a host.
 */
const LANGUAGES = {
  zh: { name: "Chinese", unit: "characters", perMinute: 300, hosts: ["安琪", "博文"] },
  ja: { name: "Japanese", unit: "characters", perMinute: 300, hosts: ["Alex", "Bailey"] },
  ko: { name: "Korean", unit: "characters", perMinute: 300, hosts: ["Alex", "Bailey"] },
  en: { name: "English", unit: "words", perMinute: 180, hosts: ["Alex", "Bailey"] },
};

/**
 * Average characters an English word occupies, including the space after it.
 *
 * The usual five-letters-plus-a-space convention, used only to turn a finished
 * character count back into an estimated duration.
 */
const EN_CHARS_PER_WORD = 6;

/** Default episode length when the caller names none. */
const DEFAULT_MINUTES = 12;

/**
 * Decide what language an episode should be written in.
 *
 * A script-counting heuristic over the assembled material: kana first, because
 * Chinese never uses kana and a Japanese sentence essentially always does;
 * then Hangul; then Han, which is what is left for Chinese. The ratios are
 * taken over letters rather than over all characters, so that URLs, digits and
 * punctuation — of which source metadata has plenty — do not dilute the count.
 *
 * The thresholds are deliberately low. Chinese technical writing quotes model
 * names, benchmark names and whole English sentences, and a fifteen percent
 * floor still catches that; a floor high enough to look "obviously" Chinese
 * would send a Chinese blog post about an English paper into English.
 *
 * Where it fails, and these are real:
 * - A row whose stored `aiSummary` was written in Chinese by an earlier
 *   enrichment pass tips an otherwise English source. The material decides,
 *   not the source — which is arguably the correct answer, since the material
 *   is what the model actually reads.
 * - Japanese written almost entirely in kanji, such as a title-only row with
 *   no body, carries no kana and is called Chinese.
 * - A mixed selection has no right answer at all. The majority wins and the
 *   minority source gets discussed in the other language. A caller who cares
 *   passes `options.language`, and then this is never consulted.
 * @param material - the assembled source material.
 * @returns a key of the language table: `'zh' | 'ja' | 'ko' | 'en'`.
 */
export function detectLanguage(material) {
  const text = String(material ?? "");
  const count = (pattern) => (text.match(pattern) ?? []).length;
  const letters = count(/\p{L}/gu);
  if (letters === 0) return "en";
  if (count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) / letters >= 0.05) return "ja";
  if (count(/\p{Script=Hangul}/gu) / letters >= 0.15) return "ko";
  if (count(/\p{Script=Han}/gu) / letters >= 0.15) return "zh";
  return "en";
}

/**
 * Estimated spoken duration of a finished script.
 *
 * The inverse of the mapping documented on the language table, kept here so
 * the two directions cannot drift apart. English arrives as a character count
 * like every other language, so it is divided back into words first.
 * @param chars - characters of spoken text.
 * @param language - a language key; anything unknown is treated as English.
 * @returns minutes, as a fractional number.
 */
export function estimateMinutes(chars, language = "en") {
  // Own properties only: `LANGUAGES["constructor"]` is not undefined, and a
  // language key that arrives from a request body can be any string at all.
  const profile = Object.hasOwn(LANGUAGES, language) ? LANGUAGES[language] : LANGUAGES.en;
  const units = profile.unit === "words" ? Number(chars) / EN_CHARS_PER_WORD : Number(chars);
  return units / profile.perMinute;
}

/** The first of several fields that actually carries text. */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * Keep lines spread across the whole recording rather than truncating.
 *
 * Cutting at the budget would hand the model the opening of a two-hour talk
 * and nothing else, and the hosts would then discuss the introduction as if it
 * were the argument. Sampling every nth line loses continuity within a passage
 * but keeps every part of the recording visible, which is the trade `index.js`
 * makes for the same reason in `fitTranscript`.
 * @param lines - the transcript lines, in order.
 * @param budget - characters available.
 * @returns `{ text, complete }`.
 */
function sampleLines(lines, budget) {
  const whole = lines.join("\n");
  if (whole.length <= budget) return { text: whole, complete: true };
  const step = Math.max(2, Math.round(whole.length / Math.max(1, budget)));
  const kept = lines.filter((_, index) => index % step === 0).join("\n").slice(0, budget);
  return { text: kept, complete: false };
}

/**
 * An excerpt of a cached transcript, within budget.
 *
 * Timestamps are dropped. The reader pane needs them to seek the player; a
 * podcast script never cites a playback offset, and at one label per cue they
 * would spend a tenth of the budget saying nothing.
 * @param transcript - a row as `SourceStore.getTranscript` returns it.
 * @param budget - characters available.
 * @returns `{ text, complete }`, or undefined when there is nothing usable.
 */
function transcriptExcerpt(transcript, budget) {
  const cues = Array.isArray(transcript?.cues) ? transcript.cues : [];
  let lines = cues
    .map((cue) => String(cue?.text ?? "").trim())
    .filter((text) => text !== "");
  if (lines.length === 0) {
    // The `cues` column was added after the first libraries were built, so an
    // older row holds joined text and nothing else. Fixed-size chunks are a
    // crude stand-in for cues, but they only have to be units the sampler can
    // spread across the recording, not sentences anybody reads whole.
    const text = String(transcript?.text ?? "").trim();
    if (text === "") return undefined;
    lines = [];
    for (let at = 0; at < text.length; at += TEXT_CHUNK_CHARS) {
      lines.push(text.slice(at, at + TEXT_CHUNK_CHARS));
    }
  }
  return sampleLines(lines, budget);
}

/** Whether a cached transcript carries any text at all, fitted or not. */
function hasBodyText(transcript) {
  const cues = Array.isArray(transcript?.cues) ? transcript.cues : [];
  if (cues.some((cue) => String(cue?.text ?? "").trim() !== "")) return true;
  return String(transcript?.text ?? "").trim() !== "";
}

/**
 * Assemble what the model is given for one source.
 *
 * The body is chosen in the order `aiSummary`, `abstract`, `content`.
 * `aiSummary` comes first because the enrichment pass wrote it against the
 * whole document, so it states what the source found; an abstract is the
 * publisher's own framing, and on a NEWS row it is frequently just the lede.
 * Both are far denser per character than raw body text, and density is exactly
 * what a budget shared across twenty sources is buying.
 *
 * A video is the exception, for the reason `buildResourceContext` gives: a
 * YouTube row usually carries no summary and no abstract, so its transcript IS
 * its content. Where a video does have a summary, the transcript still follows
 * it if the budget allows, because the summary states the conclusion while the
 * transcript holds the concrete detail — the number, the anecdote, the
 * sentence a host can quote — which is the difference between a conversation
 * and a recital.
 *
 * When no body reaches the block, it says so — and says which of the two
 * reasons it was, because they are different facts. "Nothing is stored" is
 * about the library; "it did not fit" is about this episode's budget, and a
 * model told the first when the second is true concludes the source is empty.
 * Either way the admission is what matters: a model handed a bare title with
 * no admission that the body is missing will fill the gap from whatever it
 * remembers about the title, and that is the failure this whole module is
 * written to avoid.
 * @param row - a stored `Resource`.
 * @param transcript - the cached transcript, when the row has one.
 * @param budget - characters this source may spend; defaults to {@link MAX_SOURCE_CHARS}.
 * @returns the material block, or an empty string when the row is unusable.
 */
export function sourceMaterial(row, transcript, budget = MAX_SOURCE_CHARS, options = {}) {
  if (row == null) return "";
  const title = firstText(row.title);
  if (title === "") return "";

  const lines = [`## ${title}`];
  const publication = firstText(row.sourceType, row.type);
  if (publication !== "") lines.push(`Publication: ${publication}`);
  const authors = Array.isArray(row.authors)
    ? row.authors.map((author) => author?.name ?? author?.username).filter(Boolean)
    : [];
  if (authors.length > 0) lines.push(`Authors: ${authors.slice(0, 6).join(", ")}`);
  // The date part only. A host says "back in March", never
  // "2025-03-04T00:00:00.000Z", and the time of day is budget spent on noise.
  const published = firstText(row.publishedAt);
  if (published !== "") lines.push(`Date: ${published.slice(0, 10)}`);
  const url = firstText(row.sourceUrl);
  if (url !== "") lines.push(`URL: ${url}`);

  const headerChars = lines.join("\n").length;
  let remaining = budget - headerChars;

  const summary = firstText(row.aiSummary, row.abstract, row.content);
  // A TRANSCRIBED VIDEO'S DESCRIPTION IS NOT EVIDENCE, and `spokenOnly` is how
  // a caller says so.
  //
  // MEASURED, TWICE. Told to prefer the transcript, the model quoted the
  // description anyway on 28 of 28 timestamp-less video quotes — verified by
  // searching each quote in its own transcript: none were there, none of those
  // videos lacked a transcript, and the locator was not at fault. A blurb is
  // polished, on-topic and 386 characters; a transcript is 7,610 characters of
  // conversational speech with the claim buried in it. An instruction does not
  // beat that, so the material does.
  //
  // WHAT IS LOST IS REAL AND IS THE POINT. A figure stated only in the show
  // notes becomes unquotable for this caller. That trade is right HERE and only
  // here: a claim quoted from a publisher's own marketing copy, shown under the
  // publisher's name with a link to the video, is weak provenance wearing
  // strong provenance's clothes — and it can never carry the moment that makes
  // a talk citable at all.
  //
  // AN OPTION RATHER THAN THE RULE, because the podcast generator needs the
  // description: it is writing ABOUT the video and the blurb is legitimate
  // context there. Same function, two callers, two jobs.
  const spokenOnly = options.spokenOnly === true && hasBodyText(transcript);
  let hasSummary = false;
  if (summary !== "" && remaining > 0 && !spokenOnly) {
    const fitted = summary.slice(0, remaining);
    lines.push("", fitted);
    remaining -= fitted.length + 2;
    hasSummary = true;
  }

  // Presence of a transcript is the test rather than the row's type: the store
  // only ever caches transcripts for videos, and a row typed YOUTUBE with
  // nothing fetched yet has no transcript to offer whatever its type says.
  //
  // Which floor applies depends on whether a summary went in above. Holding
  // the higher one unconditionally silenced the exact source that needs the
  // transcript most: a video row carries no summary, so a tight budget left it
  // with a header and a line claiming no body was stored, while the whole
  // transcript sat in the cache.
  let hasTranscript = false;
  if (remaining >= (hasSummary ? MIN_TRANSCRIPT_CHARS : MIN_SOLE_TRANSCRIPT_CHARS)) {
    // The label costs characters too, so it comes out of the budget rather
    // than pushing the block over it.
    const excerpt = transcriptExcerpt(transcript, remaining - 64);
    if (excerpt !== undefined) {
      // Say which it is, for the reason `buildResourceContext` gives: a model
      // told it holds the whole recording will speak for the parts it was
      // never given.
      lines.push("", excerpt.complete
        ? "Transcript (complete):"
        : "Transcript (excerpt, sampled across the whole recording):", excerpt.text);
      hasTranscript = true;
    }
  }

  // A `spokenOnly` block whose transcript did not fit is not a block with no
  // body: the transcript is there and the budget was too small. Saying "no body
  // text is stored" would send whoever reads it to fix the wrong thing.
  if (spokenOnly && !hasTranscript) {
    lines.push("", "This source has a transcript but it did not fit the space allowed, so only the details above are given.");
    return lines.join("\n");
  }
  if (!hasSummary && !hasTranscript) {
    lines.push("", summary !== "" || hasBodyText(transcript)
      ? "Body text is stored for this source but did not fit the space this episode allows, so only the details above are given. Nothing beyond them is known here."
      : "No body text is stored for this source. Only the title and the details above are known about it.");
  }
  return lines.join("\n");
}

/** Normalise a caller's sources into `{ row, transcript }` entries. */
function asEntries(sources) {
  const list = Array.isArray(sources) ? sources : [];
  // A caller holding the store passes `{ row, transcript }`; one that has only
  // rows passes rows. Accepting both keeps this module free of the store
  // without making every caller wrap.
  return list
    .map((entry) => (entry?.row === undefined ? { row: entry, transcript: undefined } : entry))
    .filter((entry) => entry.row != null);
}

/**
 * The material block for every usable source, within the shared ceiling.
 *
 * Extracted because two callers need it and they have to agree: the prompt
 * names the language the episode must be written in, and `generateScript`
 * reports which language that was. One definition assembled twice is cheap
 * next to the model call; two definitions mean the page eventually offers
 * English voices for a Chinese script.
 * @param sources - `[{ row, transcript }]`, or bare rows.
 * @returns `{ blocks, material }`.
 */
export function assembleMaterial(sources, options = {}) {
  const entries = asEntries(sources);
  if (entries.length === 0) throw new Error("an episode needs at least one source");

  // Divide the shared ceiling evenly rather than letting the first sources
  // spend it: an episode whose last five sources arrived empty would still
  // look complete in the prompt, and only the finished script would show that
  // half the selection was never discussed.
  const perSource = Math.max(
    500,
    Math.min(MAX_SOURCE_CHARS, Math.floor(MAX_TOTAL_SOURCE_CHARS / entries.length)),
  );
  const blocks = entries
    .map((entry) => sourceMaterial(entry.row, entry.transcript, perSource, options))
    .filter((block) => block !== "");
  if (blocks.length === 0) throw new Error("none of the selected sources carry a usable title");
  return { blocks, material: blocks.join("\n\n") };
}

/**
 * The language key an episode will actually be written in.
 *
 * A caller's choice wins, but only when it names a language this module has a
 * profile for. Own properties only: `LANGUAGES["constructor"]` is not
 * undefined, and a language field arriving from a request body can be any
 * string at all. Anything else falls back to detection over the material.
 * @param requested - the caller's `options.language`, whatever it is.
 * @param material - the assembled source material.
 * @returns a key of the language table.
 */
function languageCode(requested, material) {
  return Object.hasOwn(LANGUAGES, requested) ? requested : detectLanguage(material);
}

/**
 * The prompt asking for one episode.
 *
 * The instructions are written in English even when the episode is Chinese.
 * Naming the target language explicitly is reliable, whereas writing the whole
 * prompt in the target language invites the model to echo the prompt's own
 * register back in the dialogue; the rest of this plugin prompts in English
 * for the same reason.
 * @param sources - `[{ row, transcript }]`, or bare rows.
 * @param options - `{ minutes, language, hostA, hostB, focus }`; `language` is
 *   a language key, and anything else means detect it from the material.
 * @returns the user prompt.
 */
export function buildPrompt(sources, options = {}) {
  const { blocks, material } = assembleMaterial(sources);
  const profile = LANGUAGES[languageCode(options.language, material)];
  // Coerced, because a minutes field arriving from a JSON body is as likely to
  // be "10" as 10, and silently returning a twelve-minute episode to a caller
  // who asked for ten is worse than either honouring it or refusing it.
  const asked = Number(options.minutes);
  const minutes = Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_MINUTES;
  const target = Math.round(minutes * profile.perMinute);
  const hostA = firstText(options.hostA) || profile.hosts[0];
  const hostB = firstText(options.hostB) || profile.hosts[1];
  const focus = firstText(options.focus);

  return [
    `Write the script for a podcast episode about the ${blocks.length} source${blocks.length === 1 ? "" : "s"} below.`,
    "",
    `Write every line in ${profile.name}. The sources are in ${profile.name} and the episode must be too, the title included.`,
    "",
    "Two hosts, and they are different people:",
    `- ${hostA} (speaker "a") opens the episode, frames why any of this matters, and asks the questions a curious outsider would ask. ${hostA} has not read the sources.`,
    `- ${hostB} (speaker "b") has read them and explains them, with the specifics. ${hostB} pushes back when ${hostA} overstates something, and says plainly when a source claims less than its headline does.`,
    "",
    `Length: about ${minutes} minutes of speech, which is roughly ${target} ${profile.unit} of spoken text across all turns together. Do not come in far under that; a thin episode is the usual failure.`,
    "",
    "How it has to read:",
    "- A conversation, not a summary read aloud. Questions, answers that get interrupted, one host saying that is not what the paper says. If a turn could be lifted out and printed as a paragraph of an article, rewrite it.",
    "- Real disagreement at least once: a claim one host finds unconvincing, or two sources that contradict each other and the hosts having to sit with it.",
    "- Concrete detail throughout: the actual number, the actual method, the name of the model or the team, what was measured and against what. Vague enthusiasm is worse than silence.",
    "- Where the sources connect, connect them out loud. Where they were selected together but have nothing to do with each other, say that too.",
    "- Never state anything that is not in the material below. No remembered background, no plausible-sounding figures, no dates you were not given. If something obvious is missing, one host says the sources do not cover it, and that line is better than a guess.",
    "- Open with a hook: a specific claim, number, or tension from the sources, inside the first two turns. Not a greeting, not a table of contents.",
    "- Close with a takeaway a listener could repeat to somebody else the next day.",
    "- One turn is one person speaking, a few sentences at most, and the hosts alternate. Neither takes two turns in a row.",
    "- Spoken words only: no stage directions, no sound effects, no bracketed laughter, no speaker labels inside the text, no markdown.",
    ...(focus === "" ? [] : ["", `The listener asked for this angle in particular, so build the episode around it: ${focus}`]),
    "",
    'Answer with ONLY a JSON object of exactly this shape: {"title": "...", "turns": [{"speaker": "a", "text": "..."}, {"speaker": "b", "text": "..."}]}',
    '- "speaker" is exactly "a" or "b" — the role, never the host\'s name.',
    "- No fence, and no commentary before or after the object.",
    "",
    "Sources:",
    "",
    material,
  ].join("\n");
}

/** Candidate objects to try before giving up on an answer. */
const MAX_OBJECT_SCANS = 8;

/**
 * The index of the brace that closes the one at `start`, honouring strings.
 *
 * Counting braces without tracking string literals breaks on the first turn
 * whose text contains one, and dialogue about JSON or APIs contains plenty.
 * @param source - the answer being scanned.
 * @param start - index of the opening brace.
 * @returns the closing index, or -1 when the object never closes.
 */
function matchingBrace(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < source.length; at += 1) {
    const char = source[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/**
 * Pull the outer JSON object out of a model answer.
 *
 * `translate.js` gets away with first-bracket-to-last-bracket because its
 * payload is an array of short strings. Here the payload is dialogue, which
 * contains braces, and any prose wrapped around the answer contains them too,
 * so the scan walks candidates properly and tries each one. Only the first few
 * are tried: an answer full of braces would otherwise be quadratic, and an
 * answer whose eighth candidate object is the real script is not one worth
 * rescuing.
 *
 * The first parseable object is not necessarily the right one, and neither is
 * the first one carrying a `turns` array. A model that restates the schema
 * before answering emits the prompt's own example, and
 * `{"title": "...", "turns": [{"speaker": "a", "text": "..."}, ...]}` parses,
 * validates, and survives every check downstream — a two-turn episode titled
 * "..." that nothing else can tell from a real one. So every candidate is
 * scanned and the one with the most turns wins; a schema echo is always the
 * short one.
 *
 * A candidate that carries neither a `title` nor `turns` is not a script and
 * is not kept as a fallback either. That matters for the commonest failure of
 * all: an answer cut off by the output limit leaves its outer brace unclosed,
 * and the first thing that DOES close inside it is a single turn. Accepting
 * that as the answer reported a truncated script as one missing its title.
 * @param text - the model's answer.
 * @returns the parsed object, or undefined when none can be read.
 */
function extractJsonObject(text) {
  const source = String(text ?? "");
  let best;
  let fallback;
  let from = 0;
  for (let attempt = 0; attempt < MAX_OBJECT_SCANS; attempt += 1) {
    const start = source.indexOf("{", from);
    if (start === -1) break;
    const end = matchingBrace(source, start);
    if (end !== -1) {
      try {
        const parsed = JSON.parse(source.slice(start, end + 1));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          if (Array.isArray(parsed.turns)) {
            if (best === undefined || parsed.turns.length > best.turns.length) best = parsed;
          } else if (fallback === undefined && typeof parsed.title === "string") {
            fallback = parsed;
          }
        }
      } catch {
        // Not the object being looked for; the next candidate may be.
      }
    }
    from = start + 1;
  }
  return best ?? fallback;
}

/**
 * Speaker spellings tolerated beyond the two the prompt asks for.
 *
 * Kept short on purpose. These are the forms a model emits when it paraphrases
 * the schema; anything further away means the answer did not follow the schema
 * at all, and guessing which host was meant would hand one person's lines to
 * the other voice without anything downstream noticing.
 */
const SPEAKER_ALIASES = new Map([
  ["a", "a"], ["b", "b"],
  ["hosta", "a"], ["hostb", "b"],
  ["speakera", "a"], ["speakerb", "b"],
]);

/** The role a turn names, or undefined when it names something else. */
function normalizeSpeaker(value) {
  const key = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return SPEAKER_ALIASES.get(key);
}

/**
 * Read a script out of a model answer.
 *
 * Strict on purpose. Half a script is worse than none, because the failure
 * then surfaces at the speech stage, or in front of a listener, as an episode
 * that stops mid-sentence or has one host reading both parts. Every rejection
 * names what was actually wrong, so the caller can decide whether a retry has
 * any chance.
 * @param answer - the accumulated model answer.
 * @returns `{ title, turns }`, turns normalised to `{ speaker, text }`.
 */
export function parseScript(answer) {
  const source = String(answer ?? "").trim();
  if (source === "") throw new Error("the model returned an empty answer");

  const object = extractJsonObject(source);
  if (object === undefined) {
    // An answer cut off by the output limit is the common case, and it looks
    // exactly like this: an opening brace, plenty of turns, and no close.
    const hint = source.includes("{")
      ? "its JSON object never closes, which is what a cut-off answer looks like"
      : "it contains no JSON object at all";
    throw new Error(`the model did not return a script: ${hint}`);
  }

  const title = typeof object.title === "string" ? object.title.trim() : "";
  if (title === "") throw new Error("the script has no title");
  if (!Array.isArray(object.turns)) throw new Error("the script has no turns array");
  if (object.turns.length < 2) {
    throw new Error(`a dialogue needs at least two turns; the script has ${object.turns.length}`);
  }

  const turns = [];
  for (const [index, turn] of object.turns.entries()) {
    const speaker = normalizeSpeaker(turn?.speaker);
    if (speaker === undefined) {
      throw new Error(`turn ${index + 1} names speaker ${JSON.stringify(turn?.speaker ?? null)}; expected "a" or "b"`);
    }
    const text = typeof turn?.text === "string" ? turn.text.trim() : "";
    if (text === "") throw new Error(`turn ${index + 1} (speaker ${speaker}) has no text`);
    turns.push({ speaker, text });
  }
  return { title, turns };
}

/**
 * Characters of answer accepted before the stream is abandoned.
 *
 * A twenty-minute script is some 6,000 characters of speech, so a whole answer
 * including its JSON is well under 50,000; two million is far past anything
 * real. The bound exists because the failure it catches is not a long answer
 * but a model that starts repeating a turn and does not stop, and this runs
 * inside an HTTP handler — an unbounded accumulation there takes the server
 * down rather than failing the one request.
 */
const MAX_ANSWER_CHARS = 2_000_000;

/**
 * Generate one episode script.
 *
 * The stream is accumulated whole before anything is parsed, because a JSON
 * object cannot be read until it closes; there is no partial script to show
 * along the way. A caller that wants progress has to watch the deltas itself
 * rather than expect this to yield them.
 * @param chat - the streaming chat entry point from `createChat`.
 * @param sources - `[{ row, transcript }]`, or bare rows.
 * @param options - as {@link buildPrompt}, passed straight through.
 * @returns `{ title, turns, chars, language, estimatedMinutes }`, where
 *   `chars` counts spoken text only and `estimatedMinutes` is that count read
 *   back through the speaking rate for `language`.
 */
export async function generateScript(chat, sources, options = {}) {
  const prompt = buildPrompt(sources, options);
  let answer = "";
  let failure = "";
  for await (const chunk of chat({ prompt, context: "" })) {
    if (typeof chunk.text === "string") answer += chunk.text;
    if (typeof chunk.error === "string") failure = chunk.error;
    if (answer.length > MAX_ANSWER_CHARS) {
      throw new Error(`the model wrote past ${MAX_ANSWER_CHARS} characters without finishing its JSON object`);
    }
  }
  // The model's own error wins over any complaint about the answer: "context
  // length exceeded" tells the caller what to change, "the model returned an
  // empty answer" does not.
  if (failure !== "") throw new Error(failure);

  const { title, turns } = parseScript(answer);

  // Two turns by the same host in a row are joined into one. The speech stage
  // renders a turn as an audio segment, so leaving them apart drops a pause
  // into the middle of one person's thought. Joining is a formatting fix, not
  // a rewrite: no word a listener hears changes.
  const merged = [];
  for (const turn of turns) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.speaker === turn.speaker) {
      previous.text = `${previous.text} ${turn.text}`;
    } else {
      merged.push({ ...turn });
    }
  }
  // After merging, a script that never changes speaker collapses to a single
  // turn. That is a monologue wearing a dialogue's schema, and it is a real
  // failure mode: it means the model wrote the summary this module exists to
  // refuse.
  if (merged.length < 2) {
    throw new Error("the script never changes speaker; it is a monologue, not a dialogue");
  }
  const speakers = new Set(merged.map((turn) => turn.speaker));
  if (speakers.size < 2) throw new Error(`only speaker "${[...speakers][0]}" has any lines`);

  const chars = merged.reduce((total, turn) => total + turn.text.length, 0);
  // The language is reported, not just used: it decides which voices the page
  // should offer, and a Chinese script rendered in an English voice is a
  // failure nobody notices until they press play. The estimate is reported
  // separately from the requested length because they differ — the model
  // writes to a target it does not measure — and the reader deciding whether
  // to spend forty synthesis calls wants the length that will actually play.
  // Over the MATERIAL, not the prompt: the instructions are English, and
  // detecting over them would call every episode English.
  const language = languageCode(options.language, assembleMaterial(sources).material);
  return {
    title,
    turns: merged,
    chars,
    language,
    estimatedMinutes: Number(estimateMinutes(chars, language).toFixed(1)),
  };
}
