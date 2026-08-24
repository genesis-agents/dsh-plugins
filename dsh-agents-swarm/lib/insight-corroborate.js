/**
 * Go looking for the second source.
 *
 * The pass as first built was a closed world: it read the library, clustered
 * what happened to be in one slice, and asked whether the same story appeared
 * twice. Measured on the real library that produced seven claims, every one of
 * them `candidate` with one source and one independent source — nothing
 * reached the two-independent-source threshold, so the tab would have been
 * empty by construction.
 *
 * That is not a data problem. "Are multiple independent sources reporting
 * this?" cannot be answered from a slice of what a feed reader happened to
 * fetch; it is a question you answer by going to look. None of the comparable
 * systems treat their corpus as closed either — Feedly scans a hundred million
 * articles a day against its cards, and the analyst platforms are retrieval
 * engines with citations attached.
 *
 * So a candidate claim goes out and searches:
 *
 *   arXiv        always available, no key, no plugin, and the right index for
 *                a research finding, which is most of what this library holds
 *   ctx.web      when `dsh-web-search` is installed — reached through
 *                `ctx.get("web")` rather than `inject`, so the search plugin
 *                stays optional and this one still loads without it
 *
 * A hit only counts when it is INDEPENDENT — a different host from every
 * source already cited. Five rewrites of one wire story are one source, and a
 * corroboration step that forgot this would manufacture exactly the false
 * confidence the momentum test exists to prevent.
 *
 * And a hit only becomes evidence when it carries a verbatim quote from the
 * page's OWN text, fetched and extracted here, checked by the same span rule
 * as everything else. A search snippet is not that: engines truncate,
 * re-order, and interpolate ellipses, so a snippet that verifies proves the
 * engine's formatting rather than the publisher's words.
 */

import { fetchDocument, readArticle } from "./proxy.js";
import { normalizeForQuote, verifyQuote } from "./insights.js";

/** How many search hits to consider for one claim, before independence filtering. */
const HITS_PER_CLAIM = 6;

/** How many pages to actually fetch and read for one claim. Fetching is the slow part. */
const READS_PER_CLAIM = 3;

/** Characters of fetched article text handed to the model per candidate source. */
const READ_BUDGET_CHARS = 4000;

/** arXiv's public API. No key, no account, and it is the right index for a finding. */
const ARXIV_API = "https://export.arxiv.org/api/query";

/**
 * Words too common to help a search engine find anything.
 *
 * Deliberately short. A long stop list starts removing the terms that make a
 * claim findable — "model", "policy" and "release" are noise in general and
 * are exactly the subject here.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "that", "this", "it", "its", "has", "have", "had", "will", "would", "can",
  "could", "said", "says", "than", "then", "into", "over", "after", "before",
]);

/**
 * Turn a claim into something a search engine can match.
 *
 * Not the statement itself: a claim written to be specific enough to be wrong
 * is a sentence no other outlet wrote, and searching for it verbatim returns
 * the one article it came from. What travels between sources is the entities
 * and the distinctive terms, so those are what go in.
 *
 * @param insight - a stored insight row with `statement` and `entities`.
 * @returns `{ web, arxiv }`, either of which may be "" when there is nothing to ask.
 */
export function buildQueries(insight) {
  const statement = String(insight?.statement ?? "").trim();
  const entities = Array.isArray(insight?.entities)
    ? insight.entities.map((entity) => String(entity ?? "").trim()).filter((entity) => entity !== "")
    : [];

  // Rare-ish terms: capitalised words, anything with a digit, and long words.
  // Numbers matter more than they look — "$3.5bn", "O(1/k^3)", "161 tasks" are
  // the parts of a claim another source has to agree with.
  const terms = [];
  for (const raw of statement.split(/[^\p{L}\p{N}$%./^()-]+/u)) {
    const word = raw.replace(/^[.\-]+|[.\-]+$/gu, "");
    if (word.length < 3) continue;
    const lower = word.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    const distinctive = /\d/u.test(word) || /^\p{Lu}/u.test(word) || word.length > 8;
    if (distinctive && !terms.includes(word)) terms.push(word);
    if (terms.length >= 8) break;
  }

  const head = entities.slice(0, 3);
  const tail = terms.filter((term) => !head.some((entity) => entity.includes(term))).slice(0, 5);
  const web = [...head, ...tail].join(" ").trim();

  // arXiv's `all:` field with quoted entities: its query language is not
  // Google's, and an unquoted multi-word entity is read as separate terms
  // joined by an implicit OR, which returns the whole category.
  const arxiv = [...head, ...tail.slice(0, 3)]
    .map((term) => (term.includes(" ") ? `"${term}"` : term))
    .map((term) => `all:${term}`)
    .join(" AND ")
    .trim();

  return { web, arxiv };
}

