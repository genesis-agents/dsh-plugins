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

test("the proxy does not relay this hop's own body handshake", () => {
  // `expect: 100-continue` is a negotiation between a client and the server it
  // is talking to — "may I send the body?" — answered with a 100 Continue
  // before the body is written. The proxy IS that server for the leg carrying
  // it, and Node's http server already answers it. Copied onto the outbound
  // fetch it asks undici to conduct a handshake it does not implement: the
  // request fails with a bare "fetch failed", which the proxy then reports as
  // "cannot reach the library" — blaming the far end for a header the near end
  // added.
  //
  // MEASURED AND NOT EXOTIC. Every .NET client sends it by default, and curl
  // adds it for bodies over about a kilobyte. It broke every POST with a body
  // from a .NET caller outright while the identical request without it
  // answered 200.
  const source = readFileSync(new URL("../lib/remote.js", import.meta.url), "utf8");
  const block = /const HOP_BY_HOP = new Set\(\[([\s\S]*?)\]\);/.exec(source);
  assert.notEqual(block, null, "HOP_BY_HOP is gone from lib/remote.js");
  assert.match(block[1], /"expect"/, "the proxy relays expect: 100-continue, which undici cannot honour");
  // The rest of the list is what makes this a hop-by-hop drop rather than one
  // special case: losing any of these breaks a different transport promise.
  for (const name of ["connection", "transfer-encoding", "host", "upgrade"]) {
    assert.match(block[1], new RegExp(`"${name}"`), `${name} fell out of the hop-by-hop list`);
  }
});
