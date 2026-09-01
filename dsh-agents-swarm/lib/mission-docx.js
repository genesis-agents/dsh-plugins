/**
 * A report as a real `.docx`, written here because there is nowhere to get one.
 *
 * WHY NOT A LIBRARY. This plugin has no build step: `lib/*.js` is served to the
 * browser and loaded by Node as-is, so a dependency is not an option and there
 * is no bundler to hide one behind. What a `.docx` actually is, though, is a
 * ZIP of four small XML files, and Node ships both `zlib` and everything else
 * this needs.
 *
 * WHY NOT `.doc`. The usual shortcut is to serve HTML under an
 * `application/msword` type. Word opens it, so it looks like it worked — and
 * Pages, Google Docs and every converter downstream get a file whose extension
 * lies about its contents. This writes the real format.
 *
 * WHAT IT CARRIES: headings one to four, paragraphs, bold, italic, inline code,
 * bulleted and numbered lists, blockquotes and links. What it does not: images
 * — a figure becomes its caption and a line saying where the picture was — and
 * tables, which become tab-separated paragraphs. Both are named in the file
 * rather than dropped silently, because a reader who exports a report with
 * eight figures in it must not have to count them to find out.
 */
import { deflateRawSync } from "node:zlib";

/** The CRC-32 table, built once. Every ZIP entry carries one. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 of a buffer.
 * @param buffer - the bytes.
 * @returns the checksum as an unsigned 32-bit number.
 */
function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A ZIP archive, deflated.
 *
 * NO DIRECTORY ENTRIES AND NO ZIP64. A `.docx` is four files of a few kilobytes
 * and Word has read this shape since 2007; the omissions are what keeps this
 * ninety lines instead of a library.
 * @param files - `[{name, data}]`, data as a Buffer.
 * @returns the archive.
 */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = file.data;
    const packed = deflateRawSync(raw);
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // deflate
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x21, 12);         // date: a fixed 1980-01-01
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

/** XML text, escaped. The five that matter, and no more. */
function xml(value) {
  return String(value ?? "")
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&apos;");
}

/**
 * One run of text, with whatever marks it carries.
 *
 * `xml:space="preserve"` on every run, because a run that ends in a space is
 * how two words stay apart when the next run is bold.
 */
function run(text, { bold = false, italic = false, code = false } = {}) {
  const marks = [
    bold ? "<w:b/>" : "",
    italic ? "<w:i/>" : "",
    code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="6D28D9"/>' : "",
  ].join("");
  const properties = marks === "" ? "" : `<w:rPr>${marks}</w:rPr>`;
  return `<w:r>${properties}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

/**
 * Split one line of markdown into runs.
 *
 * ONE PASS, LEFT TO RIGHT, and deliberately not a parser: `**bold**`, `*em*`
 * and `` `code` `` are the three marks this pipeline's writers actually emit.
 * A `[12]` citation marker is left as literal text — it is what the reader
 * matches against the bibliography at the end.
 * @param line - the source text.
 * @returns the XML for its runs.
 */
function runsOf(line) {
  const out = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu;
  let cursor = 0;
  for (const match of String(line).matchAll(pattern)) {
    if (match.index > cursor) out.push(run(line.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("**")) out.push(run(token.slice(2, -2), { bold: true }));
    else if (token.startsWith("`")) out.push(run(token.slice(1, -1), { code: true }));
    else if (token.startsWith("[")) {
      // A LINK KEEPS ITS ADDRESS. Word's hyperlink field needs a relationship
      // id, and a fifth XML part for four links is not worth it — the address
      // goes beside the text, which is what a printed report does anyway.
      const cut = token.indexOf("](");
      out.push(run(token.slice(1, cut), { italic: true }));
      out.push(run(` (${token.slice(cut + 2, -1)})`));
    } else out.push(run(token.slice(1, -1), { italic: true }));
    cursor = match.index + token.length;
  }
  if (cursor < line.length) out.push(run(line.slice(cursor)));
  return out.join("");
}

