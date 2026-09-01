// The picture travels inside the file.
//
// The .docx export printed ［图 3：图片见网页版报告］ where the app showed a
// chart, on the reasoning the .md export still runs on: a downloaded file
// cannot reach our byte route, and a publisher URL in an `<img src>` would
// make every viewer of every copy fetch the publisher directly.
//
// Both are true of Markdown and NEITHER is true here. A .docx is a zip: the
// bytes ride inside it and opening one touches no network at all. So the two
// exports part ways at exactly one place, and this file is about what has to
// hold for the Word half of that to open rather than to say "the file is
// corrupt", which is Word's message for every packaging mistake there is.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";

import { reportToDocx, imageSize } from "../lib/mission-docx.js";

/**
 * Read a zip back into `{ name: Buffer }`, through the central directory.
 *
 * NOT BY SCANNING FOR LOCAL HEADERS. `PK\x03\x04` occurs inside deflate output
 * often enough that a scan finds phantom entries — and a reader that walks the
 * directory is also the only one that proves the directory is right, which is
 * the half of a zip that decides whether Word opens it.
 * @param buffer - the archive.
 * @returns the entries.
 */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from("PK", "latin1"));
  assert.ok(end > 0, "no end-of-central-directory record: this is not a zip");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = {};
  for (let step = 0; step < count; step += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, `central directory entry ${step} has the wrong signature`);
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    // The local header's own name and extra lengths, which need not match the
    // central directory's — reading the payload from the central copy is the
    // classic way to land in the middle of the data.
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const from = offset + 30 + localName + localExtra;
    const body = buffer.subarray(from, from + compressed);
    out[name] = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** A real 3x2 PNG, so the header walk has something true to read. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000300000002080600000099c1799"
  + "60000000f49444154789c636060606060000000050001a5f645ba0000000049454e44ae426082",
  "hex",
);

/** A real 4x3 JPEG: SOI, a JFIF APP0, a SOF0, and an EOI. */
const JPEG = Buffer.concat([
  Buffer.from("ffd8", "hex"),
  Buffer.from("ffe000104a46494600010100000100010000", "hex"),
  Buffer.from("ffc0001108000300040301112201031101", "hex"),
  Buffer.from("ffd9", "hex"),
]);

const REPORT = ["# 标题", "", "一段正文[1]。", "", ":::figure 1", ":::", "", "结尾。"].join("\n");

const figure = (over = {}) => ({
  index: 1, bytes: PNG, mime: "image/png", width: 0, height: 0,
  alt: "训练曲线", caption: "图 1 “训练曲线” — Scaling test-time compute https://a.example (抓取于 2026-08-24T09:10:00.000Z) [1]",
  ...over,
});

test("a header is measured rather than trusted, in all three formats", () => {
  // THE STORED WIDTH IS OFTEN 0, and 0 means "the page declared no intrinsic
  // size", not "small". A drawing sized from it is a zero-area rectangle,
  // which Word draws as nothing at all while still counting the paragraph —
  // a blank gap where the sentence used to be.
  assert.deepEqual(imageSize(PNG, "image/png"), { width: 3, height: 2 }, "a PNG's IHDR is not read");
  assert.deepEqual(imageSize(JPEG, "image/jpeg"), { width: 4, height: 3 }, "a JPEG's SOF0 is not found");
  const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(20)]);
  gif.writeUInt16LE(7, 6);
  gif.writeUInt16LE(5, 8);
  assert.deepEqual(imageSize(gif, "image/gif"), { width: 7, height: 5 }, "a GIF's screen descriptor is not read");

  // AND A JPEG WHOSE FRAME IS BEHIND A RESTART MARKER STILL MEASURES. D0-D7
  // carry no length; a walk that assumed every marker had one would read a
  // length out of image data and desynchronise on the first one.
  const restarted = Buffer.concat([
    Buffer.from("ffd8", "hex"), Buffer.from("ffd0", "hex"),
    Buffer.from("ffc0001108000300040301112201031101", "hex"),
  ]);
  assert.deepEqual(imageSize(restarted, "image/jpeg"), { width: 4, height: 3 }, "a standalone marker desynchronised the walk");

  assert.equal(imageSize(Buffer.alloc(4), "image/png"), null, "a truncated file is measured rather than refused");
  assert.equal(imageSize(PNG, "image/webp"), null, "an unmeasurable type reports a size");
});

test("the figure block becomes a picture, and the picture is in the zip", () => {
  const parts = unzip(reportToDocx(REPORT, { title: "报告", language: "zh", figures: [figure()] }));
  const names = Object.keys(parts);

  // THE BYTES ARE THERE, UNCHANGED. Not re-encoded, not scaled: a chart the
  // publisher drew is evidence, and an export that resamples it is an export
  // that has edited the evidence.
  const media = names.filter((name) => name.startsWith("word/media/"));
  assert.equal(media.length, 1, `the archive holds ${media.length} media parts rather than one`);
  assert.deepEqual(parts[media[0]], PNG, "the stored image was rewritten on the way into the file");

  const document = parts["word/document.xml"].toString("utf8");
  assert.ok(document.includes("<w:drawing>"), "the figure block did not become a drawing");
  assert.ok(
    !document.includes("图片见网页版报告"),
    "the picture is embedded AND the fallback sentence is printed, so the reader gets both",
  );

  // THE SENTENCE SURVIVES AS THE CAPTION. It is not replaced by the picture,
  // it is put under it: where the chart came off, when it was fetched and
  // which citation carries it is the half that makes it evidence.
  assert.ok(document.includes("Scaling test-time compute"), "the picture arrived with no attribution under it");
  assert.ok(document.includes("抓取于"), "the caption drops the fetch stamp");

  // THREE THINGS HAVE TO AGREE OR WORD SAYS "the file is corrupt", which is
  // its message for every packaging mistake there is: the drawing's r:embed,
  // a relationship with that id, and a content type for the extension.
  const embed = /r:embed="(rId\d+)"/u.exec(document);
  assert.ok(embed, "the drawing names no relationship");
  const rels = parts["word/_rels/document.xml.rels"].toString("utf8");
  assert.ok(rels.includes(`Id="${embed[1]}"`), "the drawing points at a relationship that is not declared");
  assert.ok(rels.includes("media/image2.png"), "the relationship does not target the part that was written");
  assert.ok(!rels.includes(`Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"`),
    "an image took rId1, which styles.xml already holds");
  assert.match(
    parts["[Content_Types].xml"].toString("utf8"),
    /<Default Extension="png" ContentType="image\/png"\/>/u,
    "the package contains a .png it never declares a type for, which is a file Word refuses to open",
  );
});

