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
const RUNNING = {
  id: "mission-20260824T090000Z-1a2b3c4d",
  topic: "推理时序扩展的三条技术路线",
  depth: "standard", language: "zh", status: "running", rawStatus: "running",
  budget: { maxTokens: 1500000, maxCalls: 120, maxArxiv: 60, maxWeb: 120, maxFetch: 100, wallMs: 3600000 },
  retryBelowSeam: false, goals: null, derivedFloor: 3, runCount: 1, patchRound: 0,
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
  byStage: [], byAgent: [],
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
  agents: [], todo: [],
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
  agents: [], todo: [],
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
    },
    versions: DEAD_VIEW.artifact.versions,
  },
  [SIGNED.id]: {
    artifact: {
      missionId: SIGNED.id, version: 2, runCount: 1, trigger: "initial",
      title: "开源推理模型的许可证走向",
      markdown: "# 开源推理模型的许可证走向\n\n三家实验室同期收敛到同一种做法。\n",
      sections: [{ dimensionId: "d1", chapterIndex: 0, sectionType: "evidenced", heading: "训练侧", start: 0, end: 40 }],
      citations: [{ index: 1, url: "https://deepmind.google/discover/scaling", findingId: "f1", inlineQuote: "we observe the same scaling behaviour at test time" }],
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
    versions: [
      { version: 2, runCount: 1, trigger: "initial", title: "开源推理模型的许可证走向", wordCount: 8200, degraded: false, citations: 1, createdAt: "2026-08-24T10:00:00.000Z" },
      { version: 1, runCount: 1, trigger: "initial", title: "开源推理模型的许可证走向", wordCount: 300, degraded: true, citations: 0, createdAt: "2026-08-24T09:50:00.000Z" },
    ],
  },
};

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

    const artifact = Object.keys(ARTIFACTS).find((id) => address.includes(`/missions/${id}/artifact`));
    if (artifact !== undefined) return ok(ARTIFACTS[artifact]);

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

test("the tab offers a topic, a tier, and a way to start", async () => {
  stubFetch();
  const { tree } = await render("MissionsTab", { zh: true });
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
  assert.ok(text.includes("立项") && text.includes("采集"), "starting did not open the mission it started");
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

test("opening a mission shows its twelve stages, its cost and its tail", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  const text = await open(view, RUNNING.topic);

  // Twelve, always twelve: the projector guarantees the count, so the strip is
  // a ruler a person can learn the shape of rather than a list that grows.
  for (const stage of ["立项", "规划", "采集", "评估", "归一", "综合", "拟纲", "撰写", "核验", "复盘", "签署", "归档"]) {
    assert.ok(text.includes(stage), `the stage strip is missing ${stage}`);
  }
  assert.ok(text.includes("令牌") && text.includes("412000 / 1500000"), "the cost meters are not on the page");
  // Named, not summed. A mission at 100% of its arXiv allowance and 20% of its
  // tokens is about to start failing tool calls, and one blended percentage
  // would say it is fine right up until it stops working.
  assert.ok(text.includes("最紧"), "nothing names the tightest ceiling");

  // The per-dimension pane, with the floor as a fraction rather than a tick.
  assert.ok(text.includes("已核验 5/3 条"), "a dimension does not say how it stands against the floor");
  assert.ok(text.includes("读了 6 个页面"), "a dimension does not say how much it read");
  // Availability and quality are never the same number in the same place.
  assert.ok(text.includes("被限流"), "a rate-limited dimension does not say so");
  assert.ok(text.includes("这是取不到，不是没有"), "a blocked dimension reads as an empty one");

  assert.ok(text.includes("开始运行"), "the live tail is empty");
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
  assert.ok(text.includes("这个维度读了 2 个页面，没有产出任何通过核验的引语。"), "the dimension's own account is missing");
  assert.ok(text.includes("quality_refused"), "the failure code is not shown");
  assert.ok(text.includes("领队读过报告后拒绝签署"), "a refusal to sign is not distinguished from a crash");
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
  assert.ok(textOf(view.tree).join(" ").includes("读报告"), "a finished mission offers no way to read what it wrote");
  await view.act(() => { button(view.tree, "读报告").props.onClick(); });

  const text = textOf(view.tree).join(" ");
  assert.ok(text.includes("三家实验室同期收敛到同一种做法"), "the report body did not render");
  // Per section type, never averaged: "this chapter cites nothing" has to stay
  // visible instead of disappearing into a healthy-looking overall ratio.
  assert.ok(text.includes("有据章节"), "the scorecard is not split by section type");
  assert.ok(text.includes("3/4 已核验"), "the scorecard does not say how much verified");

  assert.ok(text.includes("we observe the same scaling behaviour at test time"), "the evidence quote is missing");
  const link = find(view.tree, (node) => node.type === "a" && node.props?.href === "https://deepmind.google/discover/scaling");
  assert.ok(link, "the quote does not link to the page it was verified against");
  // A row whose address did not survive still shows its quote and says it
  // cannot be opened. Dropping it would leave a report claiming two pieces of
  // evidence and showing one.
  assert.ok(text.includes("the replication holds across the two smaller model sizes"), "an unopenable row was dropped");
  assert.ok(text.includes("没有带回可打开的地址"), "an unopenable row does not say why");
});

test("an evidence row opens the reader on the whole source", async () => {
  stubFetch();
  const asked = [];
  const view = await render("MissionsTab", { zh: true });
  await open(view, SIGNED.topic);
  await view.act(() => { button(view.tree, "读报告").props.onClick(); });

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
  assert.ok(text.includes("返回报告"), "there is no way back to the report");
});

test("a scorecard with nothing in it is not a clean bill", async () => {
  stubFetch();
  const view = await render("MissionsTab", { zh: true });
  await open(view, REFUSED.topic);
  await view.act(() => { button(view.tree, "读报告").props.onClick(); });
  const text = textOf(view.tree).join(" ");
  // `verified / total` at 0/0 is NaN or, worse, reads as "no failures" — the
  // exact figure the whole pipeline converges on, presenting a mission that
  // checked nothing as a mission that found nothing wrong.
  assert.ok(text.includes("一处引用都没有核验过"), "an empty scorecard is not called out");
  assert.ok(text.includes("这不是“没有发现问题”"), "an empty scorecard reads as a pass");
  assert.ok(text.includes("这一版是降级归档的"), "a degraded artefact does not say it is degraded");
  assert.ok(text.includes("没有产出一条通过核验的引语"), "an empty evidence list is rendered as an empty list");
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
