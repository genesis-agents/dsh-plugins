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

  // REACT REFUSES A PLAIN OBJECT AS A CHILD, AND THIS SHIM DID NOT.
  //
  // `Objects are not valid as a React child` is a THROW in the browser: the
  // pane unmounts and the user sees an error boundary, not a missing line.
  // This harness built the tree by hand and put whatever it was given into
  // it, so a component that renders `children: someObject` passed every
  // test here and crashed on the page.
  //
  // MEASURED: `signoff.foreword` is an object — `{whatWeAnswered,
  // whatRemainsUnclear, howToRead, recommendedFollowUp}`, enforced by
  // FOREWORD_SCHEMA and by shapeSignoff's own `typeof === "object"` check —
  // and MissionStageDetail passed it whole as `children`. Every mission
  // whose leader wrote a foreword crashed its own s11 drawer.
  //
  // Arrays and elements pass, as they do in React; a Date or a plain object
  // does not.
  const childOk = (child) => {
    if (child === null || child === undefined || child === false || child === true) return true;
    if (Array.isArray(child)) return child.every(childOk);
    if (typeof child !== "object") return true;
    return Object.hasOwn(child, "type") && Object.hasOwn(child, "props");
  };
  const plain = (type, props2, key) => {
    const child = props2?.children;
    if (child !== undefined && !childOk(child)) {
      const keys = Array.isArray(child) ? "an array holding one" : Object.keys(child ?? {}).join(", ");
      throw new Error(
        `<${String(type)}> was given a plain object as its children (${keys}). React throws on this — "Objects are not valid as a React child" — and the pane unmounts. Render the object's fields, or format it to a string first.`,
      );
    }
    return { type, props: props2 ?? {}, key };
  };
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
/**
 * The text a reader would read, which is not every string in the tree.
 *
 * DECORATIVE SUBTREES ARE SKIPPED. Every glyph in this app is drawn as an
 * inline SVG with `aria-hidden` on it — Icon sets it deliberately, because a
 * glyph that repeats the word beside it is read twice by a screen reader.
 * This walker read the props of every node, so the moment the tab strip
 * gained a glyph per tab, four tests that assert on the strip's LABELS
 * started comparing against path data: 任务 arrived as
 * `pxpx nonecurrentColorroundroundtrueM l -M l -...任务`.
 *
 * Skipping them is not a workaround for those four. It is what these tests
 * were always claiming to do — a screen reader skips exactly this subtree,
 * and so does a reader's eye when it is looking for a word.
 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out; }
  if (typeof node === "object") {
    const props = node.props ?? {};
    if (props["aria-hidden"] === "true" || props["aria-hidden"] === true) return out;
    for (const value of Object.values(props)) textOf(value, out);
    return out;
  }
  return out;
}

/** Every node whose props match a predicate, in render order. */
function findAll(node, predicate, out = [], seen = new Set()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out, seen);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const value of Object.values(node.props ?? {})) findAll(value, predicate, out, seen);
  return out;
}

/**
 * The labels on the mission detail's tab strip, in order.
 *
 * READ OFF A REAL TABLIST, because the strip became one: it was six buttons
 * carrying `aria-pressed`, which announces a toggle that is held down rather
 * than one of six pages, and which is not the attribute the shared tab CSS
 * matches. Scoped to the FIRST tablist in render order and not to every
 * `role="tab"` in the tree, because the trajectory drawer's own strip carries
 * the same attributes and would otherwise be counted as four more panes.
 *
 * The label comes from `children` rather than from the node, because `textOf`
 * walks EVERY prop value — `type: "button"` and `role: "tab"` are both props
 * here, and both would be read as text.
 */
