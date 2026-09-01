// Which of a page's images are figures.
//
// Measured on a real report — eight chapters, 109 citations, seven figures in
// its manifest — and two things were wrong with what came out, both visible at
// a glance and neither about the writers:
//
//   两张重复   Two figures off one Fortune article and two off one politics
//              page, each pair sharing a citation, so each pair printed one
//              after the other with nearly the same sentence underneath. That
//              reads as the export having duplicated something.
//
//   大小完全   "Influencers By State Badge-white background.jpg" at 150×154 and
//   不一致     "Influencer Project Badge.png" at 100×100, printed at their own
//              size between four charts and photographs. The sizes were not
//              inconsistent; the OBJECTS were. A badge harvested off the page
//              beside an article is not evidence for anything.
//
// Both are decided here rather than at collection, because every report already
// on disk carries these rows: a rule that ran only when a figure was first
// fetched would leave existing reports looking exactly as they do now.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { figuresOfReport, renderFigureTokens } from "../lib/mission-view.js";

/** One figure row, in the shape s12 freezes. */
const figure = (index, over = {}) => ({
  index, citationIndex: index, figureId: `fig-${index}`,
  documentId: `doc-${index}`, pageUrl: "https://a.example/page",
  width: 800, height: 600, alt: `figure ${index}`, ...over,
});

/** An artefact whose citations and evidence resolve, so nothing is dropped for that. */
const artifactOf = (figures) => ({
  markdown: figures.map((f) => `正文[${f.citationIndex}]。\n\n:::figure ${f.index}\n:::\n`).join("\n"),
  figures,
  citations: [...new Set(figures.map((f) => f.citationIndex))].map((index) => ({
    index, url: `https://a.example/${index}`, findingId: `f${index}`,
  })),
  evidence: [...new Set(figures.map((f) => f.citationIndex))].map((index) => ({
    findingId: `f${index}`, sourceTitle: `Page ${index}`, sourceHost: "a.example",
    fetchedAt: "2026-08-30T17:00:00.000Z",
  })),
});

test("a page contributes one figure, not its whole image gallery", () => {
  // TWO OFF ONE ARTICLE, sharing a citation — so both print with nearly the
  // same attribution under them, one after the other.
  const artifact = artifactOf([
    figure(1, { documentId: "doc-a" }),
    figure(2, { documentId: "doc-a", citationIndex: 1 }),
    figure(3, { documentId: "doc-b" }),
  ]);
  const kept = figuresOfReport(artifact, { language: "zh" });
  assert.deepEqual(kept.map((f) => f.index), [1, 3], "a second figure off the same page is still printed");

  // AND THE .md AGREES. Three exports read this manifest and a rule that
  // reached only the two that carry bytes would make the Markdown copy of one
  // report disagree with its Word copy about what is in it.
  const md = renderFigureTokens(artifact.markdown, artifact, { language: "zh" });
  assert.equal((md.match(/^> \*\*图/gmu) ?? []).length, 2, "the Markdown export still prints both figures off one page");
});

test("what a page drew as a badge is not a figure", () => {
  // THE PAGE'S DECLARED SIZE, NOT THE FILE'S. A badge is often a large PNG
  // displayed small, and the displaying small is what says what it is for.
  const artifact = artifactOf([
    figure(1, { width: 150, height: 154 }),
    figure(2, { width: 100, height: 100 }),
    figure(3, { width: 240, height: 320 }),
    figure(4, { width: 970, height: 647 }),
  ]);
  assert.deepEqual(
    figuresOfReport(artifact, { language: "zh" }).map((f) => f.index), [3, 4],
    "a picture the page itself drew at badge size is printed as a figure",
  );
});

test("a page that declares no size is not judged on one", () => {
  // 0 MEANS UNKNOWN, NOT SMALL — the figures route's own comment says so, and
  // a chart thrown away on a guess is worse than a badge printed.
  const artifact = artifactOf([figure(1, { width: 0, height: 0 })]);
  assert.deepEqual(
    figuresOfReport(artifact, { language: "zh" }).map((f) => f.index), [1],
    "a figure whose page declared no size was dropped on an unknown",
  );
});

test("the floor is applied before the one-per-page rule, not after", () => {
  // ORDER MATTERS AND IT IS THE WHOLE OF THIS TEST. A badge earlier in the
  // manifest would otherwise take its page's one slot, and the chart behind it
  // — off the same page — would be dropped as the duplicate. The report would
  // lose the figure and keep nothing.
  const artifact = artifactOf([
    figure(1, { documentId: "doc-a", width: 120, height: 120 }),
    figure(2, { documentId: "doc-a", width: 900, height: 700, citationIndex: 1 }),
  ]);
  assert.deepEqual(
    figuresOfReport(artifact, { language: "zh" }).map((f) => f.index), [2],
    "the badge took its page's slot and the chart behind it was dropped as a duplicate",
  );
});

test("the manifest is not renumbered, so a dropped figure is nothing rather than a shift", () => {
  // THE INDEXES ARE WHAT `:::figure N` RESOLVES AGAINST. Compacting them would
  // make every marker after the first drop point resolve to the wrong picture —
  // which is worse than the badge, because it is wrong rather than ugly.
  const artifact = artifactOf([
    figure(1, { width: 100, height: 100 }),
    figure(2, { width: 900, height: 700 }),
  ]);
  const kept = figuresOfReport(artifact, { language: "zh" });
  assert.deepEqual(kept.map((f) => f.index), [2], "the surviving figure was renumbered");
  const md = renderFigureTokens(artifact.markdown, artifact, { language: "zh" });
  assert.ok(md.includes("**图 2**"), "the surviving figure lost the number its marker names");
  assert.ok(!md.includes("**图 1**"), "the dropped figure is still printed");
});
