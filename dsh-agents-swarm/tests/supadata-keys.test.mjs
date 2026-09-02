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
import { beforeEach, test } from "node:test";

import { maskSupadataKey, resetSupadataHealth, resetSupadataSpend, supadataKeyHealth, supadataKeys, supadataSpend, resolveTranscript } from "../lib/transcript.js";

// A HOOK, NOT A CALL IN EVERY TEST. The key-health cache is module-level and
// two tests here failed on state a third had left behind — a suite reporting
// the order it ran in rather than the behaviour it checks.
beforeEach(() => { resetSupadataHealth(); resetSupadataSpend(); });

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
  // THE FAILURE THIS EXISTS FOR. One key out of credit used to mean every
  // transcript in the library failed until somebody noticed and pasted a new
  // one.
  //
  // 402, NOT 429, AND THE DIFFERENCE COST SIX KEYS. This test said 429, and it
  // taught the code the wrong lesson — the rotation learned that "the provider
  // refused" means "this key is spent, try the next".
  //
  // 429 is Too Many Requests: a statement about the RATE OF THIS MACHINE, and
  // every key in the list travels from the same address. So trying the next one
  // is one more request from the address that was just refused, and six keys
  // turned a single refusal into six. Measured, by a person adding keys one at
  // a time and watching each go red on its second call: a brand-new key cannot
  // be out of quota.
  //
  // Running out of CREDIT is 402, is per-key, and is the only thing this
  // rotation is for.
  const { used, result } = await chain("k1\nk2\nk3", (key) => (key === "k3"
    ? { content: "the third key still has quota", lang: "en" }
    : 402));
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
  const { error } = await chain("sk-live-aaaa\nsk-live-bbbb", () => 402);
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

test("a key is masked to a fingerprint, and a short one gives up almost nothing", () => {
  // THE MASK IS WHAT MAKES PER-KEY ROWS POSSIBLE. The settings pane was one
  // opaque box and a list of states joined to it only by "line number", so a
  // reader could not tell key 2 from key 3 and could not replace one without
  // retyping all of them. A fingerprint is enough to match a row against the
  // key in a password manager and useless for anything else.
  assert.equal(maskSupadataKey("sd_live_aaaaaaaaaaaaaaaa1234"), "sd_…1234");
  // Four trailing characters of a forty-character key is a fingerprint; four of
  // a nine-character key is most of it. The mask is a function of what is left
  // to hide.
  assert.equal(maskSupadataKey("sd_abc123"), "…23");
  assert.equal(maskSupadataKey(""), "…");
});

test("nothing usable leaves in the health payload", () => {
  // This is drawn on a settings page and travels to a browser. The rule the
  // failure strings already follow — position, never the secret — binds harder
  // here, and a mask is only safe if it is actually a mask.
  const keys = "sd_live_aaaaaaaaaaaaaaaa1234\nsd_live_bbbbbbbbbbbbbbbb5678";
  const blob = JSON.stringify(supadataKeyHealth(keys));
  for (const key of keys.split("\n")) {
    assert.equal(blob.includes(key), false, "a whole key reached the payload");
    assert.equal(blob.includes(key.slice(8, 20)), false, "the body of a key reached the payload");
  }
  // And the fingerprint that IS there is the one the row shows.
  assert.deepEqual(supadataKeyHealth(keys).map((one) => one.masked), ["sd_…1234", "sd_…5678"]);
});

test("an exhausted key is not asked again, so a batch cannot burn the list per video", async () => {
  // THIS EMPTIED FIVE REAL KEYS. The rotation breaks on 400 and 404 — "a video
  // Supadata will not serve is not a key problem" — and does NOT break on 429,
  // so a video whose free routes failed walked the whole list and spent one
  // request per key to be refused five times. Twelve videos a pass is sixty
  // wasted calls an hour, for ever; a drain of sixty videos is three hundred in
  // one round. Measured after the fact on the live host: 54 calls, 0 successes,
  // 51 of them 429.
  //
  // Continuing past a 429 is RIGHT when one key is spent and the others are
  // not — that is the entire reason for holding several, and the test above
  // pins it. It is wrong when the key was already known to be spent, and
  // nothing remembered.
  const keys = "k1\nk2\nk3\nk4\nk5";
  const first = await chain(keys, () => 402);
  assert.ok(first.used.length > 1, `the first video probed only ${first.used.length} key(s); the list is not being tried`);

  // Every video after it makes NO paid call at all — the whole burn, gone.
  for (const _ of [1, 2, 3, 4]) {
    const again = await chain(keys, () => 402);
    assert.equal(again.used.length, 0, `${again.used.length} paid call(s) against keys already known to be out of quota`);
  }
});

test("a key that starts working again comes back without a restart", async () => {
  // The cooldown exists to stop pointless retries, not to bury a key somebody
  // has just topped up. `resetSupadataHealth` is the door for the person who
  // fixed the quota and should not wait six hours to find out — and it is the
  // same door `POST /config/supadata-reset` opens.
  const spent = await chain("k1", () => 402);
  assert.equal(spent.used.length, 1);
  assert.equal(supadataKeyHealth("k1")[0].state, "quota");

  // Topped up on the provider's side. The cooldown correctly keeps it idle.
  const stillCooling = await chain("k1", () => ({ content: "now it works", lang: "en" }));
  assert.equal(stillCooling.used.length, 0, "the cooldown did not hold");

  resetSupadataHealth();
  const back = await chain("k1", () => ({ content: "now it works", lang: "en" }));
  assert.equal(back.result?.text, "now it works", "the key did not come back after the reset");
  assert.equal(supadataKeyHealth("k1")[0].state, "ok");
});

