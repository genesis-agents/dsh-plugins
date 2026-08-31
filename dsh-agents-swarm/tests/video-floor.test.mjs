// Twenty minutes, and what it costs to know.
//
// The roster gained the venture channels, the long-form interview shows and
// the Stanford lecture series, and the ask was: only videos over twenty
// minutes. That is a length, and the feed does not carry one — measured on
// four channels' Atom, it has `media:group`, `media:community`, a star rating
// and a thumbnail, and no duration in any form.
//
// So knowing costs a request per video, and the whole design of the gate is
// about not paying that more often than necessary.
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { dropShortVideos, youtubeVideoId, MIN_VIDEO_SECONDS, isShortFormVideo } from "../lib/collect.js";
import { sourceFeeds } from "../lib/sources.js";

/** One parsed feed row, in the shape `parseFeed` produces. */
const video = (id, seconds) => ({
  id: `row-${id}`,
  type: "YOUTUBE_VIDEO",
  title: `a video of ${seconds}s`,
  sourceUrl: `https://www.youtube.com/watch?v=${id}`,
});

test("a video under twenty minutes is dropped, and one over is kept", async () => {
  const lengths = { aaaaaaaaaaa: 19 * 60 + 59, bbbbbbbbbbb: 20 * 60, ccccccccccc: 3 * 3600 };
  const asked = [];
  const gate = await dropShortVideos(
    [video("aaaaaaaaaaa"), video("bbbbbbbbbbb"), video("ccccccccccc")],
    {
      seen: () => false,
      details: async (videoId) => { asked.push(videoId); return { lengthSeconds: lengths[videoId] }; },
    },
  );
  assert.deepEqual(gate.rows.map((row) => row.id), ["row-bbbbbbbbbbb", "row-ccccccccccc"], "the floor is not twenty minutes");
  assert.equal(gate.dropped.length, 1);
  assert.equal(gate.dropped[0].seconds, 19 * 60 + 59, "the drop does not record how long the video was, so a floor that is wrong cannot be diagnosed from the log");
  assert.equal(asked.length, 3, "something other than the length decided");
  // EXACTLY twenty minutes is over the floor, not under it. An off-by-one here
  // silently drops a whole class of talk that runs to the slot.
  assert.ok(gate.rows.some((row) => row.id === "row-bbbbbbbbbbb"), "a video of exactly the floor was dropped");
});

test("the length of a video the library already holds is never asked for", async () => {
  // A FEED ANSWERS WITH ITS MOST RECENT FIFTEEN EVERY POLL. Looking each of
  // them up every tick would be fifteen requests per channel, forever, to
  // re-learn a number that cannot change — and there are 33 video feeds on the
  // roster now. That is the difference between a cost proportional to NEW
  // videos and one proportional to time.
  const asked = [];
  const held = new Set(["row-aaaaaaaaaaa", "row-bbbbbbbbbbb"]);
  const gate = await dropShortVideos(
    [video("aaaaaaaaaaa"), video("bbbbbbbbbbb"), video("ccccccccccc")],
    {
      seen: (id) => held.has(id),
      details: async (videoId) => { asked.push(videoId); return { lengthSeconds: 30 }; },
    },
  );
  assert.deepEqual(asked, ["ccccccccccc"], "a video already in the library was looked up again");
  assert.equal(gate.looked, 1, "the count of lookups does not match what was asked, so the cost cannot be read from the result");
  // AND THE ONES ALREADY HELD SURVIVE. They are in the library because they
  // passed this gate once; re-deciding them on no evidence would delete them.
  assert.equal(gate.rows.length, 2, "a row that was never measured was dropped anyway");
});

