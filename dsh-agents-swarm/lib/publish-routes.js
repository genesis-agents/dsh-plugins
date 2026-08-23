/**
 * The 发布 tab's HTTP face: turning selected sources into a spoken episode.
 *
 * Rendering an episode is not a request-shaped operation. A ten-minute show is
 * one model call for the script plus roughly forty synthesis round trips, and
 * an HTTP request held open for minutes reads as a hang — the page cannot tell
 * "working" from "dead", and a proxy or a closed laptop lid ends it with
 * nothing to show for the tokens already spent. So rendering is a JOB: the
 * request starts it and returns an id, and the page follows progress. The
 * script step stays a plain request because it is one model call and the
 * result is something the reader wants to see and edit before paying for
 * forty more.
 *
 * Jobs live in memory only. A restart loses an in-flight render, and that is
 * the right trade at this scale: the audio for finished turns is worth nothing
 * without the rest, and persisting partial jobs would mean reasoning about
 * resuming a synthesis stream. A finished episode IS persisted — that is the
 * artefact.
 */

import { DEFAULT_HOSTS, TTS_BACKENDS, VOICES, concatMp3, synthesizeTurns } from "./tts.js";
import { generateScript } from "./podcast.js";
import { buildFeed, deleteEpisode, episodePath, getEpisode, listEpisodes, saveEpisode } from "./episodes.js";
import { pickSources, readPublishConfig, runScheduled } from "./publish-schedule.js";
import { DOCUMENT_FORMATS, findFormat, generateDocument } from "./documents.js";
import { deleteDocument, getDocument, listDocuments, saveDocument } from "./document-store.js";

/** Sources one episode may draw on. */
const MAX_SOURCES = 20;

/** Renders kept after they finish, so a page that polls late still learns the outcome. */
const JOB_RETENTION = 40;

/** In-flight and recently finished renders, newest first. */
const jobs = new Map();

