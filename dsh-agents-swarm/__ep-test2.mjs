import { JSDOM } from "jsdom";
import { buildFeed, xmlEscape } from "./lib/episodes.js";
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`);
const parse = (xml) => {
  try {
    const d = new JSDOM(xml, { contentType: "text/xml" }).window.document;
    return d.querySelector("parsererror")?.textContent ?? null;
  } catch (e) { return `THREW ${e.message}`; }
};
const opts = { baseUrl: "http://h", link: "http://h/", audioUrl: (e) => `http://h/a/${e.id}` };

const cases = {
  "lone high surrogate": `bad ${String.fromCharCode(0xd800)} title`,
  "lone low surrogate": `bad ${String.fromCharCode(0xdc00)} title`,
  "U+FFFE noncharacter": `bad ${String.fromCharCode(0xfffe)} title`,
  "NUL and ESC": `a${String.fromCharCode(0)}b${String.fromCharCode(27)}c`,
  "tab and newline (legal)": `a${String.fromCharCode(9)}b${String.fromCharCode(10)}c`,
  "CDATA breakout attempt": "]]><script>x</script>",
  "attribute breakout": '" onload="x',
};
for (const [name, title] of Object.entries(cases)) {
  const err = parse(buildFeed([{ id: "x1", title, createdAt: "2026-08-22T00:00:00Z", bytes: 100 }], opts));
  ok(`feed parses with ${name}`, err === null, err?.replace(/\s+/g, " ").slice(0, 90) ?? "");
}
ok("buildFeed with no options at all does not throw", (() => { try { buildFeed([]); return true; } catch { return false; } })());
ok("buildFeed(null) does not throw", (() => { try { buildFeed(null, opts); return true; } catch { return false; } })());
ok("xmlEscape keeps tab/LF/CR", xmlEscape(`a${String.fromCharCode(9)}b${String.fromCharCode(10)}c${String.fromCharCode(13)}d`).length === 7);
ok("xmlEscape ampersand first", xmlEscape("<&>") === "&lt;&amp;&gt;", xmlEscape("<&>"));
ok("imageUrl null emits no image element", !buildFeed([], { ...opts, imageUrl: null }).includes("<itunes:image"));
ok("imageUrl blank emits no image element", !buildFeed([], { ...opts, imageUrl: "   " }).includes("<itunes:image"));
ok("imageUrl real emits both", (() => {
  const x = buildFeed([], { ...opts, imageUrl: "http://h/i.png" });
  return x.includes("<itunes:image") && x.includes("<image>");
})());