function paneLabels(tree) {
  const strip = find(tree, (node) => node.props?.role === "tablist");
  if (strip === null) return [];
  return findAll(strip, (node) => node.props?.role === "tab")
    .map((node) => textOf(node.props?.children ?? null).join(""))
    .filter((label) => label !== "");
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

// ── missions ────────────────────────────────────────────────────────────────
//
// The 洞察 tab drives the twelve-stage mission pipeline. Everything below is
// shaped exactly as the Host half answers it — `shapeMission` for the list,
// `projectMissionView` for the detail, `shapeArtifact` for the report — because
// a fixture in a shape the server never sends tests the page against a server
// that does not exist.

/** The three tiers, as `/missions/budget-tiers` serves them. */
const TIERS = {
  tiers: {
    quick: { maxTokens: 400000, maxCalls: 40, maxArxiv: 20, maxWeb: 30, maxFetch: 30, wallMs: 20 * 60000 },
    standard: { maxTokens: 1500000, maxCalls: 120, maxArxiv: 60, maxWeb: 120, maxFetch: 100, wallMs: 60 * 60000 },
    deep: { maxTokens: 4000000, maxCalls: 300, maxArxiv: 150, maxWeb: 300, maxFetch: 250, wallMs: 3 * 60 * 60000 },
  },
  depths: ["quick", "standard", "deep"],
  limits: { maxTokens: { min: 20000, max: 20000000, unit: "tokens" } },
  fields: ["maxTokens", "maxCalls", "maxArxiv", "maxWeb", "maxFetch", "wallMs"],
  ladder: { soften: 0.7, freeze: 0.85, warn: 0.9, stop: 1 },
};

/** A mission this process is running right now. */
/** The stage words the detail prints, for assertions that derive from a view. */
const STAGE_WORDS = {
  "s1-brief": "立项", "s2-plan": "规划", "s3-collect": "采集", "s4-assess": "评估",
  "s5-reconcile": "归一", "s6-synthesize": "综合", "s7-outline": "拟纲", "s8-write": "撰写",
  "s9-verify": "核验", "s10-critique": "复盘", "s11-signoff": "签署", "s12-persist": "归档",
};

const RUNNING = {
  id: "mission-20260824T090000Z-1a2b3c4d",
  topic: "推理时序扩展的三条技术路线",
  depth: "standard", language: "zh", status: "running", rawStatus: "running",
  budget: { maxTokens: 1500000, maxCalls: 120, maxArxiv: 60, maxWeb: 120, maxFetch: 100, wallMs: 3600000 },
  retryBelowSeam: false, goals: null, derivedFloor: 3, runCount: 1, patchRound: 0,
  lastStage: "s3-collect",
  startedAt: "2026-08-24T09:00:00.000Z", completedAt: null,
  failureCode: null, errorMessage: null, leaderSigned: null, finalScore: null,
  verifiedFindings: 7, spend: { tokens: 412000, calls: 24 },
};

// A row that SAYS running while the runner reports it is not running here.
// One process, so no other owner can exist: this is a mission left behind by an
// exit, and the list is the only place that difference is visible.
const ORPHAN = {
  ...RUNNING,
  id: "mission-20260820T090000Z-deadbeef",
  topic: "上一次进程退出时留在半路的课题",
  startedAt: "2026-08-20T09:00:00.000Z",
  verifiedFindings: 2, spend: { tokens: 88000, calls: 6 },
};

// The mission this whole screen exists for: it ended, it verified nothing, and
// it must still be able to say what it tried.
const REFUSED = {
  ...RUNNING,
  id: "mission-20260823T090000Z-0badc0de",
  topic: "一个什么都没查到的冷门课题",
  status: "quality-failed", rawStatus: "quality-failed",
  startedAt: "2026-08-23T09:00:00.000Z", completedAt: "2026-08-23T09:41:00.000Z",
  failureCode: "quality_refused",
  errorMessage: "content-guard: citations.length === 0. The report cites nothing.",
  leaderSigned: false, finalScore: 31,
  verifiedFindings: 0, spend: { tokens: 190000, calls: 18 },
};

/** A mission that finished, was signed, and has a report behind it. */
const SIGNED = {
  ...RUNNING,
  id: "mission-20260822T090000Z-5e6f7a8b",
  topic: "开源推理模型的许可证走向",
  status: "completed", rawStatus: "completed",
  startedAt: "2026-08-22T09:00:00.000Z", completedAt: "2026-08-22T10:04:00.000Z",
  leaderSigned: true, finalScore: 82,
  verifiedFindings: 24, spend: { tokens: 980000, calls: 61 },
};

/** One page of `/missions/list`, `live` and all. */
const missionPage = (rows, live) => ({
  missions: rows, total: rows.length, hasMore: false,
  counts: { running: 2, "quality-failed": 1, completed: 1 },
  live,
});

// Answered PER STATUS, because the interesting question about a chip is not
// whether it draws — it is whether the list under it changes.
const MISSION_PAGES = {
  "": missionPage([RUNNING, ORPHAN, REFUSED, SIGNED], [RUNNING.id]),
  running: missionPage([RUNNING, ORPHAN], [RUNNING.id]),
  "quality-failed": missionPage([REFUSED], [RUNNING.id]),
  completed: missionPage([SIGNED], [RUNNING.id]),
  // Empty on purpose: a chip with nothing under it and a list with nothing in
  // it are two different sentences, and only a filter that can come back empty
  // proves the page tells them apart.
  cancelled: missionPage([], [RUNNING.id]),
};

const STAGE_IDS = [
  "s1-brief", "s2-plan", "s3-collect", "s4-assess", "s5-reconcile", "s6-synthesize",
  "s7-outline", "s8-write", "s9-verify", "s10-critique", "s11-signoff", "s12-persist",
];

/** Twelve stage rows, always twelve — the projector guarantees the count. */
function stagesUpTo(reached, { degradeAt = null } = {}) {
  return STAGE_IDS.map((stepId, index) => {
    const at = STAGE_IDS.indexOf(reached);
    const status = index < at ? "done" : index === at ? "running" : "pending";
    return {
      stepId, ordinal: index + 1, agent: null, mode: null,
      status: stepId === degradeAt ? "degraded" : status,
      attempts: 1,
      startedAt: index <= at ? "2026-08-24T09:01:00.000Z" : null,
      endedAt: index < at ? "2026-08-24T09:04:00.000Z" : null,
      durationMs: index < at ? 180000 : null,
      degradeNote: stepId === degradeAt ? "3 个维度里有 2 个没有达到门槛。" : null,
      stalled: false, tokens: 0, calls: 0,
    };
  });
}

/** The six meters, as `projectCost` builds them. */
const costOf = (used) => ({
  tokens: { dimension: "tokens", used: used.tokens, limit: 1500000, remaining: 0, ratio: used.tokens / 1500000 },
  calls: { dimension: "calls", used: used.calls, limit: 120, remaining: 0, ratio: used.calls / 120 },
  arxiv: { dimension: "arxiv", used: 4, limit: 60, remaining: 56, ratio: 4 / 60 },
  web: { dimension: "web", used: 9, limit: 120, remaining: 111, ratio: 9 / 120 },
  fetch: { dimension: "fetch", used: 12, limit: 100, remaining: 88, ratio: 12 / 100 },
  wall: { dimension: "wall", used: 900000, limit: 3600000, remaining: 2700000, ratio: 0.25 },
  tight: { dimension: "tokens", value: used.tokens / 1500000, used: used.tokens, limit: 1500000 },
  ratio: used.tokens / 1500000, degradeLevel: 0,
  ladder: TIERS.ladder,
  softWarnedAt: null, exhaustedAt: null,
  tokensBreakdown: { promptTok: used.tokens, completionTok: 0, cacheReadTok: 0 },
  drift: { estimated: 0, exact: used.tokens, ratio: null, exceeds: null, tolerance: 0.15 },
  waste: { stageRetries: 0, chapterRewrites: 0, underDeliveredChapters: 0, toolFailures: 3, toolCached: 1 },
  // Both already computed by `projectCost`, already in the /view payload, and
  // until now read by nothing. `s3-collect` carries fifty-one calls and zero
  // tokens, which is the true state of a real ledger and must not be drawn as
  // a stage that ran for free.
  byStage: [
    { stepId: "s3-collect", role: "researcher", calls: 51, tokens: 0 },
    { stepId: "s2-plan", role: "leader", calls: 4, tokens: 120000 },
    { stepId: "s1-brief", role: "leader", calls: 2, tokens: 46000 },
  ],
  byAgent: [],
  byTool: [
    { tool: "web.search", calls: 12, failures: 1, cached: 3, latencyMs: 9840, latencyMeasured: 12, unmeasured: 0, avgLatencyMs: 820 },
    // Nine calls, four of them failed, and not one of them timed. An average of
    // 0ms here would read as instant about a door nobody measured.
    { tool: "fetch_page", calls: 9, failures: 4, cached: 0, latencyMs: 0, latencyMeasured: 0, unmeasured: 9, avgLatencyMs: null },
  ],
});

/** A mission part-way through collection. */
const LIVE_VIEW = {
  mission: {
    id: RUNNING.id, topic: RUNNING.topic, depth: "standard", language: "zh",
    status: "running", terminal: false,
    pill: { code: "running", tone: "active", label: "运行中", detail: null, degradedDimensions: 0, totalDimensions: 2 },
    score: null, leaderScore: null, signed: null, verdict: null,
    runCount: 1, patchRound: 0, lastStage: "s3-collect", lastProgressAt: "2026-08-24T09:14:00.000Z",
    startedAt: RUNNING.startedAt, lastReopenedAt: null, effectiveStartAt: RUNNING.startedAt,
    completedAt: null, elapsedMs: 900000, wallMs: 3600000, wallRatio: 0.25,
    failureCode: null, errorMessage: null, traceEnabled: false, retryBelowSeam: false,
    goals: null, derivedFloor: 3,
    progress: { stagesResolved: 2, stagesTotal: 12, percent: 17, dimensionsResolved: 1, dimensionsTotal: 2, chaptersDone: 0, chaptersTotal: 0 },
    evidence: { total: 9, verified: 7, verifiedAbstract: 0, verifiedAdjacent: 0, unchecked: { "unchecked-rate-limited": 2 }, uncheckedTotal: 2, unverifiable: 0, misattributed: 0, tooShort: 0, other: {}, rateLimited: 2, denominator: 7, verifiedRatio: 1, uniqueHostSum: 5 },
    degradedDimensions: 0, anomalies: 0, bootId: "boot-1", pid: 4242,
    projectedAt: "2026-08-24T09:15:00.000Z",
  },
  stages: stagesUpTo("s3-collect"),
  dimensions: [
    {
      dimensionId: "d1", name: "推理时序扩展的训练侧做法", facet: "technical", rationale: null,
      state: "collected", attempt: 1, grade: 78, gradeAxes: { verified: 5, uniqueHosts: 3, pagesFetched: 6, seedTarget: 5 },
      summary: null, failureCode: null, updatedAt: "2026-08-24T09:12:00.000Z",
      verified: 5, verifiedAbstract: 0, verifiedAdjacent: 0,
      unchecked: { "unchecked-rate-limited": 0 }, uncheckedTotal: 0,
      unverifiable: 0, misattributed: 0, tooShort: 0, otherStates: {},
      counts: { "verified-source-text": 5 },
      uniqueHosts: 3, floor: 3, meetsFloor: true,
      chapters: { total: 0, done: 0, writing: 0, pending: 0, failed: 0, underDelivered: 0, rewrites: 0 },
      blocked: false,
    },
    {
      dimensionId: "d2", name: "推理时序扩展的推理侧做法", facet: "technical", rationale: null,
      state: "collecting", attempt: 1, grade: null, gradeAxes: null,
      summary: null, failureCode: null, updatedAt: "2026-08-24T09:14:00.000Z",
      verified: 2, verifiedAbstract: 0, verifiedAdjacent: 0,
      unchecked: { "unchecked-rate-limited": 2 }, uncheckedTotal: 2,
      unverifiable: 0, misattributed: 0, tooShort: 0, otherStates: {},
      counts: { "verified-source-text": 2, "unchecked-rate-limited": 2 },
      uniqueHosts: 2, floor: 3, meetsFloor: false,
      chapters: { total: 0, done: 0, writing: 0, pending: 0, failed: 0, underDelivered: 0, rewrites: 0 },
      blocked: true,
    },
  ],
  // `work`: the tree the board draws — the twelve stages as parents, and the
  // decisions somebody made as children under the stage that made them. Absent
  // from this fixture for a whole release, which is exactly how the projection
  // shipped with no reader.
  work: [
    { id: "stage:s2-plan", parentId: null, origin: "pipeline", title: "s2-plan", state: "done", assignee: "leader", reason: null, counts: { attempts: 1 } },
    { id: "stage:s3-collect", parentId: null, origin: "pipeline", title: "s3-collect", state: "running", assignee: "researcher", reason: null, counts: { attempts: 1 } },
    { id: "dimension:d1", parentId: "stage:s3-collect", origin: "s2-plan", title: "推理时序扩展的复现情况", state: "collected", assignee: "researcher:d1", dimensionId: "d1", reason: "s2 规划的维度之一。", counts: { verified: 5, floor: 3, attempts: 1 } },
    { id: "dimension:d2", parentId: "stage:s3-collect", origin: "s2-plan", title: "许可证与再分发条款", state: "degraded", assignee: "researcher:d2", dimensionId: "d2", reason: "s2 规划的维度之一。", counts: { verified: 1, floor: 3, attempts: 2 } },
    { id: "stage:s4-assess", parentId: null, origin: "pipeline", title: "s4-assess", state: "done", assignee: "leader", reason: null, counts: { attempts: 2 } },
    { id: "recollect:d2", parentId: "stage:s4-assess", origin: "leader-assess-recollect", title: "许可证与再分发条款", state: "degraded", assignee: "leader", dimensionId: "d2", reason: "两个维度低于下限，再收一轮。", critique: "这个维度只拿到一个站点，需要一条独立来源。", counts: { verified: 1, floor: 3, attempts: 1 } }
  ],
  // What /view actually returns for a mission that has run agents. An empty
  // array here made the spend pane a total with nobody attached to it, and the
  // fixture was the only thing saying that was normal.
  agents: [
    { agentId: "researcher:d1", role: "researcher", state: "done", lastStepId: "s3-collect", dimensionId: "d1", calls: 9, promptTok: 41000, completionTok: 6200, cacheReadTok: 0, tokens: 47200, toolCalls: 21, toolFailures: 2, toolCached: 5 },
    { agentId: "leader", role: "leader", state: "running", lastStepId: "s4-assess", dimensionId: null, calls: 4, promptTok: 12000, completionTok: 2100, cacheReadTok: 0, tokens: 14100, toolCalls: 0, toolFailures: 0, toolCached: 0 }
  ],
  todo: [],
  cost: costOf({ tokens: 412000, calls: 24 }),
  artifact: { kind: "empty-artifact", reason: "not-yet-materialized", detail: "The mission has not reached s12." },
  timeline: {
    events: [
      { seq: 1, ts: "2026-08-24T09:00:01.000Z", type: "mission:started", class: "business", agentId: null, payload: { stepId: "s1-brief" } },
      { seq: 2, ts: "2026-08-24T09:01:00.000Z", type: "gate:passed", class: "business", agentId: null, payload: { verdict: "pass" } },
      { seq: 3, ts: "2026-08-24T09:12:00.000Z", type: "stage:done", class: "business", agentId: "leader", payload: { stepId: "s2-plan", status: "done", durationMs: 120000 } },
    ],
    sinceSeq: 0, latestSeq: 3, count: 3, bounded: true,
    preflight: {
      known: false, risk: "availability",
      quality: { failed: 0, total: 9, ratio: 0 },
      availability: { blocked: 2, rateLimited: 2, total: 9 },
      messages: ["2 of 9 could not be checked — 2 rate-limited. This is an availability result, not evidence of absence."],
      blockedNotAbsent: true, scorecard: null,
    },
  },
  resume: { offered: false, reason: "wrong-status", detail: "The mission is still running; there is nothing to resume.", orphaned: false, runCount: 1, reclaimLimit: 3 },
  swept: [],
};

// The mission that verified nothing. `evidence:none` carries the diagnostics
// the runtime froze precisely so this screen is not blank.
const DEAD_VIEW = {
  mission: {
    ...LIVE_VIEW.mission,
    id: REFUSED.id, topic: REFUSED.topic, status: "quality-failed", terminal: true,
    pill: { code: "quality-failed-degraded", tone: "warn", label: "未签署 · 部分降级 1/1", detail: "1/1 维度降级", degradedDimensions: 1, totalDimensions: 1 },
    score: 31, leaderScore: 31, signed: false, verdict: "refuse",
    lastStage: "s12-persist", completedAt: REFUSED.completedAt, elapsedMs: 2460000,
    failureCode: "quality_refused", errorMessage: REFUSED.errorMessage,
    progress: { stagesResolved: 12, stagesTotal: 12, percent: 100, dimensionsResolved: 1, dimensionsTotal: 1, chaptersDone: 0, chaptersTotal: 0 },
    evidence: { total: 4, verified: 0, verifiedAbstract: 0, verifiedAdjacent: 0, unchecked: { "unchecked-fetch-failed": 3, "unchecked-rate-limited": 1 }, uncheckedTotal: 4, unverifiable: 0, misattributed: 0, tooShort: 0, other: {}, rateLimited: 1, denominator: 3, verifiedRatio: 0, uniqueHostSum: 0 },
    degradedDimensions: 1,
  },
  stages: stagesUpTo("s12-persist", { degradeAt: "s3-collect" }).map((stage) => ({ ...stage, status: stage.status === "running" ? "done" : stage.status })),
  dimensions: [
    {
      ...LIVE_VIEW.dimensions[1],
      dimensionId: "d1", name: "这个冷门课题的公开材料", state: "degraded",
      grade: 12, gradeAxes: { verified: 0, uniqueHosts: 0, pagesFetched: 2, seedTarget: 5 },
      summary: "这个维度读了 2 个页面，没有产出任何通过核验的引语。",
      verified: 0, uniqueHosts: 0, meetsFloor: false,
      counts: { "unchecked-fetch-failed": 3, "unchecked-rate-limited": 1 },
      unchecked: { "unchecked-fetch-failed": 3, "unchecked-rate-limited": 1 }, uncheckedTotal: 4,
    },
  ],
  // What /view actually returns for a mission that has run agents. An empty
  // array here made the spend pane a total with nobody attached to it, and the
  // fixture was the only thing saying that was normal.
  agents: [
    { agentId: "researcher:d1", role: "researcher", state: "done", lastStepId: "s3-collect", dimensionId: "d1", calls: 9, promptTok: 41000, completionTok: 6200, cacheReadTok: 0, tokens: 47200, toolCalls: 21, toolFailures: 2, toolCached: 5 },
    { agentId: "leader", role: "leader", state: "running", lastStepId: "s4-assess", dimensionId: null, calls: 4, promptTok: 12000, completionTok: 2100, cacheReadTok: 0, tokens: 14100, toolCalls: 0, toolFailures: 0, toolCached: 0 }
  ],
  todo: [],
  cost: costOf({ tokens: 190000, calls: 18 }),
  artifact: {
    kind: "artifact", version: 1, runCount: 1, stale: false, trigger: "initial",
    title: "一个什么都没查到的冷门课题", wordCount: 610, markdownBytes: 4200,
    degraded: true, createdAt: "2026-08-23T09:41:00.000Z",
    sections: [], citations: [], quality: { evidenced: { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 }, interpretive: { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 }, unplaced: { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 }, total: 0 },
    versions: [{ version: 1, runCount: 1, trigger: "initial", degraded: true, createdAt: "2026-08-23T09:41:00.000Z" }],
  },
  timeline: {
    events: [
      { seq: 40, ts: "2026-08-23T09:30:00.000Z", type: "stage:degraded", class: "business", agentId: "researcher", payload: { stepId: "s3-collect", status: "degraded", durationMs: 600000 } },
      {
        seq: 41, ts: "2026-08-23T09:31:00.000Z", type: "evidence:none", class: "business", agentId: null,
        payload: {
          outcome: "none", verified: 0, floorSum: 3, ratio: 0,
          why: "no dimension produced a single finding whose quote verified against a contiguous span of a page we fetched. 'We looked and found nothing verifiable' is a useful answer; an essay dressed as one is not.",
          diagnostics: {
            runCount: 1,
            findings: { "unchecked-fetch-failed": 3, "unchecked-rate-limited": 1 },
            hosts: [],
            tools: { web_search: { calls: 6, ok: 6, failed: 0 }, fetch_page: { calls: 5, ok: 1, failed: 4 } },
            queries: [
              { stepId: "s3-collect", agentId: "researcher-d1", tool: "fetch_page", paceKey: "fetch", errorCode: "rate_limited", at: "2026-08-23T09:28:00.000Z" },
              { stepId: "s3-collect", agentId: "researcher-d1", tool: "fetch_page", paceKey: "fetch", errorCode: "not_admissible", at: "2026-08-23T09:26:00.000Z" },
            ],
          },
        },
      },
    ],
    sinceSeq: 0, latestSeq: 41, count: 2, bounded: true,
    preflight: {
      known: true, risk: "availability",
      quality: { failed: 0, total: 4, ratio: 0 },
      availability: { blocked: 4, rateLimited: 1, total: 4 },
      messages: ["4 of 4 could not be checked — 3 fetch-failed, 1 rate-limited. This is an availability result, not evidence of absence."],
      blockedNotAbsent: true, scorecard: null,
    },
  },
  resume: { offered: true, reason: "ok", detail: "A checkpoint is usable. Resuming restarts after s11-signoff.", checkpointSavedAt: "2026-08-23T09:40:00.000Z", resumeFromStepId: "s12-persist", orphaned: false, runCount: 1, reclaimLimit: 3 },
  swept: [],
};

/** The finished, signed mission: terminal, with an artefact to read. */
const SIGNED_VIEW = {
  ...LIVE_VIEW,
  mission: {
    ...LIVE_VIEW.mission,
    id: SIGNED.id, topic: SIGNED.topic, status: "completed", terminal: true,
    pill: { code: "completed", tone: "good", label: "完成", detail: null, degradedDimensions: 0, totalDimensions: 2 },
    score: 82, leaderScore: 82, signed: true, verdict: "sign",
    // THE LEADER'S OWN SHAPE, keys and all. Not a schema this file controls —
    // an array value and a string value, because the block that renders it
    // iterates entries rather than naming the three keys somebody saw once.
    goals: { 核心问题: ["许可证会不会收紧", "谁在推动"], 交付物: "一份可引用的报告" },
    lastStage: "s12-persist", completedAt: SIGNED.completedAt, elapsedMs: 3840000,
    progress: { stagesResolved: 12, stagesTotal: 12, percent: 100, dimensionsResolved: 2, dimensionsTotal: 2, chaptersDone: 4, chaptersTotal: 4 },
  },
  stages: stagesUpTo("s12-persist").map((stage) => ({ ...stage, status: stage.status === "running" ? "done" : stage.status })),
  artifact: {
    kind: "artifact", version: 2, runCount: 1, stale: false, trigger: "initial",
    title: SIGNED.topic, wordCount: 8200, markdownBytes: 52000, degraded: false,
    createdAt: "2026-08-22T10:04:00.000Z", sections: [], citations: [{ index: 1 }],
    quality: { evidenced: { total: 4, verified: 3, unverified: 1, unchecked: 0, contradicted: 0 }, interpretive: { total: 2, verified: 2, unverified: 0, unchecked: 0, contradicted: 0 }, unplaced: { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 }, total: 6 },
    versions: [],
  },
  resume: { offered: false, reason: "wrong-status", detail: "Status completed is not resumable.", orphaned: false, runCount: 1, reclaimLimit: 3 },
};

const MISSION_VIEWS = {
  [RUNNING.id]: LIVE_VIEW, [ORPHAN.id]: LIVE_VIEW,
  [REFUSED.id]: DEAD_VIEW, [SIGNED.id]: SIGNED_VIEW,
};

// `/missions/:id/artifact`: the whole row, markdown and frozen evidence
// included — the list route sends neither, on purpose.
const ARTIFACTS = {
  [REFUSED.id]: {
    artifact: {
      ...DEAD_VIEW.artifact,
      kind: undefined,
      markdown: "# 一个什么都没查到的冷门课题\n\n没有可核验的证据。\n",
      evidence: [],
      // What `projectDegradeReason` returns, violations and all. The screen used
      // to print one either/or sentence — the guard fired OR the leader refused
      // — for every degraded version, which says something is wrong and nothing
      // about what.
      degradeReason: {
        signed: false, signedSource: "missions.leader_signed", score: 31, verdict: "refuse",
        refusalReason: "全文一处引用都没有，签不下去。",
        accountabilityNote: "失败在采集：四个页面里有三个抓不下来。",
        guardViolations: [
          { code: "no-citations", detail: "citations.length === 0" },
          { code: "scorecard-empty", detail: "quality.total === 0" },
        ],
        guardMessage: REFUSED.errorMessage,
        guardSource: "mission:finalized.detail.violations",
        failureCode: "quality_refused",
        degraded: true,
      },
    },
    versions: DEAD_VIEW.artifact.versions,
  },
  [SIGNED.id]: {
    artifact: {
      missionId: SIGNED.id, version: 2, runCount: 1, trigger: "initial",
      title: "开源推理模型的许可证走向",
      // `[1]`, `[2]` and `[9]`, exactly as s8 writes them. Two of the three have
      // a citation behind them and one does not, which is the distinction the
      // marker has to draw: a number that leads somewhere and a number that
      // leads nowhere must not look the same.
      markdown: "# 开源推理模型的许可证走向\n\n三家实验室同期收敛到同一种做法[1]，第二家实验室报告了同样的曲线[2]。\n\n这一句引的是一个没有留下元数据的编号[9]。\n",
      sections: [{ dimensionId: "d1", chapterIndex: 0, sectionType: "evidenced", heading: "训练侧", start: 0, end: 40 }],
      citations: [
        { index: 1, url: "https://deepmind.google/discover/scaling", findingId: "f1", inlineQuote: "we observe the same scaling behaviour at test time" },
        // The second one joins on `findingId` and the frozen row it lands on
        // has no address: the entry still exists, still carries its quote, and
        // says the address did not survive.
        { index: 2, url: "", findingId: "f2", inlineQuote: "the replication holds across the two smaller model sizes" },
        // The third joins nothing at all. It is kept and marked rather than
        // dropped, because a silently missing entry turns a number in the prose
        // into a pointer to nothing with no way to tell that from a mistake.
        { index: 3, url: "https://example.net/withdrawn", findingId: "f-not-frozen", inlineQuote: "" },
      ],
      evidence: [
        {
          findingId: "f1", dimensionId: "d1",
          claim: "三家实验室同期收敛到同一种推理时序扩展做法",
          quote: "we observe the same scaling behaviour at test time",
          sourceUrl: "https://deepmind.google/discover/scaling", sourceHost: "deepmind.google",
          sourceTitle: "Scaling test-time compute", verifyState: "verified-source-text",
          documentId: "doc-1", spanIndex: 4, contentHash: "abc", fetchedAt: "2026-08-24T09:10:00.000Z",
          status: 200, charCount: 18400,
        },
        // A row whose address did not survive: the quote still shows, and the
        // page says it cannot be opened rather than dropping the row and
        // disagreeing with the count printed above it.
        {
          findingId: "f2", dimensionId: "d1",
          claim: "第二家实验室报告了同样的曲线",
          quote: "the replication holds across the two smaller model sizes",
          sourceUrl: "", sourceHost: "", sourceTitle: "",
          verifyState: "verified-source-text", documentId: "doc-2", spanIndex: 1,
          contentHash: null, fetchedAt: null, status: null, charCount: null,
        },
      ],
      quality: { evidenced: { total: 4, verified: 3, unverified: 1, unchecked: 0, contradicted: 0 }, interpretive: { total: 2, verified: 2, unverified: 0, unchecked: 0, contradicted: 0 }, unplaced: { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 }, total: 6 },
      wordCount: 8200, degraded: false, createdAt: "2026-08-24T10:00:00.000Z",
    },
    // The older version, answered as a DIFFERENT document. A stub that served
    // the newest whatever was asked for would let a download control that sends
    // the wrong version pass this file.
    olderVersions: {
      1: {
        missionId: SIGNED.id, version: 1, runCount: 1, trigger: "initial",
        title: "开源推理模型的许可证走向",
        markdown: "# 开源推理模型的许可证走向\n\n第一版只写了三百字就被闸门拦下了。\n",
        sections: [], citations: [], evidence: [],
        quality: { evidenced: { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 }, interpretive: { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 }, unplaced: { total: 0, verified: 0, unverified: 0, unchecked: 0, contradicted: 0 }, total: 0 },
        wordCount: 300, degraded: true, createdAt: "2026-08-24T09:50:00.000Z",
        degradeReason: {
          signed: null, signedSource: null, score: null, verdict: null,
          refusalReason: null, accountabilityNote: null,
          guardViolations: [{ code: "word-count", detail: "300 words against a floor of 2400" }],
          guardMessage: "word-count: 300 words against a floor of 2400",
          guardSource: "mission:finalized.detail.violations",
          failureCode: null, degraded: true,
        },
      },
    },
    versions: [
      { version: 2, runCount: 1, trigger: "initial", title: "开源推理模型的许可证走向", wordCount: 8200, degraded: false, citations: 1, createdAt: "2026-08-24T10:00:00.000Z" },
      { version: 1, runCount: 1, trigger: "initial", title: "开源推理模型的许可证走向", wordCount: 300, degraded: true, citations: 0, createdAt: "2026-08-24T09:50:00.000Z" },
    ],
  },
};


// ── the trajectory ──────────────────────────────────────────────────────────
//
// `/missions/:id/trace` merges four streams into one ordered list, and the
// rows below are shaped exactly as `buildMissionTrace` emits them — `seq`
// assigned oldest-first over the whole list, `ref` as the identity, `ok` and
// `verified` three-valued. A fixture that collapsed `ok` to a boolean would
// test the page against a server that does not exist, and against the one
// distinction the whole evidence column is built to keep.

/** The rows a running mission has recorded, oldest first. */
const LIVE_TRACE_ROWS = [
  {
    seq: 1, at: "2026-08-24T09:00:01.000Z", kind: "event", role: "SYSTEM",
    title: "mission:started", detail: "stepId=s1-brief", result: "",
    ms: null, ok: null, state: "mission:started",
    stepId: "s1-brief", agentId: null, dimensionId: null, dimensionName: null,
    paceKey: null, ref: "event:1",
  },
  {
    seq: 2, at: "2026-08-24T09:01:00.000Z", kind: "stage", role: "STAGE",
    title: "s2-plan", detail: "started", result: "stepId=s2-plan · status=started",
    ms: null, ok: null, state: "started",
    stepId: "s2-plan", agentId: "leader", dimensionId: null, dimensionName: null,
    paceKey: null, ref: "stage:s2-plan@2",
  },
  {
    seq: 3, at: "2026-08-24T09:12:00.000Z", kind: "stage", role: "STAGE",
    title: "s2-plan", detail: "done", result: "stepId=s2-plan · status=done · durationMs=120000",
    ms: 120000, ok: true, state: "done",
    stepId: "s2-plan", agentId: "leader", dimensionId: null, dimensionName: null,
    paceKey: null, ref: "stage:s2-plan@3",
  },
  // The row `args_text` was added for: eighty-six searches, and the only honest
  // answer to "why did four of them find nothing" used to be that nobody could
  // see the queries.
  {
    seq: 4, at: "2026-08-24T09:13:00.000Z", kind: "tool", role: "TOOL",
    title: "web.search", detail: '{"q":"test-time compute scaling laws"}', result: "ok",
    ms: 820, ok: true, state: "ok",
    stepId: "s3-collect", agentId: "researcher:d1", dimensionId: "d1",
    dimensionName: "推理时序扩展的训练侧做法",
    paceKey: "web", ref: "tool:2026-08-24T09:13:00.000Z#0",
  },
  {
    seq: 5, at: "2026-08-24T09:13:30.000Z", kind: "tool", role: "TOOL",
    title: "web.fetch", detail: '{"url":"https://arxiv.org/abs/2401.00001"}', result: "rate_limited",
    ms: 30, ok: false, state: "rate_limited",
    stepId: "s3-collect", agentId: "researcher:d2", dimensionId: "d2",
    dimensionName: "推理时序扩展的推理侧做法",
    paceKey: "fetch", ref: "tool:2026-08-24T09:13:30.000Z#0",
  },
  {
    seq: 6, at: "2026-08-24T09:14:00.000Z", kind: "finding", role: "EVIDENCE",
    title: "deepmind.google",
    detail: "三家实验室同期收敛到同一种推理时序扩展做法",
    result: "we observe the same scaling behaviour at test time",
    ms: null, ok: true, state: "verified-source-text",
    stepId: null, agentId: null, dimensionId: "d1",
    dimensionName: "推理时序扩展的训练侧做法",
    paceKey: null, ref: "finding:f1",
  },
  // The third dimension, with exactly one row to its name. It is here so the
  // dimension select has something to be honest about: five dimensions were
  // planned, three ever reached the trajectory, and an option that matches one
  // row has to say "1" rather than looking like the other two.
  {
    seq: 7, at: "2026-08-24T09:14:30.000Z", kind: "finding", role: "EVIDENCE",
    title: "arxiv.org",
    detail: "评测侧只留下了一条记录",
    result: "the evaluation dimension recorded exactly one row",
    ms: null, ok: true, state: "verified-source-text",
    stepId: null, agentId: null, dimensionId: "d3",
    dimensionName: "推理时序扩展的评测侧做法",
    paceKey: null, ref: "finding:f7",
  },
];

/** The rows of the mission that verified nothing. */
const DEAD_TRACE_ROWS = [
  {
    seq: 1, at: "2026-08-23T09:26:00.000Z", kind: "tool", role: "TOOL",
    title: "fetch_page", detail: '{"url":"https://example.org/whitepaper"}', result: "not_admissible",
    ms: 40, ok: false, state: "not_admissible",
    stepId: "s3-collect", agentId: "researcher-d1", dimensionId: "d1",
    dimensionName: "这个冷门课题的公开材料",
    paceKey: "fetch", ref: "tool:2026-08-23T09:26:00.000Z#0",
  },
  // Two of this dimension's four findings are inside the trajectory window and
  // two are not, which is the situation `/findings` and `/trace` can genuinely
  // be in: they page independently over different bounds. The panel has to say
  // which of the two it hit rather than showing an empty tab.
  {
    seq: 2, at: "2026-08-23T09:28:00.000Z", kind: "finding", role: "EVIDENCE",
    title: "example.org", detail: "这个课题的第一条线索",
    result: "the paper reports a single unreplicated result",
    ms: null, ok: null, state: "unchecked-fetch-failed",
    stepId: null, agentId: null, dimensionId: "d1", dimensionName: "这个冷门课题的公开材料",
    paceKey: null, ref: "finding:g1",
  },
  {
    seq: 3, at: "2026-08-23T09:29:00.000Z", kind: "finding", role: "EVIDENCE",
    title: "mirror.example.net", detail: "这个课题的第四条线索",
    result: "a mirror of the same page carries the identical wording",
    ms: null, ok: null, state: "unchecked-rate-limited",
    stepId: null, agentId: null, dimensionId: "d1", dimensionName: "这个冷门课题的公开材料",
    paceKey: null, ref: "finding:g4",
  },
  {
    seq: 4, at: "2026-08-23T09:30:00.000Z", kind: "stage", role: "STAGE",
    title: "s3-collect", detail: "degraded", result: "stepId=s3-collect · status=degraded",
    ms: 600000, ok: null, state: "degraded",
    stepId: "s3-collect", agentId: "researcher", dimensionId: null, dimensionName: null,
    paceKey: null, ref: "stage:s3-collect@40",
  },
  {
    seq: 5, at: "2026-08-23T09:31:00.000Z", kind: "event", role: "GATE",
    title: "evidence:none", detail: "outcome=none · verified=0 · floorSum=3",
    result: "no dimension produced a single finding whose quote verified",
    ms: null, ok: false, state: "evidence:none",
    stepId: null, agentId: null, dimensionId: null, dimensionName: null,
    paceKey: null, ref: "event:41",
  },
];

// FIVE PLANNED. `data.dimensions` is what s2 wrote down, and it is the list the
// filter used to be built from — on a real mission five options of which three
// can ever match, with nothing on screen saying which two were dead ends.
const LIVE_TRACE_DIMENSIONS = [
  { dimensionId: "d1", name: "推理时序扩展的训练侧做法", state: "collected", verified: 5, total: 5, uniqueHosts: 3 },
  { dimensionId: "d2", name: "推理时序扩展的推理侧做法", state: "collecting", verified: 2, total: 4, uniqueHosts: 2 },
  { dimensionId: "d3", name: "推理时序扩展的评测侧做法", state: "collecting", verified: 1, total: 1, uniqueHosts: 1 },
  { dimensionId: "d4", name: "推理时序扩展的成本账", state: "pending", verified: 0, total: 0, uniqueHosts: 0 },
  { dimensionId: "d5", name: "推理时序扩展的监管面", state: "pending", verified: 0, total: 0, uniqueHosts: 0 },
];

const TRACES = {
  [RUNNING.id]: {
    rows: LIVE_TRACE_ROWS,
    stages: stagesUpTo("s3-collect").map(({ stepId, ordinal, status, attempts, startedAt, endedAt, durationMs, degradeNote }) =>
      ({ stepId, ordinal, status, attempts, startedAt, endedAt, durationMs, tokens: 0, degradeNote })),
    dimensions: LIVE_TRACE_DIMENSIONS,
    lastEventSeq: 6,
    window: {
      events: { taken: 3, cap: 1000, saturated: false },
      toolCalls: { taken: 2, cap: 500, saturated: false },
      findings: { taken: 1, cap: 2000, saturated: false },
      note: "the trajectory is assembled from bounded reads over three tables",
    },
  },
  [REFUSED.id]: {
    rows: DEAD_TRACE_ROWS,
    stages: stagesUpTo("s12-persist", { degradeAt: "s3-collect" })
      .map(({ stepId, ordinal, status, attempts, startedAt, endedAt, durationMs, degradeNote }) =>
        ({ stepId, ordinal, status, attempts, startedAt, endedAt, durationMs, tokens: 0, degradeNote })),
    dimensions: [{ dimensionId: "d1", name: "这个冷门课题的公开材料", state: "degraded", verified: 0, total: 4, uniqueHosts: 0 }],
    lastEventSeq: 41,
    // A read that hit its ceiling. Rendered rather than swallowed: a mission
    // that stops at the thousandth event looks exactly like a mission that
    // stopped working, and only this flag tells them apart.
    window: {
      events: { taken: 1000, cap: 1000, saturated: true },
      toolCalls: { taken: 11, cap: 500, saturated: false },
      findings: { taken: 4, cap: 2000, saturated: false },
      note: "the trajectory is assembled from bounded reads over three tables",
    },
  },
};

TRACES[ORPHAN.id] = TRACES[RUNNING.id];
TRACES[SIGNED.id] = TRACES[RUNNING.id];

/**
 * A mission that has recorded nothing at all.
 *
 * Handed to `stubFetch({ traces })` by the empty-state tests. Not a mistake
 * and not a failure: a mission whose first stage has not written its first
 * event answers exactly this, and it must not read as "your filter is wrong"
 * — nor, one step earlier, may a read still in flight read as this.
 */
const EMPTY_TRACE = {
  rows: [],
  stages: [],
  dimensions: [],
  lastEventSeq: 0,
  window: {
    events: { taken: 0, cap: 1000, saturated: false },
    toolCalls: { taken: 0, cap: 500, saturated: false },
    findings: { taken: 0, cap: 2000, saturated: false },
    note: "the trajectory is assembled from bounded reads over three tables",
  },
};

/**
 * The parts of a row `/trace` had to truncate, keyed by `ref`.
 *
 * Merged over the list row rather than restated beside it, because that is what
 * the route does: one read serves both, so the detail can never describe a row
 * the list did not show.
 */
const TRACE_EXTRAS = {
  "finding:f1": {
    payload: {
      id: "f1", dimensionId: "d1", dimensionName: "推理时序扩展的训练侧做法",
      runCount: 1, attempt: 0,
      claim: "三家实验室同期收敛到同一种推理时序扩展做法",
      claimHash: "c-1",
      quote: "we observe the same scaling behaviour at test time across all three model families",
      quoteChars: 79,
      sourceUrl: "https://deepmind.google/discover/scaling",
      sourceHost: "deepmind.google", sourceTitle: "Scaling test-time compute",
      publishedAt: null, verifyState: "verified-source-text", verifyReason: null,
      counts: true, verified: true, documentId: "doc-1", spanIndex: 4,
      recordedAt: "2026-08-24T09:14:00.000Z",
    },
    result: {
      text: "we observe the same scaling behaviour at test time across all three model families",
      format: "text", note: null,
    },
    timing: { at: "2026-08-24T09:14:00.000Z", ms: null, startedAt: null, endedAt: "2026-08-24T09:14:00.000Z", source: "mission_findings.created_at" },
    dimension: { dimensionId: "d1", name: "推理时序扩展的训练侧做法", facet: "technical", state: "collected", grade: 78, summary: null, verified: 5, total: 5, uniqueHosts: 3 },
  },
  // Never checked, and the panel has to say that rather than say it failed. A
  // 429 is not a fabrication, and `verified: null` is how the column keeps them
  // apart all the way to the screen.
  "finding:g1": {
    payload: {
      id: "g1", dimensionId: "d1", dimensionName: "这个冷门课题的公开材料",
      runCount: 1, attempt: 0,
      claim: "这个课题的第一条线索",
      claimHash: "c-g1",
      quote: "the paper reports a single unreplicated result and no dataset was released with it",
      quoteChars: 81,
      sourceUrl: "https://example.org/whitepaper",
      sourceHost: "example.org", sourceTitle: null, publishedAt: null,
      verifyState: "unchecked-fetch-failed",
      verifyReason: "the fetch returned 503 three times",
      counts: false, verified: null, documentId: null, spanIndex: null,
      recordedAt: "2026-08-23T09:28:00.000Z",
    },
    result: {
      text: "the paper reports a single unreplicated result and no dataset was released with it",
      format: "text", note: "verifier: the fetch returned 503 three times",
    },
    timing: { at: "2026-08-23T09:28:00.000Z", ms: null, startedAt: null, endedAt: "2026-08-23T09:28:00.000Z", source: "mission_findings.created_at" },
    dimension: { dimensionId: "d1", name: "这个冷门课题的公开材料", facet: "technical", state: "degraded", grade: 12, summary: "这个维度读了 2 个页面，没有产出任何通过核验的引语。", verified: 0, total: 4, uniqueHosts: 0 },
  },
  "tool:2026-08-24T09:13:00.000Z#0": {
    payload: {
      tool: "web.search", argsText: '{"q":"test-time compute scaling laws","max":8,"recency":"90d"}',
      argsTextStoredCap: 300, argsHash: "a-1", paceKey: "web", cached: false,
      stepId: "s3-collect", agentId: "researcher:d1",
    },
    result: {
      text: "ok", format: "text",
      note: "mission_tool_calls records the verdict of a call, not its body. A fetched page's text is in mission_documents; a finding's quote is on the finding row.",
    },
    timing: {
      at: "2026-08-24T09:13:00.000Z", ms: 820,
      startedAt: "2026-08-24T09:12:59.180Z", endedAt: "2026-08-24T09:13:00.000Z",
      source: "mission_tool_calls.at is written when the call returns; startedAt is that instant minus the measured latency_ms, and is derived rather than recorded.",
    },
  },
};

/** One finding, in the shape `projectFinding` returns it. */
const finding = (id, over) => ({
  id, dimensionId: "d1", dimensionName: "这个冷门课题的公开材料",
  runCount: 1, attempt: 0, claim: "", claimHash: null,
  quote: "", quoteChars: 0,
  sourceUrl: null, sourceHost: null, sourceTitle: null, publishedAt: null,
  verifyState: "unchecked-fetch-failed", verifyReason: null,
  counts: false, verified: null, documentId: null, spanIndex: null,
  recordedAt: "2026-08-23T09:28:00.000Z",
  ...over,
});

/** `[{host, findings}]` over a list of findings, busiest first. */
function hostTally(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (typeof row.sourceHost !== "string" || row.sourceHost === "") continue;
    seen.set(row.sourceHost, (seen.get(row.sourceHost) ?? 0) + 1);
  }
  return [...seen].map(([host, findings]) => ({ host, findings })).sort((a, b) => b.findings - a.findings);
}

