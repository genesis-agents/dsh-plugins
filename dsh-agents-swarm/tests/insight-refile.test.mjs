// Filing the claims that were already in the table.
//
// Two things changed under those rows and neither is retroactive: the language
// a claim is written in, and `layer` — where in the stack it sits — which the
// extractor was not asked for until now. Re-running the pass does not fix them:
// a pass reads the NEXT two hundred sources, not the ones it has read.
//
// And rewriting a statement has a consequence this file is mostly about.
// Near-duplicate detection is a simhash over the statement, so a claim
// translated here and the same claim extracted afresh in the target language
// become two rows with two wordings, two hashes, and no reason for either to
// notice the other. Measured on the real library: one Mayfield claim, twice,
// same quote, same video, same second.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  mergeIdenticalEvidence, needsReclassifying, readReclassification, reclassifyPrompt,
} from "../lib/insight-reclassify.js";

test("only the rows that still need it are picked", () => {
  // IDEMPOTENT BY CONSTRUCTION. The filter is a property of the row, not a
  // cursor, so a second run costs nothing and a failed batch is picked up by
  // the next one without anybody tracking which.
  assert.equal(needsReclassifying({ layer: "compute", statement: "算力" }, true), false);
  assert.equal(needsReclassifying({ layer: null, statement: "算力" }, true), true, "an unplaced claim is not picked");
  assert.equal(needsReclassifying({ layer: "compute", statement: "compute" }, true), true, "an English claim is not picked in a Chinese library");
  // AND NOT PICKED FOR LANGUAGE WHEN THE LIBRARY IS NOT CHINESE. Translating
  // an English library into Chinese because the field exists would be the
  // feature deciding something the reader did.
  assert.equal(needsReclassifying({ layer: "compute", statement: "compute" }, false), false);
});

test("the answer is read back by number, and a number outside the batch is dropped", () => {
  // A CLAMP WOULD FILE CLAIM ELEVEN'S LAYER ONTO CLAIM TEN, and the two would
  // look exactly as correct as a right answer.
  const batch = [{ id: "a", statement: "one" }, { id: "b", statement: "two" }];
  const out = readReclassification(JSON.stringify({
    claims: [
      { n: 1, layer: "compute", statement: "算力底座的一句话" },
      { n: 2, layer: "not-a-layer", statement: "模型的一句话" },
      { n: 9, layer: "energy", statement: "越界的一条" },
    ],
  }), batch, true);
  assert.deepEqual(out.map((row) => row.id), ["a", "b"], "a number outside the batch was applied anyway");
  assert.equal(out[0].layer, "compute");
  assert.equal(out[1].layer, undefined, "a layer outside the vocabulary was written");
  assert.ok(out[0].simhash, "the statement moved without its hash");
});

test("a statement that came back in the old language is not rewritten", () => {
  // A MODEL THAT ECHOES THE ENGLISH BACK would otherwise rewrite the row with
  // itself, spend a simhash change on nothing, and report a translation that
  // did not happen.
  const out = readReclassification(JSON.stringify({
    claims: [{ n: 1, layer: "model", statement: "the same English sentence" }],
  }), [{ id: "a", statement: "the same English sentence" }], true);
  assert.equal(out.length, 1);
  assert.equal(out[0].statement, undefined, "the English was written back as a translation");
  assert.equal(out[0].layer, "model", "the layer was lost with the statement");
});

test("the prompt asks for a filing and forbids a re-judgement", () => {
  const prompt = reclassifyPrompt([{ statement: "一句话" }], true);
  assert.match(prompt, /Do NOT re-judge it/u, "the prompt invites the model to re-decide what is already decided");
  assert.match(prompt, /Simplified Chinese/u);
  assert.match(prompt, /Keep every number, date, proper name and unit EXACTLY/u, "the numbers a reader checks are not protected");
  assert.match(prompt, /1\. 一句话/u, "the claim is not numbered for the answer to key on");
  // AND THE ENGLISH ARM DOES NOT ASK FOR A REWRITE AT ALL.
  assert.match(reclassifyPrompt([{ statement: "x" }], false), /return the claim unchanged/u);
});

test("two claims on the same evidence are one claim, and the oldest survives", () => {
  // BY EVIDENCE, NOT BY WORDS. The words are the pass's paraphrase and two
  // paraphrases of one fact may differ; the evidence IS the fact.
  const removed = [];
  const rows = [
    { id: "new", firstSeenAt: "2026-09-01T00:00:00.000Z", pinnedStatus: null },
    { id: "old", firstSeenAt: "2026-08-01T00:00:00.000Z", pinnedStatus: null },
    { id: "other", firstSeenAt: "2026-08-15T00:00:00.000Z", pinnedStatus: null },
  ];
  const evidence = {
    new: [{ resourceId: "v1", quote: "the same sentence" }],
    old: [{ resourceId: "v1", quote: "the same sentence" }],
    other: [{ resourceId: "v2", quote: "a different sentence" }],
  };
  const insights = {
    list: () => ({ insights: rows }),
    getWithEvidence: (id) => ({ ...rows.find((row) => row.id === id), evidence: evidence[id] }),
    remove: (id) => { removed.push(id); return true; },
  };
  const report = mergeIdenticalEvidence(insights);
  assert.deepEqual(removed, ["new"], "the wrong row was merged away");
  assert.equal(report.merged, 1);
  // `first_seen_at` IS THE COLUMN THAT ANSWERS "SINCE WHEN". Keeping the newer
  // row would tell a card standing since August that it was found today.
});

test("a claim somebody has ruled on is never merged away", () => {
  // A PINNED VERDICT IS A PERSON'S DECISION and outranks this pass. Removing
  // the row would throw it away silently, which is the one failure
  // `pinned_status` exists to prevent.
  const removed = [];
  const rows = [
    { id: "new", firstSeenAt: "2026-09-01T00:00:00.000Z", pinnedStatus: "standing" },
    { id: "old", firstSeenAt: "2026-08-01T00:00:00.000Z", pinnedStatus: null },
  ];
  const insights = {
    list: () => ({ insights: rows }),
    getWithEvidence: (id) => ({ ...rows.find((row) => row.id === id), evidence: [{ resourceId: "v1", quote: "same" }] }),
    remove: (id) => { removed.push(id); return true; },
  };
  assert.equal(mergeIdenticalEvidence(insights).merged, 0);
  assert.deepEqual(removed, [], "a claim carrying a person's own verdict was deleted");
});

test("claims that rest on nothing are not thereby the same claim", () => {
  // Grouping the evidence-less rows together would merge the whole tail of a
  // table whose rows had lost their sources.
  const removed = [];
  const rows = [
    { id: "a", firstSeenAt: "2026-08-01T00:00:00.000Z", pinnedStatus: null },
    { id: "b", firstSeenAt: "2026-08-02T00:00:00.000Z", pinnedStatus: null },
  ];
  const insights = {
    list: () => ({ insights: rows }),
    getWithEvidence: (id) => ({ ...rows.find((row) => row.id === id), evidence: [] }),
    remove: (id) => { removed.push(id); return true; },
  };
  assert.equal(mergeIdenticalEvidence(insights).merged, 0);
  assert.deepEqual(removed, []);
});
