// Render the settings page, in Node, without a browser.
//
// Three times this session a change to lib/client.js produced a page that was
// simply blank — `exact is not defined`, `kindId is not defined` — and each
// time every check that existed passed. They were all static: the file parses,
// the bundle is served, the plugin registers. None of them ever CALLS a
// component, and a ReferenceError inside one is invisible until a person opens
// the tab it lives in.
//
// So this calls them. The mini-React below is not a general implementation and
// is not trying to be: it holds state per hook slot, runs effects, and settles
// by re-rendering until nothing changes. That is enough to execute every line
// of a component's body against realistic data, which is the whole point — a
// crash here is a blank page there.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

/**
 * A JSX element, as the stub runtime records it.
 *
 * `render` swaps in a version of this that also DESCENDS into child function
 * components. The first draft did not, which made the whole harness weaker
 * than it looked: it recorded `{type: VersionLine}` and moved on, so a
 * ReferenceError inside any child was still invisible — the exact class of bug
 * this file exists to catch, surviving inside the thing built to catch it.
 */
let element = (type, props, key) => ({ type, props: props ?? {}, key });

/**
 * Render one component function to a tree, running its effects to quiescence.
 *
 * Hooks are stored in a flat array indexed by call order, which is exactly the
 * rule real React enforces, so a component that breaks the rule breaks here in
 * the same way rather than silently working.
 */
async function render(Component, props = {}) {
  // One hook store per component instance, keyed by the order it is reached in
  // a pass. That is the same identity rule React uses, so a component whose
  // hooks are conditional misbehaves here in the same way rather than quietly
  // working.
  const stores = new Map();
  let frame = null;
  let seq = 0;
  const effects = [];
  const cleanups = [];
  let dirty = false;

  const plain = (type, props2, key) => ({ type, props: props2 ?? {}, key });
  element = (type, props2, key) => {
    if (typeof type !== "function") return plain(type, props2, key);
    if (seq > 5000) throw new Error("render did not terminate");
    const id = `${type.name || "anon"}#${seq++}`;
    if (!stores.has(id)) stores.set(id, []);
    const outer = frame;
    frame = { slots: stores.get(id), cursor: 0 };
    try {
      return type(props2 ?? {});
    } finally {
      frame = outer;
    }
  };

  const react = {
    useState(initial) {
      const f = frame;
      const at = f.cursor++;
      if (f.slots.length <= at) f.slots[at] = typeof initial === "function" ? initial() : initial;
      const set = (next) => {
        const value = typeof next === "function" ? next(f.slots[at]) : next;
        if (!Object.is(value, f.slots[at])) { f.slots[at] = value; dirty = true; }
      };
      return [f.slots[at], set];
    },
    // Identity is not memoized: returning the function as-is re-runs effects
    // that depend on it, which converges here because the loop below stops
    // when a pass changes nothing.
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef(initial) {
      const f = frame;
      const at = f.cursor++;
      if (f.slots.length <= at) f.slots[at] = { current: initial };
      return f.slots[at];
    },
    useEffect: (fn) => { effects.push(fn); },
    useLayoutEffect: (fn) => { effects.push(fn); },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };

  const call = (type, props2, key) => element(type, props2, key);
  const runtime = { jsx: call, jsxs: call, Fragment: Symbol("Fragment") };
  const load = captureFactory();
  const exported = load((name) => (name === "react" ? react : runtime));

  const Target = typeof Component === "string" ? exported.__test__?.[Component] : Component;
  assert.ok(Target, `no such component: ${Component}`);

  let tree = null;
  const settle = async () => {
    for (let pass = 0; pass < 20; pass += 1) {
      seq = 0;
      dirty = false;
      effects.length = 0;
      tree = element(Target, props);
      // Last pass's cleanups first, then this pass's effects. Running a
      // cleanup the instant its effect returned -- which is what this did --
      // is not "tidying up", it is cancelling the effect: every `let live =
      // true; ... return () => { live = false }` guard fired before its own
      // fetch could resolve, so any state that arrives asynchronously never
      // arrived at all, and the component under test rendered forever in its
      // initial state while the harness reported no error.
      for (const cleanup of cleanups.splice(0)) cleanup();
      for (const effect of effects) {
        const teardown = effect();
        if (typeof teardown === "function") cleanups.push(teardown);
      }
      // Effects here are async fetches; let their promises settle before
      // deciding whether the pass changed anything.
      await new Promise((resolve) => setImmediate(resolve));
      if (!dirty) break;
    }
    return tree;
  };
  await settle();
  // `act` is what makes this a test of the feature rather than of one frame:
  // a tab that renders and does not switch is the same to a static check and
  // not the same to anybody using it.
  return { get tree() { return tree; }, act: async (fn) => { fn(); return settle(); } };
}