/** The nine verify states, as the route's vocabulary carries them. */
const VERIFY_STATES = [
  "verified-source-text", "verified-adjacent-spans", "verified-abstract",
  "misattributed", "unverifiable", "too-short",
  "unchecked-fetch-failed", "unchecked-rate-limited", "unchecked-stale",
];

/**
 * `/missions/:id/findings?dimensionId=…`, per mission and dimension.
 *
 * The mission that verified NOTHING is the interesting one: four findings, none
 * of them checked, every one of them readable. A dimension card that says
 * "已核验 0" and shows nothing at all is the screen this route was added to fix.
 */
const FINDINGS = {
  [RUNNING.id]: {
    d1: {
      missionId: RUNNING.id, runCount: 1,
      scope: { dimensionId: "d1", verifyState: null, attempt: null },
      dimension: { dimensionId: "d1", name: "推理时序扩展的训练侧做法", rationale: null, facet: "technical", state: "collected", attempt: 1, grade: 78, gradeAxes: null, summary: null, failureCode: null, updatedAt: "2026-08-24T09:12:00.000Z" },
      findings: [
        finding("f1", {
          dimensionName: "推理时序扩展的训练侧做法",
          claim: "三家实验室同期收敛到同一种推理时序扩展做法",
          quote: "we observe the same scaling behaviour at test time across all three model families",
          quoteChars: 79,
          sourceUrl: "https://deepmind.google/discover/scaling",
          sourceHost: "deepmind.google", sourceTitle: "Scaling test-time compute",
          verifyState: "verified-source-text", counts: true, verified: true,
          documentId: "doc-1", spanIndex: 4,
        }),
        finding("f1b", {
          dimensionName: "推理时序扩展的训练侧做法",
          claim: "第二家实验室报告了同样的曲线",
          quote: "the replication holds across the two smaller model sizes",
          quoteChars: 55,
          sourceUrl: "https://arxiv.org/abs/2401.00002",
          sourceHost: "arxiv.org", verifyState: "verified-source-text",
          counts: true, verified: true,
        }),
        // FIFTY-THREE MORE, so `hasMore` is something a slice actually produces.
        // `MISSION_FINDINGS_TAKE` is 50: a fixture of two findings with
        // `hasMore: true` written into it is a fixture agreeing with itself, and
        // the control that fetches the second page would never be exercised.
        ...Array.from({ length: 53 }, (_, at) => finding(`f1-${at}`, {
          dimensionName: "推理时序扩展的训练侧做法",
          claim: `第 ${at + 3} 条同类记录`,
          quote: `the ${at + 3}th corroborating span behind the same claim`,
          quoteChars: 50,
          sourceUrl: at % 2 === 0
            ? `https://deepmind.google/discover/scaling-${at}`
            : `https://arxiv.org/abs/2401.${String(at).padStart(5, "0")}`,
          sourceHost: at % 2 === 0 ? "deepmind.google" : "arxiv.org",
          verifyState: "verified-source-text", counts: true, verified: true,
        })),
      ],
      // Filled in by the stub, which pages over `findings` rather than stating
      // a page that no slice produces.
      page: { take: 50, skip: 0, returned: 50, hasMore: true, order: "created" },
      counts: { total: 55, byState: { "verified-source-text": 55 }, verified: 55, verifiedAbstract: 0, unchecked: 0, uniqueHosts: 2 },
      hosts: [{ host: "deepmind.google", findings: 28 }, { host: "arxiv.org", findings: 27 }],
      allHosts: [{ host: "deepmind.google", findings: 28 }, { host: "arxiv.org", findings: 27 }],
      vocabulary: {
        verifyStates: VERIFY_STATES, countingState: "verified-source-text", fetchBackedStates: [],
        orders: ["created", "host", "verifyState"],
        sourceHosts: ["deepmind.google", "arxiv.org"],
      },
    },
    d2: {
      missionId: RUNNING.id, runCount: 1,
      scope: { dimensionId: "d2", verifyState: null, attempt: null },
      dimension: null, findings: [],
      page: { take: 50, skip: 0, returned: 0, hasMore: false, order: "created" },
      counts: { total: 0, byState: {}, verified: 0, verifiedAbstract: 0, unchecked: 0, uniqueHosts: 0 },
      hosts: [], allHosts: [],
      vocabulary: {
        verifyStates: VERIFY_STATES, countingState: "verified-source-text", fetchBackedStates: [],
        orders: ["created", "host", "verifyState"], sourceHosts: [],
      },
    },
  },
  [REFUSED.id]: {
    d1: {
      missionId: REFUSED.id, runCount: 1,
      scope: { dimensionId: "d1", verifyState: null, attempt: null },
      dimension: { dimensionId: "d1", name: "这个冷门课题的公开材料", rationale: null, facet: "technical", state: "degraded", attempt: 1, grade: 12, gradeAxes: null, summary: "这个维度读了 2 个页面，没有产出任何通过核验的引语。", failureCode: null, updatedAt: "2026-08-23T09:31:00.000Z" },
      findings: [
        finding("g1", { claim: "这个课题的第一条线索", quote: "the paper reports a single unreplicated result", quoteChars: 46, sourceUrl: "https://example.org/whitepaper", sourceHost: "example.org", verifyState: "unchecked-fetch-failed" }),
        finding("g2", { claim: "这个课题的第二条线索", quote: "no follow-up work was published in the two years since", quoteChars: 54, sourceUrl: "https://example.org/followup", sourceHost: "example.org", verifyState: "unchecked-fetch-failed" }),
        finding("g3", { claim: "这个课题的第三条线索", quote: "the archive copy has been withdrawn by the author", quoteChars: 48, sourceUrl: "https://example.org/withdrawn", sourceHost: "example.org", verifyState: "unchecked-fetch-failed" }),
        finding("g4", { claim: "这个课题的第四条线索", quote: "a mirror of the same page carries the identical wording", quoteChars: 55, sourceUrl: "https://mirror.example.net/copy", sourceHost: "mirror.example.net", verifyState: "unchecked-rate-limited" }),
      ],
      page: { take: 50, skip: 0, returned: 4, hasMore: false, order: "created" },
      counts: { total: 4, byState: { "unchecked-fetch-failed": 3, "unchecked-rate-limited": 1 }, verified: 0, verifiedAbstract: 0, unchecked: 4, uniqueHosts: 0 },
      // `hosts` is verified-only and this mission verified nothing, so it is
      // empty while `allHosts` is not — which is exactly why the host filter is
      // validated against the second one.
      hosts: [],
      allHosts: [{ host: "example.org", findings: 3 }, { host: "mirror.example.net", findings: 1 }],
      vocabulary: {
        verifyStates: VERIFY_STATES, countingState: "verified-source-text", fetchBackedStates: [],
        orders: ["created", "host", "verifyState"],
        sourceHosts: ["example.org", "mirror.example.net"],
      },
    },
  },
};

FINDINGS[ORPHAN.id] = FINDINGS[RUNNING.id];
FINDINGS[SIGNED.id] = FINDINGS[RUNNING.id];

/**
 * `/missions/:id/sources`: one row per distinct URL, not per finding.
 *
 * Fourteen findings over three pages. The page cited six times is ONE row here
 * and six rows in the findings route, which is the whole reason this route
 * exists: a references screen built from findings shows the same address six
 * times and makes a thinly-sourced mission look well sourced.
 */
const SOURCES = {
  [SIGNED.id]: {
    missionId: SIGNED.id, runCount: 1, scope: { dimensionId: null },
    sources: [
      {
        url: "https://kanatanorthba.com/about/", host: "kanatanorthba.com",
        title: "About the Kanata North business association",
        findings: 6, verified: 4, dimensionIds: ["d1", "d2"],
        verifyStates: { "verified-source-text": 4, "unchecked-fetch-failed": 2 },
        firstSeenAt: "2026-08-22T09:20:00.000Z",
      },
      {
        url: "https://deepmind.google/discover/scaling", host: "deepmind.google",
        title: "Scaling test-time compute",
        findings: 5, verified: 5, dimensionIds: ["d1"],
        verifyStates: { "verified-source-text": 5 },
        firstSeenAt: "2026-08-22T09:22:00.000Z",
      },
      {
        url: "https://arxiv.org/abs/2401.00002", host: "arxiv.org",
        title: "Replication at two smaller sizes",
        findings: 3, verified: 2, dimensionIds: ["d2"],
        verifyStates: { "verified-source-text": 2, "unchecked-rate-limited": 1 },
        firstSeenAt: "2026-08-22T09:31:00.000Z",
      },
    ],
    totals: { sources: 3, hosts: 3, findings: 14, verified: 11 },
    runs: [{ runCount: 1, total: 14, verified: 11, dimensions: 2 }],
    dimensions: [
      { dimensionId: "d1", name: "推理时序扩展的训练侧做法" },
      { dimensionId: "d2", name: "推理时序扩展的推理侧做法" },
    ],
  },
  // A mission that READ and verified nothing, which is not the same as one that
  // read nothing. Two pages under one dimension, zero verified quotes, and the
  // dimension's own account of why — the sentence that used to be the 证据
  // pane's reason to exist and is now what the by-dimension arrangement prints
  // where that dimension's pages would be.
  [REFUSED.id]: {
    missionId: REFUSED.id, runCount: 1, scope: { dimensionId: null },
    sources: [
      {
        url: "https://example.org/a", host: "example.org", title: "一份公开材料",
        findings: 2, verified: 0, dimensionIds: ["d1"], firstSeenAt: "2026-08-22T09:30:00.000Z",
      },
      {
        url: "https://example.org/b", host: "example.org", title: "另一份公开材料",
        findings: 2, verified: 0, dimensionIds: ["d1"], firstSeenAt: "2026-08-22T09:31:00.000Z",
      },
    ],
    totals: { sources: 2, hosts: 1, findings: 4, verified: 0 },
    runs: [{ runCount: 1, total: 4, verified: 0, dimensions: 1 }],
    dimensions: [{
      dimensionId: "d1",
      name: "这个冷门课题的公开材料",
      state: "degraded",
      summary: "这个维度读了 2 个页面，没有产出任何通过核验的引语。",
    }],
  },
  // A mission that has not read a page yet: the pane must say that rather than
  // drawing an empty rectangle indistinguishable from a crash.
  [RUNNING.id]: {
    missionId: RUNNING.id, runCount: 1, scope: { dimensionId: null },
    sources: [], totals: { sources: 0, hosts: 0, findings: 0, verified: 0 },
    runs: [{ runCount: 1, total: 0, verified: 0, dimensions: 0 }],
    dimensions: [],
  },
};

/**
 * `/missions/:id/trace`, filtered and ordered the way the route does it.
 *
 * Filtered here rather than answered as one fixed page, for the reason
 * `/missions/list` is answered per status: the interesting question about a
 * filter is not whether the chip draws, it is whether the list under it changes.
 */
function tracePage(missionId, query, from = TRACES[missionId]) {
  const source = from ?? { rows: [], stages: [], dimensions: [], lastEventSeq: 0, window: {} };
  const kind = query.get("kind");
  const agentId = query.get("agentId");
  const stepId = query.get("stepId");
  const dimensionId = query.get("dimensionId");
  const needle = (query.get("search") ?? "").toLowerCase();
  const order = query.get("order") ?? "newest";
  const matched = source.rows.filter((row) => {
    if (kind !== null && row.kind !== kind) return false;
    if (agentId !== null && row.agentId !== agentId) return false;
    if (stepId !== null && row.stepId !== stepId) return false;
    if (dimensionId !== null && row.dimensionId !== dimensionId) return false;
    if (needle === "") return true;
    return [row.title, row.detail, row.result, row.stepId, row.agentId, row.dimensionName, row.state]
      .some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
  });
  const rows = order === "oldest" ? matched : [...matched].reverse();
  return {
    missionId, runCount: 1, rows,
    page: {
      order, take: Number(query.get("take") ?? 100), skip: 0,
      returned: rows.length, total: matched.length, hasMore: false,
      unfiltered: source.rows.length,
    },
    filters: { kind, role: null, agentId, stepId, dimensionId, search: needle === "" ? null : needle },
    window: source.window,
    stages: source.stages,
    dimensions: source.dimensions,
    lastEventSeq: source.lastEventSeq,
    truncation: { detailChars: 200, resultChars: 160 },
    // MEASURED FROM THE ROWS, exactly as `traceVocabulary` does it on the Host
    // half. Derived here rather than written as a literal, so a fixture whose
    // rows change cannot go on advertising an option that matches none of them
    // — which is the whole defect this vocabulary exists to close.
    vocabulary: {
      kinds: ["stage", "tool", "finding", "event"],
      roles: ["STAGE", "TOOL", "EVIDENCE", "GATE", "SYSTEM"],
      orders: ["newest", "oldest"],
      agents: traceAgents(source.rows),
      dimensions: traceDimensions(source.rows),
    },
  };
}

/** `{id, rows}` per agent that produced a row, busiest first. */
function traceAgents(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (typeof row.agentId !== "string" || row.agentId === "") continue;
    seen.set(row.agentId, (seen.get(row.agentId) ?? 0) + 1);
  }
  return [...seen].map(([id, count]) => ({ id, rows: count }))
    .sort((a, b) => b.rows - a.rows || a.id.localeCompare(b.id));
}

/** `{dimensionId, name, rows}` per dimension that appears on a row. */
function traceDimensions(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (typeof row.dimensionId !== "string" || row.dimensionId === "") continue;
    const held = seen.get(row.dimensionId);
    if (held === undefined) seen.set(row.dimensionId, { dimensionId: row.dimensionId, name: row.dimensionName ?? null, rows: 1 });
    else held.rows += 1;
  }
  return [...seen.values()].sort((a, b) => b.rows - a.rows || a.dimensionId.localeCompare(b.dimensionId));
}

/** `/missions/:id/trace/:ref`, in the shape `traceDetail` builds it. */
function traceDetail(missionId, ref, from = TRACES[missionId]) {
  const rows = (from ?? { rows: [] }).rows;
  const row = rows.find((entry) => entry.ref === ref);
  if (row === undefined) return null;
  const extra = TRACE_EXTRAS[ref] ?? {};
  const payload = extra.payload ?? {};
  return {
    missionId, ref, seq: row.seq, kind: row.kind, role: row.role, at: row.at,
    ok: row.ok, state: row.state, row, payload,
    result: extra.result ?? { text: null, format: null, note: null },
    timing: extra.timing ?? { at: row.at, ms: row.ms, startedAt: null, endedAt: null, source: "mission_events.ts" },
    stepId: row.stepId, agentId: row.agentId,
    stage: extra.stage ?? null,
    dimension: extra.dimension ?? null,
    toolCall: row.kind === "tool" ? payload : null,
    finding: row.kind === "finding" ? payload : null,
    event: row.kind === "event" || row.kind === "stage" ? { payload } : null,
  };
}

const VERSION = {
  version: "0.3.4", channel: "release", label: "0.3.4", node: "24.12.0",
  library: "local", libraryPath: "/home/someone/.dsh/swarm/swarm-sources.sqlite",
};

/** Every POST this stub was asked to make, so a test can assert the wire. */
let posted = [];

/**
 * Answer the endpoints these panels read.
 *
 * `/missions/list` is answered PER STATUS rather than with one fixed page,
 * because the interesting question about a chip is not whether it draws — it is
 * whether the list under it changes. An unknown status is a 400 naming the
 * accepted values, exactly as the route answers it: an empty page for a typo
 * would make a chip nobody implemented indistinguishable from a chip with
 * nothing to show.
 * @param overrides - `missionPages` merged over the per-status pages, and
 *   `views` merged over the per-mission read models.
 */