/** A paragraph in a named style. */
function para(runsXml, style) {
  const properties = style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${properties}${runsXml}</w:p>`;
}

/**
 * Markdown to WordprocessingML body.
 *
 * FENCES ARE HELD, NOT PARSED. Everything between a pair of ``` is emitted
 * verbatim in the code style, one paragraph per line, because a code block that
 * has had its asterisks read as emphasis is worse than one that is not
 * highlighted at all.
 * @param markdown - the report.
 * @param zh - whether the notes it inserts are Chinese.
 * @returns the paragraphs.
 */
/** Word renders these; a .docx holding anything else is a red X in the page. */
const DOCX_IMAGE_TYPES = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpeg",
  // WEBP IS NOT HERE, AND THAT IS THE POINT OF THE LIST. Word before 2021
  // draws a placeholder box for it, and every converter downstream — the
  // ones that turn a .docx into a PDF on somebody else's machine — is older
  // than that. A figure we cannot draw falls back to the sentence the .md
  // export uses, which says what the picture was and where it came from.
  "image/gif": "gif",
});

/**
 * An image's pixel size, read out of its own header.
 *
 * THE STORED WIDTH IS OFTEN 0, and 0 means "the page declared no intrinsic
 * size", not "small" — see the figures route. A drawing sized from it comes
 * out as a zero-area rectangle, which Word draws as nothing at all, so the
 * bytes are measured rather than trusted.
 *
 * Three formats, three headers, no decoding: PNG puts them in IHDR at a
 * fixed offset, GIF in the logical screen descriptor, and JPEG in whichever
 * SOFn marker the encoder chose, which is why that one is a walk.
 * @param bytes - the file.
 * @param mime - its type.
 * @returns `{ width, height }` in pixels, or null when the header will not say.
 */
