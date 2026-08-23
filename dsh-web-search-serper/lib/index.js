/**
 * `dsh-web-search-serper`: registers a Serper-backed search provider with
 * `ctx.web`, and a settings namespace so it can be configured from the UI.
 *
 * A function plugin, not a service: a search provider does not own the
 * `ctx.web` key, it registers INTO the seam's provider registry. `ctx.web` is
 * owned by `@deepseek-ai/dsh-web`, and `inject: ["web"]` is what waits for it.
 *
 * This is a THIRD-PARTY plugin: it imports nothing from the harness. A plugin
 * resolved from outside the harness checkout cannot reach the harness's own
 * packages, so an import would either fail or silently pull in a second copy
 * whose classes the harness's `instanceof` checks do not recognise. Every
 * capability is reached through `ctx` at runtime, which is what the seams
 * actually require. The one dependency is a schema library, because the
 * settings service needs a schema object it can call — and it duck-types it,
 * so a locally installed copy is fine.
 *
 * @module dsh-web-search-serper
 */

import { SerperSearchProvider, SERPER_DEFAULT_BASE_URL } from "./provider.js";
import { installSettings, resolveApiKey, DEFAULT_API_KEY_ENV } from "./settings.js";

export {
  SERPER_DEFAULT_BASE_URL,
  SERPER_PROVIDER_ID,
  SerperError,
  SerperSearchProvider,
  answerFrom,
  mapOrganicResult,
  mapSerperResponse,
} from "./provider.js";
export { Config, SETTINGS_NAMESPACE, DEFAULT_API_KEY_ENV, installSettings, resolveApiKey } from "./settings.js";

/** Cordis plugin name, used by loader diagnostics. */
export const name = "web-search-serper";

/** The seam this provider registers into. */
export const inject = ["web"];

/** A non-empty trimmed string, or undefined. */
function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Project one resolved settings section into the options a search runs with.
 *
 * Kept out of the provider so that everything the provider reads is already
 * fully defaulted, and so the environment and credential lookups live in one
 * place rather than being spread through the request path.
 * @param ctx - the plugin context.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function optionsFrom(ctx, config) {
  const apiKeyEnv = text(config.apiKeyEnv) ?? DEFAULT_API_KEY_ENV;
  return {
    // A literal key short-circuits the lookup; otherwise the resolver runs at
    // search time, when awaiting a credential store is allowed.
    apiKey: text(config.apiKey) ?? "",
    resolveApiKey: () => resolveApiKey(ctx, config),
    apiKeyEnv,
    baseURL: text(config.baseURL) ?? SERPER_DEFAULT_BASE_URL,
    ...typeof config.numResults === "number" ? { numResults: config.numResults } : {},
    ...text(config.country) !== undefined ? { country: text(config.country) } : {},
    ...text(config.locale) !== undefined ? { locale: text(config.locale) } : {},
  };
}

/**
 * Register the settings namespace and the search provider.
 * @param ctx - Cordis context carrying `web`, and optionally `settings`.
 * @param config - the composition entry config, which the user section layers over.
 */
export function apply(ctx, config = {}) {
  // Settings is optional, so its failure must not take web search with it.
  let current;
  try {
    current = installSettings(ctx, config);
  } catch (cause) {
    ctx.logger?.warn?.(`serper: settings unavailable, using composition config only: ${String(cause?.message ?? cause)}`);
    current = () => config;
  }
  ctx.web.registerSearchProvider(new SerperSearchProvider(() => optionsFrom(ctx, current())));

  // Say which state it started in. A search that later reports a missing key
  // is otherwise a puzzle with two indistinguishable causes — no key, or no
  // plugin — and the answer is already known here, at startup.
  const keyEnv = text(config.apiKeyEnv) ?? DEFAULT_API_KEY_ENV;
  const hasKey = text(config.apiKey) !== undefined || text(process.env[keyEnv]) !== undefined;
  ctx.logger?.info?.(hasKey
    ? "serper: search provider ready"
    : `serper: registered; no key in ${keyEnv} yet — set one there or under Settings → Plugins`);
}