function stubFetch(overrides = {}) {
  const pages = { ...MISSION_PAGES, ...(overrides.missionPages ?? {}) };
  const views = { ...MISSION_VIEWS, ...(overrides.views ?? {}) };
  // Overridable for the same reason `cancelled` is an empty page above: a
  // mission that has recorded nothing yet is a state the route really serves,
  // and the only way to prove the screen says something different about it is
  // to hand this stub a trajectory with nothing in it.
  const traces = { ...TRACES, ...(overrides.traces ?? {}) };
  posted = [];
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    const ok = (data) => ({ ok: true, json: async () => ({ success: true, data }) });

    if ((init?.method ?? "GET") === "POST" && address.includes("/missions/")) {
      posted.push({ url: address, body: init?.body === undefined ? null : JSON.parse(init.body) });
      if (address.endsWith("/missions/create")) {
        return ok({ id: RUNNING.id, revision: 1, stages: 12, depth: "standard", language: "zh", started: true });
      }
      if (address.endsWith("/cancel")) return ok({ aborted: true, abortWhy: null, status: "cancelled", previousStatus: "running" });
      if (address.endsWith("/resume")) return ok({ id: REFUSED.id, runCount: 2, started: true });
      if (address.endsWith("/rerun")) return ok({ id: REFUSED.id, runCount: 2, mode: "fresh", started: true, parked: false });
    }

    if (address.includes("/missions/budget-tiers")) return ok(TIERS);

    // 信源's own reader, which an evidence row opens: the Host half re-fetches
    // the page and extracts it, so what comes back is the article rather than
    // the five fields the evidence row already had.
    // THE s11 DRAWER'S OWN ENDPOINT. Nothing stubbed it, so no test had ever
    // rendered MissionJudgement, and the foreword — a STRUCTURED object by
    // FOREWORD_SCHEMA — went out as a React child unchallenged.
    if (address.includes("/insights")) {
      return ok({
        reconcile: null,
        critique: null,
        assess: null,
        signoff: {
          signature: { signed: true, score: 82, verdict: null, refusalReason: null, accountabilityNote: null },
          foreword: {
            whatWeAnswered: [{ criterion: "园区的法定边界是否成立", addressed: "partial", evidence: "两份规划文件互相矛盾。" }],
            whatRemainsUnclear: ["园区的法定边界"],
            howToRead: "这是一份证据审计后的阶段性底稿。",
            recommendedFollowUp: ["向规划局申请边界图的正式副本。"],
          },
          corrections: [],
          leaderScore: 82,
        },
        sources: { "s11-signoff": "ok" },
      });
    }
    if (address.includes("/proxy/reader")) {
      return ok({ title: "Scaling test-time compute", markdown: "An abstract of the paper the quote came from.", text: "An abstract." });
    }

    if (address.includes("/missions/list")) {
      const query = address.includes("?") ? address.slice(address.indexOf("?") + 1) : "";
      const status = new URLSearchParams(query).get("status") ?? "";
      if (!Object.hasOwn(pages, status)) {
        return {
          ok: false,
          json: async () => ({ success: false, error: `status must be one of running, resumable, completed, failed, cancelled, quality-failed; got ${status}` }),
        };
      }
      return ok(pages[status]);
    }

    const view = Object.keys(views).find((id) => address.includes(`/missions/${id}/view`));
    if (view !== undefined) return ok(views[view]);

    const sourced = Object.keys(SOURCES).find((id) => address.includes(`/missions/${id}/sources`));
    if (sourced !== undefined) return ok(SOURCES[sourced]);

    // The three routes the trajectory reads. `/trace/<ref>` is matched before
    // `/trace`, because the ref is a fourth path segment on the same action and
    // a prefix test would answer the detail request with the list.
    const traced = Object.keys(traces).find((id) => address.includes(`/missions/${id}/trace`));
    if (traced !== undefined) {
      const path = address.includes("?") ? address.slice(0, address.indexOf("?")) : address;
      const query = new URLSearchParams(address.includes("?") ? address.slice(address.indexOf("?") + 1) : "");
      const marker = `/missions/${traced}/trace/`;
      if (path.includes(marker)) {
        const ref = decodeURIComponent(path.slice(path.indexOf(marker) + marker.length));
        const detail = traceDetail(traced, ref, traces[traced]);
        return detail === null
          ? {
            ok: false,
            json: async () => ({
              success: false,
              // The route's own 404, which names the WINDOW rather than the
              // absence: a row that scrolled out of a bounded read and a row
              // that never existed want different reactions.
              error: `no trajectory row ${ref} in the window this page reads. The trajectory is assembled from the newest 1000 events, 500 tool calls and 2000 findings; an older row is on disk but outside it.`,
            }),
          }
          : ok(detail);
      }
      return ok(tracePage(traced, query, traces[traced]));
    }

    const evidenced = Object.keys(FINDINGS).find((id) => address.includes(`/missions/${id}/findings`));
    if (evidenced !== undefined) {
      const query = new URLSearchParams(address.slice(address.indexOf("?") + 1));
      const dimensionId = query.get("dimensionId") ?? "";
      const page = FINDINGS[evidenced][dimensionId];
      if (page === undefined) {
        return {
          ok: false,
          json: async () => ({
            success: false,
            // Named, never an empty list: an empty list from a mistyped id is
            // indistinguishable from an empty list from a dimension that found
            // nothing, and those two want opposite reactions.
            error: `mission ${evidenced} has no dimension "${dimensionId}" at run 1. It has ${Object.keys(FINDINGS[evidenced]).join(", ")}.`,
          }),
        };
      }
      // FILTERED AND PAGED HERE, for the reason `/missions/list` is answered per
      // status: the interesting question about a control is not whether it
      // draws, it is whether the list under it changes. A stub that ignored
      // `verifyState`, `sourceHost`, `order` and `skip` would pass a page that
      // sends them and throws the answers away.
      const take = Number(query.get("take") ?? 50);
      const skip = Number(query.get("skip") ?? 0);
      const verifyState = query.get("verifyState");
      const sourceHost = query.get("sourceHost");
      const order = query.get("order") ?? "created";
      let rows = page.findings;
      if (verifyState !== null) rows = rows.filter((row) => row.verifyState === verifyState);
      if (sourceHost !== null) rows = rows.filter((row) => row.sourceHost === sourceHost);
      if (order === "host") rows = [...rows].sort((a, b) => String(a.sourceHost).localeCompare(String(b.sourceHost)));
      if (order === "verifyState") rows = [...rows].sort((a, b) => String(a.verifyState).localeCompare(String(b.verifyState)));
      const window = rows.slice(skip, skip + take);
      return ok({
        ...page,
        findings: window,
        page: { take, skip, returned: window.length, hasMore: skip + window.length < rows.length, order },
        counts: { ...page.counts, total: rows.length },
        scope: { ...(page.scope ?? {}), verifyState, sourceHost, order },
      });
    }

    const artifact = Object.keys(ARTIFACTS).find((id) => address.includes(`/missions/${id}/artifact`));
    if (artifact !== undefined) {
      const held = ARTIFACTS[artifact];
      const query = new URLSearchParams(address.includes("?") ? address.slice(address.indexOf("?") + 1) : "");
      const asked = Number(query.get("version") ?? 0);
      if (asked > 0 && held.artifact?.version !== asked) {
        const older = (held.olderVersions ?? {})[asked];
        return ok(older === undefined
          ? { artifact: { kind: "empty-artifact", reason: "no-such-version" }, versions: held.versions }
          : { artifact: older, versions: held.versions });
      }
      return ok(held);
    }

    return ok(
      address.includes("/collect/status") ? STATUS
        : address.includes("/publish/episodes") ? { episodes: [], total: 0 }
        : address.includes("/publish/documents") ? { documents: [], total: 0 }
        : address.includes("/publish/schedule") ? SCHEDULE
        : address.includes("/publish/voices") ? { voices: [] }
        : address.includes("/publish/formats") ? { formats: [] }
        : address.includes("/version") ? VERSION
        : CONFIG,
    );
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
for (const name of ["ExploreTab", "PublishTab", "MissionsTab"]) {
  test(`${name} renders rather than throwing`, async () => {
    stubFetch();
    const { tree } = await render(name, { zh: true });
    assert.ok(tree, `${name} rendered nothing at all`);
    assert.ok(textOf(tree).length > 0, `${name} rendered no text`);
  });
}

// The 洞察 tab.
//
// It shipped for months as a placeholder, then as a list of claim cards from
// the batch pass, and the whole mission pipeline behind it — store, runtime,
// twelve stages, eleven routes — could land without a single check noticing
// that nothing on screen could start one. These call the tab and read what a
// person would read: what was asked, what it is doing, what it found, and —
// when it found nothing — what it tried.

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

/** The filter or tier chip whose label matches. */
function chip(tree, label) {
  const hit = find(tree, (node) => node.props?.role === "tab" && textOf(node).some((piece) => piece.includes(label)));
  assert.ok(hit, `no ${label} chip`);
  return hit;
}

/** The first button whose text contains `label`. */
function button(tree, label) {
  const hit = find(tree, (node) => node.type === "button" && textOf(node).some((piece) => piece.includes(label)));
  assert.ok(hit, `no button labelled ${label}`);
  return hit;
}

/**
 * The empty note's own words.
 *
 * Read from the note rather than from the page, because the list's state is
 * also printed in the toolbar above it: a page-wide search finds that copy and
 * passes even when the note itself says nothing, which leaves the empty state —
 * the only thing on screen — a bare sentence with no answer to "so what do I do
 * about it".
 */
function emptyNote(tree) {
  const hit = find(tree, (node) => node.key === "empty");
  assert.ok(hit, "nothing on the page says the list is empty");
  return textOf(hit).join(" ");
}

/** The card for one mission. */
function card(tree, topic) {
  const hit = find(tree, (node) => node.type === "article" && textOf(node).some((piece) => piece.includes(topic)));
  assert.ok(hit, `no card for "${topic}"`);
  return hit;
}

/** Open a mission from the list and settle. */
async function open(view, topic) {
  await view.act(() => { button(view.tree, topic).props.onClick(); });
  return textOf(view.tree).join(" ");
}

/**
 * Switch the open mission to one of its panes and return what is on screen.
 *
 * The detail is a tab strip rather than one scroll, so "the page shows X" is
 * now "the pane that owns X shows X". Asserting against the whole document
 * would pass on a strip that renders every pane at once, which is the bug this
 * split exists to prevent.
 */
async function pane(view, label) {
  await view.act(() => { button(view.tree, label).props.onClick(); });
  return textOf(view.tree).join(" ");
}

test("the tab offers a topic, a tier, and a way to start", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  // THE FORM IS BEHIND A CONTROL NOW, and pressing it is part of what this
  // test asserts rather than a step around it: the starter used to be a
  // permanently expanded card above every mission, so "there is somewhere to
  // type a topic" was true of a screen nobody could get past. What has to hold
  // is that ONE press reaches the whole form — the field, the three tiers and
  // the button — which is strictly more than the old assertion said.
  assert.ok(
    !find(view.tree, (node) => node.props?.["aria-label"] === "任务课题"),
    "the create form is on the screen before anyone asked for it, which is the expanded card again",
  );
  await view.act(() => { button(view.tree, "新建任务").props.onClick(); });
  const tree = view.tree;
  const text = textOf(tree).join(" ");
  assert.ok(find(tree, (node) => node.props?.["aria-label"] === "任务课题"), "nowhere to type a topic");
  for (const tier of ["快速", "标准", "深度"]) {
    assert.ok(text.includes(tier), `no ${tier} tier`);
  }
  assert.ok(text.includes("开始调研"), "no way to start a mission");
  // The numbers under a tier come from `/missions/budget-tiers`, not from a
  // copy in the bundle. Playground centralised its tier table and its frontend
  // still drifted from its backend, so the one number checked here is one the
  // stub served rather than one this file also knows.
  assert.ok(text.includes("120 次模型调用"), "the tier does not say what it may spend");
});

test("starting a mission sends the topic and the tier, then opens it", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await view.act(() => { button(view.tree, "新建任务").props.onClick(); });
  const box = find(view.tree, (node) => node.props?.["aria-label"] === "任务课题");
  await view.act(() => { box.props.onChange({ target: { value: "推理时序扩展的三条技术路线" } }); });
  await view.act(() => { button(view.tree, "开始调研").props.onClick(); });

  const create = posted.find((call) => call.url.endsWith("/missions/create"));
  assert.ok(create, "pressing start sent nothing: " + posted.map((call) => call.url).join(", "));
  assert.equal(create.body.topic, "推理时序扩展的三条技术路线");
  // The middle tier, chosen from the route's own `depths` rather than named in
  // the bundle: a form that submits a depth the server never heard of is a 400
  // the person cannot act on.
  assert.equal(create.body.depth, "standard");

  // And it opens onto the mission rather than back onto the list — a create
  // that answers 200 and leaves you where you were looks exactly like one that
  // did nothing.
  const text = textOf(view.tree).join(" ");
  // The TOPIC and the way back, not the stage words: the twelve-stage strip
  // that used to be the cheapest proof of "we are on the detail" was removed —
  // it drew the same twelve rows the task table draws, one column wider.
  assert.ok(text.includes("推理时序扩展的三条技术路线"), "starting did not open the mission it started");
  assert.ok(text.includes("任务"), "the detail has no way back to the list");
});

test("a mission row says how it ended and what it cost", async () => {
  stubFetch();
  const { tree } = await render("MissionsTab", { zh: true });
  const row = textOf(card(tree, RUNNING.topic)).join(" ");
  assert.ok(row.includes("运行中"), "the row does not say what state it is in");
  assert.ok(row.includes("标准"), "the row does not say which tier it is running at");
  assert.ok(row.includes("已核验 7 条"), "the row does not say how much verified evidence it has");
  assert.ok(row.includes("令牌"), "the row does not say what it has cost");

  // The failure, with its code beside it. The code is what makes a failure
  // countable across missions; the sentence is what makes this one actionable.
  const refused = textOf(card(tree, REFUSED.topic)).join(" ");
  assert.ok(refused.includes("未签署"), "a quality-failed mission is drawn as a plain failure");
  assert.ok(refused.includes("quality_refused"), "the failure code is not on the row");
  assert.ok(refused.includes("The report cites nothing."), "the failure sentence is not on the row");
});

test("a running mission says how far along it is, and a settled one does not", async () => {
  stubFetch();
  const { tree } = await render("MissionsTab", { zh: true });
  // THE LIST ROUTE CARRIES NO `progress`. `listMissions` attaches a verified
  // count and a spend sum to the raw row and nothing else, so the row's bar is
  // the ordinal of the stage it says it is on out of the twelve the catalogue
  // freezes — s3-collect is the third of twelve. Asserted through the aria
  // label, because a bar is the one thing on this row with no text in it.
  const bar = (topic) => find(card(tree, topic), (node) => node.props?.role === "progressbar");
  assert.ok(bar(RUNNING.topic), "a running row has no progress bar; it carried a spinner, a start stamp and no ratio anywhere");
  assert.equal(bar(RUNNING.topic).props["aria-valuenow"], 3, "the row's bar is not measuring the stage the row says it is on");
  assert.equal(bar(RUNNING.topic).props["aria-valuemax"], 12, "the row's bar divides by something other than the twelve the detail screen divides by");
  // AND THE FILL AGREES WITH WHAT IS ANNOUNCED. The width and the aria value
  // are two expressions, and a mutation that moved one and not the other left a
  // bar drawn a whole stage behind the figure a screen reader reads out — a
  // disagreement nothing on the page can show you.
  assert.equal(
    bar(RUNNING.topic).props.children.props.style.width, "25%",
    "the bar's fill and its announced value disagree; three of twelve is a quarter of the track",
  );
  // A settled mission's progress is its OUTCOME, which the pill states in a
  // word. A full bar under it reports the obvious; one frozen part-way under a
  // failure invites the reader to wait for it.
  assert.equal(bar(REFUSED.topic), null, "a mission that has ended is still drawing a progress bar");
});

test("the mission header states its four figures once each", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  const text = textOf(view.tree).join(" ");

  // NO TILE ROW, AND THAT IS THE ASSERTION. Four tinted boxes sat here
  // restating figures the same screen states elsewhere: tokens and elapsed are
  // the 成本 pane's whole subject, 已核验 is the 证据 count on the tab strip
  // eight pixels below, and 评分 renders a number an ungraded run never had.
  // They cost ~100px above a table, which is the one element here that gets
  // better with height.
  //
  // Written as an ABSENCE with the reason attached, because the tempting form
  // — deleting the test — leaves nothing to stop the row growing back.
  assert.ok(!text.includes("令牌 412k"), "the token tile is back on the header; the 成本 pane already owns that figure");
  assert.ok(!text.includes("评分 —"), "the score tile is back, stating a figure an ungraded run does not have");
  const spend = await pane(view, "成本");
  assert.ok(spend.includes("令牌") && spend.includes("412000 / 1500000"), "the figure moved off the header and is not on the pane that owns it either");
});

test("a row that says running with nothing running it says so", async () => {
  stubFetch();
  const { tree } = await render("MissionsTab", { zh: true });
  // One process, so a `running` row absent from `live` cannot have another
  // owner: it is a mission an exit left behind. Drawn identically to a live one
  // it is a clock that never moves and no explanation anywhere.
  const orphan = textOf(card(tree, ORPHAN.topic)).join(" ");
  assert.ok(orphan.includes("本进程没有在跑它"), "an orphaned row is indistinguishable from a live mission");
  const live = textOf(card(tree, RUNNING.topic)).join(" ");
  assert.ok(!live.includes("本进程没有在跑它"), "a live mission is reported as an orphan");
});

test("each chip lists a different set of missions", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  const listed = () => textOf(view.tree).join(" ");
  const press = async (label) => {
    await view.act(() => { chip(view.tree, label).props.onClick(); });
    return listed();
  };

  assert.ok(listed().includes(RUNNING.topic) && listed().includes(REFUSED.topic), "全部 is not showing everything");

  let text = await press("未签署");
  assert.ok(text.includes(REFUSED.topic), "未签署 lost the mission that was not signed");
  assert.ok(!text.includes(RUNNING.topic), "未签署 kept a running mission: the chip changed the URL and nothing else");

  text = await press("运行中");
  assert.ok(text.includes(RUNNING.topic), "运行中 lost the running mission");
  assert.ok(!text.includes(REFUSED.topic), "运行中 kept a terminal mission");

  text = await press("全部");
  assert.ok(text.includes(RUNNING.topic) && text.includes(REFUSED.topic), "going back to 全部 did not restore the list");
});

test("an empty chip and an empty list are different sentences", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await view.act(() => { chip(view.tree, "已取消").props.onClick(); });
  // A chip with nothing under it is a filter to undo, not a feature to fix.
  // Telling a person no mission has ever run while four sit one chip away sends
  // them to look at the wrong thing entirely.
  const note = emptyNote(view.tree);
  assert.ok(note.includes("这个筛选下没有任务"), "an empty chip does not say it is the chip that is empty");
  assert.ok(!note.includes("还没有跑过任何任务"), "an empty chip reports the whole list as empty");

  stubFetch({ missionPages: { "": { missions: [], total: 0, hasMore: false, counts: {}, live: [] } } });
  const cold = emptyNote((await render("MissionsTab", { zh: true })).tree);
  assert.ok(cold.includes("还没有跑过任何任务"), "an empty list does not say it is empty");
  assert.ok(cold.includes("开始调研"), "the empty state does not say what to do about it");
});

test("a failed read says what failed, where, and offers to do it again", async () => {
  // THE ONE THING NO SOURCE ASSERTION CAN MAKE. A guard can see that `onRetry`
  // is passed and that it nudges a counter; it cannot see whether anything
  // depends on that counter. A retry wired to a state nothing reads is
  // invisible in a diff and total on the screen — the button answers, the
  // spinner never comes back, and the person presses it again.
  stubFetch();
  const upstream = globalThis.fetch;
  let down = true;
  globalThis.fetch = async (url, init) => {
    if (down && String(url).includes("/missions/list")) throw new Error("connect ECONNREFUSED 127.0.0.1:3080");
    return upstream(url, init);
  };
  const view = await render("MissionsTab", { zh: true });
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("任务列表加载失败"), "a failed list read does not say that it failed");
  assert.ok(text.includes("connect ECONNREFUSED 127.0.0.1:3080"), "the reason the read failed is not on the screen");
  // The endpoint is what separates "the server said no" from "this build is
  // pointed at a host that is not there", which are two different afternoons.
  assert.ok(text.includes("/missions/list"), "nothing names the door that did not answer");

  down = false;
  await view.act(() => { button(view.tree, "重试").props.onClick(); });
  assert.ok(textOf(view.tree).join(" ").includes(RUNNING.topic), "the retry did not re-issue the read");
});

test("a slow first read draws the shape of what is coming, not a dashed box", async () => {
  stubFetch();
  // A read that never lands, which is the state the dashed box was the whole
  // answer to.
  globalThis.fetch = () => new Promise(() => {});
  const view = await render("MissionsTab", { zh: true });
  // THE WORD SURVIVES THE REDRAW, on the container. A pile of grey divs
  // announces nothing at all, and "加载中…" was the only thing a screen reader
  // ever got out of this state — losing it is a regression the page cannot
  // show, because the page looks better.
  const status = find(view.tree, (node) => node.props?.role === "status");
  assert.ok(status, "the loading screen has no accessible name");
  assert.equal(status.props["aria-label"], "加载中…", "the loading screen announces something other than loading");
  const blocks = findAll(view.tree, (node) => node.props?.className === "swm-skel");
  assert.ok(blocks.length >= 6, `${blocks.length} skeleton blocks is not the shape of three cards`);
  // Laid out in the grid the list itself uses, so nothing moves sideways at
  // the moment the answer lands.
  assert.match(String(status.props.style?.gridTemplateColumns), /minmax\(340px/, "the placeholder is not laid out in the grid it becomes");
});

test("opening a mission shows its twelve stages, its cost and its tail", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  const text = await open(view, RUNNING.topic);

  // THE TWELVE-WORD LOOP THAT STOOD HERE WAS NOT TESTING THIS SCREEN. It
  // asserted all twelve stage names appeared somewhere in the rendered text,
  // and this fixture's view carries no `stages` at all — so the words it found
  // were coming from the pane strip and the vocabulary tables, not from a
  // ruler reading the mission. It passed for the whole life of the strip and
  // would have passed with the strip drawing nothing.
  //
  // What the screen actually promises now is narrower and true: the task table
  // is the mission's list of work, and every stage the view DOES carry has a
  // row in it. Derived from the fixture rather than hardcoded, so the
  // assertion cannot outlive the data again.
  assert.ok(text.includes("任务"), "the task board is not the pane a mission opens onto");
  for (const stage of view.lastView?.stages ?? []) {
    const word = STAGE_WORDS[stage.stepId];
    if (word === undefined) continue;
    assert.ok(text.includes(word), `the task table has no row for ${stage.stepId}`);
  }
  const cost = await pane(view, "成本");
  assert.ok(cost.includes("令牌") && cost.includes("412000 / 1500000"), "the cost meters are not on the page");
  // Named, not summed. A mission at 100% of its arXiv allowance and 20% of its
  // tokens is about to start failing tool calls, and one blended percentage
  // would say it is fine right up until it stops working.
  assert.ok(cost.includes("最紧"), "nothing names the tightest ceiling");

  // A DIMENSION'S ARITHMETIC, ON THE TASK BOARD. The 证据 pane that used to
  // carry it was removed: its dimension cards restated the board's own columns
  // and its findings restated the trajectory and the report's citations. The
  // fraction moved with the rows it belongs to.
  //
  // WHAT WENT WITH THE PANE, said plainly rather than absorbed: the card's own
  // prose — 抓到 N 页, and the sentence separating "we could not fetch" from
  // "we fetched and found nothing" — is not drawn anywhere now. The verify
  // states themselves survive on the trajectory and under the report's
  // citations; the per-dimension summary of them does not.
  // The dimension's own fraction is now a chip on its task-board row. It is
  // guarded at the source in design-tokens.test.mjs — "a null floor is refused
  // a number wherever it is drawn" — against the board's own branches, rather
  // than here against a fixture whose board rows carry no counts.

  const trace = await pane(view, "轨迹");
  assert.ok(trace.includes("开始运行"), "the live tail is empty");
  // Leaving a pane and coming back is not a refetch and not a reset.
  assert.ok((await pane(view, "成本")).includes("最紧"), "the cost pane did not survive a round trip");
  // A running mission has nothing to read yet, and says which of the three
  // reasons it is: not yet, write failed, or ended without one.
  assert.ok(text.includes("报告还没有生成"), "does not say why there is no report");
});

test("a mission that verified nothing says what it tried", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  const text = await open(view, REFUSED.topic);

  assert.ok(text.includes("这次都试了什么"), "a mission that found nothing has no account of what it tried");
  // The evidence gate's own sentence, verbatim. Two wordings of one refusal is
  // the same defect as two names for one method.
  assert.ok(
    text.includes("'We looked and found nothing verifiable' is a useful answer"),
    "the gate's reason was re-worded or dropped",
  );
  // The diagnostics the runtime froze into the event precisely so this screen
  // is not blank: which tools ran, how many failed, and with what code.
  assert.ok(text.includes("fetch_page"), "does not say which tools were called");
  assert.ok(text.includes("rate_limited"), "does not say why a call failed");
  assert.ok(text.includes("not_admissible"), "only the first failure survived");
  // And it does not claim to show search terms, because the column holds a hash
  // of the arguments rather than the arguments.
  assert.ok(text.includes("没有记检索词本身"), "the page implies it could show the queries it cannot");

  // The dimension's own closing note, in the mission's language.
  // THE DIMENSION'S OWN ACCOUNT, on the references pane's by-dimension
  // arrangement. A dimension that read and verified nothing has no rows to
  // group under, so the arrangement renders its group anyway and prints the
  // dimension's summary — otherwise a mission that half-failed reads as a
  // mission that was half as ambitious.
  await pane(view, "参考文献");
  await view.act(() => { button(view.tree, "按维度").props.onClick(); });
  assert.ok(
    textOf(view.tree).join(" ").includes("这个维度读了 2 个页面，没有产出任何通过核验的引语。"),
    "the dimension's own account is missing",
  );
  // THE FAILURE IS NOT ON THE FACE OF THE PAGE. It was a tinted band across
  // the top of the one screen whose next element is a table — a glyph, a lead,
  // a next-step sentence and a 详情 toggle, three of whose four lines restate
  // the 失败 pill in the header. The pill became the door instead: the
  // diagnosis opens in a dialog, so the main window keeps the height and the
  // provider's own words are one press away rather than permanently resident.
  assert.ok(
    !text.includes("报告写出来了，但没有达到这次任务自己定的标准"),
    "the failure banner is back in the flow, above the table it pushes down",
  );
  assert.ok(!text.includes("quality_refused"), "the raw failure code is on the face of the page");
  const door = find(view.tree, (node) => typeof node.props?.["aria-label"] === "string"
    && node.props["aria-label"].startsWith("失败详情："));
  assert.ok(door, "the status pill is not a door, so a failed run states that it failed and offers no way to find out why");
  const opened = await view.act(() => { door.props.onClick(); })
    .then(() => textOf(view.tree).join(" "));
  assert.ok(
    opened.includes("报告写出来了，但没有达到这次任务自己定的标准"),
    "the dialog does not carry the reader's sentence",
  );
  // TWO PRESSES, ON PURPOSE. The dialog leads with the sentence a person can
  // act on; the runtime's own words sit behind 详情 inside it, where somebody
  // debugging a provider will look and nobody else has to.
  const inner = findAll(view.tree, (node) => node.type === "button"
    && Array.isArray(node.props?.children) === false
    && node.props?.children === "详情");
  assert.ok(inner.length > 0, "the dialog has no way to reach the runtime's own words");
  const raw = await view.act(() => { inner[inner.length - 1].props.onClick(); })
    .then(() => textOf(view.tree).join(" "));
  assert.ok(raw.includes("quality_refused"), "the runtime's own code never becomes reachable at all");

});

