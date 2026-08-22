/**
 * `source_library`: the swarm's own agents' handle on the local source library.
 *
 * The collectors in `collect.js` are the bulk intake — deterministic, no model
 * in the loop. This tool is the other half: it lets an agent SEARCH what has
 * landed and ADD the individual things a crawler cannot reach (a page it was
 * asked to read, a link a person pasted, a citation found mid-research).
 *
 * A `ToolDefinition` is built by hand rather than through `@deepseek-ai/dsh-tools`'s
 * `defineTool`: this package lives outside the harness checkout and resolves
 * none of its packages. `defineTool` compiles a parameter spec to JSON Schema
 * and wraps `execute` with validation of that schema; both are reproduced here
 * against the same `ToolDefinition` contract.
 */

import { stableId } from "./collect.js";
import { RESOURCE_TYPES } from "./store.js";

/** Rows one search may return. */
const SEARCH_LIMIT = 10;

/** Validate arguments the way the schema wrapper would. */
function violationsOf(args, spec) {
  const problems = [];
  if (args === null || typeof args !== "object") return ["arguments must be an object"];
  for (const [key, rule] of Object.entries(spec)) {
    const value = args[key];
    if (value === undefined) {
      if (rule.required === true) problems.push(`${key} is required`);
      continue;
    }
    if (rule.type === "string" && typeof value !== "string") problems.push(`${key} must be a string`);
    if (rule.type === "integer" && !Number.isInteger(value)) problems.push(`${key} must be an integer`);
    if (rule.enum !== undefined && !rule.enum.includes(value)) {
      problems.push(`${key} must be one of ${rule.enum.join(", ")}`);
    }
  }
  return problems;
}

/** Project one stored row down to what a model needs to reason about it. */
function forModel(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    url: row.sourceUrl,
    publishedAt: row.publishedAt ?? null,
    summary: (row.aiSummary ?? row.abstract ?? "").slice(0, 600),
  };
}

/**
 * Build the two tool definitions over one open store.
 * @param store - the source library.
 * @returns the tool definitions, ready for `ctx.tools.register`.
 */
export function libraryTools(store) {
  const searchParams = {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Words to match against title, abstract, and AI summary." },
      type: { type: "string", enum: RESOURCE_TYPES, description: "Narrow to one resource type." },
      limit: { type: "integer", description: `Maximum rows to return (1-${SEARCH_LIMIT}).` },
    },
  };
  const addParams = {
    type: "object",
    additionalProperties: false,
    required: ["url", "title"],
    properties: {
      url: { type: "string", description: "Absolute URL of the source." },
      title: { type: "string", description: "Title as published." },
      type: { type: "string", enum: RESOURCE_TYPES, description: "Resource type; defaults to BLOG." },
      summary: { type: "string", description: "One-paragraph summary of what the source says." },
      author: { type: "string", description: "Primary author or publication." },
      publishedAt: { type: "string", description: "ISO 8601 publication timestamp." },
    },
  };

  const search = {
    name: "source_library_search",
    description: [
      "Search the local source library — papers, blogs, reports, policy, news, and videos the swarm has collected.",
      "Prefer this over a web search when the question is about material the swarm already holds.",
    ].join(" "),
    parameters: searchParams,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer" },
          rows: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render(_args, value) {
        const rows = value?.rows ?? [];
        if (rows.length === 0) return [{ type: "text", text: "No matching source in the library." }];
        const lines = rows.map((row) => `- [${row.type}] ${row.title}\n  ${row.url}`);
        return [{ type: "text", text: `${value.total} match(es); showing ${rows.length}:\n${lines.join("\n")}` }];
      },
    },
    async execute(args) {
      const problems = violationsOf(args, {
        query: { type: "string" }, type: { type: "string", enum: RESOURCE_TYPES }, limit: { type: "integer" },
      });
      if (problems.length > 0) throw new Error(problems.join("; "));
      const limit = Math.max(1, Math.min(SEARCH_LIMIT, args?.limit ?? SEARCH_LIMIT));
      const page = store.query({ search: args?.query, type: args?.type, take: limit, skip: 0 });
      return { total: page.total, rows: page.rows.map(forModel) };
    },
  };

  const add = {
    name: "source_library_add",
    description: [
      "Add one source to the local library.",
      "Use it for material a crawler will not reach on its own: a page you were asked to read, a citation you followed, a link a person supplied.",
      "A URL already held is left untouched rather than duplicated.",
    ].join(" "),
    parameters: addParams,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          stored: { type: "boolean" },
          total: { type: "integer" },
        },
      },
      render(_args, value) {
        return [{
          type: "text",
          text: value?.stored === true
            ? `Stored. The library now holds ${value.total} source(s).`
            : "Not stored: that URL is already in the library under a different record.",
        }];
      },
    },
    async execute(args) {
      const problems = violationsOf(args, {
        url: { type: "string", required: true },
        title: { type: "string", required: true },
        type: { type: "string", enum: RESOURCE_TYPES },
        summary: { type: "string" }, author: { type: "string" }, publishedAt: { type: "string" },
      });
      if (problems.length > 0) throw new Error(problems.join("; "));
      const id = stableId(args.url);
      const stored = store.put({
        id,
        type: args.type ?? "BLOG",
        title: args.title,
        abstract: args.summary ?? null,
        sourceUrl: args.url,
        publishedAt: args.publishedAt ?? new Date().toISOString(),
        authors: args.author === undefined ? [] : [{ name: args.author }],
        categories: [],
        sourceType: "agent",
        upvoteCount: 0,
        commentCount: 0,
      });
      return { id, stored, total: store.count() };
    },
  };

  return [search, add];
}

/**
 * Register both library tools for as long as the caller's context is active.
 * @param ctx - Cordis context carrying the `tools` registry.
 * @param store - the source library.
 */
export function registerLibraryTool(ctx, store) {
  for (const tool of libraryTools(store)) ctx.tools.register(tool);
}