/** A short opaque job id. */
function jobId() {
  return `job-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Drop the oldest finished jobs once the map grows past its retention. */
function pruneJobs() {
  if (jobs.size <= JOB_RETENTION) return;
  const finished = [...jobs.entries()].filter(([, job]) => job.state !== "running");
  finished.sort((left, right) => left[1].startedAt.localeCompare(right[1].startedAt));
  for (const [id] of finished.slice(0, jobs.size - JOB_RETENTION)) jobs.delete(id);
}

/**
 * Register the publish routes onto an existing handler chain.
 *
 * Returns a function that answers a publish request or reports that it did
 * not, so the caller keeps one router rather than two competing ones.
 * @param deps - `{ store, chat, logger, sendJson, readJson }` from the Host half.
 * @returns `async (req, res, path) => boolean` — true when it answered.
 */
export function createPublishRoutes({ store, chat, logger, sendJson, readJson }) {
  return async function handlePublish(req, res, path) {
    // ── what the page needs to render its controls ───────────────────────
    if (req.method === "GET" && path === "/publish/voices") {
      sendJson(res, 200, { success: true, data: { voices: VOICES, hosts: DEFAULT_HOSTS, backends: TTS_BACKENDS } });
      return true;
    }

    // ── the script: one model call, returned for review ──────────────────
    if (req.method === "POST" && path === "/publish/script") {
      if (chat === undefined) {
        sendJson(res, 503, { success: false, error: "no model routed" });
        return true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return true;
      }
      const ids = Array.isArray(body.resourceIds) ? body.resourceIds.slice(0, MAX_SOURCES) : [];
      const sources = ids.map((id) => store.get(id)).filter((row) => row !== undefined);
      if (sources.length === 0) {
        sendJson(res, 400, { success: false, error: "select at least one source that exists" });
        return true;
      }
      // A video's substance is its transcript, and the library already holds
      // the ones that were fetched. Passing them here is what keeps an
      // episode about a podcast from being an episode about its description.
      const withTranscripts = sources.map((row) => ({ row, transcript: store.getTranscript(row.id) }));
      const minutes = Number.isFinite(Number(body.minutes)) ? Math.max(2, Math.min(20, Number(body.minutes))) : 6;
      try {
        const script = await generateScript(chat, withTranscripts, { minutes });
        sendJson(res, 200, { success: true, data: { ...script, sourceIds: sources.map((row) => row.id), minutes } });
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return true;
    }

    // ── the render: a job, because it takes minutes ──────────────────────
    if (req.method === "POST" && path === "/publish/render") {
      let body;
      try {
        body = await readJson(req, 1024 * 1024);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return true;
      }
      const turns = Array.isArray(body.turns) ? body.turns : [];
      if (turns.length === 0) {
        sendJson(res, 400, { success: false, error: "no turns to speak" });
        return true;
      }
      const hosts = {
        a: typeof body.hosts?.a === "string" && body.hosts.a !== "" ? body.hosts.a : DEFAULT_HOSTS.a,
        b: typeof body.hosts?.b === "string" && body.hosts.b !== "" ? body.hosts.b : DEFAULT_HOSTS.b,
      };
      const id = jobId();
      const job = {
        id,
        state: "running",
        done: 0,
        total: turns.length,
        startedAt: new Date().toISOString(),
        title: typeof body.title === "string" ? body.title : "",
      };
      jobs.set(id, job);
      pruneJobs();

      // Deliberately not awaited: the response goes back now and the work
      // continues. An unhandled rejection here would take the process with
      // it, so every path inside settles the job instead of throwing.
      void (async () => {
        try {
          const { segments } = await synthesizeTurns(turns, hosts, (done, total) => {
            job.done = done;
            job.total = total;
          });
          const audio = concatMp3(segments);
          const episode = await saveEpisode({
            audio,
            title: job.title,
            script: { title: job.title, turns },
            sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds : [],
            voices: hosts,
          });
          job.state = "done";
          job.episodeId = episode.id;
          job.finishedAt = new Date().toISOString();
          logger?.info?.(`swarm: published "${episode.title}" (${episode.durationSeconds}s, ${turns.length} turns)`);
        } catch (cause) {
          job.state = "error";
          job.error = String(cause?.message ?? cause);
          job.finishedAt = new Date().toISOString();
          logger?.warn?.(`swarm: publish failed: ${job.error}`);
        }
      })();

      sendJson(res, 202, { success: true, data: { jobId: id, total: turns.length } });
      return true;
    }

    if (req.method === "GET" && path.startsWith("/publish/jobs/")) {
      const job = jobs.get(decodeURIComponent(path.slice("/publish/jobs/".length)));
      if (job === undefined) {
        // A job the server never had and one it has forgotten are the same
        // answer to the page: stop polling, and say why.
        sendJson(res, 404, { success: false, error: "no such render job; it may have finished long ago or been lost to a restart" });
        return true;
      }
      sendJson(res, 200, { success: true, data: job });
      return true;
    }

    // ── written formats: the digest and the report ──────────────────
    // Not a job, unlike a render: one model call, and the reader wants to see
    // the result before deciding whether to keep it. A minute of waiting for
    // something you are about to read is different from four minutes of
    // waiting for forty synthesis round trips.
    if (req.method === "GET" && path === "/publish/formats") {
      sendJson(res, 200, { success: true, data: { formats: DOCUMENT_FORMATS } });
      return true;
    }

    if (req.method === "POST" && path === "/publish/document") {
      if (chat === undefined) {
        sendJson(res, 503, { success: false, error: "no model routed" });
        return true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return true;
      }
      const format = findFormat(body.format);
      if (format === undefined) {
        sendJson(res, 400, { success: false, error: `unknown format: ${body.format}` });
        return true;
      }
      const ids = Array.isArray(body.resourceIds) ? body.resourceIds.slice(0, MAX_SOURCES) : [];
      const sources = ids.map((id) => store.get(id)).filter((row) => row !== undefined);
      if (sources.length === 0) {
        sendJson(res, 400, { success: false, error: "select at least one source that exists" });
        return true;
      }
      // A video's substance is its transcript, exactly as for a script.
      const withTranscripts = sources.map((row) => ({ row, transcript: store.getTranscript(row.id) }));
      try {
        const document = await generateDocument(chat, withTranscripts, {
          format,
          zh: body.zh === true,
          guidance: typeof body.guidance === "string" ? body.guidance : "",
        });
        const record = saveDocument({
          text: document.text,
          title: document.title,
          format: format.id,
          sourceIds: sources.map((row) => row.id),
          guidance: body.guidance,
        });
        logger?.info?.(`swarm: wrote a ${format.id} "${record.title}" from ${sources.length} source(s)`);
        sendJson(res, 200, { success: true, data: { ...record, text: document.text } });
      } catch (cause) {
        sendJson(res, 502, { success: false, error: String(cause?.message ?? cause) });
      }
      return true;
    }

    if (req.method === "GET" && path === "/publish/documents") {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      sendJson(res, 200, {
        success: true,
        data: listDocuments({
          take: params.get("take") ?? undefined,
          skip: params.get("skip") ?? undefined,
          format: params.get("format") ?? undefined,
        }),
      });
      return true;
    }

    if (req.method === "GET" && path.startsWith("/publish/documents/")) {
      const document = getDocument(decodeURIComponent(path.slice("/publish/documents/".length)));
      if (document === undefined) {
        sendJson(res, 404, { success: false, error: "no such document" });
        return true;
      }
      sendJson(res, 200, { success: true, data: document });
      return true;
    }

    if (req.method === "DELETE" && path.startsWith("/publish/documents/")) {
      try {
        const removed = deleteDocument(decodeURIComponent(path.slice("/publish/documents/".length)));
        sendJson(res, 200, { success: true, data: { removed } });
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
      }
      return true;
    }

    // ── the schedule: what the always-on machine does by itself ────
    if (req.method === "GET" && path === "/publish/schedule") {
      const config = readPublishConfig(store);
      sendJson(res, 200, {
        success: true,
        data: {
          ...config,
          // What TODAY would draw on, so the schedule can be judged before it
          // runs rather than by reading tomorrow's episode. A schedule whose
          // only feedback arrives once a day is a schedule nobody trusts.
          waiting: pickSources(store, config).length,
        },
      });
      return true;
    }

    if (req.method === "POST" && path === "/publish/run-now") {
      if (chat === undefined) {
        sendJson(res, 503, { success: false, error: "no model routed" });
        return true;
      }
      // Answered immediately for the same reason a render is: this IS a render,
      // plus a model call. `markSkips: false` — a manual run that finds nothing
      // must not mark the day served and cancel the morning's scheduled one.
      void runScheduled(store, chat, logger, { markSkips: false });
      sendJson(res, 202, { success: true, data: { started: true } });
      return true;
    }

    // ── the episodes ─────────────────────────────────────────────────────
    if (req.method === "GET" && path === "/publish/episodes") {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      sendJson(res, 200, {
        success: true,
        data: listEpisodes({ take: params.get("take") ?? undefined, skip: params.get("skip") ?? undefined }),
      });
      return true;
    }

    if (req.method === "GET" && path.startsWith("/publish/episodes/") && path.endsWith("/audio")) {
      const id = decodeURIComponent(path.slice("/publish/episodes/".length, -"/audio".length));
      let file;
      try {
        file = episodePath(id);
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
        return true;
      }
      const { existsSync, statSync, createReadStream } = await import("node:fs");
      if (!existsSync(file)) {
        sendJson(res, 404, { success: false, error: "no such episode" });
        return true;
      }
      const size = statSync(file).size;
      // Range support is not optional here: an <audio> element seeking in a
      // ten-minute file, and every podcast client, ask for ranges. Answering
      // 200 with the whole body makes seeking silently reload from the start.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range !== null) {
        const start = range[1] === "" ? 0 : Number(range[1]);
        const end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
        if (!Number.isFinite(start) || start > end || start >= size) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return true;
        }
        res.writeHead(206, {
          "content-type": "audio/mpeg",
          "content-length": end - start + 1,
          "content-range": `bytes ${start}-${end}/${size}`,
          "accept-ranges": "bytes",
        });
        createReadStream(file, { start, end }).pipe(res);
        return true;
      }
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": size, "accept-ranges": "bytes" });
      createReadStream(file).pipe(res);
      return true;
    }

    if (req.method === "DELETE" && path.startsWith("/publish/episodes/")) {
      const id = decodeURIComponent(path.slice("/publish/episodes/".length));
      try {
        const removed = await deleteEpisode(id);
        sendJson(res, 200, { success: true, data: { removed } });
      } catch (cause) {
        sendJson(res, 400, { success: false, error: String(cause?.message ?? cause) });
      }
      return true;
    }

    // ── the feed ─────────────────────────────────────────────────────────
    if (req.method === "GET" && path === "/publish/feed.xml") {
      const { episodes } = listEpisodes();
      // The feed has to name absolute URLs, and the host that will be typed
      // into a podcast client is not knowable from here — it is whatever
      // reached us. Trusting the Host header is right for a feed served to
      // the person who asked for it, and wrong for anything with authority.
      const host = req.headers.host ?? "127.0.0.1:3080";
      // The scheme comes from the proxy, not from an assumption. Tailscale
      // Serve — and any TLS terminator — speaks https to the client and plain
      // http to us, so hardcoding `http://` here produced enclosure URLs
      // pointing at a port nothing listens on. The feed still parsed and still
      // listed every episode; they simply all failed to download, which a
      // podcast client reports as a broken episode rather than as a wrong URL.
      const forwarded = req.headers["x-forwarded-proto"];
      const scheme = typeof forwarded === "string" && forwarded.trim() !== ""
        ? forwarded.split(",")[0].trim()
        : "http";
      const origin = `${scheme}://${host}`;
      const xml = buildFeed(episodes, {
        baseUrl: origin,
        link: `${origin}/`,
        // The real route, handed over rather than guessed at: a feed whose
        // enclosure points somewhere this server does not serve downloads
        // nothing, and the client reports it as a broken episode rather than
        // as a wrong URL.
        audioUrl: (episode) => `${origin}/swarm-api/publish/episodes/${encodeURIComponent(episode.id)}/audio`,
      });
      res.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        "content-length": Buffer.byteLength(xml),
        "cache-control": "no-store",
      });
      res.end(xml);
      return true;
    }

    return false;
  };
}

export { getEpisode };
