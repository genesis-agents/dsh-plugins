/**
 * A report as a real PDF, with its pictures in it.
 *
 * THE EXPORT WAS `window.print()`. That is the browser's own engine laying out
 * our screen, which means: the reader has to pick "Save as PDF" out of a print
 * dialog, the page carries whatever the harness happened to be drawing, the
 * result differs by browser, and it cannot be produced by anything that is not
 * a person standing at a window — no schedule, no route, no automation. The
 * note that defended it said a PDF writer "would have to embed a CJK font to
 * render one sentence of this report". It does. That is this file and
 * mission-font.js, and it is the whole cost.
 *
 * WHAT IT IS NOT. Not a layout engine: no floats, no columns, no hyphenation,
 * no widow control, no tables drawn as tables. It is one column of blocks —
 * headings, paragraphs, lists, quotes, code, pictures — broken into lines by
 * measured advance widths and poured onto A4. A research report is that shape,
 * and every feature past it would be code with no reader.
 *
 * WHY NOT HTML-TO-PDF. Because there is no renderer here to run it. The only
 * two ways to get one are a headless browser (a 300MB dependency, in a plugin
 * whose whole package has none) or the browser the reader is already holding,
 * which is the thing being replaced.
 */
import { deflateSync, inflateSync } from "node:zlib";

import { findSystemFont, loadFont } from "./mission-font.js";

/** A4 in points, and the margin the .docx uses, converted from twips. */
const PAGE = { width: 595.28, height: 841.89, margin: 56.7 };
/** How the blocks are sized, in points. */
const SIZE = { h1: 19, h2: 15.5, h3: 13, h4: 11.5, body: 10.5, code: 9, caption: 9 };
/** Multiplied by the size for the baseline-to-baseline step. CJK wants more. */
const LEADING = 1.62;

/**
 * Characters that may not open a line.
 *
 * CHINESE TYPESETTING'S ONE HARD RULE, and the one a naive break gets wrong
 * every few lines: closing punctuation belongs to the line its clause ended on.
 * A comma alone at the left margin is the single thing that makes a machine-set
 * Chinese page look machine-set.
 */
const NO_START = new Set([..."。，、；：？！）］｝」』》〉】〕”’〞…‥·・-—/%),.;:!?]}\"'"]);
/** …and these may not end one: an opening bracket orphaned at the right edge. */
const NO_END = new Set([..."（［｛「『《〈【〔“‘〝([{"]);

/** Escape for a PDF literal string. */
const literal = (text) => String(text).replace(/[\\()]/gu, (ch) => `\\${ch}`);

/**
 * A metadata string, in the one encoding that can hold a Chinese title.
 *
 * A LITERAL `(…)` STRING IS PDFDocEncoding, which is Latin-1 with a few
 * substitutions — so a title written into one comes out of the reader's window
 * bar as mojibake, one box per byte. The spec's answer is a hex string opening
 * with the UTF-16BE byte-order mark, and every reader honours it.
 *
 * ASCII STILL GOES THROUGH AS A LITERAL, because a hex string is unreadable in
 * a text editor and most of what this writes — the producer, the language — is
 * ASCII that somebody may want to grep for.
 * @param text - the value.
 * @returns the PDF string, brackets and all.
 */