/** Run the bundle's factory, capturing what it registers. */
function captureFactory() {
  const source = readFileSync(CLIENT, "utf8");
  let factory;
  const window = {
    __ModuleLoader__: { load: (registration) => { factory = registration.factory; } },
    __DSH_SWARM_API_BASE__: "/swarm-api",
    // The page builds absolute URLs from this (the RSS address it shows you).
    location: { origin: "http://127.0.0.1:3080", href: "http://127.0.0.1:3080/" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  const document = {
    documentElement: { lang: "zh-CN" },
    addEventListener() {},
    removeEventListener() {},
  };
  // Indirect eval keeps the bundle out of this module's scope, so it can only
  // reach the globals handed to it here — the same ones a browser would.
  const run = new Function("window", "document", "globalThis", source);
  run(window, document, { ...globalThis, window, document });
  assert.ok(factory, "the bundle did not register through __ModuleLoader__.load");
  return (require) => {
    const module = { exports: {} };
    return factory(require, module, module.exports) ?? module.exports;
  };
}

/** The bundle's test exports, without rendering anything. */
function exportsOf() {
  const load = captureFactory();
  const noop = () => {};
  const react = {
    useState: (i) => [typeof i === "function" ? i() : i, noop],
    useCallback: (f) => f, useMemo: (f) => f(), useRef: (i) => ({ current: i }),
    useEffect: noop, useLayoutEffect: noop, useSyncExternalStore: (_s, g) => g(),
  };
  const el = (t, p) => ({ type: t, props: p ?? {} });
  return load((name) => (name === "react" ? react : { jsx: el, jsxs: el })).__test__;
}

/** Every string rendered anywhere in a tree. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node.props ?? {})) textOf(value, out);
    return out;
  }
  return out;
}

/** Find the first node whose props match a predicate. */
function find(node, predicate, seen = new Set()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) { const hit = find(child, predicate, seen); if (hit) return hit; }
    return null;
  }
  if (predicate(node)) return node;
  for (const value of Object.values(node.props ?? {})) {
    const hit = find(value, predicate, seen);
    if (hit) return hit;
  }
  return null;
}

const CONFIG = {
  feeds: [
    { url: "https://rss.arxiv.org/rss/cs.AI", type: "PAPER", name: "arXiv cs.AI" },
    { url: "https://openai.com/news/rss.xml", type: "BLOG", name: "OpenAI" },
  ],
  jobs: [{ collector: "arxiv", options: { query: "cat:cs.AI", max: 50 } }],
  transcriptLanguages: ["zh-Hans", "en"],
  collectIntervalMinutes: 60,
  supadataKeySet: true,
  collectors: ["feed", "arxiv"],
  resourceTypes: ["PAPER", "BLOG", "NEWS"],
};

const STATUS = {
  intervalMinutes: 60,
  nextExpectedAt: "2026-08-24T00:00:00.000Z",
  runs: [{
    startedAt: "2026-08-23T22:00:00.000Z", finishedAt: "2026-08-23T22:01:00.000Z",
    written: 12, total: 20696, failures: [],
  }],
};

const SCHEDULE = {
  publishAt: "", publishKinds: ["NEWS"], publishSources: 8, publishMinutes: 8,
  publishHosts: { a: "zh-CN-XiaoxiaoNeural", b: "zh-CN-YunxiNeural" },
  publishMinSources: 3, publishArtifacts: ["podcast"], publishChinese: true,
  publishLastRun: null, publishLastManualRun: null,
};

// One card, shaped exactly as `/insights/list` answers: three status fields
// rather than one coalesced `status`, and an `evidencePreview` whose second row
// is a source the library no longer holds — `title`/`sourceUrl` null, which the
// page must render as a quote it cannot open rather than dropping the row and
// disagreeing with the `6 篇` printed above it.
const INSIGHT = {
  id: "insight-20260818T090000Z-1a2b3c4d",
  statement: "三家实验室同期收敛到同一种推理时序扩展做法",
  kind: "finding", entities: ["DeepMind", "OpenAI"],
  status: "standing", pinnedStatus: null, effectiveStatus: "standing",
  firstSeenAt: "2026-08-18T09:00:00.000Z", lastSeenAt: "2026-08-23T09:00:00.000Z",
  sourceCount: 6, independentCount: 4, contradictionCount: 1,
  novelty: 0.4, relevance: 0.5, credibility: 0.9, momentum: 0.8, rankScore: 0.71,
  scoredAt: "2026-08-23T09:05:00.000Z", supersedes: null,
  evidencePreview: [
    { resourceId: "r1", stance: "supports", quote: "we observe the same scaling behaviour at test time",
      sourceKey: "arxiv", title: "Scaling test-time compute", sourceUrl: "https://arxiv.org/abs/1", type: "PAPER" },
    { resourceId: "r2", stance: "supports", quote: "test-time compute now dominates our eval budget",
      sourceKey: "deepmind.google", title: null, sourceUrl: null, type: null },
    { resourceId: "r3", stance: "contradicts", quote: "the effect disappears when the prompts are held fixed",
      sourceKey: "someblog.example", title: "A dissent", sourceUrl: "https://someblog.example/x", type: "BLOG" }
  ]
};

// A claim first seen this morning with one source behind it: what the tab
// holds on day one, before anything has been corroborated. Candidates are on
// the default page rather than hidden by it — hiding them gives a first day
// that reads as a broken feature rather than as a sprawl control.
const CANDIDATE = {
  id: "insight-20260823T060000Z-9f8e7d6c",
  statement: "Mistral 在 8 月 22 日开源了一版 24B 推理模型，权重按 Apache 2.0 发布",
  kind: "launch", entities: ["Mistral"],
  status: "candidate", pinnedStatus: null, effectiveStatus: "candidate",
  firstSeenAt: "2026-08-23T06:00:00.000Z", lastSeenAt: "2026-08-23T06:00:00.000Z",
  sourceCount: 1, independentCount: 1, contradictionCount: 0,
  novelty: 1, relevance: 0.3, credibility: 0.55, momentum: 0, rankScore: 0.42,
  scoredAt: "2026-08-23T06:05:00.000Z", supersedes: null,
  evidencePreview: [
    { resourceId: "r7", stance: "supports", quote: "the weights are available under Apache 2.0 from today",
      sourceKey: "mistral.ai", title: "Magistral 24B", sourceUrl: "https://mistral.ai/news/x", type: "BLOG" }
  ]
};

