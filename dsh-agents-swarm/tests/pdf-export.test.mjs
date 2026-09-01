// A real PDF, with a real font in it.
//
// The export was `window.print()`. That is the browser laying out our SCREEN
// with the harness made invisible around it — a different document that
// happens to contain the same words — and it cost: no pictures, because print
// CSS cannot fetch what the screen did not draw; a reader who has to find
// "Save as PDF" inside a print dialog; a result that differs by browser; and
// nothing that is not a person standing at a window able to produce one.
//
// Replacing it means writing a PDF, which means embedding a CJK font, which
// means reading and subsetting TrueType. This file is about the two places
// that work can go wrong silently: a font a reader will not accept, and a file
// whose cross-reference table points at the wrong bytes. Both produce "the
// document is damaged" rather than anything about fonts, so both are asserted
// structurally rather than by eye.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deflateSync, inflateSync } from "node:zlib";

import { reportToPdf } from "../lib/mission-pdf.js";
import { findSystemFont, loadFont, parseFont } from "../lib/mission-font.js";

/** The machine's own CJK face, or null when it has none. */
const FOUND = findSystemFont();

/** A real PNG, made here so the decoder has something true to read. */
function makePng(width, height, alpha) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buffer) => {
    let x = 0xffffffff;
    for (const byte of buffer) x = table[(x ^ byte) & 255] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const channels = alpha ? 4 : 3;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * channels);
    for (let x = 0; x < width; x += 1) {
      const at = 1 + x * channels;
      row[at] = (x * 37) & 255;
      row[at + 1] = (y * 53) & 255;
      row[at + 2] = 200;
      if (alpha) row[at + 3] = x < width / 2 ? 255 : 96;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Read a PDF back through its own cross-reference table.
 *
 * NOT BY SCANNING FOR `obj`. The table is the half of a PDF a reader trusts —
 * it is how every object is found — so a test that located objects by pattern
 * would pass on a file whose offsets are all wrong, which is exactly the file
 * a reader refuses to open.
 * @param buffer - the file.
 * @returns `{ objects, trailer }`.
 */
function readPdf(buffer) {
  const text = buffer.toString("latin1");
  const marker = text.lastIndexOf("startxref");
  assert.ok(marker > 0, "the file has no startxref, so nothing can find its objects");
  const start = Number(text.slice(marker + 9).trim().split(/\s/u)[0]);
  const head = /xref\s+0\s+(\d+)/u.exec(text.slice(start));
  assert.ok(head, "startxref does not point at a cross-reference table");
  const count = Number(head[1]);
  const rows = text.slice(start).split("\n").slice(3, 3 + count - 1);
  const objects = new Map();
  rows.forEach((row, index) => {
    const at = Number(row.slice(0, 10));
    const want = `${index + 1} 0 obj`;
    assert.equal(
      text.slice(at, at + want.length), want,
      `the table says object ${index + 1} starts at ${at}, and it does not`,
    );
    const from = text.indexOf("obj\n", at) + 4;
    const stream = text.indexOf("\nstream\n", from);
    const end = text.indexOf("\nendobj", from);
    const dict = text.slice(from, stream > 0 && stream < end ? stream : end);
    let data = null;
    if (stream > 0 && stream < end) {
      const length = Number(/\/Length (\d+)/u.exec(dict)[1]);
      const at2 = stream + "\nstream\n".length;
      const raw = buffer.subarray(at2, at2 + length);
      data = dict.includes("FlateDecode") ? inflateSync(raw) : raw;
    }
    objects.set(index + 1, { dict, data });
  });
  return { objects, trailer: text.slice(text.lastIndexOf("trailer")).split("startxref")[0] };
}

/** Every content stream, joined — a report is several pages. */
const contentOf = (read) => [...read.objects.values()]
  .filter((object) => object.data !== null && !object.dict.includes("Length1") && !object.dict.includes("/Image"))
  .map((object) => object.data.toString("latin1"))
  .filter((body) => body.includes(" Tf "))
  .join("\n");

const REPORT = [
  "## “黑帮”不是组织：PayPal 网络如何形成",
  "",
  "“PayPal 黑帮”首先不是一个组织名称，而是媒体对前 PayPal 员工的称呼[1]。",
  "",
  ":::figure 1",
  ":::",
  "",
  "- 第一条要点，带一个 **加粗** 的词",
  "1. 有序的第一条",
  "> 引用一句话。",
].join("\n");

const figure = () => ({
  index: 1, bytes: makePng(40, 24, true), mime: "image/png",
  caption: "图 1 “训练曲线” — Wikipedia https://en.wikipedia.org/wiki/x (抓取于 2026-08-30T17:09:40.139Z) [1]",
});

test("the font a machine has is found, parsed, and subset back into a font", { skip: FOUND === null && "no CJK font on this machine" }, () => {
  const face = loadFont(FOUND.path, FOUND.index);
  assert.ok(face.unitsPerEm > 0, "the face reports no em square, so every width computed from it is zero");
  assert.ok(face.numGlyphs > 1000, "a face with a thousand glyphs is not a CJK face");
  // THE CHARACTERS THIS PRODUCT ACTUALLY WRITES. A face found by path but
  // covering no Chinese would draw the whole report as empty boxes — which is
  // the failure the search exists to avoid, arriving one step later.
  for (const ch of "开源推理模型的许可证走向") {
    assert.ok(face.has(ch.codePointAt(0)), `the chosen face has no glyph for ${ch}`);
  }
  assert.ok(face.has(0x41) && face.has(0x2e), "the chosen face covers no Latin, and every report has some");

  const gids = new Set([..."开源推理模型 Report 1"].map((ch) => face.glyphFor(ch.codePointAt(0))));
  const program = face.subset(gids);
  // IT HAS TO PARSE AS A FONT. Every failure in a subsetter — a bad table
  // directory, a `loca` that disagrees with `glyf`, a checksum — comes out of
  // a PDF reader as "the document is damaged", with nothing said about fonts.
  const back = parseFont(program, 0);
  assert.equal(back.unitsPerEm, face.unitsPerEm, "the subset lost the em square it is measured in");
  assert.equal(back.numGlyphs, face.numGlyphs, "the subset renumbered its glyphs, so the PDF's codes point elsewhere");
  // AND THE WIDTHS MUST NOT MOVE. They are what the layout measured with; a
  // subset that shifted `hmtx` would lay out against one set of widths and
  // draw against another, and the text would overflow the margin.
  for (const gid of gids) {
    assert.equal(back.advanceOf(gid), face.advanceOf(gid), `glyph ${gid} changed width in the subset`);
  }
  assert.ok(program.length < 2_000_000, "the subset is the whole font, so every export carries 20MB");
});

test("the report becomes a PDF a reader can find its way around", { skip: FOUND === null && "no CJK font on this machine" }, () => {
  const buffer = reportToPdf(REPORT, { title: "Paypal黑帮深度洞察", language: "zh", figures: [figure()] });
  assert.equal(buffer.subarray(0, 8).toString("latin1"), "%PDF-1.7", "the file does not say it is a PDF");
  assert.ok(buffer.subarray(-8).toString("latin1").includes("%%EOF"), "the file has no end marker");

  // EVERY OFFSET IN THE TABLE IS CHECKED inside readPdf. That is the assertion
  // this test exists for: a PDF whose xref is wrong opens as "damaged" and
  // says nothing about which object it could not find.
  const read = readPdf(buffer);
  assert.match(read.trailer, /\/Root \d+ 0 R/u, "the trailer names no catalogue");
  assert.match(read.trailer, /\/Info \d+ 0 R/u, "the info dictionary is written and then not referenced");

  const kinds = [...read.objects.values()].map((object) => object.dict);
  assert.ok(kinds.some((dict) => dict.includes("/Type /Catalog")), "there is no catalogue");
  assert.ok(kinds.some((dict) => dict.includes("/Type /Pages")), "there is no page tree");
  assert.ok(kinds.some((dict) => dict.includes("/Type /Page ")), "there are no pages");
  assert.ok(kinds.some((dict) => dict.includes("/Subtype /Type0")), "no composite font, so the Chinese cannot be addressed");
  assert.ok(kinds.some((dict) => dict.includes("/Subtype /CIDFontType2")), "no CID font behind the Type0");
  assert.ok(kinds.some((dict) => dict.includes("/FontFile2")), "the font is referenced and not embedded");

  // A CHINESE TITLE IS NOT A LITERAL STRING. `(…)` is PDFDocEncoding, near
  // enough to Latin-1, so a title written into one is one box per byte in the
  // reader's window bar. The hex form opens with the UTF-16 mark.
  const info = kinds.find((dict) => dict.includes("/Producer"));
  assert.match(info, /\/Title <FEFF[0-9A-F]+>/u, "the title is written in an encoding that cannot hold it");
});

test("the words are drawn as glyphs, and the glyphs can be read back as words", { skip: FOUND === null && "no CJK font on this machine" }, () => {
  const read = readPdf(reportToPdf(REPORT, { title: "标题", language: "zh", figures: [figure()] }));
  const content = contentOf(read);
  assert.ok(content.includes(" Tf "), "nothing selects a font, so nothing is drawn");
  assert.ok(/<[\s0-9A-F]+> Tj/u.test(content), "no text is shown");

  // IDENTITY-H MEANS THE CODES ARE GLYPH IDS, which is why the subset must not
  // renumber. It also means the text cannot be copied out of the PDF unless a
  // reverse map is written — and a research report nobody can quote from has
  // lost most of its point.
  const toUnicode = [...read.objects.values()].find((object) => object.data !== null
    && object.data.toString("latin1").includes("beginbfchar"));
  assert.ok(toUnicode, "there is no ToUnicode map, so the text cannot be selected or copied");
  const map = toUnicode.data.toString("latin1");
  // THE CMap SYNTAX CAPS `bfchar` AT A HUNDRED PAIRS. A reader handed three
  // thousand in one block stops at the first — so the whole document copies
  // out as the first hundred characters and then nothing.
  for (const block of map.matchAll(/(\d+) beginbfchar/gu)) {
    assert.ok(Number(block[1]) <= 100, `a bfchar block declares ${block[1]} pairs, and 100 is the limit`);
  }
  const face = loadFont(FOUND.path, FOUND.index);
  const gid = face.glyphFor("黑".codePointAt(0));
  assert.ok(map.includes(`<${gid.toString(16).toUpperCase().padStart(4, "0")}> <9ED1>`), "黑 does not map back to itself");
});

test("a picture is in the file, drawn, and its transparency with it", { skip: FOUND === null && "no CJK font on this machine" }, () => {
  const read = readPdf(reportToPdf(REPORT, { language: "zh", figures: [figure()] }));
  const images = [...read.objects.entries()].filter(([, object]) => object.dict.includes("/Subtype /Image"));
  // TWO: the picture and its alpha. PDF spells transparency as a second
  // greyscale image standing beside the first, so a PNG with an alpha channel
  // that produced one object has had its transparency silently dropped —
  // which on a chart with a transparent background is a black rectangle.
  assert.equal(images.length, 2, `${images.length} image objects; a picture with alpha is the picture and its SMask`);
  const main = images.find(([, object]) => object.dict.includes("/SMask"));
  assert.ok(main, "the picture does not name a soft mask, so its alpha channel went nowhere");
  assert.match(main[1].dict, /\/Width 40 .*\/Height 24/u, "the picture was written at the wrong size");
  // AND IT IS ACTUALLY PLACED. An XObject nothing draws is bytes in the file
  // and a blank space on the page.
  assert.match(contentOf(read), new RegExp(`/I${main[0]} Do`, "u"), "the picture is embedded and never drawn");
});

test("a figure is fitted to a box rather than stretched to one", { skip: FOUND === null && "no CJK font on this machine" }, () => {
  // SCALED BY WIDTH ALONE, a 500×749 portrait photograph came out at 375 by
  // 562pt — three quarters of a page's text height. Measured on a real
  // report: it took a page of its own and left the page before it two
  // thirds blank, which reads as a broken export rather than a big picture.
  const bytes = makePng(500, 749, false);
  const read = readPdf(reportToPdf(REPORT, { language: "zh", figures: [{ ...figure(), bytes }] }));
  const placed = /q ([\d.]+) 0 0 ([\d.]+) [\d.]+ [\d.]+ cm \/I\d+ Do Q/u.exec(contentOf(read));
  assert.ok(placed, "the picture is never placed");
  // A4 less 56.7pt margins, two fifths of the text height.
  const ceiling = (841.89 - 56.7 * 2) * 0.4;
  assert.ok(Number(placed[2]) <= ceiling + 0.5, `the figure stands ${placed[2]}pt against a ceiling of ${ceiling.toFixed(1)}`);
  assert.equal(
    Math.round((Number(placed[1]) / Number(placed[2])) * 1000),
    Math.round((500 / 749) * 1000),
    "the cap squashed the picture instead of scaling it",
  );

  // AND A SMALL ONE IS LEFT ALONE. A 150px mark blown out to the column is
  // a blurred rectangle where something small belongs.
  const mark = readPdf(reportToPdf(REPORT, { language: "zh", figures: [{ ...figure(), bytes: makePng(150, 150, false) }] }));
  const kept = /q ([\d.]+) 0 0 ([\d.]+) [\d.]+ [\d.]+ cm \/I\d+ Do Q/u.exec(contentOf(mark));
  assert.equal(Number(kept[1]).toFixed(2), (150 * 0.75).toFixed(2), "a small figure was stretched to the column");
});

test("what cannot be drawn falls back to the line the .md prints", { skip: FOUND === null && "no CJK font on this machine" }, () => {
  // THE SAME RULE THE .docx FOLLOWS. A figure with no bytes, an undecodable
  // header or a format with no PDF filter is a sentence, not a blank frame.
  for (const [why, over] of [
    ["a webp", { mime: "image/webp" }],
    ["a corrupt png", { bytes: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex") }],
    ["no bytes", { bytes: Buffer.alloc(0) }],
  ]) {
    const read = readPdf(reportToPdf(REPORT, { language: "zh", figures: [{ ...figure(), ...over }] }));
    assert.equal(
      [...read.objects.values()].filter((object) => object.dict.includes("/Subtype /Image")).length, 0,
      `${why} was embedded anyway`,
    );
    assert.ok(!contentOf(read).includes(" Do"), `${why} left a draw operator with nothing behind it`);
  }
});

test("a report longer than a page becomes more than one", { skip: FOUND === null && "no CJK font on this machine" }, () => {
  // THE CURSOR HAS TO WRAP. A writer that never starts a second page draws the
  // rest of the document below the bottom edge, where it is in the file and
  // on no page — which looks, in a reader, exactly like a truncated report.
  const paragraph = "推理时序扩展的训练侧做法在过去一年里从边缘概念跃入核心议题，本章按公开材料梳理三条路径[7]。";
  const long = Array.from({ length: 40 }, (unused, at) => `## 第 ${at + 1} 章\n\n${paragraph}\n`).join("\n");
  const read = readPdf(reportToPdf(long, { title: "长报告", language: "zh" }));
  const pages = [...read.objects.values()].filter((object) => object.dict.includes("/Type /Page "));
  assert.ok(pages.length > 1, "forty chapters came out on one page");
  const tree = [...read.objects.values()].find((object) => object.dict.includes("/Type /Pages"));
  assert.match(tree.dict, new RegExp(`/Count ${pages.length}\\b`, "u"), "the page tree counts a different number of pages than exist");
  // AND EVERY PAGE IS IN THE TREE. A page object nothing lists is a page no
  // reader will show.
  for (const [number, object] of read.objects) {
    if (object.dict.includes("/Type /Page ")) {
      assert.ok(tree.dict.includes(`${number} 0 R`), `page ${number} is not in the page tree`);
    }
  }
});

test("a machine with no CJK font is told so, rather than handed empty boxes", () => {
  // A FACT ABOUT THE MACHINE, NOT ABOUT THE REPORT. Falling back to a Latin
  // face would produce a PDF of the right length with a box where every
  // Chinese character should be — which reads as a broken report, and sends
  // the reader looking in the wrong place entirely.
  assert.throws(
    () => reportToPdf("正文", { fontPath: "/no/such/font.ttf", figures: [] }),
    /no CJK font/u,
    "a machine with no font produces a PDF instead of saying it cannot",
  );
});
