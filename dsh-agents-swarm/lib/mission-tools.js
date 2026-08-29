/**
 * The tool registry, and the one door every tool call goes through.
 *
 * Playground — the reference this is built from — has five well-written
 * middlewares (permission, rate limit, validation, timeout, progress) assembled
 * into a `ToolPipeline`, and its agent path calls `tool.execute` directly and
 * never touches it. So on the shipped path, entitlement enforcement, per-call
 * rate limiting and result caching do not run at all; its own invoker's comments
 * admit this and re-implement two of the five inline. Worse, the context it
 * builds omits the field the permission middleware would read, so even if the
 * pipeline ran it would fail closed on every gated tool.
 *
 * That is the largest structural mistake in the reference and the easiest to
 * avoid: THERE IS ONE EXECUTION PATH. `invokeTool` is the only way a tool ever
 * runs — from the agent loop, from a route, from the postlude. Everything that
 * has to happen on a tool call happens inside it, in a fixed order, once.
 *
 * Four rules are carried here because each one is a scar:
 *
 *   1. A REFUSAL IS NOT AN EMPTY RESULT. `insight-corroborate.js` already holds
 *      the sharp form of this — a 429 and "no hits" are the same value to any
 *      caller that only counts, and that is how a blocked search becomes
 *      "nobody else reported this", a claim about the world made from a fact
 *      about our own request rate. Here it becomes the door's rule rather than
 *      one module's: `{ok:false, code}` and `{ok:true, empty:true, reason}` are
 *      different shapes and can never be confused.
 *
 *   2. THE MODEL MUST SEE THE ERROR. Playground's fix note says it plainly: with
 *      an `undefined` observation the model sees nothing, guesses, re-issues the
 *      same query, gets the same nothing, and burns the iteration budget. Every
 *      failure out of this door carries `{ok, error, code, tool}`.
 *
 *   3. RATE LIMITS ARE A PROPERTY OF THE TOOL, NOT OF THE CALLER. `paceKey` is
 *      on the definition. No caller anywhere remembers to space arXiv calls,
 *      because no caller can reach arXiv except through here.
 *
 *   4. THE BUDGET IS CHECKED INSIDE THE DOOR. Revision 1 of the design recorded
 *      arXiv, web and fetch calls into the ledger and never connected them to
 *      the budget pool, so three of five ceilings were DISPLAYED rather than
 *      enforced — the meter would happily read "arXiv 74/60" while call 75 went
 *      out. A cap that is rendered and not checked is not a cap.
 *
 * On pacing, specifically. `insight-corroborate.js:118` and `:129` define
 * `paceArxiv` and `paceRead` at module scope and do not export them; only
 * `createPacer` is exported. Calling `createPacer(4000)` here would build a
 * SECOND independent chain — two requests per four seconds to a service whose
 * published remedy for exceeding one per three is blocking, and which has no
 * account to appeal through. So this file creates no chain of its own: the arXiv
 * and fetch tools call `searchArxiv` and `readHit`, which run inside the chains
 * that already exist, and `PACER_CHAINS` is a registry of who owns each key with
 * a boot assertion that no two entries disagree. When the pacers move to
 * `lib/pace.js` (design §7.1.1), `installPacer()` takes the singletons and
 * nothing else here changes.
 *
 * @see design §7 — the registry, the door, the ACL, recall, the circuit.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath, sep } from "node:path";

import {
  createPacer,
  rateLimitReason,
  readHit,
  searchArxiv,
  searchWeb,
} from "./insight-corroborate.js";
import { verifyQuote } from "./insights.js";
import { admissibleUrl } from "./proxy.js";
import { normalizeUrl } from "./store.js";

/* ── result vocabulary ──────────────────────────────────────────────────── */

/**
 * Every code the door can emit, frozen.
 *
 * A fixed vocabulary because §5.5 classifies failures by counting these, and a
 * code invented at a call site splits that histogram silently — the same reason
 * `verifyQuote` holds its three reasons to three.
 */
export const TOOL_CODES = Object.freeze({
  /** The tool is not in the registry, or the model invented the name. */
  NO_SUCH_TOOL: "no_such_tool",
  /** The agent's ACL does not grant this tool. */
  FORBIDDEN: "forbidden",
  /** The spec's `forbiddenTools` names it. Applied last; nothing may resurrect it. */
  DENIED: "denied",
  /** The tool is banned for the rest of this run, or cooling down process-wide. */
  CIRCUIT_OPEN: "circuit_open",
  /** Arguments did not match the tool's schema. The error says what to send. */
  BAD_ARGS: "bad_args",
  /** A ceiling in the budget pool is spent. Suffixed with the pace key. */
  BUDGET_EXHAUSTED: "budget_exhausted",
  /** Upstream said no — 429, 503, or a metered seam refusing. NOT an empty result. */
  RATE_LIMITED: "rate_limited",
  /** The tool did not answer inside its declared timeout. */
  TIMEOUT: "timeout",
  /** The mission was aborted. `reason` carries `signal.reason`, never a message regex. */
  CANCELLED: "cancelled",
  /** The tool threw, or returned an error of its own. */
  FAILED: "tool_failed",
  /** The same tool with the same arguments, again, for a tool that cannot be cached. */
  REPEAT_CALL: "repeat_call",
  /** A URL the fetch tool must not follow: private range, or the library's own host. */
  URL_REFUSED: "url_refused",
});

/**
 * A refusal: something was asked for and NOT done, with the reason.
 *
 * Distinct in shape from `empty()` on purpose. Any caller that only counts rows
 * treats "the search was blocked" and "the search found nothing" as the same
 * number, and every gate downstream then reports a healthy count for a pass in
 * which nothing happened.
 *
 * @param tool - the tool name.
 * @param code - one of `TOOL_CODES`.
 * @param error - a sentence telling the model what to do about it.
 * @param extra - fields merged in, e.g. `{stopStage: true}`.
 * @returns a frozen `{ok:false, …}` observation.
 */
export function refusal(tool, code, error, extra = {}) {
  return Object.freeze({ ok: false, tool, code, error: String(error), ...extra });
}

/**
 * A successful call that legitimately found nothing.
 * @param tool - the tool name.
 * @param reason - why nothing came back, in the model's terms.
 * @param extra - fields merged in, e.g. `{query}`.
 * @returns a frozen `{ok:true, empty:true, …}` observation.
 */
export function empty(tool, reason, extra = {}) {
  return Object.freeze({ ok: true, tool, empty: true, results: [], reason: String(reason), ...extra });
}

/**
 * A successful call with a payload.
 * @param tool - the tool name.
 * @param payload - the tool's own fields.
 * @returns an `{ok:true, …}` observation. Not frozen: truncation rewrites it.
 */
export function ok(tool, payload) {
  return { ok: true, tool, ...payload };
}

/* ── the pacer registry ─────────────────────────────────────────────────── */

/**
 * Who owns the rate chain for each pace key.
 *
 * `chain: undefined` means DELEGATED: the backend function this file calls
 * already runs inside the one chain that exists, and building another here
 * would double the rate. That is not a placeholder, it is the correct state
 * today — `searchArxiv` runs inside `paceArxiv`, `readHit` runs inside
 * `paceRead`, and both are module-private to `insight-corroborate.js`.
 */
const PACER_CHAINS = new Map([
  ["arxiv", {
    chain: undefined,
    intervalMs: 4000,
    owner: "insight-corroborate.js paceArxiv (module-private; reached via searchArxiv)",
  }],
  ["fetch", {
    chain: undefined,
    intervalMs: 1000,
    owner: "insight-corroborate.js paceRead (module-private; reached via readHit)",
  }],
  ["web", {
    chain: undefined,
    intervalMs: 0,
    owner: "the search plugin behind ctx.get('web') — metered upstream, paced by its vendor",
  }],
]);

/**
 * Hand this file the real pacer singleton for a key.
 *
 * The seam for design §7.1.1: when `paceArxiv`/`paceRead` move to `lib/pace.js`
 * as exported singletons, that module calls `installPacer` once at load and the
 * door starts gating in its own right instead of relying on the backend to do
 * it. Refuses to replace a chain that is already installed with a different
 * object — two chains for one key is the failure this registry exists to make
 * impossible, and silently taking the second one would hide it.
 *
 * @param key - the pace key, e.g. "arxiv".
 * @param chain - a `createPacer()` result: `(thunk) => Promise`.
 * @param options - `{intervalMs, owner}` for the boot assertion's error text.
 * @returns nothing; throws when the key is unknown or already differently owned.
 */
export function installPacer(key, chain, options = {}) {
  const entry = PACER_CHAINS.get(key);
  if (entry === undefined) {
    throw new Error(`installPacer: unknown pace key "${key}". Add it to PACER_CHAINS beside the tool that uses it.`);
  }
  if (typeof chain !== "function") {
    throw new Error(`installPacer("${key}"): chain must be the function returned by createPacer(ms).`);
  }
  if (entry.chain !== undefined && entry.chain !== chain) {
    throw new Error(
      `installPacer("${key}"): a different chain is already installed, owned by ${entry.owner}. `
      + "Two chains for one key double the rate this registry exists to hold. Import the existing singleton instead.",
    );
  }
  entry.chain = chain;
  if (Number.isFinite(options.intervalMs)) entry.intervalMs = Number(options.intervalMs);
  if (typeof options.owner === "string" && options.owner !== "") entry.owner = options.owner;
}

/**
 * The chain and ownership record for a pace key.
 * @param key - the pace key, or null for an ungated tool.
 * @returns the entry, or undefined when the key is not registered.
 */
export function pacerFor(key) {
  return key === null || key === undefined ? undefined : PACER_CHAINS.get(key);
}

