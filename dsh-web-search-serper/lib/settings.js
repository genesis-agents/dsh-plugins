/**
 * The settings namespace: which backend is active, and each backend's own
 * configuration.
 *
 * Registered through `ctx.inject(['settings'], ...)` — the OPTIONAL form. The
 * service may mount after this plugin or detach while it runs, and reading
 * `ctx.settings` directly cannot express either: it answers for the instant it
 * is called, and it THROWS when the service is absent.
 *
 * The schema library is the one dependency this file has. The settings service
 * duck-types the schema — it only calls it and its `toJSON` — so a locally
 * installed copy is fine, and nothing else here imports from the harness.
 */

import z from "@deepseek-ai/schemastery";
import { BACKENDS, DEFAULT_BACKEND_ID } from "./backends.js";

/** Namespace this plugin owns in the settings document. */
export const SETTINGS_NAMESPACE = "web-search";

/** Per-backend configuration. */
const BackendConfig = z.object({
  // `role('secret')` keeps the key out of every wire descriptor: a
  // configuration surface reads a redacted view and never receives the value.
  apiKey: z.string().role("secret"),
  apiKeyEnv: z.string().role("credential-ref"),
  baseURL: z.string(),
  numResults: z.number().step(1).min(1),
  country: z.string(),
  locale: z.string(),
});

/**
 * The configurable surface.
 *
 * Defaults are declared in the schema rather than only at the point of use: a
 * configuration surface renders the RESOLVED section, so a default the schema
 * does not carry reads there as no value at all.
 */
export const Config = z.object({
  active: z.union(BACKENDS.map((backend) => backend.id)).default(DEFAULT_BACKEND_ID),
  backends: z.dict(BackendConfig).default({}),
});

/**
 * Register the namespace and hand back a live reader.
 * @param ctx - the plugin context.
 * @param entry - the composition config, layered under the user's section.
 * @returns `() => Config` reading the currently authoritative section.
 */
export function installSettings(ctx, entry) {
  // Starts as the composition entry and stays that way if no provider is ever
  // mounted, which is a supported deployment and not a degraded one.
  let read = () => entry;

  ctx.inject(["settings"], (sctx) => {
    try {
      const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: entry, applies: "live" });
      read = () => scope.get();
    } catch (cause) {
      // A duplicate namespace, or a stored section the schema rejects, fails
      // loudly. Losing the settings form must not also lose web search.
      sctx.logger?.warn?.(`web-search: settings registration failed, using composition config only: ${String(cause?.message ?? cause)}`);
      return;
    }
    // The provider detaching leaves this plugin running, so fall back rather
    // than keep reading a scope whose owner is gone.
    sctx.effect(() => () => { read = () => entry; });
  });

  return () => read();
}

/**
 * Resolve one backend's API key.
 *
 * Order: a literal key in its section, then the credential store under the
 * referenced name, then the ambient environment. The credential store is
 * optional — without it the environment is the whole credential plane, which
 * is the case on a plain local run.
 * @param ctx - the plugin context.
 * @param backend - the backend definition, for its default env name.
 * @param config - that backend's section.
 * @returns the key, or an empty string.
 */
export async function resolveApiKey(ctx, backend, config) {
  const literal = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  if (literal !== "") return literal;
  const name = typeof config?.apiKeyEnv === "string" && config.apiKeyEnv !== ""
    ? config.apiKeyEnv
    : backend.keyEnv;
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