test("cancel, rerun and resume reach the route", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  await view.act(() => { button(view.tree, "中止").props.onClick(); });
  assert.ok(posted.some((call) => call.url.endsWith("/cancel")), "中止 sent nothing");
  assert.ok(
    textOf(view.tree).join(" ").includes("已中止，运行中的工作也停了。"),
    "cancel does not say whether the work actually stopped",
  );

  stubFetch();
  const second = await render("MissionsTab", { zh: true });
  await open(second, REFUSED.topic);
  const text = textOf(second.tree).join(" ");
  assert.ok(!text.includes("中止"), "a terminal mission still offers a cancel");
  assert.ok(text.includes("从检查点继续"), "a resumable mission does not offer a resume");

  // THE TWO RERUN MODES ARE BEHIND ONE VERB NOW. The header carried seven
  // controls beside a 16px title and the reference carries two, so 全新重跑 and
  // 增量重跑 — one verb with two modes — became one 重跑 menu. Found by
  // `aria-haspopup` rather than by its word, because the task board draws a
  // per-row 重跑 as well and `button()` takes the first match in the tree.
  const rerunMenu = find(second.tree, (node) => node.type === "button"
    && node.props?.["aria-haspopup"] === "menu"
    && textOf(node).some((piece) => piece.includes("重跑")));
  assert.ok(rerunMenu, "there is no way to reach a rerun at all");
  await second.act(() => { rerunMenu.props.onClick(); });
  await second.act(() => { button(second.tree, "全新重跑").props.onClick(); });
  const rerun = posted.find((call) => call.url.endsWith("/rerun"));
  assert.ok(rerun, "重跑 sent nothing");
  assert.equal(rerun.body.mode, "fresh");
  assert.ok(
    textOf(second.tree).join(" ").includes("上一次的结果一条也没删"),
    "a rerun does not say that the previous generation survives",
  );
});

test("the report opens with its evidence, and every quote can be followed", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  assert.ok(textOf(view.tree).join(" ").includes("报告"), "a finished mission offers no way to read what it wrote");
  await pane(view, "报告");

  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("三家实验室同期收敛到同一种做法"), "the report body did not render");
  // Per section type, never averaged: "this chapter cites nothing" has to stay
  // visible instead of disappearing into a healthy-looking overall ratio.
  assert.ok(text.includes("有据章节"), "the scorecard is not split by section type");
  // THE FRACTION IS THE TILE'S OWN FIGURE now, not the third clause of a
  // sentence inside a chip. Asserted apart from the label, which is strictly
  // stronger than `3/4 已核验` was: the old form passed as long as the string
  // was assembled and could not tell which section type the fraction belonged
  // to. The section words and the fractions are both checked, and the residual
  // line only names what is actually non-zero — a section where everything
  // held up printed 未通过 0，未检查 0，被反驳 0 before, three zeros that read
  // at a glance as three problems.
  assert.ok(text.includes("3/4"), "the scorecard does not say how much verified");
  assert.ok(text.includes("已核验引用"), "the scorecard has no whole-report total");
  assert.ok(!text.includes("未检查 0"), "a remainder of zero is still printed as if it were a problem");

  // THE QUOTE IS NOT IN THE REPORT ANY MORE, and that is the change rather
  // than a regression. The report used to end with every frozen quote listed
  // under a 证据 heading — a block the reference does not have, and which on
  // a well-verified mission is a full screen of identically green cards.
  // The quote is one hover away on each `[N]` in the prose, and the trace
  // pane still lists every finding with its own.
  assert.ok(!text.includes("证据") || !text.includes("收起"), "the 证据 block is back at the end of the report");
  const link = find(view.tree, (node) => node.type === "a" && node.props?.href === "https://deepmind.google/discover/scaling");
  assert.ok(link, "the quote does not link to the page it was verified against");
  // A CITATION WHOSE ADDRESS DID NOT SURVIVE IS STILL A ROW, and still says
  // so. The concern is unchanged and the place it is answered moved: it was
  // an evidence row that showed its quote and said it could not be opened,
  // and it is now the citation itself — plain text instead of a link, with
  // 无冻结证据 beside it. Dropping it would leave a report that cites a
  // number the bibliography does not list.
  assert.ok(
    text.includes("这条引用没有留下地址。") || text.includes("无冻结证据"),
    "a citation with no address or no frozen evidence is not shown as one",
  );
  // The sentence that said WHY belonged to the evidence row. The citation
  // row says it in its own words — the title stands as plain text where
  // every other row is a link, and the line above already asserts that.
});

test("an evidence row opens the reader on the whole source", async () => {
  stubFetch();
  const asked = [];
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  // FROM THE TRAJECTORY NOW. This drove the 证据 block at the end of the
  // report, and that block is gone — the reference has no such section, and
  // on a well-verified mission it was a screenful of identically green
  // cards. `onOpenSource` still reaches the reader from the trace pane, the
  // sources pane and the dimension drawer, and what this test is actually
  // about is unchanged: the reader RE-FETCHES rather than re-rendering the
  // five fields it already has, because only the page can answer whether it
  // still says what the quote says.
  await pane(view, "轨迹");
  await view.act(() => { button(view.tree, "三家实验室同期收敛到同一种推理时序扩展做法").props.onClick(); });

  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => { asked.push(String(url)); return inner(url, init); };
  await view.act(() => { button(view.tree, "在阅读器里打开").props.onClick(); });

  // Re-fetched and extracted rather than rendered from the evidence row's own
  // five fields: the question a reader has at this point is whether the page
  // still says what the quote says, and only the page can answer it.
  assert.ok(
    asked.some((url) => url.includes("/proxy/reader") && url.includes(encodeURIComponent("https://deepmind.google/discover/scaling"))),
    "the source was not fetched: " + asked.join(", "),
  );
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("Scaling test-time compute"), "the reader opened onto nothing");
  assert.ok(text.includes("we observe the same scaling behaviour at test time"), "the reader lost the quote it was opened for");
  // 返回任务, not 返回报告: the reader labels its way out by where it was
  // opened FROM, and this path now starts on the trajectory.
  assert.ok(text.includes("返回任务"), "there is no way back out of the reader");
});

test("a scorecard with nothing in it is not a clean bill", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, REFUSED.topic);
  await pane(view, "报告");
  const text = textOf(view.tree).join(" ");
  // `verified / total` at 0/0 is NaN or, worse, reads as "no failures" — the
  // exact figure the whole pipeline converges on, presenting a mission that
  // checked nothing as a mission that found nothing wrong.
  assert.ok(text.includes("一处引用都没有核验过"), "an empty scorecard is not called out");
  assert.ok(text.includes("这不是“没有发现问题”"), "an empty scorecard reads as a pass");
  assert.ok(text.includes("这一版是降级归档的"), "a degraded artefact does not say it is degraded");
  // THAT SENTENCE BELONGED TO THE 证据 BLOCK, which is gone. The thing it
  // guarded against — a run that verified nothing presented as a run that
  // found nothing wrong — is still guarded, twice, by the two assertions
  // above it: the scorecard says 一处引用都没有核验过 in its own words.
});

// The trajectory.
//
// The complaint these answer, in the user's words: the dimensions are
// completely unusable and invisible. A card said "已核验 6 · 1 个独立站点" and
// nothing on the screen could show one of those six — the claim, the quote, the
// source and the verify state were all in `mission_findings` the whole time.
// Every test below reads what a person reads: the steps in order, one of them
// opened, and a dimension's evidence in words rather than as a count.

/** The search box over the trajectory. */
function traceSearch(tree) {
  const hit = find(tree, (node) => node.props?.["aria-label"] === "搜索轨迹");
  assert.ok(hit, "no search box over the trajectory");
  return hit;
}

test("the trajectory is one dense row per step, whatever the step was", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  const text = await pane(view, "轨迹");

  // Four kinds in one ordered list. A tail that showed only events answered
  // "what is it doing" and never "why did that dimension come back empty".
  for (const chipLabel of ["阶段", "工具", "证据", "系统"]) {
    assert.ok(text.includes(chipLabel), `no ${chipLabel} row in the trajectory`);
  }
  // The call, and the arguments it was made with. `args_text` exists precisely
  // because "eighty-six searches found nothing" was unanswerable without them.
  assert.ok(text.includes("web.search"), "the tool call is not named");
  assert.ok(text.includes("test-time compute scaling laws"), "the arguments the call was made with are not shown");
  assert.ok(text.includes("rate_limited"), "a failed call does not say what it failed with");
  // The arrow was the character "→" until the icon set landed; it is now
  // ICON_PATHS.arrowRight, drawn at the same optical weight as every other
  // glyph instead of at whatever weight the row's font happened to render.
  // The GUARANTEE is unchanged — there is a mark between input and output —
  // so this asserts the path rather than deleting the assertion.
  // ON THE PATH, NOT ON THE PROP, AND NOT ON THE TEXT.
  //
  // Three layers have to line up here and only one of them is obvious. The
  // arrow is `Icon name:"arrowRight"`; this harness CALLS function components,
  // so `Icon` has already run by the time the tree is walked and the `name`
  // prop does not survive into it — what survives is the `<path d=…>` it
  // returned. And that path sits inside an `aria-hidden` svg, which `textOf`
  // now skips, as a screen reader does. So neither the old text assertion nor
  // the obvious prop assertion can see it.
  //
  // The guarantee is unchanged: a mark stands between what went in and what
  // came out.
  assert.ok(
    findAll(view.tree, (node) => typeof node.props?.d === "string" && node.props.d.startsWith("M5 12h14")).length > 0,
    "there is no arrow between what went in and what came out",
  );
  // A stage id and an event type are vocabulary this page has words for.
  assert.ok(text.includes("规划"), "a stage row prints its raw step id");
  assert.ok(text.includes("开始运行"), "an event row prints its raw type");
  // The read is bounded and says how far it got against how much there is.
  assert.ok(text.includes("显示 7 / 7 条"), "the trajectory does not say how much of itself it is showing");
});

test("clicking a row opens a panel beside the list, and the list stays put", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  await pane(view, "轨迹");
  await view.act(() => { button(view.tree, "web.search").props.onClick(); });

  const text = textOf(view.tree).join(" ");
  // Master-detail IN PLACE: the row that was clicked is still in the list
  // beside the panel, and so is every other row.
  assert.ok(text.includes("三家实验室同期收敛到同一种推理时序扩展做法"), "opening a row replaced the list instead of appearing beside it");
  assert.ok(text.includes("tool:2026-08-24T09:13:00.000Z#0"), "the panel does not say which row it is showing");
  // Keyed on the ref, and the panel says so: `seq` is a position in a snapshot
  // over bounded windows, and a panel reopened against the wrong row is the
  // most expensive kind of wrong because it is plausible.
  assert.ok(text.includes("不是身份"), "the panel presents a snapshot position as an identity");

  await view.act(() => { chip(view.tree, "载荷").props.onClick(); });
  const payload = textOf(view.tree).join(" ");
  // The row is clipped to 200 characters for display; the panel is the only
  // place the rest of the arguments exists, which is the whole reason it opens.
  assert.ok(payload.includes("recency"), "the payload tab shows only the clipped arguments the row already had");
  // Which layer cut the string. Without this a reader goes looking for a rest
  // that was never stored.
  assert.ok(payload.includes("参数在写入时就截到 300 个字符"), "the payload tab does not say where the cap came from");

  await view.act(() => { chip(view.tree, "结果").props.onClick(); });
  assert.ok(
    textOf(view.tree).join(" ").includes("records the verdict of a call, not its body"),
    "the result tab pretends the ledger holds the page it fetched",
  );

  await view.act(() => { chip(view.tree, "计时").props.onClick(); });
  const timing = textOf(view.tree).join(" ");
  assert.ok(timing.includes("820ms"), "a sub-second latency was rounded away to nothing");
  // A tool call's start is derived — the row is written when the call returns —
  // and a computed instant presented as a recorded one is a measurement nobody
  // promised.
  assert.ok(timing.includes("is derived rather than recorded"), "the timing tab does not say where its numbers came from");
});

test("a finding opens onto the whole quote, with the state in words", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  const listed = await pane(view, "轨迹");
  // The row clips the quote; that is the display bound, and the whole point of
  // the panel is that the clipped half is reachable.
  assert.ok(!listed.includes("across all three model families"), "the fixture does not clip, so nothing is being proved");

  await view.act(() => { button(view.tree, "三家实验室同期收敛到同一种推理时序扩展做法").props.onClick(); });
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("across all three model families"), "the verbatim quote is still truncated in the one place it can be read whole");
  // The enum spelled out. `verified-source-text` is a column value, not an
  // answer a person can act on.
  assert.ok(text.includes("已核验"), "the verify state is shown as the raw enum");
  assert.ok(text.includes("越过了证据边界"), "the panel does not say whether this finding counts");
  assert.ok(text.includes("Scaling test-time compute"), "the panel does not name the source");
  assert.ok(text.includes("在阅读器里打开"), "there is no way to follow the quote to its page");
  const link = find(view.tree, (node) => node.type === "a" && node.props?.href === "https://deepmind.google/discover/scaling");
  assert.ok(link, "the panel does not link to the page the quote was verified against");
});

test("the panes are the set playground settled on, in its order", async () => {
  // Taken rather than re-derived. gens.team runs the same object through
  // 任务列表 · 协作动态 · 输出报告 · 参考文献 · 图谱分析 · 算力消耗, and the two
  // this codebase had folded into an "overview" — the task board and the
  // spend — are exactly the two that made the overview a drawer.
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  const labels = paneLabels(view.tree);
  assert.deepEqual(
    labels.map((label) => label.replace(/[0-9]/g, "")),
    ["任务", "轨迹", "报告", "参考文献", "成本"],
    "the tab strip drifted from playground's set",
  );

  // The report is IN the frame. It used to replace the whole screen, so
  // leaving the report meant leaving the mission, and the evidence behind a
  // sentence was two navigations from the sentence.
  const report = await pane(view, "报告");
  assert.ok(report.includes("轨迹"), "opening the report unmounted the tab strip around it");
  // Exactly, not as a substring: the detail's own "← 返回任务列表" contains it.
  assert.ok(
    findAll(view.tree, (node) => textOf(node).join("").replace(/^button/, "") === "← 返回任务").length === 0,
    "a pane offers a back button to a screen it never left",
  );
  // And back out in one click, from inside the report.
  assert.ok(paneLabels(view.tree).length === 5, "the strip did not survive the report");
});

test("the report tab never leaves the strip, and a stale pane falls back", async () => {
  // The strip used to drop 报告 whenever there was no artefact behind it, which
  // reads as a feature this mission does not have rather than as a report it has
  // not written yet — and it made the strip a different shape per mission, so
  // `pane` could hold a value the strip no longer offered.
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  const labels = paneLabels(view.tree).map((label) => label.replace(/[0-9]/g, ""));
  assert.ok(labels.includes("轨迹"), "the fixture never rendered a tab strip");
  assert.ok(labels.includes("报告"), "a mission that has written nothing has no tab to say so on");
  const text = await pane(view, "报告");
  assert.ok(text.includes("还没有生成报告"), "the report tab opens onto a blank pane");

  // A pane the strip does not offer must not be a blank body under a strip with
  // nothing pressed on it.
  stubFetch();
  const stale = await render("MissionDetail", {
    missionId: RUNNING.id, zh: true, onBack: () => {}, initialPane: "图谱分析",
  });
  assert.ok(
    textOf(stale.tree).join(" ").includes("负责人"),
    "a pane value the strip does not offer renders nothing at all",
  );
});

test("the task board shows the work, not only the pipeline that ran it", async () => {
  // The defect this closes: `view.work` was projected, tested, and had NO
  // READER. The board painted the twelve pipeline stages — the scaffolding —
  // while the decisions somebody actually made (a dimension planned, a
  // re-collect the Leader called for, with the sentence they wrote about it)
  // sat one field away and were drawn by nothing.
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  const tasks = await open(view, RUNNING.topic);
  assert.ok(tasks.includes("规划"), "the pipeline rows are gone");
  assert.ok(tasks.includes("维度"), "a planned dimension is not a row on the board");
  assert.ok(tasks.includes("领队要求重采"), "the Leader's re-collect decision is not a row on the board");
  // The Leader's own words about THAT dimension, not the mission-level
  // rationale repeated under every child.
  assert.ok(tasks.includes("这个维度只拿到一个站点"), "a re-collect row does not say why it was called for");
  assert.ok(tasks.includes("已核验 1/3"), "a dimension row does not say how it stands against its floor");
});

test("a board on a host that has not shipped work yet is still a board", async () => {
  // Rolling updates: the browser half is newer than the machine that owns the
  // library. A blank rectangle is indistinguishable from a component that threw.
  stubFetch({ views: { [RUNNING.id]: { ...LIVE_VIEW, work: [] } } });
  const view = await render("MissionsTab", { zh: true });
  const tasks = await open(view, RUNNING.topic);
  assert.ok(tasks.includes("规划") && tasks.includes("采集"), "the board fell back to nothing");
});

test("the report opens and closes with the leader's own words", async () => {
  // THE ONE PIECE OF WRITING ABOUT THE REPORT WAS NOT ON THE REPORT. s11
  // writes the foreword against the mission's own criteria — what was
  // answered, what is still open, how to read this, what to do next — and it
  // was reachable only by opening one stage's drawer. panels/ReportPanel.tsx
  // opens with 执行摘要 and closes with 结论与建议, and that is the same text.
  stubFetch();
  const view = await render("MissionReport", { missionId: SIGNED.id, zh: true, onBack: null });
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("执行摘要"), "the report does not open with the summary band");
  assert.ok(text.includes("结论与建议"), "the report does not close with the conclusions band");
  assert.ok(text.includes("这是一份证据审计后的阶段性底稿"), "the summary band is empty of the leader's reading guidance");
  assert.ok(text.includes("向规划局"), "the closing band drops the follow-up, which is the half a reader acts on");
  // AND THE VERDICT PER CRITERION KEEPS ITS MIDDLE VALUE. `partial` is not a
  // pass and not a failure; a report that renders it as either is lying about
  // what the leader signed.
  assert.ok(text.includes("部分回答"), "a partially answered criterion is not shown as partial");
});

test("the leader's foreword renders its parts, not the object it arrives in", async () => {
  // s11 WRITES A STRUCTURED FOREWORD. FOREWORD_SCHEMA requires
  // `whatWeAnswered`, `whatRemainsUnclear` and `howToRead`, and shapeSignoff
  // keeps the field only when `typeof === "object"`. MissionJudgement passed
  // it WHOLE as `children`.
  //
  // React refuses that: "Objects are not valid as a React child" is a THROW,
  // not a warning. Every mission whose leader signed off crashed its own s11
  // drawer — and nothing here noticed, because no test had ever mounted this
  // block and the harness built its tree by hand without React's check.
  //
  // Both halves are fixed: the shim refuses what React refuses, and this
  // mounts the block that was never mounted.
  stubFetch();
  const view = await render("MissionJudgement", { missionId: SIGNED.id, zh: true, only: "s11-signoff" });
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("这是一份证据审计后的阶段性底稿"), "the foreword's reading guidance is not on the page");
  assert.ok(text.includes("园区的法定边界"), "the foreword does not say what remains unclear");
  assert.ok(text.includes("向规划局"), "the foreword does not carry its recommended follow-up, which is the half a reader acts on");
});

test("the panes are separate screens, not one scroll with headings", async () => {
  // The reason the trajectory went unnoticed for a whole release: it was the
  // last panel of a page that opened on a stage strip, five cost meters and
  // five dimension cards. A strip that renders every pane at once would pass
  // every other test in this file and reproduce exactly that.
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  const tasks = await open(view, RUNNING.topic);
  // One row per stage, with the owner, the model and the state beside it.
  //
  // THE REFERENCE'S COLUMNS, checked against board/MissionTodoBoard.tsx
  // rather than against what we happened to ship: w-10 #, 任务名称,
  // 负责人, 模型, 状态, 操作. It has no 用时 — a duration belongs to a
  // stage and is already on that stage's row in the timeline — and this
  // test used to require the one column the reference does not have while
  // saying nothing about the one it does.
  for (const column of ["任务名称", "负责人", "模型", "状态"]) {
    assert.ok(tasks.includes(column), `the task board has no ${column} column`);
  }
  assert.ok(tasks.includes("看轨迹 →"), "a stage row does not open onto its trajectory");
  assert.ok(!tasks.includes("显示 7 / 7 条"), "the trajectory is rendered under the task board");
  assert.ok(!tasks.includes("已核验 5/3 条"), "the evidence is rendered under the task board");
  assert.ok(!tasks.includes("最紧"), "the spend is rendered under the task board");

  const refs = await pane(view, "参考文献");
  assert.ok(!refs.includes("最紧"), "the spend is still on screen behind the references");
  assert.ok(!refs.includes("显示 7 / 7 条"), "the trajectory is still on screen behind the references");

  const trace = await pane(view, "轨迹");
  assert.ok(trace.includes("显示 7 / 7 条"), "the trajectory pane is empty");
  // "立项" is in the trajectory too — it is a value in the stage filter.
  assert.ok(!trace.includes("看轨迹 →"), "the task board is still on screen behind the trajectory");

  // Per agent, not one total. "76 of 120 calls" is true of a mission that
  // worked and of one where a researcher burned forty turns re-searching.
  const cost = await pane(view, "成本");
  assert.ok(cost.includes("谁花的"), "the spend is a total with nobody attached to it");
});

test("the kind chips and the search change the list under them", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  await pane(view, "轨迹");

  await view.act(() => { chip(view.tree, "发现").props.onClick(); });
  let text = textOf(view.tree).join(" ");
  assert.ok(text.includes("三家实验室同期收敛到同一种推理时序扩展做法"), "发现 lost the finding");
  assert.ok(!text.includes("test-time compute scaling laws"), "发现 kept the tool calls: the chip changed the URL and nothing else");

  await view.act(() => { chip(view.tree, "全部记录").props.onClick(); });
  await view.act(() => { traceSearch(view.tree).props.onChange({ target: { value: "arxiv" } }); });
  text = textOf(view.tree).join(" ");
  assert.ok(text.includes("arxiv.org/abs/2401.00001"), "the search lost the row it should have matched");
  assert.ok(!text.includes("test-time compute scaling laws"), "the search matched everything");

  await view.act(() => { traceSearch(view.tree).props.onChange({ target: { value: "没有这种东西" } }); });
  // "0" and "0 of 6" are different sentences: one says the mission did nothing,
  // the other says this filter matches nothing.
  assert.ok(
    textOf(view.tree).join(" ").includes("轨迹里一共有 7 条"),
    "an empty filter reads as an empty mission",
  );
});

test("a row outside the window says so, and a saturated read says so too", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, REFUSED.topic);
  const text = await pane(view, "轨迹");
  // The window is the honest answer to "is this the whole history". A mission
  // that stops at the thousandth event looks exactly like one that stopped
  // working.
  assert.ok(text.includes("已经读到窗口上限"), "a trajectory that hit its ceiling reports as a complete one");

  // The dimension → finding path that stood here belonged to the 证据 pane and
  // went with it. Reaching a finding's detail from the trajectory is the same
  // panel and is covered by the trajectory tests above; what this test is named
  // for — a bounded read says so — is asserted before this point.

});

test("the trajectory reads in English too, every string paired", async () => {
  // Every other test on this tab runs in Chinese, which means the English half
  // of every `zh ? … : …` pair on the newest region of this file had never been
  // executed by anything. A pair whose second arm throws is a blank panel for
  // exactly the readers who cannot read the first arm.
  stubFetch();
  const view = await render("MissionsTab", { zh: false });
  await view.act(() => { button(view.tree, RUNNING.topic).props.onClick(); });
  await pane(view, "Trajectory");
  let text = textOf(view.tree).join(" ");
  for (const piece of ["All rows", "Findings", "TOOL", "EVIDENCE", "web.search", "showing 7 of 7", "Mission started"]) {
    assert.ok(text.includes(piece), `the English trajectory is missing ${piece}`);
  }

  await view.act(() => { button(view.tree, "web.search").props.onClick(); });
  text = textOf(view.tree).join(" ");
  for (const piece of ["Summary", "Payload", "Result", "Timing", "✓ Passed", "a position in this snapshot"]) {
    assert.ok(text.includes(piece), `the English detail panel is missing ${piece}`);
  }
});

