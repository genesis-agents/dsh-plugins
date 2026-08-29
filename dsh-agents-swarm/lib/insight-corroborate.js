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

/**
 * Characters of fetched article text handed to the model PER CANDIDATE SOURCE,
 * on the corroboration path — three pages per claim, all three in one prompt.
 *
 * IT IS THIS PATH'S BUDGET AND NOT A PROPERTY OF READING A PAGE, which is what
 * it had silently become. `fetch_page` calls the same `readHit` and inherited
 * it, so every page a researcher fetched arrived cut to 4,000 characters —
 * about seven hundred words, the first screen of an article — and that string
 * is not just what the model read. It is `quotableAgainst`, it is what
 * `quote_verify` checks literal substrings of, and it is what `putDocument`
 * stores as the page we kept. A verified quote could only ever come from the
 * opening of a source, a report of 31,450 words was written from 101 first
 * screens, and nothing anywhere said so.
 *
 * The tool layer's own ceiling for a `fetch_page` result is MAX_RESULT_CHARS,
 * 32,000, and the tool declares it. An eight-fold gap between the ceiling a
 * tool declares and what its reader hands back.
 */
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
 * Serialised, spaced calls to a host that asked for them to be spaced.
 *
 * arXiv's terms of use are explicit and are not a suggestion: "make no more
 * than one request every three seconds, and limit requests to a single
 * connection at a time", counted across every machine under your control, with
 * blocking as the stated remedy. The first draft of this file issued one
 * request per candidate claim in a plain `for` loop — three requests inside a
 * second, from a background job that runs hourly, for ever. That is a service
 * asking politely and a client ignoring it.
 *
 * The chain is per-process, which is the honest limit of what this can promise:
 * two boxes running the same library each keep their own. The interval is set
 * high enough that two of them together still sit inside the published rate.
 *
 * @param minIntervalMs - the smallest gap between the START of two calls.
 * @returns a function that runs a thunk in turn, no sooner than the gap allows.
 */
export function createPacer(minIntervalMs) {
  let previous = Promise.resolve();
  let last = 0;
  return (thunk) => {
    const run = previous.then(async () => {
      const wait = minIntervalMs - (Date.now() - last);
      if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
      try {
        return await thunk();
      } finally {
        // Stamped on completion, not on start: "one connection at a time" means
        // the next call waits for this one to finish before its own gap begins.
        last = Date.now();
      }
    });
    // The chain must survive a failure, or one refused request stalls every
    // later one for the life of the process.
    previous = run.then(() => undefined, () => undefined);
    return run;
  };
}

/**
 * arXiv asks for one request every three seconds. Four, for room.
 *
 * The extra second is not politeness theatre: `Date.now()` is stamped when a
 * request finishes, network jitter moves the observed gap either way, and the
 * penalty for being slightly under is being blocked from a service with no
 * account to appeal through.
 */
const ARXIV_MIN_INTERVAL_MS = 4000;

/** One chain for the whole process, so concurrent callers still queue. */
const paceArxiv = createPacer(ARXIV_MIN_INTERVAL_MS);

/**
 * Publishers get a gap too, and one connection at a time.
 *
 * Not a published rule — a courtesy, and self-interest. Reading three pages
 * per claim for three claims is nine fetches issued as fast as the event loop
 * allows, from a job that runs every hour, and the sites on the receiving end
 * are the ones whose articles this library is built out of. A second between
 * them costs a pass eight seconds and costs nobody a block.
 */
const paceRead = createPacer(1000);

/**
 * A courtesy User-Agent.
 *
 * arXiv does not mandate one, but an anonymous background job hitting a free
 * public API is exactly what an operator blocks first when they are looking for
 * something to block.
 */
const ARXIV_UA = "dsh-agents-swarm/insight-corroboration (+https://github.com/genesis-agents/dsh-plugins)";

/**
 * Read a rate-limit refusal, if that is what this is.
 *
 * Separated because a 429 and an empty result set are the same value to every
 * caller that only counts hits — and this whole feature exists to stop numbers
 * that look healthy while nothing happened. A blocked search reported as "no
 * corroboration found" is a claim quietly demoted for a reason that was not
 * about the claim.
 *
 * @param response - a fetch Response.
 * @returns a reason string, or "" when the response is not a refusal.
 */
