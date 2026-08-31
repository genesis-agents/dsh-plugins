#!/usr/bin/env node
/**
 * The suite, with a floor under its own size.
 *
 * WHY THIS EXISTS, AND IT IS NOT A PREFERENCE.
 *
 * `node --test` counts a file it cannot PARSE as one failing test. So a syntax
 * error in a test file does not report "197 guards did not run" — it reports
 * one red line, indistinguishable from an ordinary broken assertion, while the
 * total silently drops by however many tests that file held.
 *
 * MEASURED: a regex in design-tokens.test.mjs landed with its backslashes eaten
 * by a quoting layer. `${SPACE.lg}` inside a regex literal is a lone `{`, which
 * is a parse error. The file never loaded. The total fell from 588 to 392 and
 * every guard in it went dark — the declared-variable guard, the one-ramp hues,
 * gray-100-is-never-a-ground, hair-versus-rule, the role palette, all seven
 * ratchets — for three commits, while the 392 was read as green and reported as
 * green three times.
 *
 * NO ASSERTION CAN CATCH THIS FROM INSIDE. A file that stops parsing takes its
 * own tests with it, and a guard in a sibling file that tries to parse the
 * others has to tell a regex literal from a JSDoc comment in plain text, which
 * it cannot do reliably — the first attempt flagged
 * `/** A mission with one settled spend row. *\/` as a broken pattern.
 *
 * The count is the one thing that always moves. This runs the suite, reads the
 * total, and refuses a run whose total has fallen below the floor. Raise the
 * floor when tests are added; a fall is either a deleted test or a dark file,
 * and both are worth stopping for.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FLOOR_FILE = new URL("./floor.json", import.meta.url);

/** The floor, or zero when the file has not been written yet. */
function floor() {
  try {
    return Number(JSON.parse(readFileSync(FLOOR_FILE, "utf8")).tests) || 0;
  } catch {
    return 0;
  }
}

// NO SHELL. `process.execPath` on Windows is "C:\Program Files\nodejs\node.exe",
// and `shell: true` concatenates rather than escapes, so cmd reads it as the
// command `C:\Program`. Node expands the glob itself since v22, so the shell
// bought nothing and cost the whole run.
const files = process.argv.slice(2);
const child = spawn(
  process.execPath,
  ["--test", ...(files.length > 0 ? files : ["tests/*.test.mjs"])],
  { stdio: ["inherit", "pipe", "inherit"] },
);

let out = "";
child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  out += text;
  process.stdout.write(text);
});

child.on("close", (code) => {
  const tests = Number(/^ℹ tests (\d+)$/mu.exec(out)?.[1] ?? 0);
  const fail = Number(/^ℹ fail (\d+)$/mu.exec(out)?.[1] ?? 0);
  const was = floor();

  if (tests > was) {
    writeFileSync(FLOOR_FILE, `${JSON.stringify({ tests }, null, 2)}\n`);
    process.stdout.write(`\nsuite floor raised ${was} -> ${tests}\n`);
  } else if (tests < was) {
    process.stdout.write(
      `\nSUITE SHRANK: ${tests} tests ran and the floor is ${was}.\n`
      + `${was - tests} test(s) did not run. A file that fails to PARSE is counted as one\n`
      + `failing test and takes every test in it with it, so a red line here can mean\n`
      + `hundreds of guards are dark. Check each file with \`node --check\` before\n`
      + `reading this run as a result.\n`,
    );
    process.exit(1);
  }
  process.exit(fail > 0 ? 1 : code ?? 0);
});