/**
 * Run a thunk under its pace key, checking the abort signal at the last moment.
 *
 * The signal check is INSIDE the chained closure, not before the queue. A deep
 * mission can enqueue a hundred arXiv thunks; when the user cancels, every
 * queued thunk still runs — up to ten minutes of continued spend against a
 * mission the UI already shows as cancelled, which `abort()` has no way to
 * reach. Checking on entry to the slot stops all of them.
 *
 * When the key is delegated (`chain === undefined`) the thunk is called
 * directly, because the backend it wraps is already inside the one chain. It is
 * still signal-checked here.
 *
 * @param key - the pace key, or null.
 * @param thunk - the work.
 * @param signal - the mission's abort signal, if any.
 * @returns the thunk's value; rejects with an abort error when cancelled first.
 */
export function paced(key, thunk, signal) {
  const guarded = () => {
    throwIfAborted(signal);
    return thunk();
  };
  const entry = pacerFor(key);
  if (entry === undefined || entry.chain === undefined) return Promise.resolve().then(guarded);
  return entry.chain(guarded);
}

/**
 * Assert the pacer registry is coherent, at boot.
 *
 * Checks the property design §7.1.1 asks for and nothing weaker: that no two
 * registry entries resolve to DIFFERENT chain objects for the same key. A tool
 * may carry its own `pacer` reference; if it does, it must be identical to the
 * registry's, or the tool is silently on a chain of its own.
 *
 * @returns nothing; throws with the offending key named.
 */
export function assertPacerRegistry() {
  for (const tool of listTools()) {
    if (tool.paceKey === null) continue;
    const entry = PACER_CHAINS.get(tool.paceKey);
    if (entry === undefined) {
      throw new Error(`tool "${tool.name}" declares paceKey "${tool.paceKey}" which is not in PACER_CHAINS.`);
    }
    if (tool.pacer !== undefined && tool.pacer !== entry.chain) {
      throw new Error(
        `tool "${tool.name}" carries its own pacer for key "${tool.paceKey}", which is owned by ${entry.owner}. `
        + "Delete the tool's copy: one key, one chain.",
      );
    }
    if (entry.chain === undefined && entry.intervalMs > 0 && !/module-private|metered/u.test(entry.owner)) {
      throw new Error(
        `pace key "${tool.paceKey}" claims an interval of ${entry.intervalMs}ms but has no chain and no delegate. `
        + "Call installPacer() before the first mission, or the rate is not held at all.",
      );
    }
  }
}

/* ── argument validation ────────────────────────────────────────────────── */

/**
 * Validate arguments against the subset of JSON Schema the registry uses.
 *
 * Hand-written because this codebase takes no new dependencies, and because the
 * subset is small and fixed: object at the top, `required`, typed properties,
 * `enum`, string length, numeric range, array items, `additionalProperties:
 * false`. Anything a tool needs beyond this belongs in its `execute` guard, not
 * in a growing validator.
 *
 * The messages are written for the model, which is the only thing that reads
 * them: they name the property and say what to send.
 *
 * @param schema - the tool's `parameters`.
 * @param args - what the model produced.
 * @returns `{ok:true, value}` with defaults applied, or `{ok:false, error}`.
 */
export function validateArgs(schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "arguments must be a JSON object." };
  }
  const properties = schema?.properties ?? {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const value = {};

  if (schema?.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) {
        const known = Object.keys(properties).join(", ");
        return { ok: false, error: `unknown argument "${key}". This tool accepts only: ${known}.` };
      }
    }
  }

  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === "") {
      const spec = properties[name] ?? {};
      const hint = typeof spec.description === "string" && spec.description !== "" ? ` ${spec.description}` : "";
      return { ok: false, error: `"${name}" is required.${hint}` };
    }
  }

  for (const [name, spec] of Object.entries(properties)) {
    const raw = args[name];
    if (raw === undefined || raw === null) {
      if (spec.default !== undefined) value[name] = spec.default;
      continue;
    }
    const checked = checkOne(name, spec, raw);
    if (checked.ok === false) return checked;
    value[name] = checked.value;
  }
  return { ok: true, value };
}

/** One property against one schema fragment. Split out only to keep nesting flat. */
function checkOne(name, spec, raw) {
  const type = spec.type ?? "string";

  if (type === "string") {
    if (typeof raw !== "string") return { ok: false, error: `"${name}" must be a string, got ${typeof raw}.` };
    const text = raw.trim();
    if (Array.isArray(spec.enum) && !spec.enum.includes(text)) {
      return { ok: false, error: `"${name}" must be one of: ${spec.enum.join(", ")}.` };
    }
    if (Number.isFinite(spec.minLength) && text.length < spec.minLength) {
      return { ok: false, error: `"${name}" is too short — send at least ${spec.minLength} characters.` };
    }
    // Over-long is clamped rather than refused: a model that writes a long query
    // has still told us what it wants, and refusing costs a whole round trip to
    // learn a limit it can read in the schema.
    return { ok: true, value: Number.isFinite(spec.maxLength) ? text.slice(0, spec.maxLength) : text };
  }

  if (type === "integer" || type === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return { ok: false, error: `"${name}" must be a number, got ${JSON.stringify(raw)}.` };
    const rounded = type === "integer" ? Math.round(parsed) : parsed;
    const low = Number.isFinite(spec.minimum) ? spec.minimum : -Infinity;
    const high = Number.isFinite(spec.maximum) ? spec.maximum : Infinity;
    // Clamped, for the same reason as maxLength.
    return { ok: true, value: Math.min(high, Math.max(low, rounded)) };
  }

  if (type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
    return { ok: false, error: `"${name}" must be true or false.` };
  }

  if (type === "array") {
    if (!Array.isArray(raw)) return { ok: false, error: `"${name}" must be an array.` };
    const items = spec.items ?? { type: "string" };
    const out = [];
    for (const [index, element] of raw.entries()) {
      const checked = checkOne(`${name}[${index}]`, items, element);
      if (checked.ok === false) return checked;
      out.push(checked.value);
    }
    return { ok: true, value: Number.isFinite(spec.maxItems) ? out.slice(0, spec.maxItems) : out };
  }

  return { ok: true, value: raw };
}

/* ── capabilities and the ACL ───────────────────────────────────────────── */

/**
 * The local permission currency.
 *
 * Playground gates tools on billing entitlements. There is no local referent for
 * that — one user, no tiers, nothing to monetise — but the ENFORCEMENT is worth
 * keeping, so the currency changes to what a tool actually does to this machine.
 */
export const CAPABILITIES = Object.freeze({
  LIBRARY_READ: "library.read",
  LIBRARY_WRITE: "library.write",
  NET_READ: "net.read",
  /** A metered upstream. Holding this is permission to spend somebody's quota. */
  QUOTA_SPEND: "quota.spend",
});

/**
 * Which agent may call what.
 *
 * This table is the ACL doing real work rather than decoration, and two rows are
 * the argument for it:
 *
 *   - A critic that cannot search cannot quietly re-research instead of
 *     criticising. Writer, Reviewer, Reconciler and Analyst hold nothing.
 *   - A verifier that cannot write to the library cannot make a claim true by
 *     adding a source for it.
 *
 * `library_add` belongs to the postlude alone, not to the Researcher: the corpus
 * upsert happens once, after the mission, from `mission_documents`. An agent that
 * could write the library mid-mission could read its own writing back as an
 * independent source, and every independence check downstream would agree.
 */
export const AGENT_GRANTS = Object.freeze({
  researcher: Object.freeze({
    tools: Object.freeze(["library_search", "library_get", "arxiv_search", "web_search", "fetch_page", "quote_verify", "read_spill"]),
    capabilities: Object.freeze([CAPABILITIES.LIBRARY_READ, CAPABILITIES.NET_READ, CAPABILITIES.QUOTA_SPEND]),
  }),
  verifier: Object.freeze({
    tools: Object.freeze(["library_get", "fetch_page", "quote_verify", "read_spill"]),
    capabilities: Object.freeze([CAPABILITIES.LIBRARY_READ, CAPABILITIES.NET_READ]),
  }),
  leader: Object.freeze({
    tools: Object.freeze(["library_search", "read_spill"]),
    capabilities: Object.freeze([CAPABILITIES.LIBRARY_READ]),
  }),
  reconciler: Object.freeze({ tools: Object.freeze([]), capabilities: Object.freeze([]) }),
  analyst: Object.freeze({ tools: Object.freeze([]), capabilities: Object.freeze([]) }),
  writer: Object.freeze({ tools: Object.freeze([]), capabilities: Object.freeze([]) }),
  reviewer: Object.freeze({ tools: Object.freeze([]), capabilities: Object.freeze([]) }),
  // Not an agent. The postlude runs after the terminal write, holds the only
  // write capability in the file, and is never handed to the model.
  postlude: Object.freeze({
    tools: Object.freeze(["library_add"]),
    capabilities: Object.freeze([CAPABILITIES.LIBRARY_WRITE]),
  }),
});

/**
 * The grant record for an agent role.
 * @param agent - the role name, e.g. "researcher".
 * @returns `{tools, capabilities}`; empty arrays for an unknown role, which is
 *   the safe direction — an unrecognised caller gets nothing rather than
 *   everything.
 */
export function grantsFor(agent) {
  // AN INSTANCE IS ITS ROLE FOR THIS PURPOSE. Agent ids are minted per
  // dimension — `researcher:ai-capabilities` — and a grant table keyed on the
  // bare role misses every one of them. The miss is SILENT: the fallback below
  // is an empty grant, so a fan-out whose ids carry a suffix loses every tool
  // and reads as an agent that was never allowed any, rather than as a lookup
  // that failed. That is what happened; this split is why it cannot again.
  const key = String(agent ?? "").toLowerCase().split(":")[0];
  return AGENT_GRANTS[key]
    ?? Object.freeze({ tools: Object.freeze([]), capabilities: Object.freeze([]) });
}

/* ── the registry ───────────────────────────────────────────────────────── */

