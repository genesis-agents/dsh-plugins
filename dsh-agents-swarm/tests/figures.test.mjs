// The publisher's own figures: extraction, storage, pacing, serving.
//
// A figure in this system is EVIDENCE, not decoration, and the difference is
// carried by three rules that every test in this file exists to hold:
//
//   1. It never touches the quotable text. `quote_verify` checks a quote as a
//      literal substring of exactly the string `fetch_page` returned, and a
//      caption or an alt attribute spliced into that string makes every
//      verified quote in the system unverifiable.
//   2. It names the page it came off, and links to it. An image without
//      attribution is a fabricated figure.
//   3. It may only appear in a chapter that cites its page — enforced by the
//      join through `mission_documents`, not by convention.
//
// Several of these read the SOURCE rather than an observation, and that is
// deliberate where the property is structural: "this call goes through that
// queue" is not something any single fetch can demonstrate.
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SourceStore } from "../lib/store.js";
import { openMissionStore, documentIdFor } from "../lib/mission-store.js";
import { STAGES } from "../lib/mission-runtime.js";
import { readFigure } from "../lib/insight-corroborate.js";
import { driveFigureBytes } from "../lib/mission-stages-front.js";
import { FIGURE_MIME_TYPES, MAX_FIGURE_BYTES } from "../lib/mission-store.js";
import { createMissionRoutes } from "../lib/mission-routes.js";

/** One module's source, for the structural assertions. */
const sourceOf = (name) => readFileSync(new URL(`../lib/${name}`, import.meta.url), "utf8");

const CORROBORATE = sourceOf("insight-corroborate.js");
const TOOLS = sourceOf("mission-tools.js");
const PROXY = sourceOf("proxy.js");
const STORE = sourceOf("mission-store.js");
const FRONT = sourceOf("mission-stages-front.js");

/**
 * One function's source, from its declaration to the brace that closes it.
 *
 * BALANCED, AND THE PARAMETER LIST IS BALANCED FIRST. Two things in this
 * package break the simpler readings, and each one produced a test that passed
 * by reading the wrong text:
 *
 *   `driveFigureBytes` opens with a DESTRUCTURED PARAMETER LIST across three
 *   lines, so finding the close by matching the declaration's indentation
 *   returns the signature and none of the body — and "does this function call
 *   readFigure" then passed against a parameter list that never could.
 *
 *   `readFigure(url, options = {})` has a DEFAULT VALUE that is a brace, so
 *   balancing from the first `{` after the name balances the default and
 *   returns fifty characters.
 *
 * So: walk the parentheses to the end of the parameter list, then the braces
 * from the first one after it.
 */
