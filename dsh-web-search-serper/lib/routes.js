/**
 * The HTTP face of the settings page.
 *
 * The browser half cannot reach the settings service directly, so the Host
 * half exposes the one namespace this plugin owns and nothing else.
 *
 * The key is WRITE-ONLY across the wire: a GET reports whether one is stored
 * and where it would come from, never its value, and a field the page did not
 * touch is not sent back — so saving a country code cannot silently clear a
 * secret. That asymmetry is the whole reason this is a hand-written route
 * rather than a generic settings passthrough.
 */

/** Route prefix this plugin owns on the dsh web server. */
export const ROUTE_PREFIX = "/serper-api";

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
 * @param ctx - the plugin context, for the settings service.
 * @param read - reads the currently authoritative section.
 * @param namespace - the settings namespace this plugin owns.
 * @param defaultEnv - env var consulted when the section names none.
 * @returns an HTTP handler.
 */
export function createHandler(ctx, read, namespace, defaultEnv) {
  const settings = () => (typeof ctx.get === "function" ? ctx.get("settings") : undefined);

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.slice(ROUTE_PREFIX.length) || "/";

    if (req.method === "GET" && path === "/config") {
      const config = read();
      const keyEnv = text(config.apiKeyEnv) ?? defaultEnv;
      // Three ways a key can be present, and the page has to be able to tell
      // them apart: one saved here, one in the environment, or none at all.
      // "Configured" without saying which would leave an operator guessing why
      // a search still fails.
      const savedKey = text(config.apiKey) !== undefined;
      const envKey = text(process.env[keyEnv]) !== undefined;
      sendJson(res, 200, {
        success: true,
        data: {
          keyEnv,
          savedKey,
          envKey,
          baseURL: config.baseURL ?? "",
          country: config.country ?? "",
          locale: config.locale ?? "",
          numResults: config.numResults ?? null,
          writable: settings() !== undefined,
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
      // An absent field means "leave it alone"; an empty string means "clear
      // it". Collapsing those two would make every save of any field a reset
      // of the ones the page did not show.
      if (typeof body.apiKey === "string") patch.apiKey = body.apiKey.trim();
      if (typeof body.apiKeyEnv === "string") patch.apiKeyEnv = body.apiKeyEnv.trim() || defaultEnv;
      if (typeof body.baseURL === "string") patch.baseURL = body.baseURL.trim();
      if (typeof body.country === "string") patch.country = body.country.trim();
      if (typeof body.locale === "string") patch.locale = body.locale.trim();
      if (body.numResults === null) patch.numResults = undefined;
      else if (typeof body.numResults === "number" && Number.isInteger(body.numResults) && body.numResults > 0) {
        patch.numResults = body.numResults;
      }
      if (Object.keys(patch).length === 0) {
        sendJson(res, 400, { success: false, error: "nothing to update" });
        return;
      }

      try {
        await service.update(namespace, patch);
        sendJson(res, 200, { success: true, data: { updated: Object.keys(patch) } });
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    if (req.method === "POST" && path === "/test") {
      // A key that saves and still does not work is the failure this page
      // exists to prevent, so it can be exercised from here rather than by
      // asking the model a question and reading the wreckage.
      const provider = read.provider?.();
      if (provider === undefined) {
        sendJson(res, 503, { success: false, error: "provider unavailable" });
        return;
      }
      try {
        const result = await provider.search({ query: "deepseek harness", maxResults: 3 });
        sendJson(res, 200, {
          success: true,
          data: { sources: result.sources.length, sample: result.sources[0]?.title ?? "", answer: result.content ?? "" },
        });
      } catch (cause) {
        sendJson(res, 200, { success: false, error: String(cause?.message ?? cause) });
      }
      return;
    }

    sendJson(res, 404, { success: false, error: `no such route: ${req.method} ${path}` });
  };
}