/** The head-preserving truncation ceiling, in characters, for every tool result. */
const MAX_RESULT_CHARS = 32_000;

/** How many rows of a `results[]` array survive truncation. */
const KEEP_RESULTS = 10;

/**
 * Text we wrote, marked so it can never be quoted as if a publisher wrote it.
 *
 * `ai_summary` is 117 rows of THIS PROGRAM'S model's prose. Quoting it verifies
 * perfectly against itself and attributes our own words to the source — the
 * exact failure `UNQUOTABLE_MARKERS` in `insights.js` was written for. Rather
 * than return it behind a marker string that `insights.js` does not yet know
 * about, the library tools withhold it and SAY SO. A withheld field with a
 * stated reason is a fact the model can act on; a missing field is not.
 */
const AI_SUMMARY_WITHHELD =
  "withheld: ai_summary is this program's own model's prose, not the publisher's words, so it is not quotable evidence";

/**
 * Shape one library row into a lead.
 *
 * A LEAD, not a document. The library has no body-text column: `abstract`
 * averages a couple of hundred characters and 19,179 of 20,696 rows have one,
 * `ai_summary` is ours, and there are fourteen transcripts. So the honest
 * product of a library call is a title, a URL, a date and a short publisher
 * span — enough to source a specific claim and to decide what is worth
 * fetching, not enough to source an argument.
 *
 * @param row - a stored `Resource`.
 * @returns the lead, with the abstract's provenance stated.
 */
function leadOf(row) {
  const abstract = typeof row?.abstract === "string" ? row.abstract.trim() : "";
  const lead = {
    id: String(row?.id ?? ""),
    type: String(row?.type ?? ""),
    title: String(row?.title ?? ""),
    url: String(row?.sourceUrl ?? ""),
    publishedAt: row?.publishedAt ?? null,
    sourceType: row?.sourceType ?? null,
  };
  if (abstract !== "") {
    lead.abstract = abstract;
    // Named on every row rather than documented once, because this is the field
    // a quote may legitimately come from and the next one is not.
    lead.abstractSource = "publisher";
  }
  if (typeof row?.aiSummary === "string" && row.aiSummary.trim() !== "") {
    lead.aiSummary = AI_SUMMARY_WITHHELD;
  }
  return lead;
}

/** The store, or a refusal explaining that this mission was given no library. */
function requireStore(ctx, tool) {
  const store = ctx?.store;
  if (store === undefined || store === null || typeof store.query !== "function") {
    return refusal(tool, TOOL_CODES.FAILED, "the local library is not open for this mission. Report this and continue with network sources.");
  }
  return store;
}

/**
 * Every tool, frozen. Seven from the design plus `read_spill`, which exists
 * because head-preserving truncation without a way to read the tail is a dead
 * end dressed up as a preview.
 *
 * `whenToUse` carries NO numbers. It is generated into the prompt at recall
 * time, and every number and every shape belongs to the duty and to the JSON
 * Schema below it — prose that repeats a limit is prose that drifts from it.
 */