/** The host of a URL, lowercased and without `www.`, or "" when it will not parse. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Whether a hit is a source this claim does not already rest on.
 *
 * By HOST, not by URL. Two articles on the same site are the same source
 * however different their paths, and counting them separately is how the
 * momentum test starts reporting confidence that nobody earned.
 *
 * @param url - the hit's URL.
 * @param known - hosts and source keys already cited by this claim.
 * @returns true when the hit adds a genuinely new source.
 */
export function isIndependent(url, known) {
  const host = hostOf(url);
  if (host === "") return false;
  for (const seen of known) {
    const other = String(seen ?? "").toLowerCase();
    if (other === "") continue;
    if (other === host) return false;
    // A stored source_key is often an outlet name rather than a host
    // ("Reuters", "arXiv cs.AI"). Comparing both ways catches the common case
    // without pretending this is exact.
    const bare = host.replace(/\.(com|org|net|io|ai|co\.uk)$/u, "");
    if (other.includes(bare) || bare.includes(other.replace(/\s+/gu, ""))) return false;
  }
  return true;
}

/** Parse arXiv's Atom answer into hits. Its API returns XML and no key is needed. */
function parseArxiv(xml) {
  const hits = [];
  for (const entry of String(xml).split("<entry>").slice(1)) {
    const pick = (tag) => {
      const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "u").exec(entry);
      return match === null ? "" : match[1].replace(/\s+/gu, " ").trim();
    };
    const id = pick("id");
    if (id === "") continue;
    hits.push({
      url: id,
      title: pick("title"),
      snippet: pick("summary").slice(0, 400),
      source: "arxiv",
    });
  }
  return hits;
}

/**
 * Ask arXiv. Always available: no key, no plugin, no account.
 * @param query - an arXiv query string from `buildQueries`.
 * @param options - `{ maxResults, fetchImpl }`.
 * @returns hits, or an empty array on any failure.
 */