function pdfText(text) {
  const value = String(text ?? "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/u.test(value)) return `(${literal(value)})`;
  const utf16 = Buffer.from(`﻿${value}`, "utf16le").swap16();
  return `<${utf16.toString("hex").toUpperCase()}>`;
}

/**
 * Collects objects and writes the file.
 *
 * INDIRECT OBJECTS AND A CROSS-REFERENCE TABLE is the whole of a PDF's
 * structure: every object is numbered, the table says what byte each starts at,
 * and the trailer says where the table is. Getting the byte offsets right is
 * the only part a reader will refuse the file over, so they are counted from
 * the buffer as it is built rather than predicted.
 */
class Pdf {
  #objects = [];

  /**
   * Reserve a number without writing the object yet.
   *
   * NEEDED BECAUSE THE GRAPH HAS CYCLES. A page names its parent and the pages
   * node lists its children, so one of the two has to be numbered before it can
   * be written.
   * @returns the object number.
   */
  reserve() {
    this.#objects.push(null);
    return this.#objects.length;
  }

  /**
   * Write an object, at a reserved number or a fresh one.
   * @param body - the dictionary or value, as a string.
   * @param stream - stream bytes, if this object is a stream.
   * @param at - a number from {@link reserve}.
   * @returns the object number.
   */
  put(body, stream = null, at = 0) {
    const number = at > 0 ? at : this.reserve();
    this.#objects[number - 1] = { body, stream };
    return number;
  }

  /**
   * A stream, deflated, with the dictionary the filter needs.
   * @param dict - the dictionary's own entries, without the length or filter.
   * @param bytes - the payload.
   * @param at - a reserved number.
   * @returns the object number.
   */
  stream(dict, bytes, at = 0) {
    // ALWAYS DEFLATED. Text streams compress to about a fifth and font programs
    // to about a third; the only thing that does not is a JPEG, which is why
    // that one is written with its own filter instead of through here.
    const packed = deflateSync(bytes);
    return this.put(`<< ${dict} /Filter /FlateDecode /Length ${packed.length} >>`, packed, at);
  }

  /**
   * Serialise everything written so far.
   * @param root - the catalogue's object number.
   * @param info - the document information dictionary's object number, or 0.
   * @returns the file.
   */
  build(root, info = 0) {
    const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let at = parts[0].length;
    const offsets = [];
    this.#objects.forEach((object, index) => {
      if (object === null) throw new Error(`object ${index + 1} was reserved and never written`);
      offsets.push(at);
      const head = Buffer.from(`${index + 1} 0 obj\n${object.body}\n`, "latin1");
      const tail = Buffer.from("endobj\n", "latin1");
      if (object.stream === null) {
        parts.push(head, tail);
        at += head.length + tail.length;
      } else {
        const open = Buffer.from("stream\n", "latin1");
        const close = Buffer.from("\nendstream\n", "latin1");
        parts.push(head, open, object.stream, close, tail);
        at += head.length + open.length + object.stream.length + close.length + tail.length;
      }
    });
    const xrefAt = at;
    const rows = [`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`];
    for (const offset of offsets) rows.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
    const held = info > 0 ? ` /Info ${info} 0 R` : "";
    rows.push(`trailer\n<< /Size ${offsets.length + 1} /Root ${root} 0 R${held} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    parts.push(Buffer.from(rows.join(""), "latin1"));
    return Buffer.concat(parts);
  }
}

/**
 * One embedded face: the subset, the descriptor, and the widths.
 *
 * IDENTITY-H, WHICH MEANS THE CHARACTER CODES ARE GLYPH IDS. The alternative
 * is a `ToUnicode`-shaped encoding with a real cmap in it, and for a CJK face
 * that is thousands of ranges written twice. Identity-H hands the renderer the
 * glyph directly, which is also why mission-font.js does not renumber glyphs.
 *
 * AND THAT COSTS SELECTABLE TEXT UNLESS `ToUnicode` IS WRITTEN. A PDF whose
 * text cannot be copied out is a PDF nobody can quote from, which for a
 * research report is most of the point — so the reverse map goes in too.
 * @param pdf - the file being built.
 * @param face - a parsed font.
 * @param used - glyph id → the codepoint it was chosen for.
 * @param tag - a six-letter subset prefix, as the spec asks for.
 * @returns the Type0 font's object number.
 */
function embedFont(pdf, face, used, tag) {
  const gids = [...used.keys()].sort((a, b) => a - b);
  const program = face.subset(new Set(gids));
  const scale = 1000 / face.unitsPerEm;

  const file = pdf.stream(`/Length1 ${program.length}`, program);
  const descriptor = pdf.put([
    "<< /Type /FontDescriptor",
    `/FontName /${tag}+Embedded`,
    // 4 IS "SYMBOLIC", WHICH IS WHAT A FONT ADDRESSED BY GLYPH ID IS. Flagging
    // it non-symbolic invites a reader to apply a standard encoding on top of
    // Identity-H, and the result is the right glyphs in the wrong places.
    "/Flags 4",
    `/FontBBox [${Math.round(face.bbox.xMin * scale)} ${Math.round(face.bbox.yMin * scale)} ${Math.round(face.bbox.xMax * scale)} ${Math.round(face.bbox.yMax * scale)}]`,
    "/ItalicAngle 0",
    `/Ascent ${Math.round(face.ascent * scale)}`,
    `/Descent ${Math.round(face.descent * scale)}`,
    // NOT MEASURED, AND IT DOES NOT NEED TO BE. `StemV` is a hinting hint for
    // renderers that synthesise a face they cannot embed; ours is embedded.
    "/StemV 80",
    `/CapHeight ${Math.round(face.ascent * scale)}`,
    `/FontFile2 ${file} 0 R >>`,
  ].join(" "));

  // THE W ARRAY, RUN-LENGTH ENCODED. A CJK face is twenty thousand glyphs of
  // exactly one em, so the `[c [w w w]]` form would write that width once per
  // glyph; the `[first last w]` form writes it once per run. On a real report
  // this is the difference between a 200KB array and a 2KB one.
  const widths = [];
  let run = null;
  for (const gid of gids) {
    const width = Math.round(face.advanceOf(gid) * scale);
    if (run !== null && width === run.width && gid === run.last + 1) { run.last = gid; continue; }
    if (run !== null) widths.push(`${run.first} ${run.last} ${run.width}`);
    run = { first: gid, last: gid, width };
  }
  if (run !== null) widths.push(`${run.first} ${run.last} ${run.width}`);

  const toUnicode = pdf.stream("", Buffer.from([
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Embedded-UCS2 def /CMapType 2 def",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    // IN CHUNKS OF A HUNDRED, which the CMap syntax requires: `bfchar` takes at
    // most 100 pairs, and a reader given 3000 stops at the first one.
    ...chunk(gids, 100).map((group) => [
      `${group.length} beginbfchar`,
      ...group.map((gid) => `<${hex4(gid)}> <${utf16(used.get(gid))}>`),
      "endbfchar",
    ].join("\n")),
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n"), "utf8"));

  const cid = pdf.put([
    "<< /Type /Font /Subtype /CIDFontType2",
    `/BaseFont /${tag}+Embedded`,
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>",
    `/FontDescriptor ${descriptor} 0 R`,
    // THE DEFAULT FOR A GLYPH THE ARRAY DOES NOT COVER. 1000 is one em, which
    // is right for the ideographs and wrong for nothing that gets drawn — every
    // glyph the document uses is in the array.
    "/DW 1000",
    `/W [${widths.join(" ")}]`,
    "/CIDToGIDMap /Identity >>",
  ].join(" "));

  return pdf.put([
    "<< /Type /Font /Subtype /Type0",
    `/BaseFont /${tag}+Embedded`,
    "/Encoding /Identity-H",
    `/DescendantFonts [${cid} 0 R]`,
    `/ToUnicode ${toUnicode} 0 R >>`,
  ].join(" "));
}

/** Split into groups of at most `size`. */
function chunk(list, size) {
  const out = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

/** Four hex digits, upper case, as a PDF hex string wants. */
const hex4 = (value) => value.toString(16).toUpperCase().padStart(4, "0");

/** A codepoint as UTF-16BE hex, surrogate pair and all. */
function utf16(codePoint) {
  const point = Number.isFinite(codePoint) ? codePoint : 0xfffd;
  if (point <= 0xffff) return hex4(point);
  const above = point - 0x10000;
  return hex4(0xd800 + (above >> 10)) + hex4(0xdc00 + (above & 0x3ff));
}

/**
 * A JPEG, handed to the reader as it stands.
 *
 * NOT DECODED. `DCTDecode` is a filter every PDF reader implements, so the
 * file's own bytes are the stream — which also means the picture in the PDF is
 * bit for bit the picture the publisher served. A chart re-encoded on the way
 * through is a chart this export has edited.
 * @param bytes - the file.
 * @returns `{ width, height, components, bits }`, or null when the header will not say.
 */
function readJpeg(bytes) {
  let at = 2;
  while (at + 8 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        bits: bytes[at + 4],
        height: bytes.readUInt16BE(at + 5),
        width: bytes.readUInt16BE(at + 7),
        components: bytes[at + 9],
      };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/** Undo one PNG scanline filter, in place, against the row above it. */
function unfilter(type, row, prior, stride) {
  if (type === 0) return;
  for (let at = 0; at < row.length; at += 1) {
    const left = at >= stride ? row[at - stride] : 0;
    const up = prior[at] ?? 0;
    const upLeft = at >= stride ? (prior[at - stride] ?? 0) : 0;
    let add = 0;
    if (type === 1) add = left;
    else if (type === 2) add = up;
    else if (type === 3) add = (left + up) >> 1;
    else if (type === 4) {
      // Paeth: whichever of the three neighbours the gradient predicts.
      const p = left + up - upLeft;
      const dLeft = Math.abs(p - left);
      const dUp = Math.abs(p - up);
      const dUpLeft = Math.abs(p - upLeft);
      add = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
    } else throw new Error(`unknown PNG filter ${type}`);
    row[at] = (row[at] + add) & 0xff;
  }
}

/**
 * A PNG, decoded to raw samples.
 *
 * DECODED BECAUSE PDF HAS NO PNG FILTER. `FlateDecode` plus a `Predictor` can
 * carry the compression and the row filters, but only for the colour types
 * whose layout PDF already understands — and palette images with a `tRNS`
 * chunk, which is most charts with a transparent background, are not among
 * them. Decoding once here is simpler than a matrix of cases that each get the
 * predictor parameters subtly wrong.
 *
 * ALPHA BECOMES AN SMask, which is how PDF spells transparency: a second
 * greyscale image, one sample per pixel, standing beside the first.
 * @param bytes - the file.
 * @returns `{ width, height, colorSpace, data, alpha, bits }`, or null.
 */
function readPng(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  let at = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const from = at + 8;
    if (from + length > bytes.length) break;
    if (type === "IHDR") {
      header = {
        width: bytes.readUInt32BE(from), height: bytes.readUInt32BE(from + 4),
        depth: bytes[from + 8], color: bytes[from + 9],
        interlace: bytes[from + 12],
      };
    } else if (type === "PLTE") palette = bytes.subarray(from, from + length);
    else if (type === "tRNS") transparency = bytes.subarray(from, from + length);
    else if (type === "IDAT") idat.push(bytes.subarray(from, from + length));
    else if (type === "IEND") break;
    at = from + length + 4;
  }
  if (header === null || idat.length === 0) return null;
  // ADAM7 IS SEVEN INTERLACED PASSES and a different de-filtering walk. It is
  // vanishingly rare outside 1990s web graphics, and the caller's fallback —
  // the attribution line the .md export prints — is a better answer than a
  // second decoder nothing exercises.
  if (header.interlace !== 0) return null;
  const { width, height, depth, color } = header;
  if (width === 0 || height === 0) return null;

  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (channels === 0) return null;
  if (![1, 2, 4, 8, 16].includes(depth)) return null;
  if (depth !== 8 && depth !== 16 && color !== 3 && color !== 0) return null;

  // A CORRUPT `IDAT` IS A PICTURE WE CANNOT DRAW, not an export that fails.
  // `inflateSync` throws on a bad checksum, and one truncated figure must not
  // take the whole report's PDF down — null here is the caller's cue to print
  // the attribution line instead, which is the same answer the .docx gives.
  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const stride = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (raw.length < (rowBytes + 1) * height) return null;

  const pixels = Buffer.alloc(rowBytes * height);
  let prior = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1);
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + rowBytes));
    unfilter(raw[start], row, prior, stride);
    row.copy(pixels, y * rowBytes);
    prior = row;
  }

  /** One sample, whatever the bit depth packs it into. */
  const sampleAt = (y, index) => {
    if (depth === 8) return pixels[y * rowBytes + index];
    if (depth === 16) return pixels[y * rowBytes + index * 2];
    const bit = index * depth;
    const byte = pixels[y * rowBytes + (bit >> 3)];
    return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };

  const colour = [];
  const alpha = [];
  const max = (1 << depth) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (color === 3) {
        const index = sampleAt(y, x);
        const to = index * 3;
        colour.push(palette?.[to] ?? 0, palette?.[to + 1] ?? 0, palette?.[to + 2] ?? 0);
        alpha.push(transparency === null ? 255 : (transparency[index] ?? 255));
      } else if (color === 0) {
        const value = sampleAt(y, x);
        colour.push(depth === 8 || depth === 16 ? value : Math.round((value / max) * 255));
        alpha.push(255);
      } else if (color === 2) {
        colour.push(sampleAt(y, x * 3), sampleAt(y, x * 3 + 1), sampleAt(y, x * 3 + 2));
        alpha.push(255);
      } else if (color === 4) {
        colour.push(sampleAt(y, x * 2));
        alpha.push(sampleAt(y, x * 2 + 1));
      } else {
        colour.push(sampleAt(y, x * 4), sampleAt(y, x * 4 + 1), sampleAt(y, x * 4 + 2));
        alpha.push(sampleAt(y, x * 4 + 3));
      }
    }
  }
  const opaque = alpha.every((value) => value === 255);
  return {
    width, height, bits: 8,
    colorSpace: color === 2 || color === 3 || color === 6 ? "/DeviceRGB" : "/DeviceGray",
    data: Buffer.from(colour),
    alpha: opaque ? null : Buffer.from(alpha),
  };
}

/**
 * Put one picture in the file.
 * @param pdf - the file being built.
 * @param bytes - the image.
 * @param mime - its type.
 * @returns `{ object, width, height }`, or null when it cannot be carried.
 */
function embedImage(pdf, bytes, mime) {
  if (mime === "image/jpeg") {
    const read = readJpeg(bytes);
    if (read === null || read.components === 0) return null;
    // FOUR COMPONENTS IS CMYK, and Adobe's own encoder writes those inverted —
    // which is why a CMYK JPEG dropped into a PDF without the `Decode` array
    // comes out as a photographic negative.
    const space = read.components === 1 ? "/DeviceGray" : read.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
    const invert = read.components === 4 ? " /Decode [1 0 1 0 1 0 1 0]" : "";
    const object = pdf.put(
      `<< /Type /XObject /Subtype /Image /Width ${read.width} /Height ${read.height}`
      + ` /ColorSpace ${space}${invert} /BitsPerComponent ${read.bits}`
      + ` /Filter /DCTDecode /Length ${bytes.length} >>`,
      bytes,
    );
    return { object, width: read.width, height: read.height };
  }
  if (mime !== "image/png") return null;
  const read = readPng(bytes);
  if (read === null) return null;
  let mask = "";
  if (read.alpha !== null) {
    const smask = pdf.stream(
      `/Type /XObject /Subtype /Image /Width ${read.width} /Height ${read.height}`
      + " /ColorSpace /DeviceGray /BitsPerComponent 8",
      read.alpha,
    );
    mask = ` /SMask ${smask} 0 R`;
  }
  const object = pdf.stream(
    `/Type /XObject /Subtype /Image /Width ${read.width} /Height ${read.height}`
    + ` /ColorSpace ${read.colorSpace} /BitsPerComponent ${read.bits}${mask}`,
    read.data,
  );
  return { object, width: read.width, height: read.height };
}

/**
 * Split a line of Markdown into runs, on the two marks the writer actually uses.
 *
 * THE SAME TWO THE .docx READS, and no more: `**bold**` and `` `code` ``. A
 * third syntax here that mission-docx.js does not honour would make the two
 * exports of one report disagree about which words are emphasised.
 * @param line - the source.
 * @returns `[{ text, bold, code }]`.
 */
function runsOf(line) {
  const out = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/gu;
  let at = 0;
  for (const hit of String(line).matchAll(pattern)) {
    if (hit.index > at) out.push({ text: line.slice(at, hit.index), bold: false, code: false });
    if (hit[1] !== undefined) out.push({ text: hit[1], bold: true, code: false });
    else out.push({ text: hit[2], bold: false, code: true });
    at = hit.index + hit[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at), bold: false, code: false });
  return out.filter((piece) => piece.text !== "");
}

/**
 * Markdown to the blocks this writer pours onto pages.
 *
 * THE SAME GRAMMAR mission-docx.js READS. Both are fed the identical string by
 * the route, and a report whose Word copy has a heading its PDF renders as body
 * text is a report where one of the two is lying about the document's shape.
 * @param markdown - the report.
 * @param figures - index → what to draw for `:::figure N`.
 * @returns the blocks.
 */
function blocksOf(markdown, figures) {
  const out = [];
  let fenced = false;
  let figure = null;
  for (const line of String(markdown ?? "").split(/\r?\n/u)) {
    if (/^```/u.test(line.trim())) { fenced = !fenced; continue; }
    if (fenced) { out.push({ kind: "code", runs: [{ text: line, bold: false, code: true }] }); continue; }

    const opens = /^:::figure[ \t]+(\d{1,3})[ \t]*$/u.exec(line.trim());
    if (opens !== null) { figure = Number(opens[1]); continue; }
    if (figure !== null && line.trim() === ":::") {
      const held = figures.get(figure);
      if (held === undefined) out.push({ kind: "body", runs: runsOf(`［图 ${figure}］`) });
      else {
        out.push({ kind: "image", figure: held });
        if (held.caption !== "") out.push({ kind: "caption", runs: runsOf(held.caption) });
      }
      figure = null;
      continue;
    }
    if (figure !== null) continue;
    if (line.trim() === "") continue;

    const heading = /^(#{1,4})[ \t]+(.*)$/u.exec(line);
    if (heading !== null) { out.push({ kind: `h${heading[1].length}`, runs: runsOf(heading[2]) }); continue; }
    const bullet = /^[ \t]*[-*][ \t]+(.*)$/u.exec(line);
    if (bullet !== null) { out.push({ kind: "bullet", runs: runsOf(bullet[1]) }); continue; }
    const ordered = /^[ \t]*(\d+)\.[ \t]+(.*)$/u.exec(line);
    if (ordered !== null) { out.push({ kind: "ordered", marker: `${ordered[1]}.`, runs: runsOf(ordered[2]) }); continue; }
    const quoted = /^[ \t]*>[ \t]?(.*)$/u.exec(line);
    if (quoted !== null) { out.push({ kind: "quote", runs: runsOf(quoted[1]) }); continue; }
    if (/^[ \t]*\|/u.test(line)) {
      const cells = line.split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
      if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell))) continue;
      out.push({ kind: "code", runs: [{ text: cells.join("   "), bold: false, code: true }] });
      continue;
    }
    out.push({ kind: "body", runs: runsOf(line) });
  }
  return out;
}