test("an empty trajectory and an empty filter are different sentences", async () => {
  // The distinction the mission list already makes for its chips, one level
  // down. "0" answers two different questions with the same character: the
  // mission has done nothing yet, and this filter selects none of what it did.
  // A reader who cannot tell them apart either waits for a mission that is
  // finished or clears a filter that was never set.
  stubFetch({ traces: { [ORPHAN.id]: EMPTY_TRACE } });
  const view = await render("MissionsTab", { zh: true });
  await open(view, ORPHAN.topic);
  const nothing = await pane(view, "轨迹");
  assert.ok(nothing.includes("这个任务还没有留下任何轨迹"), "a mission with no trajectory does not say so");
  assert.ok(!nothing.includes("轨迹里一共有"), "an empty mission is reported as a filter that matched nothing");
  // And it does not invent a ceiling it never reached: every window in this
  // fixture is unsaturated, so the honest-bounds line has nothing to say.
  assert.ok(!nothing.includes("已经读到窗口上限"), "an unsaturated read claims it hit its window");

  // The other sentence, on a mission that DOES have a trajectory, so the two
  // are proved distinct rather than merely present.
  const other = await render("MissionsTab", { zh: true });
  await open(other, RUNNING.topic);
  await pane(other, "轨迹");
  await other.act(() => { traceSearch(other.tree).props.onChange({ target: { value: "没有这种东西" } }); });
  const filtered = textOf(other.tree).join(" ");
  assert.ok(filtered.includes("轨迹里一共有 7 条"), "a filter that matches nothing does not say what it filtered");
  assert.ok(!filtered.includes("还没有留下任何轨迹"), "a filter that matched nothing is reported as a mission that did nothing");
});

test("both empty states read in English as well", async () => {
  // The English arm of a `zh ? … : …` pair that no test has ever executed is
  // a blank line for exactly the readers who cannot read the other arm, and
  // these two arms sit on the branch a reader reaches when there is nothing
  // else on the screen to correct them.
  stubFetch({ traces: { [ORPHAN.id]: EMPTY_TRACE } });
  const view = await render("MissionsTab", { zh: false });
  await open(view, ORPHAN.topic);
  const nothing = await pane(view, "Trajectory");
  assert.ok(nothing.includes("has not recorded a trajectory yet"), "the English empty mission says nothing");

  const other = await render("MissionsTab", { zh: false });
  await open(other, RUNNING.topic);
  await pane(other, "Trajectory");
  await other.act(() => {
    find(other.tree, (node) => node.props?.["aria-label"] === "Search the trajectory").props.onChange({ target: { value: "nothing like this" } });
  });
  assert.ok(
    textOf(other.tree).join(" ").includes("the trajectory holds 7 row(s)"),
    "the English empty filter does not say what it filtered",
  );
});

test("a trajectory still being read is not a trajectory that came back empty", async () => {
  // The third state, and the one that is wrong on a working mission: between
  // the first paint and the route's answer, `page` is null and `rows` is [],
  // which is the same shape as a mission that has recorded nothing. On a slow
  // or wedged read that is a screen telling you a running mission has done
  // nothing — a claim the page has not checked and cannot make.
  stubFetch();
  const inner = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const address = String(url);
    // Only the list route hangs. Everything else on the tab answers, so what
    // is under test is this one pending read rather than a dead page.
    if (address.includes("/trace")) return new Promise(() => {});
    return inner(url, init);
  };
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  const text = await pane(view, "轨迹");
  assert.ok(
    !text.includes("这个任务还没有留下任何轨迹"),
    "a read that has not come back yet is reported as a mission that recorded nothing",
  );
  assert.ok(text.includes("正在读取轨迹"), "a pending read says nothing at all while it is pending");
  // And it must not report a total it has not been told.
  assert.ok(!text.includes("显示 0 / 0 条"), "a pending read prints a count it does not have");
});

// ── the report's citations ──────────────────────────────────────────────────
//
// Eleven numbered markers in the prose and nothing anywhere saying what [7] was.
// Both halves of the answer were stored on the artefact the whole time —
// `citations` carries the index and the finding, `evidence` carries that
// finding's title, quote and fetch stamp — so the list below is a join, not a
// derivation.

test("a citation marker is a control, and the report ends in a reference list", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  await pane(view, "报告");

  assert.equal(findAll(view.tree, (node) => node.props?.id === "ref-1").length, 1, "the reference list has no entry for [1]");
  assert.equal(findAll(view.tree, (node) => node.props?.id === "ref-2").length, 1, "the reference list has no entry for [2]");

  const marks = findAll(view.tree, (node) => node.type === "button" && textOf(node).includes("[1]"))
    .concat(findAll(view.tree, (node) => node.type === "button" && textOf(node).includes("[2]")));
  assert.equal(marks.length, 2, "the markers in the prose are still two inert characters");

  const text = textOf(view.tree).join(" ");
  // A real title, a real quote and a real host — not the column of bare
  // addresses a list built from `citations` alone would be.
  assert.ok(text.includes("Scaling test-time compute"), "the reference names no source");
  // 文中, AND I HAD IT RIGHT BEFORE I CHANGED IT. The two components word
  // this differently: panels/ReferencesPanel.tsx (the 参考文献 tab) says
  // `引用 N 处`, artifact/ReferencePanel.tsx (the list at the end of a
  // report) says `文中 N 处`. This slot is the second one. I moved it to 引用
  // citing the wrong file, which is the same error as building the whole
  // row from that file.
  assert.ok(text.includes("文中 1 处"), "the list does not say how often the prose leans on a source");
  // THE STRIP THE BIBLIOGRAPHY NEVER HAD. Four figures it already knew — how
  // many references, over how many hosts, how many verified, how many carry a
  // quote — and the pane opened straight onto row [1], so the one question a
  // reader brings to a reference list could only be answered by counting chips
  // down the column. `有引语` and `个站点` are asserted rather than `引用` and
  // `已核验`, which appear in the meta line above and would pass with the
  // whole strip deleted.
  // 有引语 WAS A TILE ON A STRIP THIS SLOT DOES NOT HAVE, and the quote it
  // counted is not gone: it is one hover away on every `[N]` in the prose,
  // which is where artifact/ReferencePanel.tsx leaves it too. What the row
  // must still carry is the site and how often the prose leans on it.
  assert.ok(text.includes("文中 1 处"), "the reference list does not say how often the prose leans on a source");
  assert.ok(text.includes("个站点"), "the reference list does not say how many distinct sites it rests on");
  assert.ok(text.includes("这条引用没有留下地址"), "a citation whose address did not survive is dropped");

  // The marker with nothing behind it: greyed, and saying why.
  const orphan = find(view.tree, (node) => node.type === "sup");
  assert.ok(orphan, "a marker with no citation behind it is drawn as a working one");
  assert.ok(String(orphan.props.title).includes("引用元数据缺失"), "the orphan marker does not say what is missing");
});

test("a degraded version says which of the two things went wrong", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, REFUSED.topic);
  const text = await pane(view, "报告");

  assert.ok(text.includes("这一版是降级归档的"), "a degraded artefact does not say it is degraded");
  // The either/or sentence is gone. Both halves are answerable and both were on
  // disk: the guard's violations ride on the terminal event and the refusal is
  // s11's own signature.
  assert.ok(!text.includes("要么内容闸门有违规"), "the report still guesses at its own degrade reason");
  assert.ok(text.includes("内容闸门拦下 2 处"), "the guard's violations are not counted");
  assert.ok(text.includes("全文一处引用都没有"), "a guard code is printed instead of what it means");
  assert.ok(text.includes("拒绝签署，评分 31"), "the refusal and the score it was refused at are missing");
  assert.ok(text.includes("失败在采集"), "the leader's accountability note was dropped");
});

// ── the references pane ─────────────────────────────────────────────────────

test("参考文献 is one row per page read, not one per finding", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  const text = await pane(view, "参考文献");

  // FOUR TILES, not one clause. The totals were 14 条发现 · 3 个来源 ·
  // 3 个站点 · 已核验 9 条 — the four figures a reader comes to this pane for,
  // dot-joined into a 12px grey sentence — and each is now a labelled tile.
  // Asserted one at a time, which is strictly stronger than the joined
  // substring was: the old form passed as long as the sentence was built, and
  // could not tell which of the four numbers a label had come unstuck from.
  for (const pair of ["发现 14", "来源 3", "站点 3", "已核验 11"]) {
    assert.ok(text.includes(pair), `the references totals do not label ${pair}`);
  }
  // The page cited six times is ONE row. Counted over the whole tree, because
  // the failure this pane exists to prevent is the same address six times over.
  const rendered = textOf(view.tree).join("\u0000");
  assert.equal(
    rendered.split("https://kanatanorthba.com/about/").length - 1, 1,
    "the six-times-cited page is listed more than once",
  );
  assert.ok(text.includes("About the Kanata North business association"), "a source is listed as a bare address");
  // ONE CHIP, ONE RATIO. The two chips this replaces — `6 条发现` and
  // `已核验 4 条` — were a denominator and a numerator drawn as separate
  // objects, and the assertion could pass with the reader still doing the
  // division. The reference's own status cell carries its score inside the
  // chip (已完成 · 78/100) and so does this one.
  assert.ok(text.includes("已核验 4/6"), "a source does not say how much of what rests on it held up, as a ratio");
  assert.ok(!text.includes("6 条发现"), "the denominator is drawn a second time as a chip of its own");
  assert.ok(text.includes("推理时序扩展的训练侧做法"), "a source does not say which dimension it fed");

  // FOUR ARRANGEMENTS, ALL NAMED AT ONCE. The old control was a two-state
  // toggle whose label was always the arrangement you were NOT looking at —
  // 按站点分组 while flat, 按引用次数排 while grouped — which is the one
  // control shape that cannot be read without pressing it.
  for (const arrangement of ["按引用", "按站点", "按核验率", "按首次读到"]) {
    assert.ok(text.includes(arrangement), `the sources pane cannot be arranged ${arrangement}`);
  }
  await view.act(() => { button(view.tree, "按站点").props.onClick(); });
  const grouped = textOf(view.tree).join(" ");
  // The host, the page count and the finding count were one `·`-joined mono
  // line. Asserted apart, for the same reason as the scorecard above.
  assert.ok(grouped.includes("kanatanorthba.com"), "grouping by host does not group");
  assert.ok(grouped.includes("1 页"), "a host group does not say how many pages it holds");
  assert.ok(grouped.includes("6 条发现"), "a host group does not say how much it carried");
});

test("a references pane that cannot load says so rather than looking empty", async () => {
  stubFetch();
  const inner = globalThis.fetch;
  // A read that failed and a mission that read nothing are the same empty list
  // and opposite problems.
  globalThis.fetch = async (url, init) => (String(url).includes("/sources")
    ? { ok: false, json: async () => ({ success: false, error: "the sources query itself failed" }) }
    : inner(url, init));

  const zh = await render("MissionSources", { missionId: SIGNED.id, zh: true });
  assert.ok(textOf(zh.tree).join(" ").includes("读不到这次任务的来源清单"), "a failed read draws as an empty pane");
  const en = await render("MissionSources", { missionId: SIGNED.id, zh: false });
  assert.ok(textOf(en.tree).join(" ").includes("Could not read this mission's sources"), "the failed read has no English arm");
});

test("a degrade note with nothing behind it does not invent a reason", async () => {
  for (const zh of [true, false]) {
    // An older Host half sends no reason at all. Printing the either/or sentence
    // back would be this page claiming to know something it was not told.
    const none = await render("MissionDegradeNote", { reason: null, zh });
    assert.ok(
      textOf(none.tree).join(" ").includes(zh ? "较旧的版本" : "older build"),
      "a missing reason is presented as a known one",
    );

    const unsigned = await render("MissionDegradeNote", {
      zh, reason: { signed: null, guardViolations: [], guardMessage: null, failureCode: null },
    });
    assert.ok(
      textOf(unsigned.tree).join(" ").includes(zh ? "签署阶段没有跑到" : "sign-off stage was never reached"),
      "never signed and refused are drawn as the same thing",
    );

    // Flagged degraded with nothing recorded against it: that is a defect, and
    // saying so beats an empty warning box.
    const bare2 = await render("MissionDegradeNote", {
      zh, reason: { signed: true, guardViolations: [], guardMessage: "", failureCode: null },
    });
    assert.ok(
      textOf(bare2.tree).join(" ").includes(zh ? "没有留下任何原因" : "no reason was recorded"),
      "a degrade flag with no reason renders an empty box",
    );
  }
});

test("a finished pane with nothing in it is a final answer, not a wait", async () => {
  for (const zh of [true, false]) {
    const done = await render("MissionEmptyPane", {
      zh, mission: { terminal: true, failureCode: null, errorMessage: "" },
      waiting: zh ? "还在等" : "still waiting",
      finished: zh ? "结束了，这里什么也没有" : "it ended with nothing here",
    });
    assert.ok(
      textOf(done.tree).join(" ").includes(zh ? "结束了，这里什么也没有" : "it ended with nothing here"),
      "a finished run is told to keep waiting",
    );
  }
});

test("the strip is five panes, and 证据 is not one of them", async () => {
  const { tree } = await render("MissionDetailTabs", {
    pane: "tasks", setPane: () => {}, zh: true,
    findings: 14, steps: 169, stages: 12,
    // THE PROJECTION, NOT A SENTENCE. The strip used to be handed a finished
    // string; it is handed `cost` itself now, because the component that
    // knows how much room the figures have is the one that should format
    // them. A fixture still passing the old prop renders no metrics at all —
    // which is correct behaviour and a silent test.
    cost: { tokens: { used: 412000, ceiling: 1500000, ratio: 412000 / 1500000 }, calls: { used: 24 }, byTool: [] },
  });
  assert.equal(findAll(tree, (node) => node.type === "button").length, 5, "the strip is not five panes");
  const text = textOf(tree).join(" ");
  assert.ok(text.includes("参考文献"), "the references pane is not on the strip");
  // THE PANE THAT WENT. Its dimension cards restated the task board's own
  // columns and its findings restated the trajectory and the report's frozen
  // citations; the one axis it alone carried — which dimension a page was read
  // for — is an arrangement on 参考文献 now. Asserted as an ABSENCE so the tab
  // cannot come back without this saying so.
  assert.ok(!text.includes("证据"), "the 证据 pane is back, and with it a third place to read the same finding");
  // THE WORD MOVED INTO THE GLYPH'S TITLE. The strip carries a metric cluster
  // now — a mark, the figure, and its share of the ceiling — so "令牌 412k" as
  // one run of text is the old sentence, not the new absence. What must stay
  // true is that the figure is ON the strip.
  assert.ok(text.includes("412k"), "the spend is not on the tab row");
});

test("a pane with nothing in it says which nothing", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  assert.ok(
    (await pane(view, "参考文献")).includes("还没有读到任何一页"),
    "an empty references pane is a blank rectangle",
  );

  const board = await render("MissionTaskBoard", { stages: [], agents: [], zh: true });
  const waiting = textOf(board.tree).join(" ");
  assert.ok(waiting.includes("暂无任务"), "an empty task board renders literally nothing");
  assert.ok(waiting.includes("等 Leader"), "an empty task board does not say what it is waiting for");

  const dead = await render("MissionTaskBoard", {
    stages: [], agents: [], zh: true,
    mission: { terminal: true, failureCode: "budget_exhausted", errorMessage: "calls reached 40 of 40" },
  });
  const failed = textOf(dead.tree).join(" ");
  assert.ok(failed.includes("预算用完了"), "a board empty because the run died says nothing about the death");
  assert.ok(failed.includes("calls reached 40 of 40"), "the runtime's own sentence was dropped");
  assert.ok(failed.includes("在成本页看是哪一项先见底"), "a failure with no next action is a dead end");

  const done = await render("MissionTaskBoard", {
    stages: [], agents: [], zh: true,
    mission: { terminal: true, failureCode: null, errorMessage: "" },
  });
  assert.ok(
    textOf(done.tree).join(" ").includes("暂无任何一条阶段记录"),
    "a finished run with an empty board reads as one that has not started",
  );
});

test("the create form waits behind a control, and closes the way it opened", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  assert.ok(
    !find(view.tree, (node) => node.props?.role === "dialog"),
    "the dialog is open before anyone asked for it, which is the expanded card with a scrim over it",
  );
  await view.act(() => { button(view.tree, "新建任务").props.onClick(); });
  const dialog = find(view.tree, (node) => node.props?.role === "dialog");
  assert.ok(dialog, "新建任务 opened nothing");
  assert.equal(dialog.props["aria-modal"], "true", "the dialog does not announce itself as one, so a screen reader keeps walking the list behind it");
  assert.equal(dialog.props["aria-label"], "新建任务", "the dialog has no accessible name");
  await view.act(() => { button(view.tree, "关闭").props.onClick(); });
  assert.ok(
    !find(view.tree, (node) => node.props?.role === "dialog"),
    "the dialog's own close control does not close it",
  );
});

test("the header, the ruler and the strip stay put; only the pane body scrolls", async () => {
  stubFetch();
  const view = await render("MissionDetail", { missionId: SIGNED.id, zh: true, onBack: () => {} });

  // ONE SCROLLER, WHICH IS WHAT THE NAME SAYS. What this test is named for is
  // unchanged: the header band, the tiles, the twelve-stage ruler
  // and the tab strip are outside both boxes, and the page as a whole still
  // does not scroll.
  //
  // The team rail this paragraph used to describe is gone: it took 320px of a
  // screen whose panes are tables, and who is on a mission is answered by the
  // roster on the cost pane and by the role chips on every row.
  const scrollers = findAll(view.tree, (node) => node.props?.style?.overflowY === "auto");
  assert.equal(scrollers.length, 1, `the mission detail has ${scrollers.length} scrollers`);
  assert.notEqual(scrollers[0], view.tree, "the whole page scrolls, header and all");

  // The twelve-stage ruler that stood above the panes is gone: it drew the same
  // twelve rows the task table draws, with less in each. What this test is
  // named for — the header band stays put, only the pane body scrolls — is
  // unchanged and is asserted above.
  //
  // The figures moved with it. `令牌` and `评分` were tiles pinned over every
  // pane; they belong to the pane that is about spending, and this is where
  // they are now.
  const spend = await pane(view, "成本");
  assert.ok(spend.includes("令牌"), "the cost pane does not carry what has been spent");
  assert.ok(spend.includes("412000 / 1500000"), "the spend figure lost the ceiling it runs against");
});

test("the download follows the version on screen", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  // THE FOUR EXPORTS ARE BEHIND ONE 导出 CONTROL NOW, so reaching one is two
  // presses rather than one. What this test is about did not change: the row
  // it opens is still a real `<a download>` against the same GET, and its href
  // and its filename still have to follow the version on screen. The helper
  // opens the menu, reads the markdown row, and shuts it again so the next
  // call starts from the same state.
  const anchor = async () => {
    const trigger = find(view.tree, (node) => node.type === "button"
      && node.props?.["aria-haspopup"] === "menu"
      && textOf(node).some((piece) => piece.includes("导出")));
    assert.ok(trigger, "there is no way to reach the exports at all");
    await view.act(() => { trigger.props.onClick(); });
    const hit = find(view.tree, (node) => node.type === "a" && typeof node.props?.download === "string");
    assert.ok(hit, "the export menu opened onto nothing a browser can save");
    const props = hit.props;
    await view.act(() => { trigger.props.onClick(); });
    return props;
  };

  const newest = await anchor();
  assert.ok(!newest.href.includes("version="), "the newest report is asked for by number");
  assert.ok(newest.download.endsWith("-v2.md"), "the filename does not say which version it is");

  await pane(view, "报告");
  await view.act(() => { chip(view.tree, "第 1 版").props.onClick(); });
  assert.ok(
    textOf(view.tree).join(" ").includes("第一版只写了三百字"),
    "the version picker did not change the document on screen",
  );
  // A reader looking at v1 who presses 下载 and receives v3 has been handed a
  // different document than the one on their screen.
  const older = await anchor();
  assert.ok(older.href.includes("version=1"), "the download still points at the newest version");
  assert.ok(older.download.endsWith("-v1.md"), "the filename does not follow the version on screen");
});

// ── the trajectory's filters ────────────────────────────────────────────────

test("the trajectory filters on what the rows carry, and on who did it", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  await pane(view, "轨迹");

  const dimensionSelect = find(view.tree, (node) => node.props?.["aria-label"] === "按维度筛选");
  const offered = dimensionSelect.props.children.filter((child) => child !== null && child.props?.value !== "");
  // Five were planned; three ever reached a row. The select was built from the
  // plan, so two of its five options could not match anything and nothing on
  // the screen said which two.
  assert.equal(offered.length, 3, "the dimension filter still offers options that match nothing");
  assert.ok(
    textOf(dimensionSelect).some((piece) => piece.includes("1 条")),
    "an option that matches one row does not say so",
  );

  const asked = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => { asked.push(String(url)); return inner(url, init); };
  const agentSelect = find(view.tree, (node) => node.props?.["aria-label"] === "按执行者筛选");
  assert.ok(agentSelect, "there is no way to see only what one agent did");
  await view.act(() => { agentSelect.props.onChange({ target: { value: "leader" } }); });

  assert.ok(asked.some((url) => url.includes("agentId=leader")), "the agent filter never reached the route: " + asked.join(" "));
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("规划"), "filtering to the leader lost the leader's own stage rows");
  assert.ok(!text.includes("test-time compute scaling laws"), "the agent filter changed the URL and nothing else");
});

// ── the cost pane ───────────────────────────────────────────────────────────

test("the cost pane says which stage ate it and which tool is failing", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  const text = await pane(view, "成本");

  // Found by the id it carries rather than by the words on it: the ruler above
  // the strip prints the same step ids in its own tooltips.
  const stage = find(view.tree, (node) => node.props?.title === "s3-collect · researcher");
  assert.ok(stage, "the per-stage breakdown is not rendered");
  assert.ok(
    textOf(stage).includes("未记账 · 51 次调用"),
    "a stage with fifty-one calls and no tokens is drawn as a stage that ran for free",
  );
  assert.ok(text.includes("这不等于没花钱"), "the gap in the ledger is not explained");

  assert.ok(text.includes("fetch_page"), "the per-tool table is not rendered");
  assert.ok(text.includes("成功率"), "the tool table does not say how often a tool works");
  assert.ok(text.includes("56%"), "the tool table does not compute a success rate");
  assert.ok(text.includes("820ms"), "a measured tool does not print its latency");
  assert.ok(text.includes("未测量"), "a tool nobody timed is given an average of zero");
});

