// The model cites handles; code owns the hashes.
//
// The Reconciler's evidence block printed `finding-<24 hex chars>` and the
// Analyst had to transcribe them into every fact's `findingIds`. At 43 findings
// it mostly worked. At 92 it did not: the model returned
// `finding-af6eb1e69fc966174f52c25` — 23 characters where the real one has 24,
// one dropped while copying — and the business gate rejected the WHOLE output
// over that one fact. Three times.
//
// Being told which id is wrong does not help when the id is wrong because it
// was mistyped: there is nothing left to look it up by. So the model shrank its
// answer instead, and the attempt that finally got through the gate carried ONE
// fact for 92 verified findings. s5 failed for producing no usable facts and
// took the mission with it — after eight dimensions had each collected their
// full quota of evidence.
//
// `F1`..`F92` is a handle a model can copy. This is the same rule the sign-off
// already follows for its arithmetic: precompute what code can, and never make
// a model do bookkeeping to earn its own verdict.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { findingHandles } from "../lib/mission-stages-middle.js";

/** `n` findings with ids shaped like the real ones: `finding-` + 24 hex chars. */
const findingsOf = (n) => Array.from({ length: n }, (_, i) => ({
  id: `finding-${i.toString(16).padStart(24, "0")}`,
  dimensionId: `d${i % 8}`,
  sourceHost: "example.test",
  claim: `claim ${i}`,
  evidence: `evidence ${i}`,
  sourceUrl: `https://example.test/${i}`,
}));

test("handles are short, ordinal, and cover every finding", () => {
  const findings = findingsOf(92);
  const { labelOf, resolve } = findingHandles(findings);

  assert.equal(labelOf.size, 92, "not every finding got a handle, so some evidence is uncitable");
  assert.equal(labelOf.get(findings[0].id), "F1");
  assert.equal(labelOf.get(findings[91].id), "F92");
  for (const finding of findings) {
    assert.equal(resolve(labelOf.get(finding.id)), finding.id, "a handle did not resolve back to its finding");
  }
});

test("the real id is still accepted, so a correct answer is never rejected", () => {
  // The handles are there to make citing EASIER. A model that quotes the
  // underlying id has done nothing wrong and must not be sent round the gate.
  const findings = findingsOf(5);
  const { resolve } = findingHandles(findings);
  assert.equal(resolve(findings[2].id), findings[2].id);
  assert.equal(resolve("f3"), findings[2].id, "handles are case-sensitive, so a lowercase copy is refused");
  assert.equal(resolve("  F3  "), findings[2].id, "surrounding whitespace makes a valid handle unresolvable");
});

test("a mistyped id resolves to nothing rather than to the wrong finding", () => {
  // The failure was a DROPPED CHARACTER. Repairing near-misses by similarity
  // would attach a fact to whichever finding happens to be closest in hex,
  // which is a fabricated citation — worse than the drop it replaces, because
  // the drop is counted and this would not be.
  const findings = findingsOf(10);
  const { resolve } = findingHandles(findings);
  const truncated = findings[4].id.slice(0, -1);

  assert.equal(resolve(truncated), null, "a truncated id was silently repaired to some finding");
  assert.equal(resolve(""), null);
  assert.equal(resolve(null), null);
  assert.equal(resolve("F0"), null, "handles are 1-based; F0 resolved to something");
  assert.equal(resolve("F11"), null, "a handle past the end of the list resolved");
});

