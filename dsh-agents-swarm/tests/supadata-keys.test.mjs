// One setting, many keys.
//
// A free Supadata key carries a small monthly quota, and a library of a few
// hundred videos exhausts one in an afternoon — after which every transcript
// on the tab fails with the same 429 and the only fix is to paste a new key
// over the old one. Several keys, tried in turn, is the difference between a
// quota that runs out and one that is a sum.
//
// The thing that makes it worth testing rather than eyeballing is the ORDER.
// Trying the list from the top every time spends the first key's whole quota
// before the second is touched — which is one key with extra steps, and it
// means the first key is the one that gets rate-limited under a burst while
// three others sit idle. Round-robin is the point; that it still tries every
// key before giving up is what makes the round-robin safe.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { supadataKeyHealth, supadataKeys, resolveTranscript } from "../lib/transcript.js";

test("the setting is split into keys however it was pasted", () => {
  // A person pasting four keys uses whichever separator their clipboard
  // produced. All three are the same list.
  assert.deepEqual(supadataKeys("a\nb\nc"), ["a", "b", "c"], "newlines do not separate keys");
  assert.deepEqual(supadataKeys("a, b, c"), ["a", "b", "c"], "commas do not separate keys");
  assert.deepEqual(supadataKeys("  a   b\t c "), ["a", "b", "c"], "whitespace does not separate keys");

  // AND A SINGLE KEY IS STILL A SINGLE KEY. This setting has been a plain
  // string since it was written; a change that needed the stored value
  // migrated would have to migrate every install that already has one.
  assert.deepEqual(supadataKeys("sk-only-one"), ["sk-only-one"], "one key stopped being one key");
  assert.deepEqual(supadataKeys(""), [], "an unset key is a key");
  assert.deepEqual(supadataKeys(null), [], "an absent setting throws instead of reading as none");

  // DEDUPED. The same key pasted twice would otherwise get two turns at a
  // quota it has already spent, and the second turn cannot succeed.
  assert.deepEqual(supadataKeys("a\nb\na"), ["a", "b"], "a key pasted twice is tried twice");
});

/**
 * Run the chain with only the Supadata leg reachable, recording which keys it
 * used and in what order.
 *
 * The three routes ahead of it — timedtext, the relay, gens — are all `fetch`
 * against hosts this test must not touch, so `fetch` is replaced wholesale:
 * everything that is not Supadata fails, which is the state this leg exists
 * for, and the Supadata calls are answered by `answer`.
 * @param keys - the setting, as it is stored.
 * @param answer - given a key, either a payload or an HTTP status to fail with.
 * @returns `{ used, result, error }`.
 */
async function chain(keys, answer) {
  const used = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    if (!address.includes("api.supadata.ai")) return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
    const key = init?.headers?.["x-api-key"];
    used.push(key);
    const said = answer(key);
    return typeof said === "number"
      ? { ok: false, status: said, json: async () => ({}), text: async () => "" }
      : { ok: true, status: 200, json: async () => said, text: async () => "" };
  };
  try {
    return { used, result: await resolveTranscript("vid00000001", { apiKey: keys }), error: null };
  } catch (cause) {
    return { used, result: null, error: cause };
  } finally {
    globalThis.fetch = inner;
  }
}

test("a spent key costs one request, and the next key is tried", async () => {
  // THE FAILURE THIS EXISTS FOR. One key at 429 used to mean every transcript
  // in the library failed until somebody noticed and pasted a new one.
  const { used, result } = await chain("k1\nk2\nk3", (key) => (key === "k3"
    ? { content: "the third key still has quota", lang: "en" }
    : 429));
  assert.equal(result?.text, "the third key still has quota", "a spent key ends the chain instead of yielding to the next");
  assert.equal(result?.via, "supadata", "the transcript is attributed to a route it did not come from");
  assert.deepEqual(used, ["k1", "k2", "k3"], "the keys were not tried in order, or one was skipped");
});

test("each call starts one further along, so the first key is not the only one spent", async () => {
  // ROUND-ROBIN. Every one of these succeeds on its first attempt, so the key
  // that gets used IS the starting point — which is the whole thing under
  // test. Four calls over three keys wrap back to the first.
  const said = { content: "fine", lang: "en" };
  const first = [];
  for (let at = 0; at < 4; at += 1) {
    const { used } = await chain("k1\nk2\nk3", () => said);
    first.push(used[0]);
  }
  // NOT ASSERTED AS A LITERAL LIST. The cursor is module state and other
  // tests in this file move it, so where the sequence STARTS is not this
  // test's business — that it advances by one each time, and wraps, is.
  const order = ["k1", "k2", "k3"];
  for (let at = 1; at < first.length; at += 1) {
    const want = order[(order.indexOf(first[0]) + at) % order.length];
    assert.equal(first[at], want, `call ${at + 1} started at ${first[at]} rather than ${want}; the cursor is not advancing`);
  }
});

