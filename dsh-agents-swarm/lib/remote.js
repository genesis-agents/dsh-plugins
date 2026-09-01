/**
 * Proxy mode: serve this machine's `/swarm-api` from another machine's library.
 *
 * The library has to live on the machine that stays on — WAL needs shared
 * memory, so the file cannot be mounted from elsewhere. But the machine that
 * stays on is usually headless, and the machine you work at is usually not.
 * Putting the whole UI through an SSH tunnel to bridge that gap is what this
 * replaces, and it failed for a specific reason worth recording: one long-lived
 * forwarded TCP session carrying every byte of the page. Measured here, the
 * same 11 KB plugin bundle took 60 ms server-to-server over the tailnet and
 * timed out repeatedly through the tunnel.
 *
 * So the page is served locally and only LIBRARY data crosses the network. The
 * browser talks to `127.0.0.1` exactly as it always did — which is not a
 * detail: a cross-origin fetch would need CORS, and a non-loopback origin loses
 * the fifteen API methods the harness pins to loopback (settings, credentials,
 * native dialogs). Proxying keeps all of that working with no client change at
 * all.
 *
 * One thing this deliberately does NOT do is guess. A machine in proxy mode
 * opens no database and starts no timers, because two machines both collecting
 * would fetch all 72 feeds twice into two diverging libraries and publish two
 * podcasts. Which machine owns the library is a decision, not something to
 * detect: configure a remote and you are a viewer, configure nothing and you
 * are the collector.
 */

import { PLUGIN_CHANNEL, PLUGIN_VERSION, versionLabel } from "./version.js";

/** Headers that belong to one hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
  // `expect: 100-continue` IS THIS HOP'S HANDSHAKE AND MUST NOT BE RELAYED.
  //
  // It is a negotiation between a client and the server it is talking to —
  // "may I send the body?" — answered with a 100 Continue before the body is
  // written. This proxy IS that server for the leg that carries it, and Node's
  // http server already answers it. Copying it onto the outbound `fetch` asks
  // undici to conduct a handshake it does not implement, and the whole request
  // fails with a bare "fetch failed" — which this file then reports as
  // "cannot reach the library", blaming the far end for a header the near end
  // added.
  //
  // MEASURED, and it is not exotic. Every .NET client sends it by default
  // (`ServicePointManager.Expect100Continue` is true), and curl adds it for any
  // body over about a kilobyte. So this broke every POST with a body from a
  // .NET caller outright, and would have broken a large enough scope from
  // anything — while the same request without the header, and every GET,
  // worked perfectly. Diagnosed by sending one request twice, identical but
  // for this header: 200 without it, 502 with it.
  "expect",
]);

/**
 * How long to wait for the remote before giving up.
 *
 * Bounded, because the failure being guarded against is a HANG rather than a
 * refusal. An unbounded proxy turns a wedged network into a page that spins
 * forever, which is exactly how the tunnel presented and exactly why it took
 * so long to diagnose.
 */
const TIMEOUT_MS = 30_000;

/** Longer, for episode audio: a 10-minute show is megabytes over a slow link. */
const MEDIA_TIMEOUT_MS = 180_000;

/** Route prefixes whose bodies are large enough to deserve the longer budget. */
const MEDIA_PATHS = ["/publish/episodes/", "/thumbnail/", "/proxy/image", "/proxy/pdf"];

/** Whether this request's body warrants the long timeout. */
function isMedia(path) {
  return MEDIA_PATHS.some((prefix) => path.startsWith(prefix));
}

/**
 * Build a handler that forwards `/swarm-api/*` to a remote library.
 * @param remote - normalized remote base, e.g. `https://box.tailnet.ts.net/swarm-api`.
 * @param logger - Cordis logger.
 * @param prefix - route prefix the harness registered this handler under.
 * @returns a Node request handler.
 */
