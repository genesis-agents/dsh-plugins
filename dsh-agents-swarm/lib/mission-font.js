/**
 * TrueType, far enough to put Chinese into a PDF.
 *
 * WHY THIS FILE EXISTS AT ALL. A PDF's fourteen built-in fonts are Latin. A
 * report in Chinese drawn with any of them is a page of blanks, so the only way
 * to write one is to carry the outlines inside the file — which means reading a
 * font, taking the glyphs the document actually uses, and writing a valid font
 * back out. There is no smaller version of that job.
 *
 * WHAT IS DELIBERATELY NOT HERE. No shaping, no kerning, no ligatures, no
 * vertical writing, no OpenType `GSUB`. A research report is horizontal
 * left-to-right Chinese and Latin, both of which draw correctly from `cmap` and
 * `hmtx` alone; every one of those features would be code with no reader.
 *
 * AND NO GID REMAPPING. The usual subsetter renumbers glyphs to make `loca`
 * small, which means rewriting every composite glyph's component references and
 * keeping a map from old to new for the PDF's own encoding. This one keeps the
 * original glyph ids and empties the entries it does not need: `loca` stays
 * numGlyphs+1 entries — about 112KB on a full CJK face — and `glyf` holds only
 * what is used. Two hundred lines of remapping, and the bugs that live in them,
 * bought for a hundred kilobytes. That is the right trade for a file somebody
 * downloads once.
 */
import { readFileSync, existsSync } from "node:fs";

/** Tables a CIDFontType2 needs, plus the hinting ones when the face has them. */
const KEEP = ["cvt ", "fpgm", "prep", "gasp", "OS/2", "post"];

/**
 * Where a CJK face lives on each platform this can run on.
 *
 * ORDERED BY WHAT THE REPORT IS. These are research documents in Simplified
 * Chinese with Latin technical terms in them, so a face that covers both
 * without falling back comes first — every entry here does, which is why the
 * list is short rather than exhaustive.
 *
 * A `.ttc` IS A COLLECTION and the index says which face inside it. YaHei's
 * collection holds the UI variant second; the first is the text face.
 */
