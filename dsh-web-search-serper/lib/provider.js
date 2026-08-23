/**
 * A `WebSearchProvider` backed by Serper (`POST https://google.serper.dev/search`),
 * which resells Google's SERP as JSON.
 *
 * Serper returns several result families in one response — `organic`, plus an
 * `answerBox` and a `knowledgeGraph` when Google showed them. The seam's shape
 * is a list of sources with an optional generated `content`, so the answer box
 * becomes `content` (it IS a direct answer, and dropping it would throw away
 * the most useful part of the response) and the organic results become the
 * sources.
 */

/** Stable id this provider registers under. */
export const SERPER_PROVIDER_ID = "serper";

/** Default Serper endpoint; `/search` is the operation. */
export const SERPER_DEFAULT_BASE_URL = "https://google.serper.dev";

/** Attribution header sent on every request. */
const USER_AGENT = "dsh-web-search-serper/0.1.0";

/**
 * A failure carrying a machine-routable code.
 *
 * The harness ships `WebError` in `@deepseek-ai/dsh-web`, and importing it
 * would be the obvious move. It is deliberately not imported: this plugin is
 * meant to stand on its own, and a plugin resolved from outside the harness
 * checkout cannot reach the harness's copy — installing a second copy would
 * give a class the harness's own `instanceof` checks do not recognise, which
 * is worse than not pretending.
 *
 * What that costs is exactly one thing: `core/tools` attaches `{name, code}`
 * as structured error metadata only for its own error class, so a failure from
 * here reaches the model as its message without that metadata. The seam itself
 * does not catch or re-wrap provider errors — it lets them propagate — so
 * nothing else changes. The `code` is still set, and still correct, for
 * anything that routes on it.
 */
export class SerperError extends Error {
  /**
   * @param message - human-readable failure.
   * @param code - stable machine-routable class.
   * @param options - standard `ErrorOptions`, for `cause`.
   */
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = "WebError";
  }
}

/** True for a fetch/`AbortSignal` abort, which is cancellation and not a failure. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL) {
  return URL.canParse(baseURL);
}

/** True for a result count that can be sent to Serper. */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** A non-empty trimmed string, or undefined. */
function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Map one Serper organic result to a normalized source.
 *
 * A result with no snippet is kept, unlike the Exa provider's rule — Serper's
 * organic entries always carry a title and a URL, and a titled link with no
 * summary is still a usable source for the model to fetch. Inventing a snippet
 * would lie; omitting the field does not.
 * @param result - one entry of Serper's `organic[]`.
 * @returns the normalized source, or undefined when it has no URL.
 */
export function mapOrganicResult(result) {
  const url = text(result?.link);
  if (url === undefined) return undefined;
  const title = text(result?.title);
  const snippet = text(result?.snippet);
  // Serper reports recency as a relative phrase ("2 days ago") in `date`,
  // which is not a timestamp and must not be passed off as one.
  const publishedAt = text(result?.date);
  return {
    url,
    ...title !== undefined ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  };
}

/**
 * The direct answer Google showed, if any.
 *
 * `answerBox` carries the answer under one of several keys depending on what
 * kind of question was asked, and `knowledgeGraph` carries an entity
 * description. Either is a generated answer in the seam's sense.
 * @param payload - the parsed Serper response.
 * @returns the answer text, or undefined.
 */
export function answerFrom(payload) {
  const box = payload?.answerBox;
  const fromBox = text(box?.answer) ?? text(box?.snippet) ?? text(box?.title);
  if (fromBox !== undefined) return fromBox;
  const graph = payload?.knowledgeGraph;
  return text(graph?.description);
}

/**
 * Map a Serper response envelope to a normalized search result.
 * @param payload - the parsed `POST /search` response body.
 * @returns the normalized result.
 */
export function mapSerperResponse(payload) {
  const organic = Array.isArray(payload?.organic) ? payload.organic : [];
  const sources = organic
    .map(mapOrganicResult)
    .filter((source) => source !== undefined);
  const content = answerFrom(payload);
  // The web service owns the final `maxResults` truncation, so this provider
  // reports `truncated: false`.
  return { sources, truncated: false, ...content !== undefined ? { content } : {} };
}