export const TOOLS = Object.freeze({

  library_search: Object.freeze({
    name: "library_search",
    description: "Search the local source library by title, abstract or summary text. Returns leads: title, URL, date, and the publisher's abstract where there is one.",
    whenToUse: "First, always. It is free, instant, cannot fail, and it tells you what has already been collected on this topic — including which URLs are worth spending a fetch on.",
    category: "retrieval",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200, description: "Words that would appear in a title or abstract. Not a sentence." },
        type: { type: "string", enum: ["PAPER", "BLOG", "REPORT", "YOUTUBE_VIDEO", "NEWS", "PROJECT", "EVENT", "RSS", "POLICY"], description: "Narrow to one resource type." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    }),
    sideEffect: "none",
    capabilities: Object.freeze([CAPABILITIES.LIBRARY_READ]),
    paceKey: null,
    circuit: Object.freeze({ threshold: 3, openMs: 0 }),
    defaultTimeoutMs: 5_000,
    maxResultChars: MAX_RESULT_CHARS,
    maturity: "real",
    execute(args, ctx) {
      const store = requireStore(ctx, "library_search");
      if (store.ok === false) return store;
      const answer = store.query({ search: args.query, type: args.type, take: args.limit });
      const rows = Array.isArray(answer?.rows) ? answer.rows : [];
      if (rows.length === 0) {
        return empty("library_search", `the library holds nothing matching "${args.query}". Try fewer or more common words, or search arXiv.`, { query: args.query });
      }
      return ok("library_search", { query: args.query, total: answer.total, results: rows.map(leadOf) });
    },
  }),

  library_get: Object.freeze({
    name: "library_get",
    description: "Read one library row: title, URL, date, authors, and the publisher's abstract. This is NOT the document text — the library stores no body text.",
    whenToUse: "After a search, to see a row's full abstract and authors before deciding whether to fetch the page. If you need words to quote, fetch the page.",
    category: "retrieval",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200, description: "The id from a library_search result." },
      },
    }),
    sideEffect: "none",
    capabilities: Object.freeze([CAPABILITIES.LIBRARY_READ]),
    paceKey: null,
    circuit: Object.freeze({ threshold: 3, openMs: 0 }),
    defaultTimeoutMs: 5_000,
    maxResultChars: MAX_RESULT_CHARS,
    maturity: "real",
    execute(args, ctx) {
      const store = requireStore(ctx, "library_get");
      if (store.ok === false) return store;
      const row = store.get(args.id);
      if (row === undefined) {
        return refusal("library_get", TOOL_CODES.FAILED, `no library row has id "${args.id}". Use an id returned by library_search.`);
      }
      const lead = leadOf(row);
      lead.authors = row.authors ?? null;
      // Stated on the row rather than left to the prompt, because "it returned
      // a document" is the assumption this tool most invites.
      lead.bodyText = "not stored; the library is a lead index. Use fetch_page on the URL to obtain quotable text.";
      return ok("library_get", lead);
    },
  }),

  library_add: Object.freeze({
    name: "library_add",
    description: "Insert one fetched document into the local source library.",
    whenToUse: "Never during a mission. The postlude holds this so the corpus grows from what a mission read, after the mission has already ended.",
    category: "write",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "url"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 500 },
        url: { type: "string", minLength: 4, maxLength: 2000 },
        type: { type: "string", enum: ["PAPER", "BLOG", "REPORT", "YOUTUBE_VIDEO", "NEWS", "PROJECT", "EVENT", "RSS", "POLICY"], default: "NEWS" },
        abstract: { type: "string", maxLength: 8000 },
        publishedAt: { type: "string", maxLength: 40 },
      },
    }),
    sideEffect: "destructive",
    capabilities: Object.freeze([CAPABILITIES.LIBRARY_WRITE]),
    paceKey: null,
    circuit: Object.freeze({ threshold: 3, openMs: 0 }),
    defaultTimeoutMs: 5_000,
    maxResultChars: MAX_RESULT_CHARS,
    maturity: "real",
    execute(args, ctx) {
      const store = requireStore(ctx, "library_add");
      if (store.ok === false) return store;
      const row = {
        id: args.id,
        type: args.type ?? "NEWS",
        title: args.title,
        sourceUrl: args.url,
        abstract: args.abstract ?? null,
        publishedAt: args.publishedAt ?? null,
      };
      const written = store.put(row);
      if (written === true) return ok("library_add", { id: args.id, written: true });
      // `store.put` returns a bare false for two different reasons, and a
      // postlude that logged "0 written" would never tell them apart. Re-derive
      // which one it was: a function that can silently do nothing has to say why.
      const normalized = normalizeUrl(args.url);
      const clash = normalized === undefined || normalized === null
        ? undefined
        : store.db.prepare("SELECT id FROM resources WHERE normalized_url = ?").get(normalized);
      const why = clash !== undefined && clash.id !== args.id
        ? `the library already holds this URL under id "${clash.id}"`
        : "the row is missing one of id, title or url";
      return refusal("library_add", TOOL_CODES.FAILED, `not written: ${why}.`, { id: args.id, written: false });
    },
  }),

  arxiv_search: Object.freeze({
    name: "arxiv_search",
    description: "Search arXiv for papers. Returns titles, abstracts and arXiv URLs. No key and no account is needed.",
    whenToUse: "For anything scientific or technical, and for finding the primary paper behind a claim a news article is reporting second-hand.",
    category: "retrieval",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 2,
          maxLength: 400,
          description: "An arXiv query. Use `all:term AND all:\"two words\"`; unquoted multi-word terms are read as an implicit OR and return the whole category.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 6 },
      },
    }),
    sideEffect: "none",
    capabilities: Object.freeze([CAPABILITIES.NET_READ]),
    paceKey: "arxiv",
    // Thirty minutes, declared by the tool because the tool is the thing that
    // knows its upstream: arXiv's published remedy for exceeding its rate is
    // blocking, and there is no account to appeal through.
    circuit: Object.freeze({ threshold: 3, openMs: 1_800_000 }),
    defaultTimeoutMs: 20_000,
    maxResultChars: MAX_RESULT_CHARS,
    maturity: "real",
    async execute(args, ctx) {
      // The signal reaches the socket by way of `fetchImpl`, and `searchArxiv`
      // still runs that closure INSIDE `paceArxiv` — so this is signal-aware
      // without building a second chain. Passing a fetchImpl to `readHit` would
      // do the opposite; see `fetch_page`.
      const answer = await searchArxiv(args.query, {
        maxResults: args.limit,
        fetchImpl: (url, init) => fetch(url, { ...init, signal: composeSignals(init?.signal, ctx.signal) }),
      });
      if (answer.rateLimited === true) {
        return refusal("arxiv_search", TOOL_CODES.RATE_LIMITED, `${answer.error}. Stop searching arXiv for now and use what you already have.`, { stopStage: true });
      }
      if (answer.error !== "") {
        return refusal("arxiv_search", TOOL_CODES.FAILED, `${answer.error}. Try the library or the web seam instead.`);
      }
      if (answer.hits.length === 0) {
        return empty("arxiv_search", `arXiv matched nothing for that query. Broaden it — drop the rarest term, or use OR between two of them.`, { query: args.query });
      }
      return ok("arxiv_search", { query: args.query, results: answer.hits });
    },
  }),

  web_search: Object.freeze({
    name: "web_search",
    description: "Search the open web through the installed search plugin. Returns titles, URLs and snippets.",
    whenToUse: "For anything recent, commercial or governmental that arXiv will not have. Snippets are never evidence — fetch the page for words you intend to quote.",
    category: "retrieval",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 300, description: "A plain search query, as you would type it." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 6 },
      },
    }),
    sideEffect: "none",
    // Holding `quota.spend` is the point: this is somebody's metered allowance.
    capabilities: Object.freeze([CAPABILITIES.NET_READ, CAPABILITIES.QUOTA_SPEND]),
    paceKey: "web",
    circuit: Object.freeze({ threshold: 3, openMs: 900_000 }),
    defaultTimeoutMs: 20_000,
    maxResultChars: MAX_RESULT_CHARS,
    maturity: "real",
    async execute(args, ctx) {
      const web = ctx?.web;
      if (web === undefined || typeof web?.search !== "function") {
        // Absent, not failed. The mission states the absence in its provenance
        // rather than quietly corroborating from arXiv alone and reporting the
        // same confidence it would have reported with both.
        return refusal("web_search", TOOL_CODES.FAILED, "no web search plugin is installed, so this tool is unavailable for this whole mission. Use arxiv_search and the library.");
      }
      // `WebSearchResult` exposes no quota fields and the harness surfaces a
      // refusal as a thrown `WebError extends HarnessError {code, status}`.
      // Route on `.code`, never on the message: a vendor changing its wording
      // must not turn an exhausted allowance into "the web has nothing".
      let raw;
      const tapped = {
        search: async (request) => {
          try {
            return await web.search({ ...request, signal: ctx.signal });
          } catch (cause) {
            raw = cause;
            throw cause;
          }
        },
      };
      const answer = await searchWeb(tapped, args.query, { maxResults: args.limit });
      const code = String(raw?.code ?? "");
      const status = Number(raw?.status ?? 0);
      const limited = answer.rateLimited === true
        || status === 429
        || /rate.?limit|quota|too.?many/iu.test(code);
      if (limited === true) {
        return refusal("web_search", TOOL_CODES.RATE_LIMITED, `${answer.error || code}. This is a fact about this installation's search allowance, not about the topic — record it and stop searching the web.`, { stopStage: true, providerCode: code || null });
      }
      if (answer.error !== "") {
        return refusal("web_search", TOOL_CODES.FAILED, `${answer.error}. Use arxiv_search or the library instead.`, { providerCode: code || null });
      }
      if (answer.hits.length === 0) {
        return empty("web_search", "the search returned no results. Rephrase with different words, or try arxiv_search.", { query: args.query });
      }
      return ok("web_search", { query: args.query, results: answer.hits });
    },
  }),

  fetch_page: Object.freeze({
    name: "fetch_page",
    description: "Fetch one URL and extract the publisher's own article text, reader-mode style.",
    whenToUse: "This is the ONLY source of text long enough to quote from. Every finding that has to survive verification needs one of these behind it. Fetch the primary source, not a write-up of it.",
    category: "retrieval",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 8, maxLength: 2000, description: "An http or https URL from a search result or a library row." },
        title: { type: "string", maxLength: 500, description: "The title you already have for it, if any." },
      },
    }),
    sideEffect: "none",
    capabilities: Object.freeze([CAPABILITIES.NET_READ]),
    paceKey: "fetch",
    circuit: Object.freeze({ threshold: 3, openMs: 600_000 }),
    // Longer than the others because a fetch is a network round trip plus a
    // jsdom parse, and the parse is the larger term.
    defaultTimeoutMs: 45_000,
    maxResultChars: MAX_RESULT_CHARS,
    maturity: "real",
    async execute(args, ctx) {
      const admitted = admissibleUrl(args.url);
      if (admitted === undefined) {
        return refusal("fetch_page", TOOL_CODES.URL_REFUSED, `"${args.url}" is not a public http(s) URL. Fetch published pages only.`);
      }
      // The model picks these URLs now, which is a different threat model from
      // the one `admissibleUrl` was written under: on a machine whose own
      // library is served over a tailnet, the library's host is a perfectly
      // ordinary public-looking name. Deny it explicitly.
      const host = admitted.hostname.toLowerCase();
      const denied = (ctx?.denyHosts ?? []).some((entry) => {
        const bare = String(entry ?? "").toLowerCase().trim();
        return bare !== "" && (host === bare || host.endsWith(`.${bare}`));
      });
      if (denied === true) {
        return refusal("fetch_page", TOOL_CODES.URL_REFUSED, `"${host}" is this installation's own infrastructure and is not a source. Fetch a published page instead.`);
      }
      // No `fetchImpl`: passing one bypasses `paceRead` entirely, and an
      // unpaced fetch loop aimed at the publishers this library is built from is
      // a worse outcome than a cancel that takes one in-flight request to land.
      // The abort is enforced at the door instead. See the header note.
      // THE TOOL'S OWN CEILING, ASKED FOR EXPLICITLY. `readHit`'s default is
      // the corroboration path's per-source budget — three pages into one
      // prompt, 4,000 characters each — and this tool silently inherited it
      // for years. It declares `maxResultChars: MAX_RESULT_CHARS` eleven lines
      // above and was handed an eighth of it, so every page fetched for
      // quoting was cut to its first seven hundred words: the substrate
      // `quotableAgainst` names, the substrate `quote_verify` checks against,
      // and the substrate `putDocument` keeps as the copy we read.
      const doc = await readHit({ url: admitted.href, title: args.title ?? "" }, { budgetChars: MAX_RESULT_CHARS });
      if (doc === undefined) {
        return empty("fetch_page", "nothing readable came back — a paywall, a login wall, a PDF, or a page with no article body. Try a different source for this claim.", { url: admitted.href });
      }
      if (doc.throttled === true) {
        return refusal("fetch_page", TOOL_CODES.RATE_LIMITED, `${host} declined the request. Do not retry it; use another source.`, { stopStage: true, url: admitted.href });
      }
      return ok("fetch_page", {
        url: doc.url,
        title: doc.title,
        text: doc.text,
        textSource: "publisher",
        // Named because the verifier's span rule runs against exactly this
        // string, and a quote checked against a different extraction of the
        // same page is a quote checked against nothing.
        quotableAgainst: doc.url,
        // THE KEY THE LITERAL HAS TO NAME. `ok(tool, payload)` builds
        // `{ok:true, tool, ...payload}`, so a key this object does not
        // mention is a key that does not exist downstream — the extractor
        // above it would be correct and the rest of the chain permanently
        // empty, with nothing anywhere failing.
        //
        // METADATA, NOT MARKUP, AND NOT IN `text`. The researcher can see
        // that a page carries a figure and what its caption says, which is
        // what lets it cite one deliberately; `text` above is untouched, and
        // it is the string `quotableAgainst` names.
        figures: Array.isArray(doc.figures) ? doc.figures : [],
      });
    },
  }),

  quote_verify: Object.freeze({
    name: "quote_verify",
    description: "Check that a quote is verbatim inside one contiguous span of the source it is attributed to.",
    whenToUse: "Before you attach a quote to a finding. A quote that spans two sections of a page is a splice, not a quote, and this is what says so.",
    category: "verification",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["quote"],
      properties: {
        quote: { type: "string", minLength: 1, maxLength: 2000, description: "The exact words, as they appear in the source." },
        sourceId: { type: "string", maxLength: 200, description: "The source you are attributing it to. Omit only if you genuinely do not know." },
      },
    }),
    sideEffect: "none",
    capabilities: Object.freeze([]),
    paceKey: null,
    circuit: Object.freeze({ threshold: 3, openMs: 0 }),
    defaultTimeoutMs: 5_000,
    maxResultChars: MAX_RESULT_CHARS,
    maturity: "real",
    execute(args, ctx) {
      const blocks = ctx?.blocks;
      const size = blocks instanceof Map ? blocks.size : Object.keys(blocks ?? {}).length;
      if (size === 0) {
        // Not "unverified". Nothing was checked, and a verify state of
        // "unchecked" is a different value from "failed" all the way up.
        return refusal("quote_verify", TOOL_CODES.FAILED, "no source text is loaded for this step, so nothing can be checked. Fetch the page first.");
      }
      const verdict = verifyQuote(args.quote, blocks, args.sourceId);
      if (verdict.ok === true) return ok("quote_verify", { verified: true, sourceId: verdict.resourceId });
      return ok("quote_verify", {
        verified: false,
        reason: verdict.reason,
        advice: verdict.reason === "too short"
          ? "Quote more words — a fragment this short cannot identify a source."
          : "Copy the words exactly as they appear, from one paragraph, without joining two.",
      });
    },
  }),

  read_spill: Object.freeze({
    name: "read_spill",
    description: "Read a window of a result that was too large to return in full.",
    whenToUse: "When a result came back with a spill path. The preview is a window, not the whole thing; this moves the window.",
    category: "utility",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 500, description: "The spill path exactly as it was given to you." },
        offset: { type: "integer", minimum: 0, default: 0 },
        length: { type: "integer", minimum: 200, maximum: 32_000, default: 8_000 },
      },
    }),
    sideEffect: "none",
    capabilities: Object.freeze([]),
    paceKey: null,
    circuit: Object.freeze({ threshold: 3, openMs: 0 }),
    defaultTimeoutMs: 5_000,
    maxResultChars: MAX_RESULT_CHARS,
    maturity: "real",
    execute(args, ctx) {
      return readSpill(args.path, args.offset, args.length, ctx?.spillDir);
    },
  }),
});