export async function searchArxiv(query, options = {}) {
  const q = String(query ?? "").trim();
  if (q === "") return [];
  const max = Math.max(1, Math.min(20, Number(options.maxResults) || HITS_PER_CLAIM));
  const call = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(q)}&max_results=${max}&sortBy=relevance`;
  try {
    const response = await call(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return [];
    return parseArxiv(await response.text());
  } catch {
    // A search that cannot be reached is not a claim that fails; the caller
    // reports how many backends answered so a run with none is legible.
    return [];
  }
}

/**
 * Ask the `ctx.web` seam, when something is registered in it.
 * @param web - the service from `ctx.get("web")`, or undefined.
 * @param query - a plain search query.
 * @param options - `{ maxResults }`.
 * @returns hits, or an empty array when there is no seam or it fails.
 */
export async function searchWeb(web, query, options = {}) {
  const q = String(query ?? "").trim();
  if (q === "" || web === undefined || typeof web.search !== "function") return [];
  const max = Math.max(1, Math.min(20, Number(options.maxResults) || HITS_PER_CLAIM));
  try {
    const answer = await web.search({ query: q, maxResults: max });
    const rows = Array.isArray(answer) ? answer : (answer?.results ?? []);
    return rows
      .map((row) => ({
        url: String(row?.url ?? row?.link ?? ""),
        title: String(row?.title ?? ""),
        snippet: String(row?.snippet ?? row?.description ?? "").slice(0, 400),
        source: "web",
      }))
      .filter((hit) => hit.url !== "");
  } catch {
    return [];
  }
}

/**
 * Fetch a hit and extract what the publisher actually wrote.
 *
 * The snippet is not used. Engines truncate mid-sentence, join fragments with
 * ellipses and sometimes rewrite for length, so a quote verified against a
 * snippet certifies the engine's formatting rather than the publisher's words
 * — the same mistake as verifying against a sampled transcript, one layer out.
 *
 * @param hit - a search hit.
 * @param options - `{ fetchImpl }`.
 * @returns `{ url, title, text }`, or undefined when nothing readable came back.
 */
export async function readHit(hit, options = {}) {
  const url = String(hit?.url ?? "");
  if (url === "") return undefined;
  try {
    const doc = typeof options.fetchImpl === "function"
      ? await options.fetchImpl(url)
      : await fetchDocument(url);

    // A string means a test handed the HTML straight in. Otherwise it is
    // `fetchDocument`'s `{status, contentType, body}`, and both of the first
    // two matter: a 404 page and a PDF both produce text that Readability will
    // happily "extract", and a quote verified against an error page reads
    // exactly like a quote verified against an article.
    let html = "";
    if (typeof doc === "string") {
      html = doc;
    } else if (doc !== undefined && doc !== null) {
      const status = Number(doc.status ?? 200);
      if (status < 200 || status >= 300) return undefined;
      const type = String(doc.contentType ?? "");
      if (type !== "" && !/html|xml|text\/plain/u.test(type)) return undefined;
      const body = doc.body;
      html = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? doc.text ?? "");
    }
    if (html === "") return undefined;

    const article = await readArticle(html, url);
    const text = String(article?.text ?? "").trim();
    // Below this a page is a paywall notice, a cookie wall or a stub, and
    // nothing quotable came back however cleanly it parsed.
    if (normalizeForQuote(text).length < 200) return undefined;
    return { url, title: String(hit.title ?? article?.title ?? ""), text: text.slice(0, READ_BUDGET_CHARS) };
  } catch {
    return undefined;
  }
}

/** The prompt that judges fetched pages against one claim. */
export const CORROBORATION_PROMPT = `You are checking one claim against sources that were found by searching for it. The sources were NOT written to answer the claim; most will be about something adjacent and the honest answer for those is "unrelated".

CLAIM:
{CLAIM}

SOURCES:
{SOURCES}

For each source, decide one of:
- supports    — the source states the same thing the claim states
- contradicts — the source states something that cannot both be true with the claim
- unrelated   — anything else, including "about the same subject but says nothing about this claim"

Answer in JSON and nothing else:

{"verdicts":[{"source":"S1","stance":"supports","quote":"…"}]}