const CANDIDATES = [
  // Windows
  { path: "C:/Windows/Fonts/msyh.ttc", index: 0, bold: { path: "C:/Windows/Fonts/msyhbd.ttc", index: 0 } },
  { path: "C:/Windows/Fonts/simsun.ttc", index: 0, bold: null },
  { path: "C:/Windows/Fonts/simhei.ttf", index: 0, bold: null },
  // macOS. PingFang is the system face and is NOT always on disk as a file:
  // measured on a Sequoia machine, /System/Library/Fonts held STHeiti and
  // Hiragino and no PingFang at all. It stays first for the machines that have
  // it, and the two below are why the list does not stop there.
  { path: "/System/Library/Fonts/PingFang.ttc", index: 0, bold: null },
  { path: "/System/Library/Fonts/STHeiti Light.ttc", index: 0, bold: { path: "/System/Library/Fonts/STHeiti Medium.ttc", index: 0 } },
  { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", index: 0, bold: null },
  { path: "/System/Library/Fonts/Supplemental/Songti.ttc", index: 0, bold: null },
  // Linux
  { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", index: 0, bold: { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", index: 0 } },
  { path: "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", index: 0, bold: null },
  { path: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", index: 0, bold: null },
  { path: "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf", index: 0, bold: null },
];

/**
 * The first CJK face this machine has, or null.
 *
 * NULL IS AN ANSWER THE CALLER HAS TO HANDLE. A machine with no CJK font
 * cannot be given one by this function, and a PDF written with a Latin face
 * would be a page of blank boxes that looks like a bug in the report rather
 * than a missing font. The route says so instead.
 * AN OVERRIDE IS AN INSTRUCTION, NOT A PREFERENCE. A caller that names a font
 * and gets a different one has been ignored — and the way that shows up is a
 * report in the wrong typeface with nothing anywhere saying why. So a named
 * path that will not parse returns null and the export says it cannot, rather
 * than falling through to whatever the machine happens to have.
 * @param override - the one font to use, for a caller that knows.
 * @returns `{ path, index, bold }`, or null.
 */
export function findSystemFont(override) {
  const named = typeof override === "string" && override !== "";
  const list = named ? [{ path: override, index: 0, bold: null }] : CANDIDATES;
  for (const entry of list) {
    try {
      if (!existsSync(entry.path)) continue;
      // AND IT HAS TO PARSE. A path that exists is not a font: a truncated
      // download or a `.ttc` this reader cannot walk must fall through to the
      // next candidate rather than take the whole export down.
      loadFont(entry.path, entry.index);
      const bold = entry.bold !== null && existsSync(entry.bold.path) ? entry.bold : null;
      return { ...entry, bold };
    } catch { /* the next candidate */ }
  }
  return null;
}

/** Read a big-endian tag. */
const tagAt = (buffer, at) => buffer.toString("latin1", at, at + 4);

/**
 * Parse one face out of a `.ttf` or a `.ttc`.
 * @param path - the file.
 * @param index - which face, for a collection.
 * @returns the parsed face.
 */
export function loadFont(path, index = 0) {
  return parseFont(readFileSync(path), index);
}

/**
 * Parse a font already in memory.
 * @param buffer - the file.
 * @param index - which face, for a collection.
 * @returns `{ tables, unitsPerEm, numGlyphs, ascent, descent, glyphFor, advanceOf, subset }`.
 */
export function parseFont(buffer, index = 0) {
  let start = 0;
  if (tagAt(buffer, 0) === "ttcf") {
    const count = buffer.readUInt32BE(8);
    if (index >= count) throw new Error(`the collection holds ${count} faces, not ${index + 1}`);
    start = buffer.readUInt32BE(12 + index * 4);
  }
  const version = buffer.readUInt32BE(start);
  // 0x00010000 is TrueType outlines; "true" is the old Apple tag. `OTTO` is
  // CFF, whose glyphs are PostScript rather than quadratic — a different format
  // behind the same wrapper, and nothing below would read it correctly.
  if (version !== 0x00010000 && tagAt(buffer, start) !== "true") {
    throw new Error(`not a TrueType outline font (0x${version.toString(16)})`);
  }
  const count = buffer.readUInt16BE(start + 4);
  const tables = new Map();
  for (let at = 0; at < count; at += 1) {
    const row = start + 12 + at * 16;
    tables.set(tagAt(buffer, row), {
      offset: buffer.readUInt32BE(row + 8),
      length: buffer.readUInt32BE(row + 12),
    });
  }
  const slice = (tag) => {
    const found = tables.get(tag);
    return found === undefined ? null : buffer.subarray(found.offset, found.offset + found.length);
  };
  const head = slice("head");
  const maxp = slice("maxp");
  const hhea = slice("hhea");
  const hmtx = slice("hmtx");
  if (head === null || maxp === null || hhea === null || hmtx === null) throw new Error("the font is missing a required table");

  const unitsPerEm = head.readUInt16BE(18);
  const longLoca = head.readInt16BE(50) === 1;
  const numGlyphs = maxp.readUInt16BE(4);
  const numberOfHMetrics = hhea.readUInt16BE(34);
  const bbox = {
    xMin: head.readInt16BE(36), yMin: head.readInt16BE(38),
    xMax: head.readInt16BE(40), yMax: head.readInt16BE(42),
  };

  const cmap = readCmap(slice("cmap"));
  const loca = slice("loca");
  const glyf = slice("glyf");

  /**
   * The advance width of one glyph, in font units.
   *
   * PAST `numberOfHMetrics` EVERY GLYPH SHARES THE LAST ONE. That is not a
   * quirk to work around — it is how the table is compressed, and a CJK face
   * relies on it: twenty thousand ideographs are all one em wide, so the table
   * stores that width once.
   */
  const advanceOf = (gid) => {
    const at = Math.min(gid, numberOfHMetrics - 1);
    const offset = at * 4;
    return offset + 2 <= hmtx.length ? hmtx.readUInt16BE(offset) : unitsPerEm;
  };

  const glyphFor = (codePoint) => cmap.get(codePoint) ?? 0;

  return {
    unitsPerEm, numGlyphs, numberOfHMetrics, bbox, longLoca,
    ascent: hhea.readInt16BE(4), descent: hhea.readInt16BE(6),
    glyphFor, advanceOf,
    // WHETHER THE FACE ACTUALLY HAS THE CHARACTER, which is not the same
    // question as what its width is. Glyph 0 is `.notdef` — the empty box —
    // and a layout that measured it as if it were the letter would push the
    // line out by a real width for something that draws as nothing.
    has: (codePoint) => cmap.has(codePoint),
    subset: (gids) => subsetFont({ tables, buffer, head, maxp, hhea, hmtx, loca, glyf, longLoca, numGlyphs, gids, slice }),
  };
}

/**
 * Unicode → glyph id, from whichever `cmap` subtable says the most.
 *
 * FORMAT 12 BEATS FORMAT 4 WHEN BOTH ARE THERE, and both usually are: format 4
 * addresses the BMP only, so a face that also covers the ideographic
 * supplementary planes carries a 12 beside it. Reading only the 4 loses every
 * character above U+FFFF — which in a Chinese document is rare but real, and
 * the failure is a blank box rather than an error.
 * @param table - the `cmap` table, or null.
 * @returns codepoint → glyph id.
 */
function readCmap(table) {
  const out = new Map();
  if (table === null) return out;
  const count = table.readUInt16BE(2);
  let best = null;
  let bestScore = -1;
  for (let at = 0; at < count; at += 1) {
    const row = 4 + at * 8;
    const platform = table.readUInt16BE(row);
    const encoding = table.readUInt16BE(row + 2);
    const offset = table.readUInt32BE(row + 4);
    if (offset + 4 > table.length) continue;
    const format = table.readUInt16BE(offset);
    // Windows full repertoire, then Windows BMP, then anything Unicode.
    const score = platform === 3 && encoding === 10 ? 4
      : platform === 0 && format === 12 ? 3
      : platform === 3 && encoding === 1 ? 2
      : platform === 0 ? 1 : 0;
    if (score > bestScore) { bestScore = score; best = { offset, format }; }
  }
  if (best === null) return out;
  if (best.format === 4) readFormat4(table, best.offset, out);
  else if (best.format === 12) readFormat12(table, best.offset, out);
  return out;
}

/** The BMP subtable: segments of start/end with a delta or an index array. */
function readFormat4(table, offset, out) {
  const segCount = table.readUInt16BE(offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + segCount * 2 + 2;
  const deltas = starts + segCount * 2;
  const ranges = deltas + segCount * 2;
  for (let at = 0; at < segCount; at += 1) {
    const end = table.readUInt16BE(ends + at * 2);
    const start = table.readUInt16BE(starts + at * 2);
    if (start > end || start === 0xffff) continue;
    const delta = table.readInt16BE(deltas + at * 2);
    const rangeOffset = table.readUInt16BE(ranges + at * 2);
    for (let code = start; code <= end; code += 1) {
      let gid;
      if (rangeOffset === 0) gid = (code + delta) & 0xffff;
      else {
        const to = ranges + at * 2 + rangeOffset + (code - start) * 2;
        if (to + 2 > table.length) continue;
        gid = table.readUInt16BE(to);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      if (gid !== 0) out.set(code, gid);
    }
  }
}

/** The full-repertoire subtable: groups of contiguous codes and glyphs. */
function readFormat12(table, offset, out) {
  const groups = table.readUInt32BE(offset + 12);
  for (let at = 0; at < groups; at += 1) {
    const row = offset + 16 + at * 12;
    if (row + 12 > table.length) break;
    const start = table.readUInt32BE(row);
    const end = table.readUInt32BE(row + 4);
    const gid = table.readUInt32BE(row + 8);
    // A GUARD, NOT A LIMIT. A corrupt group with a huge range would otherwise
    // spin here filling a Map with millions of entries; 0x10FFFF is the top of
    // Unicode and anything past it is not a codepoint.
    if (end < start || end > 0x10ffff) continue;
    for (let code = start; code <= end; code += 1) out.set(code, gid + (code - start));
  }
}

/** The offset and length of one glyph's outline, from `loca`. */
function glyphAt(loca, longLoca, gid) {
  const from = longLoca ? loca.readUInt32BE(gid * 4) : loca.readUInt16BE(gid * 2) * 2;
  const to = longLoca ? loca.readUInt32BE(gid * 4 + 4) : loca.readUInt16BE(gid * 2 + 2) * 2;
  return { from, to };
}

/**
 * Every glyph a set of glyphs actually needs.
 *
 * A COMPOSITE GLYPH IS A LIST OF OTHER GLYPHS. `é` is often one outline
 * referencing `e` and the accent, and a subset that copies the composite
 * without its components draws nothing at all — the renderer follows the
 * reference into an empty entry. Walked rather than looped once, because a
 * component may itself be composite.
 * @param wanted - the glyphs the document uses.
 * @param glyf - the outline table.
 * @param loca - the offsets.
 * @param longLoca - whether `loca` is 32-bit.
 * @returns the closure, including glyph 0.
 */
function withComponents(wanted, glyf, loca, longLoca) {
  // GLYPH 0 ALWAYS. `.notdef` is what a viewer draws for a code the font does
  // not cover, and a font whose glyph 0 is empty is a font that draws nothing
  // where it should draw a box — which hides the very failure it reports.
  const all = new Set([0, ...wanted]);
  const queue = [...all];
  while (queue.length > 0) {
    const gid = queue.pop();
    const { from, to } = glyphAt(loca, longLoca, gid);
    // 0 LENGTH IS A SPACE, not an error: `loca[n] === loca[n+1]` is how the
    // format says "this glyph has no outline".
    if (to <= from || to > glyf.length || to - from < 10) continue;
    const contours = glyf.readInt16BE(from);
    if (contours >= 0) continue;
    let at = from + 10;
    for (;;) {
      if (at + 4 > glyf.length) break;
      const flags = glyf.readUInt16BE(at);
      const component = glyf.readUInt16BE(at + 2);
      if (!all.has(component)) { all.add(component); queue.push(component); }
      at += 4;
      at += (flags & 1) !== 0 ? 4 : 2;
      if ((flags & 8) !== 0) at += 2;
      else if ((flags & 0x40) !== 0) at += 4;
      else if ((flags & 0x80) !== 0) at += 8;
      if ((flags & 0x20) === 0) break;
    }
  }
  return all;
}

/** Pad to a four-byte boundary, as the table directory requires. */
const pad4 = (buffer) => (buffer.length % 4 === 0
  ? buffer
  : Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]));

/** The sum of a table's 32-bit words, which is what the directory records. */
function checksum(buffer) {
  const padded = pad4(buffer);
  let sum = 0;
  for (let at = 0; at < padded.length; at += 4) sum = (sum + padded.readUInt32BE(at)) >>> 0;
  return sum;
}

/**
 * A font holding only the outlines a document uses.
 *
 * GLYPH IDS DO NOT MOVE. See the file's own note: `loca` keeps all its entries
 * and the unused ones point at zero-length outlines, so composite references
 * stay valid, the PDF's Identity-H codes stay the original ids, and there is no
 * old-to-new map for anything to get wrong.
 * @param parts - the parsed tables and the wanted glyph ids.
 * @returns the font file, as a Buffer.
 */
function subsetFont({ tables, head, maxp, hhea, hmtx, loca, glyf, longLoca, numGlyphs, gids, slice }) {
  if (loca === null || glyf === null) throw new Error("the font has no TrueType outlines to subset");
  const keep = withComponents(gids, glyf, loca, longLoca);

  // 32-BIT `loca` UNCONDITIONALLY. The short form stores halved offsets, so it
  // cannot address a `glyf` longer than 128KB — and it also forces every
  // outline to an even offset. Writing the long form removes both constraints
  // and costs four bytes a glyph in a table that is already the cheap half.
  const offsets = Buffer.alloc((numGlyphs + 1) * 4);
  const outlines = [];
  let at = 0;
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    offsets.writeUInt32BE(at, gid * 4);
    if (keep.has(gid)) {
      const { from, to } = glyphAt(loca, longLoca, gid);
      if (to > from && to <= glyf.length) {
        // PADDED TO A WORD each. The spec does not require it for long `loca`,
        // but a renderer that assumes alignment reads a garbled outline rather
        // than refusing, and the cost is under two bytes a glyph.
        const outline = pad4(glyf.subarray(from, to));
        outlines.push(outline);
        at += outline.length;
      }
    }
  }
  offsets.writeUInt32BE(at, numGlyphs * 4);

  const newHead = Buffer.from(head);
  newHead.writeInt16BE(1, 50);
  // ZEROED BEFORE THE WHOLE-FILE SUM, because that sum includes this field.
  newHead.writeUInt32BE(0, 8);

  const emit = new Map([
    ["head", newHead],
    ["hhea", Buffer.from(hhea)],
    ["maxp", Buffer.from(maxp)],
    ["hmtx", Buffer.from(hmtx)],
    ["loca", offsets],
    ["glyf", outlines.length === 0 ? Buffer.alloc(4) : Buffer.concat(outlines)],
  ]);
  for (const tag of KEEP) {
    const held = tables.has(tag) ? slice(tag) : null;
    if (held !== null) emit.set(tag, Buffer.from(held));
  }

  // SORTED BY TAG. The directory is searched with a binary search by every
  // reader that follows the spec, and an unsorted one makes tables past the
  // first mismatch invisible rather than making the font invalid.
  const names = [...emit.keys()].sort();
  const entrySelector = Math.floor(Math.log2(names.length));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + names.length * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(names.length, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(names.length * 16 - searchRange, 10);

  let cursor = header.length;
  const bodies = [];
  names.forEach((tag, index) => {
    const body = emit.get(tag);
    const row = 12 + index * 16;
    header.write(tag, row, 4, "latin1");
    header.writeUInt32BE(checksum(body), row + 4);
    header.writeUInt32BE(cursor, row + 8);
    header.writeUInt32BE(body.length, row + 12);
    const padded = pad4(body);
    bodies.push(padded);
    cursor += padded.length;
  });

  const file = Buffer.concat([header, ...bodies]);
  // THE WHOLE-FILE CHECKSUM, which `head` carries and some readers verify.
  // 0xB1B0AFBA less the sum of everything, with this field read as zero — which
  // is why it was zeroed above rather than after.
  const headAt = 12 + names.indexOf("head") * 16;
  const headOffset = file.readUInt32BE(headAt + 8);
  file.writeUInt32BE((0xb1b0afba - checksum(file)) >>> 0, headOffset + 8);
  return file;
}