/**
 * One tool definition.
 * @param name - the tool id.
 * @returns the frozen definition, or undefined.
 */
export function getTool(name) {
  return Object.hasOwn(TOOLS, String(name ?? "")) ? TOOLS[name] : undefined;
}

/**
 * Every registered tool.
 * @returns the definitions, in declaration order.
 */
export function listTools() {
  return Object.values(TOOLS);
}

/**
 * Assert the registry, the ACL and the pacers agree, at boot.
 *
 * These are contract tests that cost microseconds and are worth running for
 * real at startup rather than only in CI, because the thing they catch — an ACL
 * row naming a tool that was renamed — is invisible until a mission is halfway
 * through a stage and a tool the model was offered refuses to exist.
 *
 * @returns nothing; throws with the specific disagreement named.
 */
export function assertRegistry() {
  for (const tool of listTools()) {
    if (tool.maturity !== "real") {
      throw new Error(`tool "${tool.name}" is maturity "${tool.maturity}". A stub must not be registered — remove it or finish it.`);
    }
    if (typeof tool.execute !== "function") {
      throw new Error(`tool "${tool.name}" has no execute().`);
    }
    if (tool.parameters?.additionalProperties !== false) {
      throw new Error(`tool "${tool.name}" must set additionalProperties:false, or an invented argument reaches execute() unchecked.`);
    }
  }
  for (const [agent, grant] of Object.entries(AGENT_GRANTS)) {
    for (const name of grant.tools) {
      const tool = getTool(name);
      if (tool === undefined) {
        throw new Error(`the ACL grants "${agent}" a tool named "${name}" which is not in the registry.`);
      }
      // The structural half of the ACL: a grant that names a tool the agent
      // lacks the capability for is a row that reads as permission and denies
      // at invoke. Catch it here, not in a mission.
      for (const capability of tool.capabilities) {
        if (!grant.capabilities.includes(capability)) {
          throw new Error(
            `the ACL grants "${agent}" the tool "${name}", which needs capability "${capability}" that "${agent}" does not hold. `
            + "Grant the capability or drop the tool: a row that denies at invoke is worse than no row.",
          );
        }
      }
    }
  }
  assertPacerRegistry();
}

/* ── recall ─────────────────────────────────────────────────────────────── */

/**
 * The recommended order, by facet. Not a matrix, and not the model's choice.
 *
 * Playground's audit found its researcher could see about twenty information
 * tools and used one of them, and its own diagnosis was that the cause was not
 * filtering but that the choice was entirely LLM self-selection on top of a
 * Leader guessing. Worse, its tag fallback excluded every academic tool for 332
 * consecutive production missions because a Leader hint of
 * `['web','policy','community']` never intersected tags of
 * `['academic','research']`.
 *
 * The lesson taken here is not "port the repair". It is: DO NOT LET A MODEL'S
 * GUESS NARROW A CATALOGUE AT ALL. The Leader picks a facet, this decides the
 * order, and the code overwrites whatever the Leader guessed.
 */
export const FACET_TOOL_ORDER = Object.freeze({
  scientific: Object.freeze(["library_search", "arxiv_search", "fetch_page", "web_search"]),
  technical: Object.freeze(["library_search", "arxiv_search", "fetch_page", "web_search"]),
  commercial: Object.freeze(["library_search", "web_search", "fetch_page"]),
  policy: Object.freeze(["library_search", "web_search", "fetch_page"]),
  social: Object.freeze(["library_search", "web_search", "fetch_page"]),
  default: Object.freeze(["library_search", "web_search", "fetch_page"]),
});

/**
 * Decide which tools an agent may see this turn, and in what order.
 *
 * Five subtractive steps and no additive one. `forbiddenTools` is applied LAST
 * and that ordering is the single genuine lesson from the reference's incident:
 * a fallback must never be able to resurrect a denied tool. Both `forbid` and
 * `circuit` subtract, so what is actually enforced is the invariant that
 * NOTHING AFTER `forbid` CAN ADD.
 *
 * @param options - `{agent, spec, web, circuit, facet}`; `spec` carries
 *   `{tools, forbiddenTools}`, `web` is the resolved `ctx.get("web")` value.
 * @returns `{tools, recommended, notices, webAvailable}` — `notices` are
 *   sentences for the next observation, never a silently narrowed catalogue.
 */
export function recallTools(options = {}) {
  const { agent, spec = {}, web, circuit, facet } = options;
  const grant = grantsFor(agent);
  const notices = [];

  // 1. base — a literal list, from the spec if it names one, else the ACL's.
  const base = Array.isArray(spec.tools) && spec.tools.length > 0 ? spec.tools : grant.tools;
  let names = [...new Set(base.map((name) => String(name)))];

  // 2. resolve — the web seam is answered for RIGHT NOW, not at apply() time.
  //    Absent is a different thing from failed, and the difference goes into
  //    the mission's provenance rather than quietly reducing corroboration.
  const webAvailable = web !== undefined && web !== null && typeof web.search === "function";
  if (!webAvailable && names.includes("web_search")) {
    names = names.filter((name) => name !== "web_search");
    notices.push("web_search is not available: no search plugin is installed. Corroboration this mission comes from arXiv and the library alone.");
  }

  // 3. capability — and unknown ids die here, so an ACL typo is not a tool.
  names = names.filter((name) => {
    const tool = getTool(name);
    if (tool === undefined) return false;
    return tool.capabilities.every((capability) => grant.capabilities.includes(capability));
  });

  // 4. circuit — banned tools leave the catalogue AND the model is told why.
  //    Regenerating the catalogue from a Map costs microseconds here; the
  //    reference could not afford it because re-rendering meant re-sending a
  //    prompt block it paid for.
  if (circuit !== undefined && circuit !== null) {
    names = names.filter((name) => {
      const state = circuit.stateOf(name);
      if (state.usable === true) return true;
      notices.push(`${name} is unavailable for the rest of this run: ${state.reason}`);
      return false;
    });
  }

  // 5. forbid — LAST. See the docblock.
  const forbidden = new Set((spec.forbiddenTools ?? []).map((name) => String(name)));
  names = names.filter((name) => !forbidden.has(name));

  const order = FACET_TOOL_ORDER[String(facet ?? "").toLowerCase()] ?? FACET_TOOL_ORDER.default;
  const recommended = order.filter((name) => names.includes(name));

  return {
    tools: names.map((name) => getTool(name)),
    recommended,
    notices,
    webAvailable,
    // An empty pool is not an error here — it is the loop's cue to stop, and the
    // reason has to travel with it or the run ends with "no progress".
    exhausted: names.length === 0,
  };
}

/* ── the failure circuit ────────────────────────────────────────────────── */

/**
 * The one persisted piece of tool health.
 *
 * One row, not a table with a transition log. Revision 1 of the design had a
 * per-run map, a per-process breaker, per-tool metadata AND a `tool_health`
 * table mirroring every transition — a subsystem for three network tools, one
 * of which is optional. The single thing worth surviving a restart is a
 * RATE-LIMIT ban, because a process that restarts into a 429 and immediately
 * re-requests is how an anonymous client gets blocked outright.
 */
export const TOOL_COOLDOWN_DDL = `
CREATE TABLE IF NOT EXISTS tool_cooldowns (
  tool       TEXT PRIMARY KEY,
  open_until TEXT NOT NULL,
  reason     TEXT NOT NULL
) STRICT;
`;

/**
 * Build the circuit for one run.
 *
 * TWO layers, and they behave differently on purpose:
 *
 *   - PER RUN: `Map<tool, consecutiveFailures>`, reset on success, tripped at
 *     the tool's threshold, and then BANNED FOR THE REST OF THE RUN with no
 *     half-open probe. A tool that has failed three times in one mission has
 *     told us something about this mission, and re-probing it mid-run is how a
 *     run spends its iteration budget rediscovering the same outage.
 *
 *   - PER PROCESS, persisted: only a rate-limit trip, and only for a tool that
 *     declares an `openMs`. This one is a real three-state machine —
 *     closed → open → half-open → closed or open — because the thing it models
 *     is an upstream that recovers on its own clock and the correct behaviour
 *     after the clock runs out is exactly one careful request.
 *
 * The per-run ban dominates: a tool banned for the run is not probed even when
 * its cooldown expires, because within one mission the run's evidence is more
 * recent than the clock's.
 *
 * Counted from PER-CALL sub-results, never from a batch aggregate. Playground
 * counts `!!actionResult.error` for a whole parallel batch, and its `invokeMany`
 * only sets that error when EVERY sub-call failed — so in a mixed batch the
 * failing tool's counter resets every time a sibling succeeds, and its own
 * documented acceptance criterion for per-tool independence does not hold.
 *
 * @param options - `{db, now}`; `db` is a `DatabaseSync` holding `tool_cooldowns`.
 * @returns the circuit: `stateOf`, `recordFailure`, `recordSuccess`, `drainNotices`.
 */
/**
 * What to use instead of a tool that is unavailable.
 *
 * Same category, excluding the tool itself. A one-clause sentence rather than a
 * list, because it is read by a model mid-turn and the point is to keep it
 * working, not to enumerate the registry.
 *
 * @param name - the unavailable tool.
 * @returns a leading-space sentence, or "" when there is genuinely nothing else.
 */
function substitutesFor(name) {
  const category = getTool(name)?.category;
  const others = listTools()
    .filter((tool) => tool.name !== name && tool.category === category && tool.sideEffect !== "destructive")
    .map((tool) => tool.name);
  if (others.length === 0) return "";
  const last = others.pop();
  const list = others.length === 0 ? last : `${others.join(", ")} or ${last}`;
  return ` Use ${list} instead.`;
}

