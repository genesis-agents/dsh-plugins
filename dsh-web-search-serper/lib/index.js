/**
 * `dsh-web-search-serper`: registers a Serper-backed search provider with
 * `ctx.web`.
 *
 * A function plugin, not a service: a search provider does not own the
 * `ctx.web` key, it registers INTO the seam's provider registry. `ctx.web` is
 * owned by `@deepseek-ai/dsh-web`, and `inject: ["web"]` is what waits for it.
 *
 * This is a THIRD-PARTY plugin and imports nothing from the harness. That is a
 * deliberate constraint, not an oversight: a plugin resolved from outside the
 * harness checkout cannot reach the harness's own packages, so an import would
 * either fail or silently pull in a second copy. Everything needed is reached
 * through `ctx` at runtime, which is the seam's actual contract. See
 * `SerperError` in `provider.js` for the one place this costs anything.
 *
 * @module dsh-web-search-serper
 */

import { SerperSearchProvider, SERPER_DEFAULT_BASE_URL } from "./provider.js";

export {
  SERPER_DEFAULT_BASE_URL,
  SERPER_PROVIDER_ID,
  SerperError,
  SerperSearchProvider,
  answerFrom,
  mapOrganicResult,
  mapSerperResponse,
} from "./provider.js";

/** Cordis plugin name, used by loader diagnostics. */
export const name = "web-search-serper";

/** The seam this provider registers into. */
export const inject = ["web"];

/** Environment variable consulted when no `apiKey` is configured. */
const DEFAULT_API_KEY_ENV = "SERPER_API_KEY";

/**
 * Register the Serper search provider.
 *
 * Registering an unavailable provider is intentional: `available()` is what
 * the seam consults, and a provider that refuses to register when its key is
 * missing would be indistinguishable from one that is not installed — the
 * operator would have no way to tell a missing key from a missing plugin.
 * @param ctx - Cordis context carrying `web`.
 * @param config - `{ apiKey?, apiKeyEnv?, baseURL?, numResults?, country?, locale? }`.
 */
export function apply(ctx, config = {}) {
  const keyEnv = typeof config.apiKeyEnv === "string" && config.apiKeyEnv !== ""
    ? config.apiKeyEnv
    : DEFAULT_API_KEY_ENV;
  const apiKey = typeof config.apiKey === "string" && config.apiKey !== ""
    ? config.apiKey
    : process.env[keyEnv] ?? "";

  const provider = new SerperSearchProvider({
    apiKey,
    baseURL: typeof config.baseURL === "string" && config.baseURL !== ""
      ? config.baseURL
      : SERPER_DEFAULT_BASE_URL,
    ...typeof config.numResults === "number" ? { numResults: config.numResults } : {},
    ...typeof config.country === "string" && config.country !== "" ? { country: config.country } : {},
    ...typeof config.locale === "string" && config.locale !== "" ? { locale: config.locale } : {},
  });

  ctx.web.registerSearchProvider(provider);
  // Say which state it registered in. A search that later reports "no provider
  // available" is otherwise a puzzle with two indistinguishable causes, and
  // the answer is decided here, at startup.
  if (apiKey === "") {
    ctx.logger?.warn?.(`serper: registered but unavailable — no key in ${keyEnv} and none configured`);
  } else {
    ctx.logger?.info?.(`serper: search provider ready (key from ${config.apiKey ? "config" : keyEnv})`);
  }
}
