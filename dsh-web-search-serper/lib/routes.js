/**
 * The HTTP face of the settings page.
 *
 * The browser half cannot reach the settings service, so the Host half exposes
 * the one namespace this plugin owns and nothing else.
 *
 * Keys are WRITE-ONLY across the wire: a GET reports whether each backend has
 * one and where it comes from, never its value, and a field the page did not
 * touch is not sent back — so saving a country code cannot silently clear a
 * secret. That asymmetry is why this is a hand-written route rather than a
 * generic settings passthrough.
 */

import { BACKENDS, backendById, DEFAULT_BACKEND_ID } from "./backends.js";
import { searchWith } from "./provider.js";
import { resolveApiKey } from "./settings.js";
import { PLUGIN_CHANNEL, PLUGIN_COMMIT, PLUGIN_DIR, PLUGIN_VERSION, versionLabel } from "./version.js";

/** Route prefix this plugin owns on the dsh web server. */
export const ROUTE_PREFIX = "/web-search-api";

/** Send one JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/** Read a JSON request body, bounded. */
async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** A non-empty trimmed string, or undefined. */
function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Build the request handler.
 * @param ctx - the plugin context, for the settings and credential services.
 * @param read - reads the currently authoritative section.
 * @param namespace - the settings namespace this plugin owns.
 * @returns an HTTP handler.
 */
export function createHandler(ctx, read, namespace) {
  const settings = () => (typeof ctx.get === "function" ? ctx.get("settings") : undefined);

  /** One backend's row for the table. */
  const describe = (backend, section) => {
    const own = section.backends?.[backend.id] ?? {};
    const keyEnv = text(own.apiKeyEnv) ?? backend.keyEnv;
    return {
      id: backend.id,
      label: backend.label,
      docs: backend.docs,
      note: backend.note,
      keyEnv,
      // Three states, not two: saved here, present in the environment, or
      // absent. "Configured" alone would leave an operator guessing why a
      // search still fails.
      savedKey: text(own.apiKey) !== undefined,
      envKey: text(process.env[keyEnv]) !== undefined,
      baseURL: text(own.baseURL) ?? backend.defaultBaseURL,
      country: own.country ?? "",
      locale: own.locale ?? "",
      numResults: typeof own.numResults === "number" ? own.numResults : null,
    };
  };

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.slice(ROUTE_PREFIX.length) || "/";

    // What this copy is. A release and a checkout both say the same number —
    // it is bumped at release and every commit between two releases shares it
    // — so the channel is reported beside it.
    if (req.method === "GET" && path === "/version") {
      sendJson(res, 200, {
        success: true,
        data: {
          version: PLUGIN_VERSION,
          channel: PLUGIN_CHANNEL,
          commit: PLUGIN_COMMIT,
          label: versionLabel(),
          dir: PLUGIN_DIR,
          node: process.versions.node,
        },
      });
      return true;
    }

    if (req.method === "GET" && path === "/config") {
      const section = read();
      sendJson(res, 200, {
        success: true,
        data: {
          active: text(section.active) ?? DEFAULT_BACKEND_ID,
          writable: settings() !== undefined,
          backends: BACKENDS.map((backend) => describe(backend, section)),
        },
      });
      return;
    }

    if (req.method === "PUT" && path === "/config") {
      const service = settings();
      if (service === undefined || typeof service.update !== "function") {
        sendJson(res, 503, { success: false, error: "no settings provider is mounted; edit the profile config instead" });
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return;
      }

      const patch = {};
      if (typeof body.active === "string") {
        if (backendById(body.active) === undefined) {
          sendJson(res, 400, { success: false, error: `unknown backend: ${body.active}` });
          return;
        }
        patch.active = body.active;
      }
      if (typeof body.backend === "string") {
        const backend = backendById(body.backend);
        if (backend === undefined) {
          sendJson(res, 400, { success: false, error: `unknown backend: ${body.backend}` });
          return;
        }
        const own = {};
        // An absent field means "leave it alone"; an empty string means "clear
        // it". Collapsing those two would make every save of any field a reset
        // of the ones the page did not show.
        if (typeof body.apiKey === "string") own.apiKey = body.apiKey.trim();
        if (typeof body.baseURL === "string") own.baseURL = body.baseURL.trim();
        if (typeof body.country === "string") own.country = body.country.trim();
        if (typeof body.locale === "string") own.locale = body.locale.trim();
        if (body.numResults === null) own.numResults = undefined;
        else if (typeof body.numResults === "number" && Number.isInteger(body.numResults) && body.numResults > 0) {
          own.numResults = body.numResults;
        }
        if (Object.keys(own).length > 0) patch.backends = { [backend.id]: own };
      }
      if (Object.keys(patch).length === 0) {
        sendJson(res, 400, { success: false, error: "nothing to update" });
        return;
      }

      try {
        // `update` deep-merges into the user section, so a patch naming one
        // backend leaves the others' keys untouched.
        await service.update(namespace, patch);
        sendJson(res, 200, { success: true, data: { updated: Object.keys(patch) } });
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    if (req.method === "POST" && path === "/test") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const section = read();
      const backend = backendById(text(body.backend) ?? text(section.active) ?? DEFAULT_BACKEND_ID);
      if (backend === undefined) {
        sendJson(res, 200, { success: false, error: "unknown backend" });
        return;
      }
      const own = section.backends?.[backend.id] ?? {};
      const apiKey = await resolveApiKey(ctx, backend, own);
      if (apiKey === "") {
        sendJson(res, 200, { success: false, error: `no API key (looked in settings and $${text(own.apiKeyEnv) ?? backend.keyEnv})` });
        return;
      }
      // Testing the ACTIVE backend goes through `ctx.web.search()` — the same
      // entry point the model's `web_search` tool uses. That is the only way
      // to prove the seam actually routes here: a test that called the backend
      // directly would pass just as happily while `searchProvider` still named
      // somebody else, which is precisely the failure worth catching.
      //
      // A non-active backend cannot be reached that way, because the seam runs
      // one provider. Those fall back to the shared search function — the same
      // code the provider calls, one layer in.
      const isActive = backend.id === (text(section.active) ?? DEFAULT_BACKEND_ID);
      const web = typeof ctx.get === "function" ? ctx.get("web") : undefined;
      const throughSeam = isActive && web !== undefined && typeof web.search === "function";
      try {
        const started = Date.now();
        const result = throughSeam
          ? await web.search({ query: "deepseek harness", maxResults: 3 })
          : await searchWith(
            backend,
            {
              apiKey,
              baseURL: text(own.baseURL) ?? backend.defaultBaseURL,
              ...text(own.country) !== undefined ? { country: text(own.country) } : {},
              ...text(own.locale) !== undefined ? { locale: text(own.locale) } : {},
              numResults: 3,
            },
            { query: "deepseek harness", maxResults: 3 },
          );
        sendJson(res, 200, {
          success: true,
          data: {
            sources: result.sources.length,
            sample: result.sources[0]?.title ?? result.sources[0]?.url ?? "",
            answer: result.content ?? "",
            ms: Date.now() - started,
            // Say which path ran. "It worked" means two different things here.
            via: throughSeam ? "seam" : "backend",
          },
        });
      } catch (cause) {
        sendJson(res, 200, { success: false, error: String(cause?.message ?? cause), via: throughSeam ? "seam" : "backend" });
      }
      return;
    }

    sendJson(res, 404, { success: false, error: `no such route: ${req.method} ${path}` });
  };
}