export function createCircuit(options = {}) {
  const { db } = options;
  const now = typeof options.now === "function" ? options.now : () => new Date();

  /** consecutive failures this run, per tool. */
  const failures = new Map();
  /** tools banned for the rest of this run, with the reason. */
  const banned = new Map();
  /** sentences owed to the model's next observation. */
  const notices = [];
  /** tool -> ISO string, loaded once at construction. Kept in memory so the
   *  hot path does not hit SQLite on every call. */
  const cooldowns = new Map();
  /** tools currently allowed exactly one probe. */
  const probing = new Set();

  if (db !== undefined && db !== null) {
    db.exec(TOOL_COOLDOWN_DDL);
    for (const row of db.prepare("SELECT tool, open_until, reason FROM tool_cooldowns").all()) {
      cooldowns.set(row.tool, { openUntil: row.open_until, reason: row.reason });
    }
  }

  /** Write or clear the persisted row. No BEGIN: see the note in `recordFailure`. */
  function persist(tool, entry) {
    if (db === undefined || db === null) return;
    if (entry === undefined) {
      db.prepare("DELETE FROM tool_cooldowns WHERE tool = ?").run(tool);
      return;
    }
    db.prepare(
      "INSERT INTO tool_cooldowns (tool, open_until, reason) VALUES (?, ?, ?) "
      + "ON CONFLICT(tool) DO UPDATE SET open_until = excluded.open_until, reason = excluded.reason",
    ).run(tool, entry.openUntil, entry.reason);
  }

  return {
    /**
     * Whether a tool may be called, and if not, why.
     * @param name - the tool id.
     * @returns `{usable, state, reason}` — `state` is closed | open | half-open.
     */
    stateOf(name) {
      // Every unusable answer names substitutes, on BOTH paths. The first draft
      // named them only on the cooldown path, so a tool rate-limited earlier in
      // the same run reported "unavailable" with nothing to do instead — which
      // is how a model decides to stop researching rather than to research
      // differently, and it is the same dead end the reference's exit policy
      // promises to avoid.
      const ban = banned.get(name);
      if (ban !== undefined) return { usable: false, state: "open", reason: `${ban}.${substitutesFor(name)}` };

      const cooling = cooldowns.get(name);
      if (cooling === undefined) return { usable: true, state: "closed", reason: "" };

      const remainingMs = Date.parse(cooling.openUntil) - now().getTime();
      if (remainingMs > 0) {
        const minutes = Math.ceil(remainingMs / 60_000);
        return {
          usable: false,
          state: "open",
          reason: `${cooling.reason}; cooling down for about ${minutes} more minute(s).${substitutesFor(name)}`,
        };
      }
      // The clock ran out, so the tool is usable again — but only as a probe.
      // `stateOf` does NOT record that here: `recallTools` calls it to render a
      // catalogue, and a read that spends the single probe allowance would burn
      // it on a tool the model then never called. `markProbe` is the write.
      return { usable: true, state: "half-open", reason: "cooling down expired; the next call is a single probe" };
    },

    /**
     * Claim the single probe allowance for a half-open tool.
     *
     * Called by the door immediately before a half-open tool actually runs, so
     * exactly one request goes out to find out whether the upstream recovered —
     * not the four the model would otherwise issue at once the moment the
     * catalogue opened again.
     * @param name - the tool id.
     * @returns nothing.
     */
    markProbe(name) {
      probing.add(name);
    },

    /**
     * Record one FAILED sub-call.
     * @param name - the tool id.
     * @param code - the failure code from `TOOL_CODES`.
     * @param detail - the error sentence, for the notice.
     * @returns nothing.
     */
    recordFailure(name, code, detail) {
      const tool = getTool(name);
      const threshold = tool?.circuit?.threshold ?? 3;
      const openMs = tool?.circuit?.openMs ?? 0;

      // A half-open probe that fails re-opens the cooldown at full length,
      // immediately — it does not get to spend the run's three attempts first.
      const wasProbing = probing.delete(name);

      if (code === TOOL_CODES.RATE_LIMITED && openMs > 0) {
        const openUntil = new Date(now().getTime() + openMs).toISOString();
        const entry = { openUntil, reason: `${name} was rate-limited` };
        cooldowns.set(name, entry);
        // Written outside any transaction, deliberately. Three modules share
        // one connection and a nested BEGIN destroys the outer write —
        // reproduced: the inner catch's ROLLBACK kills the outer transaction
        // and the outer COMMIT throws. This is one atomic statement and needs
        // none; §5.0's rule that no transaction spans an await guarantees no
        // transaction is open while a tool call is in flight.
        persist(name, entry);
        banned.set(name, entry.reason);
        notices.push(`${name} was rate-limited and is unavailable for the rest of this run.${substitutesFor(name)}`);
        return;
      }
      if (wasProbing === true && cooldowns.has(name)) {
        const openUntil = new Date(now().getTime() + openMs).toISOString();
        const entry = { openUntil, reason: `${name} failed its recovery probe` };
        cooldowns.set(name, entry);
        persist(name, entry);
        banned.set(name, entry.reason);
        notices.push(`${name} is still failing and is unavailable for the rest of this run.${substitutesFor(name)}`);
        return;
      }

      const count = (failures.get(name) ?? 0) + 1;
      failures.set(name, count);
      if (count < threshold) return;
      const reason = `${name} failed ${count} times in a row (${code}: ${detail})`;
      banned.set(name, reason);
      // Ban the tool, not the run. Terminating the run belongs to the loop, and
      // only when the recalled pool is empty — which is what the reference's own
      // exit policy promises ("other tools are unaffected") and its loop never
      // implemented.
      notices.push(`${reason}. It is unavailable for the rest of this run; use the other tools you were given.`);
    },

    /**
     * Record one SUCCEEDED sub-call. Resets the run counter and closes a probe.
     * @param name - the tool id.
     * @returns nothing.
     */
    recordSuccess(name) {
      failures.delete(name);
      if (probing.delete(name) === true && cooldowns.delete(name) === true) {
        persist(name, undefined);
        notices.push(`${name} recovered and is available again.`);
      }
    },

    /**
     * Take the sentences owed to the model and clear them.
     * @returns the notices, oldest first. Empty when there is nothing to say.
     */
    drainNotices() {
      return notices.splice(0, notices.length);
    },

    /** Tools banned for the rest of this run, for the read model. */
    bannedTools() {
      return [...banned.keys()];
    },
  };
}

/* ── truncation and spill ───────────────────────────────────────────────── */

/** Spill file names, so `read_spill` can refuse anything that is not one. */
const SPILL_NAME = /^spill-[0-9a-f]{16}-\d{13}\.txt$/u;

/**
 * Bring a result under the tool's character ceiling, preserving the head.
 *
 * Not stringify-and-slice, which destroys structure and hands the model a
 * truncated JSON document it will then try to parse. Two shapes:
 *
 *   - A result with a `results[]` array keeps the first rows and says how many
 *     it dropped. Search results are ordered by relevance; the tail is the part
 *     that mattered least.
 *   - Anything else spills to a file beside the database, and the model gets a
 *     preview PLUS a path — and `read_spill` makes that a window rather than a
 *     dead end.
 *
 * @param result - the tool's observation.
 * @param tool - the tool definition.
 * @param spillDir - where spill files live, or undefined.
 * @returns the same result, or a truncated copy, always under the ceiling.
 */
export function truncateResult(result, tool, spillDir) {
  const ceiling = tool?.maxResultChars ?? MAX_RESULT_CHARS;
  let encoded = safeStringify(result);
  if (encoded.length <= ceiling) return result;

  if (Array.isArray(result.results) && result.results.length > KEEP_RESULTS) {
    const total = result.results.length;
    const trimmed = { ...result, results: result.results.slice(0, KEEP_RESULTS) };
    trimmed._resultsTruncated = { kept: KEEP_RESULTS, total, reason: "the result exceeded the size ceiling; the highest-ranked rows were kept" };
    encoded = safeStringify(trimmed);
    if (encoded.length <= ceiling) return trimmed;
    return spillOf(trimmed, encoded, ceiling, spillDir);
  }
  return spillOf(result, encoded, ceiling, spillDir);
}

/** Write the oversized body out and return a preview plus a path. */
function spillOf(result, encoded, ceiling, spillDir) {
  const preview = encoded.slice(0, Math.max(1_000, ceiling - 1_000));
  if (typeof spillDir !== "string" || spillDir === "") {
    // No path to offer, so say that rather than handing over a preview the
    // model will assume is the whole answer.
    return {
      ok: result.ok,
      tool: result.tool,
      preview,
      _truncated: {
        totalChars: encoded.length,
        reason: "the result exceeded the size ceiling and no spill directory is configured, so the tail is unavailable. Narrow the query.",
      },
    };
  }
  const digest = createHash("sha256").update(encoded).digest("hex").slice(0, 16);
  const file = join(spillDir, `spill-${digest}-${String(Date.now()).padStart(13, "0")}.txt`);
  mkdirSync(spillDir, { recursive: true });
  writeFileSync(file, encoded, "utf8");
  return {
    ok: result.ok,
    tool: result.tool,
    preview,
    _truncated: {
      totalChars: encoded.length,
      path: file,
      reason: "the result exceeded the size ceiling. This is the head; call read_spill with this path to move the window.",
    },
  };
}

/**
 * Read a window of a spilled result.
 *
 * The path comes from the MODEL, so this is a file-read primitive with a model
 * on the other end of it. Two guards, both mandatory: the resolved path must sit
 * inside the configured spill directory, and its name must be one this file
 * wrote. Neither is a formality — without them `read_spill` reads the library
 * database, the settings file, or anything else on this machine.
 *
 * @param path - the spill path exactly as it was handed out.
 * @param offset - characters to skip.
 * @param length - characters to return.
 * @param spillDir - the configured spill directory.
 * @returns an observation with the window, or a refusal saying which guard failed.
 */
