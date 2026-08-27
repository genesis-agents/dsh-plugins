// Every collector of a guard's verdict, not just every abort.
//
// The audit that found the second door checked two things: every
// `registry.abort` call site, and every field the failure sentences read. It
// passed. A mission then died at s9-verify reporting "No progress for 0s" —
// the timeout branch's wording with its default — because a guard's abort makes
// the RUNNING STAGE throw, and that lands in `runMission`'s catch rather than at
// the top-of-loop check. Only one of the three `endMission` signal paths merged
// the carried detail.
//
// Three doors. Auditing the aborts and the fields but not the collectors is the
// same shape as the bug itself: checking two ends of a seam and not the middle.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const RUNTIME = readFileSync(new URL("../lib/mission-runtime.js", import.meta.url), "utf8");

test("every signal-driven termination collects what the guard recorded", () => {
  const calls = RUNTIME.split(String.fromCharCode(10))
    .filter((line) => line.includes("endMission({"))
    // `fromSignal: false` paths end a mission for a reason of their own — a
    // stage contract violation, a refusal — and have no guard verdict waiting.
    .filter((line) => /fromSignal:\s*(true|signal\.aborted)/.test(line));

  assert.ok(calls.length >= 3, `only ${calls.length} signal terminations found; this test has lost its subject`);
  for (const call of calls) {
    assert.ok(
      call.includes("detailOf"),
      `a signal termination does not collect the aborting guard's detail, so its sentence renders defaults: ${call.trim().slice(0, 100)}`,
    );
  }
});

test("a cache hit is not evidence of a loop", () => {
  const handlers = readFileSync(new URL("../lib/mission-handlers.js", import.meta.url), "utf8");
  // From the read FORWARD. The first draft sliced to `indexOf("detectNoProgress")`,
  // which finds the IMPORT at the top of the file — a backwards slice, and an
  // empty window that fails whatever the code says.
  const at = handlers.indexOf("recentToolCalls");
  const window = handlers.slice(at, handlers.indexOf("detectNoProgress", at));
  assert.ok(
    /cached\s*!==\s*true/.test(window),
    "cached calls are fed to the loop rule again. The ledger records every call, served or not, and `cached: true` means "
      + "the door recognised the request and did NOT redo the work — s9-verify checks many quotes against the same few "
      + "pages, so three cached fetches in a row read as a loop to a rule that cannot see the flag",
  );
});