test("a big number is shortened without being made smaller", () => {
  const { missionCompact } = exportsOf();
  assert.equal(missionCompact(412000), "412k");
  assert.equal(missionCompact(1480000), "1.5M");
  assert.equal(missionCompact(24), "24");
  // THE TWO-UNIT JUMP ACROSS TWO TOKENS. `Math.round(n / 1000)` made these
  // `1k` and `2k`, in the figure a person compares two runs with.
  assert.equal(missionCompact(1499), "1.5k");
  assert.equal(missionCompact(1501), "1.5k");
  // Not "0". A missing number and a zero are different facts about a ledger.
  assert.equal(missionCompact(undefined), "—");
});

test("everything added here reads in English too", async () => {
  stubFetch();
  const view = await render("MissionDetail", { missionId: SIGNED.id, zh: false, onBack: () => {} });
  const at = async (label) => {
    await view.act(() => { button(view.tree, label).props.onClick(); });
    return textOf(view.tree).join(" ");
  };

  const references = await at("References");
  for (const pair of ["Findings 14", "Sources 3", "Hosts 3", "Verified 11"]) {
    assert.ok(references.includes(pair), `the references totals have no English arm for ${pair}`);
  }
  for (const arrangement of ["By citations", "By host", "By verified rate", "By first read"]) {
    assert.ok(references.includes(arrangement), `the grouping control has no English arm for ${arrangement}`);
  }
  assert.ok(references.includes("verified 5/5"), "the verified ratio has no English arm");

  const report = await at("Report");
  assert.ok(report.includes("References"), "the reference list has no English heading");
  assert.ok(report.includes("cited 1× in the text"), "the in-text count has no English arm");
  assert.ok(report.includes("No address was stored for this citation."), "the address-less entry has no English arm");

  // THE EVIDENCE CONTROLS WENT WITH THE 证据 PANE. Its filters — verify state,
  // host, order, paging — were the dimension findings list's, and that list was
  // deleted with the pane. The English arms that remain to check on this screen
  // are the references pane's own, asserted above.
  //
  // The arrangement control is the one new set of words the merge introduced,
  // so it is swept here rather than left to the Chinese-only path.
  const refs = await at("References");
  for (const word of ["By citations", "By host", "By dimension", "By verified rate", "By first read"]) {
    assert.ok(refs.includes(word), `the ${word} arrangement has no English arm`);
  }

  const cost = await at("Cost");
  assert.ok(cost.includes("not billed"), "未记账 has no English arm");
  assert.ok(cost.includes("not measured"), "未测量 has no English arm");
  assert.ok(cost.includes("Mean latency"), "the tool table has no English header");

  stubFetch();
  const refused = await render("MissionReport", { missionId: REFUSED.id, zh: false, onBack: null });
  const degraded = textOf(refused.tree).join(" ");
  assert.ok(degraded.includes("The content guard raised 2:"), "the degrade note has no English arm");
  assert.ok(degraded.includes("declined to sign it, at 31"), "the refusal has no English arm");
  assert.ok(degraded.includes("Nothing in the report is cited"), "the guard codes have no English arm");

  stubFetch();
  const running = await render("MissionDetail", { missionId: RUNNING.id, zh: false, onBack: () => {} });
  await running.act(() => { button(running.tree, "Report").props.onClick(); });
  assert.ok(textOf(running.tree).join(" ").includes("No report yet"), "the empty report pane has no English arm");
  await running.act(() => { button(running.tree, "References").props.onClick(); });
  assert.ok(textOf(running.tree).join(" ").includes("Nothing has been read yet"), "the empty references pane has no English arm");

  const empty = await render("MissionTaskBoard", { stages: [], agents: [], zh: false });
  assert.ok(textOf(empty.tree).join(" ").includes("No tasks yet"), "the empty task board has no English arm");

  // The structural addition that survived: a dialog nothing on this tab could
  // reach before. The team rail that stood beside it was removed — 320px of a
  // table-shaped screen spent on a cast list.

  const list = await render("MissionsTab", { zh: false });
  await list.act(() => { button(list.tree, "New mission").props.onClick(); });
  const dialog = textOf(find(list.tree, (node) => node.props?.role === "dialog")).join(" ");
  assert.ok(dialog.includes("New mission"), "the dialog has no English title");
  assert.ok(dialog.includes("the tier is what it may spend"), "the dialog's note has no English arm");
  assert.ok(dialog.includes("Close"), "the dialog's close control has no English arm");
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

// ── who did it, and what kind of step it was ─────────────────────────────────
//
// These four screens printed an agent id as body text and a stage's mode not at
// all. What makes them worth a RENDER test rather than another source test is
// the shape of the change: `RoleChip` lives in the primitives region and reads
// MISSION_AGENT_FACES and `missionFace`, both declared three thousand lines
// below it. That is legal — a function body is evaluated when it is called —
// and it is also one rename away from the `exact is not defined` blank page
// this file was written after. A source test cannot tell the two apart. Calling
// the component can.

test("every screen that knows who did the work says so in colour", async () => {
  const stage = {
    stepId: "s3-collect", ordinal: 2, mode: "fan-out", status: "done", attempts: 1,
    startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:05:00Z",
    durationMs: 300000, tokens: 1200, degradeNote: null,
  };

  // The roster. `agentId` is the minted instance, so the chip has to split the
  // role off the dimension slug rather than looking the whole string up.
  const roster = await render("MissionAgentTable", {
    zh: true,
    agents: [
      { agentId: "researcher:regulatory-landscape", role: "researcher", lastStepId: "s3-collect", state: "done", calls: 4, tokens: 900, toolCalls: 6, toolFailures: 1, toolCached: 2 },
      { agentId: null, role: "verifier", lastStepId: null, state: "pending", calls: 0, tokens: 0, toolCalls: 0, toolFailures: 0, toolCached: 0 },
    ],
  });
  const rosterText = textOf(roster.tree).join(" ");
  assert.ok(rosterText.includes("研究员"), "the roster still prints a raw agent id instead of the role's word");
  // AS ITS OWN NODE, not merely somewhere in the text. The first draft of
  // this assertion asked whether the string appeared anywhere in the tree,
  // and a mutation that deleted the suffix span entirely still passed it —
  // the raw id survives in the chip's `title`, which `textOf` walks. A guard
  // that a tooltip can satisfy is not guarding what it says it is.
  assert.ok(
    findAll(roster.tree, (node) => node.props?.children === "regulatory-landscape").length > 0,
    "the dimension a researcher was minted for was dropped rather than ellipsised beside the role",
  );
  assert.ok(rosterText.includes("核验员"), "an agent that has not run yet loses its row: `agentId` is null until it does, and `role` is what the planner named it");

  // The stage detail. Its Owner row is the one value in that panel that is a
  // person, and `line()` stringifies what it is handed — passing a chip through
  // it renders "[object Object]", which is why there is a second row helper.
  const detail = await render("MissionStageDetail", {
    zh: true, stage, onClose: () => {}, onOpenStage: () => {},
    owner: { agentId: "researcher:supply-chain", role: "researcher" },
  });
  const detailText = textOf(detail.tree).join(" ");
  assert.ok(detailText.includes("研究员"), "the stage detail's 负责人 row is still a raw id in the grey the figures beside it use");
  assert.ok(!detailText.includes("[object Object]"), "a chip was passed to `line()`, which calls String() on its value — the row renders [object Object]");
  // The mode badge earns its space here: s3-collect is 采集 and its mode is
  // fan-out, so the badge says something the stage's own name does not.
  assert.ok(detailText.includes("并行分发"), "the stage's declared mode is still drawn nowhere, on the panel that shows everything else about it");

  // And the suppression. s6-synthesize IS 综合, so a mode badge there would
  // print the stage's name twice in two shapes.
  const same = await render("MissionStageDetail", {
    zh: true, onClose: () => {}, onOpenStage: () => {}, owner: null,
    stage: { ...stage, stepId: "s6-synthesize", mode: "synthesize" },
  });
  const sameText = textOf(same.tree).join(" ");
  assert.equal(
    sameText.split("综合").length - 1,
    1,
    "the mode badge repeats the stage's own name; six of the twelve stages are named after their mode and this is what suppression is for",
  );

  // The trajectory row: the densest screen in the tab, where the agent used to
  // reach the DOM only inside a `title` attribute.
  const row = await render("MissionTraceRow", {
    zh: true, active: false, onOpen: () => {},
    row: {
      ref: "tool:9", seq: 9, at: "2026-01-01T00:02:00Z", kind: "tool", role: "TOOL",
      title: "web", detail: "q=…", result: "3 hits", ok: true, ms: 820,
      agentId: "researcher:regulatory-landscape",
    },
  });
  const marks = findAll(row.tree, (node) => node.props?.className === "swt-tagslot");
  assert.equal(marks.length, 1, "the trajectory row lost its tag slot");
  assert.ok(
    findAll(marks[0], (node) => typeof node.props?.d === "string").length > 0,
    "the tag slot holds no glyph, so the row still cannot say who took the step without a hover",
  );
});

test("a signature is a verdict card, not the third grey sentence in a row", async () => {
  stubFetch();
  const view = await render("MissionDetail", { missionId: SIGNED.id, zh: true, onBack: () => {} });
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("领队已签署"), "the sign-off sentence is gone from the detail header");
  assert.ok(text.includes("（sign）"), "the leader's own verdict word is dropped, and it appears nowhere else on the screen");
  assert.ok(text.includes("/100"), "the score has no scale beside it, so 82 is 82 out of nothing");
  // The figure, and NOT a second copy of it inside the sentence beside it.
  assert.ok(
    !text.includes("领队已签署，评分"),
    "the score is in the sentence AND in the card's own figure: the same number twice in one row is the reader checking whether they are the same number",
  );
});

test("the leader's brief is on the screen the work is judged on", async () => {
  stubFetch();
  const view = await render("MissionDetail", { missionId: SIGNED.id, zh: true, onBack: () => {} });
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("立项目标"), "the goals panel is not mounted; `goals` is projected onto every mission and read by nothing");
  // Both value shapes, because the block iterates rather than naming keys: an
  // array is a list and a sentence is a sentence.
  assert.ok(text.includes("许可证会不会收紧"), "an array-valued goal renders as `a,b` or not at all");
  assert.ok(text.includes("一份可引用的报告"), "a string-valued goal is dropped");
  assert.ok(text.includes("核心问题"), "the Leader's own key is translated away or hidden, so a key it adds tomorrow appears as nothing");
});

test("a run with no rework says so, and a cache hit is not a failure", async () => {
  stubFetch();
  const view = await render("MissionDetail", { missionId: SIGNED.id, zh: true, onBack: () => {} });
  await view.act(() => { button(view.tree, "成本").props.onClick(); });
  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("返工"), "the rework panel is gone and the five counters are back inside a dot-joined sentence");
  assert.ok(text.includes("工具失败"), "the tool-failure counter is not drawn as a counter");
  assert.ok(text.includes("命中缓存"), "the cache-hit counter is not drawn at all");
  assert.ok(
    !text.includes("其中花在返工上的："),
    "the joined waste sentence survived beside the grid, so the same figures are on the pane twice",
  );
});

test("the stage drawer says what the step did, and how far into the run it did it", async () => {
  stubFetch();
  const drawer = await render("MissionStageDetail", {
    zh: true, missionId: RUNNING.id, anchor: "2026-08-24T09:00:00.000Z",
    onClose: () => {}, onOpenStage: () => {},
    owner: { agentId: "researcher:d1", role: "researcher" },
    stage: {
      stepId: "s3-collect", ordinal: 3, status: "running", attempts: 1,
      startedAt: "2026-08-24T09:13:00.000Z", endedAt: null, durationMs: 90000,
      tokens: 412000, calls: 11, mode: "fan-out", agent: "researcher", degradeNote: null, stalled: false,
    },
  });
  const text = textOf(drawer.tree).join(" ");
  // The two figures the drawer never had: `calls` reached no pixel at all, and
  // the token count was a nine-character figure in a key/value row.
  assert.ok(text.includes("模型调用"), "the drawer still cannot say how many model calls a step took");
  assert.ok(text.includes("11"), "the calls figure is dropped on the way to the chip");
  assert.ok(text.includes("412k"), "the drawer prints the raw token count where every other screen prints the short form");
  // The step's own trajectory, through the trajectory's own row renderer.
  assert.ok(text.includes("这一步做了什么"), "the drawer lists properties and no process");
  assert.ok(text.includes("web.search"), "the step's own rows were fetched and not rendered");
  // And the offset, which is what a stage timing is actually asked for.
  //
  // ON THE ROW ITSELF, not anywhere in the tree. Asking whether the offset
  // appears at all passed with the 开始 row reverted to a bare wall clock: the
  // step's own trajectory rows are in the same drawer and they carry the same
  // \`+13 分 0 秒\`, so the assertion was being satisfied by a different element
  // than the one it names.
  const started = find(drawer.tree, (node) => node.key === "开始");
  assert.ok(started, "the drawer lost its 开始 row");
  assert.ok(
    textOf(started).join(" ").includes("+13 分"),
    "the drawer's timings are absolute wall-clock only, so \"how far into the run did this step start\" is subtraction done by hand",
  );
});

test("a dimension opens into a drawer, and the drawer carries what the pane cannot", async () => {
  // THE HALF OF THE 证据 PANE THAT HAD NO SECOND HOME. Its counts were the
  // task board's columns and its quotes were the trajectory's and the
  // report's, so the pane went — but a dimension's RATIONALE, and the findings
  // read for it, were nowhere else. They are a press away now instead of a
  // pane away, and the list they open over does not move while you read.
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  await pane(view, "参考文献");
  await view.act(() => { button(view.tree, "按维度").props.onClick(); });

  const heads = findAll(view.tree, (node) => node.type === "button"
    && typeof node.props?.["aria-label"] === "string"
    && node.props["aria-label"].startsWith("打开维度："));
  assert.ok(heads.length > 0, "a dimension heading is not a control, so there is no way into its findings");

  const before = textOf(view.tree).join(" ");
  await view.act(() => { heads[0].props.onClick(); });
  const opened = textOf(view.tree).join(" ");
  assert.ok(opened.length > before.length, "pressing a dimension opened nothing");
  assert.ok(opened.includes("三家实验室同期收敛"), "the drawer does not carry the dimension's findings");
  assert.ok(opened.includes("we observe the same scaling behaviour"), "the drawer drops the quote, which is what a claim is checked against");

  // A DRAWER, NOT AN EXPANSION: the rows it opened over are still there, in
  // place. An inline expansion pushes every row below it down the page, so the
  // thing being compared against moves while it is read.
  assert.ok(opened.includes("参考文献"), "the pane under the drawer went away, so this is a screen change rather than a drawer");

  const close = findAll(view.tree, (node) => node.props?.["aria-label"] === "关闭");
  assert.ok(close.length > 0, "the drawer has no way out of itself");
  await view.act(() => { close[close.length - 1].props.onClick(); });
  assert.ok(
    !textOf(view.tree).join(" ").includes("we observe the same scaling behaviour"),
    "the drawer will not close",
  );
});

test("a dimension row on the task board opens, the way a stage row does", async () => {
  // THE ROW ANSWERED THE POINTER BY DOING NOTHING. Every row on this board
  // calls `onSelect` with its own key, but the drawer resolved that key against
  // STAGE rows only — a dimension's key is its node id, `dimension:d1`, which
  // is not a `stepId`. So a click set the selection, found no stage and opened
  // nothing. A row that is pressable and answers with nothing reads as a dead
  // table, not as a feature nobody built.
  //
  // Asserted through the ROW rather than through a handler, because the defect
  // was entirely in the resolution between the two.
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, RUNNING.topic);
  const before = textOf(view.tree).join(" ");

  const rows = findAll(view.tree, (node) => node.type === "tr" && typeof node.props?.onClick === "function");
  const target = rows.find((node) => textOf(node).join(" ").includes("推理时序扩展的复现情况"));
  assert.ok(target, "the dimension row is not on the board at all");

  await view.act(() => { target.props.onClick(); });
  const opened = textOf(view.tree).join(" ");
  assert.ok(opened.length > before.length, "clicking a dimension row opened nothing");
  assert.ok(opened.includes("三家实验室同期收敛"), "the drawer does not carry the dimension's findings");

  // THE SAME DRAWER THE REFERENCES PANE OPENS. A stage and a dimension are
  // different rows and different answers, but two drawers for one board is how
  // the two come to disagree about what a finding looks like.
  assert.ok(opened.includes("we observe the same scaling behaviour"), "the quote a claim is checked against is missing");

  const close = findAll(view.tree, (node) => node.props?.["aria-label"] === "关闭");
  assert.ok(close.length > 0, "the drawer has no way out");
  await view.act(() => { close[close.length - 1].props.onClick(); });
  assert.ok(
    !textOf(view.tree).join(" ").includes("we observe the same scaling behaviour"),
    "the drawer will not close",
  );
});

test("an empty dimension says WHICH empty it is", async () => {
  // THE SENTENCE THAT SHIPPED WRONG. The drawer picked its empty text with a
  // two-way ternary on `pending`, so a dimension being collected RIGHT NOW
  // read as "collection finished and produced no finding" — we looked and
  // there was nothing — while s3 had simply not reached it. On a mission at
  // stage 2 of 12 that is every dimension on the board, and the drawer is the
  // one screen that could have said so.
  //
  // Five states, five answers. A drawer with nothing in it is only useful if
  // it says why there is nothing.
  const dimension = (state) => ({
    dimensionId: "d9", name: "空的维度", rationale: "为什么要看这一面", facet: "technical",
    state, attempt: 1, grade: null, gradeAxes: { pagesFetched: 4, uniqueHosts: 2 },
    summary: null, failureCode: null,
  });
  for (const [state, want, notWant] of [
    ["pending", "还没轮到", "采集跑完了"],
    ["collecting", "正在采集", "采集跑完了"],
    ["failed", "采集失败", "还没轮到"],
    ["collected", "采集跑完了", "还没轮到"],
  ]) {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ success: true, data: { findings: [], dimension: dimension(state), counts: { verified: 0 } } }),
    });
    const drawer = await render("MissionDimensionDrawer", {
      missionId: "m1", dimension: { id: "d9", name: "空的维度" }, runCount: 1, zh: true,
      onClose: () => {},
    });
    const text = textOf(drawer.tree).join(" ");
    assert.ok(text.includes(want), `a ${state} dimension does not say "${want}"`);
    assert.ok(!text.includes(notWant), `a ${state} dimension also says "${notWant}", which is a different answer`);
    // WHAT IT DID DO, when it did anything: four pages fetched and nothing
    // verified is a different answer from four pages never fetched, and the
    // drawer used to be silent about both.
    //
    // IT IS A TILE NOW, AND THAT IS THE POINT OF THE MOVE. This sentence lived
    // inside the empty branch, so what a dimension had READ left the screen the
    // moment it found something. The tile is drawn in every state, which is why
    // the assertion is on the label and the figure rather than on the prose.
    assert.ok(text.includes("抓取页数"), `a ${state} dimension hides what it actually read`);
    assert.ok(text.includes("4"), `a ${state} dimension draws the page-count tile without the count in it`);
    // The state belongs in the header too, or an empty drawer is a title over
    // a sentence with nothing tying them together.
    assert.ok(
      text.includes(state === "pending" ? "待采集" : state === "collecting" ? "采集中" : state === "failed" ? "失败" : "已采集"),
      `a ${state} dimension does not carry its state as a chip`,
    );
  }
});

test("a reference says what the library holds on it, and says plainly when the library holds nothing", async () => {
  // THREE STATES ON ONE PANE. Two are values the join returned; the third is
  // the one this pane must not paper over, because a mission reads the open web
  // and most of what it reads was never collected.
  const payload = {
    missionId: SIGNED.id, runCount: 1, scope: { dimensionId: null },
    sources: [
      {
        url: "https://arxiv.org/abs/2401.00002", host: "arxiv.org", title: "Replication at two smaller sizes",
        findings: 3, verified: 3, dimensionIds: ["d1"], verifyStates: { "verified-source-text": 3 },
        firstSeenAt: "2026-08-22T09:31:00.000Z", library: { type: "PAPER", quality: 9.2 },
      },
      {
        url: "https://example.org/collected", host: "example.org", title: "收录过但从未打分的一份材料",
        findings: 2, verified: 1, dimensionIds: ["d1"], verifyStates: { "verified-source-text": 1, unverifiable: 1 },
        firstSeenAt: "2026-08-22T09:32:00.000Z", library: { type: "BLOG", quality: null },
      },
      {
        url: "https://example.org/never", host: "example.org", title: "从未被收录的一份材料",
        findings: 1, verified: 0, dimensionIds: ["d1"], verifyStates: { unverifiable: 1 },
        firstSeenAt: "2026-08-22T09:33:00.000Z", library: null,
      },
    ],
    totals: { sources: 3, hosts: 2, findings: 6, verified: 4 },
    runs: [{ runCount: 1, total: 6, verified: 4, dimensions: 1 }],
    dimensions: [{ dimensionId: "d1", name: "推理时序扩展的训练侧做法" }],
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: payload }) });

  const zh = textOf((await render("MissionSources", { missionId: SIGNED.id, zh: true })).tree).join(" ");
  assert.ok(zh.includes("论文"), "a collected paper is not typed on the row, so a preprint and a press release read the same");
  assert.ok(zh.includes("质量 9.2"), "the library's own score for a page it holds is not drawn, though the join returned it");
  assert.ok(zh.includes("未评分"), "a page the library holds but never scored says nothing, so 'nobody scored it' cannot be told from 'nobody looked'");
  assert.ok(zh.includes("不在信源库"), "a page the library has never collected is drawn exactly like one it holds");
  assert.ok(!zh.includes("质量 0"), "an unscored page was given a figure — 0 here is not 'lowest quality', it is 'never graded'");

  const en = textOf((await render("MissionSources", { missionId: SIGNED.id, zh: false })).tree).join(" ");
  assert.ok(en.includes("Papers") && en.includes("quality 9.2"), "the type and the score have no English arm");
  assert.ok(en.includes("not in the library"), "the honest third state has no English arm, so it is the one sentence half the readers cannot be told");

  // AND A HOST HALF THAT PREDATES THE JOIN SAYS NOTHING AT ALL. This file's own
  // SOURCES fixture carries no `library` key, and answering an absent field
  // with 不在信源库 would state a lookup nobody performed, on every row of the
  // pane whose whole subject is what was actually read.
  stubFetch();
  const older = textOf((await render("MissionSources", { missionId: SIGNED.id, zh: true })).tree).join(" ");
  assert.ok(older.includes("About the Kanata North business association"), "the older payload stopped rendering rows at all");
  assert.ok(!older.includes("不在信源库"), "a payload that never carried the field is reported as a library miss on every row");
});