Rules that decide whether an answer is used at all:
- The quote must be copied CHARACTER FOR CHARACTER from that source's text above. It is checked as a literal substring and a quote that is not found is discarded along with the verdict.
- The quote must be one continuous run of text from one place. Do not join two passages.
- Quote the sentence that does the supporting or contradicting, not the headline.
- Omit a source entirely rather than guessing. "unrelated" needs no quote.
- Write nothing outside the JSON.`;

/**
 * Look for independent corroboration of one candidate claim.
 *
 * @param insight - the stored insight, with `evidence` already loaded.
 * @param options - `{ web, chat, knownSources, fetchImpl, maxReads }`.
 * @returns `{ searched, hits, independent, read, verdicts, evidence, reason }`.
 */
export async function corroborateOne(insight, options = {}) {
  const queries = buildQueries(insight);
  if (queries.web === "" && queries.arxiv === "") {
    return { searched: 0, hits: 0, independent: 0, read: 0, verdicts: 0, evidence: [], reason: "nothing distinctive enough to search for" };
  }

  const backends = [];
  const found = [];
  const arxiv = await searchArxiv(queries.arxiv, { fetchImpl: options.fetchImpl });
  if (arxiv.length > 0) backends.push("arxiv");
  found.push(...arxiv);
  const web = await searchWeb(options.web, queries.web);
  if (web.length > 0) backends.push("web");
  found.push(...web);

  if (found.length === 0) {
    // Naming which backends were even available is the difference between "no
    // corroboration exists" and "nothing was asked", which look identical in a
    // count of zero.
    const available = options.web === undefined ? "arxiv only" : "arxiv and the web seam";
    return { searched: backends.length, hits: 0, independent: 0, read: 0, verdicts: 0, evidence: [], reason: `no hits from ${available}` };
  }

  const known = new Set(options.knownSources ?? []);
  const fresh = [];
  const seenHosts = new Set();
  for (const hit of found) {
    if (!isIndependent(hit.url, known)) continue;
    const host = hostOf(hit.url);
    if (seenHosts.has(host)) continue;      // one page per host, per claim
    seenHosts.add(host);
    fresh.push(hit);
  }
  if (fresh.length === 0) {
    return { searched: backends.length, hits: found.length, independent: 0, read: 0, verdicts: 0, evidence: [], reason: "every hit came from a source this claim already cites" };
  }

  const maxReads = Math.max(1, Math.min(6, Number(options.maxReads) || READS_PER_CLAIM));
  const pages = [];
  for (const hit of fresh.slice(0, maxReads)) {
    const page = await readHit(hit, options);
    if (page !== undefined) pages.push(page);
  }
  if (pages.length === 0) {
    return { searched: backends.length, hits: found.length, independent: fresh.length, read: 0, verdicts: 0, evidence: [], reason: "none of the independent hits could be fetched and read" };
  }

  const chat = options.chat;
  if (typeof chat !== "function") {
    return { searched: backends.length, hits: found.length, independent: fresh.length, read: pages.length, verdicts: 0, evidence: [], reason: "no model routed, so nothing could be judged" };
  }

  const blocks = new Map();
  const labels = new Map();
  const rendered = pages.map((page, index) => {
    const label = `S${index + 1}`;
    labels.set(label, page.url);
    blocks.set(page.url, `[${label}]\n${page.text}`);
    return `[${label}] ${page.title}\n${page.text}`;
  });

  const prompt = CORROBORATION_PROMPT
    .replace("{CLAIM}", () => String(insight?.statement ?? ""))
    .replace("{SOURCES}", () => rendered.join("\n\n"));

  let answer = "";
  try {
    for await (const chunk of chat({ prompt, context: "" })) answer += String(chunk ?? "");
  } catch (cause) {
    return { searched: backends.length, hits: found.length, independent: fresh.length, read: pages.length, verdicts: 0, evidence: [], reason: `the model refused: ${String(cause?.message ?? cause)}` };
  }

  let parsed;
  try {
    const start = answer.indexOf("{");
    const end = answer.lastIndexOf("}");
    parsed = start === -1 || end <= start ? { verdicts: [] } : JSON.parse(answer.slice(start, end + 1));
  } catch {
    return { searched: backends.length, hits: found.length, independent: fresh.length, read: pages.length, verdicts: 0, evidence: [], reason: "the model answered with something that is not JSON" };
  }

  const evidence = [];
  for (const verdict of Array.isArray(parsed?.verdicts) ? parsed.verdicts : []) {
    const stance = String(verdict?.stance ?? "");
    if (stance !== "supports" && stance !== "contradicts") continue;
    const url = labels.get(String(verdict?.source ?? ""));
    if (url === undefined) continue;
    // The same span rule as everything else, against the text fetched HERE.
    const check = verifyQuote(String(verdict?.quote ?? ""), blocks, url);
    if (!check.ok) continue;
    evidence.push({ url, host: hostOf(url), stance, quote: String(verdict.quote) });
  }

  return {
    searched: backends.length,
    hits: found.length,
    independent: fresh.length,
    read: pages.length,
    verdicts: Array.isArray(parsed?.verdicts) ? parsed.verdicts.length : 0,
    evidence,
    reason: evidence.length === 0 ? "nothing that was read either supported or contradicted the claim" : "",
  };
}