export function readSpill(path, offset, length, spillDir) {
  if (typeof spillDir !== "string" || spillDir === "") {
    return refusal("read_spill", TOOL_CODES.FAILED, "no spill directory is configured for this mission, so there is nothing to read.");
  }
  const root = resolvePath(spillDir);
  const target = resolvePath(String(path ?? ""));
  if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return refusal("read_spill", TOOL_CODES.URL_REFUSED, "that path is outside the spill directory. Use a path exactly as it was given to you.");
  }
  if (!SPILL_NAME.test(basename(target))) {
    return refusal("read_spill", TOOL_CODES.URL_REFUSED, "that is not a spill file. Use a path exactly as it was given to you.");
  }
  let size = 0;
  try {
    size = statSync(target).size;
  } catch {
    return refusal("read_spill", TOOL_CODES.FAILED, "that spill file no longer exists. Re-run the tool that produced it with a narrower query.");
  }
  const body = readFileSync(target, "utf8");
  const start = Math.min(Math.max(0, Number(offset) || 0), body.length);
  const window = body.slice(start, start + (Number(length) || 8_000));
  if (window === "") {
    return empty("read_spill", `the offset is past the end of the file, which holds ${body.length} characters.`, { totalChars: body.length });
  }
  return ok("read_spill", {
    path: target,
    offset: start,
    nextOffset: start + window.length,
    totalChars: body.length,
    fileBytes: size,
    text: window,
  });
}

/* ── the ledger ─────────────────────────────────────────────────────────── */

/**
 * A stable hash of a call's arguments.
 *
 * Keys sorted, so `{a,b}` and `{b,a}` are one call. Also the thrash detector's
 * key: the same tool with the same arguments three times is a loop shape, not a
 * statistic.
 *
 * @param args - the validated arguments.
 * @returns a 16-character hex digest.
 */
export function hashArgs(args) {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}

/** Deterministic JSON: object keys sorted, at every depth. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/**
 * A ledger that writes into `mission_tool_calls` through the mission store.
 *
 * It does NOT prepare its own INSERT. It used to, against the same table and
 * the same eleven columns as `MissionStore.insertToolCall` — one statement
 * written twice, in two modules, differing in the name of one field
 * (`agent` here, `agentId` there) and in every validation the store performs.
 * The store is the module that owns SQL; a second place a statement lives is
 * how a column added in one of them stops being written by the other, silently,
 * for whichever half of the rows went through the wrong door.
 *
 * @param store - the `MissionStore` for this library.
 * @param context - `{missionId, stepId}` defaults for rows that omit them.
 * @returns a `(row) => void` recorder for `invokeTool`'s `ledger` option.
 */
export function createSqliteLedger(store, context = {}) {
  if (typeof store?.insertToolCall !== "function") {
    throw new TypeError(
      "createSqliteLedger needs the MissionStore, not a DatabaseSync handle: the INSERT into "
      + "mission_tool_calls lives in mission-store.js and nowhere else.",
    );
  }
  return (row) => {
    store.insertToolCall({
      missionId: String(row.missionId ?? context.missionId ?? ""),
      stepId: String(row.stepId ?? context.stepId ?? ""),
      // `agentId`, the store's name for it. `invokeTool` hands this recorder a
      // row keyed `agent`; both are accepted here so the one translation that
      // remains is a single line at the boundary rather than a second column
      // name loose in the schema.
      agentId: String(row.agentId ?? row.agent ?? ""),
      tool: String(row.tool ?? ""),
      paceKey: row.paceKey ?? null,
      argsHash: String(row.argsHash ?? ""),
      argsText: String(row.argsText ?? ""),
      ok: row.ok === true,
      errorCode: row.code ?? row.errorCode ?? null,
      cached: row.cached === true,
      latencyMs: Math.round(Number(row.latencyMs) || 0),
      at: String(row.at ?? new Date().toISOString()),
    });
  };
}

/* ── the one door ───────────────────────────────────────────────────────── */

/**
 * One line of a call's arguments, for the ledger.
 *
 * Values only, keys dropped: a search's argument is its query and a fetch's is
 * its URL, and a JSON envelope around that is noise in a column a person reads.
 * Bounded here as well as in the store, so a pathological argument never
 * reaches the driver.
 * @param args - the call's arguments, already parsed.
 * @returns a short readable string.
 */
function argsTextOf(args) {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args.slice(0, 300);
  if (typeof args !== "object") return String(args).slice(0, 300);
  return Object.values(args)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value)))
    .join(" · ")
    .slice(0, 300);
}

/**
 * Run one tool. The only way a tool ever runs.
 *
 * The order is fixed and each position is load-bearing:
 *
 *   circuit → forbidden → allow → tool exists → validate args → CACHE
 *   → POOL CONSUME → pacer (signal-aware) → execute (race + derived abort)
 *   → truncate → ledger row → circuit update
 *
 * Two positions differ from the design's written order, both deliberately; see
 * the comments at each.
 *
 * @param action - `{tool, args, id}` as it arrived from a native tool call.
 * @param options - `{agent, spec, ctx, signal, pool, circuit, cache, ledger,
 *   spillDir, missionId, stepId, unmetered}`.
 * @returns the observation the model will see, always with `ok` and, on
 *   failure, always with `code`, `error` and `tool`.
 */
export async function invokeTool(action, options = {}) {
  const startedAt = Date.now();
  const name = String(action?.tool ?? action?.name ?? "");
  const {
    // TWO NAMES FOR ONE CALLER, AND THEY ARE NOT INTERCHANGEABLE. `agent` is
    // the ROLE and is what `grantsFor` looks up; `agentId` is the INSTANCE —
    // `researcher:ai-capabilities` — and is what the ledger records so the loop
    // rule can tell one researcher of five from the fan-out as a whole.
    //
    // Passing the instance as `agent` was tried and it took the tools away:
    // `grantsFor` misses and returns an EMPTY grant, so every call came back
    // `forbidden` and the agents retried into a loop kill. Measured — a whole
    // run of s3-collect where every web_search, arxiv_search and library_search
    // was refused.
    agent = "", agentId = null, spec = {}, ctx = {}, signal, pool, circuit, cache,
    ledger, spillDir, missionId = "", stepId = "", unmetered = false,
  } = options;

  const record = (result, extra = {}) => {
    const row = {
      missionId, stepId, agent: agentId ?? agent, tool: name,
      paceKey: getTool(name)?.paceKey ?? null,
      argsHash: extra.argsHash ?? "",
      argsText: argsTextOf(action?.args ?? action?.arguments),
      ok: result.ok === true,
      code: result.ok === true ? null : result.code,
      cached: extra.cached === true,
      latencyMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    };
    // A ledger that throws must not take the mission with it: the observation
    // is the thing the model needs, and losing one audit row is the lesser
    // failure. It is still not silent — the row's loss rides back on the result.
    if (typeof ledger === "function") {
      try {
        ledger(row);
      } catch (cause) {
        result = { ...result, _ledgerFailed: String(cause?.message ?? cause) };
      }
    }
    return result;
  };

  // 1. Circuit. First, because a banned tool must cost nothing at all — not a
  //    validation pass, not a pool slot, and certainly not a pacer slot.
  const state = circuit?.stateOf?.(name) ?? { usable: true };
  if (state.usable === false) {
    return record(refusal(name, TOOL_CODES.CIRCUIT_OPEN, state.reason));
  }
  // Half-open: this call is the recovery probe, and it is claimed here rather
  // than in `stateOf` so rendering a catalogue never spends it.
  if (state.state === "half-open") circuit?.markProbe?.(name);

  // 2. Forbidden, then 3. allowed. Forbid is checked before allow so that a
  //    tool named in both is denied — an explicit denial outranks a grant.
  const forbidden = new Set((spec.forbiddenTools ?? []).map((entry) => String(entry)));
  if (forbidden.has(name)) {
    return record(refusal(name, TOOL_CODES.DENIED, `${name} is not available for this mission. Use one of the tools you were given.`));
  }
  const grant = grantsFor(agent);
  if (!grant.tools.includes(name)) {
    return record(refusal(name, TOOL_CODES.FORBIDDEN, `${agent || "this agent"} may not call ${name}. Its tools are: ${grant.tools.join(", ") || "none"}.`));
  }

  // 4. Exists. After the ACL, so an invented tool name that the agent would not
  //    have been granted anyway reports the ACL, not the registry.
  const tool = getTool(name);
  if (tool === undefined) {
    return record(refusal(name, TOOL_CODES.NO_SUCH_TOOL, `there is no tool called "${name}". Available: ${grant.tools.join(", ") || "none"}.`));
  }
  // The capability check runs at invoke as well as at recall. Recall keeps the
  // tool out of the catalogue; this refuses an id the model produced anyway.
  // Both are synchronous, so neither has a fail-closed-on-query-error path.
  const missing = tool.capabilities.filter((capability) => !grant.capabilities.includes(capability));
  if (missing.length > 0) {
    return record(refusal(name, TOOL_CODES.FORBIDDEN, `${agent || "this agent"} lacks ${missing.join(", ")} and may not call ${name}.`));
  }

  // 5. Validate.
  const checked = validateArgs(tool.parameters, action?.args ?? action?.arguments ?? {});
  if (checked.ok === false) {
    return record(refusal(name, TOOL_CODES.BAD_ARGS, `${name}: ${checked.error}`));
  }
  const args = checked.value;
  const argsHash = hashArgs(args);
  const cacheKey = `${name}:${argsHash}`;

  // 6. Cache. THE DESIGN PUTS THIS AFTER THE POOL AND AFTER THE PACER; it is
  //    here instead. A cache hit issues no upstream request, so charging it a
  //    ceiling would let a repeated query exhaust `max_arxiv` without arXiv ever
  //    hearing from us, and sleeping it behind the pacer would spend four
  //    seconds of wall clock returning a value already in memory. Cached rows
  //    are still ledgered, with `cached = 1`, so the budget test still has an
  //    exact predicate: count rows WHERE cached = 0.
  const cacheable = tool.sideEffect === "none" || tool.sideEffect === "idempotent";
  if (cacheable && cache instanceof Map && cache.has(cacheKey)) {
    const hit = cache.get(cacheKey);
    return record({ ...hit, _cached: true }, { argsHash, cached: true });
  }

  // 6b. Thrash. Only for tools the cache cannot cover, because for the rest the
  //     cache has already turned a repeat into a free answer. Three identical
  //     calls is a loop shape and the model needs to be told, not throttled.
  if (!cacheable && cache instanceof Map) {
    const seen = (cache.get(`repeat:${cacheKey}`) ?? 0) + 1;
    cache.set(`repeat:${cacheKey}`, seen);
    if (seen >= 3) {
      return record(refusal(name, TOOL_CODES.REPEAT_CALL, `you have called ${name} with these exact arguments ${seen} times. Change the arguments or move on.`), { argsHash });
    }
  }

  // 7. Cancellation, before anything is spent.
  if (signal?.aborted === true) {
    return record(refusal(name, TOOL_CODES.CANCELLED, "the mission was cancelled.", { reason: reasonOf(signal) }), { argsHash });
  }

  // 8. Pool. Before the pacer, so a refused call costs no wall clock. A missing
  //    pool for a metered tool is a THROW, not a shrug: revision 1 displayed
  //    three of five ceilings instead of enforcing them, and a door that runs
  //    unmetered by accident is how that happens again.
  if (tool.paceKey !== null) {
    if (pool === undefined || pool === null) {
      if (unmetered !== true) {
        throw new Error(
          `invokeTool("${name}"): no budget pool was supplied for a metered tool. `
          + "Pass `pool`, or pass `unmetered: true` to state that running without a ceiling is intended.",
        );
      }
    } else {
      const spend = pool.consume(tool.paceKey, 1);
      const allowed = spend === true || spend?.ok === true;
      if (allowed !== true) {
        const code = `${TOOL_CODES.BUDGET_EXHAUSTED}:${tool.paceKey}`;
        const why = spend?.error ?? `this mission's ${tool.paceKey} allowance is spent`;
        return record(refusal(name, code, `${why}. Work with what you already have.`), { argsHash });
      }
    }
  }

  // 9-10. Pacer, then execute under a real timeout.
  let result;
  try {
    result = await paced(tool.paceKey, () => runWithTimeout(tool, args, ctx, signal), signal);
  } catch (cause) {
    result = errorToRefusal(name, cause, signal);
  }
  if (result === undefined || result === null || typeof result !== "object" || typeof result.ok !== "boolean") {
    // The reference's scar: an observation of `undefined` shows the model
    // nothing, so it guesses, re-issues the same query, gets the same nothing,
    // and burns the iteration budget. A tool that returns a shape this door
    // does not recognise is a bug in the tool, and it is reported as one.
    result = refusal(name, TOOL_CODES.FAILED, `${name} returned no usable result. Do not retry it; use another tool.`);
  }

  // 11. Truncate. After execute, before the ledger, so the ledger's latency
  //     covers the work and not the serialisation.
  result = truncateResult(result, tool, spillDir ?? ctx.spillDir);

  // 12. Circuit update, from THIS sub-result. Never from a batch aggregate.
  if (circuit !== undefined && circuit !== null) {
    if (result.ok === true) circuit.recordSuccess(name);
    else circuit.recordFailure(name, String(result.code ?? TOOL_CODES.FAILED), result.error ?? "");
  }

  // Only successes are cached. Caching a refusal would remember a rate limit as
  // if it were an answer, and every later call would inherit a fact about one
  // moment's request rate as a fact about the world.
  if (cacheable && result.ok === true && cache instanceof Map) cache.set(cacheKey, result);

  return record(result, { argsHash });
}