test("a lookup that fails keeps the video", async () => {
  // A NETWORK ERROR IS NOT EVIDENCE THAT SOMETHING IS SHORT. Discarding a
  // source because a request failed is how a library loses material it would
  // have to be told twice to lose — and the failure is invisible, because a
  // dropped row looks exactly like a channel that published nothing.
  const gate = await dropShortVideos([video("aaaaaaaaaaa")], {
    seen: () => false,
    details: async () => { throw new Error("HTTP 429"); },
  });
  assert.equal(gate.rows.length, 1, "a video was dropped because its lookup failed, not because it was short");

  // A ZERO IS NOT A LENGTH EITHER. `fetchVideoDetails` answers 0 when the page
  // carried no `lengthSeconds`, and `0 < 1200` is true.
  const zero = await dropShortVideos([video("bbbbbbbbbbb")], {
    seen: () => false,
    details: async () => ({ lengthSeconds: 0 }),
  });
  assert.equal(zero.rows.length, 1, "a page that did not state a length was read as a video of zero seconds and dropped");
});

test("the gate only weighs YouTube rows, and Shorts still cost nothing", async () => {
  const asked = [];
  const gate = await dropShortVideos(
    [
      { id: "paper", type: "PAPER", title: "a paper", sourceUrl: "https://arxiv.org/abs/2401.00001" },
      { id: "post", type: "BLOG", title: "a post", sourceUrl: "https://example.com/post" },
    ],
    { seen: () => false, details: async (v) => { asked.push(v); return { lengthSeconds: 1 }; } },
  );
  assert.equal(asked.length, 0, "a paper or a blog post was sent for a video length lookup");
  assert.equal(gate.rows.length, 2, "a non-video row was dropped by the video gate");

  // The URL-shape check stays beside the length check rather than being
  // replaced by it: a Short is refused for free, before any request.
  assert.equal(isShortFormVideo("https://www.youtube.com/shorts/abcdefghijk"), true);
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=abcdefghijk"), "abcdefghijk");
  assert.equal(youtubeVideoId("https://youtu.be/abcdefghijk"), "abcdefghijk", "the short link form is not recognised, so those videos are never measured");
  assert.equal(youtubeVideoId("https://example.com/watch?v=abcdefghijk"), "abcdefghijk");
  assert.equal(MIN_VIDEO_SECONDS, 1200);
});

test("every channel on the roster is a resolved id, and the two that would not resolve are absent", () => {
  // EVERY ID WAS RESOLVED AND VERIFIED TWICE, and that is not ceremony.
  // Reading the first `channelId` off a channel page returns whatever shelf
  // YouTube put at the top: Bessemer came back as a personal channel called
  // "Ashley Gagnier", 20VC as "Business of Sport", NFX as "N (Nana777)", and
  // an id that reads like Sequoia's is Talks at Google.
  //
  // So each was taken from the page's own `channelMetadataRenderer.externalId`,
  // cross-checked against its canonical link, and its feed fetched and its
  // title compared to the channel's own.
  const feeds = sourceFeeds().filter((row) => row.type === "YOUTUBE_VIDEO");
  const ids = new Set();
  for (const feed of feeds) {
    const id = /channel_id=(UC[\w-]{22})$/.exec(feed.url)?.[1];
    assert.ok(id !== undefined, `${feed.name} has no resolvable channel id in ${feed.url}`);
    assert.ok(!ids.has(id), `${feed.name} repeats a channel id already on the roster, so one of the two names is wrong`);
    ids.add(id);
  }
  for (const name of ["Sequoia Capital", "a16z", "No Priors", "Acquired", "Stanford Graduate School of Business"]) {
    assert.ok(feeds.some((row) => row.name === name), `${name} left the roster`);
  }

  // AND THE TWO THAT WOULD NOT RESOLVE ARE NOT HERE. Neither 十字路口 nor
  // 曲率区动 resolved to a channel whose own title matches; the nearest search
  // results were a personal vlog and a data-centre company called Curvature. A
  // wrong id collects somebody else's videos under a name a reader will trust,
  // which is worse than a gap — so the gap is the answer until someone can
  // supply the channel URL.
  const source = readFileSync(new URL("../lib/sources.js", import.meta.url), "utf8");
  const declared = source.slice(source.indexOf("const SOURCES"), source.indexOf("export function sourceFeeds"));
  const code = declared.split(String.fromCharCode(10)).filter((line) => !line.trim().startsWith("//")).join(String.fromCharCode(10));
  for (const missing of ["十字路口", "曲率区动"]) {
    assert.ok(!code.includes(missing), `${missing} is on the roster under an id nobody verified`);
  }
});

