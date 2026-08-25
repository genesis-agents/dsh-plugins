/**
 * The five ceilings, the ladder, and the one accountant that reads them.
 *
 * Three things live here and nowhere else, because each is a number that MUST
 * have exactly one copy:
 *
 *   DEPTH_TIER_BUDGETS  what a `quick` / `standard` / `deep` mission may spend.
 *                       Served over `/swarm-api/missions/budget-tiers` so the
 *                       browser bundle never holds a second copy — playground's
 *                       frontend drifted from its backend on the FIELD LIMITS
 *                       even after the tier values were centralised, so the
 *                       limits are served too.
 *   LADDER              the four fractions the meter's colour ramp, the degrade
 *                       steps, the warning text and `mission-view.js` all read.
 *                       Revision 1 of the design stated the trigger three times
 *                       with two different values; one frozen object is the fix.
 *   resolveBudget()     called ONCE, at `createMission`, and frozen onto the
 *                       mission row. Every later stage reads the row. A test
 *                       asserts no module reads `input.maxTokens` directly:
 *                       playground's rerun builder could not read `maxCredits`,
 *                       fell back to a value worth about two dollars, and the
 *                       rerun died instantly with every layer reporting success.
 *
 * The pool is deliberately honest about what it is. Usage arrives as ONE chunk
 * at the end of a generation, so there is no running token count: the live pool
 * is an ESTIMATE and `SUM(mission_spend)` is exact. Those are two quantities,
 * both stored, and `store.estimateDrift()` measures the gap rather than a
 * comment asserting they cannot drift.
 *
 * @see docs/insight-mission.md §8 — budget is stage one.
 */

import { DEPTH_TIERS } from "./mission-runtime.js";
import { readUsage } from "./mission-agent.js";

/**
 * The degrade ladder, as fractions of the tightest dimension.
 *
 * ONE frozen object. `mission-view.js` refuses a `policy.ladder` that is not
 * this shape precisely so a local copy cannot appear beside it.
 */
export const LADDER = Object.freeze({ soften: 0.70, freeze: 0.85, warn: 0.90, stop: 1.00 });

/** The five spendable dimensions, in report order. `wall` is not one — see `ratio`. */
export const POOL_DIMENSIONS = Object.freeze(["tokens", "calls", "arxiv", "web", "fetch"]);

/** Pool dimension to the cap field on the mission row that bounds it. */
const CAP_FIELD = Object.freeze({
  tokens: "maxTokens",
  calls: "maxCalls",
  arxiv: "maxArxiv",
  web: "maxWeb",
  fetch: "maxFetch",
});

/** Every field `resolveBudget` answers with, in mission-row order. */
export const BUDGET_FIELDS = Object.freeze(["maxTokens", "maxCalls", "maxArxiv", "maxWeb", "maxFetch", "wallMs"]);

/**
 * What each depth tier costs, from docs/insight-mission.md "What a mission costs".
 *
 * `wallMs` is the CAP, not the floor. The floor is computed from the rate
 * limits by `computeWallFloorMs()`, and a plan whose floor exceeds its cap is
 * refused before a row is created — see the create route.
 */
export const DEPTH_TIER_BUDGETS = Object.freeze({
  quick: Object.freeze({
    maxTokens: 400_000, maxCalls: 40, maxArxiv: 20, maxWeb: 30, maxFetch: 30, wallMs: 20 * 60_000,
  }),
  standard: Object.freeze({
    maxTokens: 1_500_000, maxCalls: 120, maxArxiv: 60, maxWeb: 120, maxFetch: 100, wallMs: 60 * 60_000,
  }),
  deep: Object.freeze({
    maxTokens: 4_000_000, maxCalls: 300, maxArxiv: 150, maxWeb: 300, maxFetch: 250, wallMs: 3 * 60 * 60_000,
  }),
});

/**
 * The outer bounds an override may name.
 *
 * A RUNAWAY BACKSTOP, NOT A SPEND POLICY. The tier table above is the plan;
 * this only stops a typo — a wall cap of `20` meaning minutes, a token ceiling
 * with an extra zero — from becoming a mission that either cannot finish its
 * first stage or runs until somebody notices. Said out loud, because a limit
 * table read as the plan is how a backstop quietly becomes a budget nobody
 * chose.
 *
 * `maxArxiv`, `maxWeb` and `maxFetch` may be ZERO: a machine with no search
 * plugin sets `maxWeb: 0` deliberately, and `createMission` accepts it.
 */