export function rateLimitReason(response) {
  const status = Number(response?.status ?? 0);
  if (status !== 429 && status !== 503) return "";
  const after = response?.headers?.get?.("retry-after");
  return after ? `rate-limited, retry after ${after}s` : "rate-limited";
}

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
  if (q === "") return { hits: [], error: "" };
  const max = Math.max(1, Math.min(20, Number(options.maxResults) || HITS_PER_CLAIM));
  const call = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(q)}&max_results=${max}&sortBy=relevance`;
  try {
    const response = await paceArxiv(() => call(url, {
      headers: { "user-agent": ARXIV_UA },
      signal: AbortSignal.timeout(15000),
    }));
    // A refusal is NOT an empty result. Returning [] for both is how a blocked
    // search becomes "nobody else reported this", which is a claim about the
    // world made from a fact about our own request rate.
    const limited = rateLimitReason(response);
    if (limited !== "") return { hits: [], error: `arXiv ${limited}`, rateLimited: true };
    if (!response.ok) return { hits: [], error: `arXiv answered ${response.status}` };
    return { hits: parseArxiv(await response.text()), error: "" };
  } catch (cause) {
    return { hits: [], error: `arXiv unreachable: ${String(cause?.message ?? cause)}` };
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
  if (q === "") return { hits: [], error: "" };
  if (web === undefined || typeof web.search !== "function") {
    return { hits: [], error: "no web search seam is registered" };
  }
  const max = Math.max(1, Math.min(20, Number(options.maxResults) || HITS_PER_CLAIM));
  try {
    const answer = await web.search({ query: q, maxResults: max });
    // `sources`, which is what the seam returns. Reading `results` — a name
    // nothing in dsh-web-search ever produced — made every web search succeed
    // with zero hits: measured, one mission logged 86 ok web_search calls and
    // fetched thirteen pages, four of eight dimensions found nothing, and the
    // ledger said the searches worked. `sources` is what
    // dsh-web-search-serper/lib/routes.js counts, and it is the only name the
    // provider ever emits.
    const rows = Array.isArray(answer)
      ? answer
      : (answer?.sources ?? answer?.results ?? []);
    return {
      hits: rows
        .map((row) => ({
          url: String(row?.url ?? row?.link ?? ""),
          title: String(row?.title ?? ""),
          snippet: String(row?.snippet ?? row?.description ?? "").slice(0, 400),
          source: "web",
        }))
        .filter((hit) => hit.url !== ""),
      error: "",
    };
  } catch (cause) {
    // The backends behind this seam are metered — Brave, Serper and Tavily all
    // sell quota — and the seam surfaces their refusal as a thrown error with
    // the status in the message. Swallowing it would report an exhausted
    // monthly allowance as "the web has nothing about this claim".
    const message = String(cause?.message ?? cause);
    const limited = /\b429\b|rate.?limit|quota|too many requests/iu.test(message);
    return { hits: [], error: `web search failed: ${message}`, rateLimited: limited };
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
 * @param options - `{ fetchImpl, budgetChars }`. `budgetChars` is the CALLER'S
 * budget: the corroboration path reads three pages into one prompt and wants
 * 4,000 of each; `fetch_page` reads one page for quoting and wants the tool
 * layer's own ceiling. A reader that imposes one caller's budget on every
 * caller is the defect this parameter exists to end.
 * @returns `{ url, title, text }`, or undefined when nothing readable came back.
 */
export async function readHit(hit, options = {}) {
  const url = String(hit?.url ?? "");
  if (url === "") return undefined;
  try {
    const doc = typeof options.fetchImpl === "function"
      ? await options.fetchImpl(url)
      : await paceRead(() => fetchDocument(url));

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
      // 429 and 403 are a publisher declining, not an article that failed to
      // parse. Both end as "could not be read", which is honest, but they are
      // worth telling apart from a 404 when somebody asks why nothing was
      // corroborated all week.
      if (status === 429 || status === 503) return { throttled: true, url };
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
    const budget = Number.isInteger(options.budgetChars) && options.budgetChars > 0
      ? options.budgetChars
      : READ_BUDGET_CHARS;
    return {
      url,
      title: String(hit.title ?? article?.title ?? ""),
      text: text.slice(0, budget),
      // A SEPARATE KEY, AND THE SEPARATION IS THE CONTRACT. `quote_verify`
      // checks a quote as a literal substring of exactly the `text` above, so
      // the figures may not be folded into it, appended to it, or summarised
      // in it. `corroborateInsight` below reads only `page.url`, `page.title`
      // and `page.text`, so the corroboration prompt is byte-for-byte what it
      // was.
      //
      // METADATA ONLY. No image bytes are fetched here: paying `paceRead`'s
      // one-second serialised chain for every candidate picture on every page
      // of a mission is precisely the unpaced-loop-aimed-at-publishers this
      // file's own pacing note calls the worse outcome. Bytes are fetched on
      // demand, once a chapter cites the page.
      figures: Array.isArray(article?.figures) ? article.figures : [],
    };
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
  const errors = [];
  let rateLimited = false;

  const arxiv = await searchArxiv(queries.arxiv, { fetchImpl: options.fetchImpl });
  if (arxiv.error !== "") errors.push(arxiv.error);
  if (arxiv.rateLimited === true) rateLimited = true;
  if (arxiv.hits.length > 0) backends.push("arxiv");
  found.push(...arxiv.hits);

  const web = await searchWeb(options.web, queries.web);
  // "No seam registered" is a configuration, not a failure, and reporting it
  // as an error every pass would bury the errors that matter.
  if (web.error !== "" && web.error !== "no web search seam is registered") errors.push(web.error);
  if (web.rateLimited === true) rateLimited = true;
  if (web.hits.length > 0) backends.push("web");
  found.push(...web.hits);

  if (found.length === 0) {
    // Three different states that all count zero hits, kept apart:
    //   - every backend answered and had nothing        -> a fact about the claim
    //   - a backend refused us for going too fast       -> a fact about our rate
    //   - there was no backend to ask                   -> a fact about the install
    // Collapsing them is how a blocked search becomes "nobody else reported
    // this", which is a claim about the world drawn from our own request rate.
    if (errors.length > 0) {
      return { searched: backends.length, hits: 0, independent: 0, read: 0, verdicts: 0, evidence: [], rateLimited, reason: errors.join("; ") };
    }
    const available = options.web === undefined ? "arXiv (no web search installed)" : "arXiv and the web seam";
    return { searched: backends.length, hits: 0, independent: 0, read: 0, verdicts: 0, evidence: [], rateLimited: false, reason: `no hits from ${available}` };
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
    return { searched: backends.length, hits: found.length, independent: 0, read: 0, verdicts: 0, evidence: [], rateLimited, reason: "every hit came from a source this claim already cites" };
  }

  const maxReads = Math.max(1, Math.min(6, Number(options.maxReads) || READS_PER_CLAIM));
  const pages = [];
  let throttledReads = 0;
  for (const hit of fresh.slice(0, maxReads)) {
    const page = await readHit(hit, options);
    if (page === undefined) continue;
    if (page.throttled === true) { throttledReads += 1; rateLimited = true; continue; }
    pages.push(page);
  }
  if (pages.length === 0) {
    return { searched: backends.length, hits: found.length, independent: fresh.length, read: 0, verdicts: 0, evidence: [], rateLimited, reason: "none of the independent hits could be fetched and read" };
  }

  const chat = options.chat;
  if (typeof chat !== "function") {
    return { searched: backends.length, hits: found.length, independent: fresh.length, read: pages.length, verdicts: 0, evidence: [], rateLimited, reason: "no model routed, so nothing could be judged" };
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
    rateLimited,
    verdicts: Array.isArray(parsed?.verdicts) ? parsed.verdicts.length : 0,
    evidence,
    reason: evidence.length === 0 ? "nothing that was read either supported or contradicted the claim" : "",
  };
}