/**
 * Run a batch of tool calls, settled per call and paced per key.
 *
 * `Promise.allSettled`, never all-or-nothing: one arXiv failure in a batch of
 * four must not discard three good library results. Concurrency is PER PACE
 * KEY rather than a flat number, so four arXiv calls serialise behind the
 * four-second chain while library calls run with no gate at all — and
 * `fetch_page`'s jsdom parses serialise for free, because they share one key.
 *
 * @param actions - the tool calls from one model turn.
 * @param options - as `invokeTool`.
 * @returns one observation per action, in the order the actions arrived.
 */
export async function invokeMany(actions, options = {}) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.length === 0) return [];

  const groups = new Map();
  for (const [index, action] of list.entries()) {
    const key = getTool(String(action?.tool ?? action?.name ?? ""))?.paceKey ?? `__free_${index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ index, action });
  }

  const results = new Array(list.length);
  const runGroup = async (entries) => {
    for (const entry of entries) {
      // Sequential within a key so the pacer is the only thing that decides
      // spacing; a settled failure never stops the rest of its own group.
      try {
        results[entry.index] = await invokeTool(entry.action, options);
      } catch (cause) {
        results[entry.index] = refusal(
          String(entry.action?.tool ?? "unknown"),
          TOOL_CODES.FAILED,
          String(cause?.message ?? cause),
        );
      }
    }
  };
  await Promise.allSettled([...groups.values()].map(runGroup));
  return results;
}

/* ── internals ──────────────────────────────────────────────────────────── */

/**
 * Execute with a derived AbortController and a real race.
 *
 * The controller is derived from the parent so a cancelled mission cancels the
 * request, and the race is there because a tool that ignores its signal must
 * still not be able to hang the loop. Both are cleared in `finally`; a timer
 * left running per tool call is a leak that only shows up on a deep mission.
 */
function runWithTimeout(tool, args, ctx, parentSignal) {
  const budget = tool.defaultTimeoutMs;
  const local = new AbortController();
  const cleanup = new AbortController();
  const signal = composeSignals(local.signal, parentSignal);
  let timer;

  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      local.abort(new Error("timeout"));
      reject(new ToolTimeoutError(tool.name, budget));
    }, budget);
  });

  const cancelled = new Promise((_, reject) => {
    if (parentSignal === undefined || parentSignal === null) return;
    if (parentSignal.aborted === true) {
      reject(abortErrorOf(parentSignal));
      return;
    }
    parentSignal.addEventListener(
      "abort",
      () => { reject(abortErrorOf(parentSignal)); },
      { once: true, signal: cleanup.signal },
    );
  });

  return Promise.race([
    Promise.resolve().then(() => tool.execute(args, { ...ctx, signal })),
    expiry,
    cancelled,
  ]).finally(() => {
    clearTimeout(timer);
    // Removes the abort listener. Without it a deep mission accumulates one
    // listener per tool call on a signal that lives as long as the mission.
    cleanup.abort();
  });
}

/** A timeout carries its own type so the door never has to regex a message. */
class ToolTimeoutError extends Error {
  /**
   * @param tool - the tool that did not answer.
   * @param ms - its declared budget.
   */
  constructor(tool, ms) {
    super(`${tool} did not answer within ${ms}ms`);
    this.name = "ToolTimeoutError";
    this.tool = tool;
    this.code = TOOL_CODES.TIMEOUT;
  }
}

/** An abort carries `signal.reason`, which is the authoritative discriminator. */
function abortErrorOf(signal) {
  const error = new Error("cancelled");
  error.name = "AbortError";
  error.code = TOOL_CODES.CANCELLED;
  error.reason = reasonOf(signal);
  return error;
}

/** The frozen reason vocabulary's value, never a parsed message. */
function reasonOf(signal) {
  const reason = signal?.reason;
  if (reason === undefined || reason === null) return "aborted";
  return String(reason?.code ?? reason?.message ?? reason);
}

/** Throw if already cancelled. Used inside the pacer slot, not before the queue. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortErrorOf(signal);
}

/** Compose two optional signals without allocating when only one exists. */
function composeSignals(a, b) {
  if (a === undefined || a === null) return b ?? undefined;
  if (b === undefined || b === null) return a;
  return AbortSignal.any([a, b]);
}

/**
 * Turn a thrown value into an observation the model can act on.
 *
 * Classification is by TYPE and by `signal.reason`, never by a message regex.
 * The reference's regex version misread budget exhaustion and wall-time as user
 * cancellation, which skipped the failure write entirely, left the row at
 * `running`, and let the liveness guard finish it later with a message that said
 * "pod restarted" — two lies and a delay from one wrong `if`.
 */
function errorToRefusal(name, cause, signal) {
  if (cause?.code === TOOL_CODES.TIMEOUT) {
    return refusal(name, TOOL_CODES.TIMEOUT, `${cause.message}. Do not retry the same call; try a narrower query or another tool.`);
  }
  if (cause?.code === TOOL_CODES.CANCELLED || cause?.name === "AbortError" || signal?.aborted === true) {
    return refusal(name, TOOL_CODES.CANCELLED, "the mission was cancelled.", { reason: cause?.reason ?? reasonOf(signal) });
  }
  // A thrown `Response`-bearing error still gets the refusal-vs-empty rule
  // applied: `rateLimitReason` is the one place that decides what a 429 means.
  const limited = cause?.response === undefined ? "" : rateLimitReason(cause.response);
  if (limited !== "") {
    return refusal(name, TOOL_CODES.RATE_LIMITED, `${name} was ${limited}. Stop calling it and use another source.`, { stopStage: true });
  }
  return refusal(name, TOOL_CODES.FAILED, `${name} failed: ${String(cause?.message ?? cause)}. Try another tool.`);
}

/** JSON that survives a circular result rather than throwing inside the door. */
function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    return item;
  }) ?? "";
}

// Re-exported so that `lib/pace.js`, when it exists, reaches the SAME factory
// through this module rather than importing a second copy from a second place.
// This file calls it nowhere — that is the point, and it is checkable: every
// occurrence of `createPacer(` above sits inside a comment or a message string,
// and there is no assignment or await in front of any of them.
export { createPacer };
