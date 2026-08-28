// The design system, checked at the source rather than at the pixel.
//
// Every failure this file catches is invisible from the outside. A hue declared
// in the light block and forgotten in the dark one renders as the light value
// on a dark surface — legible enough to survive review, wrong enough to be the
// only thing on screen that did not switch. A fallback that drifts from its
// light-theme value is worse: it is correct on every machine that loaded the
// stylesheet and wrong on the one that did not, which is the machine nobody
// tests on. And a literal triple reintroduced into a vocabulary table is how
// the whole problem started — sixty-two of them, none of which threw.
//
// There is no browser here and there does not need to be one. The properties
// asserted are properties of the SOURCE: which names exist, whether the two
// theme blocks agree, and whether anything colours itself outside the ramp.
//
// Run with `npm test` from the package root.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const SOURCE = readFileSync(CLIENT, "utf8");

/** Where the dark block starts, so a declaration can be attributed to a theme. */
const DARK_AT = SOURCE.indexOf('"body[data-ds-dark-theme]{"');

/**
 * Every `--swm-h-*` declaration on one side of the theme boundary.
 *
 * @param theme - "light" for declarations before the dark block, "dark" for after.
 * @returns name → triple.
 */
function declared(theme) {
  const found = new Map();
  const pattern = /"--swm-h-([a-z-]+):(\d{1,3},\d{1,3},\d{1,3});"/g;
  for (const match of SOURCE.matchAll(pattern)) {
    const inDark = match.index > DARK_AT;
    if ((theme === "dark") === inDark) found.set(match[1], match[2]);
  }
  return found;
}

/** The ramp as the JavaScript half declares it: name → `{ variable, fallback }`. */
function ramp() {
  const block = SOURCE.slice(SOURCE.indexOf("const PALETTE = {"), SOURCE.indexOf("};", SOURCE.indexOf("const PALETTE = {")));
  const found = new Map();
  for (const match of block.matchAll(/(\w+): "var\(--swm-h-([a-z-]+),(\d{1,3},\d{1,3},\d{1,3})\)"/g)) {
    found.set(match[1], { variable: match[2], fallback: match[3] });
  }
  return found;
}

test("the dark block declares exactly the hues the light block does", () => {
  const light = declared("light");
  const dark = declared("dark");
  assert.ok(light.size >= 8, `the light block declares ${light.size} hues; the ramp is meant to be ten`);
  assert.deepEqual(
    [...dark.keys()].sort(),
    [...light.keys()].sort(),
    "a hue declared in one theme and not the other keeps its light value on a dark surface — the one element on the page that did not switch",
  );
});

test("light and dark values differ for every hue", () => {
  const light = declared("light");
  const dark = declared("dark");
  for (const [name, value] of light) {
    assert.notEqual(
      dark.get(name),
      value,
      `--swm-h-${name} is the same triple in both themes. Either the dark correction was never made, or this hue does not need a theme block at all — and a var that never changes is a literal with extra steps`,
    );
  }
});

test("every ramp name resolves to a declared variable", () => {
  const light = declared("light");
  for (const [name, { variable }] of ramp()) {
    assert.ok(
      light.has(variable),
      `PALETTE.${name} reads --swm-h-${variable}, which no theme block declares. It renders on its fallback for ever, in both themes, and nothing reports it`,
    );
  }
});

test("every fallback is its own light-theme value", () => {
  const light = declared("light");
  for (const [name, { variable, fallback }] of ramp()) {
    assert.equal(
      fallback,
      light.get(variable),
      `PALETTE.${name}'s fallback and --swm-h-${variable}'s light value disagree. The fallback is what renders when style injection is refused, so this is a colour that is right everywhere except where it matters`,
    );
  }
});

test("no colour literal survives outside the ramp", () => {
  // The ramp's own declarations carry the `--swm-h-` prefix inside the quotes,
  // so they do not match a BARE quoted triple. Anything that does is a
  // vocabulary table or an inline style that chose its own colour.
  const strays = [...SOURCE.matchAll(/"(\d{1,3},\d{1,3},\d{1,3})"/g)];
  assert.deepEqual(
    strays.map((match) => match[1]),
    [],
    "a raw colour triple is back in lib/client.js. It will not follow the theme and it will not match the host's palette — take the hue from PALETTE, or the meaning from TONE",
  );
});

test("no colour literal survives in FUNCTION form either", () => {
  // THE TEST ABOVE COULD NOT SEE THESE, AND THAT IS THE POINT OF THIS ONE.
  // Its pattern matches a bare quoted triple — `"217,119,6"` — and thirty-five
  // colours in this file were written as `"rgb(217,119,6)"`, which is the same
  // mistake one function call further in. They sat under a passing test. A
  // guard that cannot express the thing it guards is worse than no guard,
  // because it is also a claim.
  //
  // `rgba(0,0,0,…)` is allowed, for scrims: a scrim is black in both themes.
  const strays = [...SOURCE.matchAll(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/g)]
    .map((match) => ({ text: match[0], at: match.index }))
    .filter((stray) => !/rgba?\(\s*0\s*,\s*0\s*,\s*0/.test(stray.text))
    // Docblocks in the tokens region quote example colours while explaining why
    // they are forbidden, and prose is not a style.
    .filter((stray) => !inComment(stray.at));
  assert.deepEqual(
    strays.map((stray) => stray.text),
    [],
    "a colour is written as rgb()/rgba() with numbers in it. It cannot follow the theme: in `rgba(${TONE.warn},0.25)` the hue is a variable, and a literal has no variable in it at all",
  );
});

/**
 * Whether an offset falls inside a comment.
 *
 * Crude on purpose — it counts delimiters rather than parsing — because the
 * only thing it has to separate is prose in a docblock from a style object,
 * and in this file both are unambiguous.
 * @param at - a character offset into the source.
 * @returns true when the offset is inside a comment.
 */
function inComment(at) {
  const line = SOURCE.slice(SOURCE.lastIndexOf("\n", at) + 1, at);
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return true;
  const before = SOURCE.slice(0, at);
  return before.lastIndexOf("/*") > before.lastIndexOf("*/");
}

test("the ramp carries no meaning and TONE takes it from there", () => {
  // Guards the layering, not the values: a TONE that names a triple directly
  // has collapsed the two layers the ramp exists to keep apart.
  const block = SOURCE.slice(SOURCE.indexOf("const TONE = {"), SOURCE.indexOf("};", SOURCE.indexOf("const TONE = {")));
  for (const match of block.matchAll(/(\w+):\s*([^,\n]+)/g)) {
    assert.match(
      match[2].trim(),
      /^PALETTE\.\w+$/,
      `TONE.${match[1]} is not a PALETTE member. A state colour chosen outside the ramp is a hue the ramp cannot re-theme`,
    );
  }
});

test("every agent role has a colour of its own", () => {
  const block = SOURCE.slice(SOURCE.indexOf("const ROLE_TONE = {"), SOURCE.indexOf("};", SOURCE.indexOf("const ROLE_TONE = {")));
  const assigned = [...block.matchAll(/(\w+):\s*(PALETTE\.\w+)/g)].map((match) => [match[1], match[2]]);
  // The seven the pipeline actually dispatches, from mission-runtime.js's
  // STAGES, plus the neutral fallback for a row belonging to no agent.
  for (const role of ["leader", "researcher", "analyst", "reconciler", "writer", "reviewer", "verifier", "mission"]) {
    assert.ok(
      assigned.some(([name]) => name === role),
      `${role} runs stages and has no colour, so its rows are drawn in the fallback and read as "no agent"`,
    );
  }
  const hues = assigned.filter(([name]) => name !== "mission").map(([, hue]) => hue);
  assert.equal(
    new Set(hues).size,
    hues.length,
    "two roles share a hue, which makes the roster a colour that means two things",
  );
});

// ── the scale ──────────────────────────────────────────────────────────────
//
// The colour tests above assert a property that is already true. The four
// below assert a property that is BECOMING true: they are ratchets. Each holds
// a count measured the day the scale landed, and the only legal direction for
// that count is down. A ratchet is the honest shape for this — the file has
// ~590 inline style objects and migrating them is many changes, so a test that
// demanded zero today would have to be skipped today, and a skipped test is a
// decision nobody is enforcing.
//
// When you migrate a batch, LOWER THE NUMBER in the same commit. That is the
// whole mechanism.

/**
 * How many members one token object declares.
 *
 * Counts `name:` pairs in the object body rather than lines, because SPACE,
 * RADIUS, ICON and OPACITY are written on ONE line — a line-based counter
 * scored them zero, which made the adoption test pass by finding nothing.
 * @param name - the constant's name.
 * @returns the member count.
 */
function members(name) {
  return [...scale(name).matchAll(/(\w+):/g)].length - 1;
}

/** The object literal for one scale, as source text. */
function scale(name) {
  const at = SOURCE.indexOf(`const ${name} = {`);
  assert.notEqual(at, -1, `${name} is gone from lib/client.js`);
  return SOURCE.slice(at, SOURCE.indexOf("};", at));
}

test("the type scale is the harness's, not one of our own", () => {
  for (const match of scale("FONT").matchAll(/(\w+): "([^"]+)"/g)) {
    assert.match(
      match[2],
      /^var\(--dsw-font-[a-z0-9-]+\)$/,
      `FONT.${match[1]} is ${match[2]}. A step invented here is a step the shell does not have, and the two land one pixel apart on the same screen`,
    );
  }
});

test("the spacing rhythm stays five steps of four", () => {
  const steps = [...scale("SPACE").matchAll(/(\w+): "(\d+)px"/g)];
  assert.equal(steps.length, 5, "five steps is the rhythm; a sixth is the sixteen values this replaced, starting again");
  for (const [, name, value] of steps) {
    assert.equal(Number(value) % 4, 0, `SPACE.${name} is ${value}px, which is off the four-pixel grid`);
  }
});

test("radii and icon sizes stay countable", () => {
  assert.ok([...scale("RADIUS").matchAll(/(\w+):/g)].length <= 5, "RADIUS has grown past five names");
  assert.equal([...scale("ICON").matchAll(/(\w+):/g)].length, 3, "three icon sizes, as the reference has three");
});