export function imageSize(bytes, mime) {
  // PER FORMAT, NOT ONE FLOOR. A single `length < 24` reads as caution and is
  // a bug: a GIF header is ten bytes and a JPEG can carry its frame at byte
  // four, so the shared floor refused files it could have measured — and the
  // caller reads null as "draw the sentence instead of the picture".
  if (!Buffer.isBuffer(bytes) || bytes.length < 10) return null;
  if (mime === "image/png") {
    // 8 bytes of signature, then a length and "IHDR", then the two.
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === "image/gif") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mime !== "image/jpeg") return null;
  // MARKER BY MARKER. A JPEG's size lives in a start-of-frame segment whose
  // position depends on how much EXIF the camera wrote, so there is no
  // offset to read it from — and the standalone markers (D0-D9, 01) carry no
  // length, so a walk that assumed every marker had one would desynchronise
  // on the first restart marker and read a length out of image data.
  let at = 2;
  while (at + 8 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = bytes.readUInt16BE(at + 2);
    // C4 is the Huffman table, C8 is reserved and CC is arithmetic coding;
    // the rest of C0-CF are the frame headers, and all of them put height
    // and width at the same place.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/** Twips of text across A4 inside the margins this file sets: 11906 - 2 * 1134. */
const TEXT_WIDTH_TWIPS = 9638;
/** English Metric Units per twip. 914400 per inch, 1440 twips per inch. */
const EMU_PER_TWIP = 635;
/** …and per CSS pixel, at the 96dpi a page's declared size is in. */
const EMU_PER_PIXEL = 9525;

/**
 * One inline picture, sized to fit the text column.
 *
 * SCALED DOWN, NEVER UP. A 2400px chart at its own size is two and a half
 * pages wide and Word crops it at the margin rather than reflowing; a 200px
 * thumbnail blown up to the full column is a blurred rectangle. Only the
 * first needs correcting, so only the first is corrected.
 * @param id - the relationship id of the image part.
 * @param at - a document-unique number for the drawing's own name.
 * @param size - `{ width, height }` in pixels.
 * @param alt - the publisher's alt text, for a screen reader.
 * @returns the paragraph XML.
 */
function picture(id, at, size, alt) {
  const capacity = TEXT_WIDTH_TWIPS * EMU_PER_TWIP;
  const natural = Math.max(1, Math.round(size.width * EMU_PER_PIXEL));
  const scale = natural > capacity ? capacity / natural : 1;
  const cx = Math.round(natural * scale);
  const cy = Math.max(1, Math.round(size.height * EMU_PER_PIXEL * scale));
  const described = xml(alt === "" ? `figure ${at}` : alt);
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="80"/></w:pPr><w:r><w:drawing>`
    + `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${at}" name="Figure ${at}" descr="${described}"/>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${at}" name="Figure ${at}" descr="${described}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function bodyOf(markdown, zh, drawn) {
  const lines = String(markdown ?? "").split(/\r?\n/u);
  const out = [];
  let fenced = false;
  let figure = null;
  for (const line of lines) {
    if (/^```/u.test(line.trim())) { fenced = !fenced; continue; }
    if (fenced) { out.push(para(run(line, { code: true }), "SwarmCode")); continue; }

    // A FIGURE, AND THE PICTURE COMES WITH IT.
    //
    // This printed ［图 3：图片见网页版报告］ and nothing else, on the
    // reasoning the .md export still runs on: a downloaded file cannot reach
    // our byte route, and an `<img src>` pointing at the publisher would
    // make every viewer of every copy fetch them directly. Both are true of
    // Markdown and NEITHER is true here — a .docx is a zip, the bytes ride
    // inside it, and opening one touches no network at all.
    //
    // THE SENTENCE SURVIVES AS THE CAPTION. It is not replaced by the
    // picture, it is put under it: where the chart came off, when it was
    // fetched and which citation carries it is the half a reader needs in
    // order to use the picture as evidence rather than as decoration.
    const opens = /^:::figure[ \t]+(\d{1,3})[ \t]*$/u.exec(line.trim());
    if (opens !== null) { figure = opens[1]; continue; }
    if (figure !== null && line.trim() === ":::") {
      const held = drawn.get(Number(figure));
      if (held === undefined) {
        // NO BYTES, OR A FORMAT WORD WILL NOT DRAW. The line the Markdown
        // export prints, which says what was there and where it came from.
        out.push(para(run(zh ? `［图 ${figure}：图片见网页版报告］` : `[Figure ${figure} — see the report on screen]`, { italic: true })));
      } else {
        out.push(picture(held.rel, held.at, held.size, held.alt));
        if (held.caption !== "") out.push(para(run(held.caption, { italic: true }), "SwarmQuote"));
      }
      figure = null;
      continue;
    }
    if (figure !== null) continue;

    if (line.trim() === "") continue;

    const heading = /^(#{1,4})[ \t]+(.*)$/u.exec(line);
    if (heading !== null) {
      out.push(para(runsOf(heading[2]), `Heading${heading[1].length}`));
      continue;
    }
    const bullet = /^[ \t]*[-*][ \t]+(.*)$/u.exec(line);
    if (bullet !== null) { out.push(para(runsOf(bullet[1]), "SwarmBullet")); continue; }
    const ordered = /^[ \t]*\d+\.[ \t]+(.*)$/u.exec(line);
    if (ordered !== null) { out.push(para(runsOf(ordered[1]), "SwarmNumber")); continue; }
    const quoted = /^[ \t]*>[ \t]?(.*)$/u.exec(line);
    if (quoted !== null) { out.push(para(runsOf(quoted[1]), "SwarmQuote")); continue; }
    // A TABLE ROW, FLATTENED AND SAID TO BE. Real table XML is another two
    // hundred lines for something this pipeline emits rarely; a tab-separated
    // line keeps every cell and its order.
    if (/^[ \t]*\|/u.test(line)) {
      const cells = line.split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
      if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell))) continue;
      out.push(para(run(cells.join("\t")), "SwarmCode"));
      continue;
    }
    out.push(para(runsOf(line)));
  }
  return out.join("");
}

/** The styles the body names. Sizes are half-points, as Word counts them. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="280" w:after="140"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:outlineLvl w:val="3"/><w:spacing w:before="200" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="SwarmBullet"><w:name w:val="Swarm Bullet"/><w:pPr><w:ind w:left="480" w:hanging="240"/><w:spacing w:after="80"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="SwarmNumber"><w:name w:val="Swarm Number"/><w:pPr><w:ind w:left="480" w:hanging="240"/><w:spacing w:after="80"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="SwarmQuote"><w:name w:val="Swarm Quote"/><w:pPr><w:ind w:left="480"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="SwarmCode"><w:name w:val="Swarm Code"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/**
 * A report as a `.docx`.
 * @param markdown - the report body, figure tokens already rendered or left in.
 * @param options - `{title, language, figures}`. `figures` is
 *   `[{ index, bytes, mime, width, height, alt, caption }]` — the picture
 *   travels inside the zip, so a reader opening the file touches no network.
 * @returns the file, as a Buffer.
 */
export function reportToDocx(markdown, { title = "", language = "zh", figures = [] } = {}) {
  const zh = language !== "en";
  const heading = String(title ?? "").trim() === "" ? "" : para(runsOf(title), "Heading1");

  // WHICH FIGURES CAN ACTUALLY BE DRAWN, decided before a line of the body
  // is written. A figure with no bytes, an unmeasurable header or a format
  // Word draws as a red X is not in this map, and `bodyOf` prints the
  // Markdown export's sentence for it instead — so the two exports differ
  // only where one of them genuinely can carry more.
  const drawn = new Map();
  const parts = [];
  const rels = [];
  const kinds = new Set();
  for (const figure of Array.isArray(figures) ? figures : []) {
    const extension = DOCX_IMAGE_TYPES[figure?.mime];
    if (extension === undefined || !Buffer.isBuffer(figure?.bytes) || figure.bytes.length === 0) continue;
    const measured = imageSize(figure.bytes, figure.mime)
      ?? (Number(figure.width) > 0 && Number(figure.height) > 0
        ? { width: Number(figure.width), height: Number(figure.height) }
        : null);
    // A PICTURE WITH NO SIZE IS A ZERO-AREA RECTANGLE, which Word draws as
    // nothing while still counting the paragraph — a blank gap where the
    // sentence would have been. The sentence is better.
    if (measured === null) continue;
    // rId1 IS styles.xml. Numbered from two so the two relationship kinds
    // share one namespace without a collision, which is what `Id` means.
    const at = parts.length + 2;
    const name = `media/image${at}.${extension}`;
    parts.push({ name: `word/${name}`, data: figure.bytes });
    rels.push(`<Relationship Id="rId${at}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${name}"/>`);
    kinds.add(extension);
    drawn.set(Number(figure.index), {
      rel: `rId${at}`, at, size: measured,
      alt: typeof figure.alt === "string" ? figure.alt : "",
      caption: typeof figure.caption === "string" ? figure.caption : "",
    });
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${heading}${bodyOf(markdown, zh, drawn)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  // A DEFAULT PER EXTENSION, AND ONLY FOR THE ONES PRESENT. A package that
  // declares a part type it does not contain still opens; one that contains
  // a part whose extension is undeclared does not, and Word's message for it
  // is "the file is corrupt" rather than anything about images.
  const types = CONTENT_TYPES.replace(
    "</Types>",
    [...kinds].map((kind) => `<Default Extension="${kind}" ContentType="image/${kind === "jpeg" ? "jpeg" : kind}"/>`).join("") + "</Types>",
  );
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(types, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(DOC_RELS.replace("</Relationships>", rels.join("") + "</Relationships>"), "utf8") },
    { name: "word/styles.xml", data: Buffer.from(STYLES, "utf8") },
    { name: "word/document.xml", data: Buffer.from(document, "utf8") },
    ...parts,
  ]);
}