function body(source, opening) {
  const at = source.indexOf(opening);
  assert.notEqual(at, -1, `${opening} is gone`);
  const parenAt = source.indexOf("(", at + opening.length - 2);
  let depth = 0;
  let cursor = parenAt;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") depth += 1;
    else if (source[cursor] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const first = source.indexOf("{", cursor);
  depth = 0;
  for (let i = first; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return source.slice(at);
}

/**
 * The same source with its comments taken out.
 *
 * The driver's docblock explains that its true ceiling is the slice plus one
 * `fetchDocument` timeout — and a guard forbidding `fetchDocument` INSIDE the
 * driver then fired on the sentence explaining why the driver does not call
 * it. Tenth time in this repo that a check has matched the prose describing
 * the thing instead of the thing.
 */
function declared(source) {
  return source
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith("//"))
    .join(String.fromCharCode(10));
}

/** The twelve stage rows in the shape `createMission` insists on: 1-based, no gaps. */

/** Enough page for `putDocument` to call the document admissible. */

void DatabaseSync;
void CORROBORATE;
void TOOLS;
void PROXY;
void STORE;
void FRONT;

/** A migrated mission store over an in-memory database, closed after the test. */
function library(t) {
  const store = new SourceStore(":memory:");
  t.after(() => store.close());
  return { store, missions: openMissionStore(store) };
}

/** The twelve stage rows in the shape `createMission` insists on: 1-based, no gaps. */
const STAGE_ROWS = STAGES.map((stage, index) => ({ stepId: stage.id, ordinal: index + 1, status: "pending" }));

/** A running mission owned by `boot-1`, wide enough that no ceiling trips. */
function mission(missions, overrides = {}) {
  const { id } = missions.createMission({
    topic: "how far has solid-state battery manufacturing actually got",
    depth: "quick",
    bootId: "boot-1",
    pid: 4242,
    at: "2026-08-24T00:00:00.000Z",
    config: { resolved: true },
    budget: { maxTokens: 100_000, maxCalls: 200, maxArxiv: 10, maxWeb: 10, maxFetch: 10, wallMs: 3_600_000 },
    ...overrides,
  }, STAGE_ROWS);
  return id;
}

/** One figure on one page, through the batch writer the store actually has. */
function putFigure(missions, { documentId, url, caption = null, width = 1200, height = 800, score = 10, at }) {
  return missions.putFigures(documentId, [{
    url, alt: caption, caption, anchorText: "", textOffset: 0,
    width, height, score, signals: ["figure"],
  // `putFigures` answers `{documentId, ids, written, dropped}` — a batch
  // receipt, not the rows. The id is what a test names a figure by.
  }], at).ids[0];
}

/**
 * A mission with three pages, licensed deliberately differently.
 *
 * WHAT EACH PAGE IS FOR, because the point of the fixture is that two of the
 * three are NOT licensed and the driver must leave them alone:
 *
 *   cited + verified — a finding of this dimension, verified against this page.
 *                      Its figures may be asked for.
 *   unverified       — a finding names the page, but its state is not one of
 *                      FETCH_BACKED_VERIFY_STATES. Unchecked is not evidence,
 *                      so no request goes out.
 *   uncited          — a page in the library no finding of this dimension
 *                      names at all.
 */
function figuredMission(missions, { images, unverifiedImage = null, uncitedImage = null }) {
  const id = mission(missions);
  missions.upsertDimension({ missionId: id, dimensionId: "d1", name: "制造路径", facet: "technical", at: "2026-08-24T00:00:01.000Z" });
  const page = "https://arxiv.org/abs/2401.00001";
  missions.putDocument({ url: page, title: "Sulfide electrolytes at pilot scale", markdown: "solid electrolyte text ".repeat(40), status: 200, fetchedAt: "2026-08-24T00:00:05.000Z" });
  missions.insertFinding({
    missionId: id, dimensionId: "d1", runCount: 1, attempt: 0,
    claim: "Sulfide electrolytes reached 10 mS/cm in pilot cells.",
    evidence: "we measured 10 mS/cm at 25 C in a pilot pouch cell, sustained over two hundred cycles",
    sourceUrl: page, verifyState: "verified-source-text",
    documentId: documentIdFor(page), spanIndex: 2, createdAt: "2026-08-24T00:00:06.000Z",
  });
  // THE SAME INSTANT AS THE DOCUMENT'S OWN FETCH, and it is not tidiness.
  // `figuresForChapter` and `fetchableFigures` both carry
  // `g.last_seen_at = d.fetched_at` — the invariant that stops a picture
  // seen on an OLDER fetch of a page being shown beside the text of the copy
  // we kept. A fixture that stamps its figures two seconds later describes a
  // fetch that never happened, and every query correctly returns nothing.
  const figures = images.map((url, at) => putFigure(missions, {
    documentId: documentIdFor(page), url, caption: `figure ${at + 1}`,
    score: 10 - at, at: "2026-08-24T00:00:05.000Z",
  }));

  let unverified = null;
  if (unverifiedImage !== null) {
    const claimed = "https://example.com/press-release";
    missions.putDocument({ url: claimed, markdown: "press text ".repeat(40), status: 200, fetchedAt: "2026-08-24T00:00:05.000Z" });
    missions.insertFinding({
      missionId: id, dimensionId: "d1", runCount: 1, attempt: 0,
      claim: "The line ships this quarter.", evidence: "shipping this quarter",
      sourceUrl: claimed, verifyState: "unverifiable", createdAt: "2026-08-24T00:00:06.000Z",
    });
    unverified = putFigure(missions, { documentId: documentIdFor(claimed), url: unverifiedImage, at: "2026-08-24T00:00:05.000Z" });
  }

  let uncited = null;
  if (uncitedImage !== null) {
    const orphan = "https://example.net/nobody-cited-this";
    missions.putDocument({ url: orphan, markdown: "uncited text ".repeat(40), status: 200, fetchedAt: "2026-08-24T00:00:05.000Z" });
    uncited = putFigure(missions, { documentId: documentIdFor(orphan), url: uncitedImage, at: "2026-08-24T00:00:05.000Z" });
  }

  return { id, page, figures, unverified, uncited };
}

/* ── the pacing and the deny list ──────────────────────────────────────── */

test("the picture is fetched in the same queue as the page, and the deny list is read against the image's own host", async () => {
  // `paceRead` is module-private and only `createPacer` is exported, so a
  // module that wanted to pace an image fetch could only build a SECOND chain —
  // two request streams at the publishers this library is made of, which is the
  // outcome PACER_CHAINS is a registry to prevent and the reason `fetch_page`
  // refuses a `fetchImpl` at all. Asserted on the SOURCE because the property is
  // "this call goes through that queue", and no observation of one fetch can
  // show it: an unpaced call succeeds identically and the only party who ever
  // learns otherwise is the publisher, weeks later, with a block.
  const fetcher = body(CORROBORATE, "export async function readFigure(");
  assert.match(fetcher, /await paceRead\(\(\) => fetchDocument\(/u, "the image fetch left the pacer; an unpaced fetch loop aimed at these publishers is a worse outcome than a missing picture");
  assert.equal(/options\.fetchImpl/u.test(fetcher), false, "readFigure grew a fetchImpl seam, and an argument that can replace the call is an argument that can unpace it");
  assert.equal(
    (CORROBORATE.match(/= createPacer\(/gu) ?? []).length, 2,
    "this module builds a number of rate chains other than the two it has always had; a third chain aimed at the same publishers is the doubling PACER_CHAINS is a registry to make impossible",
  );

  // The deny list, against the IMAGE's host. A page on an ordinary public host
  // can carry an <img src> pointing at this installation's own infrastructure,
  // and a check already satisfied by the page's host would follow it there.
  const denied = await readFigure("https://library.internal.example/chart.png", { denyHosts: ["internal.example"] });
  assert.equal(denied.ok, false, "a denied host was fetched because the page carrying the image was allowed");
  assert.match(denied.reason, /own infrastructure/u, "the refusal does not say why, so an operator cannot tell it from a publisher 404");

  const private_ = await readFigure("http://192.168.1.10/chart.png", {});
  assert.equal(private_.ok, false, "the image fetcher will probe the host's own network; admissibleUrl is on the page path and has to be on this one too");
  assert.equal(private_.status, 0, "a URL that was never requested reported an HTTP status, which reads as a publisher's answer");
});

/* ── the byte driver ───────────────────────────────────────────────────── */

test("the driver asks only for pictures a chapter's verified findings license, and a refusal is written down instead of retried for ever", async (t) => {
  // EVERY URL HERE IS REFUSED BEFORE A REQUEST GOES OUT — one on the deny list,
  // one in a private range — so this exercises the driver's real path with no
  // network at all. The success path needs a live publisher and there is
  // deliberately no `fetchImpl` to fake one with: an argument that can replace
  // the fetch is an argument that can unpace it, which is the note `fetch_page`
  // carries at mission-tools.js:816. What is NOT covered here is stated in the
  // risks rather than implied by a green run.
  const { missions } = library(t);
  const { id, figures, unverified, uncited } = figuredMission(missions, {
    images: ["https://library.internal.example/chart-1.png", "http://192.168.1.10/chart-2.png"],
    unverifiedImage: "https://cdn.example.net/unverified.png",
    uncitedImage: "https://cdn.example.net/uncited.png",
  });

  const tally = await driveFigureBytes({
    store: missions, missionId: id, runCount: 1, dimensionId: "d1", dimensionCount: 1,
    denyHosts: ["internal.example"], sliceMs: 60_000, now: () => "2026-08-24T00:01:00.000Z",
  });

  assert.equal(tally.requested, 2, "the driver asked for a different number of images than this chapter's verified findings license; a picture off an uncited or unverified page is decoration presented as evidence and must not cost a request to that publisher");
  assert.equal(tally.held, 0);
  assert.equal(missions.getFigure(uncited).state, "candidate", "a figure on a page no finding cites was fetched anyway");
  assert.equal(missions.getFigure(unverified).state, "candidate", "a figure on a page whose only finding failed verification was fetched anyway; unchecked is not evidence");

  // THE PERSISTED NEGATIVE. enrich.js's own recorded scar: a reference that
  // persists no negative re-fetches those pages for ever.
  for (const figureId of figures) {
    const row = missions.getFigure(figureId);
    assert.notEqual(row.state, "candidate", `${figureId} was left a candidate, so the next round asks the same refused host all over again`);
    assert.ok(String(row.reason ?? "").length > 0, `${figureId} was refused with no reason, so an operator cannot tell a blocked host from a publisher's 404`);
  }
  assert.match(
    String(missions.getFigure(figures[0]).reason), /own infrastructure/u,
    "the deny list was read against the PAGE's host rather than the IMAGE's: an ordinary public page can carry an <img src> aimed at this installation, and a check the page already satisfied would follow it there",
  );

  // Nothing is servable, and nothing pretends bytes exist.
  assert.equal(missions.figuresForChapter(id, { runCount: 1, dimensionId: "d1" }).length, 0);
  assert.equal(missions.figureBytes(figures[0]), undefined);

  // Asked twice, asked once.
  const again = await driveFigureBytes({
    store: missions, missionId: id, runCount: 1, dimensionId: "d1", dimensionCount: 1,
    denyHosts: ["internal.example"], sliceMs: 60_000, now: () => "2026-08-24T00:02:00.000Z",
  });
  assert.equal(again.requested, 0, "a figure already refused was requested a second time; that is the loop a persisted negative exists to end");
});

test("the byte pass runs at the dimension boundary, inside the one paced chain, and never without a slice of the wall clock", async (t) => {
  // WHY NOT AT ABSORB TIME, as a measurement rather than a preference. A deep
  // mission is allowed 250 page fetches (mission-budget.js:111). Two figures a
  // page is up to 500 extra requests through the SAME one-at-a-time,
  // one-second chain the researcher's own fetch_page calls queue in — 500
  // seconds of pure gap before a byte transfers, in front of a tool door whose
  // fetch timeout is 45,000 ms. Images queued ahead of a page read turn that
  // read into a timeout refusal, and a picture starts costing findings.
  const driver = body(FRONT, "export async function driveFigureBytes(");
  assert.match(driver, /await readFigure\(/u, "the driver fetches bytes by some route other than readFigure, which is the only fetch in this package that runs inside paceRead and reads the deny list against the image's own host");
  assert.equal(
    /fetchDocument|\bfetch\(/u.test(declared(driver)), false,
    "the driver reaches the network directly, outside the chain that paces the publishers this library is built out of; only createPacer is exported, so a second fetcher can only mean a second chain",
  );

  // The slice is consulted BEFORE a request, so the ceiling is slice + one
  // fetchDocument timeout. Checked after, it would bound nothing: any number of
  // requests could begin inside its final millisecond.
  const guard = driver.indexOf("Date.now() - startedMs >= sliceMs");
  assert.ok(guard > 0, "the wall slice is never checked, so a dimension's figure pass can outlive the mission it belongs to");
  assert.ok(guard < driver.indexOf("await readFigure("), "the slice is checked after the request instead of before it, which bounds nothing");

  // A slice too small to finish one paced request is not a slice. A wall expiry
  // aborts the mission and the artefact is never written, so the figure pass
  // must never be the thing that trips it.
  const { missions } = library(t);
  const { id } = figuredMission(missions, { images: ["https://cdn.example.net/chart.png"] });
  const none = await driveFigureBytes({
    store: missions, missionId: id, runCount: 1, dimensionId: "d1", dimensionCount: 1,
    denyHosts: [], sliceMs: 0, now: () => "2026-08-24T00:01:00.000Z",
  });
  assert.equal(none.requested, 0, "a mission with no wall clock left still opened requests to publishers");
  assert.equal(none.stopped, "no-wall-clock", "the driver stopped without naming the ceiling that stopped it, so 'no figures' and 'no time for figures' read identically on the dimension summary");

  // ONE DENY LIST, NOT TWO. The stage builds toolContext.denyHosts for the tool
  // door; the driver is handed that same array rather than re-reading config,
  // because two readings of one setting is how the door refuses a host that the
  // figure fetcher then goes and asks.
  const caller = body(FRONT, "async function collectOneDimension(");
  assert.match(caller, /denyHosts: toolContext\.denyHosts,/u, "the driver reads the deny list from somewhere other than the array the tool door was given");
  // And it runs after the findings write, never before: the cited set does not
  // exist until that transaction closes.
  assert.ok(
    caller.indexOf("written.verified += 1;") < caller.indexOf("await driveFigureBytes("),
    "the figure pass runs before this dimension's findings are written, so it asks publishers for pictures off pages nothing has yet cited",
  );
});

test("the figure fetcher's fallback ceilings are the store's, by value", () => {
  // insight-corroborate.js cannot import mission-store.js — mission-tools.js
  // imports insight-corroborate and the store imports neither, so the import
  // would point the dependency arrow backwards, and the docblock beside these
  // two constants says exactly that. The honest cost of a copy is drift, and
  // this is what makes drift a failing test instead of a picture that quietly
  // stops appearing. Wider here is a wasted request; narrower here is a figure
  // the store would have kept and the fetcher never asked for.
  const from = CORROBORATE.indexOf("const DEFAULT_FIGURE_TYPES");
  assert.notEqual(from, -1, "the fetcher's fallback constants are gone; a bare readFigure() call now has no ceiling at all");
  const fallbacks = CORROBORATE.slice(from, CORROBORATE.indexOf("\n", CORROBORATE.indexOf("DEFAULT_FIGURE_MAX_BYTES")));
  for (const mime of FIGURE_MIME_TYPES) {
    assert.ok(fallbacks.includes(`"${mime}"`), `${mime} is stored and served, but the fetcher's fallback list does not admit it`);
  }
  assert.equal(
    (fallbacks.match(/"image\/[a-z+]+"/gu) ?? []).length, FIGURE_MIME_TYPES.length,
    "the fetcher admits a type the store does not, so a request goes out for bytes holdFigure will then refuse",
  );
  // The numeric separator the source is written with, from the number itself,
  // so the two cannot be pinned equal by a comment that only looks equal.
  assert.ok(
    fallbacks.includes(`DEFAULT_FIGURE_MAX_BYTES = ${MAX_FIGURE_BYTES.toLocaleString("en-US").replace(/,/gu, "_")}`),
    "the fetcher's byte ceiling drifted from the store's; whichever is narrower silently decides which pictures a report is allowed to have",
  );
  // And the docblock no longer asserts a fact about a file that does not say it.
  assert.match(CORROBORATE, /migration `009-figures` exports both/u, "the corrected docblock is gone; the sentence it replaced asserted the store owned two constants that did not exist");
});

test("only a verified finding licenses a request to a publisher", () => {
  // THE MUTATION THAT SURVIVED THE BEHAVIOURAL TEST, and why it needed a
  // second guard rather than a better fixture.
  //
  // Widening `fetchableFigures`' predicate to admit `'unverifiable'` puts a
  // figure off an unverified page into the fetch queue. The behavioural test
  // could not see it: every URL in that fixture is refused before a request
  // goes out — one on the deny list, one in a private range — precisely so the
  // test needs no network, and a third URL that is neither simply fails to
  // resolve and lands in a different column of the same tally.
  //
  // So the property is asserted where it is decided. `FETCH_BACKED_VERIFY_STATES`
  // is the whole licence: a quote checked against the stored page. Anything
  // else — unverifiable, misattributed, unchecked-* — is a claim nobody
  // confirmed, and a picture fetched on its authority is a request made to a
  // publisher for a page this run has no evidence it read correctly.
  // A PLAIN SLICE, NOT `body`. That helper walks the parameter list to find
  // the body's opening brace, and this method's parameters end before a
  // `.map(() => "?")` inside it — so the paren walk runs off into the query
  // and the brace walk never comes back. Two methods, named at both ends.
  const query = STORE.slice(STORE.indexOf("  fetchableFigures(missionId,"), STORE.indexOf("  heldFigureCounts(missionId,"));
  assert.match(query, /f\.verify_state IN \(\$\{holes\}\)/u, "the fetch queue admits verify states outside FETCH_BACKED_VERIFY_STATES, so an unchecked claim can spend a request at a publisher");
  assert.match(query, /const holes = FETCH_BACKED_VERIFY_STATES\.map\(\(\) => "\?"\)\.join\(","\)/u, "the placeholders are built from something other than FETCH_BACKED_VERIFY_STATES, so the list the query names and the list it binds can drift apart");
  assert.match(query, /g\.state = 'candidate'/u, "the queue no longer restricts itself to candidates, so a held or refused figure can be asked for again");
});

/* ── the byte route ────────────────────────────────────────────────────── */

const ROUTES = readFileSync(new URL("../lib/mission-routes.js", import.meta.url), "utf8");

/** Bytes standing in for an image. Not a valid PNG — nothing here decodes one. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");

/**
 * The mission router, with the response body kept as BYTES.
 *
 * NOT `callRoute` from mission.test.mjs. That one does `String(chunk)` because
 * `report.md` is text, and a shim that stringifies cannot tell a PNG from its
 * own mangling of one — the byte comparison below would pass against garbage.
 */
async function callBytes(missions, url, headers = {}) {
  const chunks = [];
  const res = {
    writeHead(status, head) { res.status = status; res.headers = head ?? {}; },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)); },
    on() {},
  };
  const handler = createMissionRoutes({
    missionStore: missions,
    runtime: { start: () => ({ started: true }), running: () => [], bootId: "boot-1", clock: () => "2026-08-24T01:00:00.000Z" },
    sendJson: (target, status, body) => { target.status = status; target.body = body; },
    readJson: async () => ({}),
  });
  const handled = await handler({ method: "GET", url, headers }, res, new URL(url, "http://local").pathname);
  return { handled, status: res.status, body: res.body, headers: res.headers ?? {}, bytes: Buffer.concat(chunks) };
}

/** The fixture from the driver section, with the bytes put in by hand. */
function servedMission(missions) {
  const held = figuredMission(missions, { images: ["https://cdn.example.net/d1/figure-1.png"] });
  // Written directly, because the only way through the driver is a live
  // publisher and there is deliberately no seam to fake one. The mime arrives
  // with a parameter on purpose: `holdFigure` stores the type as SERVED with its
  // parameters cut off, and comparing the raw header would refuse it.
  missions.holdFigure({ id: held.figures[0], bytes: PNG, mime: "image/png; charset=binary", status: 200, fetchedAt: "2026-08-24T00:01:00.000Z" });
  return held;
}

test("a chapter's figure is served from our own origin, as the bytes we kept, and never as a redirect", async (t) => {
  const { missions } = library(t);
  const { id, figures } = servedMission(missions);

  const listed = await callBytes(missions, `/missions/${id}/figures?dimensionId=d1`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const [row] = listed.body.data.figures;
  assert.equal(row.figureId, figures[0]);
  assert.equal(row.page.url, "https://arxiv.org/abs/2401.00001", "the row carries no page to credit; an image with no attribution is a fabricated figure");
  assert.equal(row.page.title, "Sulfide electrolytes at pilot scale", "the credit has no words to be a link with");
  assert.equal(row.sourceUrl, "https://cdn.example.net/d1/figure-1.png", "the publisher's own image address is missing, so the credit cannot name what it is crediting");
  assert.equal(row.mime, "image/png", "the stored type is the raw header rather than the type as served");
  assert.match(
    row.path, /^\/missions\/[^/]+\/figure\?figureId=[^&]+&runCount=1&dimensionId=d1$/u,
    "the card was handed something other than our own route, carrying its chapter, to point an <img> at",
  );

  const served = await callBytes(missions, row.path);
  assert.equal(served.status, 200, JSON.stringify(served.body));
  assert.equal(served.headers["content-type"], "image/png", "the bytes went out under a type nothing checked");
  assert.equal(served.headers["x-content-type-options"], "nosniff", "a third party's bytes are served from our origin with the browser free to decide for itself what they are");
  assert.match(String(served.headers["content-security-policy"]), /default-src 'none'/u, "navigating straight at a publisher's bytes on our origin is not made inert");
  assert.equal(Buffer.compare(served.bytes, PNG), 0, "the bytes on the wire are not the bytes in the row");
  assert.equal(
    String(served.headers.location ?? ""), "",
    "the route answered with a redirect; a 302 to a publisher's CDN is hotlinking with an extra hop, and client.js:3182 already hotlinks elsewhere so there is no CSP behind this rule",
  );
  assert.equal(
    served.headers["cross-origin-resource-policy"], undefined,
    "CORP would blank every figure wherever apiBase() points at another origin, which lib/remote.js exists to support",
  );

  // THE COPY WE KEPT. Nothing on the serving path touches the network, which is
  // the difference between this route and /proxy/image and the reason a
  // publisher who 404s the image next month changes nothing here.
  const block = ROUTES.slice(ROUTES.indexOf('action === "figure"'), ROUTES.indexOf("res.end(stored.bytes);"));
  assert.ok(block.length > 0, "the byte route is gone from the router");
  assert.equal(/fetchDocument|\bfetch\(|admissibleUrl/u.test(block), false, "the byte route reaches a publisher at request time, which is /proxy/image's design and the opposite of this one");

  // Revalidation is cheap, and a re-extract that replaced the image replaces
  // the validator the browser is holding.
  const again = await callBytes(missions, row.path, { "if-none-match": served.headers.etag });
  assert.equal(again.status, 304, "every render of a long report re-sends every figure whole");
  assert.equal(again.bytes.byteLength, 0, "a 304 carried a body");
});

test("a figure is served only under the chapter that cites its page", async (t) => {
  // RULE 3 IN SQL, NOT IN THE RENDERER. Both routes run ONE query, so the rule
  // deciding what a chapter may SHOW and the rule deciding what bytes go OUT
  // cannot drift apart.
  const { missions } = library(t);
  const { id, figures } = servedMission(missions);
  missions.upsertDimension({ missionId: id, dimensionId: "d2", name: "监管口径", facet: "policy", at: "2026-08-24T00:00:01.000Z" });

  const other = await callBytes(missions, `/missions/${id}/figure?figureId=${figures[0]}&runCount=1&dimensionId=d2`);
  assert.equal(other.status, 404, "a chapter was served a picture off a page its own findings never cite, which is decoration presented as evidence");
  assert.equal(other.body.data.held, 0, "the bound is not on the answer, so a caller cannot tell a stale id from a chapter with no pictures");

  const elsewhere = mission(missions);
  const leak = await callBytes(missions, `/missions/${elsewhere}/figure?figureId=${figures[0]}&runCount=1&dimensionId=d1`);
  assert.equal(leak.status, 404, "one mission's image came back under another mission's path, which is the fetch cache served as evidence");

  const mine = await callBytes(missions, `/missions/${id}/figure?figureId=${figures[0]}&runCount=1&dimensionId=d1`);
  assert.equal(mine.status, 200, "the scope is a scope, not a ban: the chapter that cites the page lost its own picture");

  // The byte route cannot be talked out of naming a chapter, because a URL that
  // could would leave rule 3 holding by convention in the renderer.
  const loose = await callBytes(missions, `/missions/${id}/figure?figureId=${figures[0]}&runCount=1`);
  assert.equal(loose.status, 400, "the byte route served a figure without being told which chapter was asking");

  // And the unscoped listing mints no byte URL at all, while still carrying the
  // attribution a references pane exists to show.
  const inventory = await callBytes(missions, `/missions/${id}/figures`);
  assert.equal(inventory.body.data.figures[0].path, null, "an unscoped listing handed out a byte URL, which is a URL that outlives the scope justifying it");
  assert.equal(inventory.body.data.figures[0].page.url, "https://arxiv.org/abs/2401.00001", "the inventory dropped the attribution, which is the one thing it exists to carry");

  assert.equal(
    ROUTES.split("missionStore.figuresForChapter(id, { runCount: runCount.value, dimensionId: dimensionId.value })").length - 1, 2,
    "the two routes stopped asking the same question, so what a chapter may show and what bytes go out are now two rules free to disagree",
  );
});

test("the byte route refuses a type this build would never have stored", async (t) => {
  // The write-side check stops a hole being dug; this one stops a hole dug by an
  // older build from being served by this one.
  const { missions } = library(t);
  const { id, figures } = servedMission(missions);
  assert.equal(FIGURE_MIME_TYPES.includes("image/svg+xml"), false, "an SVG is a document that runs script; served from our origin as an image it is also offered as a page");

  missions.db.prepare("UPDATE mission_figures SET mime = 'image/svg+xml' WHERE id = ?").run(figures[0]);
  const served = await callBytes(missions, `/missions/${id}/figure?figureId=${figures[0]}&runCount=1&dimensionId=d1`);
  assert.equal(served.status, 404, "a content type this build refuses to store was served anyway, because only the write path checked it");
  assert.equal(
    String(served.body.data.sourceUrl ?? ""), "https://cdn.example.net/d1/figure-1.png",
    "the refusal does not name the image it declined, so nobody can tell which figure vanished out of the report",
  );
});

test("lib/mission-routes.js is CRLF, and the figure block did not arrive as LF", () => {
  // MEASURED, NOT ASSUMED. This is the only file in lib/ with CRLF line endings
  // (mission-store.js, mission-stages-front.js, client.js and proxy.js are all
  // LF). Two bare LFs already survive in it, at CRLF-lines 1069 and 1072, from
  // an earlier patch applied with the wrong ones — so this is not hypothetical,
  // it has happened here before. A multi-line anchor written with \n matches
  // ZERO times in this file, and a replacement written with \n leaves a block
  // whose every line ends differently from the file around it.
  assert.ok(ROUTES.includes("\r\n"), "mission-routes.js is no longer CRLF; every multi-line anchor written against it is now wrong");
  const block = ROUTES.slice(ROUTES.indexOf("// ── the publisher's own figures"), ROUTES.indexOf("res.end(stored.bytes);"));
  assert.ok(block.length > 0, "the figure block is gone from the router");
  assert.equal((block.match(/(?<!\r)\n/gu) ?? []).length, 0, "the figure routes were applied with LF endings into a CRLF file");
});