test("each channel id is the one that was resolved against YouTube", () => {
  // PINNED, BECAUSE THE RESOLUTION CANNOT BE REPEATED HERE. Verifying an id
  // means two network requests — the channel page for its own
  // `channelMetadataRenderer.externalId`, and the feed to compare titles — and
  // a unit suite does not have a network.
  //
  // So the verification's RESULT is pinned instead. Every id below was checked
  // that way once; changing one has to be a deliberate act that re-does the
  // check, rather than a paste that quietly points a trusted name at somebody
  // else's videos.
  //
  // That is not hypothetical. Reading the first `channelId` off a channel page
  // gave Bessemer as "Ashley Gagnier", 20VC as "Business of Sport", NFX as
  // "N (Nana777)", Kleiner Perkins as "natcin", 张小珺 as "张晓军", and
  // UCbmNph6atAoGfqLoCL_duAg — which reads like Sequoia — is Talks at Google.
  // Six wrong channels out of one afternoon's guessing.
  const RESOLVED = {
    "Sequoia Capital": "UCWrF0oN6unbXrWsTN7RctTw",
    "a16z": "UC9cn0TuPq4dnbTY-CBsm8XA",
    "Greylock": "UCZ7x7yDBbEFCGztD8BYvRhA",
    "Lightspeed Venture Partners": "UCwBTFE_6Bsb_EtmXlW2aTlg",
    "Bessemer Venture Partners": "UCKuHAxZoh99t8uyPQhoDR3A",
    "Khosla Ventures": "UCF92qR15QflJFGO7c_PeT-g",
    "Index Ventures": "UCFMxDWNYefVV3XmCdCBCFjQ",
    "First Round Capital": "UC_oji6l_-xwhmZqCxRGuAXw",
    "NFX": "UC2ZCl6UC4FYlvsUEtK4ZaOg",
    "General Catalyst": "UC92DK_oxZFRuAbT4lU2iTlA",
    "Kleiner Perkins": "UCkNsANayKfsdXFXHpBm8LQg",
    "No Priors": "UCSI7h9hydQ40K5MJHnCrQvw",
    "The Logan Bartlett Show": "UCugS0jD5IAdoqzjaNYzns7w",
    "20VC with Harry Stebbings": "UCf0PBRjhf0rF8fWBIxTuoWA",
    "Acquired": "UCyFqFYfTW2VoIQKylJ04Rtw",
    "Latent Space": "UCxBcwypKK-W3GHd_RZ9FZrQ",
    "The Cognitive Revolution": "UCjNRVMBVI30Sak_p6HRWhIA",
    "Stanford Graduate School of Business": "UCGwuxdEeCf0TIA2RbPOj-8g",
    "Stanford Online": "UCBa5G_ESCn8Yd4vw5U-gIcg",
    "Stanford eCorner": "UCctkeBNtFIOn7Yl_9TTj_4w",
    "张小珺 商业访谈录": "UC3Sv1JuKpbOx3csUO8FAo5g",
  };
  const byName = new Map(sourceFeeds().filter((row) => row.type === "YOUTUBE_VIDEO").map((row) => [row.name, row.url]));
  for (const [name, id] of Object.entries(RESOLVED)) {
    const url = byName.get(name);
    assert.ok(url !== undefined, `${name} left the roster`);
    assert.equal(
      /channel_id=(UC[\w-]{22})$/.exec(url)?.[1],
      id,
      `${name}'s channel id changed. That is not a typo fix — re-resolve it against the channel page's own externalId and its feed title before changing this line, because a wrong id collects somebody else's videos under a name a reader will trust.`,
    );
  }
});