// A claim nothing has corroborated since June. It is off the default page by
// design — the default clause is `status != 'dormant'` — and only the 已沉寂
// chip reaches it, which is the one thing that tells a filter apart from a
// decoration.
const DORMANT = {
  id: "insight-20260701T090000Z-0badc0de",
  statement: "某公司 6 月宣布的万卡集群至今没有第二个来源提到过",
  kind: "shift", entities: ["某公司"],
  status: "dormant", pinnedStatus: null, effectiveStatus: "dormant",
  firstSeenAt: "2026-07-01T09:00:00.000Z", lastSeenAt: "2026-07-02T09:00:00.000Z",
  sourceCount: 1, independentCount: 1, contradictionCount: 0,
  novelty: 0, relevance: 0.2, credibility: 0.5, momentum: 0.15, rankScore: 0.18,
  scoredAt: "2026-08-23T09:05:00.000Z", supersedes: null,
  evidencePreview: [
    { resourceId: "r9", stance: "supports", quote: "the cluster is described as the largest of its kind in the region",
      sourceKey: "wire.example", title: "A wire report", sourceUrl: "https://wire.example/y", type: "NEWS" }
  ]
};

// The full tally, sent with every page whatever the chip says, so the tab can
// offer "+N candidates" without a second request.
const INSIGHT_COUNTS = { candidate: 3, standing: 1, contested: 1, dormant: 2 };

/** One page of `/insights/list`, counts and all. */
const insightPage = (rows) => ({ insights: rows, total: rows.length, hasMore: false, counts: INSIGHT_COUNTS });

// What each chip is answered with. Five different answers on purpose: a stub
// that hands back the same cards whatever the filter says lets a tab whose
// chips do nothing at all pass a test named after them.
//
// 升温中 is empty here, and that is a fixture rather than an oversight: a chip
// with nothing under it and a library with nothing in it are two different
// sentences, and only a filter that can come back empty proves the page tells
// them apart.
const INSIGHT_PAGES = {
  "": insightPage([INSIGHT, CANDIDATE]),
  new: insightPage([CANDIDATE]),
  rising: insightPage([]),
  contested: insightPage([INSIGHT]),
  dormant: insightPage([DORMANT])
};

// `/insights/item/{id}`: the whole evidence trail, in the OTHER shape — the
// resource nested under `resource` and null when the library no longer holds
// it, where the list route flattens the same three fields onto the row itself.
// Read one shape by the other's field names and every row of an expanded card
// renders as a pruned source: a card that cites nothing, opens nothing, and
// reports no error while doing it.
const INSIGHT_ITEM = {
  ...INSIGHT,
  evidence: [
    { resourceId: "r3", stance: "contradicts", quote: "the effect disappears when the prompts are held fixed",
      sourceKey: "someblog.example", addedAt: "2026-08-23T09:00:00.000Z",
      resource: { id: "r3", title: "A dissent", sourceUrl: "https://someblog.example/x", type: "BLOG", sourceType: "blog", publishedAt: "2026-08-22T00:00:00.000Z" } },
    { resourceId: "r1", stance: "supports", quote: "we observe the same scaling behaviour at test time",
      sourceKey: "arxiv", addedAt: "2026-08-18T09:00:00.000Z",
      resource: { id: "r1", title: "Scaling test-time compute", sourceUrl: "https://arxiv.org/abs/1", type: "PAPER", sourceType: "arxiv", publishedAt: "2026-08-18T00:00:00.000Z" } },
    { resourceId: "r2", stance: "supports", quote: "test-time compute now dominates our eval budget",
      sourceKey: "deepmind.google", addedAt: "2026-08-19T09:00:00.000Z", resource: null },
    { resourceId: "r4", stance: "supports", quote: "a third laboratory reports the same curve on its own benchmark",
      sourceKey: "openai.com", addedAt: "2026-08-20T09:00:00.000Z",
      resource: { id: "r4", title: "Compute at inference", sourceUrl: "https://openai.com/index/z", type: "BLOG", sourceType: "blog", publishedAt: "2026-08-20T00:00:00.000Z" } },
    { resourceId: "r5", stance: "supports", quote: "the replication holds across the two smaller model sizes",
      sourceKey: "aclanthology.org", addedAt: "2026-08-21T09:00:00.000Z",
      resource: { id: "r5", title: "The same result, replicated", sourceUrl: "https://aclanthology.org/1", type: "PAPER", sourceType: "acl", publishedAt: "2026-08-21T00:00:00.000Z" } },
    { resourceId: "r6", stance: "supports", quote: "every team in the room reported the same test-time trade-off",
      sourceKey: "workshop.example", addedAt: "2026-08-22T09:00:00.000Z",
      resource: { id: "r6", title: "Notes from the workshop", sourceUrl: "https://workshop.example/n", type: "EVENT", sourceType: "workshop", publishedAt: "2026-08-22T00:00:00.000Z" } },
    { resourceId: "r8", stance: "supports", quote: "our independent reproduction lands within two points",
      sourceKey: "eleuther.ai", addedAt: "2026-08-23T09:00:00.000Z",
      resource: { id: "r8", title: "An independent reproduction", sourceUrl: "https://eleuther.ai/r", type: "REPORT", sourceType: "lab", publishedAt: "2026-08-23T00:00:00.000Z" } }
  ],
  supersededRow: null,
  supersededBy: []
};