export const BUDGET_FIELD_LIMITS = Object.freeze({
  maxTokens: Object.freeze({ min: 20_000, max: 20_000_000, unit: "tokens" }),
  maxCalls: Object.freeze({ min: 4, max: 2_000, unit: "model calls" }),
  maxArxiv: Object.freeze({ min: 0, max: 1_000, unit: "arXiv requests" }),
  maxWeb: Object.freeze({ min: 0, max: 2_000, unit: "web searches" }),
  maxFetch: Object.freeze({ min: 0, max: 1_500, unit: "page fetches" }),
  wallMs: Object.freeze({ min: 60_000, max: 8 * 60 * 60_000, unit: "milliseconds of wall clock" }),
});

/** An integer, or undefined when the value cannot be read as one. */
function asInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/**
 * Resolve the five ceilings and the wall cap, once, for one mission.
 *
 * Checked rather than coerced where it matters. An override that is not a
 * number at all is REPORTED in `rejected` rather than silently replaced by the
 * tier default, because an override that vanishes is a setting that reports one
 * thing and does another. An override that IS a number but out of bounds is
 * clamped and recorded in `clamped`, since the backstop exists to be hit.
 *
 * The answer is frozen and JSON-serialisable: `createMission` stores the whole
 * of it as config revision 1, and a rerun re-reads it rather than re-resolving.
 *
 * @param input - `{ depth, overrides }`; `overrides` may name any BUDGET_FIELDS member.
 * @returns `{ depth, maxTokens, maxCalls, maxArxiv, maxWeb, maxFetch, wallMs, source, clamped, rejected }`.
 */
export function resolveBudget(input = {}) {
  const depth = input?.depth;
  if (!DEPTH_TIERS.includes(depth)) {
    throw new Error(`resolveBudget: depth must be one of ${DEPTH_TIERS.join(", ")}, received ${JSON.stringify(depth)}.`);
  }
  const tier = DEPTH_TIER_BUDGETS[depth];
  const overrides = input?.overrides ?? {};

  const source = {};
  const clamped = [];
  const rejected = [];
  const resolved = {};

  for (const field of BUDGET_FIELDS) {
    const asked = overrides?.[field];
    if (asked === undefined || asked === null || asked === "") {
      resolved[field] = tier[field];
      source[field] = "default";
      continue;
    }
    const value = asInteger(asked);
    if (value === undefined) {
      // Named, not swallowed. `Number("thirty")` is NaN, and a NaN ceiling reads
      // as no ceiling at all in every comparison below.
      rejected.push(`${field}: ${JSON.stringify(asked)} is not a number; the ${depth} default ${tier[field]} was used instead`);
      resolved[field] = tier[field];
      source[field] = "default";
      continue;
    }
    const limit = BUDGET_FIELD_LIMITS[field];
    const bounded = Math.max(limit.min, Math.min(limit.max, value));
    if (bounded !== value) clamped.push(`${field}: ${value} -> ${bounded} (${limit.min}..${limit.max} ${limit.unit})`);
    resolved[field] = bounded;
    source[field] = "override";
  }

  return Object.freeze({
    depth,
    ...resolved,
    source: Object.freeze(source),
    clamped: Object.freeze(clamped),
    rejected: Object.freeze(rejected),
  });
}

/**
 * One mission's accountant.
 *
 * The interface two existing modules already assume, and it matches BOTH:
 * `invokeTool` calls `consume(paceKey, 1)` and treats anything but `true` or
 * `{ok:true}` as a refusal; `checkDeadlines` calls `isExhausted()` and
 * `ratio()` and prints the named dimension into the failure sentence.
 *
 * TWO DECISIONS THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 * 1. A ceiling of ZERO means "this tool is switched off", not "this mission is
 *    over". With a bare `>=` on every dimension a `maxWeb: 0` mission would
 *    report itself exhausted before its first stage — so a zero-limit dimension
 *    is excluded from `isExhausted()` and from `ratio()`, and `consume()` on it
 *    refuses with a sentence saying it was never available rather than spent.
 * 2. `settle()` is what advances the `calls` dimension. One settlement is one
 *    completed model call, and that is the only moment this process learns a
 *    call happened at all; counting at dispatch would charge a turn the
 *    provider refused.
 *
 * @param options - `{ caps, used, onCross }`; `used` seeds a resumed mission from the ledger.
 * @returns the pool.
 */