test("a success clears a key's cooldown by itself", async () => {
  // The other direction, and it matters as much: a key restored on the
  // provider's side must come back without anybody pressing anything, or the
  // reset button becomes a step people have to know about.
  await chain("k1\nk2", (key) => (key === "k1" ? 402 : { content: "k2 is fine", lang: "en" }));
  assert.equal(supadataKeyHealth("k1\nk2")[0].state, "quota");
  assert.equal(supadataKeyHealth("k1\nk2")[1].state, "ok", "the working key was marked spent");
});

test("paid calls are counted, and the ceiling refuses rather than warns", async () => {
  // THE NUMBER NOBODY WAS COUNTING, and its absence is why five keys emptied.
  // The budget upstream counts VIDEOS — twelve a pass, sixty a drain — and the
  // paid calls those become are two multiplications away: sixty videos against
  // five keys is three hundred requests, and the figure on screen said sixty.
  // Nothing computed the second number, so nothing could refuse it, report it,
  // or notice it climbing.
  resetSupadataSpend();
  assert.equal(supadataSpend().calls, 0);

  // One video, five keys, all refusing: five paid requests, all counted.
  await chain("k1\nk2\nk3\nk4\nk5", () => 500);
  assert.equal(supadataSpend().calls, 5, "paid requests are not being counted");

  // COUNTED ON FAILURE TOO. A request that throws still reached the provider
  // and still counted against a quota; metering only successes would count the
  // calls that were worth making and miss every one that was not — which is
  // the entire population here, measured: 54 calls, 0 successes.
  assert.equal(supadataSpend().remaining, supadataSpend().ceiling - 5);
});

test("past the ceiling the paid route is not taken at all", async () => {
  // A METER THAT ONLY REPORTS IS A METER SOMEBODY HAS TO BE WATCHING, and this
  // runs unattended. The free routes are unaffected, so the library keeps
  // gaining transcripts at no cost while the spend stays where it was put.
  resetSupadataSpend();
  resetSupadataHealth();
  const ceiling = supadataSpend().ceiling;
  // Burn to the ceiling with a fresh key each time, so cooldowns are not what
  // stops it — the ceiling has to be the thing that does.
  for (let at = 0; at < ceiling; at += 1) {
    resetSupadataHealth();
    await chain(`burn${at}`, () => 500);
  }
  assert.ok(supadataSpend().remaining === 0, `remaining ${supadataSpend().remaining} after burning the ceiling`);

  resetSupadataHealth();
  const after = await chain("fresh-key", () => ({ content: "would have worked", lang: "en" }));
  assert.equal(after.used.length, 0, "a paid request was made past the ceiling");
  assert.match(String(after.error?.message ?? ""), /ceiling/, "the refusal does not say why");

  // And a reset restores it, for somebody who has just topped up.
  resetSupadataSpend();
  const back = await chain("fresh-key", () => ({ content: "now it works", lang: "en" }));
  assert.equal(back.result?.text, "now it works", "the ceiling could not be cleared");
});

test("a rate limit stands the whole client down, and never blames a key", async () => {
  // THE BUG THAT BURNED SIX KEYS, and the evidence that found it: a person
  // added a fresh key, watched it turn 配额用尽 on its second call, added
  // another, and repeated — six times. A key that has never been used cannot be
  // out of quota. What was being refused was the MACHINE.
  //
  // 429 is Too Many Requests. It is a statement about the rate of the
  // requester, and every key in the list travels from the same address, so the
  // rotation's "a spent key yields to the next" turned one refusal into one per
  // key — and each new key the person added was consumed by the next pass.
  const { used, error } = await chain("k1\nk2\nk3\nk4\nk5", () => 429);
  assert.equal(used.length, 1, `a rate limit tried ${used.length} keys; every one after the first is a request from the address that was just refused`);
  assert.match(String(error?.message), /429/);

  // AND IT IS NOT RECORDED AS THE KEY'S FAULT. `limited` is a fact about this
  // host; `quota` is a fact about an account. Reporting the first as the second
  // is what sent somebody out to buy five more keys.
  const health = supadataKeyHealth("k1\nk2\nk3\nk4\nk5");
  const touched = health.filter((one) => one.calls > 0);
  assert.equal(touched.length, 1, "more than one key was marked by a single rate limit");
  assert.equal(touched[0].state, "limited", `a rate limit was recorded as ${touched[0].state}`);
  assert.equal(touched[0].quota, 0, "a rate limit was counted against the key's credit");
});

test("while rate limited, no key is tried at all", async () => {
  // The backoff is about the client, so it holds for every key including one
  // added a second later — which is exactly the case that kept happening.
  await chain("k1", () => 429);
  const after = await chain("k1\nbrand-new-key", () => ({ content: "would have worked", lang: "en" }));
  assert.equal(after.used.length, 0, "a fresh key was spent during the backoff");
  assert.match(String(after.error?.message), /rate limited|standing down/i);

  // And the reset clears it, for somebody who has waited or changed address.
  resetSupadataHealth();
  const back = await chain("k1", () => ({ content: "back", lang: "en" }));
  assert.equal(back.result?.text, "back", "the backoff could not be cleared");
});

test("running out of credit is still per-key and still yields to the next", async () => {
  // The distinction is the whole fix: 402 is an account fact and the next key
  // may genuinely have credit; 429 is a client fact and the next key cannot
  // help. Collapsing them either wastes the key list or wastes the quota.
  const { used, result } = await chain("k1\nk2", (key) => (key === "k2"
    ? { content: "the second key has credit", lang: "en" }
    : 402));
  assert.equal(result?.text, "the second key has credit");
  assert.equal(used.length, 2, "an out-of-credit key no longer yields to the next");
});