// An empty library, and the two reasons it can be empty. They must not read the
// same: one is waiting for somebody to arm the pass, the other is waiting for
// the world to produce something worth extracting, and only one of them is
// asking a person to do something.
const NOTHING = { insights: [], total: 0, hasMore: false, counts: {} };

const NEVER_ARMED = {
  insightIntervalMinutes: 0, insightMaxRows: 200, waiting: 0, waitingAtCap: false,
  insightLastRun: null, insightLastManualRun: null, manualRunInFlight: false, quoteDrop: null,
  stats: { total: 0, byStatus: {}, byKind: {}, evidenceRows: 0, contested: 0,
    newestFirstSeen: null, oldestScoredAt: null }
};

const RAN_AND_FOUND_NOTHING = {
  insightIntervalMinutes: 30, insightMaxRows: 200, waiting: 0, waitingAtCap: false,
  insightLastRun: {
    date: "2026-08-23", at: "2026-08-23T09:00:00.000Z", ran: true, rows: 40, clusters: 3,
    claims: 0, verified: 0, dropped: 0, droppedReasons: {},
    created: 0, merged: 0, contested: 0, rescored: 0, failures: [], watermark: "2026-08-23T08:59:00.000Z"
  },
  insightLastManualRun: null, manualRunInFlight: false, quoteDrop: null,
  stats: { total: 0, byStatus: {}, byKind: {}, evidenceRows: 0, contested: 0,
    newestFirstSeen: null, oldestScoredAt: null }
};

const INSIGHT_STATUS = {
  insightIntervalMinutes: 30, insightMaxRows: 200, waiting: 42, waitingAtCap: false,
  insightLastRun: {
    date: "2026-08-23", at: "2026-08-23T09:00:00.000Z", ran: true, rows: 120, clusters: 14,
    claims: 9, verified: 7, dropped: 2, droppedReasons: { "too short": 1 },
    created: 3, merged: 2, contested: 1, rescored: 11, failures: [], watermark: "2026-08-23T08:59:00.000Z"
  },
  insightLastManualRun: { date: "2026-08-23", at: "2026-08-23T10:00:00.000Z", skipped: "no model routed" },
  manualRunInFlight: false,
  quoteDrop: { claims: 9, dropped: 2, rate: 2 / 9, reasons: { "too short": 1 } },
  stats: { total: 5, byStatus: { standing: 1 }, byKind: {}, evidenceRows: 12, contested: 1,
    newestFirstSeen: "2026-08-23T09:00:00.000Z", oldestScoredAt: "2026-08-20T09:00:00.000Z" }
};

const VERSION = {
  version: "0.3.4", channel: "release", label: "0.3.4", node: "24.12.0",
  library: "local", libraryPath: "/home/someone/.dsh/swarm/swarm-sources.sqlite",
};

/**
 * Answer the endpoints these panels read.
 *
 * `/insights/list` is answered PER FILTER rather than with one fixed page,
 * because the interesting question about a chip is not whether it draws — it is
 * whether the list under it changes.
 * @param overrides - `insightPages` merged over the per-filter pages, and
 *   `insightStatus` replacing what `/insights/status` reports.
 */
function stubFetch(overrides = {}) {
  const pages = { ...INSIGHT_PAGES, ...(overrides.insightPages ?? {}) };
  const passStatus = overrides.insightStatus ?? INSIGHT_STATUS;
  globalThis.fetch = async (url) => {
    const address = String(url);
    if (address.includes("/insights/list")) {
      const query = address.includes("?") ? address.slice(address.indexOf("?") + 1) : "";
      const filter = new URLSearchParams(query).get("filter") ?? "";
      // The route answers 400 naming the accepted values. Answering an unknown
      // filter with an empty page here instead would make a tab that sends a
      // chip nobody implemented indistinguishable from a tab with nothing to
      // show, which is the shape of failure this whole file exists to refuse.
      if (!Object.hasOwn(pages, filter)) {
        return { ok: false, json: async () => ({ success: false, error: `filter must be one of new, rising, contested, dormant; got ${filter}` }) };
      }
      return { ok: true, json: async () => ({ success: true, data: pages[filter] }) };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: address.includes("/collect/status") ? STATUS
          : address.includes("/insights/status") ? passStatus
          : address.includes("/insights/item/") ? INSIGHT_ITEM
          : address.includes("/publish/episodes") ? { episodes: [], total: 0 }
          : address.includes("/publish/documents") ? { documents: [], total: 0 }
          : address.includes("/publish/schedule") ? SCHEDULE
          : address.includes("/publish/voices") ? { voices: [] }
          : address.includes("/publish/formats") ? { formats: [] }
          : address.includes("/version") ? VERSION
          : CONFIG,
      }),
    };
  };
}

test("the settings page renders rather than throwing", async () => {
  stubFetch();
  const { tree } = await render("SourcesSettings");
  const text = textOf(tree).join(" ");
  // Past the loading branch: proof the effects ran and the body executed.
  assert.ok(!text.includes("加载中"), "still on the loading branch");
  assert.ok(text.includes("订阅源"), "no Feeds pane");
});