test("the evidence block prints the handle, not the hash", () => {
  // The whole fix is one line of rendering, and a revert of that line puts the
  // 24-character ids back in front of the model with everything else intact —
  // which is exactly how this shipped the first time.
  const source = readFileSync(new URL("../lib/mission-stages-middle.js", import.meta.url), "utf8");
  const open = source.indexOf("function renderFindings(");
  assert.ok(open > 0, "renderFindings moved; this guard is looking at nothing");
  const body = source.slice(open, source.indexOf("\n}", open));

  assert.ok(
    /const handle = labelOf\?\.get\(finding\.id\) \?\? finding\.id;/.test(body),
    "renderFindings no longer resolves a handle for the evidence line",
  );
  assert.ok(
    !/`- \$\{finding\.id\}/.test(body),
    "the evidence block prints the raw 24-character finding id again, which is the transcription the model gets wrong",
  );

  // And the schema has to ask for the same thing the block prints, or the model
  // is told to copy one and rewarded for copying the other.
  const schema = source.slice(source.indexOf("findingIds: {"), source.indexOf("findingIds: {") + 600);
  assert.match(
    schema,
    /handles/,
    "the fact schema still asks for `finding ids`, so the model is told to supply what the block no longer shows it",
  );
});

/* ── the same defect, in every stage that asks a model to name a row ────── */

test("facts get their own handles, under a different letter", async () => {
  const { factHandles } = await import("../lib/mission-stages-middle.js");
  const facts = Array.from({ length: 40 }, (_, i) => ({ factId: `fact-${i.toString(16).padStart(16, "0")}` }));
  const { labelOf, resolve } = factHandles(facts);

  assert.equal(labelOf.get(facts[0].factId), "T1");
  assert.equal(labelOf.get(facts[39].factId), "T40");
  assert.equal(resolve("T7"), facts[6].factId);
  assert.equal(resolve(facts[6].factId), facts[6].factId, "the real fact id stopped being accepted");
  // `T`, not `F`. The two stages never share a prompt so `F` would not confuse
  // the model — it would confuse anyone reading a trace of both, and they are
  // different tables.
  assert.equal(resolve("F7"), null, "fact handles answer to the findings' letter");
});

test("a cited handle becomes the real id in the stored artefact", async () => {
  // The mapping back. A bug here writes handles into `mission_artifacts`
  // permanently, where the evidence pane and the scorecard look findings up by
  // the real id and would find nothing.
  const { bindCitations, idHandles } = await import("../lib/mission-stages-middle.js");
  const findings = findingsOf(3);
  const verifiedById = new Map(findings.map((f) => [f.id, { ...f, sourceUrl: `https://example.test/${f.id}` }]));
  const cite = idHandles(findings.map((f) => f.id), "F");

  const bound = bindCitations(
    "A claim [1] and another [2].",
    [{ findingId: "F2", inlineQuote: "q1" }, { findingId: findings[0].id, inlineQuote: "q2" }],
    verifiedById,
    cite.resolve,
  );

  assert.equal(bound.dropped, 0, `a citation was dropped: ${JSON.stringify(bound)}`);
  assert.equal(bound.citations[0].findingId, findings[1].id, "the handle was stored instead of the finding it names");
  assert.equal(bound.citations[1].findingId, findings[0].id, "a citation that used the real id was not preserved");
});

test("no stage shows a model an id it cannot copy", () => {
  // The defect was in FOUR stages and killed two runs before the pattern was
  // visible: s5 lost a whole fact table to it, s7 mis-allocated a chapter, and
  // s6 and s8 were dropping rows silently. Each render site is one interpolation
  // and each revert is one line, so they are pinned by name.
  const source = readFileSync(new URL("../lib/mission-stages-middle.js", import.meta.url), "utf8");

  const RENDERS = [
    ["the evidence block s5 reconciles from", /const handle = labelOf\?\.get\(finding\.id\) \?\? finding\.id;/],
    ["the fact line s6 and s7 read", /const handle = labelOf\?\.get\(fact\.factId\) \?\? fact\.factId;/],
    ["a fact's provenance list", /fact\.findingIds\.map\(\(id\) => findingLabelOf\?\.get\(id\) \?\? id\)/],
    ["s7's fact table", /handles\.labelOf\.get\(f\.factId\)/],
    ["s8's citable findings", /cite\.labelOf\.get\(f\.id\)/],
  ];
  for (const [what, pattern] of RENDERS) {
    assert.match(source, pattern, `${what} prints a minted id the model has to transcribe`);
  }

  // And the negative, because several of these blocks render twice — once full
  // and once shrunk — and a positive match on one branch stays green while the
  // other prints hashes. That is not hypothetical: it survived the first
  // version of this guard.
  const RAW = [
    ["a citable finding", /`- \$\{f\.id\} \| \$\{f\.sourceHost\}/],
    ["a fact table row", /`- \$\{f\.factId\} \|/],
    ["an evidence line", /`- \$\{finding\.id\} \|/],
  ];
  for (const [what, pattern] of RAW) {
    assert.doesNotMatch(source, pattern, `${what} is still rendered as its raw minted id somewhere`);
  }

  const GATES = [
    ["s5's fact provenance", /const bad = fact\.findingIds\.filter\(\(id\) => resolve\(id\) === null\);/],
    ["s6's themes", /asArray\(theme\?\.factIds\)\.map\(\(id\) => handles\.resolve\(asText\(id\)\)\)/],
    ["s7's chapter allocation", /const resolved = named\.map\(\(id\) => handles\.resolve\(id\)\);/],
    ["s8's citations", /citations\.filter\(\(c\) => resolve\(asText\(c\?\.findingId\)\) === null\)/],
  ];
  for (const [what, pattern] of GATES) {
    assert.match(source, pattern, `${what} compares strings instead of resolving a handle`);
  }
});

test("no model-supplied id reaches a membership test without being resolved", () => {
  // The rule, not another list of sites. Wiring the handles into a gate's
  // themes check and not its FORECASTS check refused the model for doing
  // exactly what it was told: run 18 lost four forecasts to
  // `预测 #1 的 factId「T11」不在事实表里` — T11 was a correct handle. Two more
  // sites, s6's quickview card and s7's refined outline, dropped every
  // allocation silently rather than complaining, which is worse.
  //
  // Both shapes below take a string the MODEL wrote straight into a lookup
  // against ids that CODE minted. There is exactly one legitimate place to
  // compare them, and it is after `resolve`.
  const source = readFileSync(new URL("../lib/mission-stages-middle.js", import.meta.url), "utf8");

  const SHAPES = [
    ["a lookup on model text", /(factIds|verifiedIds|verifiedById)\.(has|get)\(\s*asText\(/g],
    ["a filter over model ids", /\.filter\(\(id\) => (factIds|verifiedIds)\.has\(id\)\)/g],
  ];
  for (const [what, pattern] of SHAPES) {
    const found = [...source.matchAll(pattern)].map(([whole]) => whole);
    assert.deepEqual(
      found,
      [],
      `${what} still goes straight into a membership test: ${found.join(", ")}. `
      + "Resolve it first, or the model is refused — or silently dropped — for citing the handle it was shown.",
    );
  }

  // And the one comparison that is allowed, kept honest: it reads a variable
  // that `resolve` produced, on the line above it.
  assert.match(
    source,
    /const factId = handles\.resolve\(asText\(forecast\?\.factId\)\) \?\? "";[\s\S]{0,200}factIds\.has\(factId\)/,
    "the surviving membership test no longer reads a resolved id",
  );
});