test("a video Supadata will not serve stops the chain rather than spending every key", async () => {
  // 400 AND 404 ARE THE SAME ANSWER FROM EVERY KEY. Trying the other three
  // spends three requests to be told the same thing — and on a library sweep
  // that is three wasted requests per unservable video, against a quota this
  // whole change exists to conserve.
  // WHICH key it starts on is the round-robin cursor's business, not this
  // test's — only that it stops after ONE.
  const { used, error } = await chain("k1\nk2\nk3", () => 404);
  assert.equal(used.length, 1, "an unservable video was tried against more than one key");
  assert.match(String(error?.message), /supadata key \d\/3/u, "the failure does not say which key it was");

  // A QUOTA FAILURE IS NOT THAT. It is worth another key, and all three are
  // spent before the chain gives up.
  const spent = await chain("k1\nk2\nk3", () => 402);
  assert.equal(spent.used.length, 3, "a quota failure stopped the chain early");
});

test("the failure names the key by position and never by value", async () => {
  // THIS STRING IS HANDED TO THE BROWSER. `/transcript` answers 502 with
  // `failures.join("; ")` as the error body, so a key printed here leaves the
  // machine — and "key 3 of 4" is what a person needs in order to know which
  // one to replace without it ever being printed.
  const { error } = await chain("sk-live-aaaa\nsk-live-bbbb", () => 429);
  const said = String(error?.message);
  assert.ok(!said.includes("sk-live-aaaa"), "a key is in the error message the route sends to the browser");
  assert.ok(!said.includes("sk-live-bbbb"), "a key is in the error message the route sends to the browser");
  assert.equal([...said.matchAll(/supadata key \d\/2/gu)].length, 2, "both keys are not reported by position");
});

test("no key configured is still said, and said as that", async () => {
  // A DIFFERENT SENTENCE FROM A KEY THAT FAILED. The first is a setting
  // nobody has filled in; the second is a setting that needs replacing, and
  // the fix for the two is not the same.
  const { used, error } = await chain("", () => 200);
  assert.deepEqual(used, [], "a request went out with no key");
  assert.match(String(error?.message), /no API key configured/u, "an unconfigured key reads as a failed one");
});

/* ── which key is actually working ─────────────────────────────────────── */

test("key health is reported by position and never carries the key", () => {
  // THE QUOTA IS THE SUM OF THE KEYS, so a list of four with one exhausted
  // behaves exactly like a list of three — and the settings page said
  // "已配置 2 把" and nothing else. Which one to replace was unanswerable from
  // the product while the information already existed: every refusal names its
  // key by position inside a failure string only whoever read one failed fetch
  // ever saw.
  const raw = "sd_aaaaaaaaaaaaaaaa\nsd_bbbbbbbbbbbbbbbb\nsd_cccccccccccccccc";
  const health = supadataKeyHealth(raw);
  assert.equal(health.length, 3, "a configured key went missing from the report");
  assert.deepEqual(health.map((one) => one.position), [1, 2, 3], "positions are not the line numbers");
  // NEVER THE VALUE. This is drawn on a settings page in a browser.
  const serialized = JSON.stringify(health);
  for (const key of raw.split("\n")) {
    assert.equal(serialized.includes(key), false, "the report carries a key value");
    assert.equal(serialized.includes(key.slice(-8)), false, "the report carries a recognisable tail of a key");
  }
});

test("an unused key is untried, not healthy and not broken", () => {
  // On a library whose free routes are working, every key sits unused and that
  // is the system behaving correctly: Supadata is the paid fallback, reached
  // only when timedtext, the relay and gens have all refused. Reporting those
  // as "ok" would claim a working key nobody has ever exercised.
  const health = supadataKeyHealth("sd_dddddddddddddddd");
  assert.equal(health[0].state, "untried");
  assert.equal(health[0].calls, 0);
});

test("an empty key blob reports nothing rather than a phantom key", () => {
  assert.deepEqual(supadataKeyHealth(""), []);
  assert.deepEqual(supadataKeyHealth(undefined), []);
});