test("its three jobs are three panes, not one column", async () => {
  stubFetch();
  const { tree } = await render("SourcesSettings");
  const bar = find(tree, (node) => node.props?.role === "tablist");
  assert.ok(bar, "no tab bar");
  const labels = textOf(bar).filter((s) => ["订阅源", "采集", "密钥"].includes(s));
  assert.deepEqual(labels, ["订阅源", "采集", "密钥"]);

  // The feeds pane opens, and only it: the collectors heading belongs to
  // another pane and rendering it here would mean the column is still a column.
  const text = textOf(tree).join(" ");
  assert.ok(text.includes("arXiv cs.AI"), "the feeds pane does not name its feeds");
  assert.ok(text.includes("https://rss.arxiv.org/rss/cs.AI"), "the feeds pane is not showing its feeds");
  assert.ok(!text.includes("采集任务"), "the collectors section rendered on the feeds pane");
  assert.ok(!text.includes("字幕服务密钥"), "the key section rendered on the feeds pane");
});

test("the feed count is on the tab, not behind it", async () => {
  stubFetch();
  const { tree } = await render("SourcesSettings");
  const bar = find(tree, (node) => node.props?.role === "tablist");
  assert.ok(textOf(bar).includes(String(CONFIG.feeds.length)), "the tab does not say how many feeds there are");
});

/** The tab whose label matches, from the bar. */
function tab(tree, label) {
  const bar = find(tree, (node) => node.props?.role === "tablist");
  assert.ok(bar, "no tab bar");
  const hit = find(bar, (node) => node.props?.role === "tab" && textOf(node).includes(label));
  assert.ok(hit, `no tab labelled ${label}`);
  return hit;
}

test("clicking a tab actually swaps the pane", async () => {
  stubFetch();
  const view = await render("SourcesSettings");

  await view.act(() => { tab(view.tree, "采集").props.onClick(); });
  let text = textOf(view.tree).join(" ");
  assert.ok(text.includes("采集任务"), "Collection does not show the collectors");
  assert.ok(text.includes("采集记录"), "Collection does not show the log");
  assert.ok(text.includes("立即采集"), "Collection does not offer a run");
  assert.ok(!text.includes("https://rss.arxiv.org/rss/cs.AI"), "the feeds followed us onto Collection");

  await view.act(() => { tab(view.tree, "密钥").props.onClick(); });
  text = textOf(view.tree).join(" ");
  assert.ok(text.includes("Supadata"), "Keys does not show the transcript key");
  assert.ok(!text.includes("采集任务"), "the collectors followed us onto Keys");

  await view.act(() => { tab(view.tree, "订阅源").props.onClick(); });
  text = textOf(view.tree).join(" ");
  assert.ok(text.includes("https://rss.arxiv.org/rss/cs.AI"), "going back to Feeds lost the feeds");
});

test("feeds are grouped under the kind they belong to", async () => {
  stubFetch();
  const { tree } = await render("SourcesSettings");
  const text = textOf(tree);
  // Both kinds in the fixture get a heading, and PAPER sorts before BLOG only
  // if the grouping is by kind rather than by insertion order.
  assert.ok(text.includes("PAPER"), "no PAPER group");
  assert.ok(text.includes("BLOG"), "no BLOG group");
  assert.ok(text.indexOf("BLOG") < text.indexOf("PAPER"), "the groups are not in a stable order");
});

// The other two panels, called rather than merely parsed. `kindId is not
// defined` took the whole Agents panel down on a tab switch, and the check
// that missed it was a syntax check.
for (const name of ["ExploreTab", "PublishTab", "InsightsTab"]) {
  test(`${name} renders rather than throwing`, async () => {
    stubFetch();
    const { tree } = await render(name, { zh: true });
    assert.ok(tree, `${name} rendered nothing at all`);
    assert.ok(textOf(tree).length > 0, `${name} rendered no text`);
  });
}

// The 洞察 tab.
//
// It shipped for months as a placeholder saying the stage was not built, and
// the whole pipeline behind it — store, pass, four routes — could land without
// a single check noticing that the tab still said so. These call the tab and
// read what a person would read: the claim, how well attested it is, and the
// sentences it rests on.

test("a claim renders with its provenance, not just its text", async () => {
  stubFetch();
  const { tree } = await render("InsightsTab", { zh: true });
  const text = textOf(tree).join(" ");
  assert.ok(text.includes(INSIGHT.statement), "the claim itself is missing");
  // The strip the plan puts under the statement. A claim with no count of
  // INDEPENDENT sources beside it is a headline, which is the thing this tab
  // exists not to be.
  assert.ok(text.includes("6 篇"), "no article count");
  assert.ok(text.includes("4 个独立来源"), "no independent-source count");
  assert.ok(text.includes("首见 8月18日"), "does not say since when");
  assert.ok(text.includes("最近 8月23日"), "does not say how recently");
  // Both quotes, verbatim, and the disagreement called out rather than averaged
  // away — the ✗ row is the part no comparable product shows.
  assert.ok(text.includes("we observe the same scaling behaviour at test time"), "no supporting quote");
  assert.ok(text.includes("the effect disappears when the prompts are held fixed"), "no contradicting quote");
  assert.ok(text.includes("✗"), "the contradiction is not marked");
  assert.ok(text.includes("立场分歧 1"), "the card does not say it is contested");
  // A source the library has pruned still shows its quote and says why it
  // cannot be opened. Dropping the row would leave a card claiming six sources
  // and showing five.
  assert.ok(text.includes("信源已不在库中"), "a pruned source is silently missing");
});

