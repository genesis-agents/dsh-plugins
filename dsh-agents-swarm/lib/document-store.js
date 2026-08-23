/**
 * Where written documents are kept.
 *
 * Beside the library and beside the episodes, for the reason the episodes are
 * there: everything derives from one path, so the library is a single
 * directory you can copy to another machine and have its media come with it.
 *
 * Markdown files with a JSON index, rather than rows in the database. A
 * document is an artefact, not a record — you want to be able to open one in
 * an editor, hand it to someone, or grep the lot of them without going through
 * this process at all. The index carries only what a list needs to render, so
 * showing fifty documents never reads fifty files.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mediaDirs } from "./library.js";
import { storePath } from "./index.js";

/** The index file inside the documents directory. */
const INDEX_FILE = "index.json";

/** Ids are ours, so anything outside this alphabet is tampering. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Documents kept before the oldest are pruned; 0 means keep everything. */
const RETENTION = 0;

/**
 * The documents directory, derived from the library's location.
 * @param env - process environment.
 * @returns the absolute directory path.
 */
export function documentDir(env = process.env) {
  return mediaDirs(storePath(env)).documents;
}

/**
 * Absolute path of one document's Markdown.
 * @param id - the document id.
 * @param env - process environment.
 * @returns the absolute file path.
 */
export function documentPath(id, env = process.env) {
  const value = String(id ?? "");
  // The id reaches this from a URL. Rejecting anything outside the alphabet we
  // generate is what keeps `../../etc/passwd` from being a document id, and it
  // is a whitelist rather than a blacklist because the set of ways to spell a
  // traversal is larger than the set of characters we actually use.
  if (!SAFE_ID.test(value)) throw new Error(`unsafe document id: ${value}`);
  return join(documentDir(env), `${value}.md`);
}

/** Read the index, tolerating a missing or corrupt one. */
function readIndex(env) {
  const file = join(documentDir(env), INDEX_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt index must not take the documents with it. They are still on
    // disk and still readable by hand; losing the list is recoverable, and
    // throwing here would make the whole tab fail to load.
    return [];
  }
}

/** Write the index. */
function writeIndex(records, env) {
  const dir = documentDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INDEX_FILE), `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

/** A sortable, collision-resistant id carrying its own timestamp. */
function documentId(at) {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`;
}

/**
 * Store one document.
 * @param input - `{ text, title, format, sourceIds, guidance }`.
 * @param env - process environment.
 * @returns the stored record.
 */
export function saveDocument({ text, title, format, sourceIds, guidance } = {}, env = process.env) {
  const body = String(text ?? "");
  // Checked rather than assumed: an empty document written to disk is a row in
  // the list that opens onto nothing, and the failure would be attributed to
  // the reader's click rather than to the generation that produced no text.
  if (body.trim() === "") throw new Error("refusing to store an empty document");

  const at = new Date();
  const id = documentId(at);
  const dir = documentDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), body, "utf8");

  const record = {
    id,
    title: String(title ?? "").trim() || "Untitled",
    format: String(format ?? "digest"),
    createdAt: at.toISOString(),
    chars: body.length,
    // Stored so a document can say what it was made from even after those
    // rows have scrolled out of every list.
    sourceIds: Array.isArray(sourceIds) ? sourceIds.slice(0, 40) : [],
    guidance: String(guidance ?? "").trim().slice(0, 400),
  };

  const records = [record, ...readIndex(env)];
  writeIndex(RETENTION > 0 ? records.slice(0, RETENTION) : records, env);
  return record;
}

/**
 * A page of documents, newest first.
 * @param options - `{ take, skip, format }`.
 * @param env - process environment.
 * @returns `{ documents, total, hasMore }`.
 */
export function listDocuments({ take, skip = 0, format } = {}, env = process.env) {
  let all = readIndex(env)
    .slice()
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  if (typeof format === "string" && format !== "") all = all.filter((record) => record.format === format);
  const from = Math.max(0, Number(skip) || 0);
  const size = Number.isFinite(Number(take)) ? Math.max(1, Math.min(200, Number(take))) : all.length;
  return { documents: all.slice(from, from + size), total: all.length, hasMore: from + size < all.length };
}

/**
 * One document, with its text.
 * @param id - the document id.
 * @param env - process environment.
 * @returns the record plus `text`, or undefined.
 */
export function getDocument(id, env = process.env) {
  const record = readIndex(env).find((entry) => entry.id === String(id ?? ""));
  if (record === undefined) return undefined;
  const file = documentPath(id, env);
  // The index and the files can disagree — a file removed by hand, a write
  // that failed after the index was updated. Reporting the record with no text
  // beats throwing: the reader learns the document is gone and can delete the
  // row, rather than meeting a page that will not load.
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return { ...record, text, missing: text === "" };
}

/**
 * Forget one document and remove its file.
 * @param id - the document id.
 * @param env - process environment.
 * @returns whether a record was removed.
 */
export function deleteDocument(id, env = process.env) {
  const wanted = String(id ?? "");
  const records = readIndex(env);
  const remaining = records.filter((record) => record.id !== wanted);
  if (remaining.length === records.length) return false;
  const file = documentPath(wanted, env);
  if (existsSync(file)) rmSync(file);
  writeIndex(remaining, env);
  return true;
}

/**
 * Rebuild the index from the Markdown files on disk.
 *
 * For the case the index is lost or was never written — the documents survive
 * it, since each one is a whole file whose name carries its timestamp. Titles
 * are recovered from the first heading, which is where they came from.
 * @param env - process environment.
 * @returns how many records were recovered.
 */
export function reindexDocuments(env = process.env) {
  const dir = documentDir(env);
  if (!existsSync(dir)) return 0;
  const known = new Map(readIndex(env).map((record) => [record.id, record]));
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    if (!SAFE_ID.test(id)) continue;
    if (known.has(id)) { records.push(known.get(id)); continue; }
    const text = readFileSync(join(dir, name), "utf8");
    const heading = /^#{1,3}\s+(.+)$/m.exec(text);
    records.push({
      id,
      title: heading === null ? id : heading[1].trim().slice(0, 160),
      format: "digest",
      // Recovered from the id, which is why the id carries a timestamp.
      createdAt: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`,
      chars: text.length,
      sourceIds: [],
      guidance: "",
    });
  }
  records.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  writeIndex(records, env);
  return records.length;
}
