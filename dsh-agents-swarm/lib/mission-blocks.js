/**
 * One builder for the text a quote is checked against.
 *
 * `verifyQuote` in insights.js takes a MAP of blocks and an attributed id, and
 * it is strict on purpose: a quote must sit inside ONE contiguous span of the
 * block it was attributed to. That strictness is only worth anything if every
 * caller builds its block the SAME way. Two builders — one splitting a page on
 * blank lines, one handing over the whole document as a single string — give
 * two different answers to the same question, and the loose one degrades the
 * splice guard into a plain substring check without saying so.
 *
 * WHY THIS IS A MODULE OF ITS OWN, AND NOT A CHANGE TO insights.js:
 * the design asks `verifyQuote` to refuse an untagged block. `verifyQuote` is
 * shared with the standing-insight pass, which builds its blocks from
 * `sourceMaterial` and has no tags at all — teaching it to refuse would break a
 * pass that works. So the TAG lives here and the assertion lives at the call
 * site: s9 checks `block.tag` before it verifies anything, and an untagged block
 * means this builder was bypassed.
 *
 * @see docs/insight-mission.md §3.6 — the quote is checked against one span.
 */

import { MIN_DOCUMENT_CHARS } from "./mission-store.js";

/**
 * What a block's text is, and therefore what a successful match earns.
 *
 * `source-text` is a page we fetched and stored ourselves: a quote verified
 * against it is `verified-source-text`, the one state that counts toward every
 * floor. `empty` is a row with nothing quotable in it, and it is a tag rather
 * than a null so a caller cannot mistake "we hold this page and it is blank"
 * for "we do not hold this page".
 *
 * There is deliberately no `abstract` member yet. `VERIFY_STATES` has
 * `verified-abstract` for a quote checked against a publisher's abstract rather
 * than a page we fetched, but nothing in the pipeline produces one today —
 * adding the tag before the builder would put a value in this list that no
 * block can ever carry, which is the kind of vocabulary that reads as supported
 * for as long as nobody tries it.
 */
export const BLOCK_TAGS = Object.freeze(["source-text", "empty"]);

/**
 * Build the one block for a stored document.
 *
 * The text is the stored MARKDOWN, untouched. Markdown keeps the blank lines
 * between paragraphs, and those blank lines are exactly what `quotableSpans`
 * splits on — hand it the plain text instead and the whole document becomes one
 * span, at which point a "quote" spliced from two paragraphs three screens
 * apart verifies cleanly. The measured paragraph-crossing rate is ZERO, so
 * keeping the rule strict costs nothing and buys the guarantee.
 *
 * @param row - a shaped `mission_documents` row, as `store.getDocument` returns.
 * @returns `{ id, text, tag, url, admissible, why }` — `why` says what the tag means.
 */
export function blockFor(row) {
  if (row === null || row === undefined || typeof row !== "object") {
    throw new TypeError("blockFor needs a shaped mission_documents row (store.getDocument's answer), not an id or a string. A block built from a bare string carries no tag and no address, and the address is what a reader opens.");
  }

  // Keyed by the document's own URL rather than its hash id. `verifyQuote`
  // reports the attributed id straight back, and the attribution is stored on
  // the finding — so the key has to be the address a reader can open, not a
  // sixteen-character digest nobody can resolve.
  const id = typeof row.url === "string" && row.url !== "" ? row.url : String(row.id ?? "");
  const text = typeof row.markdown === "string" ? row.markdown : "";
  const status = Number(row.status);
  const chars = text.replace(/\s+/gu, " ").trim().length;

  if (text === "") {
    return {
      id,
      text: "",
      tag: "empty",
      url: row.url ?? null,
      admissible: false,
      why: "the stored page has no body text, so nothing in it can be quoted",
    };
  }

  // `admissible` is precomputed by the store and repeated here rather than
  // trusted blindly: a caller that built the row by hand (a test, a repair
  // script) would otherwise carry an absent field into a verified state.
  const admissible = Number.isFinite(status) && status >= 200 && status < 300 && chars >= MIN_DOCUMENT_CHARS;

  return {
    id,
    text,
    tag: "source-text",
    url: row.url ?? null,
    admissible,
    why: admissible
      ? "a fetched page we hold in full; a quote inside one of its spans is verified-source-text"
      : `held, but ${Number.isFinite(status) ? status : "an unknown status"} with ${chars} normalised characters cannot back a verified state (${MIN_DOCUMENT_CHARS} required)`,
  };
}