test("the four chips are the plan's, and they reach the route", async () => {
  stubFetch();
  const view = await render("InsightsTab", { zh: true });
  for (const chip of ["新出现", "升温中", "有分歧", "已沉寂"]) {
    assert.ok(textOf(view.tree).includes(chip), `no ${chip} chip`);
  }
  const asked = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => { asked.push(String(url)); return inner(url, init); };
  const chip = find(view.tree, (node) => node.props?.role === "tab" && textOf(node).includes("有分歧"));
  await view.act(() => { chip.props.onClick(); });
  assert.ok(asked.some((url) => url.includes("filter=contested")),
    "the chip changed nothing on the wire: " + asked.join(", "));
});

test("the pass says what it did, including when it did nothing", async () => {
  stubFetch();
  const { tree } = await render("InsightsTab", { zh: true });
  const text = textOf(tree).join(" ");
  assert.ok(text.includes("立即提炼"), "no way to run the pass");
  assert.ok(text.includes("每 30 分钟自动提炼一次。"), "does not say whether the pass is armed");
  // A skip with no reason on screen is indistinguishable from a broken button.
  assert.ok(text.includes("跳过"), "the manual run's skip is not reported");
  assert.ok(text.includes("还没有接入模型"), "the skip does not say a model is what is missing");
  // The one number to watch in week one: claims dropped for a quote that was
  // not in the source it was attributed to.
  assert.ok(text.includes("22%"), "the hallucinated-quote rate is not on the page");
});

test("an evidence row opens the reader on the whole source", async () => {
  stubFetch();
  const inner = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push(String(url));
    if (String(url).includes("/resources/r1")) {
      return { ok: true, json: async () => ({ success: true, data: {
        id: "r1", title: "Scaling test-time compute", sourceUrl: "https://arxiv.org/abs/1",
        type: "PAPER", sourceType: "arxiv", publishedAt: "2026-08-18T00:00:00.000Z",
        abstract: "An abstract.", authors: []
      } }) };
    }
    return inner(url, init);
  };
  const view = await render("InsightsTab", { zh: true });
  const row = find(view.tree, (node) => node.type === "button" && typeof node.props.onClick === "function"
    && textOf(node).some((piece) => piece.includes("we observe the same scaling")));
  assert.ok(row, "the quote is not a control");
  await view.act(() => { row.props.onClick(); });
  // Fetched whole rather than handed the evidence row's five fields: the
  // reader reads the abstract, the authors and the transcript, and five fields
  // would render an empty document with nothing reporting why.
  assert.ok(asked.some((url) => url.endsWith("/resources/r1")), "the source was not fetched: " + asked.join(", "));
  const text = textOf(view.tree).join(" ");
  assert.ok(!text.includes(INSIGHT.statement), "the list is still on screen; the reader did not open");
  assert.ok(text.includes("Scaling test-time compute"), "the reader opened onto nothing");
});

/** Every node in a tree, outermost first. */
function nodes(node, out = [], seen = new Set()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, out, seen);
    return out;
  }
  out.push(node);
  for (const value of Object.values(node.props ?? {})) nodes(value, out, seen);
  return out;
}

/**
 * The evidence row a quote is drawn in: the element that holds the quote, its
 * stance mark, and the frame the row is painted on.
 *
 * All three tests are load-bearing. The paragraph around the sentence answers
 * "the quote rendered" and says nothing about how the row is drawn. The flex
 * wrapper one level in carries the very same text and none of the drawing —
 * picking that one, which is what "the smallest node holding the quote and the
 * mark" selects, compares two undefined backgrounds and passes while proving
 * nothing at all.
 */
function evidenceRow(tree, fragment) {
  const holding = nodes(tree).filter((node) => {
    const text = textOf(node);
    return text.some((piece) => piece.includes(fragment))
      && text.some((piece) => piece === "✓" || piece === "✗")
      && typeof node.props?.style?.background === "string";
  });
  assert.ok(holding.length > 0, `nothing draws a row around the quote "${fragment}"`);
  return holding.reduce((best, node) => (textOf(node).length < textOf(best).length ? node : best));
}

/** The filter chip whose label matches. */
function chip(tree, label) {
  const hit = find(tree, (node) => node.props?.role === "tab" && textOf(node).includes(label));
  assert.ok(hit, `no ${label} chip`);
  return hit;
}

/**
 * The empty note's own words.
 *
 * Read from the note rather than from the page, because the pass's state is
 * also printed in the toolbar above the list: a page-wide search finds that
 * copy and passes even when the note itself says nothing, which leaves the
 * empty state — the only thing on screen — a bare sentence with no answer to
 * "so what do I do about it".
 */
function emptyNote(tree) {
  const hit = find(tree, (node) => node.key === "empty");
  assert.ok(hit, "nothing on the page says the list is empty");
  return textOf(hit).join(" ");
}

/** The card rendering one claim. */
function card(tree, statement) {
  const hit = find(tree, (node) => node.type === "article" && textOf(node).some((piece) => piece.includes(statement)));
  assert.ok(hit, `no card for "${statement}"`);
  return hit;
}