/** How each block is drawn: which face, what size, how far in, what after. */
const STYLE = {
  h1: { size: SIZE.h1, bold: true, indent: 0, before: 14, after: 8 },
  h2: { size: SIZE.h2, bold: true, indent: 0, before: 12, after: 6 },
  h3: { size: SIZE.h3, bold: true, indent: 0, before: 10, after: 5 },
  h4: { size: SIZE.h4, bold: true, indent: 0, before: 8, after: 4 },
  body: { size: SIZE.body, bold: false, indent: 0, before: 0, after: 6 },
  bullet: { size: SIZE.body, bold: false, indent: 18, before: 0, after: 3, marker: "•" },
  ordered: { size: SIZE.body, bold: false, indent: 18, before: 0, after: 3 },
  quote: { size: SIZE.body, bold: false, indent: 18, before: 2, after: 6, grey: true },
  code: { size: SIZE.code, bold: false, indent: 0, before: 0, after: 2, grey: true },
  caption: { size: SIZE.caption, bold: false, indent: 0, before: 2, after: 10, grey: true, centre: true },
  image: { size: SIZE.body, bold: false, indent: 0, before: 6, after: 2 },
};

/**
 * A report as a PDF.
 *
 * @param markdown - the report body, `:::figure N` blocks intact.
 * @param options - `{ title, language, figures, fontPath }`. `figures` is
 *   `[{ index, bytes, mime, caption }]`; `fontPath` overrides the search.
 * @returns the file, as a Buffer.
 * @throws when no CJK font can be found, which is a fact about the machine
 *   rather than about the report, and must not be silently drawn as blanks.
 */
