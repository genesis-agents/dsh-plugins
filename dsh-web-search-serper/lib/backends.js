/**
 * The search backends this plugin can route to.
 *
 * `ctx.web` selects exactly ONE search provider, by id, and reads that id once
 * when the service is constructed. So "several search methods" cannot be built
 * by registering several providers — the seam would still use one, and
 * changing which would mean editing composition config and restarting.
 *
 * Instead one provider is registered and routes internally. The seam keeps its
 * single-provider model, and switching backends becomes a settings write that
 * takes effect on the next search.
 *
 * A backend is a plain object so adding one is adding a file's worth of code:
 * an id, how to ask, and how to map the answer. Everything else — key
 * resolution, error classification, the settings page — is shared.
 */

/** A non-empty trimmed string, or undefined. */
function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Serper — Google's SERP resold as JSON.
 *
 * Returns several result families at once; `answerBox` (else the knowledge
 * graph description) IS a direct answer and becomes `content`, because
 * dropping it would discard the most useful part of the response.
 */
export const serper = {
  id: "serper",
  label: "Serper",
  keyEnv: "SERPER_API_KEY",
  docs: "https://serper.dev",
  defaultBaseURL: "https://google.serper.dev",
  note: {
    zh: "转售 Google 搜索结果，带直接答案框。",
    en: "Resells Google's results, with a direct answer box.",
  },
  request({ apiKey, baseURL, country, locale, numResults }, request) {
    return {
      url: `${baseURL}/search`,
      init: {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          q: request?.query ?? "",
          ...numResults !== undefined ? { num: numResults } : {},
          ...country !== undefined ? { gl: country } : {},
          ...locale !== undefined ? { hl: locale } : {},
        }),
      },
    };
  },
  map(payload) {
    const organic = Array.isArray(payload?.organic) ? payload.organic : [];
    const sources = [];
    for (const result of organic) {
      const url = text(result?.link);
      if (url === undefined) continue;
      const title = text(result?.title);
      const snippet = text(result?.snippet);
      // Serper reports recency as a relative phrase ("2 days ago"), which is
      // not a timestamp and must not be passed off as one.
      const publishedAt = text(result?.date);
      sources.push({
        url,
        ...title !== undefined ? { title } : {},
        ...snippet !== undefined ? { snippet } : {},
        ...publishedAt !== undefined ? { publishedAt } : {},
      });
    }
    const box = payload?.answerBox;
    const content = text(box?.answer) ?? text(box?.snippet) ?? text(box?.title)
      ?? text(payload?.knowledgeGraph?.description);
    return { sources, content };
  },
  error(payload) {
    return text(payload?.message) ?? text(payload?.error);
  },
};

/**
 * Tavily — a search API built for retrieval, which can return a synthesised
 * answer alongside the sources.
 */
export const tavily = {
  id: "tavily",
  label: "Tavily",
  keyEnv: "TAVILY_API_KEY",
  docs: "https://tavily.com",
  defaultBaseURL: "https://api.tavily.com",
  note: {
    zh: "面向检索增强的搜索，可同时返回综合答案。",
    en: "Retrieval-oriented search that can also return a synthesised answer.",
  },
  request({ apiKey, baseURL, numResults }, request) {
    return {
      url: `${baseURL}/search`,
      init: {
        method: "POST",
        // Tavily takes the key in the body on its v1 route and in a bearer
        // header on newer ones; sending both is harmless and spares the
        // operator a version question they have no way to answer.
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: request?.query ?? "",
          include_answer: true,
          ...numResults !== undefined ? { max_results: numResults } : {},
        }),
      },
    };
  },
  map(payload) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const sources = [];
    for (const result of results) {
      const url = text(result?.url);
      if (url === undefined) continue;
      const title = text(result?.title);
      const snippet = text(result?.content);
      const publishedAt = text(result?.published_date);
      sources.push({
        url,
        ...title !== undefined ? { title } : {},
        ...snippet !== undefined ? { snippet } : {},
        ...publishedAt !== undefined ? { publishedAt } : {},
      });
    }
    return { sources, content: text(payload?.answer) };
  },
  error(payload) {
    return text(payload?.error) ?? text(payload?.detail?.error) ?? text(payload?.message);
  },
};

/**
 * Brave Search — an independent index rather than a reseller of someone
 * else's, which is the reason to have it beside the others.
 */
export const brave = {
  id: "brave",
  label: "Brave Search",
  keyEnv: "BRAVE_API_KEY",
  docs: "https://brave.com/search/api",
  defaultBaseURL: "https://api.search.brave.com",
  note: {
    zh: "独立索引，不是转售他人结果。",
    en: "An independent index, not a reseller of someone else's.",
  },
  request({ apiKey, baseURL, country, locale, numResults }, request) {
    const query = new URLSearchParams({ q: request?.query ?? "" });
    if (numResults !== undefined) query.set("count", String(numResults));
    if (country !== undefined) query.set("country", country);
    if (locale !== undefined) query.set("search_lang", locale);
    return {
      url: `${baseURL}/res/v1/web/search?${query.toString()}`,
      init: {
        method: "GET",
        headers: { "x-subscription-token": apiKey, accept: "application/json" },
      },
    };
  },
  map(payload) {
    const results = Array.isArray(payload?.web?.results) ? payload.web.results : [];
    const sources = [];
    for (const result of results) {
      const url = text(result?.url);
      if (url === undefined) continue;
      const title = text(result?.title);
      const snippet = text(result?.description);
      const publishedAt = text(result?.age) ?? text(result?.page_age);
      sources.push({
        url,
        ...title !== undefined ? { title } : {},
        ...snippet !== undefined ? { snippet } : {},
        ...publishedAt !== undefined ? { publishedAt } : {},
      });
    }
    // Brave returns no synthesised answer.
    return { sources, content: undefined };
  },
  error(payload) {
    return text(payload?.error?.detail) ?? text(payload?.message);
  },
};

/** Every backend, in the order the settings page lists them. */
export const BACKENDS = [serper, tavily, brave];

/**
 * One backend by id.
 * @param id - the backend id.
 * @returns the backend, or undefined.
 */
export function backendById(id) {
  return BACKENDS.find((backend) => backend.id === id);
}

/** The id used when the settings section names none. */
export const DEFAULT_BACKEND_ID = serper.id;