test("the token meter says which kind of token it was", async () => {
  // THE FIGURE WAS ON THE WIRE AND ON NO SCREEN. `projectCost` has returned
  // `tokensBreakdown` since it was written; nothing in lib/client.js read it.
  // So the bar summed prompt, completion and cache-read and drew one length —
  // and a run that burned nine tenths of its ceiling re-reading a cached
  // prompt was the same picture as one that burned it writing. Same bar, two
  // different bills, two different things to do about it.
  const cost = {
    ...costOf({ tokens: 1240000, calls: 24 }),
    tokensBreakdown: { promptTok: 260000, completionTok: 84000, cacheReadTok: 896000 },
  };
  const view = await render("MissionCostMeters", { cost, zh: true });

  // IN THE TOKENS CELL, not merely somewhere on the pane. Asserting against
  // the whole tree passes on a split rendered under every one of the six,
  // which is the arrangement that says arXiv requests have a prompt half.
  const cell = find(view.tree, (node) => node.key === "tokens");
  assert.ok(cell, "the tokens meter is not on the pane at all");
  const inside = textOf(cell).join(" ");
  assert.ok(inside.includes("提示") && inside.includes("260k"), "the prompt half of the bill is not under the bar that charges for it");
  assert.ok(inside.includes("生成") && inside.includes("84k"), "what this run WROTE is folded back into the total it was split out of");
  assert.ok(inside.includes("缓存读取") && inside.includes("896k"), "the cache reads are invisible, so the meter cannot say the ceiling went on re-reading rather than on work");

  const calls = find(view.tree, (node) => node.key === "calls");
  assert.ok(calls, "the calls meter is gone from the pane");
  assert.ok(
    !textOf(calls).join(" ").includes("缓存读取"),
    "a ceiling that counts one thing is drawn with a split under it, which says model calls have a cached half",
  );
});

test("a ledger with no split says so instead of inventing three noughts", async () => {
  // AN OLDER HOST HALF SERVES THE METER WITHOUT THE BREAKDOWN, and `?? 0`
  // there would print 提示 0 · 生成 0 · 缓存读取 0 under a bar reading 412k —
  // a fabricated zero, and one that reads as "this run wrote nothing", which
  // is a claim the screen has not checked.
  const stale = { ...costOf({ tokens: 412000, calls: 24 }) };
  delete stale.tokensBreakdown;
  const view = await render("MissionCostMeters", { cost: stale, zh: true });
  const cell = find(view.tree, (node) => node.key === "tokens");
  const inside = textOf(cell).join(" ");
  assert.ok(inside.includes("412000"), "the meter itself stopped saying what the run spent");
  assert.ok(!inside.includes("缓存读取"), "a breakdown the ledger never sent is drawn anyway, as noughts nobody counted");
  assert.ok(inside.includes("没有分项"), "the gap is silent, so a missing split looks exactly like a split that is all zero");

  // AND NOTHING TO SPLIT IS NOT A GAP. A mission that has spent nothing yet
  // does not need a sentence about a breakdown it could not have; the meter
  // above already reads 0.
  const fresh = { ...costOf({ tokens: 0, calls: 0 }) };
  delete fresh.tokensBreakdown;
  const early = await render("MissionCostMeters", { cost: fresh, zh: true });
  assert.ok(
    !textOf(early.tree).join(" ").includes("没有分项"),
    "a mission that has spent nothing is told its ledger carries no split, which is chrome about an absence that is not one",
  );
});

test("a dimension jumps to what it actually searched for", async () => {
  // THE HALF THE DRAWER WAS MISSING. It says what a dimension FOUND, and the
  // question every reader arrives with when it found one thing or nothing is
  // what it went LOOKING for — which lived on another pane, behind a filter
  // they had to rebuild from the id by hand. `/trace` has taken a dimensionId
  // since it was written.
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  await pane(view, "参考文献");
  await view.act(() => { button(view.tree, "按维度").props.onClick(); });

  const heads = findAll(view.tree, (node) => node.type === "button"
    && typeof node.props?.["aria-label"] === "string"
    && node.props["aria-label"].startsWith("打开维度："));
  assert.ok(heads.length > 0, "there is no way into a dimension to jump out of");
  await view.act(() => { heads[0].props.onClick(); });

  await view.act(() => { button(view.tree, "看它搜了什么").props.onClick(); });
  const text = textOf(view.tree).join(" ");

  // THE FILTER CAME WITH IT. A jump that lands on the unfiltered trajectory
  // has not answered the question it was asked — it has handed the reader the
  // same rebuild one pane further on.
  const picker = find(view.tree, (node) => node.props?.["aria-label"] === "按维度筛选");
  assert.ok(picker, "the trajectory opened without its dimension filter");
  assert.equal(picker.props.value, "d1", "the trajectory opened unfiltered, so the jump landed the reader in the whole run again");
  assert.ok(text.includes("显示 2 / 2 条"), "the list is not narrowed to this dimension's rows");
  assert.ok(text.includes("未筛选共 7 条"), "the list does not say how much of the trajectory it is hiding, so a filtered view reads as the whole of it");

  // AND IT IS A PANE CHANGE, not a drawer over the references list.
  assert.equal(
    findAll(view.tree, (node) => typeof node.props?.["aria-label"] === "string"
      && node.props["aria-label"].startsWith("打开维度：")).length,
    0,
    "the references pane is still underneath, so the jump opened a second screen rather than moving to one",
  );
});

test("an empty dimension is the one that most needs the jump", async () => {
  // THE INCIDENT IS THE EMPTY CASE. MissionStageDetail puts its own jump under
  // the rows it summarises, and copying that here would have hidden this one
  // behind a list that is not there: a dimension that collected nothing is
  // exactly the dimension whose searches you want to read.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        findings: [],
        counts: { verified: 0 },
        dimension: {
          dimensionId: "d9", name: "空的维度", rationale: null, facet: "technical",
          state: "collected", attempt: 1, grade: null,
          gradeAxes: { pagesFetched: 4, uniqueHosts: 2 }, summary: null, failureCode: null,
        },
      },
    }),
  });
  let jumped = "nothing";
  const drawer = await render("MissionDimensionDrawer", {
    missionId: "m1", dimension: { id: "d9", name: "空的维度" }, runCount: 1, zh: true,
    onClose: () => {},
    onOpenTrace: (id) => { jumped = id; },
  });
  const jump = find(drawer.tree, (node) => node.type === "button"
    && textOf(node).some((piece) => piece.includes("看它搜了什么")));
  assert.ok(jump, "a dimension that found nothing offers no way to see what it looked for, which is the only question left about it");
  jump.props.onClick();
  assert.equal(jumped, "d9", "the jump names no dimension, so the trajectory it opens is the whole run's");

  // WITHOUT A CALLER, NO CONTROL. A pane with nowhere to send the reader must
  // not offer to send them — the rule the finding rows' 读这一页 already follows.
  const alone = await render("MissionDimensionDrawer", {
    missionId: "m1", dimension: { id: "d9", name: "空的维度" }, runCount: 1, zh: true,
    onClose: () => {},
  });
  assert.ok(
    !textOf(alone.tree).join(" ").includes("看它搜了什么"),
    "the drawer offers a jump its caller cannot perform, so the control is a dead button",
  );
});

test("a jump into a dimension the trajectory never recorded still names it", async () => {
  // FIVE PLANNED, THREE EVER RECORDED. The dimension select is built from the
  // rows themselves, on purpose, so it cannot offer an option matching nothing
  // — which means a jump into d4 arrives with a value that is in none of the
  // options, and a `<select>` in that state paints itself BLANK. The list is
  // then filtered while its control reads as unfiltered, which is the one
  // thing a filter must never do.
  stubFetch();
  const view = await render("MissionTrace", {
    missionId: RUNNING.id, zh: true, live: false, timeline: [], focusDimension: "d4",
  });
  const picker = find(view.tree, (node) => node.props?.["aria-label"] === "按维度筛选");
  assert.ok(picker, "the trajectory has no dimension filter at all");
  assert.equal(picker.props.value, "d4", "the jump was dropped, so the drawer sent the reader to an unfiltered list");
  const options = textOf(picker).join(" ");
  assert.ok(options.includes("推理时序扩展的成本账"), "the filter is set to a dimension it will not name, so the control reads as empty over a filtered list");
  assert.ok(options.includes("0 条"), "the option hides that it matches nothing, which is the answer the reader came for");
  assert.ok(
    textOf(view.tree).join(" ").includes("这个筛选下没有记录"),
    "an empty list under this filter does not say which empty it is — nothing recorded here, against a mission that recorded nothing",
  );
});


test("a graded dimension says what its grade is made of, and which bar it was measured on", async () => {
  // A NUMBER A READER CANNOT ARGUE WITH IS A NUMBER THEY CANNOT USE. The grade
  // is 0.7 of the evidence share and 0.3 of the independence share, and the two
  // ask for opposite responses: a dimension short on verified findings wants
  // another collection round, one short on hosts wants a different query. "74"
  // on its own asks for neither.
  //
  // The bar is asserted BY NAME because there are two of them. s3 divides by
  // its own collection target and s4 by the floor this mission derived from
  // measured supply; a sentence that names neither lets a reader take an s3
  // grade for an assessment that has not happened.
  const graded = (axes) => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: {
          findings: [],
          dimension: {
            dimensionId: "d7", name: "评过分的维度", rationale: null, facet: "technical",
            state: "collected", attempt: 1, grade: 74, gradeAxes: axes,
            summary: null, failureCode: null,
          },
          counts: { verified: 5 },
        },
      }),
    });
    return render("MissionDimensionDrawer", {
      missionId: "m1", dimension: { id: "d7", name: "评过分的维度" }, runCount: 1, zh: true,
      onClose: () => {},
    });
  };

  const assessed = textOf((await graded({ verified: 5, floor: 6, uniqueHosts: 2, unchecked: 1 })).tree).join(" ");
  assert.ok(assessed.includes("74/100"), "a dimension's own grade is still nowhere on its own drawer");
  assert.ok(assessed.includes("已验证 5 条"), "the verified count the grade was computed from is missing, so the score cannot be checked against anything");
  assert.ok(assessed.includes("下限 6 条"), "the bar the evidence half was divided by is unstated, which makes the share unreadable");
  assert.ok(assessed.includes("2 个独立站点"), "the independence half is invisible, so a well-verified dimension sourced from one site looks like a well-sourced one");
  assert.ok(assessed.includes("占 70%") && assessed.includes("占 30%"), "the two halves are printed without their weights, so a reader cannot tell which one is holding the grade down");

  const collected = textOf((await graded({ verified: 5, uniqueHosts: 2, pagesFetched: 6, seedTarget: 5 })).tree).join(" ");
  assert.ok(
    collected.includes("采集阶段的目标 5 条"),
    "a grade s3 wrote is described against a floor the assessment has not derived yet, so the reader is told this dimension was judged when it was only counted",
  );
  assert.ok(
    !collected.includes("评估阶段推出的下限"),
    "an s3 grade claims the assessment's floor, which is the one bar it was not measured against",
  );
});

test("an ungraded dimension says so rather than being handed a nought", async () => {
  // `grade ?? 0` IS A FAILING MARK NOBODY GAVE. A dimension s3 has not reached
  // has no grade at all, and 0/100 beside its name reads as one that was
  // measured and found worthless — the reading the header's score tile and the
  // verified chip each already refuse, and the drawer would have been the third
  // place to give it.
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      success: true,
      data: {
        findings: [],
        dimension: {
          dimensionId: "d8", name: "还没评分的维度", rationale: null, facet: "technical",
          state: "collecting", attempt: 1, grade: null, gradeAxes: { pagesFetched: 4, uniqueHosts: 2 },
          summary: null, failureCode: null,
        },
        counts: { verified: 0 },
      },
    }),
  });
  const drawer = await render("MissionDimensionDrawer", {
    missionId: "m1", dimension: { id: "d8", name: "还没评分的维度" }, runCount: 1, zh: true,
    onClose: () => {},
  });
  const text = textOf(drawer.tree).join(" ");
  assert.ok(!text.includes("0/100"), "an ungraded dimension is drawn with a nought, which is a mark for work that has not been marked");
  // THE TILE PRINTS THE EM DASH, and the block under it still says WHICH empty
  // this is. `未评分` went out with the span that held it: the score is a
  // `MetricStat` now, and that component's word for "not measured" is the dash
  // this file uses at every other absence — while the account of WHEN a grade
  // arrives, which is the half a reader can act on, is asserted below.
  assert.ok(text.includes("这个分数是怎么来的"), "the drawer is silent about the missing grade, which leaves a reader to assume the pipeline judged this dimension and said nothing");
  assert.ok(
    text.includes("采集收尾时会打一次分"),
    "the drawer says there is no grade without saying when there will be one, which is the difference between a gap and a fault",
  );
});

test("a stage row re-runs itself, and only the rows the pipeline lets re-run", async () => {
  // THE CONTROL AT THE ROW, PRESSED. The source guard in design-tokens.test.mjs
  // can see that the gate is written; only calling it can see that the button
  // reaches `onRerunStage` with this row's own step id and does not also select
  // the row underneath it.
  const stages = [
    { stepId: "s1-open", status: "done", attempts: 1, durationMs: 900, agent: "leader", rerunable: false, rerunReason: "re-running the gate would re-resolve caps this mission is already graded against" },
    { stepId: "s3-collect", status: "done", attempts: 1, durationMs: 41000, agent: "researcher", rerunable: true, rerunReason: null },
  ];
  const pressed = [];
  const chosen = [];
  const board = await render("MissionTaskBoard", {
    stages, agents: [], zh: true,
    onRerunStage: (stepId) => { pressed.push(stepId); },
    onSelect: (key) => { chosen.push(key); },
  });

  const reruns = findAll(board.tree, (node) => node.type === "button" && textOf(node).some((piece) => piece.includes("重跑")));
  assert.equal(reruns.length, 1, `${reruns.length} rows offer a rerun; exactly one of these two stages declares itself rerunable, and the budget gate is the other`);

  // Both rows keep the link. The rerun joined it rather than replacing it.
  const links = findAll(board.tree, (node) => node.type === "button" && textOf(node).some((piece) => piece.includes("看轨迹")));
  assert.equal(links.length, 2, "the trajectory link was replaced by the rerun rather than joined by it");

  let stopped = false;
  await board.act(() => { reruns[0].props.onClick({ stopPropagation: () => { stopped = true; } }); });
  assert.deepEqual(pressed, ["s3-collect"], "the row's rerun did not reach onRerunStage with its own step id");
  assert.ok(stopped, "the rerun let the row's own click through, so re-running also opens the drawer over the board");
  assert.deepEqual(chosen, [], "pressing 重跑 selected the row as well, which reads as the rerun having navigated somewhere");

  // And the un-rerunable stage says nothing here: its reason is a sentence
  // `validateStageDag` refuses to let a stage omit, and it belongs to the
  // drawer, where one row is being asked about.
  const text = textOf(board.tree).join(" ");
  assert.ok(!text.includes("re-resolve caps"), "the un-rerunable reason is printed on the row; thirty of those down a 16% column is not a table");
});

test("a references row says its ratio once, and only the arrangement that sorts by a key prints it", async () => {
  const times = (haystack, needle) => haystack.split(needle).length - 1;
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  const text = await pane(view, "参考文献");

  assert.ok(text.includes("已核验 4/6"), "the row does not carry its verdict as a ratio");
  // FOLDED, NOT JOINED. The page that fed two dimensions names the first and
  // counts the rest, the way the run picker folds its history.
  assert.ok(text.includes("推理时序扩展的训练侧做法 +1"), "a page that fed two dimensions prints both names in full again");
  // ONE occurrence: the arrangement's own label in the strip, and no stamp on
  // any row. Counted rather than matched on the clock itself, because
  // `formatStamp` renders in the runner's zone and the digits move with it.
  assert.equal(
    times(text, "首次读到"),
    1,
    "the first-read stamp is on every row under 按引用, where nothing is sorted by it",
  );
  await view.act(() => { button(view.tree, "按首次读到").props.onClick(); });
  assert.ok(
    times(textOf(view.tree).join(" "), "首次读到") > 1,
    "按首次读到 orders the list by a key that appears nowhere on the rows it ordered",
  );
});

test("the library miss is a sentence about the run, not five characters on every row", async () => {
  const times = (haystack, needle) => haystack.split(needle).length - 1;
  stubFetch();
  const inner = globalThis.fetch;
  // Every page a library miss — the shape of a real mission, where the join
  // finds almost nothing.
  const payload = {
    missionId: SIGNED.id, runCount: 1, scope: { dimensionId: null },
    sources: [
      { url: "https://a.example/one", host: "a.example", title: "第一页", findings: 2, verified: 2, dimensionIds: ["d1"], firstSeenAt: "2026-08-22T09:20:00.000Z", library: null },
      { url: "https://b.example/two", host: "b.example", title: "第二页", findings: 1, verified: 0, dimensionIds: ["d1"], firstSeenAt: "2026-08-22T09:21:00.000Z", library: null },
    ],
    totals: { sources: 2, hosts: 2, findings: 3, verified: 2, dated: 0 },
    runs: [{ runCount: 1, total: 3, verified: 2, dimensions: 1 }],
    dimensions: [{ dimensionId: "d1", name: "推理时序扩展的训练侧做法" }],
  };
  globalThis.fetch = async (url, init) => (String(url).includes("/sources")
    ? { ok: true, status: 200, json: async () => ({ success: true, data: payload }) }
    : inner(url, init));

  const zh = textOf((await render("MissionSources", { missionId: SIGNED.id, zh: true })).tree).join(" ");
  assert.equal(
    times(zh, "不在信源库"),
    1,
    "a run whose library holds none of its pages says so once per row instead of once — the same five characters repeated, carrying nought bits each",
  );
  assert.ok(zh.includes("这 2 页都不在信源库"), "the sentence does not say how many pages it is speaking for");

  const en = textOf((await render("MissionSources", { missionId: SIGNED.id, zh: false })).tree).join(" ");
  assert.ok(en.includes("None of these 2 pages is in the library"), "the once-said library miss has no English arm");
  assert.equal(times(en, "not in the library"), 0, "the English rows still repeat the miss under the sentence that already said it");
});

test("a dimension row's status chip carries the score that dimension was given", async () => {
  // THE REFERENCE'S 状态 IS A CHIP WITH A SCORE IN IT — 已完成 · 78/100 — and
  // ours was a chip with a word. The number was three hops away and drawn
  // nowhere: mission_dimensions.grade → projectDimensions → buildWork's
  // `counts.grade` → no reader. More information in the same 26px pill, which
  // is the only kind of density this round accepts.
  const board = await render("MissionTaskBoard", {
    zh: true, agents: [],
    stages: stagesUpTo("s3-collect"),
    work: [
      { id: "stage:s3-collect", parentId: null, origin: "pipeline", title: "s3-collect", state: "running", assignee: "researcher", reason: null, counts: { attempts: 1 } },
      { id: "dimension:d1", parentId: "stage:s3-collect", origin: "s2-plan", title: "推理时序扩展的复现情况", state: "collected", assignee: "researcher:d1", reason: "", counts: { verified: 5, floor: 3, attempts: 1, grade: 78 } },
      { id: "dimension:d2", parentId: "stage:s3-collect", origin: "s2-plan", title: "许可证与再分发条款", state: "degraded", assignee: "researcher:d2", reason: "", counts: { verified: 1, floor: 3, attempts: 2, grade: 41 } },
      { id: "dimension:d3", parentId: "stage:s3-collect", origin: "s2-plan", title: "尚未开始的维度", state: "pending", assignee: "researcher:d3", reason: "", counts: { verified: 0, floor: 3, attempts: 1, grade: null } },
    ],
  });
  const text = textOf(board.tree).join(" ");
  assert.ok(text.includes("78"), "the dimension's grade is stored, projected, carried through buildWork and drawn nowhere; the reference's status column reads 已完成 · 78/100");

  // A RETRY OUTRANKS A SCORE, AND ONLY ONE OF THEM IS PRINTED. Both in one
  // pill is two figures in a 26px box in a 14% column.
  assert.ok(text.includes("第 2 次"), "the retried row lost its attempt count to the score");
  assert.ok(!text.includes("41"), "the retried row prints its attempt count AND its score into one pill");

  // NULL IS NOT NOUGHT. A dimension s3 has not settled has no score, and a 0
  // here is a mark the pipeline never gave — the `/0` defect, one column over.
  const chips = findAll(board.tree, (node) => node.props?.children === "0");
  assert.deepEqual(chips, [], "an ungraded dimension renders a score of 0, which is a verdict nothing issued");
});

test("every row on the board offers something, and never a control the route would refuse", async () => {
  // 操作 WAS THE ONLY COLUMN THAT WAS BLANK ON A WHOLE CLASS OF ROW. `stage` is
  // null on every child, so the cell rendered null under its own header on
  // exactly the rows a real run's board is mostly made of.
  const picked = [];
  const pressed = [];
  const board = await render("MissionTaskBoard", {
    zh: true, agents: [],
    stages: [
      { stepId: "s1-brief", status: "done", attempts: 1, durationMs: 900, agent: null, rerunable: false, rerunReason: "a budget gate cannot be re-run — the caps it froze are what this mission is graded against" },
      { stepId: "s3-collect", status: "done", attempts: 1, durationMs: 41000, agent: "researcher", rerunable: true, rerunReason: null },
    ],
    work: [
      { id: "stage:s1-brief", parentId: null, origin: "pipeline", title: "s1-brief", state: "done", assignee: null, reason: null, counts: { attempts: 1 } },
      { id: "stage:s3-collect", parentId: null, origin: "pipeline", title: "s3-collect", state: "done", assignee: "researcher", reason: null, counts: { attempts: 1 } },
      { id: "dimension:d1", parentId: "stage:s3-collect", origin: "s2-plan", title: "推理时序扩展的复现情况", state: "collected", assignee: "researcher:d1", reason: "", counts: { verified: 5, floor: 3, attempts: 1, grade: 78 } },
    ],
    onSelect: (key) => { picked.push(key); },
    onRerunStage: (stepId) => { pressed.push(stepId); },
  });

  const details = findAll(board.tree, (node) => node.type === "button" && textOf(node).some((piece) => piece.includes("详情")));
  assert.equal(details.length, 1, `${details.length} rows offer 详情; the one dimension row's 操作 cell was the only blank cell on the board and there is exactly one child here`);
  let stopped = false;
  await board.act(() => { details[0].props.onClick({ stopPropagation: () => { stopped = true; } }); });
  assert.deepEqual(picked, ["dimension:d1"], "详情 does not open the dimension it sits on");
  assert.ok(stopped, "详情 let the row's own click through, so pressing it opens and then closes the drawer");

  // THE REFUSED CONTROL IS SHOWN AND IS NOT PRESSABLE. A span, so it is not in
  // the tab order and cannot reach a route that would answer 409.
  const reruns = findAll(board.tree, (node) => node.type === "button" && textOf(node).some((piece) => piece.includes("重跑")));
  assert.equal(reruns.length, 1, `${reruns.length} rows offer a pressable rerun; s1-brief declares rerunable:false and a button there is a click the route refuses`);
  await board.act(() => { reruns[0].props.onClick({ stopPropagation: () => {} }); });
  assert.deepEqual(pressed, ["s3-collect"], "the pressable rerun is not the one on the rerunable stage");

  const text = textOf(board.tree).join(" ");
  assert.ok(text.includes("原因写在详情里"), "the un-rerunable stage's 操作 cell is empty, so the column has one shape on ten rows and another on two, for a reason nothing on screen gives");
  assert.ok(!text.includes("caps it froze"), "the pipeline's rerun refusal is printed on the row; a full sentence down a 12% column is not a table, which is why the drawer owns it");
});
