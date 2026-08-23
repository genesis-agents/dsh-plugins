import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import * as E from "./lib/episodes.js";

const root = mkdtempSync(join(tmpdir(), "ep-"));
const env = { ...process.env, DSH_SWARM_DB: join(root, "swarm.sqlite") };
const ok = (n, c, extra = "") => console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? "  :: " + extra : ""}`);

// real MP3-ish bytes
const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(48000, 7)]);

// 1. round trip with the SHAPE THE REAL CALLER PASSES (publish-routes.js:137)
const turns = [
  { speaker: "a", text: "欢迎收听，今天我们聊 <AI> & 播客。" },
  { speaker: "b", text: "没错，这期内容很有意思。" },
];
const rec = await E.saveEpisode(
  { audio: mp3, title: "第一期 & <测试>", script: { title: "第一期", turns }, sourceIds: ["s1", "s2"], voices: { a: "x", b: "y" } },
  env,
);
ok("audio file on disk", existsSync(E.episodePath(rec.id, env)));
ok("bytes round trip", readFileSync(E.episodePath(rec.id, env)).equals(mp3));
ok("script preserved (caller shape {title,turns})", rec.turns === 2 && rec.script?.length === 2, `turns=${rec.turns} script.len=${rec.script?.length}`);
const back = E.getEpisode(rec.id, env);
ok("getEpisode returns it", back?.id === rec.id);
ok("listEpisodes has 1", E.listEpisodes(env).length === 1);

// 2. array shape also accepted
const rec2 = await E.saveEpisode({ audio: mp3, title: "array shape", script: turns }, env);
ok("script preserved (array shape)", rec2.turns === 2);

// 3. duplicate mint: identical args twice in the same second
const a1 = await E.saveEpisode({ audio: mp3, title: "dup", sourceIds: ["s1"] }, env);
const a2 = await E.saveEpisode({ audio: mp3, title: "dup", sourceIds: ["s1"] }, env);
ok("two saves get distinct ids", a1.id !== a2.id, `${a1.id} vs ${a2.id}`);

// 4. feed, called EXACTLY as publish-routes.js:238 calls it
const origin = "http://127.0.0.1:3080";
const feedOpts = {
  baseUrl: origin,
  link: `${origin}/`,
  audioUrl: (ep) => `${origin}/swarm-api/publish/episodes/${encodeURIComponent(ep.id)}/audio`,
};
const xml = E.buildFeed(E.listEpisodes(env), feedOpts);
const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
const err = doc.querySelector("parsererror");
ok("feed parses as XML", err === null, err?.textContent?.slice(0, 120) ?? "");
const enc = [...doc.getElementsByTagName("enclosure")].map((n) => n.getAttribute("url"));
ok("enclosure URLs absolute", enc.every((u) => /^https?:\/\//.test(u)), enc[0]);
ok("enclosure URL hits a real route", enc.every((u) => u.includes("/swarm-api/publish/episodes/")), enc[0]);
ok("channel link non-empty", (doc.querySelector("channel > link")?.textContent ?? "") !== "");
ok("atom:self absolute", /^https?:\/\//.test(doc.getElementsByTagNameNS("http://www.w3.org/2005/Atom", "link")[0]?.getAttribute("href") ?? ""));
const mine = [...doc.getElementsByTagName("item")].find((n) => n.querySelector("guid")?.textContent === rec.id);
ok("description falls back to script opening", mine?.querySelector("description")?.textContent?.includes("欢迎收听") === true,
   mine?.querySelector("description")?.textContent?.slice(0, 40));
ok("feed ends with newline", xml.endsWith("\n"), JSON.stringify(xml.slice(-14)));

// 5. hostile title / control chars
const evil = await E.saveEpisode({ audio: mp3, title: "</title><script>alert(1)</script>\u0000\u001b bad", script: turns }, env);
const xml2 = E.buildFeed([evil], feedOpts);
const d2 = new JSDOM(xml2, { contentType: "text/xml" }).window.document;
ok("hostile title still parses", d2.querySelector("parsererror") === null, d2.querySelector("parsererror")?.textContent?.slice(0, 100) ?? "");
ok("no script element injected", d2.getElementsByTagName("script").length === 0);

// 6. traversal
for (const bad of ["../../etc/passwd", "a/b", "..", "a.mp3", ""]) {
  let threw = false;
  try { E.episodePath(bad, env); } catch { threw = true; }
  ok(`episodePath refuses ${JSON.stringify(bad)}`, threw);
}

// 7. junk audio that is not base64 at all (a TTS error string)
let threw = false;
try { await E.saveEpisode({ audio: '{"error":"quota exceeded"}', title: "junk" }, env); } catch { threw = true; }
ok("non-base64 string audio refused", threw);

// 8. empty audio
threw = false;
try { await E.saveEpisode({ audio: Buffer.alloc(0) }, env); } catch { threw = true; }
ok("empty audio refused", threw);

// 9. estimateDuration contract: "never less than one"
ok("estimateDuration(undefined) >= 1", E.estimateDuration(undefined) >= 1, String(E.estimateDuration(undefined)));
ok("estimateDuration('abc') >= 1", E.estimateDuration("abc") >= 1, String(E.estimateDuration("abc")));

// 10. corrupt index throws, does not report an empty library
writeFileSync(join(root, "episodes", "index.json.bak"), readFileSync(join(root, "episodes", "index.json"), "utf8"));
writeFileSync(join(root, "episodes", "index.json"), "{not json");
threw = false;
try { E.listEpisodes(env); } catch { threw = true; }
ok("corrupt index throws", threw);
const saved = readFileSync(join(root, "episodes", "index.json.bak"), "utf8");
writeFileSync(join(root, "episodes", "index.json"), "[null]");
let kind = "none";
try { E.listEpisodes(env); } catch (e) { kind = e.constructor.name + ": " + e.message; }
ok("index with a null row raises an error naming the file, not a TypeError",
   kind.startsWith("Error:") && kind.includes("index.json"), kind.slice(0, 40) + "...");
writeFileSync(join(root, "episodes", "index.json"), saved);

// 11. rfc822 / itunesDuration
ok("rfc822 shape", /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/.test(E.rfc822("2026-08-22T09:04:00Z")), E.rfc822("2026-08-22T09:04:00Z"));
ok("rfc822 invalid -> ''", E.rfc822("not a date") === "");
ok("itunesDuration", E.itunesDuration(3725) === "01:02:05", E.itunesDuration(3725));
const badDate = E.buildFeed([{ id: "x", title: "t", createdAt: "garbage", bytes: 10 }], feedOpts);
ok("invalid createdAt does not emit an empty <pubDate>", !/<pubDate><\/pubDate>|<pubDate\/>/.test(badDate), (badDate.match(/<pubDate>.*?<\/pubDate>|<pubDate\/>/) ?? [""])[0]);

// 11b. legitimate base64 still works
const b64 = await E.saveEpisode({ audio: mp3.toString("base64"), title: "b64" }, env);
ok("valid base64 audio accepted and byte-exact", readFileSync(E.episodePath(b64.id, env)).equals(mp3));
const wrapped = mp3.toString("base64").match(/.{1,60}/g).join(String.fromCharCode(10));
ok("base64 with newlines accepted", (await E.saveEpisode({ audio: wrapped, title: "b64nl" }, env)).bytes === mp3.byteLength);

// 12. delete
ok("deleteEpisode true", E.deleteEpisode(rec.id, env) === true);
ok("audio gone", !existsSync(join(root, "episodes", `${rec.id}.mp3`)));
ok("deleteEpisode false second time", E.deleteEpisode(rec.id, env) === false);
ok("deleteEpisode on traversal id is false, not a throw", E.deleteEpisode("../../x", env) === false);
console.log("root:", root);
