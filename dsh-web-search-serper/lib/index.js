/**
 * `dsh-web-search`: web search for the `ctx.web` seam, over several
 * interchangeable backends.
 *
 * A function plugin, not a service: a search provider does not own the
 * `ctx.web` key, it registers INTO the seam's provider registry. `ctx.web` is
 * owned by `@deepseek-ai/dsh-web`, and `inject: ["web"]` is what waits for it.
 *
 * ONE provider is registered and routes internally. The seam selects a
 * provider by id and reads that id once, when the service is constructed, so
 * registering several would still leave one in use and changing which would
 * mean editing composition config and restarting. Routing inside a single
 * registration keeps the seam's model intact and makes switching a settings
 * write that takes effect on the next search.
 *
 * Nothing here is imported from the harness. A plugin resolved from outside
 * the harness checkout cannot reach the harness's own packages, so an import
 * would either fail or pull in a second copy whose classes the harness's
 * `instanceof` checks do not recognise. Every capability comes through `ctx` at
 * runtime, which is what the seams actually require.
 *
 * @module dsh-web-search
 */

import { MultiSearchProvider, backendById, DEFAULT_BACKEND_ID } from "./provider.js";
import { installSettings, resolveApiKey, SETTINGS_NAMESPACE } from "./settings.js";
import { BACKENDS } from "./backends.js";
import { createHandler, ROUTE_PREFIX } from "./routes.js";

export { BACKENDS, backendById, DEFAULT_BACKEND_ID } from "./backends.js";
export { MultiSearchProvider, PROVIDER_ID, SearchError, searchWith } from "./provider.js";
export { Config, SETTINGS_NAMESPACE, installSettings, resolveApiKey } from "./settings.js";

/** Cordis plugin name, used by loader diagnostics. */
export const name = "web-search";

/** The seams this plugin uses. */
export const inject = ["web", "webServer"];

/** A non-empty trimmed string, or undefined. */
function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Project the settings section into the active backend and its options.
 *
 * Kept out of the provider so everything the provider reads is already fully
 * defaulted, and so environment and credential lookups live in one place.
 * @param ctx - the plugin context.
 * @param config - the currently authoritative section.
 * @returns `{ backend, options }`; `backend` is undefined when none is selected.
 */
export function resolveActive(ctx, config) {
  const backend = backendById(text(config?.active) ?? DEFAULT_BACKEND_ID);
  if (backend === undefined) return { backend: undefined, options: { apiKey: "", baseURL: "" } };
  const section = config?.backends?.[backend.id] ?? {};
  return {
    backend,
    options: {
      // A literal key short-circuits the lookup; otherwise the resolver runs
      // at search time, when awaiting a credential store is allowed.
      apiKey: text(section.apiKey) ?? "",
      resolveApiKey: () => resolveApiKey(ctx, backend, section),
      apiKeyEnv: text(section.apiKeyEnv) ?? backend.keyEnv,
      baseURL: text(section.baseURL) ?? backend.defaultBaseURL,
      ...typeof section.numResults === "number" ? { numResults: section.numResults } : {},
      ...text(section.country) !== undefined ? { country: text(section.country) } : {},
      ...text(section.locale) !== undefined ? { locale: text(section.locale) } : {},
    },
  };
}

/**
 * Register the settings namespace, the search provider, and its config route.
 * @param ctx - Cordis context carrying `web` and `webServer`.
 * @param config - the composition entry config, layered under the user section.
 */
export function apply(ctx, config = {}) {
  // Settings is optional, so its failure must not take web search with it.
  let current;
  try {
    current = installSettings(ctx, config);
  } catch (cause) {
    ctx.logger?.warn?.(`web-search: settings unavailable, using composition config only: ${String(cause?.message ?? cause)}`);
    current = () => config;
  }

  ctx.web.registerSearchProvider(new MultiSearchProvider(() => resolveActive(ctx, current())));

  // The configuration page's own route. The shipped Plugins tab renders a
  // curated set of first-party namespaces, so a third-party provider has to
  // bring its own surface or its key is enterable only by editing YAML.
  ctx.webServer.register({
    kind: "api",
    path: ROUTE_PREFIX,
    handler: createHandler(ctx, current, SETTINGS_NAMESPACE),
  });

  // Say which state things started in. A search that later reports a missing
  // key is otherwise a puzzle with indistinguishable causes, and the answer is
  // already known here, at startup.
  const section = current();
  const active = text(section.active) ?? DEFAULT_BACKEND_ID;
  const keyed = BACKENDS
    .filter((backend) => {
      const own = section.backends?.[backend.id] ?? {};
      return text(own.apiKey) !== undefined || text(process.env[text(own.apiKeyEnv) ?? backend.keyEnv]) !== undefined;
    })
    .map((backend) => backend.id);
  ctx.logger?.info?.(`web-search: active=${active}, keyed=[${keyed.join(",")}]`);
}
