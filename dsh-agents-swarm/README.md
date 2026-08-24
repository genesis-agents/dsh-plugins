# dsh-agents-swarm

A source library for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it
reads a roster of feeds on a timer, gives you somewhere to read what it finds,
and turns a selection of that into a podcast, a digest, or a report — on demand
or every morning while you sleep.

It adds one entry to the sidebar. Everything else lives behind it.

- **信源 Sources** — 72 feeds out of the box (papers, blogs, reports, policy,
  news, YouTube), searchable and filterable. Articles open in a reader view;
  videos open with their transcript, seekable and translatable.
- **发布 Publish** — pick sources, get a two-host podcast with an RSS feed, a
  digest, or a report. Set a time and it does it daily without you.

Everything is local: a SQLite file, some MP3s, and some Markdown. No account,
no service, nothing phones home except the feeds it fetches and the model you
have already configured.

---

## Requirements

- **A harness.** `npm install -g @deepseek-ai/dsh`, then `dsh --version` to
  check. Verified against `0.1.1-rc.2` on every release. Nothing here pins a
  harness version: a plugin is mounted by the harness rather than imported by
  it, so a peer range in this manifest would only warn in a directory the
  harness is not installed into.
- **Node 24 or newer.** `node:sqlite` is used unguarded, so an older Node does
  not degrade — it throws on the first database call.
- **A model routed in the harness.** Translation and writing use
  `ctx.agentDefaultModel`, so whatever you have configured is what it uses.
  There is no second key to manage.
- **Speech needs no key.** Episodes are spoken through Edge's read-aloud
  endpoint, which is free and keyless. Each line does leave your machine; if
  that matters, the backend is swappable (`lib/tts.js`).

You do **not** need a second machine. See [Two machines](#two-machines-optional)
if you happen to have one.

## Install

Two steps, and the second one is easy to miss.

```sh
dsh plugin --profile web add @ai4gensteam/dsh-agents-swarm
```

That is `pnpm add` in your profile directory — it puts the plugin in
`node_modules` and **does not enable it**. Nothing will happen until you add it
to the bundle list in `~/.dsh/profiles/web/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@ai4gensteam/dsh-agents-swarm"
      ]
    }
  }
}
```

Order matters — patches apply in list order, so add it at the end. Then:

```sh
dsh web
```

A **智能体 / Agents** entry appears in the sidebar footer. The library starts
empty; the roster of 72 feeds installs itself on first boot and the first
collection runs within the hour.

## Where it keeps things

One directory, so the whole library is a single thing you can copy or back up:

```
~/.dsh/swarm/
├── swarm-sources.sqlite     the library
├── thumbnails/              images fetched on demand
├── episodes/                *.mp3 + index.json
└── documents/               *.md + index.json
```

To put it elsewhere, name the location once:

```sh
echo /srv/data/swarm-sources.sqlite > ~/.dsh/swarm-library-location.txt
# or: DSH_SWARM_LIBRARY=/srv/data/swarm-sources.sqlite dsh web
```

Deliberately **not** under the harness's `storages/`, which holds session
caches: this is a corpus that takes months to accumulate, and it should not sit
in the blast radius of a routine cleanup of harness state.

## Publishing

Three formats over the same pipeline — choose sources, gather them, ask the
model, keep the artefact:

| | What it is |
|---|---|
| **播客 Podcast** | A two-host conversation, spoken, with an RSS feed a podcast app can subscribe to |
| **摘要 Digest** | ~500 words. What happened, one entry per source, each heading the finding rather than the headline |
| **报告 Report** | ~1,400 words. What it means, grouped into themes, with the disagreements named |

Set a daily time and choose which of them to produce; the sources are gathered
once and each artefact is attempted independently, so a model that refuses one
does not cost you the others. A day with too little new material is skipped
rather than padded.

The RSS feed is at `/swarm-api/publish/feed.xml`. Subscribing to it from a
phone is the point of the podcast: an episode that only plays in this tab is a
file, and one a podcast client subscribes to is a habit.

## The feeds

72 to start with, verified live. They are a starting point, not a prescription
— add and remove them in **Settings → 信源库**, or read
[`lib/sources.js`](./lib/sources.js) to see what you are getting.

Collection runs hourly and deduplicates by normalized URL, so a source that
appears in three feeds is one row.

## Two machines (optional)

If your workstation sleeps and you have a box that does not, point the
workstation at the box:

```sh
DSH_SWARM_LIBRARY=https://box.your-tailnet.ts.net dsh web
```

A URL means somebody else owns the library: this machine opens no database and
starts no timers, and serves its page locally while proxying `/swarm-api` to
the box. A path — or nothing — means this machine is the collector.

**Which machine owns the library is configured, never detected.** Two
collectors would fetch all 72 feeds twice into two diverging libraries and
publish two podcasts, and no signal distinguishes "should collect" from "is
just looking".

## Checking it works

```sh
curl -s localhost:3080/swarm-api/stats             # the library opened, and from where
curl -s localhost:3080/swarm-api/collect/status    # the timer, and its last runs
curl -s localhost:3080/swarm-api/publish/schedule  # the standing order and what it did
```

`publish/schedule` reports `waiting` — how many new sources the next run would
draw on. Zero every morning means collection is what is broken, not publishing.

## Tests

```sh
npm test
```

They cover the parts whose failures are silent: where the library is, how the
schedule decides a day is due, and what a watermark excludes. A wrong answer
there produces no error — just a podcast that repeats itself, or a schedule
that never fires.

## License

MIT.
