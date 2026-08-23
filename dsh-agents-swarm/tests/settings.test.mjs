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

/** A JSX element, as the stub runtime records it. */
const element = (type, props, key) => ({ type, props: props ?? {}, key });

/**
 * Render one component function to a tree, running its effects to quiescence.
 *
 * Hooks are stored in a flat array indexed by call order, which is exactly the
 * rule real React enforces, so a component that breaks the rule breaks here in
 * the same way rather than silently working.
 */
async function render(Component, props = {}) {
  const slots = [];
  let cursor = 0;
  const effects = [];
  let dirty = false;

  const react = {
    useState(initial) {
      const at = cursor++;
      if (slots.length <= at) slots[at] = typeof initial === "function" ? initial() : initial;
      const set = (next) => {
        const value = typeof next === "function" ? next(slots[at]) : next;
        if (!Object.is(value, slots[at])) { slots[at] = value; dirty = true; }
      };
      return [slots[at], set];
    },
    // Identity is not memoized: returning the function as-is re-runs effects
    // that depend on it, which converges here because the loop below stops
    // when a pass changes nothing.
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef(initial) {
      const at = cursor++;
      if (slots.length <= at) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect: (fn) => { effects.push(fn); },
    useLayoutEffect: (fn) => { effects.push(fn); },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };

  const runtime = { jsx: element, jsxs: element, Fragment: Symbol("Fragment") };
  const load = captureFactory();
  const exported = load((name) => (name === "react" ? react : runtime));

  const Target = typeof Component === "string" ? exported.__test__?.[Component] : Component;
  assert.ok(Target, `no such component: ${Component}`);

  let tree = null;
  const settle = async () => {
    for (let pass = 0; pass < 20; pass += 1) {
      cursor = 0;
      dirty = false;
      effects.length = 0;
      tree = Target(props);
      for (const effect of effects) {
        const teardown = effect();
        if (typeof teardown === "function") teardown();
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

/** Answer the two endpoints the settings page reads. */
function stubFetch() {
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => ({
      success: true,
      data: String(url).includes("/collect/status") ? STATUS : CONFIG,
    }),
  });
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
for (const name of ["ExploreTab", "PublishTab"]) {
  test(`${name} renders rather than throwing`, async () => {
    stubFetch();
    const { tree } = await render(name, { zh: true });
    assert.ok(tree, `${name} rendered nothing at all`);
    assert.ok(textOf(tree).length > 0, `${name} rendered no text`);
  });
}