test("a contradiction is drawn as a contradiction, not as one more source", async () => {
  stubFetch();
  const { tree } = await render("InsightsTab", { zh: true });
  const supporting = evidenceRow(tree, "we observe the same scaling behaviour");
  const against = evidenceRow(tree, "the effect disappears when the prompts are held fixed");

  // Two carriers, because either alone fails somebody: the mark survives a
  // monochrome screen and a reader who cannot see red, the background survives
  // a reader skimming past a 14px glyph. A ✗ row drawn exactly like the rows it
  // disagrees with has averaged the disagreement away while displaying it,
  // which is the one thing this tab exists not to do.
  assert.ok(textOf(supporting).includes("✓"), "a supporting quote carries no mark");
  assert.ok(!textOf(supporting).includes("✗"), "a supporting quote is marked as a contradiction");
  assert.ok(textOf(against).includes("✗"), "the contradicting quote carries no mark");
  assert.ok(!textOf(against).includes("✓"), "the contradicting quote is marked as support");
  assert.notEqual(
    String(against.props?.style?.background), String(supporting.props?.style?.background),
    "the two stances are drawn identically",
  );

  // Driven by the row's stance rather than by its position: the card nothing
  // contradicts draws no ✗ and claims no disagreement. Without this the marks
  // could be decoration on the third row of every card and every assertion
  // above would still pass.
  const uncontested = card(tree, CANDIDATE.statement);
  assert.ok(!textOf(uncontested).includes("✗"), "a card with nothing against it still draws a contradiction");
  assert.ok(!textOf(uncontested).join(" ").includes("立场分歧"), "a card with nothing against it claims a disagreement");
});

test("a card that counts seven pieces of evidence can show seven", async () => {
  stubFetch();
  const view = await render("InsightsTab", { zh: true });
  // The preview carries three rows against a strip that says six articles and
  // one contradiction. A card whose count and whose body disagree, with nothing
  // offering the rest, is the same lie as a card citing sources it cannot show.
  const more = find(view.tree, (node) => node.type === "button"
    && textOf(node).some((piece) => piece.includes("查看全部")));
  assert.ok(more, "a card holding more evidence than it previews offers no way to reach the rest");
  assert.ok(textOf(more).some((piece) => piece.includes("查看全部 7 条证据")), "the button does not say how much is behind it");

  await view.act(() => { more.props.onClick(); });
  const opened = card(view.tree, INSIGHT.statement);
  const pieces = textOf(opened);
  assert.equal(pieces.filter((piece) => piece === "✓").length, 6, "the expanded card does not show all six supporting rows");
  assert.equal(pieces.filter((piece) => piece === "✗").length, 1, "the expanded card lost the contradiction");
  // `/insights/item` nests the resource where `/insights/list` flattens it.
  // Read by the wrong field names every row here would render as pruned — a
  // whole card of quotes that open nothing, reporting nothing.
  const text = pieces.join(" ");
  assert.ok(text.includes("An independent reproduction"), "an expanded row does not name its source");
  assert.equal(
    pieces.filter((piece) => piece.includes("信源已不在库中")).length, 1,
    "the expanded card is reading the nested shape by the flat shape's field names",
  );
});

test("each chip lists a different set of claims", async () => {
  stubFetch();
  const view = await render("InsightsTab", { zh: true });
  const listed = () => textOf(view.tree).join(" ");
  const press = async (label) => {
    await view.act(() => { chip(view.tree, label).props.onClick(); });
    return listed();
  };

  assert.ok(listed().includes(INSIGHT.statement), "the default page is missing the standing claim");
  assert.ok(listed().includes(CANDIDATE.statement), "candidates are hidden by default, which is an empty tab on day one");
  assert.ok(!listed().includes(DORMANT.statement), "the default page shows a dormant claim");

  let text = await press("新出现");
  assert.ok(text.includes(CANDIDATE.statement), "新出现 lost the claim first seen this morning");
  assert.ok(!text.includes(INSIGHT.statement), "新出现 kept a five-day-old claim: the chip changed the URL and nothing else");

  text = await press("有分歧");
  assert.ok(text.includes(INSIGHT.statement), "有分歧 lost the contested claim");
  assert.ok(!text.includes(CANDIDATE.statement), "有分歧 kept a claim nothing contradicts");

  text = await press("已沉寂");
  assert.ok(text.includes(DORMANT.statement), "已沉寂 does not reach the dormant claim, which no other chip shows");
  assert.ok(!text.includes(INSIGHT.statement), "已沉寂 kept a live claim");

  text = await press("全部");
  assert.ok(text.includes(INSIGHT.statement) && text.includes(CANDIDATE.statement), "going back to 全部 did not restore the list");
  assert.ok(!text.includes(DORMANT.statement), "全部 is showing the dormant claim it hides by default");
});

test("an empty chip and an empty library are different sentences", async () => {
  stubFetch();
  const view = await render("InsightsTab", { zh: true });
  await view.act(() => { chip(view.tree, "升温中").props.onClick(); });
  const note = emptyNote(view.tree);
  // A chip with nothing under it is a filter to undo, not a pipeline to fix.
  // Telling a person the pass has extracted nothing while three cards sit one
  // chip away sends them to look at the wrong thing entirely.
  assert.ok(note.includes("这个筛选下没有卡片"), "an empty chip does not say it is the chip that is empty");
  assert.ok(!note.includes("还没有提炼出任何主张"), "an empty chip reports the whole library as empty");
});