export function reportToPdf(markdown, { title = "", language = "zh", figures = [], fontPath } = {}) {
  const found = findSystemFont(fontPath);
  if (found === null) {
    throw new Error(
      "no CJK font on this machine, so a PDF of this report would be a page of empty boxes."
      + " Install one (Windows: Microsoft YaHei; macOS: PingFang; Linux: fonts-noto-cjk) and export again.",
    );
  }
  const regular = loadFont(found.path, found.index);
  // A REAL BOLD FACE WHEN THERE IS ONE. Synthesising bold by stroking the
  // outline — which is the alternative, and what the `Tr 2` render mode does —
  // thickens Chinese strokes unevenly, because a character with twenty strokes
  // gets twenty times the added ink of one with a single stroke.
  const bold = found.bold === null ? regular : loadFont(found.bold.path, found.bold.index);

  const pdf = new Pdf();
  const byIndex = new Map();
  for (const figure of Array.isArray(figures) ? figures : []) {
    if (!Buffer.isBuffer(figure?.bytes)) continue;
    const drawn = embedImage(pdf, figure.bytes, figure.mime);
    if (drawn === null) continue;
    byIndex.set(Number(figure.index), { ...drawn, caption: typeof figure.caption === "string" ? figure.caption : "" });
  }

  const blocks = blocksOf(markdown, byIndex);
  if (String(title ?? "").trim() !== "") blocks.unshift({ kind: "h1", runs: runsOf(title) });

  const column = PAGE.width - PAGE.margin * 2;
  const usedRegular = new Map();
  const usedBold = new Map();

  /** The face a run is drawn in, and the map that records its glyphs. */
  const faceFor = (piece, style) => ((piece.bold || style.bold) ? { face: bold, used: usedBold } : { face: regular, used: usedRegular });

  /**
   * Break one block's runs into lines that fit.
   *
   * MEASURED, NOT COUNTED. Chinese is one em a character and Latin is not, so
   * a break by character count leaves either half the column empty or the text
   * over the margin depending on which language the sentence is in.
   */
  const linesOf = (runs, style, width) => {
    const lines = [];
    let line = [];
    let at = 0;
    let lastBreak = -1;
    const push = () => { if (line.length > 0) lines.push(line); line = []; at = 0; lastBreak = -1; };
    for (const piece of runs) {
      const { face } = faceFor(piece, style);
      const size = piece.code ? style.size * 0.95 : style.size;
      for (const ch of piece.text) {
        const code = ch.codePointAt(0);
        const advance = face.advanceOf(face.glyphFor(code)) / face.unitsPerEm * size;
        if (at + advance > width && line.length > 0) {
          // BACK UP TO THE LAST PLACE A BREAK WAS ALLOWED. Without this a Latin
          // word is cut mid-syllable; with it, and no opportunity found, the
          // line breaks here anyway — which is right for an unbroken 80-column
          // URL, the one case where refusing to break loses the text entirely.
          if (lastBreak > 0 && lastBreak < line.length) {
            const carry = line.splice(lastBreak);
            lines.push(line);
            line = carry;
            at = carry.reduce((sum, cell) => sum + cell.advance, 0);
          } else push();
          lastBreak = -1;
        }
        line.push({ ch, code, advance, piece, size });
        at += advance;
        // WHERE THE NEXT LINE MAY START. A space is consumed by the break; a
        // CJK character allows one after it unless what follows may not open a
        // line, and an opening bracket may not end one.
        const isSpace = ch === " " || ch === "\t";
        const wide = code > 0x2e80 && code < 0xfe70;
        if ((isSpace || wide) && !NO_END.has(ch)) lastBreak = line.length;
      }
    }
    push();
    // A TRAILING SPACE AT A BREAK IS INK NOBODY ASKED FOR, and it pushes a
    // centred caption off centre.
    return lines
      .map((cells) => {
        let end = cells.length;
        while (end > 0 && (cells[end - 1].ch === " " || cells[end - 1].ch === "\t")) end -= 1;
        const trimmed = cells.slice(0, end);
        // …and a line that starts with the space the break left behind.
        let start = 0;
        while (start < trimmed.length && trimmed[start].ch === " ") start += 1;
        return trimmed.slice(start);
      })
      .filter((cells) => cells.length > 0);
  };

  const pages = [];
  let ops = [];
  let y = PAGE.height - PAGE.margin;
  const newPage = () => { pages.push(ops); ops = []; y = PAGE.height - PAGE.margin; };
  const room = (height) => {
    if (y - height >= PAGE.margin) return;
    newPage();
  };

  /** Draw one laid-out line at the current cursor. */
  const draw = (cells, style, left) => {
    if (cells.length === 0) return;
    const leading = style.size * LEADING;
    room(leading);
    y -= leading;
    let x = left;
    let open = null;
    const flush = () => { if (open !== null) { ops.push(`${open.glyphs}> Tj ET`); open = null; } };
    for (const cell of cells) {
      const { face, used } = faceFor(cell.piece, style);
      const gid = face.glyphFor(cell.code);
      used.set(gid, cell.code);
      const name = face === bold ? "/FB" : "/FR";
      const grey = style.grey === true || cell.piece.code;
      const key = `${name}|${cell.size}|${grey}`;
      if (open === null || open.key !== key) {
        flush();
        ops.push(`BT ${grey ? "0.35 0.36 0.38 rg" : "0 0 0 rg"} ${name} ${cell.size.toFixed(2)} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <`);
        open = { key, glyphs: "" };
      }
      open.glyphs += hex4(gid);
      x += cell.advance;
    }
    flush();
  };

  for (const block of blocks) {
    const style = STYLE[block.kind] ?? STYLE.body;
    y -= style.before;

    if (block.kind === "image") {
      // SCALED TO THE COLUMN, AND NEVER UP. The same rule the .docx applies,
      // and the same reason: a 2400px chart at its own size runs off the page,
      // and a 200px thumbnail blown up to the column is a blurred rectangle.
      const natural = block.figure.width * 0.75;
      const scale = natural > column ? column / natural : 1;
      const width = natural * scale;
      const height = block.figure.height * 0.75 * scale;
      // A PICTURE TALLER THAN A PAGE IS SHRUNK, not clipped: PDF has no
      // mechanism for continuing an image onto the next page, so the choice is
      // between a smaller chart and half a chart.
      const capacity = PAGE.height - PAGE.margin * 2;
      const fit = height > capacity ? capacity / height : 1;
      room(height * fit);
      y -= height * fit;
      const left = PAGE.margin + (column - width * fit) / 2;
      ops.push(`q ${(width * fit).toFixed(2)} 0 0 ${(height * fit).toFixed(2)} ${left.toFixed(2)} ${y.toFixed(2)} cm /I${block.figure.object} Do Q`);
      y -= style.after;
      continue;
    }

    const marker = block.kind === "bullet" ? STYLE.bullet.marker : block.kind === "ordered" ? block.marker : null;
    const left = PAGE.margin + style.indent;
    const lines = linesOf(block.runs, style, column - style.indent);
    lines.forEach((cells, index) => {
      if (style.centre === true) {
        const width = cells.reduce((sum, cell) => sum + cell.advance, 0);
        draw(cells, style, PAGE.margin + (column - width) / 2);
      } else draw(cells, style, left);
      // THE MARKER HANGS IN THE INDENT, on the first line only, and it is drawn
      // AFTER the line so the cursor is already on that line's baseline.
      if (index === 0 && marker !== null) {
        const cells2 = linesOf([{ text: marker, bold: false, code: false }], style, style.indent);
        if (cells2.length > 0) {
          const held = y;
          y += style.size * LEADING;
          draw(cells2[0], style, PAGE.margin);
          y = held;
        }
      }
    });
    y -= style.after;
  }
  pages.push(ops);

  const fontRegular = usedRegular.size === 0 ? null : embedFont(pdf, regular, usedRegular, "SWMREG");
  const fontBold = usedBold.size === 0 ? null : embedFont(pdf, bold, usedBold, "SWMBLD");
  const images = [...byIndex.values()].map((figure) => `/I${figure.object} ${figure.object} 0 R`);
  const resources = [
    "<< /Font <<",
    fontRegular === null ? "" : `/FR ${fontRegular} 0 R`,
    fontBold === null ? "" : `/FB ${fontBold} 0 R`,
    ">>",
    images.length === 0 ? "" : `/XObject << ${images.join(" ")} >>`,
    ">>",
  ].filter((part) => part !== "").join(" ");

  const pagesAt = pdf.reserve();
  const numbers = pages
    .filter((page) => page.length > 0)
    .map((page) => {
      const content = pdf.stream("", Buffer.from(page.join("\n"), "latin1"));
      return pdf.put(
        `<< /Type /Page /Parent ${pagesAt} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}]`
        + ` /Resources ${resources} /Contents ${content} 0 R >>`,
      );
    });
  pdf.put(
    `<< /Type /Pages /Count ${numbers.length} /Kids [${numbers.map((n) => `${n} 0 R`).join(" ")}] >>`,
    null,
    pagesAt,
  );
  const info = pdf.put(
    `<< /Title ${pdfText(title)} /Producer (dsh-agents-swarm) /Creator (dsh-agents-swarm) >>`,
  );
  const catalog = pdf.put(`<< /Type /Catalog /Pages ${pagesAt} 0 R /Lang (${literal(String(language).startsWith("en") ? "en" : "zh-CN")}) >>`);
  // THE INFO DICTIONARY HANGS OFF THE TRAILER, not the catalogue. Written and
  // then not referenced it is an object nothing reaches — which is not an
  // error, but it also means the reader's title bar says the filename, and the
  // one thing a person exporting a report wants named is the report.
  return pdf.build(catalog, info);
}