test("raw style values only ever decrease", () => {
  // Measured 2026-08-26, the day FONT/SPACE/RADIUS/ICON landed. Lower these in
  // the commit that migrates a batch; never raise one.
  const ceiling = { fontSize: 0, fontWeight: 9, lineHeight: 10, borderRadius: 0, gap: 5 };
  const counted = {
    fontSize: [...SOURCE.matchAll(/fontSize: "\d+px"/g)].length,
    fontWeight: [...SOURCE.matchAll(/fontWeight: \d+/g)].length,
    lineHeight: [...SOURCE.matchAll(/lineHeight: "[^"]+"/g)].length,
    borderRadius: [...SOURCE.matchAll(/borderRadius: "[^"]+"/g)].length,
    gap: [...SOURCE.matchAll(/gap: "[^"]+"/g)].length,
  };
  for (const [key, limit] of Object.entries(ceiling)) {
    assert.ok(
      counted[key] <= limit,
      `${counted[key]} raw \`${key}\` declarations, up from ${limit}. Take the value from FONT / SPACE / RADIUS instead — and if this batch legitimately removed some, lower the ceiling here in the same commit`,
    );
  }
});

// ── the rest of the token layer ────────────────────────────────────────────

test("the alpha steps are declared in both themes, and differ", () => {
  // Same shape as the hue tests, for the same reason one layer along: a tint
  // is a hue AND an alpha, and correcting only the hue leaves the tint half
  // corrected. 10% of a mid-tone reads as a wash on white and as nothing on
  // rgb(35,35,36).
  const read = (theme) => {
    const found = new Map();
    for (const match of SOURCE.matchAll(/"--swm-a-([a-z-]+):(0?\.\d+);"/g)) {
      const inDark = match.index > DARK_AT;
      if ((theme === "dark") === inDark) found.set(match[1], match[2]);
    }
    return found;
  };
  const light = read("light");
  const dark = read("dark");
  assert.deepEqual([...dark.keys()].sort(), [...light.keys()].sort(), "the two theme blocks declare different alpha steps");
  assert.equal(light.size, 3, "three steps: soft, ring, fill");
  for (const [name, value] of light) {
    assert.notEqual(dark.get(name), value, `--swm-a-${name} is unchanged in the dark theme, which is the correction this token exists to carry`);
  }
});

test("every alpha at a call site is a TINT name", () => {
  const strays = [...SOURCE.matchAll(/rgba\(\$\{[^}]+\},\s*\.?\d[\d.]*\)/g)].map((match) => match[0]);
  assert.deepEqual(strays, [], "a numeric alpha is back in a tint. Only the hue half is a variable there, so the dark theme corrects half the colour");
});

test("no token is declared without being used", () => {
  // RADIUS IS WHY THIS TEST EXISTS. It landed with a careful docblock and zero
  // call sites, so all thirteen hand-typed radii stayed on screen and the file
  // looked like it had a scale. A token with no callers is not a head start,
  // it is a claim the code does not honour.
  // ADOPTED — every member of these is in use. PENDING is below, and naming
  // the batch is the point: an unadopted token is a debt with an owner, not a
  // test that gets skipped.
  for (const name of ["TINT", "SURFACE", "ELEVATION", "LINE", "INK", "OPACITY", "MOTION", "TONE", "PALETTE", "SPACE", "RADIUS", "FONT", "ICON", "CONTROL"]) {
    const count = members(name);
    // Counted by split rather than by a built regex: a `\b` assembled inside a
    // template literal is one unescaped backslash away from a backspace
    // character, and the first draft of this test scored every token zero.
    const uses = SOURCE.split(`${name}.`).length - 1;
    assert.ok(
      uses >= count,
      `${name} has ${count} members and ${uses} references — it is declared and not adopted, which is the shape of a scale that exists only in the docblock`,
    );
  }
});

test("the icon set is a set, not a pile", () => {
  // The two glyphs this file had before the primitive were drawn at different
  // weights on different boxes. A set is only a set if every member shares
  // both, and the only way to keep that true is to keep them in one table.
  const table = SOURCE.slice(SOURCE.indexOf("const ICON_PATHS = {"), SOURCE.indexOf("};", SOURCE.indexOf("const ICON_PATHS = {")));
  const glyphs = [...table.matchAll(/(\w+): "([^"]+)"/g)];
  assert.ok(glyphs.length >= 14, `${glyphs.length} glyphs is not enough to replace the text arrows, ticks and crosses this file draws`);
  for (const [, name, d] of glyphs) {
    assert.match(d, /^[Mm]/, `ICON_PATHS.${name} does not start with a move — it will render relative to whatever came before it`);
  }
  assert.ok(SOURCE.includes('viewBox: "0 0 24 24"'), "the glyphs must share one box or they will not share one optical size");
  assert.ok(SOURCE.includes('strokeWidth: "2"'), "one stroke weight, or the set reads as five sets");
});

test("the first motion in the file ships with its opt-out", () => {
  assert.ok(SOURCE.includes("@keyframes swm-spin"), "the spinner keyframes are gone");
  assert.ok(SOURCE.includes("@keyframes swm-pulse"), "the live-pulse keyframes are gone");
  assert.ok(
    SOURCE.includes("@media (prefers-reduced-motion:reduce)"),
    "an animation shipped without a reduced-motion rule. A spinner that cannot be stopped is a vestibular trigger, and the setting that says so is standard",
  );
});

test("surfaces and lines come from the host, not from us", () => {
  for (const name of ["SURFACE", "LINE", "INK"]) {
    for (const match of scale(name).matchAll(/(\w+): "([^"]+)"/g)) {
      assert.match(
        match[2],
        /^var\(--dsw-(alias|specific)-/,
        `${name}.${match[1]} is ${match[2]}. A surface invented here does not follow the shell's theme`,
      );
    }
  }
});

test("the panel recipe exists once", () => {
  assert.equal([...SOURCE.matchAll(/const CARD = \{/g)].length, 0, "a local card recipe is back; two copies inside two component bodies is where this started");
  assert.ok([...SOURCE.matchAll(/PANEL_STYLE/g)].length >= 8, "PANEL_STYLE should be the recipe every card spreads");
});

test("a control that can be refused says so", () => {
  // NOT "no bare controlStyle()" — most controls are never disabled and
  // passing them `false` would be noise. The invariant is narrower and is the
  // one that was actually broken: an element that sets `disabled:` must not
  // ALSO take the enabled style, or it greys nothing, keeps `cursor: pointer`
  // and answers no click.
  const lines = SOURCE.split("\n");
  const offenders = [];
  lines.forEach((line, index) => {
    if (!line.includes("controlStyle()")) return;
    const near = lines.slice(Math.max(0, index - 8), index + 9);
    if (near.some((row) => /\bdisabled:/.test(row))) offenders.push(index + 1);
  });
  assert.deepEqual(
    offenders,
    [],
    "these lines take the enabled control style while their own element sets `disabled:` — pass the same expression to controlStyle()",
  );
});

test("every duration is a MOTION member", () => {
  const strays = [...SOURCE.matchAll(/transition: "[^"]*\d+ms/g)].map((match) => match[0]);
  assert.deepEqual(strays, [], "a hand-typed duration is back, and it is on the browser's default easing — the one curve no design system chooses");
});

// ── the interaction sheet ──────────────────────────────────────────────────
//
// None of this can be asserted at the pixel from here, and two of the things
// that matter most — whether the focus ring has contrast where it lands, and
// whether a class beats an inline `background` in the cascade — cannot be
// asserted at all. What CAN be pinned is that the rules exist, that they ship
// on the sheet the whole page mounts, and that something wears them. A rule
// with no consumer is the unused-token failure in CSS form.

test("every interaction state has a rule", () => {
  for (const selector of [
    ".swm-focus:focus-visible",
    ".swm-focus:focus:not(:focus-visible)",
    ".swm-ctl:hover",
    ".swm-chip:hover",
    ".swm-iconbtn:hover",
    ".swm-iconbtn:focus-visible",
    ".swm-back:hover",
  ]) {
    assert.ok(SOURCE.includes(selector), `${selector} is missing — an inline style object cannot express that state, so without this rule the state does not exist`);
  }
});

test("the interaction rules ship on the sheet the page mounts", () => {
  // TRACE_CSS mounts only when the trace pane opens. A focus ring that arrives
  // with the trajectory is a focus ring most of the tab never gets.
  const rules = SOURCE.slice(SOURCE.indexOf("const SWM_RULES = ["), SOURCE.indexOf("].join(\"\")", SOURCE.indexOf("const SWM_RULES = [")));
  assert.ok(rules.includes(".swm-focus:focus-visible"), "the focus rule is not in SWM_RULES");
  assert.ok(SOURCE.includes("ensureStyle(SWM_STYLE_ID, SWM_SHEET)"), "the page must inject variables AND rules");
});

test("the classes reach the controls", () => {
  assert.ok(SOURCE.split('"swm-ctl swm-focus"').length - 1 >= 50, "the control class is on the sheet and not on the buttons");
  assert.ok(SOURCE.split("swm-chip").length - 1 >= 6, "the chip class is not reaching the chips");
  assert.ok(SOURCE.split("swm-iconbtn").length - 1 >= 4, "the icon-button class is not reaching the icon buttons");
});

test("a hover rule survives the style object that would override it", () => {
  // THE TEST ABOVE ASKS WHETHER THE RULES EXIST. All three of these existed,
  // shipped on the right sheet, and reached the right elements — and not one
  // of them could ever fire, because the style builder for each wrote the
  // property the rule sets as an INLINE key. An inline declaration beats a
  // stylesheet whatever the selector, so `background: "transparent"` on a
  // `.swm-ctl` button switches `.swm-ctl:hover` off with nothing on screen to
  // say so. It was true of fifty-odd controls, six category chips and every
  // back control at once, under a passing suite. `chipStyle`'s own comment
  // even claimed the transparent was what KEPT the hover reachable.
  //
  // The fix is the one `.swm-tr` (B10) and `.swm-tab` (B14) already took: the
  // resting value moves to the rule, and the builder emits nothing — or, where
  // there is a state to draw, `undefined`, which React does not write at all.
  for (const [builder, selector] of [
    ["function controlStyle(", ".swm-ctl{"],
    ["function chipStyle(", ".swm-chip{"],
    ["function backStyle(", ".swm-back{"],
  ]) {
    const built = code(body(builder));
    assert.ok(
      !built.includes('"transparent"'),
      `${builder} writes a resting background inline, so ${selector.slice(0, -1)}:hover cannot paint one. Leave the key out and let the rule carry it`,
    );
    assert.ok(
      !built.includes("color: INK.secondary"),
      `${builder} writes the resting ink inline, so the colour half of ${selector.slice(0, -1)}:hover never lands`,
    );
    const at = SHEET_RULES.indexOf(selector);
    assert.notEqual(at, -1, `${selector} has no base rule, so the builder's element has a UA background and no ink of its own`);
    // Bounded by the backtick, not by `}`: these rules interpolate
    // `${INK.secondary}`, and a `[^}]*` span stops dead inside the token name
    // — the trap B13 and B15 were each caught by, one rule along.
    const rule = SHEET_RULES.slice(at, SHEET_RULES.indexOf("`,", at));
    assert.ok(rule.includes("background:transparent"), `${selector} stopped resetting the UA background, so every control it dresses is a grey box`);
    assert.ok(rule.includes("color:${INK.secondary}"), `${selector} stopped setting the resting ink, so the label takes whatever colour it inherits`);
  }
});

test("nothing removes the focus ring without putting one back", () => {
  const strays = [...SOURCE.matchAll(/outline: "none"/g)].map((match) => match[0]);
  assert.deepEqual(strays, [], "an input suppresses the browser's focus ring. Keyboard users lose their position and nothing reports it");
});

test("selection is drawn inside the box, not as a border", () => {
  assert.ok(SOURCE.includes("function pressedStyle("), "pressedStyle is gone");
  // LOWERED FROM 4 TO 3, and only because a caller was replaced by a STRONGER
  // expression of the same idea rather than deleted. The sources pane's
  // two-state grouping toggle became a four-way segmented strip, and a segment
  // says "chosen" with a raised surface — `segmentStyle`'s ELEVATION step —
  // which is further inside the box than a ring is, not a font weight. The
  // second half of this test is what actually holds the property now; the
  // count is a floor under the OTHER idiom, so it may only fall when a caller
  // moves to the segmented one.
  // ONE CALL SITE, and that is now the honest number. It had three: two run
  // pickers and an arrangement toggle. One picker was in the 证据 pane and went
  // with it; the toggle became a segmented control, which draws selection its
  // own way. What is left is the run picker on the references pane — the last
  // place in this file where selection would otherwise be a bold word alone.
  assert.ok(SOURCE.split("pressedStyle(").length - 1 >= 2, "pressedStyle has lost its last call site, so a selected run is a font weight and nothing else");
  assert.ok(SOURCE.includes("function segmentStyle("), "segmentStyle is gone, so the two segmented strips are back to two surfaces, two radii and two shadows");
  const segment = declaration("function segmentStyle(");
  assert.ok(
    segment.includes("ELEVATION.raised"),
    "a chosen segment is no longer raised off its track, so the strip signals selection with weight and colour alone — which is the failure `pressedStyle` was added to fix, one widget along",
  );
  assert.ok(
    !/boxShadow: "0 1px 2px/.test(SOURCE),
    "a hand-mixed black drop shadow is back. It does not exist in the dark theme, where the surface under it is already darker than the shadow",
  );
  assert.ok(
    SOURCE.includes("style: segmentStyle("),
    "segmentStyle is declared and applied nowhere, which is the same as not existing",
  );
  assert.ok(SOURCE.includes("function backStyle("), "backStyle is gone");
  assert.ok(SOURCE.split("backStyle()").length - 1 >= 5, "back controls are still wearing the destructive control style");
  assert.ok(SOURCE.includes("function IconButton("), "IconButton is gone");
});

test("the retired class is gone from both halves", () => {
  assert.equal(SOURCE.split("swt-close").length - 1, 0, "`.swt-close` still exists — its consumers moved to .swm-iconbtn, so the rule is dead CSS that will be copied by the next person who greps for a close button");
});

// ── the type scale, adopted ────────────────────────────────────────────────

test("no size is chosen outside the scale", () => {
  // 289 raw `fontSize` declarations across ten distinct sizes became zero. The
  // ceiling above is 0, so this is belt and braces — but it names the reason,
  // which the number cannot.
  assert.equal(
    [...SOURCE.matchAll(/fontSize: "\d+px"/g)].length,
    0,
    "a raw font size is back. It is one pixel from a neighbour it will sit next to, and the leading that went with it was chosen separately",
  );
});

test("emphasis is the shell's weight", () => {
  const heavy = [...SOURCE.matchAll(/fontWeight: (\d+)/g)].map((match) => Number(match[1])).filter((weight) => weight > 500);
  assert.deepEqual(
    heavy,
    [],
    "a weight above 500 is back. The harness draws emphasis at 500 at every step below 24px, so anything heavier makes this tab louder than the app it lives in",
  );
});

test("the shorthand comes before what it would reset", () => {
  // `font` resets weight, leading AND font-variant. React writes style keys in
  // insertion order, so a `fontVariantNumeric` written BEFORE it is discarded
  // — silently, and only in the places that show figures, which is exactly
  // where tabular alignment is the point.
  const offenders = [];
  for (const match of SOURCE.matchAll(/fontVariantNumeric: "tabular-nums"[^}]*?\bfont: FONT\./g)) {
    offenders.push(match[0].slice(0, 60));
  }
  assert.deepEqual(offenders, [], "a font shorthand follows a fontVariantNumeric in the same object and silently resets it");

  // THE SAME RULE, ONE KEY ALONG. `font: FONT.micro` followed by
  // `font: "inherit"` in the SAME object is the shorthand resetting itself:
  // insertion order decides, so the step written first is thrown away and the
  // element renders at whatever its parent is. Thirteen objects were doing
  // this, including the citation marker — so two hundred `[12]` markers in a
  // long report were drawn at body size instead of micro, and three small
  // controls were drawn as prose.
  //
  // A bare `font: "inherit"` with no FONT step above it is fine and stays: a
  // button that means to take its parent's type is saying so.
  const discarded = [];
  const body = SOURCE.split(/\r?\n/);
  body.forEach((line, index) => {
    if (!line.includes('font: "inherit"')) return;
    let depth = 0;
    for (let back = index; back >= 0 && index - back < 40; back -= 1) {
      const text = body[back];
      depth += (text.match(/\}/g) ?? []).length - (text.match(/\{/g) ?? []).length;
      if (back < index && /font: FONT\./.test(text) && depth <= 0) {
        discarded.push(`${index + 1} discards the FONT step at ${back + 1}`);
        return;
      }
      if (depth < 0 && back < index) return;
    }
  });
  assert.deepEqual(
    discarded,
    [],
    "a `font: \"inherit\"` follows a FONT step in the same object and silently discards it",
  );
});

test("the rhythm holds", () => {
  // 136 gaps across sixteen values became eight, and every survivor is a 1px
  // or 2px hairline pack — spacing that is doing a divider's job, not the
  // rhythm's. Sixty-one radii across thirteen values became zero.
  const gaps = [...SOURCE.matchAll(/gap: "(\d+)px"/g)].map((match) => Number(match[1]));
  for (const gap of gaps) {
    assert.ok(gap <= 2, `a ${gap}px gap is back. Between 3 and 24 the answer is a SPACE step; only a hairline pack may name its own number`);
  }
  assert.equal([...SOURCE.matchAll(/borderRadius: "[^"]+"/g)].length, 0, "a raw radius is back; thirteen values within six pixels of each other is what this replaced");
});

/**
 * One function declaration, whole, by matching its braces.
 *
 * `indexOf("};")` is the idiom the object tests above use and it is wrong for a
 * function: the first `};` inside `pillStyle` closes a ternary branch, three
 * lines ABOVE the property this test exists to find. A guard that stops
 * reading before the thing it guards is a guard that passes for the wrong
 * reason.
 * @param opening - the text the declaration starts with.
 * @returns the declaration's source, from the name to its closing brace.
 */
function declaration(opening) {
  const at = SOURCE.indexOf(opening);
  assert.notEqual(at, -1, `${opening} is gone from lib/client.js`);
  let depth = 0;
  for (let cursor = SOURCE.indexOf("{", at); cursor < SOURCE.length; cursor += 1) {
    if (SOURCE[cursor] === "{") depth += 1;
    if (SOURCE[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(at, cursor + 1);
    }
  }
  throw new Error(`${opening} never closes`);
}

// ── the small surfaces ─────────────────────────────────────────────────────
//
// Ten sites drew one chip by hand — seven radii, five paddings and three font
// sizes — and three more hand-built the same tinted box in three alphas. None
// of the differences was a decision, and every one of them is visible only
// when two of the copies are on screen together, which is most of the time.

test("the chip is a primitive, not a shape ten places redraw", () => {
  assert.ok(SOURCE.includes("function Chip("), "the chip primitive is gone; the ten hand-drawn copies are what it replaced");
  assert.ok(SOURCE.includes("function Callout("), "the callout primitive is gone");
  // Ten, not twelve: the four STATE sites route through `pillStyle` rather
  // than through `Chip`, because a state and a category are deliberately two
  // shapes — see the test below. Counting them here would be counting the
  // separation as a failure.
  assert.ok(
    SOURCE.split("Chip({").length - 1 >= 10,
    "the chip primitive exists and barely anything calls it, which is a tenth geometry rather than one fewer",
  );
  assert.ok(
    SOURCE.split("Callout({").length - 1 >= 6,
    "fewer than six callouts: three were hand-built boxes and three were bare coloured text, and all six were meant to become this one component",
  );
});

test("one chip geometry survived, and it is not any of the seven", () => {
  // The claim this batch actually makes is not that a component exists — it is
  // that the literals it replaced are GONE. A primitive beside its copies is
  // an eleventh way to draw a chip.
  assert.equal([...SOURCE.matchAll(/borderRadius: "[57]px"/g)].length, 0, "a 5px or 7px chip corner is back; the ramp has sm/md/lg/pill and none of them is five");
  for (const padding of ['padding: "1px 7px"', 'padding: "3px 9px"', 'padding: "2px 9px"']) {
    assert.equal(
      SOURCE.split(padding).length - 1,
      0,
      `${padding} is back. It is one of the five paddings that drew one chip, and it is a pixel from the next one`,
    );
  }
});

test("a state is drawn round and a category is not", () => {
  assert.ok(SOURCE.includes("function pillStyle("), "pillStyle is gone, and with it the only thing separating a state from a category by shape");
  const body = declaration("function pillStyle(");
  assert.ok(
    body.includes("RADIUS.pill"),
    "pillStyle does not use RADIUS.pill. The finding was that six status pills were drawn at 5px and 6px and NONE of them was round",
  );
  // COUNTED AT `pill: true`, NOT AT `pillStyle(`, and the change is the same
  // correction B8 made to the `roleTone(` count. Every state site used to
  // spread `pillStyle` itself; they now pass `pill: true` to `Chip`, which
  // calls it once — so the direct-call count fell to one and a guard written
  // against that count would score the worse design higher. What the finding
  // actually was is unchanged: a STATE is round, and there are at least four
  // of them.
  const rounds = SOURCE.split("pill: true").length - 1;
  assert.ok(
    rounds >= 4,
    `${rounds} sites ask for the round shape; the mission pill, the header pill, the dimension state and the task board's status are four states that must not be drawn as categories`,
  );
  assert.ok(
    SOURCE.split("pillStyle(").length - 1 >= 2,
    "pillStyle has no caller but its own declaration — the round shape is declared and nothing spends it",
  );
});

test("the three bare notices are banners with a tone", () => {
  // The notices were `{margin, font, color}` and nothing else — no box, no
  // mark, no cap on a response body that can be a paragraph.
  //
  // AT THE THREE MOUNTS, BY KEY. The first draft of this test asked whether
  // the strings `tone: TONE.info` / `.danger` / `.warn` occurred ANYWHERE in
  // eleven thousand lines. They do — a chapter counter passes one, a host
  // share bar another — so it passed with two of the three notices reverted
  // to the bare coloured text they were, which a mutation proved. A guard
  // satisfied by an unrelated line is not a guard, it is a claim.
  const detail = code(body("function MissionDetail("));
  for (const [key, tone, what] of [
    ["notice", "TONE.info", "the wait"],
    ["actionError", "TONE.danger", "the failed action"],
    ["staleView", "TONE.warn", "the stale view"],
  ]) {
    const at = detail.indexOf(`}, "${key}")`);
    assert.notEqual(at, -1, `${what} is gone from the mission header entirely`);
    const from = detail.lastIndexOf("Callout({", at);
    assert.ok(from !== -1 && at - from < 600, `${what} is not drawn as a Callout — it is bare coloured text again, with no box, no mark and no cap on a paragraph`);
    assert.ok(
      detail.slice(from, at).includes(`tone: ${tone}`),
      `${what} is a banner in some other tone than ${tone}, so the three notices no longer differ by the thing that separates them`,
    );
  }
  // AND THE CAP IS IN THE PRIMITIVE, which is the load-bearing half: a 409's
  // response body is a paragraph, and uncapped it pushed the whole header
  // stack down the page.
  assert.match(
    code(body("function Callout(")),
    /maxHeight: "\d+px", overflowY: "auto"/,
    "the callout body lost its cap, so one long response body owns the top of the screen again",
  );
});

test("the count badge is declared after the stack it reads", () => {
  // A cheap, exact guard against the crash this batch was one edit from: MONO
  // used to be declared beside the trajectory table, four thousand lines below
  // the tokens, and COUNT_CHIP is a top-level object literal that reads it at
  // MODULE EVALUATION. Written in the wrong order that is a TDZ
  // ReferenceError at load and a blank tab, not a style bug.
  const mono = SOURCE.indexOf("const MONO");
  const chip = SOURCE.indexOf("const COUNT_CHIP");
  assert.notEqual(mono, -1, "MONO is gone or renamed; COUNT_CHIP reads it at module evaluation");
  assert.notEqual(chip, -1, "COUNT_CHIP is gone");
  assert.ok(chip > mono, "COUNT_CHIP is declared before MONO, which is a ReferenceError at load — the tab renders nothing at all");
  assert.ok(
    SOURCE.split("COUNT_CHIP").length - 1 >= 4,
    "COUNT_CHIP is declared and unused; the counts are still bare monospace in the tertiary label colour",
  );
});

// ── the vocabularies get their colour ──────────────────────────────────────
//
// Every one of these is a table that already existed and a consumer that never
// read it. ROLE_TONE had one caller — `roleTone`'s own body — so the seven-hue
// agent ramp had no pixels at all; MISSION_ROLE_FACES carried five `hue`s that
// nothing looked at while the tag beside them was coloured by whether the row
// failed; MISSION_VERIFY_FACES was the one vocabulary in the file with no
// colour, so 已核验 and 查无此文 were the same grey box. None of that throws,
// and none of it is visible in a diff — which is what a source test is for.

/** The first-level keys of an object literal declared at the top level. */
function keysOf(opening) {
  const block = declaration(opening);
  // Only the first level. Every table here is one deep, and a nested
  // `{ zh, en }` would otherwise contribute `zh` as if it were a role.
  //
  // A COMMA COUNTS AS A SEPARATOR, not just a newline. The first draft
  // anchored on line starts alone, and a mutation test found what that
  // misses: a second key written on the same line as the first was invisible
  // to it, so ROLE_ICON could gain a role ROLE_TONE has never heard of and
  // the comparison below would still pass. A guard that cannot see half the
  // ways a table is written is a claim, not a check.
  const found = [];
  let depth = 0;
  for (const match of block.matchAll(/([{}])|(?:^|\n|,)\s*"?([\w-]+)"?:/g)) {
    if (match[1] === "{") { depth += 1; continue; }
    if (match[1] === "}") { depth -= 1; continue; }
    if (depth === 1 && match[2] !== undefined) found.push(match[2]);
  }
  return found;
}

test("the role ramp finally has pixels", () => {
  // NOT the `roleTone(` >= 5 the batch spec asked for, and the difference is
  // the point. The spec assumed each of the four identity sites would call
  // `roleTone` itself; they call `RoleChip`, which calls it once. Counting
  // `roleTone(` would therefore score a WORSE design higher — four copies of
  // one colon-split beat one — so the guard is written against what the
  // finding actually was: the ramp has a consumer, and the consumer is on
  // screen in more than one place.
  assert.ok(SOURCE.includes("function RoleChip("), "RoleChip is gone, and with it the only thing that spends ROLE_TONE");
  const calls = SOURCE.split("roleTone(").length - 1;
  assert.ok(calls >= 2, `roleTone( appears ${calls} times — the declaration and nothing else, which is the state this batch existed to end`);
  assert.ok(
    SOURCE.split("RoleChip(").length - 1 >= 5,
    "RoleChip is declared and barely called; the roster, the owner column, the stage detail and the trajectory are still printing raw agent ids as body text",
  );
});

test("ROLE_ICON and ROLE_TONE are keyed alike, and every glyph exists", () => {
  // Two tables that must agree and are five hundred lines apart. A role with a
  // colour and no glyph draws a chip with a hole in it, which reads as a broken
  // icon rather than as a missing role — and `Icon` renders NOTHING for a name
  // it does not hold, so the failure is silent in both directions.
  assert.deepEqual(
    keysOf("const ROLE_ICON = {").sort(),
    keysOf("const ROLE_TONE = {").sort(),
    "ROLE_ICON and ROLE_TONE disagree on which roles exist",
  );
  const glyphs = new Set(keysOf("const ICON_PATHS = {"));
  for (const [, name] of declaration("const ROLE_ICON = {").matchAll(/\w+: "(\w+)"/g)) {
    assert.ok(glyphs.has(name), `ROLE_ICON points at "${name}", which ICON_PATHS does not hold — Icon renders null for it and the chip loses its mark`);
  }
});

test("the words for the roles are keyed like their colours", () => {
  // MISSION_AGENT_FACES deliberately carries no `hue`: the colour is
  // ROLE_TONE's and `roleTone()` is the lookup, so there is only one place
  // "researcher is blue" is true. What it must carry is the same key set, or a
  // role resolves to its own raw slug inside a chip that is nonetheless
  // correctly coloured — right colour, English identifier on a Chinese screen.
  assert.deepEqual(
    keysOf("const MISSION_AGENT_FACES = {").sort(),
    keysOf("const ROLE_TONE = {").sort(),
    "MISSION_AGENT_FACES and ROLE_TONE disagree on which roles exist",
  );
});

test("all nine verify states carry a colour", () => {
  const block = declaration("const MISSION_VERIFY_FACES = {");
  const words = block.split("zh:").length - 1;
  const hues = block.split("hue:").length - 1;
  assert.equal(words, 9, `${words} verify states — the store writes nine, and the whole reason it writes nine is that they need opposite responses`);
  assert.equal(hues, words, "a verify state has a word and no colour, which is the state the whole table was in: 已核验 and 查无此文 drawn as the same grey chip");
  // THE SPLIT THE TABLE'S OWN DOCBLOCK NAMES. A quote nobody could check and a
  // quote that was checked and found nowhere are the same number in the same
  // place, and colouring them alike undoes the distinction at the last step.
  for (const state of ["unchecked-fetch-failed", "unchecked-rate-limited", "unchecked-stale"]) {
    const from = block.indexOf(`"${state}"`);
    assert.notEqual(from, -1, `${state} is gone from MISSION_VERIFY_FACES`);
    assert.match(
      block.slice(from, block.indexOf("}", from)),
      /hue: TONE\.muted/,
      `${state} is not muted. "4 fetches failed with 429" drawn in the same red as "4 quotes were invented" is the merge this column has nine values to prevent`,
    );
  }
});

test("the tool doors have a word, a mark and a colour", () => {
  const block = declaration("const MISSION_TOOL_FACES = {");
  const words = block.split("zh:").length - 1;
  assert.ok(words >= 4, `${words} tools — the ceilings alone name three, and a knowledge base is the fourth`);
  assert.equal(block.split("hue:").length - 1, words, "a tool has a word and no colour");
  assert.equal(block.split("icon:").length - 1, words, "a tool has a word and no mark");
  const glyphs = new Set(keysOf("const ICON_PATHS = {"));
  for (const [, name] of block.matchAll(/icon: "(\w+)"/g)) {
    assert.ok(glyphs.has(name), `MISSION_TOOL_FACES points at the glyph "${name}", which ICON_PATHS does not hold`);
  }
  // The fallback is the load-bearing half: the Host registers its own ids and
  // this list deliberately does not block on enumerating them, so an unlisted
  // door has to draw as its own slug under a wrench rather than unmarked.
  assert.ok(SOURCE.includes(`? MISSION_TOOL_FACES[id].icon : "wrench"`), "the unknown-tool fallback glyph is gone, so a door this table has not heard of renders unmarked");
  assert.ok(glyphs.has("wrench"), "ICON_PATHS has no wrench, and Icon renders null for a name it does not hold");
  // AND SOMETHING WEARS IT. Everything above is a property of the TABLE, and
  // a table can carry a word, a mark and a colour for every door and still
  // reach no pixel — which is the unused-token failure this whole section
  // exists to catch, one layer up. Nothing held `ToolChip`'s two mounts:
  // replacing both with `String(row.tool)` left the entire suite green, so
  // `no-toolbadge` was a claim rather than a check.
  for (const site of ["function MissionToolTable(", "function MissionTried("]) {
    assert.ok(
      code(body(site)).includes("ToolChip({"),
      `${site} prints a raw tool id again — the identifier the Host registered it under, unmarked and uncoloured, in a column whose whole job is to say which door is failing`,
    );
  }
});

test("every mode the catalogue declares has a face here", () => {
  // Read from mission-runtime.js rather than hard-coded, because the failure
  // this guards is a TENTH mode arriving there and not here: `missionFace`
  // falls through to the raw value, so the badge would print `fan-out` — an
  // English identifier — on a Chinese screen, and nothing would throw.
  const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "mission-runtime.js"), "utf8");
  const declared = new Set([...runtime.matchAll(/mode: "([a-z-]+)"/g)].map((match) => match[1]));
  assert.ok(declared.size >= 9, `mission-runtime.js declares ${declared.size} modes; the catalogue has nine`);
  const faces = new Set(keysOf("const MISSION_STAGE_MODE_FACES = {"));
  assert.ok(faces.size >= 9, `${faces.size} mode faces for ${declared.size} declared modes`);
  for (const mode of declared) {
    assert.ok(faces.has(mode), `the catalogue declares mode "${mode}" and MISSION_STAGE_MODE_FACES has no word for it`);
  }
  const block = declaration("const MISSION_STAGE_MODE_FACES = {");
  assert.equal(block.split("hue:").length - 1, block.split("zh:").length - 1, "a mode has a word and no colour");
  // The suppression branch. A source test can prove it EXISTS; it cannot prove
  // it fires on the right stages, because the collision is a runtime string
  // comparison between two per-language labels — which is exactly why the code
  // compares labels instead of listing stage ids.
  // Asserted against SOURCE rather than through `declaration()`: that helper
  // brace-matches from the first `{` it finds, and for a function the first
  // `{` is the destructured parameter list — so it hands back the signature
  // and nothing else. A guard that reads the wrong text is the failure this
  // file already carries one comment about.
  assert.ok(
    SOURCE.includes("if (label === missionFace(MISSION_STAGE_FACES, stepId, zh)) return null;"),
    "the mode badge no longer suppresses itself, so five of the twelve stages print their own name twice in two shapes",
  );
});

test("the trajectory tag is coloured by what it says, not by whether the row failed", () => {
  assert.equal(
    SOURCE.split("missionTagFace(").length - 1,
    0,
    "missionTagFace is back. Its whole body was a switch on row.ok and row.kind, which made four colours out of five kinds and repeated in colour what the tag's own word already said",
  );
  assert.ok(
    SOURCE.includes("missionHue(MISSION_ROLE_FACES"),
    "MISSION_ROLE_FACES carries five hues and nothing reads them, which is the state that let the tag be coloured by row.ok instead",
  );
  // AND IT REACHES THE TAG. Reading the hue into a local and then not
  // spending it is the same screen as never reading it, and a mutation test
  // caught exactly that: deleting the tag's style left the `missionHue` call
  // above intact and the assertion above still passed.
  assert.ok(
    SOURCE.includes("style: { color: `rgb(${kindHue})`, background: `rgba(${kindHue},${TINT.soft})` }"),
    "the kind hue is computed and not spent — the tag is back to being uncoloured or coloured by something else",
  );
  // The agent reached the DOM only inside a `title` attribute, so the densest
  // screen in the tab could not say who took a step without a hover per row.
  assert.match(
    SOURCE,
    /RoleChip\(\{ agentId: row\.agentId[^)]*iconOnly: true \}/,
    "the trajectory row has no role mark; the agent id is back to being tooltip-only",
  );
  assert.ok(
    SOURCE.includes(".swt-tagslot{flex:none;width:96px"),
    "the tag slot is back to 64px, which does not fit the kind tag and the role mark together",
  );
});

// ── B9: the states get a mark, the vocabularies get their colour ───────────
//
// Everything below is a property of the SOURCE. Each one was mutation-tested
// against a deliberately broken copy of `lib/client.js` before it was kept — a
// guard that cannot fail is not a guard, it is a claim.

/** One array literal, from its name to the `.join(` that closes it. */
function arrayLiteral(opening) {
  const at = SOURCE.indexOf(opening);
  assert.notEqual(at, -1, `${opening} is gone from lib/client.js`);
  const end = SOURCE.indexOf("].join(", at);
  assert.notEqual(end, -1, `${opening} never closes`);
  return SOURCE.slice(at, end);
}

const TRACE_RULES = arrayLiteral("const TRACE_CSS = [");
const SHEET_RULES = arrayLiteral("const SWM_RULES = [");

/**
 * One function's BODY, whole.
 *
 * NOT BRACE-MATCHED, and both reasons are traps this file has already fallen
 * into. `declaration()` matches from the first `{`, which for
 * `function Chip({ tone, … }, key)` is the PARAMETER LIST — it returns the
 * props and stops, and every assertion made against it then passes for the
 * wrong reason. Starting from the body's own brace instead fixes that and
 * walks straight into the second trap: counting braces cannot see quotes, and
 * `missionColourJson` contains the string `"{"` — one nesting level that never
 * closes, so its "body" ran on to the end of the file and the guard below read
 * class names off six other components.
 *
 * The INDENTATION is the anchor that holds. Every function in this bundle is
 * declared at two tabs inside the module's IIFE, so its close is the first
 * line that is exactly `\t\t}` — a position no string literal and no nested
 * block can occupy.
 * @param opening - the text the function starts with.
 * @returns the function's source, from its name to its closing brace.
 */
function body(opening) {
  const at = SOURCE.indexOf(opening);
  assert.notEqual(at, -1, `${opening} is gone from lib/client.js`);
  const end = SOURCE.indexOf("\n\t\t}", at);
  assert.notEqual(end, -1, `${opening} never closes at the module's own indent`);
  return SOURCE.slice(at, end + 4);
}

test("every state carries a mark as well as a colour", () => {
  // THE ACCESSIBILITY HALF OF THE WHOLE BATCH. Each of these three tables has
  // at least one pair of values that share a hue ON PURPOSE — `pending` and
  // `skipped-by-tier` are both muted because a skip is not a failure,
  // `cancelled` and `unknown` are both neutral — so for those pairs the tint
  // cannot be the answer and the glyph is the only thing left. It is also the
  // only thing left for a reader who cannot separate the two tints at all.
  for (const table of [
    "const MISSION_STAGE_STATUS_FACES = {",
    "const MISSION_DIMENSION_FACES = {",
    "const MISSION_PILL_FACES = {",
  ]) {
    const block = declaration(table);
    const hues = block.split("hue:").length - 1;
    const icons = block.split("icon:").length - 1;
    assert.ok(hues > 0, `${table} declares no hue at all`);
    assert.equal(
      icons,
      hues,
      `${table} has ${hues} colours and ${icons} marks. A state with a hue and no glyph is a state that another state is drawn exactly like`,
    );
  }
  // And every mark names a glyph that exists: `Icon` renders NOTHING for a name
  // ICON_PATHS does not hold, so a typo here is a hole in a chip rather than an
  // error anybody sees.
  const glyphs = new Set(keysOf("const ICON_PATHS = {"));
  for (const [, name] of SOURCE.matchAll(/icon: "(\w+)"/g)) {
    assert.ok(glyphs.has(name), `icon: "${name}" is not in ICON_PATHS — the chip that asks for it silently loses its mark`);
  }
});

test("the event log is the last vocabulary to get its colour, and it got it", () => {
  // `missionHue` answers TONE.neutral for any entry whose `hue` is not a
  // string, so a table with no hue at all does not fail — it renders thirty
  // event types in one grey, which is what the stream looked like.
  const block = declaration("const MISSION_EVENT_FACES = {");
  const words = block.split("zh:").length - 1;
  const hues = block.split("hue:").length - 1;
  assert.ok(words >= 29, `${words} event types is fewer than the Host half registers`);
  assert.equal(hues, words, "an event type has a word and no colour, and `missionHue` answers neutral for it without telling anybody");
});

test("the JSON tokeniser's class names all have rules", () => {
  // THE DEAD-CODE FAILURE THIS BATCH EXISTED TO FIND, and the guard is written
  // against the emitter rather than against three literals: it reads the class
  // names `missionColourJson` actually emits and demands a rule for each. A
  // fourth token added later with no rule fails here; three hard-coded strings
  // would not have.
  const emitter = body("function missionColourJson(");
  const emitted = new Set([...emitter.matchAll(/className: [^,]*?"(\w+)"(?: : "(\w+)")?/g)].flatMap(
    (match) => [match[1], match[2]].filter((name) => name !== undefined),
  ));
  assert.ok(emitted.size >= 3, `the tokeniser emits ${emitted.size} class names; it emits k, s and n`);
  for (const name of emitted) {
    assert.ok(
      TRACE_RULES.includes(`.swt-code .${name}{`),
      `missionColourJson emits className "${name}" and no rule defines it — the tokeniser allocates a span per token and the payload renders in one colour`,
    );
    // SCOPED, EVERY TIME IT APPEARS. These are one-letter names on a sheet the
    // whole tab shares; an unscoped `.k` paints anything anyone ever gives that
    // class. Counted rather than pattern-matched as a negative: every `.k{` on
    // the sheet must be the tail of a `.swt-code .k{`, so one unscoped copy
    // makes the two counts differ.
    const all = TRACE_RULES.split(`.${name}{`).length - 1;
    const scoped = TRACE_RULES.split(`.swt-code .${name}{`).length - 1;
    assert.equal(
      all,
      scoped,
      `.${name} is defined unscoped somewhere; a one-letter class name on a shared sheet is a rule that will hit something else`,
    );
  }
});

test("the quote block stops claiming every quote is fine", () => {
  const rule = TRACE_RULES.split("\n").find((line) => line.includes(".swt-quote{"));
  assert.ok(rule, ".swt-quote is gone; the finding's verbatim quote and the degrade note both lose their block");
  assert.ok(
    !rule.includes("state-success-primary"),
    "the quote rule still hard-codes the success green. It serves a REFUTED quote and a degrade note as well as a confirmed one, and green is a verdict",
  );
  assert.ok(rule.includes("currentColor"), "the quote rule names no inheritable colour, so the call sites have nothing to override");
  // And both call sites actually override it. A rule that inherits and nobody
  // tones draws every quote in the text colour, which is the same one-answer
  // failure one shade quieter.
  const overrides = SOURCE.split("borderLeftColor:").length - 1;
  assert.ok(overrides >= 2, `${overrides} call sites tone the quote; the finding's verdict and the degrade note are two`);
});

test("a chip that can be pressed is a button, and keeps its ring", () => {
  // One chip, two elements. The alternative was a second component for the one
  // place a chip is a control, and a second component is a second geometry the
  // moment either is touched. What a button needs and a span never wanted is
  // the resets and the focus ring — and `:focus-visible` is not reachable from
  // a style object, so the ring arrives as a class.
  const chip = body("function Chip(");
  assert.ok(chip.includes('jsxs(pressable ? "button" : "span"'), "Chip is a span whatever it does; a pressable chip is not announced as a control");
  assert.ok(chip.includes('type: pressable ? "button" : undefined'), "a pressable chip inside a form would submit it");
  assert.ok(/swm-focus/.test(chip), "a pressable chip draws no focus ring, so a keyboard user cannot see where they are on the ruler");
});

test("the event stream has a rail, and the rail is a pseudo-element", () => {
  assert.ok(SHEET_RULES.includes(".swm-rail:before{"), "the rail's line is gone. As a wrapper border it would run past the first and last dot instead of between them");
  assert.ok(SHEET_RULES.includes(".swm-ev:hover{"), "an event row has no hover, which is a state no style object can express");
  const timeline = body("function MissionTimeline(");
  assert.ok(timeline.includes('className: "swm-rail"'), "the stream is a flat list again");
  assert.ok(
    timeline.includes("missionHue(MISSION_EVENT_FACES, event.type)"),
    "the row does not read the event's colour, so the thirty hues added to the table reach nothing",
  );
  assert.ok(
    timeline.includes("missionClock(event.ts)"),
    "the stamp is back to minute resolution — six events inside one minute then print six identical times and the order is unreadable",
  );
});

test("the task board resolves a row's status once", () => {
  const board = body("function MissionTaskBoard(");
  // TWO READERS, ONE RESOLUTION. The legend counts what the rows draw. Written
  // twice — once per row and once per tally, forty lines apart — the two drift
  // and the header says 3 完成 over four green rows.
  const resolutions = board.split('.state ?? "pending"').length - 1;
  assert.equal(resolutions, 1, `the row's status is resolved ${resolutions} times; the legend above the table and the spine beside each row must be one fact`);
  assert.ok(board.includes("const tally = new Map()"), "the board has no tally, so a thirty-row table still has to be read to be counted");
  assert.ok(
    board.includes("MISSION_DIMENSION_FACES).filter("),
    "the legend walks only the stage vocabulary; a child row is a dimension and 采集中 would be counted by nothing, so the tallies would not add up to the rows",
  );
});

test("slow means one thing on both screens that say it", () => {
  // Two columns answer "which door is slow" — the trajectory's trailing metric
  // and the tool table's mean latency — and both drew every duration in the
  // same tertiary grey. Banding them against a number typed at each call site
  // is how two screens end up disagreeing about what slow is.
  for (const name of ["MISSION_SLOW_MS", "MISSION_WARN_MS"]) {
    const declarations = SOURCE.split(`const ${name} =`).length - 1;
    assert.equal(declarations, 1, `${name} is declared ${declarations} times`);
  }
  // AND NO THIRD ONE APPEARS BESIDE THEM. Counting only the two names cannot
  // see the way this actually regresses: nobody edits `MISSION_SLOW_MS` to say
  // something else, they add `MISSION_VERY_SLOW_MS` next to it and read that
  // at one site. A mutation test found exactly that hole. `MISSION_POLL_MS` is
  // the one legitimate neighbour — it is how often the view refetches, not a
  // band a duration is drawn against.
  const durations = [...SOURCE.matchAll(/const (MISSION_\w*_MS)\b/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    durations,
    ["MISSION_POLL_MS", "MISSION_SLOW_MS", "MISSION_WARN_MS"],
    "a third duration constant is declared in the missions half. Two screens already say 'slow'; a third number is how they start disagreeing",
  );
  const uses = SOURCE.split("MISSION_SLOW_MS").length - 1 + SOURCE.split("MISSION_WARN_MS").length - 1 - 2;
  assert.ok(
    uses >= 4,
    `the two thresholds are read ${uses} times outside their declarations; the trajectory's metric column and the tool table's latency cell are two sites reading two thresholds each`,
  );
  // Both are read against a duration and nothing else. A threshold that starts
  // deciding whether to retry is a behaviour change wearing a colour's name.
  for (const [line] of SOURCE.matchAll(/[^\n]*MISSION_(?:SLOW|WARN)_MS[^\n]*/g)) {
    assert.ok(
      !/\breturn\b|\bthrow\b|fetch\(/.test(line),
      `a duration threshold is deciding something rather than drawing it: ${line.trim()}`,
    );
  }
});

// ── the panel header and the three tables ──────────────────────────────────
//
// Two findings, one shape. `MissionPanel` printed a bare `h3` with a whole
// sentence beside it on the same baseline and dropped even that when `bare`,
// so the four densest panes in the tab arrived unlabelled; and the three data
// tables on those panes declared three head/cell pairs between them — three
// heights, three paddings, two header weights, and a roster whose cells had no
// padding at all. None of it throws and none of it shows in a diff.

/** The three data tables, which are the whole subject of half these tests. */
const TABLES = [
  "function MissionToolTable(",
  "function MissionTaskBoard(",
  "function MissionAgentTable(",
];

/** The missions-detail region, where every MissionPanel is mounted. */
const DETAIL = SOURCE.slice(
  SOURCE.indexOf("//#region missions detail\n"),
  SOURCE.indexOf("//#region missions report"),
);

test("the panel header carries a count and a slot, and keeps its title when bare", () => {
  const signature = /function MissionPanel\(\{([^}]+)\}/.exec(SOURCE);
  assert.ok(signature, "MissionPanel no longer destructures its props, so nothing below can be read off it");
  for (const prop of ["count", "action"]) {
    assert.ok(
      signature[1].includes(prop),
      `MissionPanel does not take \`${prop}\`. Without it a number stays buried in a sentence and the task board keeps hand-building a header the panel should own`,
    );
  }
  // `bare` MUST NOT REACH THE TITLE any more. The old branch read
  // `bare === true ? null : jsx("h3"` and it is the whole reason the tasks,
  // sources, dimensions and trajectory panes arrived as unlabelled slabs.
  assert.ok(
    !/bare === true \? null : jsx\("h3"/.test(SOURCE),
    "`bare` still discards the heading. It is meant to say 'no card chrome' and nothing else — the four panes that pass it are the four that most need a label",
  );
  // AND THE PROSE IS OUT OF THE HEADER. A header that wraps is a header three
  // lines tall on a narrow pane, which is what `flexWrap` plus a `note`
  // holding a full sentence produced.
  //
  // THE COMMENTS ARE STRIPPED FIRST, and the first draft of this test did not
  // do it and failed against a correct file: the rewritten component explains
  // in a comment what it no longer does, and the words it uses to explain it
  // are the words being searched for. A guard that reads prose is a guard that
  // can be broken by describing the fix.
  const panel = body("function MissionPanel(").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!panel.includes("flexWrap"), "the panel header can wrap again; a sentence in `note` then drops under the title and the header grows to three lines");
  assert.ok(!panel.includes('alignItems: "baseline"'), "the header aligns on the baseline again, which sits the count badge low against an 11px eyebrow");
  // AND THE PROSE IS BELOW THE RULE, not merely un-wrapped. `"head"` is the
  // header row's key, so a note paragraph rendered before it is a note back
  // inside the header — the position that made the header three lines tall,
  // reached again without `flexWrap` ever coming back.
  assert.ok(
    panel.indexOf('}, "head")') < panel.indexOf('jsx("p"'),
    "the note renders inside the header row again; a sentence there is a header as tall as the sentence",
  );
});

test("a prop that exists and is never passed is the next failure", () => {
  // The guard the batch spec asked for, written against the call sites rather
  // than against the component: `count` on a signature nobody passes is a
  // slot, not a feature, and the numbers stay in the prose where they were.
  const mounts = DETAIL.split("MissionPanel, {").slice(1);
  assert.ok(mounts.length >= 8, `only ${mounts.length} MissionPanel mounts in the detail region`);
  // `action` HAS A CALLER, which is the whole reason it is in the signature.
  // The task board used to hand-build a header of its own — a count and a
  // status key — eight pixels above the panel's, because the panel had no slot
  // for either. A slot nobody fills would have left that duplicate standing.
  assert.ok(
    DETAIL.includes("action: "),
    "MissionPanel takes an `action` and no call site passes one, so the task board's hand-built header is still a second header shape on the same pane",
  );
  // Cut at `children:`, because that is where a panel's own props end and its
  // CONTENT begins — and one panel's content is where the next panel's props
  // would otherwise be read from.
  const props = (mount) => mount.slice(0, mount.indexOf("children:"));
  assert.ok(
    mounts.filter((mount) => props(mount).includes("count:")).length >= 6,
    "fewer than six panels pass a count. Six call sites buried a number in a sentence — 已核验 9 条 · 共 23 条发现 — and the badge exists so a reader does not have to parse a clause to find it",
  );
  // A RULE RATHER THAN A TALLY, and this is the half a count could not do. The
  // first draft asserted `>= 5` against six real call sites, so deleting one
  // still passed — a ratchet with headroom is a ratchet that never fires, which
  // is what a mutation test is for. The invariant underneath is sharper anyway:
  // a panel that is RENDERED ONLY IF SOMETHING IS NON-EMPTY has already
  // measured that something. It knows its own size, so printing it costs
  // nothing and withholding it is a decision nobody made.
  for (const match of DETAIL.matchAll(/jsx\(MissionPanel, \{/g)) {
    const guard = DETAIL.slice(Math.max(0, match.index - 180), match.index);
    if (!guard.includes(".length === 0 ? null :")) continue;
    const mount = DETAIL.slice(match.index, match.index + 900);
    assert.ok(
      props(mount).includes("count:"),
      `a panel gated on a length does not print it: ${mount.slice(0, 120).replace(/\s+/g, " ")}`,
    );
  }
});

test("no primitive declares a prop that nothing hands it", () => {
  // THE RULE THIS FILE STATES FOUR TIMES AND HAD NEVER ONCE CHECKED. `dot`
  // came off Chip, `accent` off MissionPanel, `mono` off MetricStat and `hits`
  // off SourceLink, each with the same sentence written down beside it: a prop
  // nobody passes is not a head start, it is the next geometry, added by
  // whoever first needs something near it. `RoleChip` then shipped `suffix` —
  // destructured, documented in its own @param line, and handed to it by
  // nothing — and every guard in this file was satisfied.
  //
  // MATCHED AS A SUBSTRING rather than with a word boundary, deliberately: a
  // prop can be passed long-hand (`suffix: name`), in a shorthand list
  // (`{ token, index, refs, zh }`) or as the last name before the brace, and
  // the three forms are what these three tests are. It is the loose direction
  // — `count` would be satisfied by `counts:` — so it under-reports rather
  // than failing a correct file, which is the right way round for a rule
  // nobody should have to argue with.
  const clean = code(SOURCE);
  for (const name of [
    "Chip", "RoleChip", "ToolChip", "StageModeChip", "Callout", "Meter", "MetricStat",
    "SourceLink", "EmptyBox", "ErrorBox", "Skeleton", "SkeletonScreen", "IconButton",
    "MissionClamp", "MissionPanel", "SwarmModal",
  ]) {
    // indexOf, not a built regex: a `\(` assembled inside a template literal
    // loses its backslash before RegExp ever sees it, and the first draft of
    // this test threw `Unterminated group` rather than checking anything.
    const opening = `function ${name}({`;
    const at = clean.indexOf(opening);
    assert.notEqual(at, -1, `${name} no longer destructures its props, so nothing here can be read off it`);
    const close = clean.indexOf("}", at + opening.length);
    assert.notEqual(close, -1, `${name}'s parameter list never closes`);
    // The declaration itself is cut out: a prop counts as passed only where it
    // is not being named.
    const rest = clean.slice(0, at) + clean.slice(close + 1);
    const props = clean.slice(at + opening.length, close).split(",").map((part) => part.trim().split(":")[0].trim()).filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
    assert.ok(props.length > 0, `${name}'s signature could not be read`);
    for (const prop of props) {
      assert.ok(
        rest.includes(`${prop}:`) || rest.includes(`${prop},`) || rest.includes(`${prop} }`),
        `${name} takes \`${prop}\` and nothing in this file ever hands it one. A slot with no caller is the tenth geometry waiting to happen — take it off, the way Chip lost \`dot\``,
      );
    }
  }
});

test("one cell recipe, not three", () => {
  // THE ENTIRE CLAIM OF THE FINDING. Three tables on three panes of the same
  // tab declared `const head` / `const cell` locally and disagreed with each
  // other on every property that has a value.
  assert.deepEqual(
    [...SOURCE.matchAll(/const head = \{/g)].map((match) => match[0]),
    [],
    "a local table-header recipe is back. Three copies is what this replaced, and the differences between them were nobody's decision",
  );
  for (const name of ["TH", "TD"]) {
    const declared = [...SOURCE.matchAll(new RegExp(`const ${name} = \\{`, "g"))].length;
    assert.equal(declared, 1, `${name} is declared ${declared} times; one shared recipe declared twice is two recipes`);
  }
  // And they are ADOPTED, IN EACH OF THE THREE, which a total cannot say. The
  // first draft counted `...TH` across the file and wanted four; there are
  // five, so a mutation that stripped the recipe out of a whole table still
  // passed. A shared recipe two tables use and one does not is the fourth
  // density, not one fewer.
  //
  // MATCHED IN VALUE POSITION, never as a substring. `includes("TH")` passes
  // on the word THE, and these comments are written in shouty caps — a
  // mutation that stripped the recipe out of a whole table sat under that
  // assertion because the cell above it says "THE SUBJECT OF THE TABLE".
  for (const table of TABLES) {
    const source = body(table);
    assert.ok(/\.\.\.TH\b|style: TH\b/.test(source), `${table} does not use the shared header cell, so its column labels are a density of their own again`);
    assert.ok(/\.\.\.TD\b|style: TD\b/.test(source), `${table} does not use the shared data cell, so its rows are a height of their own again`);
  }
});

test("the figures are tabular in one place rather than per cell", () => {
  const cell = scale("TD");
  assert.ok(
    cell.includes('fontVariantNumeric: "tabular-nums"'),
    "TD does not set tabular figures, so every column that shows a number has to remember to — and the one added next year will not",
  );
  // AND THE SHORTHAND STILL COMES FIRST. `TD` writes `font` then the variant;
  // an object that spreads TD and overrides `font` puts a shorthand BELOW that
  // variant in the merged insertion order and silently resets it. React writes
  // style keys in order, so the only fix is to write the variant again after
  // the override — and the only way to know it was is to check.
  const fontAt = cell.indexOf("font: FONT.");
  const variantAt = cell.indexOf("fontVariantNumeric");
  assert.ok(fontAt !== -1 && fontAt < variantAt, "TD sets fontVariantNumeric before its `font` shorthand, which discards it");
  for (const match of SOURCE.matchAll(/\{ \.\.\.TD,[^}]*\bfont: FONT\.[^}]*\}/g)) {
    assert.ok(
      match[0].includes("fontVariantNumeric"),
      `a cell spreads TD and overrides \`font\` without writing the figures back: ${match[0]}. The totals row then stops lining up under the columns it totals`,
    );
  }
});

test("a wide table scrolls instead of clipping a column off the card", () => {
  // WHAT A SOURCE TEST CAN AND CANNOT SEE, said plainly. The clip is a
  // consequence of CSS table-layout resolving to min-content inside an
  // `overflow: hidden` parent, and every property involved is individually
  // legal — so only a browser at a narrow width proves the mean-latency column
  // came back. What is checkable is the STRUCTURE that makes it possible: a
  // frame that clips (for the rounded corner) and an inner box that scrolls.
  // One element cannot do both; the corner wins and the scrollbar never
  // appears.
  //
  // PER TABLE, NOT AS A TOTAL, for the reason the recipe test above gives:
  // file-wide counts of `tableLayout` and `overflowX` both had headroom, so a
  // mutation that stripped either from a whole table sat under a passing
  // assertion.
  for (const table of TABLES) {
    const source = body(table);
    assert.ok(
      source.includes('tableLayout: "fixed"'),
      `${table} does not fix its layout. The browser then resolves the table to its content's min-content width, and inside an overflow:hidden frame a long tool id pushes the last column off the card — no scrollbar, no ellipsis, just a column that is not there`,
    );
    assert.ok(
      source.includes('overflow: "hidden"'),
      `${table} has no clipping frame, so it sits on the pane at a different altitude from the two tables beside it`,
    );
  }
  // The scroller is the two that declare a pixel minimum. The task board's
  // columns are percentages, so it can never be wider than its pane and a
  // scroll box there would be a scrollbar that never appears.
  for (const table of ["function MissionToolTable(", "function MissionAgentTable("]) {
    assert.ok(
      body(table).includes('overflowX: "auto"'),
      `${table} declares a minimum width and has nowhere to scroll, which is the clip this finding is about`,
    );
  }
});

test("a table row answers the pointer", () => {
  // `:hover` IS UNREACHABLE FROM AN INLINE STYLE, which is why two clickable
  // tables had no hover at all. The rule ships on SWM_RULES rather than
  // SWM_CSS, against the batch spec: SWM_CSS's entries sit INSIDE `body{ … }`,
  // so a rule written there would be nested in a declaration block and
  // dropped. Both strings are concatenated into SWM_SHEET and injected
  // together, so the effect is the one that was asked for.
  assert.ok(SHEET_RULES.includes(".swm-tr:hover"), "the row hover is gone from the sheet the page mounts before first paint");
  // EVERY TABLE, not two out of three: a rule that reaches some of the rows on
  // a pane is worse than one that reaches none, because the rows it misses read
  // as disabled.
  for (const table of TABLES) {
    const source = body(table);
    assert.ok(
      source.includes('className: "swm-tr"'),
      `${table}'s rows do not carry the class, so the hover rule is a stylesheet nobody reads`,
    );
    // AND NO ROW WRITES AN INLINE BACKGROUND FOR ITS RESTING STATE. An inline
    // declaration beats a stylesheet: `background: "transparent"` on every
    // unselected row would leave the rule in the sheet, the class on the row,
    // and nothing lighting up — a failure with no symptom to search for.
    assert.ok(
      !/background: [^,\n]*: "transparent"/.test(source),
      `${table} writes a resting background inline, which silently overrides .swm-tr:hover`,
    );
  }
});

test("a success rate is drawn as a share, and an uncalled tool is not drawn at all", () => {
  const table = body("function MissionToolTable(");
  assert.ok(
    /pct >= 90 \? TONE\.success/.test(table),
    "the success column is a bare percentage string again. Six numbers in one grey is a question you answer by holding six numbers in your head",
  );
  // THE BRANCH THAT MUST SURVIVE. `calls === 0` through `?? 0` is a 0% bar,
  // which draws a door nobody has opened as a door that fails every time —
  // the same defect as the `/0` the task board's verified chip refuses.
  assert.ok(
    /calls === 0 \? null/.test(table),
    "a tool with no calls is given a rate rather than an em dash; an empty track reads as 0%, which is the one reading that is certainly wrong",
  );
});

// ── meters, tiles and progress ─────────────────────────────────────────────
//
// Five bars, no two of them the same object, and all five painting their TRACK
// with a LINE token — which is a 4%/10% black overlay, a hairline on white and
// nothing at all on the dark theme's own dark ground. Three of the five had no
// visible track on dark: a coloured sliver in the page with nothing behind it
// to say what share it was. And every headline figure on the tab was either a
// table cell or a clause in a dot-joined grey sentence, including the two the
// mission screen exists to report.

/**
 * Source with its comments removed.
 *
 * Every guard below searches for words that this batch's own comments use to
 * explain what the code no longer does — `阶段 ${`, `missionCompact`,
 * `background: LINE.` — and a prose mention is not a declaration. The header
 * test one section up hit exactly this and failed against a correct file.
 * @param text - source text.
 * @returns the same text with `//` lines and docblocks blanked.
 */
function code(text) {
  return text.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*\*[\s\S]*?\*\//g, "");
}

/** Every bar in the file, by the function that draws it. */
const BARS = [
  "function MissionStageSpend(",
  "function MissionCostMeters(",
  "function MissionToolTable(",
  "function MissionProgressBar(",
  "function MissionListRow(",
  "function EpisodeRow(",
  "function PodcastFormat(",
];

test("there is one bar, and every bar is it", () => {
  assert.ok(SOURCE.includes("function Meter("), "the meter primitive is gone; the five hand-drawn tracks are what it replaced");
  // PER SITE, NOT AS A TOTAL. A file-wide `Meter({ >= 5` passes with one
  // component still drawing its own track and another calling it twice, which
  // is the headroom that let a whole table lose its header cells one batch ago.
  for (const bar of BARS) {
    assert.ok(
      body(bar).includes("Meter({"),
      `${bar} still draws its own track. Five of these existed, at four heights and three radii, and not one of the differences was a decision`,
    );
  }
});

test("no track is painted with an edge token", () => {
  // THE DEFECT, EXACTLY AND GREPPABLY. `LINE.hair` and `LINE.rule` resolve to
  // `--dsw-alias-border-l1`/`-l2`, which are black overlays: correct for a
  // divider, invisible as a fill on a dark ground.
  //
  // NOT a file-wide ban — a 1px divider drawn as a box is a legitimate use of
  // the same token, and banning it outright is a guard that forces the wrong
  // fix. A TRACK is the thing that CLIPS its fill, so the shape to look for is
  // one style object holding both.
  const stripped = code(SOURCE);
  for (const match of stripped.matchAll(/background: LINE\.\w+/g)) {
    const object = stripped.slice(stripped.lastIndexOf("{", match.index), stripped.indexOf("}", match.index) + 1);
    assert.ok(
      !object.includes(`overflow: "hidden"`),
      `a clipping box is painted with a LINE token: ${object.replace(/\s+/g, " ")}. That is a track, and on the dark theme a black overlay over a dark ground is no track at all`,
    );
  }
  const track = scale("TRACK");
  assert.ok(track.includes("SURFACE."), "TRACK no longer takes its ground from SURFACE, which is the half of this that survives the dark theme");
  assert.ok(!track.includes("LINE."), "TRACK paints itself with an edge token, which is the defect it exists to end");
});

test("the meter refuses a zero denominator rather than rendering full", () => {
  // `used / 0` is NaN, CSS drops a NaN width, and the fill keeps the width it
  // already had — which is 100%. A bar saying a mission with no stages has
  // finished is worse than no bar, and it is the same `/0` the verified chip
  // and the tool table's success column already refuse.
  const meter = body("function Meter(");
  assert.match(meter, /Number\(max\) > 0 \? Number\(max\) : 100/, "Meter divides by whatever `max` it is handed");
  assert.match(
    meter,
    /Math\.max\(0, Math\.min\(100,/,
    "Meter does not clamp. A mission can spend past a soft ceiling, and a 140%-wide fill leaves the panel it is measuring",
  );
});

test("a headline figure is a tile, not a clause", () => {
  assert.ok(SOURCE.includes("function MetricStat("), "the stat tile is gone");
  assert.ok(SOURCE.includes("function MissionStatTiles("), "the tile row is gone");
  // THE THREE SITES, EACH NAMED. A file-wide call count has the headroom every
  // other file-wide count in this file has had: three call sites plus a deleted
  // one still reads as three.
  // `function MissionDetail(` used to be on this list. Its four tiles were
  // removed: tokens and elapsed are the 成本 pane's subject, verified is the
  // 证据 count on the tab strip directly below, and a score is a figure a
  // failed run does not have — it rendered 0, which reads as "graded zero"
  // rather than "never graded".
  // TILES OR THE LINE, but never a dot-joined clause. This required the tile
  // row by name, which was the mechanism that replaced the clause. The report
  // and the sources pane read their figures as a LINE now — labelled, graded
  // by the same ladder, and over a rule rather than in four boxes — because
  // four boxes of fixed chrome above every list is what a reader meets before
  // the first row. What must not come back is the figure buried in a grey
  // sentence, so that is what is asserted.
  const sources = body("function MissionSources(");
  assert.ok(
    sources.includes("MissionStatTiles({") || sources.includes("MissionScoreLine({"),
    "MissionSources states its figures as a dot-joined sentence again — the shape both of these components replaced",
  );
  assert.ok(
    sources.includes("tone: missionRateHue(totals.verified, totals.findings)"),
    "the verified figure is no longer graded, so a pane that verified 3 of 40 reads like one that verified 40 of 40",
  );
  // FONT.title AND NOTHING BIGGER. The batch spec asked for a 24px numeral;
  // 20px is the largest step this file declares anywhere, and the raw-value
  // ratchet's `fontSize` ceiling is zero, so a 24px tile would have to be
  // written as a violation to exist at all.
  const tile = body("function MetricStat(");
  assert.ok(tile.includes("font: FONT.title"), "the tile's value is no longer FONT.title, so the file has a second opinion about how big its biggest number is");
  assert.ok(!/font(Size)?: "\d+px"/.test(tile), "the tile writes a raw size, which is the invented step FONT exists to prevent");
  // `font` IS A SHORTHAND: it resets the family, the leading AND the figures. A
  // tile is a column of numerals, so a `fontVariantNumeric` written above the
  // shorthand is discarded in the one component whose whole subject is that the
  // digits line up.
  const fontAt = tile.indexOf("font: FONT.title");
  assert.ok(fontAt !== -1 && fontAt < tile.indexOf("fontVariantNumeric"), "MetricStat sets the figures before its `font` shorthand, which throws them away");
  // ZERO IS A VALUE. `value || "—"` prints the em dash over a real zero, which
  // is the difference between "none verified" and "not measured" — the same
  // distinction the null-floor branch below exists to keep.
  assert.match(
    tile,
    /value === null \|\| value === undefined \|\| value === ""/,
    "MetricStat tests its value for truthiness, so a genuine 0 renders as the em dash that means not measured",
  );
});

test("no figure on the mission header is stated twice", () => {
  const detail = code(DETAIL);
  const metaAt = detail.indexOf("const meta = [");
  const meta = detail.slice(metaAt, detail.indexOf("].filter", metaAt));
  assert.ok(metaAt !== -1 && meta.length < 1200, "the mission header's meta array is not where this test thinks it is");
  assert.ok(
    !meta.includes("阶段 ${"),
    "the stage fraction is back in the joined meta line. The bar under it draws that fraction AND spells it, and a figure stated twice on one screen is what this batch was about",
  );
  assert.ok(
    !meta.includes("missionDuration"),
    "the elapsed clock is back in the joined meta line; it is a tile now, beside the wall-clock ceiling it is running out of",
  );
  // AND THE TWO THAT MUST STAY. Dimensions and chapters have no tile and no
  // bar, and they are the numbers that say WHICH of the three ran short.
  assert.ok(
    meta.includes("dimensionsResolved") && meta.includes("chaptersDone"),
    "the dimension and chapter fractions were deleted along with the stage one, and nothing else on this screen carries them",
  );

  const spendAt = detail.indexOf("const spend =");
  const spend = detail.slice(spendAt, detail.indexOf(";", spendAt));
  assert.ok(spendAt !== -1, "the tab strip's spend line is gone entirely, prop and all");
  assert.ok(
    !spend.includes("missionCompact"),
    "the token count is back on the tab strip as well as in a tile, four inches apart in the same viewport",
  );
  assert.ok(!spend.includes("mission.score"), "the score is back on the tab strip as well as in a tile");
});

test("the projector's percentage is finally read, and the bar is mounted", () => {
  const bar = code(body("function MissionProgressBar("));
  assert.ok(
    bar.includes("progress?.percent"),
    "MissionProgressBar computes a percentage of its own. `percent` has been on the view route since it was written — deliberately unblended with the dimension and chapter fractions — and re-deriving it here is a second answer to a question already answered",
  );
  // AND THE ABSENCE THAT RENDERS AS NOTHING, not as an empty track. The
  // projector answers `percent: 0` for a mission whose stages have not been
  // read yet, and a 0% bar over the words 阶段 0/0 says the run is stalled on
  // the start line rather than that there is nothing yet to measure.
  assert.match(
    bar,
    /if \(total <= 0\) return null;/,
    "the progress bar draws itself for a mission with no stage catalogue, which is an empty track saying 0% about a run nobody has measured",
  );
  // THE MOUNT, and the branch that keeps it off a finished run: a full green
  // bar under a completed mission reports the obvious, and one frozen at 58%
  // under a failed one invites the reader to wait for it.
  assert.match(
    code(DETAIL),
    /mission\.terminal === true \? null : jsx\(MissionProgressBar/,
    "the progress bar is either unmounted or mounted on every mission, terminal ones included",
  );
  // AND IN THE LIST, where a running row carried no ratio at all. Gated on the
  // status AND on a stage having been recorded: a row that has not reached s1
  // has nothing to measure, and an empty track under it says the mission is a
  // twelfth of the way through nothing.
  const row = code(body("function MissionListRow("));
  assert.match(
    row,
    /mission\.status !== "running" \|\| stageOrdinal === null \? null : Meter\(/,
    "the list row's bar is gone, or it is drawn for a settled row, or it is drawn before there is a stage to draw",
  );
  // MATCHED ON THE `max` THE BAR IS ACTUALLY GIVEN, not on the constant being
  // mentioned. A mutation that hard-coded 10 as the denominator left
  // MISSION_STAGE_ORDER in the aria-label three lines below, and an
  // `includes` passed over a bar measuring twelve stages out of ten.
  assert.match(
    row,
    /max: MISSION_STAGE_ORDER\.length/,
    "the list row measures against a denominator of its own. The list route hands back the raw mission row — no `progress` at all — so the ordinal has to be read out of the same twelve the detail screen divides by, or the two bars are measuring different things",
  );
});

test("a null floor is refused a number wherever it is drawn", () => {
  // THE DECISION SURVIVED ITS COMPONENT. `floor: null` means s3 has not derived
  // the bar yet, and rendering it as `/0` reads as a bar this dimension
  // cleared. That guard used to live on the dimension card, in the 证据 pane;
  // the pane was removed and the card with it, so this now holds the copy that
  // remains — the verified chip on the task board's dimension rows, which is
  // where a dimension's own arithmetic is read now.
  //
  // The sentence 门槛还没算出来 and the progress bar went with the card. Both
  // were the card's own prose; the chip states the same refusal by dropping
  // the denominator instead of printing a zero for it.
  const board = code(body("function MissionTaskBoard("));
  assert.match(
    board,
    /tone: node\.counts\.floor === null \|\| node\.counts\.floor === undefined\s*\?\s*TONE\.neutral/,
    "a null floor is graded again. `?? 0` here draws a dimension green for having beaten nothing",
  );
  assert.match(
    board,
    /label: node\.counts\.floor === null \|\| node\.counts\.floor === undefined/,
    "the chip prints a denominator for a floor that has not been derived, which is `/0` in words",
  );
});


test("the rework counters are still drawn, and still only when they fired", () => {
  // THESE WERE ALSO ON THE DIMENSION CARD, per dimension. The card went with
  // the 证据 pane, and the per-dimension breakdown went with it — an honest
  // loss, recorded here rather than quietly absorbed. What survives is the
  // RUN-level set, which is where the same four numbers answer "did this run
  // fight itself", and that is the question they were mostly read for.
  const rework = code(body("function MissionRework("));
  for (const counter of ["stageRetries", "chapterRewrites", "underDeliveredChapters", "toolFailures"]) {
    assert.ok(rework.includes(counter), `the run lost its ${counter} counter as well, which the projector is still computing`);
  }
  assert.match(
    rework,
    /\.filter\(\(cell\) => cell\.n > 0\)/,
    "every counter is drawn, zeroes included, so a healthy run carries four chips saying nothing went wrong",
  );
});


test("the ladder that colours a meter has one copy", () => {
  assert.ok(SOURCE.includes("function missionLadderHue("), "the degrade ladder is inline again");
  // The six ceiling meters and the header's token tile have to agree, and the
  // way they stop agreeing is a second `0.9` typed at the second site.
  const meters = body("function MissionCostMeters(");
  assert.ok(meters.includes("missionLadderHue("), "MissionCostMeters has its own ladder ternary back");
  assert.ok(
    !/ratio >= \(ladder\.warn/.test(meters),
    "the old inline ternary survived beside the shared one, which is two answers waiting to diverge",
  );
  assert.ok(
    code(DETAIL).includes("missionLadderHue("),
    "the header's token tile picks its own thresholds rather than the ones the runtime actually degrades on",
  );
});


// ── B12: long text, live numbers and the fields nobody read ────────────────
//
// Same rule as everything above: mutation-tested against a broken copy before
// it was kept. Two of these were rewritten after a mutation walked past them.

test("linkify is a primitive now, and not a video-description local", () => {
  const quarantine = SOURCE.indexOf("//#region video description structure");
  assert.ok(
    SOURCE.indexOf("function linkify(") < quarantine,
    "linkify is back inside the video-description region, where it had two call sites in one component and every mission sentence with a URL in it printed the URL as dead text",
  );
  assert.ok(
    SOURCE.indexOf("const BARE_URL") < quarantine,
    "the pattern stayed behind when its only reader moved: a function that reads a const declared 2,000 lines later in another region is one reorder from a ReferenceError at load",
  );
  // NOT A CALL COUNT, and the batch spec's `linkify( >= 8` is the reason to
  // say so. That figure assumed each prose site would call linkify itself;
  // every one of them goes through MissionClamp, which calls it ONCE. A count
  // would score the copied version higher than the shared one — the same
  // correction B8 made for roleTone and B9 for pillStyle.
  assert.ok(
    code(body("function MissionClamp(")).includes("linkify("),
    "MissionClamp prints its text raw, so an address an agent wrote inside a sentence is not a link on any mission screen",
  );
  assert.ok(
    code(body("function MissionGoals(")).includes("linkify("),
    "the Leader's own goals print their URLs as dead text",
  );
});

test("mission prose is clamped with a way out, not clipped to one line", () => {
  assert.ok(SOURCE.includes("function MissionClamp("), "the clamp primitive is gone; what it replaced was a nowrap ellipsis on half the mission prose and no cap at all on the other half");
  // PER SITE, NOT AS A TOTAL — and this one WAS a total until a mutation
  // walked past it: seven mounts against a floor of six means any one of them
  // can be deleted and the count still passes, which is the same headroom that
  // let a whole table lose its header cells in B10.
  const PROSE = [
    "function MissionTried(",
    "function MissionEvidenceRow(",
    "function MissionDegradeNote(",
    "function MissionGoals(",
  ];
  for (const site of PROSE) {
    assert.ok(
      code(body(site)).includes("jsx(MissionClamp, {"),
      `${site} prints an agent's sentence with no cap and no way to expand it — either uncapped, so one refusal pushes the pane off the screen, or clipped to a line with the rest behind a native tooltip`,
    );
  }
  const clamp = code(body("function MissionClamp("));
  // THE UNMEASURED BRANCH, which is the one that decides whether text can go
  // missing. `null` means nothing has laid out yet — no DOM, a hidden
  // ancestor, a first paint — and it must not be read as "it fits": that
  // reading clamps the text and drops the control that reaches the rest.
  assert.match(
    clamp,
    /overflows === false \? null :/,
    "an unmeasured box hides its toggle, so text that has never been laid out is text with no way to reach it",
  );
  assert.match(
    clamp,
    /if \(open\) return;/,
    "an expanded box measures itself, finds scrollHeight === clientHeight, decides it fits and drops the toggle — leaving no way back",
  );
  // The finding row's two clauses used to be checked here. It was the 证据
  // pane's leaf and went with the pane; a finding's claim and quote are read in
  // the trajectory's detail panel and under the report's own citations now,
  // both of which are unclamped reading surfaces rather than two-line rows.

});

test("one token quantity has one shape on every screen", () => {
  const locale = [...SOURCE.matchAll(/toLocaleString/g)].length;
  assert.equal(
    locale,
    1,
    "a token count is back to `12,431` in one panel and `12k` in the panel below it",
  );
  assert.match(SOURCE, /viewCount\.toLocaleString/, "the one surviving toLocaleString is meant to be the explore tab's view count");
  const roster = code(body("function MissionAgentTable("));
  // BOTH ROWS, counted. The body cells and the totals row are two separate
  // maps over the same columns, so an assertion that only asks whether the
  // string exists anywhere in the table passes with either one of them
  // reverted — a mutation proved exactly that before this was a count.
  assert.equal(
    [...roster.matchAll(/column\.id === "tokens" \? missionCompact\(/g)].length,
    2,
    "the roster's body cells and its totals row disagree about how a token count is drawn: one shortens and the other does not, in the same column",
  );
  assert.equal(
    [...roster.matchAll(/title: String\(/g)].length,
    2,
    "a shortened cell keeps no exact figure on its hover, so the precision is not lost from the screen but from the machine",
  );
  assert.ok(
    code(body("function MissionListRow(")).includes("missionCompact(mission.spend?.tokens ?? 0)"),
    "the list row and the detail header disagree about the same run's tokens again",
  );
});

test("the shortener stops jumping two units across two tokens", () => {
  const compact = code(body("function missionCompact("));
  assert.ok(
    !compact.includes("Math.round(n / 1000)"),
    "1,499 is `1k` and 1,501 is `2k` again — a two-unit jump across two tokens, in the figure people compare two runs with",
  );
  assert.match(compact, /toFixed\(1\)/, "the rounding fix is one character from being undone and this is the character");
  // AND THE TRAILING ZERO STAYS OFF. `412.0k` is a decimal place of precision
  // on a figure whose last three digits are noise, in a slot that exists
  // because the exact number did not fit; settings.test.mjs holds the value.
  assert.match(compact, /endsWith\("\.0"\)/, "412,000 renders as 412.0k");
});

test("a trajectory says how far into the run, not only what time it was", () => {
  assert.ok(SOURCE.includes("function missionSince("), "the offset formatter is gone and every timestamp on the mission screen is absolute wall-clock again");
  // MINUS THE DECLARATION, which the raw count includes: a guard that passes
  // on a function nobody calls is the shape of guard this file keeps catching.
  const calls = [...SOURCE.matchAll(/missionSince\(/g)].length - 1;
  assert.ok(calls >= 4, `missionSince has ${calls} callers; the trajectory row, the event stream, the row drawer and the stage drawer are four`);
  const since = code(body("function missionSince("));
  assert.match(
    since,
    /if \(ms < 0\) return "";/,
    "a row recorded before the anchor prints `-3s into the run`, which presents a wrong anchor as a measurement",
  );
  // The slot has to hold two lines now, and the line-height has to come after
  // the `font` shorthand that would reset it.
  const clock = /\.swt-clock\{([^}]+)\}/.exec(TRACE_RULES);
  assert.ok(clock, ".swt-clock lost its rule, so the two-line slot is whatever flex gives it");
  assert.ok(clock[1].includes("width:64px"), "the clock slot is 58px again, which clips `+11m 4s`");
  assert.ok(clock[1].includes("flex-direction:column"), "the offset and the wall clock are side by side in a 64px slot");
  assert.ok(
    clock[1].indexOf("line-height:") > clock[1].indexOf("font:"),
    "the line-height is written above the `font` shorthand, which sets one of its own — so it is discarded and the two lines sit 32px apart in a 38px row",
  );
});

test("a citation marker can be looked at without leaving the sentence", () => {
  assert.ok(SOURCE.includes("function MissionCitationPeek("), "the citation marker is a bare button again, whose only affordance is a jump that loses the reader's place");
  const peek = code(body("function MissionCitationPeek("));
  assert.match(
    peek,
    /setOpen\(false\); \}, 150\)/,
    "the card closes on the first mouseleave, so the gap between the number and the card six pixels above it makes the card unreachable by the only input that opens it",
  );
  assert.ok(peek.includes("onFocus"), "the preview opens for a pointer only, which is half the people reading a report");
  assert.ok(peek.includes("title: zh ?"), "the native tooltip fallback went with the rewrite, so a reader with no hover lost what they had");
  assert.ok(
    peek.includes("if (source === null || source === undefined) return mark;"),
    "a marker with no reference behind it opens an empty floating box, which is worse than the plain marker it replaced",
  );
  // The UNKNOWN branch is deliberately untouched: its grey says the source did
  // not survive, and a hover card is exactly what it must not offer.
  const mark = code(body("function missionCitationMark("));
  assert.ok(mark.includes("INK.quiet"), "the unknown-citation branch lost its grey treatment, so a hole in the record looks like a working link");
  const REPORT = SOURCE.slice(SOURCE.indexOf("//#region missions report"));
  assert.match(code(REPORT), /peek: \(index\) =>/, "the report stopped handing the markers a way to look, so every card is empty");
});

test("the stage drawer shows what the step did, not only what it is", () => {
  const drawer = code(body("function MissionStageDetail("));
  // IN VALUE POSITION. `drawer.includes("stage.calls")` passed with the chip
  // switched off at its own condition — the field survived in a branch that
  // never renders, which is indistinguishable from not reading it at all.
  assert.ok(
    drawer.includes("count: String(stage.calls)"),
    "`calls` is attached to every stage by the projector and reaches no pixel again: the drawer says a step took four minutes and not that it took eleven model calls to do it",
  );
  assert.ok(
    drawer.includes("jsx(MissionTraceRow, {"),
    "the drawer draws its own row shape, which is a second renderer for a row the trajectory pane already renders — they drift the moment one gains a field",
  );
  assert.match(
    drawer,
    /query\.set\("stepId", stage\.stepId\)/,
    "the drawer asks for the whole trajectory and filters nothing, on a route that has accepted stepId since it was written",
  );
  assert.ok(
    !drawer.includes('line(zh ? "令牌"'),
    "the tokens row is back in the property list beside the tokens chip: the same figure twice in one panel is the reader checking whether they are the same figure",
  );
});

test("rework is five counters, and a clean run says so", () => {
  assert.ok(SOURCE.includes("function MissionRework("), "the rework counters are a dot-joined grey sentence again");
  const rework = code(body("function MissionRework("));
  assert.match(
    rework,
    /id: "toolCached", n: n\("toolCached"\), tone: TONE\.success/,
    "a cache hit is listed beside four failures again, so a run that avoided forty fetches reads as a run that went wrong forty times",
  );
  assert.match(
    rework,
    /cells\.length === 0/,
    "a mission with no rework renders nothing at all, which on screen is the same blank space as a mission whose waste data never arrived",
  );
  assert.ok(rework.includes("MissionStatTiles("), "the counters got a grid of their own rather than the one every other figure block on this screen uses");
  const meters = code(body("function MissionCostMeters("));
  assert.ok(
    !meters.includes("wasted"),
    "the joined waste sentence survived beside the grid, so the same five figures are on the cost pane twice",
  );
});

test("the sign-off is a verdict, not the third grey sentence in a row", () => {
  assert.ok(SOURCE.includes("function MissionSignoffCard("), "sign-off is a 13px sentence between the failure note and the no-artefact note again, at the weight of the least consequential line on the screen");
  const card = code(body("function MissionSignoffCard("));
  assert.match(card, /mission\.signed === false \? TONE\.danger/, "a refusal is drawn in the score's colour, so a refusal at 84 is green");
  assert.ok(
    !card.includes("?? 0"),
    "a run nobody graded is handed a 0 it never got — the same defect as the `/0` the verified chip refuses",
  );
  // THE THREE-WAY GUARD STAYS AT THE MOUNT. `signed: null` means s11 never ran,
  // and a stage that never ran must not be drawn a verdict card.
  assert.match(
    code(DETAIL),
    /mission\.signed === null \|\| mission\.signed === undefined \? null : jsx\(MissionSignoffCard/,
    "an unsigned report and a refused one are drawn as the same card, and they are different failures with different next actions",
  );
});

test("the Leader's brief is finally read, and read whole", () => {
  assert.ok(SOURCE.includes("function MissionGoals("), "mission.goals is projected onto every mission and read by nothing again");
  assert.match(code(DETAIL), /goals: mission\.goals/, "the goals block exists and is mounted nowhere, which is the same as not existing");
  const goals = code(body("function MissionGoals("));
  assert.ok(
    goals.includes("Object.entries(goals)"),
    "the goals block names the keys it expects; the shape is parseJson(row.goals, null) — the Leader's, not this file's — so a key added tomorrow would be dropped in silence",
  );
  // IN THE BRANCH THAT RENDERS, not merely present somewhere in the function.
  // The filter above tests the same expression to drop empty arrays, so
  // `includes("Array.isArray(value)")` passed with the list branch deleted —
  // and `String(["a","b"])` is `a,b`, which reads as one goal with a comma in
  // it rather than as two goals. The render test misses this for the same
  // reason: the words are all still on the screen.
  assert.match(
    goals,
    /Array\.isArray\(value\)\s*\n\s*\? jsx\("ul"/,
    "an array of goals renders as `a,b,c` on one line instead of as a list",
  );
});


// ── B13: sources, references and the report's scorecard ────────────────────
//
// ONE DISEASE AT FIVE SITES, and it is this file's signature. Every
// differentiating signal about a page the mission read — its host, how much it
// carried, how much of that held up, which dimension it fed, when it was first
// seen — was `.join(" · ")`-ed into a single 11px grey line in which nothing
// outranks anything, under a bare `<a>` with no card and no affordance. The
// report's scorecard had the same shape one altitude up: three neutral
// outlined chips, each carrying a four-number sentence, ungraded and in
// declaration order.
//
// Every guard below was mutation-tested against a deliberately broken copy of
// lib/client.js before it was kept.

test("a source is a card with a name, not an address on a line", () => {
  assert.ok(
    SOURCE.includes("function SourceLink("),
    "the source card is gone, and three components are back to a bare anchor over a dot-joined grey line",
  );
  assert.ok(
    SOURCE.includes("function sourceTitleOf("),
    "the title fallback is gone, so a page whose <title> the fetcher could not read is listed as its own URL — a column where every row starts with the same eight characters and the part that differs is off the right edge",
  );
  // PER SITE, NOT AS A TOTAL. A file-wide `SourceLink({ >= 2` passes with one
  // component still drawing its own row and another calling it twice, which is
  // the headroom that let a whole table lose its header cells one batch ago.
  for (const site of ["function MissionSources(", "function MissionReferenceList("]) {
    assert.ok(body(site).includes("SourceLink({"), `${site} draws its own source row again`);
  }
  // FOUR STEPS, and the third is the one that is easy to drop: without the
  // decoded path segment a titleless page on a site with twenty of them is
  // indistinguishable from the other nineteen.
  const fallback = code(body("function sourceTitleOf("));
  for (const [step, why] of [
    ["String(title", "the stored title is no longer the first choice, so a page that named itself is named by us instead"],
    ["String(snippet", "the snippet's first sentence is gone from the ladder"],
    ["new URL(address).pathname", "the decoded path segment is gone, so every titleless page on one host is named the same thing"],
    ["hostOf(address)", "the hostname is gone from the bottom of the ladder"],
  ]) {
    assert.ok(fallback.includes(step), why);
  }
  // AN ANCHOR WITH NO href IS NOT FOCUSABLE and announces as plain text, so a
  // citation whose address did not survive would look pressable and answer
  // nothing. The card still renders: the finding it carried is real.
  const link = code(body("function SourceLink("));
  assert.match(link, /jsxs\(openable \? "a" : "div"/, "a source with no address is drawn as a dead anchor");
  assert.ok(
    link.includes("clampBox(2)"),
    "the card's title is unclamped, so one page with a 300-character <title> sets the height of every row under it",
  );
  assert.ok(
    link.includes("missionHue(MISSION_VERIFY_FACES"),
    "the verdict is back to being a word in the meta line, in the same ink as the timestamp beside it — on the one screen where 已核验 and 查无此文 differing is the whole point",
  );
});

test("the source card's hover is a rule, because a style object cannot hold one", () => {
  // AGAINST SWM_RULES, NOT SWM_CSS, against what the batch spec asked for.
  // SWM_CSS's entries sit INSIDE `body{ … }` — a rule written there would be
  // nested inside a declaration block and dropped on the floor. The two are
  // concatenated and injected together, so the effect is what was asked; the
  // guard names the half that can actually hold a selector.
  assert.ok(
    SOURCE.includes("const SWM_SHEET = SWM_CSS + SWM_RULES"),
    "the two halves of the sheet are no longer injected together, so a rule appended to SWM_RULES reaches no element",
  );
  // MATCHED ON THE DECLARATION, not on the selector. `.swm-source:hover` also
  // opens the title-underline rule two lines down, so `includes(":hover")`
  // passed with the rule that actually moves the box deleted — the card sat
  // inert under the pointer and the guard said it did not.
  assert.match(
    SHEET_RULES,
    // Bounded by the backtick rather than by `}`: the rule interpolates
    // ${LINE.rule} and ${SURFACE.hover}, so a `[^}]*` span stops dead inside
    // the first token name.
    /\.swm-source:hover\{border-color:[^`]*background:/,
    "the source card no longer answers the pointer, which makes it a paragraph with a border round it",
  );
  assert.ok(
    SHEET_RULES.includes(".swm-source:hover .swm-source-title"),
    "the title stopped underlining on hover; the card carries no link colour, so that underline is the only thing that says the box opens something",
  );
  assert.ok(code(SOURCE).includes('className: openable ? "swm-source'), "the class is on the sheet and on no element");
  // AND THE CARD MUST NOT PAINT ITS OWN EDGE OR GROUND. It did — `border: 1px
  // solid ${LINE.hair}` and `background: SURFACE.card` in the style object —
  // and an inline declaration beats a stylesheet whatever the selector, so
  // BOTH declarations of the hover rule above were overridden and the card sat
  // inert under the pointer. Every assertion above passed the whole time: the
  // rule existed, on the right sheet, on the right element, and dead. The
  // resting pair is on `.swm-source` now, which the hover can outrank.
  const style = code(body("function SourceLink("));
  assert.ok(!style.includes("border: "), "SourceLink writes its own border, which switches the border-color half of .swm-source:hover off");
  assert.ok(!style.includes("background: "), "SourceLink writes its own background, which switches the surface half of .swm-source:hover off");
  const rule = SHEET_RULES.slice(SHEET_RULES.indexOf(".swm-source{"), SHEET_RULES.indexOf("`,", SHEET_RULES.indexOf(".swm-source{")));
  assert.ok(rule.includes("border:1px solid"), ".swm-source stopped carrying the card's edge, so the card has none until it is hovered");
  assert.ok(rule.includes("background:${SURFACE.card}"), ".swm-source stopped carrying the card's ground, so it reads as a hole in the pane");
});

test("the five flattened signals stay unflattened", () => {
  // `" · "` IS THE SIGNATURE. Where it survives in this file it is joining two
  // or three things that genuinely read as one clause; where this batch found
  // it, it was joining five signals of five different weights.
  for (const site of [
    "function MissionSources(",
    "function MissionReferenceList(",
    "function MissionEvidenceRow(",
  ]) {
    assert.equal(
      body(site).split('.join(" · ")').length - 1,
      0,
      `${site} joined its signals back into one grey line`,
    );
  }
  // A RATCHET, seeded the day this batch landed. The only legal direction is
  // down; lower it in the commit that removes one.
  assert.ok(
    SOURCE.split('.join(" · ")').length - 1 <= 15,
    "a new dot-joined clause appeared. Five signals at one weight in one grey is how this file says 'nobody decided which of these matters'",
  );
});

test("one verification ladder, named once and read three times", () => {
  for (const rung of ["MISSION_RATE_GOOD", "MISSION_RATE_FAIR"]) {
    assert.match(new RegExp(`const ${rung} = 0\\.\\d`).exec(SOURCE)?.[0] ?? "", /0\.\d/, `${rung} is gone, so the 0.8/0.5 ladder is typed at the sites again`);
  }
  // COUNTED AS CALLS, NOT AS COPIES OF THE NUMBER. Asserting the constants
  // appear three times would score the WORSE design higher — three sites each
  // re-typing `>= MISSION_RATE_GOOD ? … : >= MISSION_RATE_FAIR ? …` is exactly
  // the three copies the names were extracted to remove. The rungs are read in
  // one place; what must have three readers is the function.
  assert.equal(
    code(SOURCE).split("MISSION_RATE_GOOD").length - 1,
    2,
    "a second reader of the rungs appeared. The ladder is a function; a site that re-implements it from the constants is the copy nobody edits",
  );
  const ladder = code(body("function missionRateHue("));
  assert.ok(ladder.includes("MISSION_RATE_GOOD") && ladder.includes("MISSION_RATE_FAIR"), "the ladder no longer reads its own rungs");
  for (const site of ["function MissionSources(", "function MissionReferenceList(", "function MissionReport("]) {
    assert.ok(code(body(site)).includes("missionRateHue("), `${site} grades its own ratio again, which is the third copy of one decision`);
  }
  // NOT GREEN AT NOUGHT, and the `/0` lives in the function so that all three
  // readers get it rather than two of them remembering.
  assert.match(
    ladder,
    /if \(rate === null\) return TONE\.neutral/,
    "a population nobody checked is graded green: `verified >= total` is true at zero, which is the clean bill this whole scorecard exists to refuse",
  );
  // AND IT IS NOT THE SPEND LADDER. `missionLadderHue` grades a ratio where
  // MORE IS WORSE — tokens against a ceiling — so reading it here would paint
  // a fully verified section red.
  assert.ok(
    !ladder.includes("missionLadderHue"),
    "the verification rate is graded on the spend ladder, which runs the other way: a fully verified section would be drawn red",
  );
});

test("the scorecard is graded, ordered, and quiet about its zeros", () => {
  const report = code(body("function MissionReport("));
  // GRADED, wherever it is drawn. This pinned the component name, which is a
  // mechanism rather than the promise. The promise is that a ratio on this page
  // is coloured by what the ratio SAYS rather than drawn in the same grey either
  // way. The report draws it as a line now, not as three bordered, tinted,
  // metered boxes, because three equal boxes open a document as an instrument
  // panel. The grading has to survive that, so the grading is what is asserted.
  assert.match(
    report,
    /tone: missionRateHue\(verified, total\)/,
    "the per-section figures are no longer graded by their own ratio, so a section that verified 3 of 40 looks like one that verified 40 of 40",
  );
  assert.match(
    report,
    /tone: missionRateHue\(allVerified, quality\.total\)/,
    "the whole-report figure is no longer graded by its own ratio",
  );
  assert.ok(
    report.includes("MissionScoreLine({ tiles: scored"),
    "the report draws its scorecard with nothing at all: scored is built and read by no one",
  );
  // IN VALUE POSITION. `report.includes("rank")` passed with the sort deleted,
  // because the field survives on the object either way.
  assert.match(
    report,
    /\.sort\(\(a, b\) => a\.rank - b\.rank\)/,
    "the section types are back in declaration order, so the weakest one is first on some runs and last on others for no reason a reader can use",
  );
  assert.match(
    report,
    /\.filter\(\(\[count\]\) => count > 0\)/,
    "a section where everything held up prints 未通过 0，未检查 0，被反驳 0 again — three zeros that read, at a glance, as three problems",
  );
  assert.ok(
    report.includes('label: zh ? "已核验引用" : "Citations verified"'),
    "the whole-report total is gone; `quality.total` is projected and read by nothing",
  );
  // It is the HEADLINE now, beside the title where the reference puts its one
  // number, and lifted out of the line below so the same figure is not printed
  // twice in one header.
  assert.ok(
    report.includes("scored.filter((tile) => tile !== headline)"),
    "the headline figure is printed twice in one header: once beside the title and again in the line under it",
  );
});

test("the empty scorecard still refuses to look like a clean bill", () => {
  // THE ONE PART OF THIS BLOCK THAT ALREADY READ CORRECTLY, kept verbatim. It
  // is a sentence and not a tile on purpose: "not one citation was checked" is
  // not a low score, it is the absence of a score, and a 0/0 tile sitting in a
  // row of graded ones is the most flattering thing this screen could draw.
  assert.equal(
    SOURCE.split("这不是“没有发现问题”，这是没有检查过。").length - 1,
    1,
    "the empty-scorecard sentence was duplicated or deleted; it is the branch that keeps an unchecked report from reading as a clean one",
  );
  assert.match(
    code(body("function MissionReport(")),
    /Number\(quality\.total \?\? 0\) === 0\s*\n\s*\? jsx\("div"/,
    "the empty-scorecard branch no longer guards the grid, so a report with nothing checked renders a row of 0/0 tiles",
  );
});

test("the sources pane offers four arrangements and compares its hosts", () => {
  const at = SOURCE.indexOf("const MISSION_SOURCE_ORDERS = [");
  assert.notEqual(at, -1, "the arrangements are back to a two-state toggle whose off position has no name");
  const orders = SOURCE.slice(at, SOURCE.indexOf("];", at));
  for (const id of ["cites", "host", "rate", "seen"]) {
    assert.ok(orders.includes(`id: "${id}"`), `the sources pane cannot be arranged by ${id}, though every field it needs is already on the row`);
  }
  const pane = code(body("function MissionSources("));
  assert.ok(
    pane.includes("style: segmentStyle(") && pane.includes("style: SEGMENT_TRACK"),
    "the four arrangements are four loose buttons, or a second segmented track built beside the one the file already has",
  );
  assert.ok(
    !pane.includes("setByHost"),
    "the two-state grouping toggle is back. Its label was always the arrangement you were NOT looking at, which is the one control shape that cannot be read without pressing it",
  );
  // IN VALUE POSITION. `pane.includes("Meter({")` passed with the bar measured
  // against `totals.findings` instead, which makes every bar nearly empty and
  // answers a question the grouping was not asked.
  assert.match(
    pane,
    /max: grouped\[0\]\.findings/,
    "the host share bar measures against something other than the biggest host, so the comparison the grouping exists to answer — is one site holding the whole report up — is gone again",
  );
});

test("the reference list opens with what it already knew about itself", () => {
  const list = code(body("function MissionReferenceList("));
  assert.ok(
    list.includes("MissionStatTiles({"),
    "the bibliography opens straight onto row [1] again, so 'how much of what this report cites was actually checked' can only be answered by counting chips down the column",
  );
  // IN VALUE POSITION for the same reason as the bar above: the four counts
  // are all computed from `references`, so their expressions survive a tile
  // being deleted.
  for (const [expr, why] of [
    ['label: zh ? "引用" : "References"', "the reference count has no tile"],
    ['label: zh ? "已核验" : "Verified"', "the verified count has no tile, on the pane where it is the only figure that matters"],
    ['label: zh ? "有引语" : "Quoted"', "how many citations carry a quote is computed and shown nowhere"],
  ]) {
    assert.ok(list.includes(expr), why);
  }
  assert.match(
    list,
    /missing === 0 \? null : \{/,
    "a clean bibliography prints 元数据缺失 0 — the same defect one size up as the chip that printed three zeros on a clean section",
  );
  assert.ok(
    list.includes("meter: missionRate(verified, references.length)"),
    "the verified tile lost its bar, so the share it reports has to be divided by eye from the two figures beside it",
  );
});

// ── page chrome: the header, three tab strips, two segmented controls ──────
//
// B14's whole subject is that ONE widget was built three ways. The assertions
// below hold the shared names rather than the pixels: a test cannot see that
// three strips read as one vocabulary, but it can see that they stopped
// carrying three of everything.

test("a format's colour is the format's, not its position in a list", () => {
  const block = declaration("const FORMAT_TONE = {");
  const assigned = [...block.matchAll(/(\w+):\s*(PALETTE\.\w+)/g)].map((match) => [match[1], match[2]]);
  for (const format of ["podcast", "digest", "report", "brief"]) {
    assert.ok(
      assigned.some(([name]) => name === format),
      `${format} has no colour of its own, so it falls back to the product accent and looks like a format nobody has named`,
    );
  }
  for (const [name, hue] of assigned) {
    assert.match(hue, /^PALETTE\.\w+$/, `FORMAT_TONE.${name} is ${hue}. A colour chosen outside the ramp cannot be re-themed`);
  }
  const hues = assigned.map(([, hue]) => hue);
  assert.equal(new Set(hues).size, hues.length, "two formats share a hue, which makes the switcher a colour that means two things");
  // AGAINST COMMENT-STRIPPED SOURCE. The docblock over FORMAT_TONE quotes the
  // expression it replaced, in order to say why — and a prose mention is not a
  // colour. Searching the raw file fails against a correct one.
  assert.equal(
    code(SOURCE).split("KINDS[(at + 1) % KINDS.length]").length - 1,
    0,
    "the publish switcher is picking a format's accent by rotating through the SOURCE-KIND ramp again, so a format's identity is decided by the order the Host lists it in and every colour shifts when a format is added",
  );
  assert.ok(
    declaration("function formatTone(").includes("TONE.accent"),
    "an unlisted format has no fallback, or falls back into the ramp — it should look unlisted, not like one of the four",
  );
});

test("three tab strips, one tab vocabulary", () => {
  // THE RULES HAD TO CHANGE SHEETS for this to be true rather than cosmetic.
  // TRACE_CSS is injected when the trajectory pane opens; SWM_RULES is injected
  // by the page before first paint. A strip wearing a class from the first
  // sheet is an unstyled row of buttons until somebody clicks 轨迹.
  for (const rule of [
    ".swm-tab{",
    ".swm-tab:hover{",
    '.swm-tab[aria-selected="true"]::after{',
    ".swm-tab:focus-visible{",
  ]) {
    assert.ok(SHEET_RULES.includes(rule), `${rule} is not on the sheet the page injects, so at least one of the three strips is unpainted where it renders`);
    assert.ok(!TRACE_RULES.includes(rule), `${rule} is back on the trajectory sheet, which only mounts when the trace pane opens`);
  }
  assert.equal(
    [...code(SOURCE).matchAll(/\.swt-tab(?![s-])/g)].length,
    0,
    "`.swt-tab` is back. It is the same underline as `.swm-tab` on a sheet two of the three strips cannot reach, which is how this product got three tab treatments in the first place",
  );
  assert.equal(
    code(SOURCE).split('className: "swm-tab"').length - 1,
    3,
    "the shared tab class is on some other number than three strips — the page bar, the mission detail strip and the trajectory drawer are all of them",
  );
});

test("every strip swaps the whole shorthand, so no label moves when it is pressed", () => {
  // A weight riding beside a size is the defect: two weights at one size have
  // different advances, so the label physically shifts away from the pointer as
  // its tab opens. Three strips did that at three sizes.
  // EACH SLICE IS THE STRIP, not the component around it. The mission detail
  // component also renders the run's spend beside its tabs, which is legitimately
  // `INK.quiet` and is not a tab — a component-wide slice fails against a
  // correct file on the assertion below.
  const clean = code(SOURCE);
  const between = (open, close) => {
    const at = clean.indexOf(open);
    assert.notEqual(at, -1, `${open} is gone from lib/client.js`);
    return clean.slice(at, clean.indexOf(close, at));
  };
  const strips = {
    "the page strip": body("function tabStyle("),
    "the mission detail strip": between('const strip = jsx("div", {', "}, entry.id);"),
    "the trajectory strip": between("MISSION_TRACE_TABS.map(", "}, entry.id))"),
  };
  for (const [name, slice] of Object.entries(strips)) {
    assert.ok(
      slice.includes("FONT.bodyStrong") && slice.includes("FONT.body"),
      `${name} does not swap FONT.body for FONT.bodyStrong. Either it marks its active tab with something other than the shared 13px pair, or it marks it with a weight at a size the other two do not use`,
    );
    assert.ok(
      !/fontWeight/.test(slice),
      `${name} sets a fontWeight beside its font shorthand. The shorthand already carries a weight, and swapping only the weight is what made the label move`,
    );
    assert.ok(
      !slice.includes("INK.quiet"),
      `${name} draws a tab label in INK.quiet. That is 3.71:1 — the decoration budget INK's own docblock sets aside for an ordinal or a unit — on the words a reader navigates the product by`,
    );
  }
});

test("the active tab is the accent, and the hover has somewhere to land", () => {
  const tab = body("function tabStyle(");
  assert.ok(
    tab.includes("state-business-primary"),
    "the active page tab is drawn in `label-primary` again — the colour of every other word on the page, so which tab you are on is carried by a weight and a hairline and nothing else",
  );
  // MATCHED ON THE DECLARATION, not on the selector: `.swm-tab:hover` also
  // appears in the comment above the rule, and would pass with the rule's body
  // emptied. Bounded by the closing backtick rather than by `}`, because the
  // rule interpolates `${SURFACE.hover}` and a `[^}]*` span stops dead inside
  // the token name — B13 was caught by exactly that.
  assert.match(
    SHEET_RULES,
    /\.swm-tab:hover\{background:\$\{SURFACE\.hover\}\}/,
    "the tab hover is gone or is no longer a background. It cannot be a colour: every strip sets its label colour inline, and an inline declaration beats a stylesheet",
  );
  // AND NOTHING MAY PAINT ITS OWN BACKGROUND, or the rule above is dead on
  // arrival with nothing to say so — the defect B10 found on `.swm-tr`, which
  // is why the UA reset lives on the class instead of at the call sites.
  // SCOPED TO THE RULE, not to the sheet: `.swm-iconbtn` also resets its
  // background, so a file-wide `includes` passed with `.swm-tab`'s own reset
  // deleted — an empty guard that also read as a claim.
  const tabRule = SHEET_RULES.slice(SHEET_RULES.indexOf(".swm-tab{"), SHEET_RULES.indexOf("`,", SHEET_RULES.indexOf(".swm-tab{")));
  assert.ok(
    tabRule.includes("background:transparent"),
    "the tab class stopped resetting the button's UA background, so every tab is a grey box the sheet then has to paint over",
  );
  for (const [name, slice] of [
    ["the page strip", tab],
    ["the mission detail strip", code(body("function MissionDetailTabs("))],
  ]) {
    assert.ok(
      !/background:/.test(slice),
      `${name} writes an inline background on its tabs. An inline declaration beats the sheet, so the hover rule is dead and nothing reports it`,
    );
  }
});

test("the tab bar scrolls rather than clipping its last tab", () => {
  const bar = declaration("const TABBAR_STYLE = {");
  assert.ok(bar.includes('overflowX: "auto"'), "the page tab bar can neither wrap nor scroll. Inset beside a wide sidebar the last tab is simply not there, and nothing on the page says a tab is missing");
  assert.ok(bar.includes('scrollbarWidth: "none"'), "the tab bar grew a scrollbar across the page chrome");
  assert.ok(bar.includes("minWidth: 0"), "without `minWidth: 0` a flex child refuses to shrink below its content and the overflow never engages");
  assert.ok(
    SHEET_RULES.includes(".swm-tabbar::-webkit-scrollbar{display:none}"),
    "the scrollbar is hidden in Firefox and drawn in every WebKit browser, which is a bar of chrome across the page header on most of them",
  );
  // The rule can only live on the half that may hold a selector: SWM_CSS's
  // entries sit INSIDE `body{ … }`, so a selector written there is nested in a
  // declaration block and dropped. Both halves ship together, which is what
  // makes that placement equivalent to the one the gap asked for.
  assert.ok(SOURCE.includes("const SWM_SHEET = SWM_CSS + SWM_RULES"), "the two halves of the sheet stopped shipping together, so the rules above are written and never injected");
  assert.equal(
    code(SOURCE).split('className: "swm-tabbar"').length - 1,
    3,
    "one of the three tablists that can overflow — the page bar, the mission detail strip, the reader's own — lost the class that hides its scrollbar",
  );
  // AND ALL THREE TAKE THE SCROLLER, not just the one the gap named. A hidden
  // scrollbar on a row that cannot scroll is a row that clips in silence, which
  // is strictly worse than the visible bar.
  assert.equal(
    code(SOURCE).split('overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none"').length - 1,
    3,
    "a tablist wears the class that hides its scrollbar without the properties that make it scroll, so it clips its last control and draws no bar to say so",
  );
});

test("the mission strip is a tablist, not six buttons held down", () => {
  // COMMENT-STRIPPED, because this component's own comment explains what it no
  // longer does using the words being searched for. The raw file fails here
  // against a CORRECT one — the same trap B10 and B12 both hit.
  const strip = code(body("function MissionDetailTabs("));
  assert.equal(
    strip.split("aria-pressed").length - 1,
    0,
    "`aria-pressed` is back on the pane tabs. On a bare button it announces a toggle that is held down rather than one of six pages, and it is not the attribute the shared underline matches",
  );
  assert.ok(strip.includes('role: "tablist"') && strip.includes('role: "tab"'), "the strip is six loose buttons again");
  assert.ok(strip.includes('"aria-selected": on'), "nothing on the strip says which pane is showing");
  assert.ok(
    !strip.includes("fill-tertiary") && !strip.includes('width: "fit-content"'),
    "the segmented pill track is back on the mission strip, one screen from two strips that underline",
  );
  assert.ok(
    strip.includes("style: COUNT_CHIP"),
    "the pane count went back to being a bare number beside a word, which reads as an artefact of the label rather than as the answer to how many",
  );
  assert.ok(
    !strip.includes('flexWrap: "wrap"'),
    "the strip row wraps again. A second line of tabs under the first reads as twelve panes; the strip is meant to scroll",
  );
});

test("the lede renders once, and on all five tabs", () => {
  const page = code(body("function SwarmPage("));
  // COUNTED, not merely present. The lede used to be rendered in the
  // PLACEHOLDER branch — the path only the two unbuilt tabs take — so the three
  // built tabs carried a written sentence that nothing on screen showed. A
  // second copy would put it back on two tabs and not on five.
  for (const field of ["active.ledeZh", "active.ledeEn"]) {
    assert.equal(
      code(SOURCE).split(field).length - 1,
      1,
      `${field} is read ${code(SOURCE).split(field).length - 1} times. Two reads is the lede back in the placeholder branch as well as in the header, which is the same sentence twice on the two tabs that have least to say`,
    );
  }
  assert.ok(page.includes("HERO_LEDE_STYLE"), "the header lost its subtitle, so the page opens with a product name and no statement of what the tab under it is for");
  assert.ok(!page.includes("style: LEDE_STYLE"), "the placeholder branch is rendering the lede again, under a header that is already showing it");
  const lede = declaration("const HERO_LEDE_STYLE = {");
  assert.ok(
    lede.includes('whiteSpace: "nowrap"') && lede.includes('textOverflow: "ellipsis"'),
    "the header subtitle can wrap. It sits on the chrome row, so a second line pushes the tab bar down as the window narrows and the page reads as reloading",
  );
  // `emptyEn`/`emptyZh` are placeholder-only ON PURPOSE — TABS records that at
  // the declaration — so the branch that reads them has to survive this move.
  assert.ok(page.includes("active.emptyZh"), "the unbuilt tabs stopped saying they are unbuilt, which is the one thing they have to say");
});

test("the page opens with a header rather than a label row", () => {
  const page = code(body("function SwarmPage("));
  // THE DECISION WAS THE TILE, NOT THE NUMBER. A bare 18px mark beside a 16px
  // word reads as a bullet in front of the label; a mark inside a tinted,
  // ringed tile reads as the product's mark at any size that fits the tile.
  // This used to assert `size: 22`, which pinned the wrong half — the band was
  // later compacted to one row and the literal failed while the decision held.
  const tile = /background: `rgba\(\$\{PALETTE\.violet\},\$\{TINT\.soft\}\)`[\s\S]{0,240}?jsx\(SwarmMark, \{ size: (\d+) \}\)/.exec(page);
  assert.ok(tile, "the mark lost its tile, so it is a glyph in front of a word again");
  assert.ok(Number(tile[1]) <= 22, "the mark outgrew its tile");
  assert.ok(page.includes("borderRadius: RADIUS.lg"), "the mark's tile lost its corner radius, so it is a square behind a glyph");
  const header = declaration("const HEADER_STYLE = {");
  assert.ok(
    !header.includes("font:"),
    "the header container sets a font again. It holds two text lines at two sizes now, and one inherited shorthand cannot serve both",
  );
  assert.ok(
    !header.includes("borderBottom"),
    "the header grew a hairline while the tab bar still has one. Two rules fourteen pixels apart read as a double border round an empty strip — and the tab bar's is load-bearing, it is the rail the active tab's underline sits on",
  );
});

test("there is one segmented control, and both strips are it", () => {
  assert.equal(SOURCE.split("const SEGMENT_TRACK").length - 1, 1, "a second segmented track is declared, which is how the file got two of them a pane apart in the first place");
  assert.equal(SOURCE.split("function segmentStyle(").length - 1, 1, "a second segment builder is declared");
  for (const [name, slice] of [
    ["the publish switcher", code(body("function PublishTab("))],
    ["the sources arrangement", code(body("function MissionSources("))],
  ]) {
    assert.ok(
      slice.includes("segmentStyle(") && slice.includes("SEGMENT_TRACK"),
      `${name} builds its own segmented strip again — its own surface, its own radius and its own shadow, one pane away from the other one`,
    );
  }
  // The publish switcher's per-format hue is spread AFTER the state, and that
  // ordering is the whole distinction: the raised surface says CHOSEN, the hue
  // says WHICH. Written before the spread, the state would overwrite it.
  assert.match(
    code(body("function PublishTab(")),
    /\.\.\.segmentStyle\(entry\.id === current\.id\),[\s\S]{0,40}color: entry\.id === current\.id \? `rgb\(\$\{entry\.accent\}\)`/,
    "the publish switcher's selected segment lost its format colour, or writes it before the state that would overwrite it",
  );
});

// ── the three screen states ────────────────────────────────────────────────
//
// "加载中…", "读不到这个任务" and "还没有跑过任何任务" were the SAME 140px
// dashed rectangle with one centred sentence in it. That is one vocabulary
// doing three jobs, and the two it confuses most are the two that call for
// opposite reactions: an emptiness you wait out, and a failure you go and look
// at the server about. None of it throws, and a screenshot of any one of them
// looks fine on its own — the defect is only visible when you know what the
// other two look like.

/** The 洞察 list region, which is where the grid and both list states live. */
const MISSIONS_LIST = SOURCE.slice(
  SOURCE.indexOf("//#region missions list\n"),
  SOURCE.indexOf("//#region missions detail panels"),
);

/** The 信源 feed's own tab, which has the other two. */
const EXPLORE = SOURCE.slice(
  SOURCE.indexOf("//#region explore tab\n"),
  SOURCE.indexOf("//#region missions model"),
);

/** The report pane, whose three absences used to be one sentence. */
const REPORT = SOURCE.slice(
  SOURCE.indexOf("//#region missions report\n"),
  SOURCE.indexOf("//#region publish tab"),
);

/**
 * How many times a name is CALLED, ignoring prose.
 *
 * Comments are stripped first because this batch's own docblocks explain what
 * the code no longer does using the exact names being counted — the trap B10
 * and B11 both hit — and the declaration is subtracted because a primitive
 * that exists and is never mounted is the thing these counts exist to catch.
 * @param name - the function's name.
 * @param text - source text to count in.
 * @returns the number of calls, not counting the declaration.
 */
function calls(name, text = SOURCE) {
  const stripped = code(text);
  const total = [...stripped.matchAll(new RegExp(`\\b${name}\\(`, "g"))].length;
  const declared = stripped.includes(`function ${name}(`) ? 1 : 0;
  return total - declared;
}

test("an emptiness, a failure and a wait are three different screens", () => {
  for (const name of ["EmptyBox", "ErrorBox", "Skeleton", "SkeletonScreen"]) {
    assert.ok(SOURCE.includes(`function ${name}(`), `${name} is gone; the one dashed box is what it replaced`);
  }
  // FOUR, not three: ErrorBox is composed OUT of EmptyBox rather than beside
  // it — same disc, same heading, same 42ch measure — so the count is the
  // three empty screens plus the primitive that reuses it. Counting only the
  // screens would score a second hand-built column exactly as highly.
  assert.ok(calls("EmptyBox") >= 4, `EmptyBox is mounted ${calls("EmptyBox")} times; the three empty screens and ErrorBox are what it is for`);
  assert.ok(calls("ErrorBox") >= 4, `ErrorBox is mounted ${calls("ErrorBox")} times; there are four screen-level load failures in this file`);
  assert.ok(calls("Skeleton") >= 4, `Skeleton is drawn ${calls("Skeleton")} times, which is not enough to be a screen`);
  // Every skeleton is wrapped, because a pile of grey divs announces NOTHING:
  // the sentence it replaced was the only thing a screen reader ever got out
  // of this state, and losing it is a regression the page cannot show.
  assert.ok(calls("SkeletonScreen") >= 4, "a skeleton is drawn outside the box that carries its accessible name");
  assert.match(
    // `declaration()` cannot read a FUNCTION — it brace-matches from the first
    // `{`, which for a function is its destructured parameter list. B8 hit
    // that and wrote it down; `body()` anchors on the module's own indent.
    body("function SkeletonScreen("),
    /role: "status"[\s\S]{0,120}"aria-label": zh \? "加载中…"/,
    "the skeleton screen lost the word it is standing in for; to a screen reader it is now nothing at all",
  );
});

test("the dashed box retreated from the screens and kept the inline notes", () => {
  // A RATCHET, measured after B15. NOTE_STYLE is not being deleted — a
  // one-line status inside a panel that is already built is a genuinely inline
  // note and must not grow a 260px box under it. What it may no longer be is
  // the answer to "what is a whole screen doing".
  const uses = SOURCE.split("NOTE_STYLE").length - 1;
  assert.ok(uses <= 12, `NOTE_STYLE has ${uses} references, up from 12. A screen state drawn as the inline-note box is the vocabulary collapse this batch undid`);
  // The four screen-level waits, by the region each is in. A NOTE_STYLE with
  // the word 加载中 anywhere near it is one of them coming back.
  for (const [where, slice] of [["the 信源 feed", EXPLORE], ["the mission list", MISSIONS_LIST], ["the mission detail", body("function MissionDetail(")], ["the report", REPORT]]) {
    assert.ok(
      !/NOTE_STYLE[^}]{0,200}加载中/.test(code(slice)),
      `${where} draws its screen-level wait as the dashed inline-note box again`,
    );
  }
});

test("a screen-level failure offers to try again, and names the door", () => {
  // `grep onRetry` hit NOTHING on any of these branches before this batch: the
  // only way to re-issue a failed read was to leave the tab and come back, and
  // on the mission detail the ONLY control on the screen was the one that
  // leaves it.
  const passed = [...code(SOURCE).matchAll(/onRetry: /g)].length;
  assert.ok(passed >= 4, `onRetry is passed at ${passed} sites; there are four screen-level load failures`);
  for (const [where, slice] of [
    ["the 信源 feed", EXPLORE],
    ["the mission list", MISSIONS_LIST],
    ["the mission detail", body("function MissionDetail(")],
    ["the report", REPORT],
  ]) {
    const failure = code(slice);
    assert.ok(failure.includes("ErrorBox("), `${where} draws its load failure by hand again`);
    assert.match(failure, /onRetry: \(\) => \{/, `${where}'s failure screen has no retry, so the read can only be re-issued by leaving the screen`);
    assert.match(failure, /endpoint: /, `${where}'s failure screen dropped the endpoint, which is the line that separates "the server said no" from "this build points at a host that is not there"`);
  }
  // The mission list's retry is the SAME tick the toolbar's 刷新 nudges. A
  // second way to re-read the list, written a few lines from the first, is two
  // definitions of one action waiting to disagree.
  assert.match(
    code(MISSIONS_LIST),
    /onRetry: \(\) => \{ setTick\(\(value\) => value \+ 1\); \}/,
    "the list's retry no longer goes through the tick its own refresh button uses",
  );

  // AND SOMETHING READS THE COUNTER IT NUDGES. This is the half a guard can
  // most easily fake: `onRetry: () => { setTick(…) }` looks wired from any
  // distance, and if no effect lists `tick` among its dependencies the button
  // answers the press, re-renders nothing, and never re-issues the read. That
  // failure is invisible in a diff and total on the screen — the person
  // presses it again, and again. Only MissionsTab's is proved end to end, by
  // the render test in tests/settings.test.mjs; the other three are proved
  // here, at the seam where they would come unstuck.
  for (const owner of ["function ExploreTab(", "function MissionsTab(", "function MissionDetail(", "function MissionReport("]) {
    const component = code(body(owner));
    const nudged = /onRetry: \(\) => \{ set(\w+)\(/.exec(component);
    assert.ok(nudged, `${owner} has no retry to check`);
    const state = nudged[1][0].toLowerCase() + nudged[1].slice(1);
    const deps = [...component.matchAll(/\}, \[([^\]]*)\]\);/g)].map((match) => match[1]);
    assert.ok(
      deps.some((list) => list.split(",").some((name) => name.trim() === state)),
      `${owner}'s retry nudges \`${state}\` and no effect depends on it, so pressing it re-renders and re-reads nothing`,
    );
  }
});

test("the skeleton ships with its opt-out and reuses the one pulse", () => {
  // MATCHED ON THE DECLARATION, not on the selector. `.swm-skel{` also occurs
  // inside the reduced-motion rule two lines down, so `includes(".swm-skel{")`
  // passed with the rule that actually PAINTS the block deleted — a mutation
  // found that. Bounded by the backtick and not by `}`, because the rule
  // interpolates `${SURFACE.hover}` and a `[^}]*` span stops dead inside the
  // token name (B13's correction, one rule along).
  assert.match(
    SHEET_RULES,
    /`\.swm-skel\{[^`]*animation:swm-pulse/,
    "the skeleton rule is gone from the sheet the page mounts before first paint, or no longer animates",
  );
  assert.match(
    SHEET_RULES,
    /`\.swm-skel\{background:\$\{SURFACE\.\w+\}/,
    "the skeleton block picked its own grey. A placeholder painted outside the surface scale is the one box on the page that does not follow the theme",
  );
  assert.ok(!TRACE_RULES.includes(".swm-skel"), "the skeleton rule moved to the trajectory sheet, which mounts only when the trace pane opens");
  // ONE PULSE, not two. A live dot and a skeleton make the same statement, and
  // a second set of keyframes at a second rate is how a page ends up breathing
  // at two speeds.
  assert.equal(
    [...SHEET_RULES.matchAll(/@keyframes swm-pulse/g)].length,
    1,
    "a second pulse animation was declared beside the one that already existed",
  );
  const reduced = /@media \(prefers-reduced-motion:reduce\)\{([^}]*)\{animation:none\}/.exec(SHEET_RULES);
  assert.ok(reduced, "the reduced-motion rule is gone");
  assert.ok(
    reduced[1].includes(".swm-skel"),
    "the skeleton animates and the reduced-motion rule does not name it. Four blocks pulsing on every screen-level read is exactly what that setting is set for",
  );
});

test("the mission list is a grid, and its placeholder is laid out in the same one", () => {
  assert.equal(SOURCE.split("const MISSION_LIST_GRID").length - 1, 1, "a second grid definition is declared; two copies is how a list and its skeleton stop agreeing");
  assert.match(
    declaration("const MISSION_LIST_GRID = {"),
    /gridTemplateColumns: "repeat\(auto-fill, minmax\(340px, 1fr\)\)"/,
    "the list grid lost its minimum, or took auto-fit — with auto-fit a filter matching one mission draws one card as wide as the window, which is the column layout this replaced",
  );
  // Counted in VALUE position, because the name also appears in the docblock
  // that explains why it is shared, and a guard satisfied by its own comment
  // is a claim. Two readers: the list, and the skeleton screen above it.
  const read = [...code(MISSIONS_LIST).matchAll(/style: MISSION_LIST_GRID/g)].length;
  assert.ok(read >= 2, `MISSION_LIST_GRID is laid out at ${read} sites; the list and its loading placeholder are both meant to be one of them`);
  // The card's own margin is cancelled AT THE SITE. Stripping it from
  // CARD_STYLE would re-flow the 信源 feed, the starter and MissionPanel, none
  // of which this batch looked at.
  assert.match(declaration("const CARD_STYLE = {"), /marginBottom: SPACE\.lg/, "CARD_STYLE lost the margin its four consumers are laid out on");
  assert.match(
    code(MISSIONS_LIST),
    /\.\.\.\(hover \? CARD_HOVER_STYLE : CARD_STYLE\), marginBottom: 0, height: "100%"/,
    "the row in the grid kept the stacked column's bottom margin, so the space between two cards is a gap plus a margin",
  );
});

test("the list takes the frame rather than the prose measure", () => {
  const tab = code(body("function MissionsTab("));
  assert.ok(tab.includes("WIDE_STYLE"), "the mission list is capped at the 1080px measure again, so the grid stops at three columns with dead page beside it");
  assert.ok(!tab.includes("CONTENT_STYLE"), "the mission list still carries the prose cap the grid replaced");
  // Three readers now: the detail frame, the mission list, and the detail's
  // own loading screen — which was on CONTENT_STYLE while the view it becomes
  // was on WIDE_STYLE, so the whole page slid sideways at the moment the
  // answer landed, which is the one jump a skeleton exists to remove.
  const read = [...code(SOURCE).matchAll(/\.\.\.WIDE_STYLE/g)].length;
  assert.ok(read >= 3, `WIDE_STYLE is spread at ${read} sites; the detail frame, the list and the detail's skeleton are all meant to be one`);
  assert.ok(
    // COMMENT-STRIPPED. The branch's own comment explains that it USED to be
    // CONTENT_STYLE, so this failed against a correct file on its first run —
    // the trap B10 and B11 each left a note about.
    !/state === "loading" && view === null[\s\S]{0,400}CONTENT_STYLE/.test(code(SOURCE)),
    "the mission detail's skeleton is drawn at a different measure from the screen it becomes",
  );
});

test("the mission header is a band, and the meta line is inside it", () => {
  const bar = /jsxs\("div", \{\s*style: \{\s*display: "flex", alignItems: "center", gap: SPACE\.md, flexWrap: "wrap",[\s\S]*?\}, "bar"\)/.exec(body("function MissionDetail("));
  assert.ok(bar, "the mission detail's header row is not the band any more");
  assert.match(bar[0], /borderBottom: `1px solid \$\{LINE\.rule\}`/, "the header band lost the edge that says where the chrome stops");
  assert.match(bar[0], /background: SURFACE\.subtle/, "the header band is on the same surface as the pane under it, which is what made it invisible");
  // The negative margin is the escape from the frame's own 24px gutter that
  // the pane scroller further down this component already uses. A band inset
  // from both edges is a card, and this is not a card.
  // THE INVARIANT IS THAT THEY CANCEL, not that either is 24. This asserted the
  // literal, so trimming the frame's gutter to give the panes their width back
  // failed a test whose subject — a band that reaches both edges — was still
  // true. Read both numbers and check they annul.
  const gutter = /padding: "0 (\d+)px", height: "100%", minHeight: 0, flex: "1 1 auto"/.exec(SOURCE);
  assert.ok(gutter, "the mission detail frame's gutter is not where this test thinks it is");
  const escape = /margin: `0 -(\S+?) \$\{SPACE\.\w+\}`/.exec(bar[0]);
  assert.ok(escape, "the band no longer escapes the frame's gutter at all, so it is a card");
  const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
  const pulled = escape[1].startsWith("${")
    ? SPACE[escape[1].slice(escape[1].indexOf(".") + 1).replace("}", "")]
    : Number(escape[1].replace("px", ""));
  assert.equal(
    pulled,
    Number(gutter[1]),
    `the band pulls ${pulled}px out of a ${gutter[1]}px gutter, so it stops short of one edge or hangs past it`,
  );
  // THE META LINE IS A CHILD, not a sibling. It used to be rendered after the
  // header's closing brace — a second line of grey text under a bordered
  // strip, belonging to neither the header nor the pane.
  assert.match(bar[0], /style: META_STYLE, children: meta/, "the meta line is outside the band again");
  assert.match(bar[0], /roleTone\("leader"\)/, "the run lost its mark, so the band opens with a back button and a sentence");
});

test("an empty screen names its next step, and two empties are two steps", () => {
  const list = code(MISSIONS_LIST);
  // The chip's empty and the library's empty were already two sentences. What
  // neither had was an ACTION: the field that fixes the second one is on the
  // same screen four inches up, and the list said so and then left you to find
  // it yourself.
  assert.match(list, /topicRef\.current\?\.focus\?\.\(\)/, "the cold empty list no longer puts the cursor in the topic field it tells you to write in");
  assert.match(list, /setFilterId\(""\); \}/, "the filtered empty list no longer offers to clear the filter it is empty because of");
  assert.match(code(SOURCE), /function MissionStarter\(\{ zh, onStarted, topicRef \}\)/, "the starter stopped taking the ref, so the call to action has nothing to focus");
  assert.match(code(SOURCE), /ref: topicRef/, "the ref is threaded to the starter and never attached to the field");
  // Three absences, three marks. Drawn identically — which is what the one
  // dashed box did — a report nobody will ever get looks like one to wait for.
  assert.match(
    code(REPORT),
    /mark: failed \? "alert" : missing \? "search" : "penLine"/,
    "the report's write-failure, its wrong version and its not-written-yet are one picture again",
  );
});

test("the second overlay is the first one's depth, on the sheet the page injects", () => {
  // ON SWM_RULES, NOT TRACE_CSS, and the brief asked for TRACE_CSS. TRACE_CSS
  // is injected by `ensureTraceStyle`, which runs when the trajectory pane or
  // the stage drawer opens — and the missions LIST, which is where the only
  // consumer lives, never calls it. A `.swt-modal` would have been an unstyled
  // div in the page flow until somebody clicked 轨迹.
  for (const rule of [".swm-modal-scrim{", ".swm-modal{", ".swm-modalhead{", ".swm-modalbody{"]) {
    assert.ok(SHEET_RULES.includes(rule), `${rule} is not on the sheet the page injects before first paint, so the dialog renders as a block in the page flow`);
    assert.ok(!TRACE_RULES.includes(rule), `${rule} moved to the trajectory sheet, which the missions list never injects`);
  }
  // ONE OVERLAY DEPTH. Two scrims a shade apart read as two products, so the
  // values are compared rather than each asserted against a number somebody
  // typed twice.
  const ruleFor = (text, selector) => {
    const line = text.split("\n").find((candidate) => candidate.includes(selector));
    assert.ok(line, `${selector} is gone`);
    return line;
  };
  const alphaOf = (line) => /rgba\(0,0,0,([\d.]+)\)/.exec(line)?.[1] ?? null;
  const blurOf = (line) => /backdrop-filter:blur\((\d+px)\)/.exec(line)?.[1] ?? null;
  const drawer = ruleFor(TRACE_RULES, ".swt-scrim{");
  const dialog = ruleFor(SHEET_RULES, ".swm-modal-scrim{");
  assert.ok(alphaOf(drawer), "the drawer's scrim lost its colour, so there is nothing left to match");
  assert.equal(alphaOf(dialog), alphaOf(drawer), "the dialog's scrim and the drawer's scrim are two different blacks; one product, one overlay depth");
  assert.equal(blurOf(dialog), blurOf(drawer), "the dialog's backdrop blur drifted from the drawer's");
  // The elevation is the token the drawer wears, not a hand-mixed shadow — the
  // literal the segmented control's guard already keeps out of this file.
  assert.match(ruleFor(SHEET_RULES, ".swm-modal{"), /box-shadow:var\(--dsw-shadow-lv3\)/, "the dialog mixed its own shadow instead of taking the drawer's elevation");
});

test("a dialog's Escape closes the dialog and not the page behind it", () => {
  // THE ONE-LINE REGRESSION THAT COSTS A KEY. The host app closes the whole
  // 智能体 panel on Escape, so an overlay that does not stop the event closes
  // itself AND the page behind it — measured once already on the drawer, at
  // 1945 characters down to 65.
  //
  // SCOPED TO THE KEY HANDLER, because both shells carry a SECOND
  // `stopPropagation` on the sheet's own click, and a whole-body search is
  // satisfied by that one with the Escape branch deleted.
  for (const shell of ["function MissionDrawer(", "function SwarmModal("]) {
    const source = body(shell);
    const handler = source.slice(source.indexOf('if (event.key !== "Escape") return;'), source.indexOf("}, [open, onClose]);"));
    assert.ok(handler.length > 0, `${shell} lost its Escape handler entirely`);
    assert.ok(handler.includes("event.stopPropagation();"), `${shell}'s Escape no longer stops propagating, so one press closes the overlay and the whole panel behind it`);
    assert.ok(source.includes('window.addEventListener("keydown", onKey, true)'), `${shell} listens in the bubble phase, so the panel's own handler has already closed the page by the time this runs`);
  }
});

test("the create form waits to be asked for", () => {
  const list = code(MISSIONS_LIST);
  assert.equal(list.split("jsx(MissionStarter, {").length - 1, 1, "the starter is mounted some number of times other than once");
  // A PROXIMITY ASSERTION, AND IT IS WEAK: it proves the mount sits inside the
  // dialog's props, not that the dialog is shut. The three assertions under it
  // are what carry the finding — the form is behind a control, the control
  // exists, and the toolbar is what the tab now opens with.
  const modal = list.slice(list.indexOf("jsx(SwarmModal, {"));
  assert.ok(modal.includes("jsx(MissionStarter, {"), "the starter is not inside the dialog, so it is drawn on the page again");
  assert.match(list, /const \[startOpen, setStartOpen\] = useState\(false\)/, "the dialog does not start closed, which is the permanently expanded card with a scrim over it");
  assert.ok(
    list.split("setStartOpen(true)").length - 1 >= 2,
    "fewer than two things open the form — the toolbar's own control and the empty list's call to action are both meant to",
  );
  assert.ok(
    list.indexOf("style: TOOLBAR_STYLE") < list.indexOf("jsx(SwarmModal, {"),
    "the dialog is written above the toolbar, so the first thing this tab says is still 'ask a new question' — in source and to anything walking the tree",
  );
  // The starter is a form now and not a card: a bordered, shadowed panel
  // inside a bordered, shadowed dialog is the same edge drawn twice.
  assert.ok(
    !code(body("function MissionStarter(")).includes("CARD_STYLE"),
    "the create form kept the card it was drawn as when it lived on the page",
  );
});

// ── hooks ──────────────────────────────────────────────────────────────────

test("every hook runs on every render", () => {
  // THIS ONE SHIPPED. A `useState` was added to MissionDetail below its three
  // early returns — loading, error, and the source reader — so the loading
  // render called thirteen hooks and the ready render called fourteen. React
  // counts hooks by call order: the render that crosses from loading to ready
  // throws before it paints, and the tab simply does not open.
  //
  // THE RENDER HARNESS CANNOT SEE IT. tests/settings.test.mjs stores hook slots
  // in an array indexed by call order and grows it on demand, so a conditional
  // hook works there and only there. All 358 tests were green while the tab was
  // dead. That is why this reads the source instead of rendering.
  //
  // An early return is one NOT inside a nested function: a `return` in a
  // useCallback body is a callback returning, not a component exiting. The
  // first draft of this check missed the real bug because it only looked at
  // returns one brace deep, and every early return here is written
  // `if (…) { return … }`, which is two. It was mutation-tested in both
  // directions before it was trusted.
  const HOOK = /^\s*(const \[[^\]]+\] = |const \w+ = )?use[A-Z]\w*\(/;
  const OPENS_FN = /=>\s*\{|\bfunction\b/;
  const lines = SOURCE.split("\n");
  const offenders = [];
  for (let i = 0; i < lines.length; i += 1) {
    const declared = /^\t\tfunction ([A-Za-z]\w*)\(/.exec(lines[i]);
    if (!declared) continue;
    const stack = [];
    let firstReturn = -1;
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j].replace(/\/\/.*$/, "").replace(/`[^`]*`|"[^"]*"|'[^']*'/g, "''");
      const insideFn = stack.some((frame) => frame.fn);
      if (j > i && stack.length === 0) break;
      if (!insideFn && stack.length > 0 && firstReturn < 0 && /^\s*return\b/.test(line)) firstReturn = j;
      if (!insideFn && firstReturn >= 0 && HOOK.test(line)) {
        offenders.push(`${declared[1]}: the hook on line ${j + 1} runs only when the early return on line ${firstReturn + 1} did not fire`);
      }
      let opensFn = OPENS_FN.test(line);
      for (const character of line) {
        if (character === "{") { stack.push({ fn: opensFn }); opensFn = false; }
        else if (character === "}") stack.pop();
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a hook is declared after an early return. React counts hooks by call order, so the first render that takes the other path throws and the tab does not open",
  );
});

test("the report takes the frame the page already gave it", () => {
  // `WIDE_STYLE` exists two thousand lines above these panes because "the
  // detail view is a two-pane reader and must use the whole frame — capping it
  // left a band of dead space down the right of the page". `MissionReport` then
  // put a 760px cap back INSIDE that frame, and `MissionReferenceList` did the
  // same: on a wide window the report sat in the left half with an empty band
  // beside it, while the stat tiles directly above it spanned the full width.
  // Two containers, one page, opposite answers — which is what makes a screen
  // read as broken rather than as typeset.
  for (const pane of ["function MissionReport(", "function MissionReferenceList("]) {
    const source = code(body(pane));
    const capped = [...source.matchAll(/maxWidth:\s*"(\d+)px"/g)].map(([, px]) => px);
    assert.deepEqual(
      capped,
      [],
      `${pane.slice(9, -1)} caps its own measure at ${capped.join(", ")}px, which reinstates the dead band beside the report`,
    );
  }
});

test("the report reads as a document, not as an instrument panel", () => {
  // Aligning to the reference's report surface: it opens with a title and ONE
  // headline figure, carries the rest of the scorecard as a line of text, and
  // separates its sections with a hairline (`divide-y`) rather than with
  // borders and fills. Ours opened with three equal bordered, tinted, metered
  // boxes — three numbers given equal weight and none of them a headline — and
  // then ran every chapter together into one column.
  const line = code(body("function MissionScoreLine("));
  assert.ok(line.length > 0, "MissionScoreLine is gone; the scorecard is boxes again");
  for (const boxy of ["border:", "borderRadius", "meter"]) {
    assert.ok(!line.includes(boxy), `the scorecard line grew a ${boxy} and is a panel of boxes again`);
  }
  // Colour marks the EXCEPTION. An all-clear figure drawn green is three green
  // numbers at the top of every healthy report, which is decoration.
  assert.ok(
    line.includes("tile.tone === TONE.success"),
    "a passing figure is coloured again, so colour no longer marks the one number that is short",
  );

  // The chapter rule, in the article variant only: a chat answer in a 400px
  // panel has no chapters to divide.
  const markdown = code(body("function renderMarkdown("));
  assert.match(
    markdown,
    /article && level === 2 && blocks\.length > 0/,
    "chapters run together again, or a rule is drawn above the first heading where it reads as a line under the header",
  );
});

test("a signature that holds up is a line; a refusal is still a banner", () => {
  // The docblock records why this became a card: a refusal used to be the same
  // grey sentence as "no report yet", so "the Leader read this and declined to
  // sign" carried the weight of "not finished". That lesson is about the
  // REFUSAL and it is kept.
  //
  // The other side had the opposite problem. A signed report clearing 80 drew a
  // full-width green banner above every one of the five panes — and the header
  // already carries a green 完成 chip six inches above it. The same fact twice,
  // in the loudest treatment on the screen, on the runs where there is nothing
  // to look at.
  const card = code(body("function MissionSignoffCard("));
  assert.match(
    card,
    /const quiet = mission\.signed === true && hue === TONE\.success;/,
    "the sign-off is loud again on every passing run, or the condition stopped being both signed AND above par",
  );
  for (const chrome of ["background: quiet ?", "border: quiet ?", "borderRadius: quiet ?"]) {
    assert.ok(card.includes(chrome), `the sign-off keeps its ${chrome.split(":")[0]} on a passing run`);
  }
  // The hue ternary itself is untouched: a refusal is danger whatever it
  // scored, and a signature at 44 is amber, not green. Only where the hue is
  // SPENT changed.
  assert.match(
    card,
    /mission\.signed === false \? TONE\.danger/,
    "a refusal is no longer red on sight, which is the incident this component exists for",
  );
  // The shorthand before the longhand, or `border: none` erases the rule that
  // replaces it — the same discarded-property bug this batch removed thirteen of.
  const border = card.indexOf("border: quiet ?");
  const borderTop = card.indexOf("borderTop: quiet ?");
  assert.ok(border >= 0 && borderTop > border, "borderTop is written above border, so the quiet rule is erased by the shorthand");
});

test("a figure's ground is neutral and its reading size is declared", () => {
  // THE GROUND. `MetricStat` tinted its whole box by the tone, so a run with
  // rework drew amber, amber, amber, red and green boxes in one row — colour on
  // every tile in the row a reader scans precisely to find the one that is
  // short. The hue survives, on the figure, where it means something.
  const stat = code(body("function MetricStat("));
  assert.match(
    stat,
    /background: SURFACE\.subtle\s*$/m,
    "the tile ground is tinted by its tone again, so colour marks every figure instead of the exception",
  );
  assert.ok(
    stat.includes("color: hue === null ? INK.primary : `rgb(${hue})`"),
    "the hue stopped reaching the figure, so a short tile no longer reads as short at all",
  );

  // THE SIZE. The article block declared `lineHeight` and no `font`, so every
  // report paragraph inherited the 13px UI step under a 24/20/18px heading
  // tower — and the docblock two lines above claimed a reading column that was
  // never applied. `font` first, because the shorthand resets leading.
  const declaration = SOURCE.slice(SOURCE.indexOf("const ARTICLE_BLOCK ="));
  const article = declaration.slice(0, declaration.indexOf("\n"));
  assert.match(
    article,
    /font: FONT\.large, lineHeight:/,
    "the article paragraph has no size again, or the shorthand was written after the leading it resets",
  );
});

test("the fixed chrome above a pane does not grow with the mission's history", () => {
  // The run picker drew one pill per run, so a mission on its twenty-second
  // attempt opened every pane under three wrapped rows of them — ninety pixels
  // of fixed chrome for a control used to look BACK, and mostly not used at
  // all. It got taller with every rerun.
  const sources = code(body("function MissionSources("));
  assert.match(sources, /const RECENT_RUNS = 5;/, "the picker draws every run again, so it grows with the history");
  assert.match(
    sources,
    /\.\.\.shownRuns\.map\(\(entry\) => jsx\("button"/,
    "the picker maps the full list rather than the folded one",
  );
  // The current run is always drawn, wherever it sits: a picker that cannot
  // show what is selected is worse than a long one.
  assert.ok(
    sources.includes("runs.filter((entry) => entry.runCount === current)"),
    "a folded picker can hide the run it is showing, so the selected pill is not on screen",
  );
  // And the fold has a way out, which is the same rule MissionClamp follows.
  assert.ok(sources.includes("setAllRuns(true)"), "the folded runs cannot be reached at all");
});

test("a pane is named once, by the tab that selected it", () => {
  // All four `bare` panels printed their own tab's word a second time twelve
  // pixels below it, with the tab's count beside it twice as well. `bare`'s own
  // comment said it drops the card and keeps the heading — that was the bug,
  // not the contract.
  const panel = code(body("function MissionPanel("));
  assert.match(
    panel,
    /title === undefined \|\| title === null \|\| title === ""/,
    "a panel with no title draws an empty header row again: a rule and its padding under nothing",
  );
  for (const repeated of ['title: zh ? "参考文献" : "References"', 'title: zh ? "轨迹" : "Trajectory"']) {
    assert.ok(
      !SOURCE.includes(repeated),
      `a pane still names itself a second time under its own tab: ${repeated}`,
    );
  }
});

test("the article is one family, and its ladder is the reference's", () => {
  // "The fonts are inconsistent" had a precise cause: the serif was applied at
  // levels 1 and 2 ONLY, so a report set its chapter titles in Georgia and its
  // sub-headings in the UI sans, over a sans body — three treatments in one
  // document. The docblock claimed the serif came from the reference; the
  // reference's article is `prose prose-gray prose-headings:font-semibold` with
  // no font-family override at all, so its headings and its body are the same
  // face and only size and weight separate them.
  assert.ok(!SOURCE.includes("ARTICLE_SERIF"), "the article declares a second font family again");
  // BY SHAPE, not by the constant's name. Deleting `ARTICLE_SERIF` and writing
  // `fontFamily: "Georgia, serif"` inline at the same site is the same
  // regression, and the first version of this guard could not see it. The code
  // face is the one family this renderer is allowed to name.
  const families = [...code(body("function renderMarkdown(")).matchAll(/fontFamily: ([^,\n]+)/g)]
    .map(([, value]) => value.trim());
  // Twice: the fenced block and the inline code span, which are the same face
  // and the only one this renderer may name.
  assert.deepEqual(
    [...new Set(families)],
    ['"var(--ds-font-family-code)"'],
    `renderMarkdown names a font family besides the code face, so the article has two typefaces again: ${families.join(", ")}`,
  );
  assert.match(
    SOURCE,
    /ARTICLE_HEADING_SIZES = \{ 1: "24px", 2: "20px", 3: "18px", 4: "16px" \}/,
    "the heading ladder no longer matches the reference's 2xl / xl / lg / base",
  );
  const markdown = code(body("function renderMarkdown("));
  assert.ok(
    markdown.includes("fontWeight: article ? 600 : 650"),
    "article headings are back at 700, where the reference sets font-semibold",
  );
});

test("a quote and a table survive being rendered", () => {
  // Neither had a branch. A pull-quote printed its own "> " at the head of a
  // paragraph and a table printed |---|---| as prose in the middle of a
  // chapter — the reader lost the content, not just its shape.
  const markdown = code(body("function renderMarkdown("));
  assert.match(markdown, /jsx\("blockquote", \{/, "a quote is prose with a stray marker again");
  assert.match(markdown, /jsxs\("table", \{/, "a table is prose with stray pipes again");

  // A LONE PIPE IS NOT A TABLE. The run of pipe lines is gathered and only
  // becomes a table when the second row is a delimiter; anything else goes back
  // out as the prose it was, or a sentence containing one pipe is eaten.
  assert.match(
    markdown,
    /for \(const row of raw\) paragraph\.push\(row\);/,
    "a run of pipe lines that is not a table is dropped instead of being put back as prose",
  );

  // AND EVERY PATH CLOSES IT. The fence, blank-line and heading branches all
  // `continue`, so a table followed by a heading would render after it — or
  // never, at the end of a document.
  assert.match(
    markdown,
    /if \(fence === null && !\/\^\s\*\\|\/\.test\(line\)\) flushTable\(\);/,
    "an open table is no longer closed by the lines that follow it",
  );
  const tail = markdown.slice(markdown.lastIndexOf("flushParagraph();"));
  assert.ok(tail.includes("flushTable();"), "a document ending in a table loses it");
});