test("an empty tab says which of the two empties it is", async () => {
  // Nothing extracted and nobody ever armed the pass. The page has to say the
  // second part: a tab waiting for a person to press something looks exactly
  // like a tab waiting for the world to happen.
  stubFetch({ insightPages: { "": NOTHING }, insightStatus: NEVER_ARMED });
  const cold = emptyNote((await render("InsightsTab", { zh: true })).tree);
  assert.ok(cold.includes("还没有提炼出任何主张。"), "an empty library does not say it is empty");
  assert.ok(cold.includes("定时提炼是关的"), "the empty state does not say the pass was never armed");
  assert.ok(!cold.includes("上次提炼"), "reports a pass that has never run");

  // Armed, ran on forty sources, extracted nothing. Same empty list, different
  // answer to "what do I do about it" — and the numbers are the only evidence
  // that the pass is working rather than silently failing.
  stubFetch({ insightPages: { "": NOTHING }, insightStatus: RAN_AND_FOUND_NOTHING });
  const swept = emptyNote((await render("InsightsTab", { zh: true })).tree);
  assert.ok(swept.includes("还没有提炼出任何主张。"), "an empty library does not say it is empty");
  assert.ok(swept.includes("每 30 分钟自动提炼一次。"), "the empty state does not say the pass is armed");
  assert.ok(swept.includes("上次提炼"), "a pass that ran and found nothing does not say it ran");
  assert.ok(swept.includes("读了 40 条信源"), "does not say how much the pass read to find nothing");
  assert.notEqual(cold, swept, "a pass nobody armed and a pass that found nothing read the same");
});

test("the tab no longer says it is unbuilt, and the other two still do", () => {
  const source = readFileSync(CLIENT, "utf8");
  const insights = source.slice(source.indexOf('id: "insights"'), source.indexOf('id: "research"'));
  assert.ok(!insights.includes("soon: true"), "洞察 still wears the planned badge");
  const research = source.slice(source.indexOf('id: "research"'), source.indexOf('id: "simulation"'));
  const simulation = source.slice(source.indexOf('id: "simulation"'), source.indexOf('id: "publish"'));
  assert.ok(research.includes("soon: true"), "研究 lost its badge");
  assert.ok(simulation.includes("soon: true"), "推演 lost its badge");
});

// Where the library lives.
//
// One value decides which machine holds the data, and it lives in a pointer
// file and an environment variable — nothing on screen ever said which way it
// was set. A workstation proxying to a box that had gone down looked exactly
// like a workstation with an empty library: same page, same empty lists, no
// error anywhere.

/** The library row's text, from a `/version` payload. */
async function libraryRow(version) {
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => ({
      success: true,
      data: String(url).includes("/version") ? version
        : String(url).includes("/collect/status") ? STATUS
        : CONFIG,
    }),
  });
  const { tree } = await render("SourcesSettings");
  const bar = find(tree, (node) => node.props?.role === "tablist");
  assert.ok(bar, "the page did not render");
  return textOf(tree).join(" ");
}

test("a local library says so, and where", async () => {
  const text = await libraryRow({
    version: "0.3.4", channel: "release", label: "0.3.4", node: "24.12.0",
    library: "local", libraryPath: "/home/someone/.dsh/swarm/swarm-sources.sqlite",
  });
  assert.ok(text.includes("本地"), "does not say the library is local");
  assert.ok(text.includes("/home/someone/.dsh/swarm/swarm-sources.sqlite"), "does not say where");
  assert.ok(!text.includes("连不上"), "a local library cannot be unreachable");
});

test("a reachable remote names the machine and its version", async () => {
  const text = await libraryRow({
    version: "0.3.4", channel: "release", label: "0.3.4", node: "24.12.0",
    library: "remote", remote: "https://box.tailnet.ts.net/swarm-api",
    remoteVersion: "0.3.4", remoteLabel: "0.3.4", remoteChannel: "release", remoteError: null,
  });
  assert.ok(text.includes("远端"), "does not say the library is remote");
  assert.ok(text.includes("box.tailnet.ts.net"), "does not name the machine");
  assert.ok(text.includes("v0.3.4"), "does not report the far end's version");
  assert.ok(!text.includes("连不上"), "called a reachable box unreachable");
});

test("a remote that is down says so, rather than looking empty", async () => {
  const text = await libraryRow({
    version: "0.3.4", channel: "release", label: "0.3.4", node: "24.12.0",
    library: "remote", remote: "https://box.tailnet.ts.net/swarm-api",
    remoteVersion: null, remoteLabel: null, remoteChannel: null,
    remoteError: "fetch failed",
  });
  assert.ok(text.includes("连不上"), "a box that is down is indistinguishable from an empty library");
  assert.ok(text.includes("box.tailnet.ts.net"), "does not say which machine is down");
});

// The formatting itself, checked on the pure function rather than by grepping
// a whole page: the page has other URLs on it, so "no scheme anywhere" is an
// assertion about the wrong thing.
test("the remote is named by machine, not by URL", async () => {
  const { libraryLine } = exportsOf();
  assert.deepEqual(
    libraryLine({ library: "remote", remote: "https://box.tailnet.ts.net/swarm-api", remoteLabel: "0.3.4", remoteError: null }, true),
    { what: "远端", detail: "box.tailnet.ts.net  ·  v0.3.4", trouble: "" },
  );
  assert.deepEqual(
    libraryLine({ library: "local", libraryPath: "/a/b.sqlite" }, true),
    { what: "本地", detail: "/a/b.sqlite", trouble: "" },
  );
  // Nothing to say before the first answer comes back — an empty row would
  // read as "no library", which is a claim rather than a silence.
  assert.equal(libraryLine(null, true), null);
});