export function createProxyHandler(remote, logger, prefix = "/swarm-api") {
  return async function handleProxy(req, res) {
    // A prefix-registered handler receives the FULL path, prefix included, and
    // `remote` already ends in that same prefix -- so appending req.url raw
    // asks the far end for /swarm-api/swarm-api/stats. It answers "no such
    // route", which reads as a broken remote rather than as a doubled prefix,
    // and the proxy looks innocent because it faithfully relayed the 404.
    const raw = req.url ?? "/";
    const suffix = raw.startsWith(prefix) ? (raw.slice(prefix.length) || "/") : raw;

    // Answered here AND asked of the far end, which is the whole point.
    //
    // Forwarding it would report the remote's version under both names.
    // Answering it locally — the first version of this — reported the local
    // version under both names, so the page compared this machine against
    // itself and always agreed. Either way the one fact worth having is lost:
    // whether the machine serving the routes is running the same code as the
    // page asking for them. So both are named.
    if (req.method === "GET" && suffix === "/version") {
      let remoteVersion = null;
      let remoteLabel = null;
      let remoteChannel = null;
      let remoteError = null;
      try {
        // Short, and non-fatal. This is a label on a settings page; a slow far
        // end must not make the page that reports it slow too.
        const probe = await fetch(`${remote}/version`, { signal: AbortSignal.timeout(6000) });
        if (probe.status === 404) {
          // The route itself is missing, which is not a failure to read a
          // version — it is the version. That machine is older than this
          // feature, and saying so names the fix.
          remoteError = "older than this route";
        } else {
          const payload = await probe.json();
          remoteVersion = payload?.data?.version ?? null;
          // The label carries the commit for a checkout, which is the only
          // thing that separates two machines both claiming 0.1.0.
          remoteLabel = payload?.data?.label ?? remoteVersion;
          remoteChannel = payload?.data?.channel ?? null;
          if (remoteVersion === null) remoteError = "answered without a version";
        }
      } catch (cause) {
        remoteError = String(cause?.message ?? cause);
      }
      const body = JSON.stringify({
        success: true,
        data: {
          version: PLUGIN_VERSION,
          channel: PLUGIN_CHANNEL,
          label: versionLabel(),
          node: process.versions.node,
          library: "remote",
          remote,
          remoteVersion,
          remoteLabel,
          remoteChannel,
          remoteError,
        },
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    const target = `${remote}${suffix}`;
    const controller = new AbortController();
    const budget = isMedia(suffix) ? MEDIA_TIMEOUT_MS : TIMEOUT_MS;
    const timer = setTimeout(() => { controller.abort(); }, budget);

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }
    // Range is what makes seeking in an episode work rather than silently
    // reloading from the start, so it has to survive the hop. It is already
    // covered by the copy above; named here so a future filter does not drop it.

    try {
      const response = await fetch(target, {
        method: req.method,
        headers,
        // GET and HEAD carry no body; passing the stream for them throws.
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
        duplex: "half",
        redirect: "manual",
        signal: controller.signal,
      });

      const out = {};
      for (const [key, value] of response.headers.entries()) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
      }
      res.writeHead(response.status, out);
      if (response.body === null) {
        res.end();
        return;
      }
      // Streamed, not buffered: a 1.5 MB episode read into memory before the
      // first byte reaches the browser would add latency for nothing, and a
      // long show would add more.
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch (cause) {
      const aborted = cause?.name === "AbortError";
      const message = aborted
        ? `the library at ${remote} did not answer within ${Math.round(budget / 1000)}s`
        : `cannot reach the library at ${remote}: ${String(cause?.message ?? cause)}`;
      logger?.warn?.(`swarm: proxy ${suffix}: ${message}`);
      if (res.headersSent) {
        // Mid-stream: the status already said 200 and the page has part of the
        // body. Ending the response is all that is left; a truncated payload is
        // at least honest, where a second status line would be a protocol error.
        res.end();
        return;
      }
      const body = JSON.stringify({ success: false, error: message, remote });
      res.writeHead(aborted ? 504 : 502, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
    } finally {
      clearTimeout(timer);
    }
  };
}
