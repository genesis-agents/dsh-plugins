/**
 * The one `WebSearchProvider` this plugin registers, routing to whichever
 * backend the settings section selects.
 *
 * The seam picks a provider by id once, at construction. Routing inside a
 * single registration is therefore what makes several search methods possible
 * at all, and what makes switching between them a settings write rather than a
 * config edit and a restart.
 */

import { backendById, DEFAULT_BACKEND_ID } from "./backends.js";

/** Stable id this provider registers under. */
export const PROVIDER_ID = "multi";

/** Attribution header sent on every request. */
const USER_AGENT = "dsh-web-search/0.2.0";

/**
 * A failure carrying a machine-routable code.
 *
 * The harness ships `WebError` in `@deepseek-ai/dsh-web`, and importing it
 * would be the obvious move. It is deliberately not imported: a plugin
 * resolved from outside the harness checkout cannot reach the harness's copy,
 * and installing a second copy would give a class the harness's own
 * `instanceof` checks do not recognise — worse than not pretending.
 *
 * What that costs is exactly one thing: `core/tools` attaches `{name, code}`
 * as structured error metadata only for its own class, so a failure from here
 * reaches the model as its message without that metadata. The seam does not
 * catch or re-wrap provider errors, so nothing else changes.
 */
export class SearchError extends Error {
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

/** True for a fetch/`AbortSignal` abort, which is cancellation and not failure. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL) {
  return URL.canParse(baseURL);
}

/**
 * Run one search against one backend.
 *
 * Exported so the settings page's Test button exercises exactly the path a
 * real search takes, rather than a parallel implementation that could pass
 * while the real one fails.
 * @param backend - the backend definition.
 * @param options - resolved options including a non-empty `apiKey`.
 * @param request - `{ query, maxResults? }`.
 * @param signal - optional cancellation signal.
 * @returns a normalized `WebSearchResult`.
 */
export async function searchWith(backend, options, request, signal) {
  const { url, init } = backend.request(options, request);
  let response;
  try {
    response = await fetch(url, {
      ...init,
      // Never follow a redirect: the target would be chosen by whoever
      // answered, and the API key travels in the request.
      redirect: "error",
      headers: { ...init.headers, "user-agent": USER_AGENT },
      ...signal !== undefined ? { signal } : {},
    });
  } catch (cause) {
    if (isAbortError(cause)) throw new SearchError(`${backend.label} search aborted`, "WEB_ABORTED", { cause });
    throw new SearchError(`${backend.label} search request failed: ${String(cause)}`, "WEB_PROVIDER_ERROR", { cause });
  }

  if (!response.ok) {
    let message = `${backend.label} API error (HTTP ${response.status})`;
    try {
      const detail = backend.error(await response.json());
      if (detail !== undefined) message = `${backend.label}: ${detail}`;
    } catch (cause) {
      // An abort mid-body is cancellation, not a provider error.
      if (isAbortError(cause)) throw new SearchError(`${backend.label} search aborted`, "WEB_ABORTED", { cause });
      // Otherwise the status is already in `message`; a non-JSON error body is
      // normal for gateway 5xx and can only cost a richer message.
    }
    throw new SearchError(message, "WEB_PROVIDER_ERROR");
  }

  try {
    const { sources, content } = backend.map(await response.json());
    // The web service owns the final `maxResults` truncation, so this reports
    // `truncated: false`.
    return { sources, truncated: false, ...content !== undefined ? { content } : {} };
  } catch (cause) {
    if (isAbortError(cause)) throw new SearchError(`${backend.label} search aborted`, "WEB_ABORTED", { cause });
    throw new SearchError(`${backend.label} returned an unprocessable response body: ${String(cause)}`, "WEB_PROVIDER_ERROR", { cause });
  }
}

/** The routing search provider. */
export class MultiSearchProvider {
  /**
   * @param resolve - reads `{ backend, options }` for the active backend. A
   *   thunk, not a value: the selection and its key can change while the
   *   process runs, and both must take effect on the next search.
   */
  constructor(resolve) {
    this.id = PROVIDER_ID;
    this.resolve = resolve;
  }

  /**
   * Cheap local usability check; makes no network call.
   *
   * "A key can be obtained", not "a key is present": resolving one may have to
   * await a credential store, and this must answer synchronously. A key that
   * turns out to be missing fails at search, where the message can name the
   * backend and where to put the key.
   */
  available() {
    const { backend, options } = this.resolve();
    if (backend === undefined) return false;
    return (options.apiKey.length > 0 || options.resolveApiKey !== undefined)
      && isValidBaseUrl(options.baseURL);
  }

  /**
   * Run one search through the active backend.
   * @param request - `{ query, maxResults? }`.
   * @param signal - optional cancellation signal.
   * @returns the normalized result.
   */
  async search(request, signal) {
    // One snapshot for the whole operation: key resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old backend to the endpoint named by the new one.
    const { backend, options } = this.resolve();
    if (backend === undefined) {
      throw new SearchError("no search backend is selected", "WEB_PROVIDER_ERROR");
    }
    const apiKey = options.apiKey.length > 0 ? options.apiKey : await options.resolveApiKey?.() ?? "";
    if (apiKey === "") {
      throw new SearchError(
        `${backend.label} has no API key: set ${backend.keyEnv}, or enter one under Settings → Search`,
        "WEB_PROVIDER_ERROR",
      );
    }
    if (signal?.aborted === true) throw new SearchError(`${backend.label} search aborted`, "WEB_ABORTED");
    const numResults = request?.maxResults ?? options.numResults;
    return searchWith(
      backend,
      { ...options, apiKey, ...numResults !== undefined ? { numResults } : {} },
      request,
      signal,
    );
  }
}

export { backendById, DEFAULT_BACKEND_ID };
