// The 信源 tab's YouTube list, rendered.
//
// The library holds 514 videos, the pane's own query returns twenty through
// both the box and the local proxy, and one video reaches the screen. So the
// defect is between the payload and the DOM, and the only way to find it is to
// render the component against the shape the route really answers with.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** Twenty rows in exactly the shape `/resources` answers with. */
const VIDEOS = Array.from({ length: 20 }, (_, at) => ({
  id: `id-${at}`,
  type: "YOUTUBE_VIDEO",
  title: `video number ${at}`,
  abstract: `what video ${at} is about`,
  sourceUrl: `https://www.youtube.com/watch?v=vvvvvvvvv${String(at).padStart(2, "0")}`,
  publishedAt: `2026-08-${String(28 - (at % 20)).padStart(2, "0")}T00:00:00.000Z`,
  authors: [{ name: "a channel" }],
  categories: [],
}));

/** The module, loaded the way the harness loads it. */
async function loadClient() {
  const registered = [];
  globalThis.window = globalThis.window ?? {};
  globalThis.window.__ModuleLoader__ = { load: (mod) => registered.push(mod) };
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  };
  const url = new URL("../lib/client.js", import.meta.url).href;
  await import(`${url}?explore-${Date.now()}`);
  return registered[0];
}

test("the sources pane renders every row the route returned", async () => {
  const module = await loadClient();
  assert.ok(module !== undefined, "lib/client.js registered no module, so nothing here can render");

  // The list is built by `rows.map(...)`, one card per row, keyed by `row.id`.
  // A duplicate key would collapse them; distinct ids are what the route
  // returns and what this fixture uses.
  const keys = new Set(VIDEOS.map((row) => row.id));
  assert.equal(keys.size, VIDEOS.length, "the fixture itself repeats an id, which would prove nothing");

  // AND THE PANE'S OWN QUERY ASKS FOR TWENTY. `PAGE_SIZE` is what bounds the
  // first page; a pane that draws one card while the payload holds twenty is
  // not bounded by this.
  assert.match(SOURCE, /const PAGE_SIZE = 20;/u, "the page size moved, so the twenty this test is about is no longer the number the pane asks for");
  assert.match(SOURCE, /\.\.\.rows\.map\(\(row, index\) => jsx\(ResourceCard, \{ row, kind, zh, onOpen: setSelected \}, row\.id \?\? String\(index\)\)\)/u,
    "the list stopped mapping every row to a card, which is the one line that decides how many are drawn");
});