test("a picture wider than the page is scaled down, and a small one is left alone", () => {
  // A 2400px chart at its own size is two and a half pages wide and Word crops
  // it at the margin rather than reflowing. A 200px thumbnail blown up to the
  // column is a blurred rectangle. Only the first needs correcting.
  const wide = Buffer.from(PNG);
  wide.writeUInt32BE(2400, 16);
  wide.writeUInt32BE(1200, 20);
  const document = unzip(reportToDocx(REPORT, { figures: [figure({ bytes: wide })] }))["word/document.xml"].toString("utf8");
  const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/u.exec(document);
  assert.ok(extent, "the drawing declares no size");
  // 9638 twips of text across A4 inside 1134-twip margins, 635 EMU per twip.
  const capacity = 9638 * 635;
  assert.equal(Number(extent[1]), capacity, "a picture wider than the column was not scaled to it");
  // AND THE ASPECT RATIO SURVIVES. Half the width means half the height; a
  // chart squashed to fit is a chart that lies about its own axes.
  assert.equal(Number(extent[2]), Math.round(capacity / 2), "the picture was scaled without keeping its shape");

  // AND A TALL ONE IS CAPPED BY HEIGHT, WHICH IS THE HALF THAT WAS MISSING.
  // Measured on a real report: a 500×749 portrait photograph, scaled by
  // width alone, came out at three quarters of a page's text height — so it
  // took a page of its own and left the page before it mostly blank. A
  // figure is evidence beside an argument; past about two fifths of the
  // page nothing else fits with it, so it is beside nothing.
  const tall = Buffer.from(PNG);
  tall.writeUInt32BE(500, 16);
  tall.writeUInt32BE(749, 20);
  const portrait = unzip(reportToDocx(REPORT, { figures: [figure({ bytes: tall })] }))["word/document.xml"].toString("utf8");
  const stood = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/u.exec(portrait);
  // 14570 twips of text down A4 inside 1134-twip margins, two fifths of it.
  const ceiling = Math.round(14570 * 635 * 0.4);
  assert.ok(Number(stood[2]) <= ceiling, `a portrait figure stands ${stood[2]} EMU tall against a ceiling of ${ceiling}`);
  assert.ok(Number(stood[1]) < capacity, "a portrait figure was widened to the column it did not need");
  assert.equal(
    Math.round((Number(stood[1]) / Number(stood[2])) * 1000),
    Math.round((500 / 749) * 1000),
    "the height cap squashed the picture instead of scaling it",
  );

  const small = unzip(reportToDocx(REPORT, { figures: [figure()] }))["word/document.xml"].toString("utf8");
  const asIs = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/u.exec(small);
  assert.equal(Number(asIs[1]), 3 * 9525, "a picture narrower than the column was stretched to it");
});

test("what Word cannot draw falls back to the sentence, and says the same thing", () => {
  // A RED X IS WORSE THAN A LINE OF TEXT. Word before 2021 draws a placeholder
  // box for WebP, and every converter downstream — the ones that turn a .docx
  // into a PDF on somebody else's machine — is older than that.
  for (const [why, over] of [
    ["a webp", { mime: "image/webp" }],
    ["no bytes", { bytes: Buffer.alloc(0) }],
    ["a header that will not measure", { bytes: Buffer.from("89504e470d0a1a0a", "hex") }],
  ]) {
    const parts = unzip(reportToDocx(REPORT, { language: "zh", figures: [figure(over)] }));
    const document = parts["word/document.xml"].toString("utf8");
    assert.ok(!document.includes("<w:drawing>"), `${why} was embedded anyway`);
    assert.ok(document.includes("图片见网页版报告"), `${why} left the figure block as nothing at all`);
    assert.equal(
      Object.keys(parts).filter((name) => name.startsWith("word/media/")).length, 0,
      `${why} put a part in the archive that nothing references`,
    );
    assert.ok(
      !parts["[Content_Types].xml"].toString("utf8").includes("<Default Extension=\"webp\""),
      "the package declares a type for a part it does not contain",
    );
  }
});

test("a report with no figures is the file it was before any of this", () => {
  // THE CASE EVERY REPORT ON DISK IS IN. An artefact written before figures
  // existed must export byte for byte what it exported before — asserted
  // rather than assumed, because the packaging changed for all of them.
  const plain = ["# 标题", "", "一段正文。"].join("\n");
  const parts = unzip(reportToDocx(plain, { title: "报告", language: "zh" }));
  assert.deepEqual(
    Object.keys(parts).sort(),
    ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml"],
    "a report with no figures gained or lost a part",
  );
  assert.ok(
    !parts["[Content_Types].xml"].toString("utf8").includes("<Default Extension=\"png\""),
    "a report with no pictures declares an image type",
  );
});
