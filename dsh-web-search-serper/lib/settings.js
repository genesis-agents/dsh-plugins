/**
 * The configuration surface: what makes this provider appear under
 * Settings → Plugins with a key field, instead of only being configurable by
 * editing a YAML file.
 *
 * A plugin gets that entry by registering a namespace schema with `ctx.settings`.
 * Nothing renders a form for a plugin that has not; that is the whole reason
 * Serper had no entry while the shipped DeepSeek provider did.
 *
 * Reached through `ctx`, not through an import of `@deepseek-ai/dsh-settings`:
 * the service is duck-typed at the seam (it only calls the schema and its
 * `toJSON`), so the schema library is the one dependency this needs, and the
 * registration itself stays a runtime call like every other capability here.
 *
 * The settings provider is OPTIONAL. Without one mounted, `ctx.settings` is
 * absent and the plugin resolves its composition config alone — which is what
 * the seam promises, and why every path below tolerates its absence rather
 * than requiring it.
 */

import z from "@deepseek-ai/schemastery";

/** Namespace this plugin owns in the settings document. */
export const SETTINGS_NAMESPACE = "web-search-serper";

/** Environment variable consulted when no key is configured. */
export const DEFAULT_API_KEY_ENV = "SERPER_API_KEY";

/**
 * The configurable surface.
 *
 * `role('secret')` keeps the key out of every wire descriptor — a
 * configuration UI reads a redacted view and never receives the value back.
 * `role('credential-ref')` marks the env var as naming a credential rather
 * than being one, so the field renders as a reference and not as a password.
 *
 * Defaults are declared here rather than only at the point of use: a
 * configuration surface renders the RESOLVED section, so a default the schema
 * does not carry reads there as no value at all.
 */
export const Config = z.object({
  apiKey: z.string().role("secret"),
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default("https://google.serper.dev"),
  numResults: z.number().step(1).min(1),
  country: z.string(),
  locale: z.string(),
});

/**
 * Register the namespace and hand back a live reader.
 *
 * Returns a function rather than a value because the section can change while
 * the process runs: the provider projects it per search, so a saved key takes
 * effect on the next search with no restart and no re-registration.
 * @param ctx - the plugin context.
 * @param entry - the composition config, used as the layer under the user's.
 * @returns `() => Config` reading the currently authoritative section.
 */
export function installSettings(ctx, entry) {
  // Starts as the composition entry and stays that way if no provider is ever
  // mounted, which is a supported deployment and not a degraded one.
  let read = () => entry;

  // `ctx.inject(names, callback)` is the OPTIONAL form: the callback runs when
  // the service is present, and its fiber is disposed when the service
  // detaches. Reading `ctx.settings` directly cannot express that — it answers
  // for the instant it is called, so a provider that mounts later never
  // reaches this plugin, and the configuration entry never appears. That is
  // exactly what happened on the first attempt here.
  ctx.inject(["settings"], (sctx) => {
    try {
      const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: entry, applies: "live" });
      read = () => scope.get();
    } catch (cause) {
      // A duplicate namespace, or a stored section the schema rejects, fails
      // the registration loudly. Losing the settings form must not also lose
      // web search, so the composition entry carries on serving.
      sctx.logger?.warn?.(`serper: settings registration failed, using composition config only: ${String(cause?.message ?? cause)}`);
      return;
    }
    // The provider detaching leaves this plugin running, so fall back rather
    // than keep reading a scope whose owner is gone.
    sctx.effect(() => () => { read = () => entry; });
  });

  return () => read();
}

/**
 * Resolve the API key for one search.
 *
 * Order: a literal key in the section, then the credential store under the
 * referenced name, then the ambient environment. The credential store is
 * consulted through `ctx` and is optional — without it the environment is the
 * whole credential plane, which is exactly the case on a plain local run.
 * @param ctx - the plugin context.
 * @param config - the currently authoritative section.
 * @returns the key, or an empty string when none is available.
 */
export async function resolveApiKey(ctx, config) {
  const literal = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  if (literal !== "") return literal;
  const name = typeof config.apiKeyEnv === "string" && config.apiKeyEnv !== ""
    ? config.apiKeyEnv
    : DEFAULT_API_KEY_ENV;
  const credentials = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
  if (credentials !== undefined && typeof credentials.resolve === "function") {
    try {
      const found = await credentials.resolve(name);
      const value = typeof found?.value === "string" ? found.value.trim() : "";
      if (value !== "") return value;
    } catch {
      // A credential plane that cannot answer is not a reason to skip the
      // environment behind it.
    }
  }
  const ambient = process.env[name];
  return typeof ambient === "string" ? ambient.trim() : "";
}
