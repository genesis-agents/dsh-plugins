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
  const ceiling = { fontSize: 0, fontWeight: 9, lineHeight: 5, borderRadius: 0, gap: 5, padding: 128, height: 19 };
  const counted = {
    fontSize: [...SOURCE.matchAll(/fontSize: "\d+px"/g)].length,
    fontWeight: [...SOURCE.matchAll(/fontWeight: \d+/g)].length,
    lineHeight: [...SOURCE.matchAll(/lineHeight: "[^"]+"/g)].length,
    borderRadius: [...SOURCE.matchAll(/borderRadius: "[^"]+"/g)].length,
    gap: [...SOURCE.matchAll(/gap: "[^"]+"/g)].length,
    // PADDING WAS THE HOLE IN THIS RATCHET, AND IT IS THE LARGEST ONE IN THE
    // FILE. Counted the day this line was written: `gap` is a SPACE step at 193
    // of its 198 sites — 97% — while 128 paddings still hard-code a pixel, and
    // twenty of those are off the four-pixel grid entirely (9px 13px, 10px 13px,
    // 11px 13px, 11px 14px). Air lives in padding. Five rounds of design work
    // could change the density of every screen in this tab without moving a
    // number anybody was watching, which is exactly what happened.
    //
    // THE TEMPLATE FORM COUNTS TOO. `padding: `10px ${SPACE.sm}`` is half a
    // token and reads on the page as a whole one — it was the vertical air on
    // all six tables and it was invisible to a quoted-string counter.
    padding: [...SOURCE.matchAll(/padding(?:Top|Bottom|Left|Right)?: (?:"[^"]*\d+px[^"]*"|`[^`]*\d+px[^`]*`)/g)].length,
    // AND A PINNED BOX HEIGHT, for the same reason one property over. TH wrote
    // `height: "30px"` and TD wrote `minHeight: "30px"`, and both are the claim
    // TD's own docblock refuses: a box is as tall as what it has to say plus its
    // air. CONTROL exists for the boxes that genuinely are a fixed size.
    height: [...SOURCE.matchAll(/height: "\d+px"/g)].length,
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
  // FOUR STEPS: soft, ring, fill, wash. `wash` is the faintest and it was
  // added for the citation card, whose hovered ground the reference sets to
  // `bg-violet-50/30` — a third of the palette's lightest step. `soft` at
  // 0.10 is a filled chip and reads as a selection, not as a hover.
  assert.equal(light.size, 4, "four steps: soft, ring, fill, wash");
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
  "function MissionChapterTable(",
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

  // THE PROJECTION, NOT A SENTENCE ABOUT IT. This used to read a local called
  // `spend` that MissionDetail built as a finished string. The strip is handed
  // `cost` itself now — the component that knows how much room the figures have
  // is the one that should format them — so the guard reads the prop, and the
  // rule it exists for moves to the component that draws them.
  assert.ok(
    detail.includes("cost: view.cost"),
    "the tab strip is no longer handed the spend at all, so the one figure a reader wants on every pane is a click away again",
  );
  const spend = code(body("function MissionTabMetrics("));

  // THIS RULE CHANGED, DELIBERATELY, AND THE REVERSAL IS THE POINT.
  //
  // It used to forbid the token figure appearing on the strip at all, on the
  // grounds that the 成本 pane owns it and the same number twice in one viewport
  // is the reader checking whether they are the same number. The reference puts
  // it in both places, and having built it the reason is clear: they are not the
  // same statement. The strip says "412k, 27% of what this run may spend" — a
  // headline with a ceiling — and the pane says how it was spent. What must not
  // come back is the BARE figure, which really would be the tile repeated.
  assert.ok(
    spend.includes("ratio") && spend.includes("missionLadderHue"),
    "the strip prints the token figure with no share of the ceiling beside it, which is the cost tile's statement repeated rather than a headline",
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
  // AND IT SURVIVED ITS COMPONENT A SECOND TIME. The board and the dimension
  // drawer drew this chip twice — same three tones, same two labels, one of
  // them without the glyph — so the refusal is asserted where it is now
  // written instead of at one of the two call sites.
  const chip = code(body("function VerifiedChip("));
  assert.match(
    chip,
    /tone: !hasFloor \? TONE\.neutral/,
    "a null floor is graded again. `?? 0` here draws a dimension green for having beaten nothing",
  );
  assert.match(
    chip,
    /label: hasFloor/,
    "the chip prints a denominator for a floor that has not been derived, which is `/0` in words",
  );
  // AND BOTH CALLERS STILL HAND IT A NULL RATHER THAN A NOUGHT. The board's
  // absent floor is `null`/`undefined`; the drawer's is anything not finite
  // and above nought. Two tests for "there is no bar yet", both right about
  // their own source, so the component takes the answer and derives no third.
  assert.match(
    code(body("function MissionTaskBoard(")),
    /floor: node\.counts\.floor \?\? null/,
    "the board hands the chip a raw floor, so an undefined one comes back as a denominator",
  );
  assert.match(
    code(body("function MissionDimensionDrawer(")),
    /floor: hasFloor \? floor : null/,
    "the drawer hands the chip a floor of 0, which is the `/0` this guard exists to refuse",
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
  // IT IS A TILE NOW, NOT A CHIP, and the assertion moved with it rather than
  // being deleted: what it was guarding — that `calls` reaches a pixel in VALUE
  // position and not inside a branch that never renders — is unchanged.
  assert.ok(
    drawer.includes("value: started ? String(stage.calls) : null"),
    "`calls` is attached to every stage by the projector and reaches no pixel again: the drawer says a step took four minutes and not that it took eleven model calls to do it",
  );
  // ONE RENDERER, NOW THROUGH ONE HOP. The invariant is unchanged and it is
  // the reason this assertion exists: the drawer must not grow a row shape of
  // its own. It reaches `MissionTraceRow` through `MissionRail` rather than
  // directly, so the guard follows the hop instead of asserting the old
  // spelling — asserting the spelling would have failed a file that still
  // satisfies the rule, and passing the rail through without checking what it
  // mounts would satisfy the spelling while a second renderer hid inside it.
  assert.ok(
    drawer.includes("MissionRail({"),
    "the drawer stopped drawing its step as a sequence and went back to a stack, in a 672px drawer where the row's two elastic columns are 95px and 47px wide",
  );
  assert.ok(
    code(body("function MissionRail(")).includes("jsx(MissionTraceRow, {"),
    "the rail draws its own row shape, which is a second renderer for a row the trajectory pane already renders — they drift the moment one gains a field",
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
  assert.ok(body("function MissionSources(").includes("SourceLink({"), "MissionSources draws its own source row again");

  // A CITATION IS NOT A SOURCE, and the reference keeps them apart on
  // purpose: `ui/SourceLink.tsx` is the generic card for a search result and
  // panels/ReferencesPanel.tsx draws its own, richer row for a citation.
  // This test used to REQUIRE the citation list to call SourceLink, which
  // capped a bibliography at what a search result needs.
  //
  // Four things a citation row has that a source card cannot: its NUMBER on
  // the title's baseline, the verification state as a badge, how often the
  // prose leans on it, and when the page was pulled. Guarded here so the
  // exemption cannot decay into a hand-rolled copy of the source card.
  const cite = code(body("function MissionReferenceList("));
  for (const [needle, why] of [
    ["`[${entry.index}]`", "the citation number"],
    ["MISSION_VERIFY_FACES", "the verification state"],
    ["entry.inText", "how often the prose leans on it"],
    ["entry.fetchedAt", "when the page was pulled"],
  ]) {
    assert.ok(
      cite.includes(needle),
      `the citation row does not print ${why}, so it is a source card with a border and there was no reason to write a second component`,
    );
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
  // THREE PARTS NOW. `SWM_THEME` sits between them: the variables the
  // reference's own values are written into, scoped to `.swm-page`. A rule
  // in SWM_RULES still needs SWM_CSS's variables, and now also needs the
  // theme's overrides, or the page paints in the harness palette.
    SOURCE.includes("const SWM_SHEET = SWM_CSS + SWM_THEME + SWM_RULES"),
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
  // THREE PARTS NOW. `SWM_THEME` sits between them: the variables the
  // reference's own values are written into, scoped to `.swm-page`. A rule
  // in SWM_RULES still needs SWM_CSS's variables, and now also needs the
  // theme's overrides, or the page paints in the harness palette.
  assert.ok(SOURCE.includes("const SWM_SHEET = SWM_CSS + SWM_THEME + SWM_RULES"), "the two halves of the sheet stopped shipping together, so the rules above are written and never injected");
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
  assert.match(declaration("const CARD_STYLE = {"), /marginBottom: SPACE\.xl/, "CARD_STYLE lost the margin its four consumers are laid out on, or dropped back to the 16px gutter — the reference's sections stand 24 apart");
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
  // MATCHED ON `meta` ITSELF, not on the style object the line used to take
  // whole. The claim this assertion is named for is unchanged — the meta line
  // is a CHILD of the band — but the line is clipped to one row now, and
  // `text-overflow` has nothing to clip inside META_STYLE's flex box: a joined
  // sentence in a flex container is an anonymous item that wraps. So it takes
  // that object's font and colour by name instead of spreading it, and pinning
  // the old literal would be this guard asserting a style rather than the
  // structure it exists for.
  assert.match(bar[0], /title: meta,\s*children: meta/, "the meta line is outside the band again");
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
  // ON SHEET_RULES NOW, LIKE THE DIALOG'S. The drawer's shell lived on
  // TRACE_CSS, which only the trajectory pane and the stage drawer inject —
  // so the dimension drawer, which is opened from 信源 and from the task
  // board, drew an unstyled div until somebody happened to open one of them.
  const drawer = ruleFor(SHEET_RULES, ".swm-drawer-scrim{");
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

test("a signature that holds up costs no band at all", () => {
  // Making it a hairline row was still a row — the same vertical band above
  // every pane, carrying a sentence the 完成 chip had already said and one
  // figure. The figure and the Leader's own verdict word moved into the
  // header's meta line, beside every other fact about the run, and the row is
  // not drawn.
  const card = code(body("function MissionSignoffCard("));
  assert.match(card, /if \(quiet\) return null;/, "a passing run still draws a band above every pane");

  const detail = code(body("function MissionDetail("));
  assert.match(
    detail,
    /mission\.signed === true && Number\(mission\.score\) >= 80/,
    "the header does not carry the score, so removing the band loses it",
  );
  // The verdict word rides with it: the card was the only place it appeared
  // anywhere on the screen, and a deletion without it loses the Leader's own
  // term for what it signed.
  assert.ok(
    detail.includes("mission.verdict"),
    "the header carries the score without the verdict word, which then appears nowhere at all",
  );
  // And it is the SECOND meta array. The first belongs to MissionListRow, and
  // an earlier attempt at this edit landed there instead — a score on every
  // row of the mission list, and none on the screen it was written for.
  const metas = [...SOURCE.matchAll(/const meta = \[/g)].length;
  assert.equal(metas, 2, `there are now ${metas} meta arrays; the guard below can no longer tell which one was edited`);
  assert.ok(
    !code(body("function MissionListRow(")).includes("Number(mission.score) >= 80"),
    "the mission list's rows carry the sign-off score, which belongs to the detail header",
  );
});

test("a long report can be read one chapter at a time", () => {
  // A thirty-thousand-word report is not something anybody reads top to bottom
  // in a pane, and this screen had never had a table of contents. The reference
  // offers three readings — continuous, chapter and quick — and the first two
  // are a pure slice: every section already carries `start` and `end` offsets
  // into the markdown, written by s12 and checked by contentGuard's
  // section-offset test.
  const report = code(body("function MissionReport("));
  assert.match(report, /const \[reading, setReading\] = useState\("continuous"\)/, "the report has one reading again");
  assert.match(
    report,
    /String\(artifact\?\.markdown \?\? ""\)\.slice\(/,
    "the chapter view no longer slices the markdown it already has, so it either re-fetches or shows the whole document",
  );
  // AND THE MODE IS WHAT DECIDES. Asserting the slice exists is not enough:
  // `false && …` leaves the expression in place and shows the whole document
  // in a view whose only job is to show one chapter.
  // THROUGH `chosen`, NOT THROUGH THE MODE ALONE.
  //
  // This pinned the slice to `reading === "chapter"`, and that was the whole
  // bug: being IN the chapter mode is not the same as having CHOSEN a chapter.
  // `chapter` started at 0, 0 is a real chapter, so the list and the article
  // always rendered together — 分章节 was an index sitting on top of the thing
  // it indexes, and the two modes differed only in how much prose was below it.
  assert.match(
    report,
    /const chosen = reading === "chapter" && chapter >= 0 && chapter < readSections\.length;/,
    "nothing separates being in the chapter mode from having chosen a chapter, so the list and the article render together",
  );
  assert.match(report, /const readSlice = chosen &&/, "the slice no longer waits for a chapter to be chosen");
  // AND -1 IS WHAT MAKES UNCHOSEN POSSIBLE. Starting at 0 means a chapter is
  // always chosen, which is how the list became permanent furniture.
  assert.match(report, /const \[chapter, setChapter\] = useState\(-1\);/, "the chapter index starts at a real chapter, so the list can never be the whole screen");
  // THE LIST HIDES WHEN ONE IS OPEN, AND THE ARTICLE HIDES UNTIL ONE IS.
  assert.match(report, /reading !== "chapter" \|\| chosen \? null : jsx\("nav"/, "the chapter list draws over the chapter a reader opened");
  assert.match(report, /reading === "chapter" && !chosen \? null : jsx\("div"/, "the article draws under the chapter list again");
  // CLAMPED. A version switch can land on an artefact with fewer chapters than
  // the one that was open, and `sections[7]` of a five-chapter report is
  // undefined — a blank pane with no way back to the prose.
  assert.match(
    report,
    /Math\.min\(Math\.max\(0, chapter\), Math\.max\(0, readSections\.length - 1\)\)/,
    "the chapter index is trusted, so switching to a shorter version blanks the pane",
  );
  // The list is the table of contents: numbered, and carrying what each chapter
  // costs to read.
  assert.ok(report.includes("section.citationCount"), "the chapter list drops the citation count, which is why a reader picks one");
  assert.ok(report.includes('"aria-current"'), "the chapter list does not say which chapter is open");
});

test("a report exports as more than prose", () => {
  // Markdown alone meant the evidence could be read one row at a time on a
  // screen and nowhere else. Four formats now, each a plain anchor against a
  // GET the browser already knows how to save — no menu, no state, and a link
  // that can be copied or opened in a tab.
  const header = code(body("function MissionDetail("));
  for (const format of ["report.md", "facts.csv", "citations.csv", "report.json"]) {
    assert.ok(header.includes(format), `the header offers no ${format} export`);
  }
  // The version on screen rides in the query AND the filename, the way the
  // markdown export already did: the query makes the file the one being read,
  // and the filename stops three versions overwriting each other.
  assert.ok(
    header.includes("reportVersion > 0 ? `?version=${reportVersion}`"),
    "an export downloads the latest version while the reader is looking at an older one",
  );
});

test("the reasoning four stages produced is on the screen", () => {
  // `GET /missions/:id/insights` has returned the Analyst's reconciliation, the
  // critic's blindspots and biases, the Leader's per-dimension verdicts and the
  // sign-off's forced corrections since the route was written — and
  // `grep /insights lib/client.js` returned ZERO. Four stages of judgement, on
  // the wire and off the screen, for as long as the route has existed.
  // COMMENT-STRIPPED. The first version read `SOURCE`, and the comments in
  // this very component name the route it fetches — so a mutation that pointed
  // the fetch somewhere else walked straight through a guard that was reading
  // prose about the route rather than the call to it.
  const pane = code(body("function MissionJudgement("));
  assert.match(
    pane,
    /fetch\(`\$\{apiBase\(\)\}\/missions\/\$\{encodeURIComponent\(missionId\)\}\/insights`\)/,
    "nothing in the browser asks for the insights route again",
  );
  assert.ok(pane.length > 0, "MissionJudgement is gone");

  // EACH EMPTY BLOCK SAYS WHICH EMPTY IT IS. The projection distinguishes 'no
  // row', 'ran and wrote nothing' and 'unreadable output', which are three
  // different failures with three different next actions.
  for (const reason of ["no-row", "unreadable"]) {
    assert.ok(pane.includes(reason), `the pane collapses ${reason} into one empty state`);
  }

  // IN THE STAGE DRAWER, not a sixth tab. The strip is pinned to the set the
  // reference settled on, and the reference reaches this same content through a
  // row's own detail rather than through a tab of its own.
  const drawer = code(body("function MissionStageDetail("));
  assert.match(
    drawer,
    /\["s4-assess", "s5-reconcile", "s10-critique", "s11-signoff"\]\.includes\(stage\.stepId\)/,
    "the judgement is mounted for every step, or for none",
  );
  assert.ok(drawer.includes("MissionJudgement"), "the stage drawer no longer shows what the step concluded");
  // And the strip stays five.
  const panes = SOURCE.match(/const MISSION_PANES = \[[^\]]*\]/)?.[0] ?? "";
  assert.equal((panes.match(/"/g) ?? []).length / 2, 5, `the pane strip is ${(panes.match(/"/g) ?? []).length / 2} panes: ${panes}`);
});

test("the surface paints in the reference's values, not the harness's", () => {
  // 100% of the way, not most of it. Every component here styles itself from
  // FONT / INK / LINE / SURFACE / RADIUS / ELEVATION, so the whole surface
  // moves onto the reference's palette by redefining what those resolve to —
  // no component changes, and no second set of numbers to keep in step.
  //
  // The values are COUNTED off the reference, not approximated: every className
  // in its agent-playground was tallied. text-gray-500 (112 uses), 700 (92),
  // 600 (92), 400 (82), 900 (67); border-gray-200 outside and 100 inside;
  // bg-gray-50; violet for the accent where ours was the harness blue.
  assert.match(SOURCE, /const SWM_THEME = \[/, "the reference's own values are gone from the sheet");
  const theme = SOURCE.slice(SOURCE.indexOf("const SWM_THEME = ["), SOURCE.indexOf("const SWM_SHEET"));
  // THE LIGHT BLOCK ONLY. The dark block redeclares the same names with the
  // dark corrections, so a search across both finds whichever came last —
  // which is how a "did it drift?" guard becomes a coin toss. This read was
  // one line long because the constant was one line; it is bounded now
  // because the constant is not.
  const darkAt = theme.indexOf("body[data-ds-dark-theme] .swm-page{");
  const block = darkAt < 0 ? theme : theme.slice(0, darkAt);

  for (const [name, value] of [
    ["--dsw-alias-label-primary", "#111827"],   // gray-900
    ["--dsw-alias-label-secondary", "#4b5563"], // gray-600
    ["--dsw-alias-label-tertiary", "#9ca3af"],  // gray-400
    ["--dsw-alias-border-l1", "#f3f4f6"],       // gray-100, inside
    ["--dsw-alias-border-l2", "#e5e7eb"],       // gray-200, outside
    ["--dsw-alias-bg-layer-2", "#f9fafb"],      // gray-50
  ]) {
    assert.ok(block.includes(`${name}:${value};`), `${name} drifted off the reference's ${value}`);
  }

  // SCOPED. The harness's other tabs are not this product and must not be
  // repainted by it — `body{…}` here would take the whole app.
  assert.ok(block.includes(".swm-page{"), "the theme is unscoped and repaints the rest of the harness");
  assert.match(
    code(body("function SwarmPage(")),
    /className: "swm-page"/,
    "nothing carries the class the theme selects, so every token falls back to the harness palette",
  );

  // The hues stay in their ONE home, with a light value and a dark correction.
  // Declaring them again in the theme block made the second declaration read as
  // the dark one, and the light/dark guard caught it.
  // A DECLARATION, NOT A MENTION. This looked for the STRING `--swm-h-`, and
  // the accent patch fired it by writing two comments that name the hue its
  // new hex equals — which is exactly the evidence a reader of that block
  // wants. Fourth time in this file a guard has matched the sentence
  // describing the thing instead of the thing; the shape to look for is a
  // NAME FOLLOWED BY A COLON inside a quoted CSS fragment.
  assert.ok(
    !/"--swm-h-[a-z-]+:/.test(block),
    "a hue is declared a second time in the theme block, where it reads as the dark value",
  );
});

test("the model that spent the tokens reaches the screen", () => {
  // Recording it and never drawing it is the shape this whole batch keeps
  // finding: the value is stored, projected, and read by nobody.
  assert.ok(SOURCE.includes("function MissionModelTable("), "the per-model table is gone");
  const table = code(body("function MissionModelTable("));
  // NOT RECORDED, not blank. A row from before the column existed is a
  // different statement from a model whose name is the empty string.
  assert.ok(table.includes('zh ? "未记录" : "not recorded"'), "an unrecorded model renders as an empty cell");
  // The share is what makes the row worth reading; a token count alone repeats
  // the meter four inches above it.
  assert.ok(table.includes("row.tokens / spent"), "the table drops the share, so it restates the total meter per row");
  assert.match(
    code(body("function MissionDetail(")),
    /jsx\(MissionModelTable, \{ byModel: view\.cost\.byModel, zh \}\)/,
    "the table exists and nothing mounts it",
  );
});

test("both spend writers stamp the model, not just the one with tools", () => {
  // Two writers reach the ledger: `onUsage` for stages that hold tools, and
  // `recordSpend` for the middle stages that do not — which is most of them. A
  // fix applied to one writes NULL for the other, and the table then reports
  // that a deep mission ran one model for its collection and nothing for its
  // reasoning.
  const agent = readFileSync(new URL("../lib/mission-agent.js", import.meta.url), "utf8");
  assert.match(agent, /model: route\?\.model \?\? null,/, "the tool-bearing writer stopped stamping the model");
  const middle = readFileSync(new URL("../lib/mission-stages-middle.js", import.meta.url), "utf8");
  assert.match(
    middle,
    /model: run\?\.model \?\? null,/,
    "recordSpend stopped stamping the model, so every stage without tools writes NULL",
  );
  // From the RESULT, never re-resolved: re-resolving at write time reports the
  // selection then, which is not necessarily the one that produced the tokens.
  assert.ok(
    !/model: ctx\.agentDefaultModel/.test(middle),
    "the middle writer re-resolves the model at write time instead of reading what the run reported",
  );
});

test("the year facet narrows every arrangement on the references pane", () => {
  // A filter that reached the flat list and not the grouped one is two answers
  // to one question: the same run reads as four pages under 按站点 and one under
  // 按引用, and neither number is wrong on its own. The pane has four
  // arrangements and one filter, so the filtered set has to be computed ONCE
  // and read by all of them.
  const pane = code(body("function MissionSources("));
  assert.match(
    pane,
    /const visible = narrowed \? sources\.filter\(\(source\) => eraOf\(source\) === era\) : sources;/u,
    "the pane no longer derives the filtered set, so the year chips are a control that selects nothing",
  );

  const after = pane.slice(pane.indexOf("const visible ="));
  assert.equal(
    /\[\.\.\.sources\]\.sort\(/u.test(after),
    false,
    "an arrangement sorts the whole run again instead of the rows the chip left, so the filter quietly does nothing in that one mode",
  );
  assert.equal(
    /for \(const source of sources\)/u.test(after),
    false,
    "the host roll-up counts the whole run again, so its page counts disagree with the rows printed underneath them",
  );
  assert.equal(
    /const rows = sources\.filter\(/u.test(after),
    false,
    "the dimension fan-out reads the whole run again, so 按维度 shows unfiltered groups while 按引用 shows filtered rows",
  );
  for (const reader of [/\[\.\.\.visible\]\.sort\(/u, /for \(const source of visible\)/u, /const rows = visible\.filter\(/u]) {
    assert.match(after, reader, `an arrangement stopped reading the filtered set (${reader.source}), so one tab of this pane answers a different question from the others`);
  }
});

test("a year chip never speaks for the whole run", () => {
  const pane = code(body("function MissionSources("));
  // THE TILES ARE THE RUN'S AND THE LIST IS THE CHIP'S. Four figures sit above
  // a list the filter shortens; with nothing between them a reader compares
  // "14 findings" against three rows and concludes the pane dropped eleven.
  assert.match(
    pane,
    /!narrowed \? null : jsx\("div", \{/u,
    "a filtered list no longer says that it is filtered, so the totals above it read as a miscount",
  );
  assert.match(
    pane,
    /\$\{visible\.length\} of \$\{sources\.length\}/u,
    "the narrowing sentence stopped naming how many of how many, which is the only figure that reconciles this list with the tiles above it",
  );
  // THREE EMPTIES, NOT TWO. Under a chip an empty dimension group means
  // "nothing from this era"; saying "left no page behind" there states a fact
  // about the whole run that the filter itself produced.
  assert.match(
    pane,
    /left no page from \$\{eraLabel\(era\)\}/u,
    "a dimension with no page in the chosen year says it left no page behind at all, which is the filter talking about the run",
  );
  // AND THE RUN WITH NO DATES ANYWHERE. Dropping the control in silence makes
  // "this screen has no year facet" and "not one of these pages is dated"
  // identical, and only one of the two is a fact about the mission.
  assert.match(
    pane,
    /totals\.dated > 0 \? null : jsx\("div", \{/u,
    "a run whose pages carry no publish date simply loses the year control, and nothing on the pane says why it is gone",
  );
  assert.match(
    pane,
    /eras\.length < 2 \? null : jsx\("div", \{/u,
    "the year strip draws with a single value in it — an All and one chip that select the same rows, which is a control that cannot do anything",
  );
  // THE VALUES COME FROM THE ROWS. A hard-coded list of years is a chip that
  // matches nothing the moment the calendar moves, and an empty result this
  // control is built to be incapable of producing.
  assert.match(
    pane,
    /const eras = \[\.\.\.eraCounts\.keys\(\)\]/u,
    "the facet stopped being built from the rows it filters, so a chip can now select nothing",
  );
});

test("the library's facts are drawn once, and the absence of them is not a colour", () => {
  assert.ok(
    SOURCE.includes("function missionLibraryMeta("),
    "the type and the score are computed nowhere again, so a references row cannot say whether the page it lists is a preprint or a press release",
  );
  const facts = code(body("function missionLibraryMeta("));
  // THE PARAMETER LIST IS THE GUARD. A score invented from the hostname needs
  // the address to read from, and this function is handed the joined row and
  // the locale — so there is nothing in scope to guess with.
  assert.match(
    facts,
    /function missionLibraryMeta\(library, zh\)/,
    "the helper takes the page's address again, which is the one input a grade guessed off the TLD would need",
  );
  // TWO SILENCES, AND THEY ARE NOT THE SAME SILENCE.
  assert.match(
    facts,
    /if \(library === undefined\) return \[\]/,
    "a payload that predates the join now prints 'not in the library' on every row — a lookup nobody performed, stated on the pane whose whole subject is what was actually read",
  );
  assert.match(
    facts,
    /if \(library === null\)/,
    "a page the library has never collected is drawn exactly like one it holds, so 'we have nothing on this' and 'we never asked' read the same",
  );
  // THE SCORE IS A FIGURE AT PAR. A hue would grade it, and this pane has no
  // ladder to grade it on: the range belongs to the library's upstream.
  for (const verdict of ["TONE.success", "TONE.warn", "TONE.danger", "missionRateHue("]) {
    assert.ok(
      !facts.includes(verdict),
      `the library score is drawn in ${verdict}, which passes a verdict this screen cannot support — and paints an unrated page as a failed one`,
    );
  }
  assert.ok(
    facts.includes("KINDS.find(") && facts.includes("kindLabel("),
    "the type badge picks its own colour and its own words instead of the feed's, so PAPER is one colour on 信源 and another here",
  );
  // AND THE PANE MOUNTS IT. A helper nothing calls is the same screen as
  // before with more code behind it.
  assert.ok(
    code(body("function MissionSources(")).includes("missionLibraryMeta(source.library, zh)"),
    "the references rows stopped reading the join, so every page on the pane is typeless and unscored again",
  );
});


test("the stage panel offers a rerun only where the pipeline allows one", () => {
  // A CONTROL OFFERED FOR WORK THE ROUTE WILL REFUSE is worse than no control:
  // the person presses it, gets a 409 in the error line, and learns that this
  // screen's buttons are a guess. `rerunable` and its sentence come up from the
  // pipeline's own declaration through the view, so the panel never decides
  // this for itself — and the third state is not "assume yes": a payload that
  // does not carry the field is a payload that says nothing about this step.
  const panel = code(body("function MissionStageDetail({"));

  assert.match(panel, /onRerunStage\?\.\(stage\.stepId\)/u, "the stage panel has no way to re-run the stage it is describing, so the only rerun on this screen is still the whole mission");
  assert.match(panel, /stage\.rerunable === true/u, "the rerun control is offered without asking whether the pipeline allows it, so pressing it on the budget gate is a 409 the reader cannot predict");
  assert.match(panel, /stage\.rerunReason/u, "a stage that cannot be re-run shows no reason, which is the dead end validateStageDag refuses to let a stage declare");
  assert.ok(
    !/onRerunStage\?\.\(stage\.stepId\)[\s\S]{0,400}rerunable/u.test(panel),
    "the rerunable check sits after the click handler rather than around it",
  );

  // The label has to say the cascade. "Re-run this step" is the half that
  // sounds safe; the successors are reset with it.
  assert.match(panel, /Re-run this step and everything after it/u, "the rerun label promises one stage and resets its successors too, which is the surprise this wording exists to remove");

  // And the control has to be reachable: a prop nobody threads down is a button
  // that renders and does nothing.
  const board = code(body("function MissionTaskBoard({"));
  assert.match(board, /onRerunStage/u, "the task board does not pass the rerun down to the drawer it opens, so the control is inert");
  assert.match(code(SOURCE), /onRerunStage: \(stepId\) =>/u, "nothing on the mission screen supplies the rerun, so the panel's control is wired to undefined");

  // Tokens, like every other control on this panel. A rerun is a figure at par
  // — it deletes nothing — so it is drawn in ink, and the colour this panel has
  // stays spent on the stage that actually degraded.
  assert.ok(
    !/onClick: \(\) => \{ onRerunStage[\s\S]{0,200}rgb\(\$\{TONE\./u.test(panel),
    "the rerun control is coloured; colour on this panel marks the exception, and re-running a step is not one",
  );
});

test("every hue is the same step of one ramp", () => {
  // "The colours are a mess" had a precise cause: half the palette had been
  // moved onto the reference's values and half had not, and of the half that
  // moved, some landed on the 600 step and some on the 700 — so ten hues came
  // from two palettes at two brightnesses, on one page, in chips sitting
  // beside each other.
  //
  // The reference pairs `text-*-700` with `bg-*-50` almost everywhere. One
  // step for all of them, and the dark theme one step for all of them too.
  const LIGHT = {
    green: "4,120,87", amber: "180,83,9", red: "185,28,28", blue: "29,78,216",
    violet: "109,40,217", indigo: "67,56,202", cyan: "14,116,144", rose: "190,18,60",
  };
  const DARK = {
    green: "52,211,153", amber: "251,191,36", red: "248,113,113", blue: "96,165,250",
    violet: "167,139,250", indigo: "129,140,248", cyan: "34,211,238", rose: "251,113,133",
  };
  const declaredIn = (theme) => {
    const found = new Map();
    const darkAt = SOURCE.indexOf('"body[data-ds-dark-theme]{"');
    for (const match of SOURCE.matchAll(/"--swm-h-([a-z-]+):(\d{1,3},\d{1,3},\d{1,3});"/g)) {
      const inDark = match.index > darkAt;
      if ((theme === "dark") === inDark) found.set(match[1], match[2]);
    }
    return found;
  };
  const light = declaredIn("light");
  const dark = declaredIn("dark");
  for (const [name, value] of Object.entries(LIGHT)) {
    assert.equal(light.get(name), value, `--swm-h-${name} is off the reference's 700 step, so it reads as a different palette beside the others`);
    assert.equal(dark.get(name), DARK[name], `--swm-h-${name}'s dark value is off the 400 step`);
  }
  // The two neutrals are the reference's greys, and they are the only hues that
  // are not a chip colour.
  assert.equal(light.get("slate"), "107,114,128");
  assert.equal(light.get("slate-dim"), "156,163,175");
});

test("the source reader opens the copy we kept, not the address", () => {
  // ONE ANSWER TO TWO QUESTIONS. The reader built a synthetic row and handed it
  // to `DocumentView`, whose only input is a url — so every open was a
  // re-fetch, and a page edited since the mission read it came back without the
  // quote in it. Its own comment said why: "the mission documents are not
  // library rows and no route serves them". One of them serves them now.
  const reader = code(body("function MissionSourceReader("));
  assert.ok(
    reader.includes("/document?documentId="),
    "the reader never asks for the stored page, so opening a quote still re-fetches the address and a page that moved on reads as a quote that was invented",
  );
  assert.ok(
    !body("function MissionSourceReader(").includes("no route serves them"),
    "the docblock still says nothing serves the mission documents, which is the sentence this whole change exists to make false",
  );
  // THE DEFAULT IS THE ORDER OF THE BRANCHES. A reader that fetches the kept
  // copy and still draws the live one first has bought the reader nothing —
  // and one that fetches it and draws nothing has bought them less.
  const kept = reader.indexOf("renderMarkdown(stored.markdown");
  assert.notEqual(
    kept,
    -1,
    "the stored page is fetched and never drawn, so the reader pays for a read whose answer it throws away and still shows the address as it is now",
  );
  assert.ok(
    kept < reader.indexOf("jsx(DocumentView"),
    "the live re-fetch is drawn ahead of the copy we kept, so the answer on screen is still the one that cannot say what the page said when we checked",
  );
  // EVERY HOOK ABOVE EVERY EARLY RETURN — which here is easy, because there are
  // no early returns; the guard is that none appears before the last hook.
  assert.ok(
    reader.lastIndexOf("useEffect(") < reader.indexOf("return "),
    "a return moved above a hook in the reader, which is the render that throws on the second open and not the first",
  );
});

test("the reader says which absence it is, and colours only the exceptional ones", () => {
  // THREE OF THESE WERE ONE SCREEN. A quote that names no stored page is normal
  // and permanent — anything verified against a publisher abstract carries no
  // document id at all. A page the mission no longer holds has left the corpus.
  // A read that failed is worth pressing again. One "could not load" for all
  // three tells the reader something false about their own evidence twice.
  const states = scale("MISSION_COPY_STATES");
  for (const state of ["loading", "unkeyed", "gone", "failed"]) {
    assert.ok(
      states.includes(`${state}: {`),
      `nothing is written for \`${state}\`, so that absence borrows another one's sentence and the reader is told the wrong reason the page is not there`,
    );
  }
  // COLOUR MARKS THE EXCEPTION. Waiting, and "there never was one", are at par.
  assert.match(
    states,
    /loading: \{ tone: null/u,
    "a read in flight is drawn as an exception, but waiting is not an anomaly and colour is the only thing on this bar that says one has happened",
  );
  assert.match(
    states,
    /unkeyed: \{ tone: null/u,
    "a quote that never had a stored page is coloured like a failure, and that is the normal case for every quote checked against a publisher abstract",
  );
  assert.equal(
    (states.match(/tone: TONE\.warn/gu) ?? []).length,
    2,
    "the two states that say the substrate is gone are no longer the only marked ones, so a page we hold and a page we lost read at the same weight",
  );
  // And the fallback is the honest one: an unrecognised state is a read that
  // did not land, never "there never was one".
  const note = code(body("function missionStoredCopyNote("));
  assert.ok(
    note.includes("MISSION_COPY_STATES.failed"),
    "an unknown state falls back to a reassuring sentence, which tells a reader their evidence has no page behind it when the truth is that this screen could not fetch one",
  );
});


test("a dimension's own grade is drawn, and drawn with the two halves it is made of", () => {
  // THE FIGURE THAT WAS SERVED AND NEVER SHOWN. `mission_dimensions.grade` is
  // written twice per dimension — by s3 as collection settles and by s4 against
  // the mission's derived floor — and the drawer opened `gradeAxes` twice, for
  // the floor and for the page count, while stepping over the score sitting
  // between them. The one number the pipeline computes per dimension, and the
  // one the Leader argues a recollect from, was legible nowhere.
  const drawer = code(body("function MissionDimensionDrawer("));
  assert.ok(
    drawer.includes("detail?.grade"),
    "the drawer reads gradeAxes and not the grade beside it, so the figure s3 and s4 each compute for this dimension is on the wire and on no screen",
  );
  assert.ok(
    !/grade\s*\?\?\s*0/.test(drawer),
    "an ungraded dimension is handed a nought, which is a failing mark for work nobody has marked — the same `?? 0` the floor two lines above refuses",
  );
  // THE HALVES, OR THE NUMBER IS UNARGUABLE. 74 alone tells a reader nothing
  // they can act on; "5 verified against a floor of 6, from 2 hosts" tells them
  // whether to re-collect and what to change about it.
  for (const axis of ["gradedVerified", "gradedHosts", "seedTarget"]) {
    assert.ok(
      drawer.includes(axis),
      `the drawer prints a grade without ${axis}, so a reader is handed a verdict and none of the evidence it was reached on`,
    );
  }
  assert.ok(
    drawer.includes("MISSION_GRADE.hostsForFull") && drawer.includes("MISSION_GRADE.evidence"),
    "the weights are typed into the drawer's own sentences instead of read from MISSION_GRADE, which is where the client's account of the formula starts drifting from the formula",
  );
  assert.ok(
    drawer.includes("missionRateHue(grade, 100)"),
    "the drawer grades its score on rungs of its own instead of the one ladder this tab reads, which is the third copy of a decision already extracted twice",
  );
  // THE SAME RULE, ONE LAYER EARLIER. The score is a `MetricStat` now, and
  // MetricStat already draws a null tone in INK.primary — so at par the drawer
  // hands it NOTHING rather than handing it green. Asserting the old ink
  // ternary would pin a colour the component no longer takes.
  assert.match(
    drawer,
    /gradeTone === TONE\.success \? null/,
    "a grade at par is painted rather than left in ink, which spends the tab's loudest colour on the ordinary case and leaves nothing louder for the dimension that came in under the floor",
  );
  assert.ok(
    !drawer.includes("MISSION_RATE_"),
    "the drawer reads the 0.8/0.5 rungs directly instead of asking missionRateHue, which is the second reader that function exists to be instead of",
  );
  // THE BOX'S EDGE IS A HAIR AND THE SPLIT INSIDE IT IS A RULE. LINE's docblock
  // is the only guard on that distinction, so the one new container in the file
  // is held to it here.
  assert.match(
    drawer,
    /border: `1px solid \$\{LINE\.hair\}`/,
    "the grade block's outer edge is not LINE.hair, so a container edge is drawn at the weight reserved for dividers between siblings",
  );
  assert.match(
    drawer,
    /borderTop: `1px solid \$\{LINE\.rule\}`/,
    "the split between the evidence half and the independence half is drawn at hairline weight, where there is no shadow to make it read at all",
  );
});

test("the drawer's account of a grade is the stage's arithmetic, not a second opinion", () => {
  // TWO FILES, ONE OF WHICH COMPUTES. gradeOf() in lib/mission-stages-front.js
  // decides a dimension's grade; MISSION_GRADE is the client's label for the
  // same weights, so a reader can be told 70/30 without the client ever doing
  // the sum. The two drifting apart is silent — the drawer would go on
  // explaining a formula the pipeline had stopped using, and the explanation is
  // the entire reason the number is worth putting on screen.
  const stage = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "mission-stages-front.js"),
    "utf8",
  );
  const formula = /function gradeOf\(row, floor\) \{[\s\S]*?\n\}/.exec(stage);
  assert.ok(formula, "gradeOf is gone from lib/mission-stages-front.js, and the drawer is now explaining a formula that lives nowhere");

  const declared = /const MISSION_GRADE = \{([^}]+)\}/.exec(SOURCE);
  assert.ok(declared, "MISSION_GRADE is gone, so the weights the drawer states are read from nothing");
  const weights = Object.fromEntries(
    [...declared[1].matchAll(/(\w+): ([\d.]+)/g)].map((match) => [match[1], Number(match[2])]),
  );

  assert.ok(
    formula[0].includes(`* ${weights.evidence}`),
    `the drawer tells a reader evidence is ${weights.evidence} of the grade and gradeOf no longer weighs it there`,
  );
  assert.ok(
    formula[0].includes(`* ${weights.independence}`),
    `the drawer tells a reader independence is ${weights.independence} of the grade and gradeOf no longer weighs it there`,
  );
  assert.ok(
    formula[0].includes(`/ ${weights.hostsForFull})`),
    `the drawer says ${weights.hostsForFull} hosts is full independence and gradeOf divides by a different number, so a dimension reads as short of a bar it has already cleared`,
  );
  assert.equal(
    weights.evidence + weights.independence,
    1,
    "the two shares the drawer prints do not add up to the whole grade, which leaves a reader to conclude the rest of it came from somewhere nobody named",
  );
});


test("the per-chapter record is on a screen, with the reviewer's score on it", () => {
  // Recording a number, projecting it and drawing it nowhere is the shape this
  // file keeps finding. `mission_chapters.score` was the purest case of it: a
  // reviewer's verdict on every chapter of every run, in the database since the
  // report tables landed, and not one pixel anywhere.
  assert.ok(
    SOURCE.includes("function MissionChapterTable("),
    "the per-chapter record has no component, so the decision, the score, the rounds and the delivered words are computed on the wire and read by nobody",
  );
  const table = code(body("function MissionChapterTable("));
  for (const [field, loss] of [
    ["row.heading", "which chapter the row is about"],
    ["row.sectionType", "whether the chapter cites or interprets"],
    ["row.score", "the reviewer's score, which nothing else in this product reports"],
    ["row.attempts", "how many rounds the chapter took"],
    ["row.wordCount", "what the chapter actually delivered"],
    ["row.minDelivery", "the floor it was delivering against"],
    ["row.bodyMissing", "whether the chapter came back empty"],
  ]) {
    assert.ok(table.includes(field), `the chapter row no longer says ${loss}`);
  }
  // MOUNTED, and on the pane that holds the rest of the work: a run whose
  // chapters came back empty is a run with no report pane to read.
  assert.match(
    code(DETAIL),
    /jsx\(MissionChapterTable, \{ chapters: view\.chapters, zh \}\)/,
    "the table exists and nothing mounts it, which is the state the projector's own `chapters` key was in",
  );
});

test("a chapter's delivery is read from the column that recorded it, and never over a floor of nought", () => {
  const table = code(body("function MissionChapterTable("));
  // NO DENOMINATOR FOR A FLOOR OF NOUGHT — the same refusal the dimension floor
  // gets on the board. `312/0` reads as a bar this chapter cleared.
  assert.match(
    table,
    /floor > 0 \? `\$\{words\}\/\$\{floor\}` : String\(words\)/,
    "a chapter recorded before a floor was set prints `/0`, which reads as a bar it cleared rather than a bar nobody has drawn",
  );
  // THE STORED FLAG, not a comparison invented here. The write loop measures
  // against a fraction of the floor, so `words < floor` on this side would
  // disagree with the column on every chapter between the two lines — and the
  // column is the one the content guard reads.
  assert.match(
    table,
    /color: row\.underDelivered === true \? `rgb\(\$\{TONE\.warn\}\)` : INK\.primary/,
    "the shortfall is recomputed on this side of the wire instead of read from the column the writer wrote, which is a second opinion on a decision already taken",
  );
  // AND THE SCORE IS NOT BANDED. The pass bar is SCORE_THRESHOLDS one file
  // away and it MOVES with the attempt, so a threshold typed here is a second
  // copy of a ladder that is not even constant.
  assert.ok(
    !/row\.score\s*[<>]=?/.test(table),
    "the score is graded against a number typed on this side of the wire; the bar it is graded against moves with the attempt, so the two can only agree by accident",
  );
  // A FIGURE AT PAR IS INK. One round is the ordinary case and every round past
  // it is a chapter written twice — the same fact the rework panel paints.
  assert.match(
    table,
    /color: attempts > 1 \? `rgb\(\$\{TONE\.warn\}\)` : INK\.primary/,
    "every chapter's round count is drawn in the same colour, so a chapter written four times is as quiet as one written once",
  );
});

test("a chapter with no decision says which empty it is, and an empty body is marked only when it is a hole", () => {
  const table = code(body("function MissionChapterTable("));
  // THREE DIFFERENT FACTS, NOT ONE BLANK CELL: never started, being written,
  // and a run that ended over a chapter the write loop never decided.
  assert.match(
    table,
    /decided \? MISSION_CHAPTER_DECISION_FACES : MISSION_CHAPTER_STATE_FACES/,
    "a chapter with no decision draws the same nothing whether it has not been started, is being written now, or was left behind by a run that ended",
  );
  // THE MARK IS FOR THE HOLE. A chapter nobody has written yet has no body
  // either, and marking that paints the ordinary case as the failure.
  assert.match(
    table,
    /row\.bodyMissing !== true \|\| !decided \? null : Chip\(/,
    "an unwritten chapter is marked as an empty one, which puts a red mark on every chapter of every mission that is still running",
  );

  // THE DECISION VOCABULARY IS THE STORE'S, and this side only says what each
  // value means. A value the column may write and this table has never heard of
  // falls through `missionFace` to its raw slug.
  const store = readFileSync(new URL("../lib/mission-store.js", import.meta.url), "utf8");
  const declared = /export const CHAPTER_DECISIONS = Object\.freeze\(\[([^\]]+)\]\)/.exec(store);
  assert.ok(declared, "CHAPTER_DECISIONS is gone from the store, so the faces table here is a copy of nothing");
  const words = keysOf("const MISSION_CHAPTER_DECISION_FACES = {");
  for (const value of declared[1].match(/"[a-z-]+"/g).map((quoted) => quoted.slice(1, -1))) {
    assert.ok(words.includes(value), `the store may write the decision "${value}" and this side has no word for it, so a reader is shown the raw column value`);
  }
  // AND THE TWO FALLBACKS ARE NOT DRAWN ALIKE. `fallback-length` is a fact
  // about the delivery — the prose may well have scored 82 — and
  // `fallback-exhausted` is a chapter nobody could fix.
  const faces = declaration("const MISSION_CHAPTER_DECISION_FACES = {");
  const hueOf = (value) => (new RegExp(`"${value}":[^\\n]*hue: (TONE\\.\\w+)`).exec(faces) ?? [])[1];
  assert.ok(hueOf("fallback-length") !== undefined && hueOf("fallback-exhausted") !== undefined, "a fallback lost its hue, so it draws in the neutral every unknown value gets");
  assert.notEqual(
    hueOf("fallback-length"),
    hueOf("fallback-exhausted"),
    "a chapter that came in short and a chapter nobody could fix are painted the same colour, which is the split the column has three values for",
  );
  // THE KIND OF CHAPTER TAKES NONE OF IT. Colour on this row means how the
  // chapter landed, and an interpretive chapter has not landed badly.
  assert.ok(
    !declaration("const MISSION_SECTION_FACES = {").includes("hue:"),
    "the section type carries a colour, so a chapter that interprets is drawn as a chapter that went wrong",
  );
});

test("every onOpenSource call passes the keys the reader reads", () => {
  // MissionSourceReader's docblock names its contract in a sentence:
  // "anything carrying `sourceUrl`, `sourceTitle`, `quote`, `documentId`".
  // The one call site passed `url` and `title`. It had a documentId, so the
  // stored page loaded and the pane looked right — and the header above it,
  // the live link beside it and the quote it was opened to check were all
  // undefined. A contract written in prose and read by nothing.
  const READS = ["sourceUrl", "sourceTitle", "quote", "documentId"];
  const calls = [...SOURCE.matchAll(/onOpenSource\(\{([^}]*)\}\)/g)];
  assert.ok(calls.length > 0, "no onOpenSource call site found; this guard is watching nothing");
  for (const call of calls) {
    const keys = [...call[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    for (const key of keys) {
      assert.ok(READS.includes(key), `onOpenSource is passed \`${key}\`, which MissionSourceReader never reads: ${call[0]}`);
    }
    assert.ok(keys.includes("sourceUrl"), `onOpenSource call omits sourceUrl, so the reader's header and live link are undefined: ${call[0]}`);
  }
});

test("the page declares every variable it reads, in both themes", () => {
  // WHY THIS IS "ALL OF THEM" AND NOT "THE BROKEN ONES".
  //
  // Counted off the running build: the served app reads 60 distinct `--dsw-*`
  // variables and defines exactly ONE. The token sheet that would define the
  // rest is not shipped, and the harness's own boot screen only survives that
  // by writing a fallback into every single reference. So this block is not an
  // override layer, it is the palette — and `SURFACE.card`, which is
  // `var(--dsw-specific-menu)`, had no value at all: unresolved with no
  // fallback makes the declaration invalid at computed-value time, so every
  // card took `transparent` and showed the grey behind it. Twelve more names
  // were in that state, silently, because a missing variable does not
  // complain — it just takes the initial value.
  const theme = SOURCE.slice(SOURCE.indexOf("const SWM_THEME"), SOURCE.indexOf("const SWM_SHEET"));
  const darkAt = theme.indexOf("body[data-ds-dark-theme] .swm-page{");
  assert.ok(darkAt > 0, "SWM_THEME has no dark block: a light-only override on .swm-page paints near-black text on a dark ground");

  const declared = (text) => new Set([...text.matchAll(/(--dsw-[a-z0-9-]+):/g)].map((m) => m[1]));
  const light = declared(theme.slice(0, darkAt));
  const dark = declared(theme.slice(darkAt));

  // Every variable read without a fallback must be declared. A fallback is the
  // other honest answer, so a `var(--x, #fff)` is allowed to be undeclared.
  for (const match of SOURCE.matchAll(/var\((--dsw-[a-z0-9-]+)([^)]*)\)/g)) {
    if (match[2].trim() !== "") continue;
    assert.ok(light.has(match[1]),
      `${match[1]} is read with no fallback and never declared: the declaration using it is invalid at computed-value time, and its property silently takes the initial value`);
  }

  // Every COLOUR the light block sets, the dark block must reset. Sizes,
  // radii and font shorthands are theme-independent and stay in light only.
  for (const match of theme.slice(0, darkAt).matchAll(/(--dsw-[a-z0-9-]+):(#[0-9a-f]{3,8})/g)) {
    if (match[1] === "--dsw-static-neutral-00") continue; // white is white in both.
    assert.ok(dark.has(match[1]), `${match[1]} is a colour set for light only, so dark mode keeps the light value`);
  }
});

test("a list row is separated by a line, never by a fill", () => {
  // "为什么是灰色" was pointing at the trajectory. The row carried
  // `background: var(--dsw-alias-bg-layer-3)` — gray-100 — inside a full
  // border at an 8px radius, so a hundred records read as a hundred grey
  // cards with white gutters. It is the same complaint as "太表格化" and the
  // same cause: separation done with a fill instead of a line.
  //
  // Two rules, both checkable:
  //
  // GRAY-100 IS NEVER A GROUND. It is the palette's lightest LINE, and a
  // background at the same value as a border is two greys with nothing to
  // tell them apart. Insets are gray-50; surfaces are white.
  for (const match of SOURCE.matchAll(/background:\s*var\(--dsw-alias-bg-layer-3\)/g)) {
    assert.fail(`gray-100 is painted as a ground here, and it is a line weight: ${SOURCE.slice(Math.max(0, match.index - 60), match.index + 40)}`);
  }

  // AND A ROW IS NOT A BOX. The one that started this may not go back to
  // carrying a fill or a full border.
  // THE WHOLE LINE, not up to the first `}`. The declaration interpolates
  // `${LINE.hair}`, whose closing brace arrives before the CSS block ends —
  // so a slice to the first `}` stopped short of the very properties this is
  // here to check, and passed by reading nothing.
  const row = SOURCE.split(String.fromCharCode(10)).find((line) => line.includes(".swt-row{"));
  assert.ok(row !== undefined, "the trajectory row rule is gone");
  assert.ok(row.includes("background:transparent"), "the trajectory row paints a ground again, so the list reads as a stack of cards");
  assert.ok(row.includes("border:0"), "the trajectory row took a border back");
  assert.ok(row.includes("border-bottom:1px solid"), "nothing separates one row from the next");
  assert.ok(!row.includes("border-radius"), "a row with a radius is a card; a row in a list is a line");

  // AND SELECTED IS A MARK IN THE MARGIN. `inset 0 0 0 2px` draws, on all
  // four sides, exactly the border the row was just relieved of — so the
  // boxes come back one at a time as the reader clicks through the list.
  const pressed = SOURCE.split(String.fromCharCode(10)).find((line) => line.includes('.swt-row[aria-pressed="true"]'));
  assert.ok(pressed !== undefined, "nothing marks the selected row");
  assert.match(pressed, /box-shadow:inset 2px 0 0 0/, "the selected row is ringed on all four sides, which is the border it just lost");
});

test("the task row says two things, and marks only the selected one", () => {
  // Held against the reference side by side, two differences accounted for
  // most of the gap on this screen, and both were structural rather than
  // chromatic.
  //
  // ONE: the reference's row is a title over a sentence. Ours put both on one
  // line, which forced the name to a 40% cap and left the sentence an
  // ellipsised fragment in the remainder — two facts of different weight
  // competing for one line, both losing, and a table half as tall as the one
  // it was meant to match.
  const board = body("function MissionTaskBoard(");
  assert.match(board, /whiteSpace: "normal"/, "the name cell is back to one nowrap line, so the sentence under the title cannot exist");
  assert.ok(!/maxWidth: child \? "40%"/.test(board), "the task name is capped at 40% of its cell again, which only made sense while the sentence shared the line");
  assert.match(board, /marginTop: "2px"/, "nothing puts the row's sentence on its own line");

  // TWO: every row drew a 3px bar in its status hue down its left edge.
  // Twenty rows of that is not twenty marks, it is one continuous stripe — and
  // it was the second drawing of what the status chip already says in words.
  assert.ok(!/boxShadow: `inset 3px 0 0 0 rgba\(\$\{hue\}/.test(board),
    "the per-row status spine is back: on a full table it reads as one stripe down the side, and the status column already says it");
  assert.match(board, /boxShadow: open \? "inset 2px 0 0 0/, "the selected row has no mark at all");
});

test("a table cell has room for two lines", () => {
  // `height:30px` with no vertical padding is a log line's rhythm. It was
  // correct while every cell held one short string, and it silently crushes
  // the stacked name cell — title over sentence — back into something the eye
  // reads as one line again. A row is as tall as what it has to say.
  const td = SOURCE.slice(SOURCE.indexOf("const TD = {"), SOURCE.indexOf("};", SOURCE.indexOf("const TD = {")));
  assert.ok(!/height: "30px"/.test(td), "TD pins a fixed 30px height again, which crushes the two-line name cell");
  assert.ok(td.includes("padding: `${SPACE.md} ${SPACE.md}`"), "TD's vertical air moved. Sixteen is the value the fourth pass derived against a 16px text line while a 26px chip was already in the row; it stood the one-line row at 58 and the two-line row at 76, past the reference's 72");
});

test("a category and a state differ in the corner and in nothing else", () => {
  // The shape IS the meaning: a CATEGORY takes RADIUS.sm, a STATE takes
  // RADIUS.pill, and both docblocks say so. What neither said, and what was
  // true, is that the two also differed in HEIGHT — one padded by hand, the
  // other through pillStyle, and the two arithmetics landed two pixels apart.
  //
  // THIS TEST USED TO PIN THE MECHANISM RATHER THAN THE RULE. It asserted one
  // exact literal, so when the chip moved to the reference's 26px and the
  // variable that literal mentioned stopped existing, the guard failed for
  // having its old implementation taken away rather than for anything being
  // wrong. A guard written against one spelling of an answer expires the first
  // time the answer is spelled differently.
  //
  // What is held instead: EVERY STEP THE PILL DECLARES, THE CHIP DECLARES TOO.
  // Directional on purpose. `Chip` also pads its count badge, which is a
  // nested span and not a box a pill is ever drawn beside; requiring the two
  // sets to be equal would make that badge's padding a violation, and it is
  // not one. What must not happen is a pill step the chip does not match.
  const chip = code(body("function Chip("));
  const pill = code(body("function pillStyle("));

  const paddings = (source) => [...source.matchAll(/padding: (`[^`]*`|"[^"]*")/g)].map((m) => m[1]);
  const pillSteps = paddings(pill);
  assert.ok(pillSteps.length >= 2, "pillStyle no longer declares two steps, so there is nothing for the chip to agree with");
  for (const step of pillSteps) {
    assert.ok(
      chip.includes(step),
      `pillStyle pads ${step} and the chip has no step that matches it, so a category and a state beside it stand at different heights`,
    );
  }

  // AND BOTH OF THEM ARE ON THE CHIP'S OWN BOX, not scattered across it. The
  // box is the declaration written beside its corner.
  const NL = String.fromCharCode(10);
  const rows = chip.split(NL);
  const cornerAt = rows.findIndex((row) => /borderRadius: RADIUS\.sm/.test(row));
  assert.notEqual(cornerAt, -1, "the category chip lost its corner");
  const box = rows[cornerAt - 1];
  for (const step of pillSteps) {
    assert.ok(box.includes(step), `the chip's box does not offer ${step}; it is somewhere else in the function, which is not the same object`);
  }

  assert.ok(pill.includes("RADIUS.pill"), "the state pill lost its corner");
  assert.equal(
    [...chip.matchAll(/"2px 8px"/g)].length,
    0,
    "`2px 8px` is back in the chip: it is one of the five paddings that drew one chip, and it is a pixel from the next one",
  );
});

test("the panel header is one bar, and a count with no title still sits in it", () => {
  // ONE HEADER SHAPE, not two. The title-less branch was a second flex row —
  // `action` alone, no rule under it, and nowhere for `count` to go — so the
  // task board's tally floated over the top edge of its own table with nothing
  // joining the two, and `display.length`, the number the board's closing note
  // calls the entire reason it mounts its own panel, reached the screen
  // nowhere at all: MissionPanel took the prop and then dropped it whenever
  // the title was absent, which is exactly when the board passes it.
  const panel = code(body("function MissionPanel("));
  const heads = panel.split('}, "head")').length - 1;
  assert.equal(
    heads,
    1,
    `the panel draws ${heads} header rows; a count and an action must land in the same bar as a title, under the same rule`,
  );
  // AND THE BAR IS SKIPPED ONLY WHEN ALL THREE ARE ABSENT. Gating the row on
  // the title alone is what dropped the count, and it is the one-character
  // regression: the title may gate the `h3` and nothing else.
  assert.match(
    panel,
    /!Number\.isFinite\(count\)\s+&& \(action === undefined \|\| action === null\)/,
    "the header row is gated on the title again, so a panel with a count and no heading prints neither the number nor the rule that joins the bar to its table",
  );
  assert.match(
    panel,
    /title === undefined \|\| title === null \|\| title === "" \? null : jsx\("h3"/,
    "the `h3` renders unconditionally, so a title-less panel prints an empty heading where the reference prints nothing",
  );
  // THE DIVIDER IS `LINE.rule` AND IS DRAWN ONCE. The bar and the table are
  // siblings inside one card, which is what `rule` is for; `hair` is the
  // card's own outer edge and drawing it here would be the outer edge twice.
  const rules = panel.split("borderBottom: `1px solid ${LINE.rule}`").length - 1;
  assert.equal(rules, 1, `the header's divider is drawn ${rules} times, and there is one header`);
  assert.ok(
    !panel.includes("borderBottom: `1px solid ${LINE.hair}`"),
    "the bar is divided from its table with the container's outer edge weight, which is a frame drawn inside a frame",
  );
});

test("the trajectory's kind tag is the chip its own comment says it is", () => {
  // The rule's docblock reads "THE GEOMETRY IS THE CHIP'S; THE COLOUR NOW IS
  // TOO". The colour was; the geometry was not. `.swt-tag` pinned
  // `height:22px` while a Chip at the same font sizes itself: 16px of line
  // (`--dsw-font-xxxs-strong-11` is `600 11px/16px`) plus 1px of padding top
  // and bottom, which is 18px. Both live in the SAME 96px `.swt-tagslot` — the
  // kind tag and the role mark, side by side on every row of the densest
  // screen in the tab — so the four pixels are not a difference anyone has to
  // hunt for.
  const tag = TRACE_RULES.split(String.fromCharCode(10)).find((line) => line.includes(".swt-tag{"));
  assert.ok(tag !== undefined, "the trajectory's kind tag rule is gone");
  assert.ok(
    !/height:\d/.test(tag),
    "the kind tag pins a height of its own again, so it stands four pixels taller than the role chip it touches",
  );
  assert.ok(
    tag.includes("padding:1px 6px"),
    "the kind tag no longer takes the chip's own padding, which is the only thing left deciding how tall it is",
  );
  // AND THE CHIP IT IS MATCHED TO HAS NOT MOVED UNDER IT. The two numbers
  // agree by being written twice, four thousand lines apart, so a guard that
  // holds only one end holds neither.
  assert.ok(
    code(body("function Chip(")).includes('"1px 6px"'),
    "Chip's narrow step moved and the tag rule that was matched to it did not",
  );
});

test("one verified count, and it carries its mark on both screens", () => {
  // THE PUREST TWO-SHAPES-FOR-ONE-MEANING left on the board. The task board's
  // status cell and the dimension drawer's header answer the same question
  // from the same two numbers — how much of this dimension held up, against
  // the floor s3 derived for it — and they answered it twice: the identical
  // three-rung ladder, the identical pair of bilingual labels, written out in
  // full 1,100 lines apart. The one difference was the glyph, and the copy
  // that had it was the drawer. TONE.success against TONE.warn is exactly the
  // pair "every state carries a mark as well as a colour" exists for, so on
  // the board a dimension over its floor and one under it were two tints and
  // nothing else.
  assert.ok(SOURCE.includes("function VerifiedChip("), "the verified chip is written out at each of its call sites again");
  const chip = code(body("function VerifiedChip("));
  assert.match(
    chip,
    /icon: !hasFloor \? undefined : over \? "check" : "alert"/,
    "the verified chip drops its mark, which is what the board's copy had already done: success and warn separated by tint alone",
  );
  // COUNTED, NOT MERELY PRESENT. A component beside one surviving copy is a
  // third drawing of the same three tones, and a mutation proved an
  // `includes` on the component alone passes with either call site reverted.
  const ladders = [...SOURCE.matchAll(/verified >= (?:node\.counts\.)?floor \? TONE\.success : TONE\.warn/g)].length;
  assert.equal(
    ladders,
    0,
    `${ladders} call sites still grade a verified count themselves, which is the copy VerifiedChip was extracted to be instead of`,
  );
  for (const caller of ["function MissionTaskBoard(", "function MissionDimensionDrawer("]) {
    assert.ok(code(body(caller)).includes("VerifiedChip({"), `${caller} draws its own verified chip again`);
  }
});

test("every FONT step named at a call site is one FONT declares", () => {
  // `FONT.titleStrong` and `FONT.displayStrong` were both written and neither
  // exists: FONT.title is already 600 and FONT.display is already 700, so a
  // `Strong` suffix on either names a member that could never have been there.
  // Nothing threw — React drops a style key whose value is `undefined` — so the
  // report's <h2> and the article reader's <h1> rendered with no `font` at all
  // and fell back to the UA's `1.5em` and `2em bold`: a multiple of a size the
  // harness sets and this file does not control. Two of the twelve steps had a
  // typo standing in for them, on the two largest headings in the tab, and the
  // point of a scale is that its members can be checked.
  const declared = new Set([...scale("FONT").matchAll(/(\w+): "/g)].map(([, name]) => name));
  const unknown = [...new Set([...SOURCE.matchAll(/\bFONT\.(\w+)/g)].map(([, name]) => name))]
    .filter((name) => !declared.has(name));
  assert.deepEqual(
    unknown,
    [],
    `FONT.${unknown.join(", FONT.")} is not a step FONT declares, so it renders as \`font: undefined\` and the element takes the browser's default heading size instead of the scale's`,
  );
});

test("no object literal declares `font` twice, and no control swaps only its weight", () => {
  // THE MIRROR OF THE RULE TWO TESTS UP. Two objects — STEPPER_BUTTON and the
  // armed-artifact chip — wrote `font: "inherit"` on one line and
  // `font: FONT.base` / `font: FONT.small` on the next, in the SAME literal.
  // The later key wins, so nothing looked wrong and nothing threw; what is
  // wrong is that the object states two intentions and only a reader who knows
  // the last-wins rule can say which renders. The test above catches only the
  // order that discards the step, so this pair sat underneath it.
  const stack = [];
  const doubled = [];
  for (let at = 0; at < SOURCE.length; at += 1) {
    const character = SOURCE[at];
    if (character === "{") stack.push({ at, count: 0 });
    else if (character === "}") {
      const frame = stack.pop();
      if (frame !== undefined && frame.count > 1) {
        doubled.push(`line ${SOURCE.slice(0, frame.at).split(/\r?\n/).length} declares font ${frame.count} times`);
      }
    } else if (character === "f" && SOURCE.startsWith("font:", at) && !/[\w.$]/.test(SOURCE[at - 1] ?? "") && stack.length > 0) {
      stack[stack.length - 1].count += 1;
    }
  }
  assert.deepEqual(doubled, [], "an object declares `font` twice; the later key silently wins and the earlier one is a statement the file does not honour");

  // THE SAME RULE ONE KEY ALONG. Both of those objects also swapped emphasis
  // with a bare `fontWeight: … ? 600 : 400` written AFTER the step — which is
  // what chipStyle's own docblock forbids one screen over: 400 and 600 have
  // different advances at 12px, so toggling one re-measures its own label and
  // nudges what follows it along the row. Written as a ternary, that 600 is
  // also invisible to "emphasis is the shell's weight", which reads
  // `fontWeight: <digits>` — so the ceiling that test holds had two holes in it.
  assert.equal(
    [...SOURCE.matchAll(/FONT\.smallStrong : FONT\.small\b/g)].length,
    3,
    "the tightest-dimension label, the armed-artifact chip and the pane tab are the three controls that mark emphasis at 12px; one of them is back to riding a `fontWeight` beside a fixed step",
  );
});

test("a child whose parent fell out of the window is still drawn", () => {
  // THE COMMENT OVER THE GROUPING HAS ALWAYS SAID SO. The loop walked
  // `parents` and emitted `kids.get(parent.id)`, so a child whose parent was
  // not among them sat in the map, was never looked up, and vanished — no
  // row, and no gap where one would have been. It was missing from
  // `display.length` as well, so the header count and the table agreed with
  // each other about a row neither of them had, which is the one shape of
  // this bug nothing on screen can contradict.
  const board = code(body("function MissionTaskBoard("));
  const pushes = board.split("display.push(").length - 1;
  assert.equal(
    pushes,
    3,
    `rows are emitted from ${pushes} places; a parent, the children under it, and the children with no parent left are three`,
  );
  assert.match(board, /orphan: true/, "an appended child is emitted unmarked, so it draws the connector and claims the row above it as its parent");
  assert.match(board, /grouped\.has\(node\)/, "nothing remembers which children were already placed, so every grouped child is drawn a second time at the end");
  assert.ok(
    !/fell outside the window is in neither/.test(SOURCE),
    "the note at the mount still explains the count by a row being dropped, which is the behaviour this test exists to say has ended",
  );
});

test("a child row draws the connector its indent only implied", () => {
  // WHAT THIS TEST REQUIRED WAS MY INVENTION, and on two counts it required
  // the exact opposite of the reference.
  //
  // board/MissionTodoBoard.tsx indents a child with an inline
  // `paddingLeft: depthOf(td) * 18px` and draws the elbow as `mt-1.5
  // inline-block h-3 w-3 flex-shrink-0 border-b-2 border-l-2
  // border-violet-200`. This test forbade `paddingLeft` BY NAME and demanded
  // a glyph from the icon table. Both halves came from a screenshot I had
  // transcribed into prose, and then guarded, so the transcription outranked
  // the product for as long as the guard stood.
  //
  // What survives is the half that was never about the shape: whatever draws
  // the corner must not be a box-drawing character and must not be a
  // hand-typed <svg>.
  const board = code(body("function MissionTaskBoard("));
  assert.ok(
    board.includes('paddingLeft: child ? TASK_INDENT : undefined'),
    'the depth is not a padding on the row, which is how the reference indents a child',
  );
  assert.ok(
    board.includes('borderLeft: `2px solid rgba(${PALETTE.violet}')
      && board.includes('borderBottom: `2px solid rgba(${PALETTE.violet}'),
    'no child row draws the elbow, so the tree is a gap again and the relationship is left for the reader to infer from indentation alone',
  );
  // `└` is box-drawing: it falls back to whatever font the platform
  // substitutes, at that font's weight, and it cannot take `currentColor`.
  // An <svg> typed at the call site is how this file once got a trash can and
  // a close cross at two different stroke widths.
  assert.ok(!board.includes('└'), 'the connector is a box-drawing character, which renders in a substituted font on most platforms');
  assert.ok(!board.includes('jsx("svg"'), 'the board draws its own <svg> again, beside a glyph table that exists so it does not');
  // AND AN ORPHAN GETS THE INDENT WITHOUT THE CORNER. An elbow says "the row
  // above me is my parent"; for a child appended after its parent fell out of
  // the display that is a claim about whatever row happens to be there.
  assert.ok(
    board.includes('!child || entry.orphan === true ? null :'),
    'the elbow is drawn on every child, so an appended orphan points at a row that is not its parent',
  );
});

test("the rerun is on the row too, and still only where the pipeline allows one", () => {
  // THE CONTROL WAS THREE INTERACTIONS FROM THE ROW IT ACTS ON: select the
  // row, wait for the drawer, read to the bottom of it. `onRerunStage` has
  // been a prop of this component all along and was only ever forwarded — the
  // board's own 操作 cell held one link. The reference prints two controls per
  // row, a tinted 重跑 and a 详情 link, and the rerun is the half that was
  // missing.
  //
  // The gate is the same one the drawer's control is under, for the same
  // reason: `rerunable` comes up from `dag.rerunable` through the view, the
  // budget gate declares itself `rerunable: false`, and a button that earns a
  // 409 teaches that this screen's controls are a guess.
  const board = code(body("function MissionTaskBoard({"));

  assert.match(board, /onRerunStage\?\.\(stage\.stepId\)/u, "the task board still only forwards the rerun to the drawer, so the row it belongs to cannot re-run itself");
  assert.match(board, /stage\.rerunable !== true \? null : Chip\(/u, "the row's rerun is drawn without asking whether the pipeline allows it, so it is offered on the budget gate as well");
  assert.ok(
    !/onRerunStage\?\.\(stage\.stepId\)[\s\S]{0,400}rerunable/u.test(board),
    "the rerunable check sits after the click handler rather than around it",
  );

  // PRESSING IT MUST NOT ALSO SELECT THE ROW. The whole `tr` is a click
  // target, so without this the rerun opens the drawer over the board it was
  // pressed on and reads as having navigated somewhere.
  assert.match(
    board,
    /onClick: \(event\) => \{ event\.stopPropagation\(\); onRerunStage\?\.\(stage\.stepId\); \}/u,
    "the row's rerun does not stop the row's own click, so re-running also opens the drawer",
  );

  // BOTH CONTROLS, not a swap. 看轨迹 → is the second half of the reference's
  // pair and the only way onto the trajectory from this table.
  assert.match(board, /"看轨迹 →" : "Trajectory →"/u, "the trajectory link was replaced by the rerun rather than joined by it");
  assert.match(board, /icon: "refresh"/u, "the rerun on the row has no glyph, so at FONT.micro it is a second word beside a link");

  // AND THE SENTENCE STAYS IN THE DRAWER. A stage that cannot be re-run
  // carries a reason `validateStageDag` refuses to let it omit; thirty of those
  // down a column 16% wide is not a table. The row shows nothing and the
  // drawer explains, which is why this is a copy of the control and not a move.
  assert.ok(!board.includes("rerunReason"), "the un-rerunable stage's reason is printed on every row of the board; it belongs to the drawer, where one row is being asked about");
  assert.match(code(body("function MissionStageDetail({")), /stage\.rerunReason/u, "the drawer lost the reason when the board gained the button, so nothing on the screen says why a stage cannot be re-run");
});

test("the task board's table sits in the frame it claims to sit in", () => {
  // `table` declines a border, a radius and a ground with a stated reason —
  // "the panel around this already carries" all three — and the board then
  // mounted that panel `bare`, which is the one prop whose whole job is to
  // drop all three. MissionToolTable and MissionAgentTable copy the same
  // comment into titled card panels, where it is true; the board is the table
  // that states the rule and was the only one breaking it, so on the tasks
  // pane it read as an unframed list under 立项目标 and 成章记录, which are cards.
  const board = body("function MissionTaskBoard(");
  assert.ok(
    board.includes("ONE FRAME PER THING"),
    "the board's table no longer records why it draws no frame of its own, and that comment is the thing this test keeps true",
  );
  // THE COMMENTS ARE STRIPPED, for the reason the header test one section up
  // records: the fix explains itself in prose that names the prop it stopped
  // passing, and a guard that reads prose is a guard broken by describing it.
  assert.ok(
    !code(board).includes("bare: true"),
    "the task board mounts its panel `bare` again: the panel then draws no border, no radius and no ground, while the table inside it declines its own on the grounds that the panel has all three",
  );
  // AND THE ARITHMETIC STILL REACHES THE PANEL. `display.length` — what
  // survived grouping, which is neither `stages.length` nor `work.length` — is
  // the whole stated reason the board mounts its own panel instead of being
  // handed one by the detail view.
  assert.ok(
    board.includes("count: display.length"),
    "the board stopped passing the count it mounts its own panel in order to compute",
  );
  // BOTH RETURNS, one shape. An empty board that kept `bare` while a full one
  // dropped it makes the pane appear to gain a card when the first task lands.
  const mounts = board.split("MissionPanel, {").length - 1;
  assert.equal(mounts, 2, `the board mounts ${mounts} panels; the empty state and the table are the two, and they must be the same shape`);
});

test("the mission header spends two controls where it spent seven", () => {
  // MEASURED, on a terminal run that has a report. The action group was
  // 全新重跑, 增量重跑, 下载 .md, 证据 .csv, 引用 .csv and .json — six controls
  // at FONT.small in CONTROL.sm with 10px of padding, about 636px of label
  // boxes plus 60px of SPACE.md between them — on a row that also carries an
  // 80px back button, a 28px mark, a ~90px status pill and a title block whose
  // flex basis is 200px. Below roughly 1140px of frame the row wrapped and the
  // fixed chrome above the panes became two bands. gens.team's own header row
  // spends one status pill and one gear.
  const detail = code(body("function MissionDetail("));
  const at = detail.indexOf("const missionActions = [");
  assert.notEqual(at, -1, "the header's action array is gone or renamed");
  const actions = detail.slice(at, detail.indexOf("].filter((entry) => entry !== null);", at));

  assert.equal(
    actions.split('jsx("a", {').length - 1,
    0,
    "an export link is back on the header row itself, and four of those are what pushed the row onto two lines",
  );
  assert.equal(
    actions.split("jsx(MissionHeaderMenu,").length - 1,
    2,
    "the header no longer holds exactly two menus — one verb for the reruns, one for the exports — so either one was unfolded back into loose buttons or a third has grown",
  );

  // AND NOTHING WAS LOST. The exports were asked for explicitly and are recent
  // work: every route the six controls reached is still named here, and the
  // version on screen still rides in the query AND in the filename.
  for (const kept of ["report.md", "facts.csv", "citations.csv", "report.json", "全新重跑", "增量重跑"]) {
    assert.ok(actions.includes(kept), `${kept} was dropped rather than folded`);
  }
  assert.ok(
    actions.includes("reportVersion > 0 ? `?version=${reportVersion}`"),
    "an export downloads the latest version while the reader is looking at an older one",
  );

  // THE ROWS ARE STILL ANCHORS, which is the whole of the argument the docblock
  // this replaced made for four bare links: each is a GET the browser already
  // knows how to save, right-clickable and copyable. A row with an `href` has
  // to render as an <a>; a row with an `onSelect` POSTs and is a button.
  const menu = code(body("function MissionHeaderMenu("));
  assert.match(
    menu,
    /entry\.href === undefined \? "button" : "a"/,
    "the menu draws every row as one element, so either the exports stopped being real links or the two reruns became anchors that navigate",
  );
  assert.ok(
    menu.includes("download: entry.download"),
    "the menu row drops the download filename, so three downloads of three versions overwrite each other in the downloads folder",
  );
  // AND IT SHUTS BY ITSELF. It opens directly over the tab strip.
  assert.ok(menu.includes("pointerdown"), "the menu closes only by pressing its own trigger, so it sits over the tab strip until the reader finds the trigger again");
  assert.ok(menu.includes('event.key === "Escape"'), "the menu cannot be dismissed from the keyboard");
  // `LINE.hair` because this is a container's OUTER edge under its own shadow,
  // which is the rule LINE's docblock writes down. There is no divider BETWEEN
  // the rows at all: four hairlines in a four-item menu is a table.
  assert.ok(menu.includes("border: `1px solid ${LINE.hair}`"), "the menu's outer edge is drawn at the inner-divider weight");
  assert.ok(!menu.includes("borderBottom"), "the menu rules between its own rows, which turns a four-item list into a table");
});

test("the mission header's meta line is one line, and it clips what a pane redraws", () => {
  // Six dot-joined facts measure about 540px in English — "deep · run 3 ·
  // signed by the leader (thorough) 88/100 · 2026-08-26 14:22 · dimensions 5/5
  // · chapters 8/8" — inside a title block whose flex basis is 200px. It ran to
  // two rows on every frame under about 1400px: 16px of fixed chrome above the
  // panes, on every tab of every mission, on a screen whose next element is a
  // table.
  const detail = code(DETAIL);
  const metaAt = detail.indexOf("const meta = [");
  assert.notEqual(metaAt, -1, "the mission header's meta array is not where this test thinks it is");
  const meta = detail.slice(metaAt, detail.indexOf("].filter", metaAt));

  // THE ORDER IS THE DECISION, because an ellipsis eats the tail. What trails
  // has to be what a pane one click away draws in full: 成章记录 on the 任务
  // pane is a row per chapter with how each one landed, and the board beside it
  // is a row per dimension. The tier, the run number, the Leader's signature
  // and the start stamp are on this screen exactly once — here.
  const stamp = meta.indexOf("formatStamp(mission.startedAt)");
  assert.notEqual(stamp, -1, "the start stamp left the meta line, and nothing else on this screen carries it");
  for (const restated of ["dimensionsResolved", "chaptersDone"]) {
    const found = meta.indexOf(restated);
    assert.notEqual(found, -1, `${restated} was deleted rather than moved to the tail`);
    assert.ok(
      found > stamp,
      `${restated} is back ahead of the start stamp, so a narrow window clips the date — which appears nowhere else on this screen — instead of a fraction the 任务 pane draws in full`,
    );
  }

  // AND THE BOX ACTUALLY CLIPS. `text-overflow` needs a block box: META_STYLE
  // is a flex row, and a joined sentence inside one is an anonymous flex item
  // that wraps instead of ellipsising. Spreading META_STYLE here is the version
  // of this that looks fixed in the source and is not fixed on the screen.
  const bar = /jsxs\("div", \{\s*style: \{\s*display: "flex", alignItems: "center", gap: SPACE\.md, flexWrap: "wrap",[\s\S]*?\}, "bar"\)/.exec(body("function MissionDetail("));
  assert.ok(bar, "the mission detail's header band is not where this test thinks it is");
  const band = code(bar[0]);
  assert.ok(!band.includes("style: META_STYLE,"), "the meta line took META_STYLE whole again, so it is a flex row and text-overflow has nothing to clip");
  assert.equal(
    band.split('whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"').length - 1,
    1,
    "the meta line wraps again, which is a second row of chrome above every pane of every mission",
  );
  assert.ok(band.includes("title: meta,"), "the clipped tail is on no title attribute, so a narrow window loses it with nothing to say so");
});

test("a source row's title is one step, at that step's own leading", () => {
  // Five lists draw the same row — a title over a `source · date` meta line.
  // Three of them (the search dropdown and the two picked-source lists) named
  // no step at all, so the title inherited the row's FONT.small and came out at
  // 12px, and then hand-wrote `lineHeight: "18px"` — which IS FONT.body's own
  // leading, typed out because the step it belongs to was never reached for.
  // The other two (episodes, documents) did name FONT.body and then overrode
  // its 18px with a hand-typed 19px. One row, two sizes and two leadings, on
  // screens one click apart.
  assert.deepEqual(
    [...SOURCE.matchAll(/lineHeight: "1[89]px"/g)].map(([value]) => value),
    [],
    "a row title hand-writes its leading again. 18px IS FONT.body's leading and 19px is one pixel off it, so the same row draws two heights on two screens",
  );
  assert.equal(
    [...SOURCE.matchAll(/font: FONT\.body, color: INK\.primary \}, children: row\.title/g)].length,
    2,
    "a picked-source row's title is not FONT.body, so a source in the episode's own list is a different size from the same source in the search results above it",
  );
  assert.equal(
    [...SOURCE.matchAll(/font: FONT\.body, display: "block", color: INK\.primary \}/g)].length,
    1,
    "the search dropdown's row title names no step, so it is back to inheriting the row's 12px while the list it feeds draws 13px",
  );
});

test("a fact is a label over a value, and the two cards are one box", () => {
  // WHAT THE REFERENCE REPEATS MORE THAN ANY OTHER DEVICE. Every fact in it is
  // a small label over a value in a bordered box on a grey ground — four in a
  // row for figures, four in a 2x2 for context — and this file had exactly half
  // of that: `MetricStat` for figures, and for everything else a run-on line of
  // "key · key · key" in one grey sentence.
  //
  // THE SECOND HALF IS A SIBLING, NOT A FLAG. MetricStat's docblock records
  // that every value reaching it is a figure, which is why it sets 20px tabular
  // mono and why it has no `mono` prop. A model name in that face is a sentence
  // clipped at the first space that does not fit, so the prose card is its own
  // component and the decision above it stands.
  assert.ok(SOURCE.includes("function MissionFactCard("), "the prose fact card is gone, so a context fact is a sentence again");
  assert.ok(SOURCE.includes("function MissionFactGrid("), "the context grid is gone");
  const card = code(body("function MissionFactCard("));
  // THE VALUE READS AS PROSE. `font` first because the shorthand resets the
  // leading the clamp then counts in — MetricStat carries the same note one
  // property along, and it is the same discarded-property bug both times.
  assert.ok(card.includes("font: FONT.body"), "the context value is not FONT.body, so the card has a second opinion about what reading size prose is");
  assert.ok(card.includes("...clampBox(2)"), "the context value stopped wrapping, so the qualifier that made the name worth printing is what gets clipped");
  assert.ok(!card.includes("FONT.title") && !card.includes("MONO"), "the context card set its value in the figure face, which is the `mono` prop MetricStat refused, added at a second call site instead");
  // THE TONE IS ON THE LABEL. On MetricStat the hue means THIS FIGURE IS SHORT
  // and is spent on the figure; here it means WHICH KIND OF CONTEXT THIS IS,
  // which is a category, and a context value drawn in a state colour turns
  // every card on the band into an alarm.
  const labelAt = card.indexOf("textTransform: \"uppercase\"");
  const toneAt = card.indexOf("`rgb(${tone})`");
  assert.ok(labelAt !== -1 && toneAt !== -1 && toneAt - labelAt < 200, "the hue moved off the eyebrow and onto the value, so a card that says which model ran can read as a warning");
  // ZERO IS A VALUE, spelled the way MetricStat spells it. Forking the test
  // between the two cards is how one of them starts disagreeing with the other
  // about what an absence looks like.
  assert.match(
    card,
    /value === null \|\| value === undefined \|\| value === ""/,
    "the fact card tests its value for truthiness, so a genuine 0 renders as the em dash that means not measured",
  );
  // ONE GRID RULE, TWO FLOORS. The floor is the only thing that may differ —
  // 150px lays four figures across the drawer, 220px lays two context cards —
  // and everything else is written once so the two bands cannot drift.
  assert.ok(SOURCE.includes("function tileGrid("), "the two strips each declare their own grid again, which is how four bars became four geometries before Meter");
  const grid = code(body("function MissionFactGrid("));
  const stat = code(body("function MissionStatTiles("));
  assert.ok(stat.includes("tileGrid(\"150px\")"), "the figure strip stopped reading the shared grid");
  assert.ok(grid.includes("tileGrid(\"220px\")"), "the context grid stopped reading the shared grid, or took the figure strip's floor and lays four columns of clipped prose");
  // A NULL CARD IS DROPPED, NOT DASHED. A dash in a figure strip says "not
  // measured"; a dash in a context strip would say "we did not record which
  // model ran", which is a claim about the run that nobody checked.
  assert.match(
    grid,
    /filter\(\(fact\) => fact !== null && fact !== undefined\)/,
    "an unsourced context slot is drawn rather than dropped, so the band answers a question it was never told the answer to",
  );
});

test("an absent duration is an absence, not nought seconds", () => {
  // THE GUARD THAT WAS NOT ONE. `const value = Number(ms); if
  // (!Number.isFinite(value)) return ""` reads as a null check and is not one:
  // `Number(null)` is 0, 0 is finite, and both functions went on to format it.
  // So an absent duration printed `0 秒` — "this took no time", a measurement —
  // where each docblock promises "". Live in three places when it was found:
  // the trajectory row's 用时, the trace panel's Duration row for a finding
  // (whose `timing.ms` is null by construction), and the mission header's
  // elapsed hint, which drew 上限 0 秒 for a run whose wall ceiling the mission
  // row does not carry. It is the header's `score ?? 0` one coercion earlier.
  //
  // THE ORDER IS THE ASSERTION. A guard written after the coercion is the same
  // bug with a comment over it.
  for (const opening of ["function missionDuration(", "function missionLatency("]) {
    const fn = code(body(opening));
    assert.match(
      fn,
      /if \(ms === null \|\| ms === undefined \|\| ms === ""\) return "";/,
      `${opening} formats whatever Number() makes of its argument again, so an absent duration is printed as nought`,
    );
    const guardAt = fn.indexOf("ms === null");
    const coerceAt = fn.indexOf("Number(ms)");
    assert.ok(
      guardAt !== -1 && coerceAt !== -1 && guardAt < coerceAt,
      `${opening} coerces before it guards, which is the same defect with a check written under it`,
    );
  }
  // AND THE ONE READER THAT DEPENDS ON IT. The trajectory row hands `row.ms`
  // straight to these two and lets the empty answer through; if either ever
  // starts saying "0s" again, that column is the first thing to lie.
  //
  // It was written against the stage tile, which draws its 用时 through
  // `line(…)` with the null test spelled out at the call site — so the string
  // it looked for was not in the file and the assertion could only fail.
  assert.ok(
    code(body("function MissionTraceRow(")).includes('const took = row.kind === "tool" ? missionLatency(row.ms, zh) : missionDuration(row.ms, zh);'),
    "the trajectory row stopped reading these two functions' own empty answer, so it now carries its own copy of the null test",
  );
});

test("the drawer's own shell ships on the sheet the page injects", () => {
  // THE SCREEN THAT RENDERED AS A BLOCK IN THE PAGE FLOW. `.swt-scrim` and
  // `.swt-drawer` carried position, ground, width cap, right edge and
  // elevation for EVERY drawer in this tab, and they shipped on TRACE_CSS —
  // injected by `ensureTraceStyle`, which is called from exactly two places:
  // MissionTrace and MissionStageDetail. Neither is on the path from 信源 or
  // from the task board to MissionDimensionDrawer, so a dimension opened
  // before anybody had touched a trajectory or a stage got an unstyled div,
  // and then got the real drawer for the rest of the session the moment they
  // did. A bug that fixes itself after one unrelated click is a bug nobody
  // can reproduce, which is why this is a source guard and not a bug report.
  for (const rule of [".swm-drawer-scrim{", ".swm-drawer{"]) {
    assert.ok(
      SHEET_RULES.includes(rule),
      `${rule} is not on the sheet the page injects before first paint, so a drawer opened from a screen that never touches the trajectory renders as a block in the page flow`,
    );
    assert.ok(
      !TRACE_RULES.includes(rule),
      `${rule} is back on the trajectory sheet, which two of the three drawer mount sites never inject`,
    );
  }
  // AND THE SHELL WEARS THEM. A rule on the right sheet with nothing wearing
  // it is the same blank screen with a passing test over it.
  const shell = code(body("function MissionDrawer("));
  assert.match(shell, /className: "swm-drawer-scrim"/, "the backdrop no longer wears the rule that fixes it over the page and pushes it right");
  assert.match(shell, /className: "swm-drawer"/, "the sheet no longer wears the rule that gives it a width, a ground, an edge and its elevation");
  assert.ok(
    !/swt-/.test(shell),
    "the drawer shell reaches back into the trajectory's namespace, which is the sheet it is the one component in this file that cannot count on",
  );
  // The two call sites that inject TRACE_CSS are still the only two, which is
  // the fact the move was made against — if a third ever appears the guard
  // above stops being about anything.
  assert.equal(
    code(SOURCE).split("ensureTraceStyle()").length - 1,
    3,
    "the number of ensureTraceStyle callers moved; the drawer shell was taken off that sheet precisely because two callers could not cover three mount sites",
  );
});

test("the stage drawer's figures are tiles, and an unstarted stage has none", () => {
  const drawer = code(body("function MissionStageDetail("));
  // CHIPS ARE FOR STATES. Three of the four figures were chips, so "11 model
  // calls" and "degraded" were the same object on one panel — and 用时 was
  // drawn twice, once as a chip and once as a `dd` two elements below it.
  assert.ok(drawer.includes("MissionStatTiles({ tiles: ["), "the step's figures are chips again, which is the shape this file reserves for a state");
  assert.ok(!drawer.includes('icon: "sparkles"'), "the tokens chip is back beside the tokens tile, which is the same figure twice on one panel");
  // THE EM DASH, AND THE FACT IT IS DERIVED FROM. `projectStages` seeds
  // `tokens: 0` and `calls: 0` on every stage and only ever ADDS the ledger's
  // sums, so neither is ever null and the old `=== null` guards were dead: a
  // pending stage drew "令牌 0 · 模型调用 0". This is the header's `score ?? 0`
  // again — a figure nobody measured, printed as a measurement.
  assert.match(
    drawer,
    /const started = stage\.startedAt !== null/,
    "nothing separates a 0 that is a measurement from the 0 projectStages seeds, so a stage that has not run reports having spent nothing",
  );
  for (const field of ["missionCompact(stage.tokens) : null", "String(stage.calls) : null"]) {
    assert.ok(drawer.includes(field), `${field} is drawn unconditionally, so an unstarted stage prints a seeded 0 where the file's own word for "not measured" is the em dash`);
  }
  // AND THE FIGURES ARE NOT RESTATED BELOW. The property list carried status,
  // attempts and 用时 as well; the same figure twice in one panel is the reader
  // checking whether they are the same figure.
  for (const row of ['line(zh ? "状态"', 'line(zh ? "尝试"', 'line(zh ? "用时"']) {
    assert.ok(!drawer.includes(row), `${row} is back in the property list beside the tile that replaced it`);
  }
  // THE STATE IS IN THE HEADER, where both other drawers on this screen put
  // theirs. It was a `dd` four elements down in the same grey as 开始 and 结束.
  assert.ok(
    drawer.includes('missionHue(MISSION_STAGE_STATUS_FACES, stage.status)'),
    "the drawer states the stage's status as grey text again, so the one thing a reader opens it to check is the least visible thing in it",
  );
});

test("the drawer's 用时 tile tests its own hole", () => {
  // THE OTHER THREE FIGURES ARE COUNTS THAT START AT ZERO AND MEAN IT.
  // `duration_ms` is the one that is genuinely nullable — `projectStages`
  // writes `r.duration_ms == null ? null : ...` — so the absence is real and
  // it arrives here.
  //
  // `missionDuration` answers "" for a null of its own since the em-dash
  // patch, and this test is at the tile anyway, deliberately: the tile is
  // where the VALUE IS CHOSEN, and one that depends on a helper three
  // thousand lines away to notice its own hole is a tile that starts lying
  // the moment that helper changes. It has changed once already.
  const drawer = code(body("function MissionStageDetail("));
  assert.ok(
    drawer.includes('value: stage.durationMs === null || stage.durationMs === undefined ? null : missionDuration(stage.durationMs, zh)'),
    "the 用时 tile hands a null straight to missionDuration, so its em dash is somebody else's promise",
  );
  // AND THE TINT IS FOR AN EXCEPTION, NOT FOR A ROW. Two of four tiles tinted
  // is not an exception, it is a pattern with two members — MetricStat's
  // docblock says the hue is for the figure that is the odd one.
  const strip = drawer.slice(drawer.indexOf("MissionStatTiles({ tiles: ["));
  const tinted = strip.slice(0, strip.indexOf("]")).split("tone: TONE.").length - 1;
  assert.equal(tinted, 0, `${tinted} of the four figure tiles are tinted; the hue is for the exception, and a row where two are exceptional has none`);
});

test("the dimension drawer's figures are tiles, and its box keeps only the argument", () => {
  const drawer = code(body("function MissionDimensionDrawer("));
  assert.ok(drawer.includes("MissionStatTiles({ tiles: ["), "the dimension's figures are prose again");
  // THREE FIGURES THAT WERE REACHABLE ONLY INSIDE SENTENCES, and two of those
  // only in the branch that runs when a dimension found NOTHING — so how much
  // it had read left the screen the moment it worked.
  for (const figure of ["counts?.total", "counts?.uniqueHosts", "axes.pagesFetched"]) {
    assert.ok(drawer.includes(figure), `${figure} is back inside a sentence, or gone: the drawer states a verdict and not what it was reached over`);
  }
  // A COUNT NOBODY STORED IS NOT NONE. The empty branch printed
  // `pagesFetched ?? 0`, which reads as "it fetched nothing" about a row whose
  // axes were never written.
  assert.ok(
    !/pagesFetched \?\? 0/.test(drawer),
    "the page count is defaulted to 0 again, which is a measurement about a dimension nobody measured",
  );
  // GUARDED ON `detail`. The findings route answers `dimension: null` AND swaps
  // `counts` for the MISSION-WIDE histogram when it cannot scope; drawing that
  // here prints the whole run's evidence under one dimension's name.
  assert.ok(
    drawer.includes("detail === null ? null : MissionStatTiles({"),
    "the strip draws whatever `counts` holds, so an unscoped read prints the whole mission's evidence under one dimension",
  );
  // AND THE BOX UNDER IT NO LONGER RESTATES THE SCORE IT IS EXPLAINING.
  assert.ok(
    !drawer.includes("This dimension's grade"),
    "the box opens by restating the figure in the tile above it, which is one number stated twice on one drawer",
  );
});

test("a permanent tile is never a permanent dash", () => {
  // The 抓取页数 tile was written to draw an em dash when `pagesFetched` is
  // absent, which is the right answer to "not recorded" and the WRONG SHAPE
  // here — because it is absent on every assessed mission, not on a rare one.
  // `gradeDimension` SETs `grade_axes` whole, and what s4 writes into it is
  // {verified, floor, uniqueHosts, unchecked}: no `pagesFetched` at all. So
  // the tile would be a dash always, and a strip of four with one permanent
  // hole is a strip of three that lies about being four.
  //
  // `MissionStatTiles` filters nulls, so a null TILE simply is not drawn.
  const drawer = code(body("function MissionDimensionDrawer("));
  assert.ok(
    /axes\.pagesFetched === undefined\s*\n?\s*\?\s*null\s*\n?\s*:\s*\{ label:/.test(drawer),
    "the pages-read tile draws a dash instead of standing down, so every assessed mission carries a hole in its figure strip",
  );
  assert.ok(!drawer.includes("pagesFetched ?? 0"), "an absent page count is coerced to zero, which reports 'read nothing' for 'never recorded'");
});

test("a step's rows are a sequence, and one row is not one", () => {
  // THE COMPLAINT UNDERNEATH: the stage drawer reused the trajectory's row,
  // which is right, inside a container the row was never measured for. That
  // row is eight FIXED columns — 24 + 64 + 96 + 132 + 12 + 72, seven 12px gaps
  // and 18px of padding, 502px before a character of content. `.swt-drawer` is
  // capped at 672 and the section is inset 14, so the two ELASTIC columns
  // share 142px: the arguments get ~95px and the result ~47px. The two columns
  // that answer "what did this step actually do" are the two that vanish.
  assert.ok(SOURCE.includes("function MissionRail("), "the rail is gone and a stage's steps are a flat stack again");
  const rail = code(body("function MissionRail("));

  // THE SPINE IS THE CONTAINER'S, and it is the whole difference between a
  // sequence and a stack. A per-card left border draws the line through the
  // first dot and past the last one instead of between them.
  const spine = TRACE_RULES.split("\n").find((line) => line.includes(".swt-rail:before{"));
  assert.ok(spine, "the rail has no spine, so its dots are bullets");
  assert.ok(spine.includes('content:""'), "the spine is not a pseudo-element, so it is a border on something");

  // ONE END. A lone card beside 12px of hairline is a rule that reaches
  // nothing, and there is nothing for it to connect.
  assert.ok(rail.includes("list.length === 1"), "a single-row step still draws a spine between it and nothing");
  assert.ok(
    TRACE_RULES.includes('.swt-rail[data-solo="true"]:before{display:none}'),
    "the solo attribute is set and never read, so switching the spine off does nothing",
  );

  // THE OTHER END. Two hundred cards at their natural height is a scroll
  // nobody can use; `clampBox` is this file's one three-property spell for
  // capping lines and the whole string stays reachable on the hover.
  const row = code(body("function MissionTraceRow("));
  const branch = row.slice(row.indexOf("if (rail === true) {"));
  assert.ok(branch.length > 0, "the rail layout is gone from the row, so the rail has nothing to draw");
  assert.ok(branch.includes("clampBox("), "the rail's text boxes are uncapped, so one long payload is the whole drawer");
  assert.ok(branch.includes("title: said"), "a clamped box with no title is a truncation the reader cannot get past");
  // AND IT WINDOWS NOTHING. A second cap here is a second answer to "is this
  // all of it", and the caller already prints the one the route gave it.
  assert.ok(!rail.includes(".slice("), "the rail caps its own list, so it and MISSION_STAGE_TRACE_TAKE can disagree about how much was withheld");

  // A SECOND LAYOUT, NOT A SECOND RENDERER. Every field either shape draws is
  // derived ABOVE the branch, once — which is what makes "one renderer" a
  // property of the source rather than a promise in a comment.
  for (const derived of ["const name =", "const kindHue =", "const verdict =", "const took =", "const band ="]) {
    const at = row.indexOf(derived);
    assert.ok(at !== -1, `${derived} is gone from the row`);
    assert.ok(at < row.indexOf("if (rail === true) {"), `${derived} is computed inside one layout, so the other one has its own copy`);
  }
  // AND THE BAND IS DRAWN FROM THAT ONE COPY. `MISSION_WARN_MS`'s own docblock
  // is about two screens disagreeing over what slow means; two branches of one
  // component is the same defect at closer range.
  assert.equal(
    row.split("MISSION_SLOW_MS").length - 1,
    1,
    "the slow threshold is read in more than one place inside one row component",
  );

  // THE OFFSET IS NOT COMPUTED A SECOND TIME. `missionSince` against the
  // anchor the caller was handed is this file's one answer to "how far in";
  // subtraction anywhere in this component is a second one.
  assert.ok(!row.includes("Date.parse("), "the row parses instants itself, which is a second derivation of the offset missionSince already owns");
  assert.ok(branch.includes("missionSince(row.at, anchor, zh)"), "the rail prints a wall clock only, so `how far into the run` is subtraction done by hand");
  assert.ok(
    branch.indexOf("missionSince(") < branch.indexOf("missionClock("),
    "the rail prints the clock before the offset; the flex row and the event stream both print the offset first, and a shape that reorders the facts is a second screen to learn",
  );

  // AND THE CARD IS NOT A BOX AT REST. Same rule the list rows already carry:
  // separation costs a line, not a fill, or twenty cards down a drawer is the
  // "hundred grey cards" complaint again.
  const card = TRACE_RULES.split("\n").find((line) => line.includes(".swt-ev{"));
  assert.ok(card, "the rail card lost its rule");
  assert.ok(card.includes("background:transparent"), "the rail card paints a ground, so a step reads as a stack of grey boxes");
  assert.ok(card.includes("border:1px solid transparent"), "the card's hover border is added rather than coloured, so every row shifts a pixel under the pointer");
});

test("a section that folds still says how much is inside it", () => {
  const panel = code(body("function MissionPanel("));
  const signature = /function MissionPanel\(\{([^}]+)\}/.exec(SOURCE);
  assert.ok(signature, "MissionPanel no longer destructures its props");
  assert.ok(signature[1].includes("collapsible"), "the panel cannot fold, so the drawer's twenty rail cards push four blocks below the fold with no way to shut them");
  // A PROP WITH A CALLER, which is the rule that kept it out until now. The
  // docblock's sentence is about WHEN, not whether.
  assert.ok(code(SOURCE).includes("collapsible: true"), "`collapsible` is declared and nothing passes it, which is the next geometry rather than a feature");
  assert.ok(!signature[1].includes("defaultOpen"), "`defaultOpen` came in beside it with no caller; a section that arrives shut is a section the reader has to discover");
  assert.ok(panel.includes("useState(true)"), "the panel starts folded, so the step's rows are hidden from a reader who never asked for them to be");

  // THE FOLD NEEDS A HANDLE, AND THE HANDLE IS THE HEADING. A panel with a
  // count and an action but no title has nothing to press.
  assert.match(
    panel,
    /const folds = collapsible === true && title !== undefined/,
    "a title-less panel can be asked to fold, which draws a chevron beside a number with nothing naming what it shuts",
  );
  assert.ok(panel.includes('name: open ? "chevronDown" : "chevronRight"'), "the chevron does not turn, so the control says nothing about which way it is");
  assert.ok(panel.includes('"aria-expanded": open'), "the fold's state reaches the pixels and not the accessibility tree");

  // THE COUNT SURVIVES THE FOLD, and that is the only reason folding is not
  // hiding: shut, the heading still answers "how much is in there". Positional,
  // because the count is a sibling in the header bar and the body is what the
  // fold gates — moving the badge inside the fold is the regression.
  const head = panel.indexOf('}, "head")');
  const gate = panel.indexOf("folds && !open");
  assert.ok(gate !== -1, "nothing is gated on the fold, so the chevron is decoration");
  assert.ok(head < gate, "the count is inside the folded region, so a shut section says nothing about what it is holding");
  assert.match(panel, /folds && !open \? null : jsx\("div", \{ children \}/, "the body is hidden rather than dropped, so twenty subtrees are still reconciled on every poll of the screen above them");

  // AND THE DRAWER PASSES A COUNT THAT IS A MEASUREMENT. Nought before the
  // rows are in is a number nobody took — the same distinction the three
  // states under it draw in words.
  const drawer = code(body("function MissionStageDetail("));
  assert.ok(!drawer.includes('"didHead"'), "the section heading is a loose paragraph again, so the count has nowhere to sit and the block cannot fold");
  assert.ok(
    drawer.includes("count: steps === null ? undefined : steps.length"),
    "the drawer prints 0 while the read is still out, which says the step did nothing and is a claim the page has not checked",
  );
});

test("the rail is the only thing that draws a step's rows", () => {
  // THE MUTATION THAT SURVIVED, AND WHY IT MATTERED. The rail guard asserts
  // `drawer.includes("MissionRail({")`, which stays true when the flat stack
  // is put back IN FRONT of it:
  //
  //   : steps.map((row) => jsx(MissionTraceRow, {…})) || MissionRail({…})
  //
  // The rail is still named, still in the source, and never renders. A guard
  // that a dead tail satisfies is a guard on a string, not on behaviour —
  // which is exactly the class of hole this file's mutation runs exist for,
  // and it took an audit's own mutation to find this one.
  const drawer = code(body("function MissionStageDetail("));
  assert.ok(drawer.includes("MissionRail({"), "the stage drawer stopped using the rail");
  assert.ok(
    !/jsx\(MissionTraceRow,/.test(drawer),
    "the stage drawer renders trajectory rows directly again; the rail is what places them in a sequence, and a second renderer beside it means whichever comes first wins",
  );
});

test("the drawer has one heading device, and it is MissionPanel", () => {
  // The audit proposed a `TraceSectionHead` — "a title, a count badge and a
  // right-hand context". That component already exists: MissionPanel's
  // docblock opens "A section heading that is actually a header: a rule, a
  // count and a slot for whatever the panel wants on the right", its
  // signature already takes `count` and `action`, and `bare` exists precisely
  // so a panel inside a drawer drops the card and keeps the heading.
  //
  // So the class was retired instead of a fourth one added. `.swt-secthead`
  // was a hand-rolled `p` with a font-weight, and it was the third heading
  // device in one drawer.
  // `code(SOURCE)`, NOT `SOURCE`. Two comments in the drawer record that the
  // class was retired and why, and a guard that reads the prose is a guard
  // that fires on its own explanation — the third time in this file that a
  // check has matched the sentence describing the thing instead of the thing.
  assert.ok(!code(SOURCE).includes("swt-secthead"), "`.swt-secthead` is back: a hand-rolled heading beside MissionPanel, which is the component it duplicates");
  assert.ok(!SOURCE.includes("TraceSectionHead"), "a second section-heading component exists beside MissionPanel");
  // The one call site it had reads as a panel now, with its amber quote inside.
  const drawer = code(body("function MissionStageDetail("));
  assert.match(drawer, /MissionPanel\(\{\s*\n?\s*bare: true,\s*\n?\s*title: zh \? "降级说明"/, "the degradation note lost its heading, so the sentence a degraded stage wrote about itself is an unlabelled amber block");
});

test("a citation with nothing behind it is not drawn like one that holds up", () => {
  // THE RULE THIS FILE ALREADY STATES, enforced one level below where it was
  // written. `missionCitationMark` splits a marker on `has(index)` — is this
  // number in the reference list at all — and `missionReferences` deliberately
  // KEEPS an index that joined no frozen evidence row so the list can say so in
  // TONE.warn. So `[7]` with nothing behind it passed `has`, came out the same
  // accent blue as a quote taken verbatim off a live page, and the reader's
  // only warning sat in the bibliography they have to scroll to in order to be
  // warned. The prose disagreed with its own reference list, which is the exact
  // shape of a fabricated citation on screen.
  const peek = code(body("function MissionCitationPeek("));
  assert.match(
    peek,
    /const broken = source\?\.joined === false;/,
    "the marker no longer reads the join, so a citation that resolved to no evidence is accent blue again",
  );
  assert.match(
    peek,
    /color: broken \? `rgb\(\$\{TONE\.warn\}\)` : "var\(--dsw-alias-state-business-primary\)"/,
    "an unresolvable citation is drawn in the accent, which is the colour this file spends on a source that IS one click away",
  );
  // AND THE CARD SAYS WHICH OF THE TWO IT IS. `missionFace` answers "" for a
  // null verify state — MISSION_VERIFY_FACES has nine keys and none of them is
  // "" — so the head drew an empty neutral pill in a card that opened in order
  // to say something.
  assert.match(
    peek,
    /broken \? jsx\("span", \{/,
    "the hover card still puts an empty chip where the verdict would be, which is the one thing worse than no card",
  );
  // The jump SURVIVES in both states: the row is where the full sentence is,
  // and a marker that stopped being pressable would remove the route to the
  // explanation at the moment there is something to explain.
  assert.match(peek, /onClick: \(\) => \{ refs\.jump\?\.\(index\); \},/, "a broken citation lost its jump, so the row that explains it is unreachable from the prose");

  // A CHAT ANSWER HAS NO CITATION TABLE, so nothing in it can be missing from
  // one. `refs` is null there, `has` is undefined, and every `[3]` a model typed
  // in the panel was labelled "Citation metadata missing: nothing was stored
  // behind this number" — a sentence about a report that does not exist.
  const mark = code(body("function missionCitationMark("));
  assert.match(
    mark,
    /if \(refs === null \|\| refs === undefined\) return token;/,
    "a bracketed number in a chat answer is accused of missing citation metadata again, which is the renderer stating provenance it was told nothing about",
  );
  // The UNKNOWN branch is still the grey one: an index the report never issued
  // is a hole in the record, and it is not the same hole as one it issued and
  // could not back.
  assert.ok(mark.includes("INK.quiet"), "the unknown-citation branch lost its grey, so a number the report never issued looks like a working link");
});

test("a chapter's number is the chapter list's number, or there is no number", () => {
  // The reference numbers its headings — "2. RSI边界与术语", then "2.1. 术语谱系…"
  // — and a number that disagrees with the list two inches above it is worse
  // than no number at all, because the list is how a reader gets back to it.
  //
  // So the number is not COUNTED here. It is read off `artifact.sections`, the
  // same array `MissionReport`'s nav numbers `String(at + 1)` over, and issued
  // only to an h2 that matches the section the table expects in that position.
  // `sanitizeBody` strips only a heading that REPEATS the chapter's own and
  // `contentGuard` only asserts each section STARTS with its heading, so a
  // writer's own `##` reaches this renderer intact — and a running counter
  // would hand it chapter seven's number and every chapter after it the wrong
  // one.
  const markdown = code(body("function renderMarkdown("));
  assert.match(
    markdown,
    /const expected = numbering\.table\[numbering\.taken\];/,
    "the section number is counted in the renderer again rather than read off the table the chapter list numbers, so the prose and the list are two opinions about one document",
  );
  assert.match(
    markdown,
    /expected !== undefined && expected\.heading === heading\[2\]/,
    "an h2 takes a number without being checked against the section it claims to be, so a stray `##` inside a chapter body is drawn as the next chapter",
  );
  // AND DOES NOT ADVANCE THE CURSOR. Numbering the stray is one defect; letting
  // it consume a slot is the same defect once per chapter after it.
  //
  // Written against the CURSOR rather than against the line that used to sit
  // beside it. This assertion read `indexOf("numbering.taken += 1") <
  // indexOf("numbering.chapter = null;")`, and the branch it was watching no
  // longer sets the chapter to null — a stray h2 is a sub-heading now, not a
  // nothing — so the guard was holding a landmark instead of a guarantee.
  const branch = markdown.slice(markdown.indexOf("if (numbering !== null && level === 2)"));
  const advances = [...branch.matchAll(/numbering\.taken \+= 1/gu)];
  assert.equal(advances.length, 1, `the cursor is advanced in ${advances.length} places inside the level-2 branch; one stray heading then shifts every number after it off the list`);
  assert.ok(
    advances[0].index < branch.indexOf("} else if (numbering.chapter !== null) {"),
    "the cursor is advanced outside the arm that matched a section, so a heading the table never vouched for consumes a chapter's number",
  );

  // A STRAY h2 IS A SUB-HEADING, NOT A CHAPTER AND NOT NOTHING.
  //
  // MEASURED ON THE FINISHED MISSION: eight chapters, THIRTY `##` headings.
  // `assemble` writes exactly one per chapter, so twenty-two came from inside
  // the chapter bodies — and they were drawn unnumbered AT CHAPTER SIZE, which
  // is honest about what they are not and silent about what they are. Thirty
  // things that look like chapters, beside a list with eight rows in it.
  assert.match(
    markdown,
    /\} else if \(numbering\.chapter !== null\) \{[\s\S]{0,900}?level = 3;[\s\S]{0,200}?numbering\.sub \+= 1;/u,
    "an h2 the section table does not hold is drawn at chapter size again, so a reader cannot tell a chapter from a heading inside one",
  );

  // AND THE WRITER'S OWN ORDINAL COMES OFF. It numbered its sub-headings three
  // different ways in one report — `一、` eight times, `1. ` seven times, and
  // not at all seven times — none of which agreed with the number the report
  // derives. Two numberings on one heading is one of them being wrong.
  assert.match(SOURCE, /const WRITER_ORDINAL = /u, "nothing strips the writer's own ordinal, so its number and the report's are printed side by side");
  assert.match(markdown, /heading\[2\]\.replace\(WRITER_ORDINAL, ""\)/u, "the heading is drawn with whatever number the writer put in front of it");
  assert.ok(
    !/renderInline\(heading\[2\]/u.test(markdown),
    "the heading is still drawn from the raw text, so stripping the ordinal changed nothing a reader can see",
  );

  // A SUB-HEADING HANGS OFF A CHAPTER THAT HAS ONE. `numbering.chapter` is null
  // for an h2 the table did not vouch for, and "null.1." under it would be the
  // renderer printing its own bookkeeping into the report.
  assert.match(
    markdown,
    /level === 3 && numbering\.chapter !== null/,
    "a sub-heading is numbered under a chapter the section table never confirmed",
  );

  // THE SEED, which is what makes the chapter view agree with itself: the slice
  // starts at `readSections[readAt].start`, so its one chapter is `readAt + 1`.
  const report = code(body("function MissionReport("));
  assert.match(
    report,
    /\[\{ number: readAt \+ 1, heading: String\(readSections\[readAt\]\.heading \?\? ""\) \}\]/,
    "the chapter view restarts the numbering at 1, so chapter nine is drawn as chapter one while the list beside it still says nine",
  );
  assert.match(
    report,
    /readSections\.map\(\(section, at\) => \(\{ number: at \+ 1, heading: String\(section\.heading \?\? ""\) \}\)\)/,
    "the continuous view is handed no section table, so the report's own prose is the one reading with no numbers in it",
  );
});

test("the report's headings carry the accent, and only the report's", () => {
  const markdown = code(body("function renderMarkdown("));
  assert.match(
    markdown,
    /color: numbering === null \? INK\.primary : "var\(--dsw-alias-state-business-primary\)"/,
    "the article's headings are back in body ink, so a thirty-thousand-word report is one column of one colour and its chapters read as paragraphs",
  );
  // SCOPED, and the scope is the point. `MissionSourceReader` renders a FETCHED
  // page through this same `article` variant; tinting its headings would be
  // this file painting somebody else's document in our report's colour.
  assert.ok(
    !/color: article \?[^\n]*state-business-primary/.test(markdown),
    "the accent went on every article read, so a source page opened from a quote is repainted as if it were our report",
  );

  // THE HUE IS THE RAMP'S, IN BOTH THEMES. The guard above holds every `--swm-h-*`
  // to the reference's 700 step light and 400 dark; a heading colour off that
  // step would be the eleventh colour on a page that has ten, and it would be
  // the largest text on the screen.
  const theme = SOURCE.slice(SOURCE.indexOf("const SWM_THEME"), SOURCE.indexOf("const SWM_SHEET"));
  const declared = [...theme.matchAll(/"--dsw-alias-state-business-primary:(#[0-9a-f]{6});"/g)].map(([, hex]) => hex);
  assert.deepEqual(
    declared,
    ["#6d28d9", "#a78bfa"],
    "the accent is no longer violet-700 light / violet-400 dark, so the heading tint is off the one ramp — and #6d28d9 measures 7.11:1 on white and #a78bfa 6.52:1 on #111827, which is the budget a heading in it was chosen against",
  );
});

test("the report says where its citations come from, and never invents a site", () => {
  // A bibliography prints in the order the prose numbers it, which is the one
  // order that hides concentration: five entries from one host at [3], [17],
  // [22], [40] and [48] read down the column as five sources. Both halves of
  // the answer were already on this side of the wire — `missionReferences`
  // joins `artifact.citations` to `artifact.evidence` on `findingId`, and the
  // host on every joined row is `mission_findings.source_host` frozen into the
  // artefact at s12 — and the pane spent the whole of it as a four-word hint
  // on one tile. This is that join, drawn.
  assert.ok(SOURCE.includes("function MissionEvidenceSpread("), "the evidence-spread figure is gone");
  const figure = code(body("function MissionEvidenceSpread("));

  // THE HOST IS READ, NEVER DERIVED. `missionReferences` already falls back to
  // `hostOf(url)` once, for an index the evidence blob does not carry; a
  // second fallback here would silently re-home the citations the first one
  // gave up on, and a guessed host is indistinguishable on screen from a
  // measured one — the trade `#libraryFactsFor` refuses one file away.
  assert.ok(figure.includes("entry.host"), "the figure stopped reading the host off the reference row");
  assert.ok(
    !figure.includes("hostOf("),
    "the figure derives a host of its own, so a citation the join could not place is drawn as if it had been placed",
  );

  // AND A CITATION WITH NO HOST IS ITS OWN ANSWER, not a site named "". "We
  // cannot tell where this came from" and "one more page on this site" are
  // different sentences and only one of them is about sourcing.
  assert.ok(
    figure.includes('entry.host === "" ? null :'),
    "a citation whose frozen evidence carries no source_host is bucketed as a site called empty-string, so it sorts into the chart as though it were one",
  );

  // NOTHING IS DROPPED FOR SPACE. Eight bars and then a line carrying the
  // tail's own count: a chart that quietly ends at eight reports a NARROWER
  // evidence base than the run has, which on this figure is the one direction
  // the error must never go.
  assert.match(
    figure,
    /const folded = named\.slice\(8\);/,
    "the host list is truncated instead of folded into a row that still carries its count",
  );
  assert.ok(
    figure.includes("folded.length === 0 ? null :"),
    "the remainder line is drawn on a run that has no remainder, which prints 另外 0 个站点 — the same defect as the chip that printed three zeros on a clean section",
  );

  // THE BAR IS THE ONE BAR. Five hand-drawn tracks is what `Meter` replaced,
  // and a chart is the most tempting place in this file to draw a sixth.
  assert.ok(figure.includes("Meter({"), "the figure draws its own track");

  // THE SCALE IS THE BIGGEST BAR AND THE SHARE IS SAID IN WORDS. Against the
  // total, eighteen hosts draw eighteen stubs and the distribution — the whole
  // reason to draw this rather than print the host count — disappears.
  assert.ok(
    figure.includes("max: widest"),
    "every bar is measured against the citation total again, so a well-sourced report draws a row of stubs and reads as a broken chart",
  );

  // THE CAPTION IS THE CLAIM, in the counts the bars are drawn from, so a
  // reader who doubts the sentence can check it against the rows underneath.
  // A caption reading 引用来源分布 is a title and tells them nothing they
  // cannot already see.
  assert.ok(
    figure.includes("named[0].cites"),
    "the caption stopped stating the top host's own count, so it is a title again rather than the finding the figure is evidence for",
  );

  // MOUNTED, and from the same array as the list below it: two host counts on
  // one page is the shape this file has paid for four times.
  assert.match(
    code(body("function MissionReport(")),
    /jsx\(MissionEvidenceSpread, \{ references, zh \}, "spread"\)/,
    "the figure exists and nothing mounts it, which is the state the projector's own `chapters` key sat in for a release",
  );
});

test("a chapter card shows the chapter's own opening words", () => {
  // The reference's 章节视图 is a list of CARDS: a mark, "第 9 章: 北美创业公司版图",
  // and THREE CLAMPED LINES of the chapter's own opening text. Ours was a table
  // of contents — one line, an ordinal, a heading, two figures — so a reader
  // choosing between ten chapters could only choose between ten titles.
  //
  // AND THE PREVIEW IS NOT A NEW FIELD. `sections[i].start/end` are offsets into
  // the markdown this component already holds for `readSlice`, written by
  // `assemble`, asserted there against the string they index, and re-checked by
  // contentGuard's section-offset test. A `preview` column written by s12 would
  // be a second copy of those words crossing the store, the projection and the
  // route — the hop-by-hop defect this file exists to catch — and it would be
  // missing from every artefact already on disk.
  assert.ok(SOURCE.includes("function missionChapterPreview("), "the preview is gone, so the chapter list is a table of contents again");
  const preview = code(body("function missionChapterPreview("));
  assert.match(preview, /section\?\.start/, "the preview no longer cuts at the section's own offset, so it previews the whole report or the wrong chapter");
  assert.ok(!/\.preview/.test(preview), "the preview reads a stored field: a second copy of the chapter's opening that no offset check covers");
  assert.match(preview, /start \+ 1200/, "the preview cleans the whole chapter — twenty thousand characters through four regexes, once per row, on every click");

  const report = code(body("function MissionReport("));
  assert.ok(report.includes("missionChapterPreview("), "the chapter list draws no preview");
  assert.ok(report.includes("clampBox(3)"), "the preview is unclamped, so one chapter's opening paragraph pushes the next nine cards off the screen");
  assert.match(report, /第 \$\{at \+ 1\} 章/, "the card lost its ordinal, which is how a reader refers to a chapter at all");
  // AND THE TWO FIGURES SURVIVE THE REDRAW. They are the section's own columns
  // and the only per-chapter numbers this screen has ever carried.
  assert.ok(report.includes("section.wordCount"), "the word-count chip is gone, and it is the one figure that says what a chapter costs to read");
  assert.ok(report.includes("section.citationCount"), "the chapter list drops the citation count, which is why a reader picks one");
});

test("the mark on a chapter card is a measurement, not a tick on every row", () => {
  // The reference draws a green tick on every chapter in the list. On our data
  // that mark would say nothing: a chapter that reached the artefact was
  // assembled by definition, so a tick on all of them is decoration a reader
  // reads as a verdict — the same clean bill the empty-scorecard branch in this
  // very component refuses to give a report nobody checked.
  //
  // WHAT WE DO HOLD PER CHAPTER is the citation join. `assemble` stamps every
  // citation with the `dimensionId`/`chapterIndex` it came from, and the frozen
  // evidence rows carry `verifyState`. So the mark counts how much of THIS
  // chapter held up — which is also the one thing the scorecard above cannot
  // say. Its docblock splits by section TYPE precisely so that "chapter seven
  // cites nothing" stays visible, and the card is where it becomes visible.
  assert.ok(SOURCE.includes("function missionChapterVerified("), "the per-chapter verified count is gone, so the card's mark has nothing behind it");
  const marks = code(body("function missionChapterVerified("));
  assert.match(marks, /chapterIndex/, "the count no longer keys on the chapter a citation belongs to, so every chapter is drawn with the whole report's number");
  assert.match(marks, /startsWith\("verified"\)/, "the count stopped reading the verify state, so a rate-limited fetch counts as a checked quote");

  const report = code(body("function MissionReport("));
  assert.match(
    report,
    /missionRateHue\(verified, section\.citationCount\)/,
    "the chapter mark takes a fixed hue, so a chapter whose citations all failed is drawn exactly like one whose citations all held",
  );
  assert.match(
    report,
    /name: section\.citationCount === 0 \? "minus" :/,
    "the glyph is unconditional, which is the reference's decorative tick reintroduced as a verdict",
  );
  assert.match(
    report,
    /section\.citationCount === 0 \? TONE\.neutral/,
    "a chapter that cites nothing is graded, and 0/0 grades green: the one reading the scorecard exists to refuse",
  );
});

test("the report's toolbar carries what we hold, and refuses the control we do not", () => {
  // The reference's report toolbar is a segmented control on the left and FOUR
  // controls on the right: 报告分析 (51), 版本历史 (v1), 导出报告, 原始数据.
  //
  // TWO OF THE FOUR ARE ONE FRAME UP AND STAY THERE. 导出报告 and 原始数据 are
  // `report.md` and `report.json` in MissionDetail's 导出 menu, and MissionReport's
  // own docblock records the reason: the version on screen has to ride in the
  // query, and a second download control in the pane is a second place for a
  // reader looking at v1 to be handed v3.
  //
  // ONE OF THE FOUR WE DO NOT HAVE AT ALL. 报告分析 counts 51 of something this
  // pipeline does not produce — there is no analysis table among the fifteen in
  // lib/mission-store.js and no artefact field with a count that means it.
  // Pointing the control at `citations.length` or `evidence.length` would be a
  // label attached to the nearest available number, and both of those are
  // already printed in the meta line. An empty control is worse than none.
  const report = code(body("function MissionReport("));
  assert.ok(!report.includes("报告分析"), "报告分析 is back, and nothing in this pipeline produces the number it would carry");

  // AND THE ONE WE DO HOLD MOVED INTO THE TOOLBAR. `listArtifactVersions` is
  // 版本历史; its chips used to sit in a band of their own above the title, which
  // that block's own comment already described as a pill parked at the far right.
  assert.match(report, /versions\.length <= 1 \? null : jsxs\("div"/, "the version switcher is not in the toolbar");
  assert.ok(
    !report.includes("back === null && versions.length <= 1"),
    "the version band above the title is back, so the report has two version controls or one three blocks from the prose it changes",
  );
  // AND THE STRIP IS NOT THE ROW'S ONLY REASON TO EXIST. A one-chapter report
  // with three versions had nowhere at all to put its switcher.
  assert.match(
    report,
    /readSections\.length < 2 && versions\.length <= 1 \? null/,
    "the toolbar disappears on a single-chapter report, taking the version switcher with it",
  );
  // AND THE META LINE NAMES THE VERSION, ALWAYS. It printed the version only
  // when there was exactly one, on the reasoning that the chips said it
  // otherwise — and with the chips below the scorecard that left the top of a
  // three-version report naming every fact about the artefact except which one.
  assert.ok(
    !report.includes('versions.length > 1 ? "" :'),
    "the meta line drops the version whenever there is more than one, which is exactly when a reader needs it",
  );
});

test("the interactive accent is violet, and it is the ramp's violet", () => {
  // WHAT WAS MEASURED, AND WHY IT WAS NOT VISIBLE FROM ANY ONE LINE.
  // `--dsw-alias-state-business-primary` held #1d4ed8 light and #60a5fa dark.
  // `--swm-h-blue` holds 29,78,216 and 96,165,250. Those are the same two
  // colours written in two syntaxes, so the name that draws the tab underline,
  // three strips' active labels, five focus rings, both selected-row margin
  // marks, the citation marker, the markdown anchor and every chapter heading
  // was byte-identical to ROLE_TONE.researcher — and the researcher is the role
  // the board prints MOST, because mission-view mints one
  // `researcher:<dimensionId>` per dimension while `leader` owns 3 of the 12
  // rows in STAGES. Nothing threw, nothing looked broken, and "you are here"
  // and "a researcher owns this" were one colour on every screen that has both.
  //
  // The reference is violet there, and this file had ALREADY written that down
  // without spending it: the palette test above reads "violet for the accent
  // where ours was the harness blue".
  const theme = SOURCE.slice(SOURCE.indexOf("const SWM_THEME"), SOURCE.indexOf("const SWM_SHEET"));
  const hexes = (name) => [...theme.matchAll(new RegExp(`"${name}:(#[0-9a-f]{6});"`, "g"))].map(([, value]) => value);
  const triple = (value) => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)).join(",");

  // ONE COLOUR, TWO SPELLINGS, AND THIS IS THE ONLY THING BETWEEN THEM.
  // SWM_THEME must spell a hex (it is a CSS declaration) and SWM_CSS must spell
  // a triple (every consumer builds `rgba(hue,alpha)` out of it, which a var
  // holding a finished colour cannot do). So `TONE.accent` and the accent alias
  // are the same violet by hand, and without an assertion they are two violets
  // one redesign apart — the exact drift the ramp exists to prevent, reopened
  // at the one name the ramp does not cover.
  const accent = hexes("--dsw-alias-state-business-primary");
  assert.equal(accent.length, 2, `the accent is declared ${accent.length} times; it needs one value per theme`);
  assert.equal(triple(accent[0]), declared("light").get("violet"), "the light accent is off `--swm-h-violet`, so the tab underline and TONE.accent are two different violets fourteen pixels apart");
  assert.equal(triple(accent[1]), declared("dark").get("violet"), "the dark accent is off `--swm-h-violet`, so the tab underline and TONE.accent are two different violets");

  // AND IT IS NOT THE ROLE HUE. This is the finding itself: an accent equal to
  // a role hue makes chrome and content one colour, and blue is the role hue
  // that appears most.
  assert.notEqual(triple(accent[0]), declared("light").get("blue"), "the accent is the harness blue again — exactly `--swm-h-blue`, which is the researcher's colour on every trajectory row, every owner cell and every roster chip");
  assert.notEqual(triple(accent[1]), declared("dark").get("blue"), "the dark accent is the harness blue again — exactly `--swm-h-blue`");

  // A LINK IS ONE ACT, SO IT IS ONE HUE. Two of the three link-ish sites read
  // the accent; the third — a source card's URL — reads `--dsw-alias-label-link`.
  // They held one value by coincidence. They hold it by assertion now, so an
  // accent move cannot leave a URL behind in the colour the accent just left.
  assert.deepEqual(hexes("--dsw-alias-label-link"), accent, "a link and a citation marker are two colours for one act: one of `--dsw-alias-label-link` and `--dsw-alias-state-business-primary` moved and the other did not");
});

test("a lane in the trajectory plot is a kind, never the accent", () => {
  // FOUR LANES, AND ONLY THREE OF THEM NAMED AS CONTENT. `finding`, `tool` and
  // `bad` read the harness's success / warn / error aliases — state names, for
  // marks that report state. `stage` read `--dsw-alias-state-business-primary`,
  // which is the name the tab underline and every focus ring read.
  //
  // That was never a shade problem; it was a wiring problem, and it only had a
  // symptom once somebody moved the accent. A span in a chart is a KIND. Wired
  // to the interactive name it is repainted by decisions about underlines — and
  // the violet it would have taken is ROLE_TONE.leader, so the stage lane and
  // the Leader's chip would have become one colour on the pane that shows both.
  const lanes = TRACE_RULES.split("\n").filter((line) => line.includes(".swt-span[data-tone="));
  assert.equal(lanes.length, 4, `the plot draws ${lanes.length} lanes; it has four kinds to draw`);
  for (const lane of lanes) {
    assert.ok(
      !lane.includes("state-business-primary"),
      `a plot lane is painted in the interactive accent: ${lane.trim()}. A span in a chart is a KIND, and a kind wired to the accent changes colour whenever a decision about chrome is taken`,
    );
  }
  assert.ok(
    lanes.some((lane) => lane.includes('data-tone="stage"') && lane.includes("rgb(${TONE.info})")),
    "the stage lane stopped naming its own hue. It is the one lane with no state alias behind it, so TONE is the only thing that can hold it to the ramp",
  );
});

test("the re-run is offered in the colour of an action, not the colour of running", () => {
  // MEASURED ON ONE ROW. A running dimension row printed three tinted chips
  // inside about 300 pixels: 重跑 at TONE.info, 运行中 at TONE.info
  // (MISSION_STAGE_STATUS_FACES.running), and the owner's RoleChip at
  // ROLE_TONE.researcher — which is PALETTE.blue, the same triple TONE.info
  // resolves to. Three chips, three meanings, one colour.
  //
  // THE CONTROL IS THE ONE THAT MOVES, and the rule says why: it is the only
  // one of the three that is CHROME — a thing you press. The status and the
  // owner are facts about the row and keep the hues that identify them. The
  // reference draws its 重跑 violet-tinted for the same reason.
  //
  // IT IS ALSO REQUIRED BY THE ACCENT MOVE. `看轨迹 →` in the same cell reads
  // `--dsw-alias-state-business-primary`; leaving 重跑 on TONE.info would put
  // two controls two pixels apart in two colours, which is worse than the
  // ambiguity it replaced.
  const board = code(body("function MissionTaskBoard("));
  assert.match(
    board,
    /tone: TONE\.accent,\s*icon: "refresh",\s*label: zh \? "重跑"/,
    "the re-run chip is drawn in TONE.info again — the same tint as the 运行中 chip beside it, the same tint as the researcher chip beside that, and a different colour from the 看轨迹 link it shares a cell with",
  );
  // The DRAWER's re-run stays neutral on purpose: it spends its colour on the
  // stage that degraded, and the board's cell has no such budget. So this is
  // scoped to the board, not asserted file-wide.
  assert.equal(
    [...board.matchAll(/tone: TONE\.accent,\s*icon: "refresh"/g)].length,
    1,
    "the board draws more than one accent re-run chip, which means the row's action is being offered twice",
  );
});

test("the trajectory's rows touch, so the line between them is the line", () => {
  // A LIST IS ROWS SEPARATED BY A LINE — the rule this file already states,
  // and the one thing that was still stopping it from reading that way. Two
  // declarations, written a batch apart, cancelled each other: `.swt-row` took
  // `border-bottom:1px solid` when the row stopped being a card, and
  // `.swt-list` kept a `gap:2px` from when it was one. A hairline in the
  // middle of a two-pixel gutter is not an edge, and the hover fill lit a 38px
  // band with a stripe of page above and below it.
  //
  // AND IT IS THE DENSITY THIS BATCH GIVES BACK. The pane renders
  // MISSION_TRACE_TAKE rows — 120 — so the gap cost 119 gutters and 238px of
  // scroll on the screen that carries a mission's thousand records.
  const line = (needle) => SOURCE.split(String.fromCharCode(10)).find((row) => row.includes(needle));
  const list = line(".swt-list{");
  assert.ok(list !== undefined, "the trajectory list rule is gone");
  assert.ok(
    !/gap:/.test(list),
    "the trajectory list separates its rows with a gap again, which puts each row's own hairline in the middle of a gutter and breaks the hover into stripes",
  );
  const row = line(".swt-row{");
  assert.ok(row !== undefined, "the trajectory row rule is gone");
  assert.ok(
    row.includes("border-bottom:1px solid"),
    "the row lost the line that is now the only thing separating it from the next one",
  );
  // THE CONTAINER'S EDGE IS THE CONTAINER'S. `.swt-wrap` draws it; the last
  // row drawing a second one a pixel inside is the hair-outside/rule-inside
  // rule broken where both are visible together.
  assert.ok(
    SOURCE.includes(".swt-row:last-child{border-bottom:0}"),
    "the bottom row draws a divider under nothing, one pixel inside the wrapper's own border",
  );
});

test("a card carries the reference's air, and the panel stops taking it back", () => {
  // MEASURED, NOT FELT. The reference's cards carry 20-24px of interior
  // padding and its sections stand ~24px apart. Ours carried SPACE.lg for
  // both — and MissionPanel, which draws seventeen of the cards on the mission
  // screens, then overrode the interior down to SPACE.md. The component that
  // owns most of this product's surface was the tightest thing on it, at half
  // the reference's air.
  //
  // SPACE IS PINNED AT FIVE STEPS OF FOUR by the test above, so the reference's
  // 20 is not a step this file may have and 24 is the step it has.
  const card = declaration("const CARD_STYLE = {");
  assert.match(card, /padding: SPACE\.xl/, "a card is back to 16px inside, which is where it measured tighter than the reference on every screen in the tab");
  assert.match(card, /marginBottom: SPACE\.xl/, "two stacked cards are back to a 16px gutter");
  // AND THE GAP IS NOT THE MARGIN. `gap` is the space between a card's own
  // columns — the thumbnail and the text in the 信源 feed — and widening it
  // with the padding would push a 340px grid card's text off its own image.
  assert.match(card, /gap: SPACE\.lg/, "the card's internal column gap moved with its padding; they are different distances between different things");
  // THE OVERRIDE MAY NOT COME BACK. Spreading CARD_STYLE and re-declaring
  // `padding` is the one way to make a token change land nowhere: the object
  // says 24 and seventeen mounts render 12, with nothing on either side saying
  // so.
  const panel = code(body("function MissionPanel("));
  assert.match(
    panel,
    /\.\.\.CARD_STYLE, display: "flex", flexDirection: "column", gap: SPACE\.md \}/,
    "MissionPanel overrides CARD_STYLE's padding again, so the card token moves every card in the file except the seventeen that carry the mission screens",
  );
  // AND BOTH BRANCHES KEEP ONE RHYTHM. `bare` drops the card and nothing else;
  // a bare panel in the drawer and a carded one on the page sitting on two
  // different heading-to-body gaps is two heading devices again, which is the
  // thing the drawer batch spent a whole commit collapsing.
  assert.equal(
    (panel.match(/flexDirection: "column", gap: SPACE\.md/g) ?? []).length,
    2,
    "the bare panel and the carded panel disagree about the space between a heading and its body",
  );
});

test("the panel head counts in a sentence, not in a box the colour of its own rule", () => {
  // THE BADGE'S ONE ADVANTAGE, MEASURED, AND IT IS NOT THERE. A badge beats a
  // sentence by being findable by SHAPE at any x, and that is OUR case rather
  // than the reference's: these panels stack — thirteen down the overview and
  // four consecutively down the cost pane — where the reference's
  // 任务列表 · 共 30 项 sits alone at the top of a pane. So the badge should have
  // won here, and this test exists because it does not.
  //
  // IT IS NOT AT A FIXED x: it follows the title inside a flex row, and the cost
  // pane's four titles are 3, 5, 6 and 7 CJK characters at `600 14px/20px`, so
  // its left edge lands at four positions about 56px apart.
  //
  // AND THE SHAPE IS NOT A SHAPE: COUNT_CHIP fills on
  // `--dsw-alias-fill-tertiary`, declared #e5e7eb, six pixels above a rule drawn
  // in `--dsw-alias-border-l2`, declared #e5e7eb — and #374151 against #374151
  // in the dark block. That collision is asserted below, so the day either
  // variable moves, this argument gets re-read instead of inherited.
  const theme = SOURCE.slice(SOURCE.indexOf("const SWM_THEME = ["), SOURCE.indexOf("const SWM_SHEET"));
  const valueOf = (name) => [...theme.matchAll(new RegExp(`"${name}:(#[0-9a-f]{3,8});"`, "g"))].map((m) => m[1]);
  assert.deepEqual(
    valueOf("--dsw-alias-fill-tertiary"),
    valueOf("--dsw-alias-border-l2"),
    "the count badge's fill and the rule under it are no longer the same value in both themes — which is the measurement the panel head's sentence was argued from, so re-read the comment there before trusting it",
  );
  const panel = code(body("function MissionPanel("));
  assert.ok(
    !panel.includes("COUNT_CHIP"),
    "the panel head draws a badge again, filled with the exact value of the rule six pixels under it: a grey box on a grey line, which is the one thing a badge cannot be",
  );
  assert.match(
    panel,
    /children: `· \$\{count\}`/,
    "the count is not part of the heading's sentence — the reference writes 任务列表 · 共 30 项 and the middot is what makes the two one clause",
  );
  assert.match(
    panel,
    /font: FONT\.body, color: INK\.secondary/,
    "the count is set in some step other than the heading's own face one size down, which is two fonts in one heading again",
  );
  assert.ok(
    !panel.includes("INK.quiet"),
    "the panel head reaches for the decoration weight — INK's docblock puts tertiary at 3.71:1 and a count is a value the reader came for",
  );
  // AND THE BADGE SURVIVES WHERE IT IS RIGHT. Ten sites draw a figure INSIDE a
  // row, at a fixed x in a fixed cell, which is the case COUNT_CHIP was declared
  // for. This finding is about one heading, not about retiring the badge.
  assert.ok(
    SOURCE.split("COUNT_CHIP").length - 1 >= 12,
    "COUNT_CHIP lost its other callers too; the ten figures that live inside rows are back to bare monospace in the tertiary colour",
  );
});

test("a chip stands where the reference's chip stands, and the pill still agrees", () => {
  // MEASURED ON BOTH SIDES. gens.team/agent-playground draws its chips at about
  // 26px with a 13px label. Every chip in this file stood 18px with an 11px one:
  // `--dsw-font-xxxs-strong-11` is a 16px line box and `Chip` padded it a single
  // pixel top and bottom, and `pillStyle` did the same. Forty-one call sites,
  // eight pixels short each — which is not a chip that reads dense, it is a
  // different object, and it is most of why a row of ours reads as a toolbar
  // where the reference's reads as a set of labels.
  //
  // 26 IS ARITHMETIC. FONT.bodyStrong is `600 13px/18px`; 18 + 4 + 4 = 26. The
  // corner was already right — RADIUS.sm is 6px and the reference's rounded-md
  // is 6px — which is why this is a height finding and not a shape one.
  const chip = code(body("function Chip("));
  assert.match(
    chip,
    /font: dense \? FONT\.microStrong : FONT\.bodyStrong/,
    "the chip's default step is back under 13px, so every label on the page is two sizes below the reference's",
  );
  assert.match(
    chip,
    /padding: dense \? "1px 6px" : `4px \$\{SPACE\.sm\}`/,
    "the chip pads one pixel again: an 18px box where the reference draws 26",
  );
  // THE DENSE STEP IS AN EXCEPTION WITH A CALLER, not a second geometry. The
  // trajectory row is 38px because the host app's row is 38px, and a tag plus a
  // role mark plus a gap have 96px to live in there.
  assert.match(
    chip,
    /const dense = size === "xs"/,
    "`size` no longer names the dense step, so the one row whose geometry is the host app's has no way to ask for it",
  );
  assert.equal(
    SOURCE.split('size: "xs"').length - 1,
    1,
    "the dense step has no caller, or more than the one row that needs it — either way it is a second geometry rather than an exception",
  );
  // AND THE TWO STEPS STILL AGREE, which is what the previous round bought: a
  // chip and a pill on the same row differ in the corner and in nothing else.
  const pill = declaration("function pillStyle(");
  assert.match(
    pill,
    /font: FONT\.bodyStrong, padding: `4px \$\{SPACE\.sm\}`/,
    "the pill pads differently from the chip again — the eight-pixel disagreement this file closed once, reopened at the other end",
  );
  assert.match(
    pill,
    /font: FONT\.microStrong, padding: "1px 6px"/,
    "the pill's dense step no longer matches the chip's, so the trajectory row holds two boxes at two heights again",
  );
});

test("the two table recipes indent to the same column, and neither pins a height", () => {
  // COUNTED, AND COUNTED AGAINST THE WRONG ROW THE FIRST TIME. This comment
  // used to read "SPACE.lg vertical takes those to 48 and 66". It did not: the
  // figure 48 is a 16px text line plus 32px of air, and the task board has not
  // had a 16px line in it since the chip round — `pillStyle(hue, "md")` is 26px
  // and the 状态 cell draws one on every row. The real heights were 58 and 76,
  // and 76 is past the reference's own 72 on a row carrying half what the
  // reference's carries. SPACE.md puts them at 50 and 68. The test below this
  // one derives all of that from the file rather than restating it here.
  //
  // THE INSET IS THE HALF THAT CANNOT DRIFT. TH and TD agreed at 8px by
  // accident rather than by rule — nothing held them together — and the task
  // board's name cell has a whole paragraph about the two pixels that put 任务
  // out of line with its own column header. Moving one alone reproduces that
  // defect on all six tables at four times the width. Only the vertical value
  // moved; the pair below still has to agree.
  const cell = scale("TD");
  const head = scale("TH");
  assert.match(cell, /padding: `\$\{SPACE\.md\} \$\{SPACE\.md\}`/, "the data cell's vertical air moved. Sixteen is what the fourth pass derived against a text line that a 26px chip had already replaced");
  assert.match(head, /padding: `\$\{SPACE\.sm\} \$\{SPACE\.md\}`/, "the header cell lost its own air, or went back to being a pinned box");
  // The LAST SPACE step in a two-value padding is the horizontal one. Taken
  // that way rather than by position, so a three-value padding written later
  // is read correctly instead of scoring its top edge as its inset.
  const inset = (source) => [...(/padding: `([^`]*)`/.exec(source)?.[1] ?? "").matchAll(/SPACE\.(\w+)/g)].pop()?.[1];
  assert.ok(inset(cell) !== undefined, "TD's padding is no longer a SPACE step, so the column inset is a literal again");
  assert.equal(
    inset(cell),
    inset(head),
    "TH and TD indent their text by different amounts, so every column label on every table sits off the column beneath it",
  );
  // NEITHER PINS A PIXEL HEIGHT. `height: "30px"` was TH's and
  // `minHeight: "30px"` was TD's, and both are the claim TD's docblock
  // refuses: a box is as tall as what it has to say plus its air. TD's could
  // not bind once the air was real, which is the honest reason to delete it
  // rather than raise it.
  // `declared(...)`, NOT THE RAW SLICE. TD's docblock now explains that a
  // minHeight of 30px USED to sit here and why deleting it was the honest
  // move — so the guard fired on the sentence recording its own fix. Fifth
  // time in this file, and the rule is the same every time: a check that can
  // match prose is a check on prose.
  const declared = (source) => source.split(String.fromCharCode(10)).filter((line) => !line.trim().startsWith("//")).join(String.fromCharCode(10));
  assert.ok(
    !/height: "[0-9]+px"/i.test(declared(cell) + declared(head)),
    "a table cell pins a pixel height again, which crushes the two-line name cell back into something the eye reads as one line",
  );
});

test("three kinds of chip, three treatments, and the treatment is what separates them", () => {
  // The reference tells a ROLE from a CATEGORY from a MODEL by how the box is
  // FILLED: a role is a glyph and a word in a bordered box on no fill, a
  // category is tinted with no border, a model is grey on grey. Here,
  // thirty-nine of the forty-one `Chip({` sites took ONE treatment — tinted AND
  // ringed — so "Researcher" and "维度规划" differed by hue alone, and the hue is
  // already spent saying which role and which category. The only two chips on
  // the page that matched the reference were `.swt-tag` and `.swt-evkind`, both
  // hand-drawn in the trajectory and both tinted with no ring.
  const chip = code(body("function Chip("));
  const shape = chip.slice(chip.indexOf("const shape ="), chip.indexOf("return jsxs("));
  assert.ok(shape.length > 0, "Chip no longer builds a `shape` before it returns, so nothing here can be read off it");
  assert.ok(
    !shape.includes("boxShadow"),
    "the category chip has its ring back, and a category with a ring is a role with a different hue — which is exactly the distinction the reference spends the treatment on",
  );
  // THE ROLE KEEPS THE RING AND LOSES THE TINT, and `outline` is how.
  assert.match(
    chip,
    /outline === true/,
    "Chip has no outline treatment, so nothing on the page is drawn the way the reference draws a role",
  );
  assert.match(
    chip,
    /background: "transparent", boxShadow: `inset 0 0 0 1px rgba\(\$\{hue\},\$\{TINT\.ring\}\)`/,
    "the outlined chip either paints a ground of its own or draws no ring; the reference's role chip is a hue-coloured border over whatever is behind it",
  );
  // WITH EXACTLY ONE CALLER, which is the rule this file writes down four times.
  // `solid` has one caller (Callout) and this has one (RoleChip); a second is
  // the moment the treatment stops meaning "this is a role".
  const role = code(body("function RoleChip("));
  assert.match(
    role,
    /outline: true/,
    "RoleChip is tinted like everything else again, so who did it and what kind of thing it is are drawn identically",
  );
  assert.equal(
    SOURCE.split("outline: true").length - 1,
    1,
    "the outline treatment has no caller, or more than the one it means — a second caller is the point at which it stops saying ROLE",
  );
});

test("the strip's metrics are measured figures, and an unmeasured one is dropped", () => {
	// Three figures on the strip, each read from the projection that already
	// computes it. The reference puts a token count with its share of budget, a
	// count and a latency there; ours had one call count at 11px in the
	// decoration weight, and the other two cost a click on 成本.
	const metrics = code(body("function MissionTabMetrics("));
	for (const source of ["cost.tokens", "cost.calls", "cost.byTool"]) {
		assert.ok(
			metrics.includes(source),
			`the strip stopped reading ${source}. A figure on this row is read from the projection or it is invented, and there is no third option`,
		);
	}
	assert.ok(
		metrics.includes("latencyMeasured"),
		"the mean latency divides by calls rather than by the calls the ledger actually timed. `mission_tool_calls.latency_ms` is NOT NULL DEFAULT 0, so every untimed call drags the mean towards instant",
	);
	assert.ok(
		metrics.includes("measured > 0"),
		"a mission whose tools were never timed prints a latency anyway. A figure with no source is dropped from the row, never dashed",
	);
	assert.ok(
		metrics.includes("missionLatency("),
		"the strip formats its own milliseconds. `missionLatency` is what the tool table reads, and two formatters is how 93ms here becomes 0.1s there",
	);
	assert.ok(
		/ratio === null/.test(metrics),
		"a mission whose row froze no token ceiling prints a share of a limit it does not have. `meter()` answers null instead of 0 for exactly this reason",
	);
	assert.ok(
		metrics.includes("missionLadderHue"),
		"the token share grades itself. Six ceiling meters and the header read one ladder; this would be the copy nobody edits",
	);
	assert.ok(
		!metrics.includes("font: FONT.micro"),
		"the strip's figures are back at 11px, which INK's own docblock budgets at 3.71:1 for a unit suffix — not for the two numbers this screen exists to report",
	);
});

test("the tab strip is handed the projection, not a sentence about it", () => {
	assert.ok(
		!code(SOURCE).includes("const spend = zh ?"),
		"the strip is fed a pre-formatted `调用 N 次` again. A component handed a finished sentence cannot grade a figure inside it, cannot align it and cannot drop the one with no source",
	);
	assert.ok(
		body("function MissionDetailTabs(").includes("MissionTabMetrics"),
		"the strip draws its own figures inline again, which is where the third one — the one that is null on a mission nobody timed — gets a dash instead of an absence",
	);
	assert.ok(
		/function MissionDetailTabs\(\{[^}]*cost[^}]*\}/.test(SOURCE),
		"MissionDetailTabs takes no cost projection, so whatever stands on the right of its rule was formatted somewhere it cannot see",
	);
});

test("every mission tab is a glyph and a label, out of the one glyph table", () => {
	// The page strip has drawn a mark beside each of its five labels since
	// TAB_ICONS landed. The mission strip — the one a reader moves along ten
	// times a session — drew five bare words under it, and the two strips are
	// forty pixels apart on the same screen.
	const strip = body("function MissionDetailTabs(");
	const at = strip.indexOf("const panes = [");
	assert.notEqual(at, -1, "the mission strip no longer declares its panes as a table");
	const panes = strip.slice(at, strip.indexOf("\n\t\t\t];", at));
	const ids = [...panes.matchAll(/id: "([a-z]+)"/g)].map((match) => match[1]);
	const marks = [...panes.matchAll(/icon: "([A-Za-z]+)"/g)].map((match) => match[1]);
	assert.ok(ids.length >= 5, `the strip declares ${ids.length} panes; it had five`);
	assert.equal(
		marks.length,
		ids.length,
		`${ids.length} panes and ${marks.length} marks. A strip where some tabs carry a glyph and some do not is read as two kinds of tab, which is worse than none carrying one`,
	);
	assert.equal(
		new Set(marks).size,
		marks.length,
		"two panes share one mark. A mark that names two panes is the single thing a mark on a six-tab strip cannot do",
	);
	for (const mark of marks) {
		assert.ok(
			SOURCE.includes(`\n\t\t\t${mark}: "M`),
			`\`${mark}\` is named by a tab and drawn in no table. Icon renders an unknown name as null, so the tab loses its glyph silently instead of throwing — the gap is the only symptom`,
		);
	}
	assert.ok(
		code(strip).includes("jsx(Icon, { name: entry.icon"),
		"the tab draws a fixed mark rather than its pane's. A glyph that does not come off the pane record is decoration, and a sixth pane would inherit the fifth's",
	);
});

test("the ratchet counts the property air is made of", () => {
  // A RATCHET IS ONLY A RATCHET FOR WHAT IT COUNTS, and this one held five
  // properties, none of which was the one that decides how the page breathes.
  // `fontSize` and `borderRadius` were driven to zero and stayed there because
  // they were watched; `padding` sat at 129 hard-coded pixels across the same
  // file and nothing said a word. Deleting a key from the ceiling is a silent
  // way to unwatch a property, so the keys themselves are asserted here rather
  // than left to whoever edits the object next.
  //
  // IT READS ITS OWN SOURCE. Every other guard in this file reads
  // lib/client.js; this one is about the guard, so the file it opens is this
  // one.
  const SELF = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const ceiling = /const ceiling = \{([^}]+)\}/.exec(SELF);
  assert.ok(ceiling, "the ratchet's ceiling is gone, so nothing holds any raw-value count down");
  for (const key of ["fontSize", "fontWeight", "lineHeight", "borderRadius", "gap", "padding", "height"]) {
    assert.match(
      ceiling[1],
      new RegExp(`\\b${key}: \\d+`),
      `the ratchet stopped counting \`${key}\`. Unwatching a property is not the same as fixing it, and the two look identical from a passing test run`,
    );
  }
});

test("a figure token resolves to a stored figure, or to nothing at all", () => {
  // THE RENDERER HALF OF THE SOURCE-FIGURE FEATURE, and the rules it carries
  // are the ones that make a picture evidence rather than decoration.
  //
  // BY ID, NEVER BY URL. The token names a figure the pipeline already stored;
  // it cannot name an address. That is the whole difference between a citation
  // and an invented one — a model that can write a URL into a report can write
  // a URL that was never fetched.
  assert.match(SOURCE, /const FIGURE_TOKEN = /, "the token's shape is no longer declared once, so the writer, the renderer and the sanitiser can drift apart");
  const render = code(body("function renderMarkdown("));
  assert.match(render, /FIGURE_TOKEN\.exec\(line\.trim\(\)\)/, "renderMarkdown no longer recognises a figure token, so a chapter that placed one prints it as a paragraph");
  assert.match(render, /refs\?\.figure === "function" \? refs\.figure\(/, "the renderer resolves a figure by some route other than the seam the report hands it");

  // AN ID THAT DOES NOT RESOLVE DRAWS NOTHING. Not a broken image, not an
  // empty frame, and not the token. Every mission finished before this feature
  // existed holds no figures at all, and their reports must read exactly as
  // they did.
  assert.match(render, /if \(found !== null && found !== undefined\) \{/, "an unresolved figure id reaches the card, which draws a frame around a hole");

  // THE src IS OUR OWN ROUTE, and the credit is not optional.
  const card = code(body("function MissionFigure("));
  assert.match(card, /src: `\$\{apiBase\(\)\}\$\{figure\.path\}`/, "the img points somewhere other than our own route; a publisher's URL here puts the reader's IP at every source in the bibliography");
  assert.ok(!/src: (figure\.url|figure\.sourceUrl)/.test(card), "the img points at the publisher's own address");
  assert.match(card, /rel: "noreferrer noopener"/, "the credit link leaks the reader's page to the publisher");
  // WITH NO BYTES, THE CITATION SURVIVES. The caption and the link are what
  // make this evidence; the picture is the part that can be missing.
  assert.match(card, /const held = typeof figure\.path === "string"/, "the card no longer distinguishes a figure we hold from one we do not");
  assert.match(card, /!held \? null : jsx\("img"/, "a figure with no stored bytes still mounts an img, which draws a broken-image mark inside a bordered box");
});

test("the chapter card's preview carries no figure directive", () => {
  // THE PREVIEW IS PLAIN TEXT, cut from the chapter's own markdown at
  // `section.start` — which is why the `## ` heading and the `[N]` markers
  // already come off here: both are syntax pointing at things this card does not
  // have and cannot reach. `:::figure 3` is the third of them. It points at a
  // picture the card cannot draw, and unremoved it reads as a typo in the
  // opening line of a chapter.
  //
  // The pair regex is what is pinned rather than the loose one. The block is two
  // lines and the slice can cut between them, so a reader that only handled the
  // orphan would leave the closing `:::` on the card of any chapter short enough
  // for both lines to fall inside 1200 characters.
  const preview = code(body("function missionChapterPreview("));
  assert.ok(
    preview.includes(":::figure[ \\t]+\\d{1,3}[ \\t]*\\r?\\n:::"),
    "the chapter preview no longer strips the whole figure block, so a short chapter's card opens with `:::figure 3` and a line of colons under it"
  );
  assert.ok(preview.includes("\\[\\d+\\]"), "the preview no longer strips citation markers either");
});

test("the writer's token and the renderer's parser are the same token", () => {
  // THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE, caught with both halves green.
  //
  // The renderer was written expecting `:::figure <figureId>` — one line, a hex
  // id, resolved against a live index. The writer mints `:::figure N` followed
  // by a closing `:::`, where N indexes the manifest frozen into the artefact.
  // Each half was correct on its own and the whole suite passed, and every
  // figure in every report would have been invisible: the writer would emit a
  // token the renderer could not parse, and the renderer draws NOTHING for a
  // token it cannot resolve, by design.
  //
  // So the two are asserted against each other rather than each against its own
  // idea of the shape.
  const mint = readFileSync(new URL("../lib/mission-stages-middle.js", import.meta.url), "utf8");
  // THE TOKEN, WHEREVER IT IS BUILT. It was pushed as a bare string; it is
  // pushed inside an object now, because a figure has to be placed beside the
  // paragraph carrying its own citation marker rather than stacked at the end
  // of the chapter. The container is not what this test is about — the token
  // is — so it reads the literal and not the call around it.
  const minted = /`(:::figure [^`]*)`/.exec(mint);
  assert.ok(minted !== null, "the assembler no longer mints a figure block, or mints it somewhere this cannot see");

  // What the writer actually produces, with its index filled in.
  const sample = minted[1].replace("${index}", "7").split(String.fromCharCode(92) + "n");
  const pattern = /const FIGURE_TOKEN = (\/[^;]*\/);/.exec(SOURCE);
  assert.ok(pattern !== null, "FIGURE_TOKEN is gone, so nothing declares the shape both halves have to agree on");
  const token = new RegExp(pattern[1].slice(1, pattern[1].lastIndexOf("/")));
  assert.match(sample[0], token, `the writer mints ${JSON.stringify(sample[0])} and the renderer's FIGURE_TOKEN does not match it, so every figure would be invisible`);
  assert.equal(token.exec(sample[0])[1], "7", "the token captures something other than the index the writer put in it");

  // AND THE CLOSING FENCE IS SWALLOWED. Left to the paragraph branch it prints
  // three colons under every picture.
  assert.ok(sample.length < 2 || sample[1].trim() === ":::", "the writer's second line is not a bare fence, so this assertion is checking the wrong thing");
  const render = code(body("function renderMarkdown("));
  assert.match(render, /line\.trim\(\) === ":::"/, "the closing fence reaches the paragraph branch and prints three colons under every figure");
});

test("the figure index is 1-based, and the parser is as narrow as the mint", () => {
  // TWO MUTATIONS SURVIVED THE CROSS-CHECK and this closes both. The
  // cross-check proves the writer's token PARSES; neither of these breaks
  // parsing, and both change what the reader sees.
  //
  // OFF BY ONE. `:::figure 1` is the first row of the manifest. Shifting the
  // lookup by one draws the SECOND figure under the first caption — a picture
  // credited to a page it did not come from, which is the one failure this
  // whole feature is built to make impossible, and it draws perfectly.
  const detail = code(body("function MissionReport("));
  assert.match(
    detail,
    /figure: \(index\) => manifest\[index - 1\] \?\? null,/,
    "the figure lookup is not 1-based, so `:::figure 1` draws the second figure and every picture is credited to the wrong page",
  );

  // AND THE PARSER IS AS NARROW AS THE MINT. The writer emits a small integer
  // chosen from a list it was handed. A parser that also accepts a hex id or a
  // slug is a parser that will one day resolve something the writer invented —
  // `manifest[NaN - 1]` is undefined and draws nothing, which is safe, but the
  // narrowness is the guarantee and it should be checked rather than relied on.
  const pattern = /const FIGURE_TOKEN = (\/[^;]*\/);/.exec(SOURCE);
  // Written as an inclusion rather than a pattern-of-a-pattern: matching a
  // regex's own source with a regex is where the last two of these went
  // wrong, and the thing being asserted is one literal.
  assert.ok(pattern[1].includes("{1,3}"), "the token accepts more than an index, so the writer could name something it was never handed");
  assert.ok(!/A-Za-z/.test(pattern[1]), "the token accepts letters; the writer mints an integer chosen from a list it was handed");
});

test("an open chapter offers the way back to the list", () => {
  // A reader who opens chapter 7 and wants the index again must not have to
  // re-choose the mode they are already in. Without this the only route back
  // was 通读 and then 分章节 — two clicks to undo one, through a mode that is
  // not where they wanted to be.
  const report = code(body("function MissionReport("));
  assert.match(report, /onClick: \(\) => \{ setChapter\(-1\); \}/, "nothing returns to the chapter list, so opening a chapter is a one-way door");
  // AND IT NAMES WHERE IT GOES. A back control that does not say is one a
  // reader has to press to find out.
  assert.match(report, /全部 \$\{readSections\.length\} 章/, "the back control says only 返回, so it does not say what it returns to");
  assert.match(report, /!chosen \? null : jsxs\("button"/, "the back control draws when no chapter is open, where it points at nothing");
});

test("a references row is two informative lines, not seven things on one", () => {
  const pane = code(body("function MissionSources("));
  // ONE CHIP CARRYING A RATIO, which is what the reference's status cell does.
  // Two chips holding a numerator and a denominator with a gap between them
  // made the reader do the division on every one of a hundred and seven rows.
  assert.match(
    pane,
    /label: zh \? `已核验 \$\{source\.verified\}\/\$\{source\.findings\}`/u,
    "the row is back to a bare verified count, so the number it is out of is a separate object again",
  );
  assert.ok(
    !pane.includes("${source.findings} 条发现"),
    "the standalone finding-count chip is back on the row — the denominator drawn as its own object",
  );
  // THE VERDICT'S GLYPH IS IN THE LEFT MARGIN, ONCE. A list row is separated by
  // a line and marked in the margin; the mark is the one signal a reader of a
  // hundred rows takes in without reading.
  assert.match(pane, /mark: jsx\("span", \{/u, "the row lost its left-margin mark, so the only verdict left is a word inside a chip");
  assert.equal(
    (pane.match(/icon: source\.verified === 0/gu) ?? []).length,
    0,
    "the glyph is inside the chip as well as in the margin, so one verdict is drawn twice on one row",
  );
  // A SORT KEY MUST BE ON THE ROW; A GROUP KEY MUST NOT BE. The pane has made
  // the second half of that argument about the host since it was written, and
  // printed every dimension name under its own 按维度 heading anyway.
  assert.match(
    pane,
    /order !== "seen" \|\| source\.firstSeenAt === null/u,
    "the first-read stamp is back under every arrangement — a monospace clock on every row of a finished bibliography",
  );
  assert.match(pane, /const byDim = order === "dim";/u, "the dimension names print on every row under the heading that already names them");
  assert.match(pane, /`\$\{names_\[0\]\} \+\$\{names_\.length - 1\}`/u, "the dimension list is unfolded again, so a page that fed four prints all four");
  // AND THE LIBRARY MISS ONLY WHERE SAYING IT SEPARATES ONE ROW FROM ANOTHER.
  assert.match(
    pane,
    /const libraryDiscriminates = libraryHeld > 0 && libraryMissed > 0;/u,
    "不在信源库 is back on every row of a run whose library holds none of them — the same five characters a hundred times, nought bits each",
  );
  // THE SLOTS ARE POSITIONS ON THE CARD, and the card has them.
  const link = code(body("function SourceLink("));
  assert.match(
    link,
    /function SourceLink\(\{ title, url, host, verifyState, mark, lead, tail, meta, zh \}/u,
    "the card lost the three layout slots its first line is built from, so the row is a title with everything else beneath it",
  );
  assert.ok(
    link.includes("font: FONT.bodyStrong, flex: 1"),
    "the title is back at the weight of the sentence under it and the host beside it, which is no title at all",
  );
});

test("a fact that is the same on every row is not a fact worth 107 repeats", () => {
  // 不在信源库 was printed on all 107 reference rows of a run whose library
  // matched nothing. A line that is identical on every row carries no
  // information and costs the width that a row's real facts need — which is
  // most of why that pane read as a jumble.
  //
  // THE MUTATION THAT SURVIVED. Removing the discriminating check left
  // `libraryDiscriminates` declared and unused, so a source-text guard that
  // only looked for the NAME stayed green while the badge came back on every
  // row. The name has to be checked where it is USED.
  const pane = code(body("function MissionSources("));
  assert.match(
    pane,
    /source\.library === null && !libraryDiscriminates \? \[\] : missionLibraryMeta\(/,
    "the library badge is drawn without asking whether it separates anything, so it prints on every row of a run whose library matched nothing",
  );
  assert.match(pane, /const libraryDiscriminates =/, "nothing computes whether the library badge discriminates");
});

test("the references bar carries the clauses that were three grey paragraphs", () => {
  const pane = code(body("function MissionSources("));
  // The bar is the row that already held the two segmented strips. Its left
  // half was empty and the three sentences each took a full-width line under
  // it — on a run with no publish dates, which is most runs, two of the three
  // drew on every visit.
  assert.match(pane, /marginRight: "auto"/u, "the bar's sentence no longer holds the strips against the right edge, so the clauses and the controls are one undifferentiated row");
  // THE HEAD THAT CLOSES THE BAR, not the first one in the pane. `}, "head")`
  // occurs earlier in this component for a different block, so slicing to the
  // FIRST one ran backwards and produced an empty string — every clause
  // assertion below then failed against nothing at all.
  const barAt = pane.indexOf('marginRight: "auto"');
  const bar = pane.slice(barAt, pane.indexOf('}, "head")', barAt));
  assert.ok(bar.length > 0, "the bar slice is empty, so the clause assertions below are reading nothing");
  for (const [clause, why] of [
    ['!narrowed ? null : jsx("div", {', "the narrowing sentence is back outside the bar, on a line of its own"],
    ['totals.dated > 0 ? null : jsx("div", {', "the missing year facet is explained on a full-width line again — a permanent explanation of an absent control, at paragraph weight"],
    ["libraryHeld > 0 || libraryMissed === 0 ? null", "the library miss is not said once here, which is what lets it be said on every row"],
  ]) {
    assert.ok(bar.includes(clause), why);
  }
  // AND NOTHING IS DRAWN BETWEEN THE BAR AND THE FIRST ROW. This is the
  // assertion that actually buys the space back: the clauses can be inside the
  // bar AND copied below it, and the pane would look exactly as it did.
  // FROM THE BAR'S OWN CLOSE, for the same reason as the slice above: the
  // first `}, "head")` in this component belongs to an earlier block, so this
  // measured from there to the list and reported the whole bar as sitting
  // between the bar and the list.
  const between = pane.slice(pane.indexOf('}, "head")', barAt), pane.indexOf('order === "dim" ?'));
  assert.ok(
    !between.includes('jsx("div"'),
    "a paragraph is back between the bar and the first row, which is the fixed chrome this pane keeps regrowing",
  );
});

test("the references list's rows touch, so the line between them is the line", () => {
  // THE SAME MOVE THE TRAJECTORY ALREADY MADE, on the pane that still had not.
  // 107 rows, each with its own border, its own radius and 8px of page under
  // it: 9px per row of separation that a single rule does for nothing, and a
  // hover fill that lights a card rather than a row.
  const line = (needle) => SOURCE.split(String.fromCharCode(10)).find((row) => row.includes(needle));
  const list = line(".swm-sourcelist{");
  assert.ok(list !== undefined, "the references list is a stack of bordered cards with gaps between them again");
  assert.ok(
    list.includes("border:1px solid ${LINE.hair}"),
    "the list container has no outer edge, so a hundred ruled rows float on the pane with nothing round them — or it took LINE.rule, which is the inner divider",
  );
  const row = line(".swm-sourcelist .swm-source{");
  assert.ok(row !== undefined, "the rows inside the list keep the card's own edge, radius and ground");
  assert.ok(
    row.includes("border-bottom-color:${LINE.rule}"),
    "the row lost the inner divider that is now the only thing separating it from the next one",
  );
  assert.ok(
    SOURCE.includes(".swm-sourcelist .swm-source:last-child{border-bottom-color:transparent}"),
    "the bottom row draws a divider one pixel inside the container's own edge — the hair-outside/rule-inside rule broken where both are visible at once",
  );
  // THE HOVER HAS TO OUTRANK THE RESTING RULE, which is (0,2,0) exactly as
  // `.swm-source:hover` is. Without the three-class selector the row goes inert
  // under the pointer and every assertion above still passes.
  assert.ok(
    SOURCE.includes(".swm-sourcelist .swm-source:hover{"),
    "the list's resting rule outranks the card's hover, so a row inside a list stops answering the pointer",
  );
  // ALL THREE ARRANGEMENTS, NOT ONE. The pane draws its rows from three
  // containers — flat, by host, by dimension — and a file-wide match passes
  // with two of them still stacking cards.
  const pane = code(body("function MissionSources("));
  assert.equal(
    (pane.match(/className: "swm-sourcelist"/gu) ?? []).length,
    3,
    "one of the pane's three lists is still a stack of cards, so the same rows read two ways a click apart",
  );
  assert.ok(
    !/flexDirection: "column", gap: SPACE\.sm \},\s*children: (ordered|entry\.rows)\.map\(row\)/u.test(pane),
    "a list of source rows separates them with a gap again, which puts each row's own hairline in the middle of a gutter",
  );
});

test("a table row is measured with the chip that is actually in it", () => {
  // WHAT THE FOURTH PASS GOT WRONG, AND IT IS ARITHMETIC RATHER THAN TASTE.
  // TD's own note argued that SPACE.lg vertical "takes the two-line row to 66
  // and the one-line row to 48". Both figures measure a 16px TEXT line — and
  // the SAME round put a 26px chip in every row of the task board: the 状态
  // cell draws `Chip({ ..., pill: true })` with no `size`, which resolves to
  // `pillStyle(hue, "md")`, an 18px line box plus four pixels top and bottom.
  // The rows stood at 58 and 76. Seventy-six is PAST the reference's ~72, on a
  // row that carries one line where the reference carries two.
  //
  // DERIVED, NOT TYPED. Every number below is read out of the file, so the day
  // the chip step or the spacing step moves, this guard moves with it instead
  // of asserting a constant nobody can re-check. That is the whole difference
  // between this and the sentence it replaces.
  const steps = Object.fromEntries(
    [...scale("SPACE").matchAll(/(\w+): "(\d+)px"/g)].map((match) => [match[1], Number(match[2])]),
  );
  const pad = /padding: `\$\{SPACE\.(\w+)\} \$\{SPACE\.(\w+)\}`/.exec(scale("TD"));
  assert.ok(pad, "TD's padding is no longer a pair of SPACE steps, so a row's height can no longer be derived here");
  const vertical = steps[pad[1]];
  assert.ok(Number.isFinite(vertical), `TD's vertical step SPACE.${pad[1]} is not on the spacing scale`);

  // THE CHIP'S OWN HEIGHT, off `pillStyle`'s md step. FONT.bodyStrong is
  // `600 13px/18px`, which is the only number here the type scale owns and the
  // one `pillStyle`'s own docblock does the same sum with.
  const chipPad = /font: FONT\.bodyStrong, padding: `(\d+)px \$\{SPACE\.sm\}`/.exec(declaration("function pillStyle("));
  assert.ok(chipPad, "the pill's md step no longer pads in pixels, so the tallest thing in a row cannot be derived");
  const chip = 18 + Number(chipPad[1]) * 2;
  assert.equal(chip, 26, "the reference's chip is 26px, and a table row is measured against it rather than against a line of text");

  // AND IT IS REALLY IN THE ROW. Without this the guard measures a chip the
  // board has stopped drawing, and then passes on a row that got shorter for
  // some entirely different reason.
  assert.match(
    code(body("function MissionTaskBoard(")),
    /pill: true,/,
    "the task board's status cell stopped drawing a pill, so the tallest element in its rows is no longer what this guard measures",
  );

  // A ONE-LINE ROW MAY NOT COST WHAT A TWO-LINE ROW COSTS. The reference
  // spends ~72px on two lines that BOTH carry information — a title over a
  // real description, beside an owner, a model and a scored status. Ours has
  // one line on every row whose `note` is empty, which is most of them. Fifty-
  // two is 26 of chip plus SPACE.md top and bottom, with two pixels of slack so
  // that tripping this is a decision about the scale rather than an off-by-one.
  assert.ok(
    chip + vertical * 2 <= 52,
    `a one-line task row stands ${chip + vertical * 2}px, of which ${vertical * 2}px is air around a ${chip}px chip. More padding is not what makes the reference's rows tall — more information is`,
  );
});

test("every row's action cell offers something, and a refusal says why", () => {
  // TWO MUTATIONS SURVIVED THE PATCH'S OWN GUARD and both are visible.
  //
  // ONE: `children: child ? … : …`. Flipping that to `false` sends every
  // dimension row down the STAGE branch, where `stage` is null and the cell
  // draws nothing. Sixteen rows of the board would have an empty 操作 column
  // and no test would say so — the guard asserted the two branches exist, not
  // that the right rows reach them.
  const board = code(body("function MissionTaskBoard("));
  assert.match(
    board,
    /children: child\s*\n?\s*\? jsx\("button", \{/u,
    "the action cell no longer branches on whether the row is a dimension, so one of the two kinds gets an empty cell",
  );
  assert.match(board, /children: zh \? "详情 ›" : "Details ›"/u, "a dimension row has no way into its own detail");

  // TWO: the refusal's title. The reference's un-rerunable steps say why they
  // cannot be re-run; `stage.rerunReason ?? ""` renders an EMPTY tooltip on
  // every stage whose reason the projection did not carry, which is a control
  // that refuses and will not say what refused it.
  assert.match(
    board,
    /title: zh \? "这一步不能单独重跑，原因写在详情里"/u,
    "the un-rerunable hint falls back to an empty string, so a step that cannot be re-run gives no reason at all",
  );
});

test("the citation card flips at the top of the pane and clamps at its sides", () => {
  const peek = code(body("function MissionCitationPeek("));
  // components/common/citations/CitationBadge.tsx portals its card into
  // document.body as `fixed z-[9999] w-96 rounded-lg border border-gray-200
  // bg-white shadow-xl` and places it in handleMouseEnter:
  //   showBelow = rect.top < 200
  //   top       = showBelow ? rect.bottom + 8 : rect.top - 8
  //   left      = Math.min(Math.max(rect.left + rect.width / 2, 200), window.innerWidth - 200)
  // Every number asserted below is one of those four.
  //
  // Ours was `position: absolute; bottom: calc(100% + 6px); left: 50%`,
  // unclamped in both axes, inside a pane whose one scroller is
  // `overflowY: "auto"` — and an inline axis left `visible` beside an `auto`
  // block axis computes to `auto` too, so that box clips on BOTH sides. A
  // marker in the first visible line opened a card with its top cut off; one
  // near the right edge opened a card that clipped or pushed a horizontal
  // scrollbar under the whole report.
  assert.match(peek, /position: "fixed"/, "the card is positioned inside the scroller again, and that box clips it on both axes");
  assert.ok(!peek.includes('bottom: "calc(100% + 6px)"'), "the old unclamped placement is back beside the new one, so two rules place one card");
  assert.match(peek, /rect\.top < 200/, "the card never flips below the marker, so one opened on the first visible line goes off the top of the screen");
  assert.match(
    peek,
    /Math\.min\(Math\.max\(rect\.left \+ rect\.width \/ 2, 200\)/,
    "the card is not clamped horizontally, so a marker near either edge opens one off the side of the window",
  );
  assert.match(peek, /width: "384px"/, "the card is narrower than the reference's `w-96`, so the same four rows each wrap a line earlier");
  assert.match(peek, /ref: anchor,/, "nothing holds the marker's element, so there is no rect to place the card from and it lands at 0,0");
  // AND NOTHING DRAWS BEFORE IT HAS A PLACE, which is the reference's own
  // `isHovered && tooltipPos &&`: a card rendered before its rect is read
  // flashes in the window's top-left corner on its way to the marker.
  assert.match(peek, /!open \|\| spot === null \? null : jsxs\("span", \{/, "the card renders before it has been placed");
});



test("the child connector is the reference's twelve pixels, in the reference's colour", () => {
  // THIS TEST TOOK THE WHOLE FILE DOWN FOR THREE COMMITS.
  //
  // It landed with its backslashes eaten passing through a quoting layer:
  // `[\s\S]` became `[sS]`, `\s*` became `s*`, `\$\{` became `${`, and a `\n`
  // became a real newline that split one literal across two lines. `${SPACE.lg}`
  // inside a regex literal is a lone `{`, which is a PARSE error — so
  // design-tokens.test.mjs never loaded at all, and every guard in it was dark:
  // the declared-variable guard, the one-ramp hue guard, gray-100-is-never-a-
  // ground, hair-versus-rule, the role palette, and all seven ratchets.
  //
  // 197 guards, silent, while `npm test` printed a number I read as a pass.
  // The runner counts an unloadable file as ONE failing test, so the total fell
  // from 588 to 392 and I reported the 392 as green three times.
  //
  // Written with `includes` rather than a pattern for exactly that reason: the
  // strings this checks contain `{`, `$`, backticks and parentheses, and every
  // attempt to express them as a regex through a shell has been eaten. Twelve
  // times this session, and this is the first one that cost coverage rather
  // than a retry.
  const board = code(body("function MissionTaskBoard("));
  // BOTH HALVES OF THIS USED TO ASSERT THE OPPOSITE, and the second one
  // forbade by name the exact thing the reference does.
  //
  // board/MissionTodoBoard.tsx draws a child's marker as `mt-1.5
  // inline-block h-3 w-3 flex-shrink-0 border-b-2 border-l-2
  // border-violet-200` and indents the row with an inline
  // `paddingLeft: depthOf(td) * 18px`. So: two borders on a 12px box, and a
  // padding. Not a glyph, and not a reserved column — which is what I had
  // written here, from a screenshot, and then guarded so it could not change.
  assert.ok(
    board.includes('borderLeft: `2px solid rgba(${PALETTE.violet}'),
    'the elbow is not drawn as a left border in the accent hue',
  );
  assert.ok(
    board.includes('borderBottom: `2px solid rgba(${PALETTE.violet}'),
    'the elbow has no bottom edge, so it is a line rather than a corner',
  );
  assert.ok(
    board.includes('paddingLeft: child ? TASK_INDENT : undefined'),
    'the depth is not a padding on the row; the reference indents with one',
  );
  assert.ok(
    !board.includes('treeBranch'),
    'the glyph connector is back. It sits on the text baseline, which is why it floated clear of the stem it was meant to join',
  );
  assert.ok(
    board.includes('alignItems: "flex-start"'),
    'the row centres its cells again, which makes every row as tall as its tallest chip and moves the title baseline on each one',
  );
});