export function createBudgetPool({ caps, used = {}, onCross = null } = {}) {
  if (caps === null || typeof caps !== "object") {
    throw new TypeError("createBudgetPool needs the five resolved ceilings as `caps`. Read them off the mission row (mission.budget), never from the request that opened it.");
  }

  const limits = {};
  for (const key of POOL_DIMENSIONS) {
    const value = caps[CAP_FIELD[key]];
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`createBudgetPool: caps.${CAP_FIELD[key]} must be a non-negative integer, received ${JSON.stringify(value)}. resolveBudget() runs once at createMission and every later reader takes the row's value.`);
    }
    limits[key] = value;
  }

  /** Settled spend: exact token counts, completed calls, charged tool calls. */
  const spent = {};
  for (const key of POOL_DIMENSIONS) spent[key] = Math.max(0, asInteger(used?.[key]) ?? 0);

  /** Estimated completion tokens since the last settlement. Replaced, not added to, at settle. */
  let pendingTokens = 0;

  /** Ladder rungs already announced, so a notifier fires once per rung. */
  const announced = new Set();

  const usedOf = (key) => (key === "tokens" ? spent.tokens + pendingTokens : spent[key]);

  /** The tightest dimension, skipping the ones with no ceiling to be tight against. */
  const tight = () => {
    let best = { value: 0, dimension: "tokens", used: usedOf("tokens"), limit: limits.tokens };
    for (const key of POOL_DIMENSIONS) {
      if (limits[key] <= 0) continue;
      const value = usedOf(key) / limits[key];
      if (value > best.value || best.limit <= 0) {
        best = { value, dimension: key, used: usedOf(key), limit: limits[key] };
      }
    }
    return best;
  };

  /** Announce a ladder crossing, at most once per rung. */
  const cross = () => {
    if (typeof onCross !== "function") return;
    const state = tight();
    for (const [rung, at] of Object.entries(LADDER)) {
      if (state.value < at || announced.has(rung)) continue;
      announced.add(rung);
      try {
        onCross(rung, state);
      } catch {
        // A notifier that throws must never take the mission with it: this is
        // bookkeeping, and the ladder proceeds whether or not anybody was there
        // to be told.
      }
    }
  };

  const pool = {
    /**
     * Charge one dimension.
     * @param key - a POOL_DIMENSIONS member; the tool door passes `tool.paceKey`.
     * @param n - how many units.
     * @returns `true`, or `{ ok: false, error }` naming the ceiling and its numbers.
     */
    consume(key, n = 1) {
      if (!POOL_DIMENSIONS.includes(key)) {
        // Thrown rather than refused. A refusal here would reach the model as
        // `budget_exhausted:<key>`, which is a lie — the allowance is not spent,
        // the key does not exist. That is a tool declaring a pace key the pool
        // has never heard of: a bug to fix, not a budget to raise.
        throw new TypeError(`budget pool: "${key}" is not one of ${POOL_DIMENSIONS.join(", ")}. A tool's paceKey must name a dimension the pool meters, or its calls run unmetered while every layer reports success.`);
      }
      const amount = Math.max(0, asInteger(n) ?? 0);
      const limit = limits[key];
      if (limit <= 0) {
        return { ok: false, error: `this mission's ${key} ceiling is 0, so ${key} was never available — it was not spent` };
      }
      if (usedOf(key) + amount > limit) {
        return { ok: false, error: `this mission's ${key} allowance is spent (${usedOf(key)} of ${limit})` };
      }
      spent[key] += amount;
      cross();
      return true;
    },

    /**
     * Add estimated completion tokens mid-stream.
     *
     * The agent seam accumulates `text.length / 4` and calls this so the loop
     * can break the instant the pool drains. Bounding the overrun to one
     * estimation error beats noticing after a whole pathological response.
     * @param tokens - estimated tokens since the last call.
     * @returns `true`, or `{ ok: false, error }` once the ceiling is reached.
     */
    estimate(tokens) {
      pendingTokens += Math.max(0, asInteger(tokens) ?? 0);
      cross();
      if (limits.tokens > 0 && usedOf("tokens") >= limits.tokens) {
        return { ok: false, error: `this mission's token allowance is spent (${usedOf("tokens")} of ${limits.tokens}, estimated)` };
      }
      return true;
    },

    /**
     * Reconcile against the usage chunk: exact counts in, estimate discarded.
     * @param usage - the adapter's raw usage object.
     * @returns `{ settled, tokens, calls, why }` — `why` says what happened when nothing did.
     */
    settle(usage) {
      const counts = readUsage(usage);
      if (counts === null) {
        // Not silently zero. A settlement that quietly records nothing makes the
        // estimator permanently untunable and renders a mission that cost real
        // money as free, so the estimate is KEPT rather than replaced by 0.
        return {
          settled: false,
          tokens: usedOf("tokens"),
          calls: spent.calls,
          why: "the usage chunk was absent or not an object; the estimate was kept rather than replaced by zero",
        };
      }
      // cache_read_tok is disjoint from prompt_tok, so the three add without
      // double counting — the same sum `projectCost` meters against.
      spent.tokens += counts.prompt + counts.completion + counts.cacheRead;
      spent.calls += 1;
      pendingTokens = 0;
      cross();
      return { settled: true, tokens: spent.tokens, calls: spent.calls, why: counts.source };
    },

    /**
     * Whether any ceiling is reached. `>=`, on every dimension that HAS one.
     * @returns true when the mission may spend no more.
     */
    isExhausted() {
      for (const key of POOL_DIMENSIONS) {
        if (limits[key] > 0 && usedOf(key) >= limits[key]) return true;
      }
      return false;
    },

    /**
     * The max over all five dimensions, naming the tight one.
     *
     * Named, never a bare scalar: an unnamed one would be tokens-only, so a
     * mission that burned 100% of `max_arxiv` at 20% of tokens would never warn
     * and would just start failing tool calls with no explanation.
     * @returns `{ value, dimension, used, limit }`.
     */
    ratio() {
      return tight();
    },

    /**
     * A child accountant that cannot outspend the parent.
     *
     * Every charge goes to both, so a fan-out with a per-child cap cannot spend
     * N times the ceiling. `isExhausted` is the OR of the two and both sides use
     * `>=` — playground used `>` on one side and had to unify them after the two
     * disagreed about whether a mission was over.
     * @param subCap - per-dimension caps, clamped to what is left.
     * @returns a pool with the same interface.
     */
    allocate(subCap = {}) {
      const childCaps = {};
      for (const key of POOL_DIMENSIONS) {
        const asked = asInteger(subCap?.[CAP_FIELD[key]] ?? subCap?.[key]);
        const left = Math.max(0, limits[key] - usedOf(key));
        childCaps[CAP_FIELD[key]] = asked === undefined ? left : Math.max(0, Math.min(asked, left));
      }
      const child = createBudgetPool({ caps: childCaps });
      return {
        ...child,
        consume(key, n = 1) {
          const own = child.consume(key, n);
          if (own !== true) return own;
          return pool.consume(key, n);
        },
        estimate(tokens) {
          child.estimate(tokens);
          return pool.estimate(tokens);
        },
        settle(usage) {
          child.settle(usage);
          return pool.settle(usage);
        },
        isExhausted() {
          return child.isExhausted() || pool.isExhausted();
        },
        ratio() {
          const mine = child.ratio();
          const theirs = pool.ratio();
          return mine.value >= theirs.value ? mine : theirs;
        },
      };
    },

    /**
     * Every number, for an event payload or a log line.
     * @returns `{ limits, used, pendingTokens, ratio, exhausted }`.
     */
    snapshot() {
      const usedNow = {};
      for (const key of POOL_DIMENSIONS) usedNow[key] = usedOf(key);
      return { limits: { ...limits }, used: usedNow, pendingTokens, ratio: tight(), exhausted: pool.isExhausted() };
    },
  };

  return pool;
}