/** The Serper-backed search provider; HTTP redirects fail rather than being followed. */
export class SerperSearchProvider {
  /**
   * @param resolveOptions - reads the currently authoritative options. A thunk,
   *   not a value: the settings section can change while the process runs, and
   *   a key saved in the UI has to take effect on the next search without a
   *   restart.
   */
  constructor(resolveOptions) {
    this.id = SERPER_PROVIDER_ID;
    this.resolveOptions = resolveOptions;
  }

  /**
   * Cheap local usability check; makes no network call.
   *
   * "A key can be obtained", not "a key is present": resolving one may have to
   * await a credential store, and this must answer synchronously. A provider
   * that reported itself unavailable whenever the key lived somewhere it could
   * not read synchronously would be invisible for a reason the operator could
   * not see. A key that turns out to be missing fails at search, where the
   * message can say so.
   */
  available() {
    const options = this.resolveOptions();
    return (options.apiKey.length > 0 || options.resolveApiKey !== undefined)
      && isValidBaseUrl(options.baseURL)
      && (options.numResults === undefined || isPositiveInteger(options.numResults))
      && (options.country === undefined || options.country.length > 0)
      && (options.locale === undefined || options.locale.length > 0);
  }

  /**
   * Run one search.
   * @param request - `{ query, maxResults? }`.
   * @param signal - optional cancellation signal.
   * @returns the normalized result.
   */
  async search(request, signal) {
    // One snapshot for the whole operation: key resolution awaits, and a
    // settings write landing inside that await must not send the key from the
    // old section to the endpoint named by the new one.
    const options = this.resolveOptions();
    const apiKey = options.apiKey.length > 0
      ? options.apiKey
      : await options.resolveApiKey?.() ?? "";
    if (apiKey === "") {
      throw new SerperError(
        `Serper has no API key: set ${options.apiKeyEnv ?? "SERPER_API_KEY"}, or enter one under Settings → Plugins → Serper`,
        "WEB_PROVIDER_ERROR",
      );
    }
    if (signal?.aborted === true) throw new SerperError("Serper search aborted", "WEB_ABORTED");
    // A per-request bound wins over the configured default; either may be absent.
    const num = request?.maxResults ?? options.numResults;
    let response;
    try {
      response = await fetch(`${options.baseURL}/search`, {
        method: "POST",
        // Never follow a redirect: the target would be chosen by whoever
        // answered, and the API key travels in the header.
        redirect: "error",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          q: request?.query ?? "",
          ...num !== undefined ? { num } : {},
          ...options.country !== undefined ? { gl: options.country } : {},
          ...options.locale !== undefined ? { hl: options.locale } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      });
    } catch (cause) {
      if (isAbortError(cause)) throw new SerperError("Serper search aborted", "WEB_ABORTED", { cause });
      throw new SerperError(`Serper search request failed: ${String(cause)}`, "WEB_PROVIDER_ERROR", { cause });
    }

    if (!response.ok) {
      let message = `Serper API error (HTTP ${response.status})`;
      try {
        const parsed = await response.json();
        const detail = text(parsed?.message) ?? text(parsed?.error);
        if (detail !== undefined) message = detail;
      } catch (cause) {
        // An abort that fires mid-body is cancellation, not a provider error,
        // and must not be swallowed into the generic HTTP message.
        if (isAbortError(cause)) throw new SerperError("Serper search aborted", "WEB_ABORTED", { cause });
        // Otherwise the status is already in `message`; a non-JSON error body
        // is normal for gateway 5xx and can only cost a richer message.
      }
      throw new SerperError(message, "WEB_PROVIDER_ERROR");
    }

    try {
      return mapSerperResponse(await response.json());
    } catch (cause) {
      if (isAbortError(cause)) throw new SerperError("Serper search aborted", "WEB_ABORTED", { cause });
      throw new SerperError(`Serper returned an unprocessable response body: ${String(cause)}`, "WEB_PROVIDER_ERROR", { cause });
    }
  }
}
