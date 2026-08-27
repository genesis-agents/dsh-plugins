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
