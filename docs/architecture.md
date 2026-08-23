# Architecture

What this repository is, where every piece runs, and which parts are safe to
replace. Written to be maintained: each section says what is true today and
what would have to change to make it false.

Status as of 2026-08-23, commit `9d5f5b6`. Running on `genesiss-mac-mini`
(macOS 26.3.1, Apple Silicon, 16 GB), reached over Tailscale.

---

## 1. What this is

Four third-party plugins for DeepSeek Harness. Three are small. One,
`dsh-agents-swarm`, is effectively a second application living inside the
harness's shell: its own database, its own HTTP routes, its own UI, its own
timers. It reads 72 feeds on an hourly timer and turns what it collects into
something you can read or listen to.

The harness supplies four things and nothing else matters: a plugin loader, a
UI slot registry, a model route, and an HTTP server to hang routes off.

```mermaid
flowchart TB
  subgraph browser["Browser — wherever you open it"]
    direction LR
    UI["Agents panel<br/>信源 · 发布"]
    YT["YouTube timedtext<br/><i>carries your own session</i>"]
  end

  subgraph mac["Mac mini — always on, home network, UTC-4"]
    direction TB
    HOST["dsh host process<br/><i>launchd · KeepAlive</i>"]
    T1(["collection timer<br/>hourly"])
    T2(["publish timer<br/>daily 07:00"])
    DB[("SQLite<br/>20,696 rows · 80 MB")]
    FILES[["thumbnails/ 150<br/>episodes/ *.mp3"]]
    HOST --- T1
    HOST --- T2
    T1 --> DB
    T2 --> DB
    DB -.same directory.- FILES
  end

  subgraph ext["External services"]
    direction TB
    FEEDS["72 RSS/Atom feeds"]
    MODEL["model API<br/><i>translation · scripts</i>"]
    TTS["Edge read-aloud<br/><i>free, keyless</i>"]
    SEARCH["Serper / Tavily / Brave"]
    SUPA["Supadata<br/><i>transcript fallback</i>"]
  end

  UI <-->|"SSH tunnel :3080"| HOST
  YT -->|transcript| HOST
  T1 --> FEEDS
  HOST --> MODEL
  HOST --> TTS
  HOST --> SEARCH
  HOST --> SUPA
  T2 -->|RSS| PODCAST["Podcast app"]
```

The three constraints that fix this shape:

1. **The timers need a machine that stays on.** A desktop that sleeps collects
   nothing while it sleeps, and an episode generated at 07:00 needs something
   awake at 07:00.
2. **The database must sit on the same machine as the process that writes it.**
   The store opens it in WAL mode, and WAL needs shared memory that SMB and NFS
   cannot provide. Putting the file on a network share and keeping the process
   elsewhere is the obvious-looking arrangement that silently corrupts.
3. **Transcripts must be fetched by the browser.** YouTube has hardened
   `timedtext`; a server-side fetch returns an empty body for most videos. The
   browser fetch carries the viewer's own session, which is the only reason it
   works — so this one step is indifferent to where the host lives.

---

## 2. The four plugins

| Plugin | What it is | `lib/` |
|---|---|---|
| `dsh-agents-swarm` | The source library, reader, and podcast publisher | 10,108 lines |
| `dsh-web-search-serper` | One `ctx.web` provider routing to three search backends | 1,152 lines |
| `dsh-brand-mine` | Occupies the brand slots in the sidebar and hero | 104 lines |
| `dsh-agent-presets` | Agent presets under version control, republished at boot | 81 lines |

They are independent. Removing any one leaves the others working.

### How a plugin attaches

Every plugin has two halves that never share a process.

```mermaid
flowchart LR
  subgraph host["Host half — Node, lib/index.js"]
    APPLY["apply(ctx, config)"]
    INJ["export const inject = ['webServer', ...]"]
    ROUTES["ctx.webServer routes<br/>/swarm-api/*"]
    TIMERS["timers"]
    STORE["SQLite"]
    APPLY --> ROUTES
    APPLY --> TIMERS
    ROUTES --> STORE
    TIMERS --> STORE
  end

  subgraph client["Client half — browser, lib/client.js"]
    LOADER["window.__ModuleLoader__.load"]
    SLOTS["ctx.slots.register(...)"]
    REACT["React components"]
    LOADER --> SLOTS --> REACT
  end

  PATCH["cordis.patch.yml<br/><i>declared as dsh.bundle.patch</i>"] --> APPLY
  PKG["package.json → dsh.client"] --> LOADER
  REACT -->|fetch| ROUTES
```

The client half is not bundled or compiled by the harness — it is a plain
`lib/client.js` registering a factory with `window.__ModuleLoader__`. That is
why it is written as `jsx(...)` calls rather than JSX syntax: nothing
transforms it.

### The slots occupied

| Slot | Kind | By | Note |
|---|---|---|---|
| `sidebar.footer.action` | list | swarm | additive — sits beside Settings |
| `shell.overlay` | list | swarm | the panel, frame-wide, click-through until it opts in |
| `settings.section` | list | swarm, search | added beside Models and Appearance |
| `sidebar.brand.mark` | **single** | brand-mine | registered at priority **-1** |
| `sidebar.brand.name` | **single** | brand-mine | same |
| `conversation.hero.brand.mark` | **single** | brand-mine | same |

**List slots are additive; single slots are not.** A second registration on a
single slot at the same priority is a collision, and the loader refuses the
whole plugin rather than picking a winner — which takes the entire UI down, not
just that slot. This is not hypothetical: `@linxin666/dsh-liangshen` claims
`sidebar.brand.mark` from 0.2.9, a profile pinned to `^0.2.1` picked it up on a
fresh install, and the page rendered nothing but the error. Lower priority
renders, so `dsh-brand-mine` now states `-1`.

---

## 3. The pipeline

Ten stages from a feed to something in your ears. Colour marks where each runs.

```mermaid
flowchart TB
  F["1 · Collect<br/><i>hourly · 72 feeds</i>"] --> DB[("SQLite")]
  DB --> TH["2 · Thumbnail<br/><i>on demand · og:image</i>"]
  DB --> RD["3 · Reader<br/><i>Readability → Markdown</i>"]
  DB --> TR["4 · Transcript<br/><i>browser · your session</i>"]
  TR -->|"fails"| SUPA["4b · Supadata<br/><i>paid fallback</i>"]
  TR --> TL["5 · Translate<br/><i>20-block batches, cached</i>"]
  DB --> SC["6 · Script<br/><i>one model call</i>"]
  TR --> SC
  RD --> SC
  SC --> SP["7 · Speech<br/><i>~840 ms per turn</i>"]
  SP --> EP["8 · Episode<br/><i>MP3 + index.json</i>"]
  EP --> RSS["9 · RSS<br/><i>Range-capable audio</i>"]
  RSS --> LI["10 · Listen<br/><i>browser or podcast app</i>"]

  classDef host fill:#e8f0fe,stroke:#4a6fa5,color:#16324f
  classDef brow fill:#fdf0e6,stroke:#c07a3e,color:#5a3410
  classDef extn fill:#f0ece9,stroke:#8a7f76,color:#3d3733
  class F,TH,RD,SC,SP,EP,RSS host
  class TR,LI brow
  class SUPA,TL extn
```

Blue runs on the Mac mini, orange in the browser, grey reaches an external
service (as do the model and TTS calls inside stages 5, 6, and 7).

**Scheduled publishing** wires 6 → 9 together. At the configured local time the
timer takes the newest sources collected since the last episode, runs the whole
chain, and records what it did. Design notes worth keeping:

- **Local wall-clock, not an interval.** "Every 24 hours" drifts with every
  restart until the episode arrives at three in the morning.
- **Catch-up is bounded to six hours.** A machine asleep at 07:00 and awake at
  09:00 still makes the episode. Unbounded catch-up means typing 07:00 at three
  in the afternoon fires one on the spot.
- **The window does not cross midnight.** Catching up would mean marking
  *yesterday* served, and the date stamp is what makes "already ran" answerable.
  Schedules near midnight lose their catch-up.
- **A thin day is skipped, not padded.** An episode from two press releases
  costs the same model call, takes the same place in the feed, and teaches the
  listener the feed is not worth opening.
- **A watermark, not a timestamp.** Each episode records the newest row it
  covered so the next starts there. It deliberately steps over rows it did not
  cover — a digest that works through a backlog falls further behind daily.

---

## 4. Data

One SQLite file. Everything else derives its location from it, which is what
makes the library a single directory you can copy.

```mermaid
erDiagram
  resources ||--o| transcripts : "has at most one"
  resources ||--o{ transcript_translations : "per language, per block"
  resources ||--o{ notes : "timestamped"

  resources {
    text id PK
    text type "PAPER BLOG REPORT YOUTUBE_VIDEO NEWS POLICY ..."
    text title
    text abstract
    text source_url
    text thumbnail_url "enriched; COALESCE-protected"
    text normalized_url UK "dedupe key"
    text raw "JSON snapshot at collection"
    text created_at "the watermark field"
    text updated_at
  }
  transcripts {
    text resource_id PK
    text language
    text text
    text cues "JSON"
  }
  transcript_translations {
    text resource_id PK
    text target_lang PK
    int  block_start PK
    text text
  }
  settings {
    text key PK
    text value "JSON"
  }
```

`resources` has 20 columns; the ones above are the load-bearing ones.

**Two traps live in this table, both of which have already cost a day.**

`raw` is a snapshot of what the source handed over at collection time. Columns
written *afterwards* are invisible if a row is served from `raw` alone. This is
what hid 937 enriched thumbnails, and later what made every `createdAt`
comparison run against `undefined` — which would have made the podcast repeat
itself indefinitely without erroring. `withColumns()` in `store.js` layers
column values over the snapshot; anything new written as a column must be added
there or it will not reach the page.

`put` upserts, and the hourly collection re-writes every row it still sees. Any
column enriched later needs `COALESCE(excluded.x, resources.x)` or the next
cycle erases it. Today only `thumbnail_url` does.

### Where files live

```
~/engineering/dsh-db/                      ← pointer target
├── swarm-sources.sqlite                   80 MB, 20,696 rows
├── thumbnails/                            150 files — rescued, NOT re-fetchable
└── episodes/                              *.mp3 + index.json
```

Resolved in `lib/index.js:storePath()`, in order:

1. `DSH_SWARM_DB` environment variable
2. `~/.dsh/swarm-library-location.txt` — a one-line pointer file
3. `~/.dsh/storages/swarm-sources.sqlite` — the default

`thumbnailDir()` and `episodeDir()` are `dirname(storePath()) + "/…"`, so they
follow the database without separate configuration. **No path is hardcoded
anywhere in the code** — a regex sweep for drive letters over every `.js`,
`.ts`, `.yml`, and `.json` returns nothing.

---

## 5. HTTP surface

All under `/swarm-api` except where noted.

| Group | Routes |
|---|---|
| Library | `/resources`, `/resources/:id`, `/resources/search/suggestions`, `/resources/sources/facets`, `/stats` |
| Collection | `/collect`, `/collect/status`, `/collectors`, `/seed` |
| Config | `/config` (GET, PUT) |
| Media | `/thumbnail/:id`, `/thumbnail-for`, `/enrich-thumbnails`, `/video-info` |
| Fetch proxy | `/proxy/image`, `/proxy/pdf`, `/proxy/html`, `/proxy/reader` |
| Transcripts | `/transcript`, `/transcript/tracks`, `/transcript/ingest`, `/transcript/translation`, `/transcript/translate` |
| Notes | `/notes` |
| Model | `/chat`, `/quick-action` |
| Publish | `/publish/voices`, `/publish/script`, `/publish/render`, `/publish/jobs/:id`, `/publish/schedule`, `/publish/run-now`, `/publish/episodes`, `/publish/episodes/:id/audio`, `/publish/feed.xml` |
| Search *(separate plugin, `/web-search-api`)* | `/config`, `/test` |

Two shapes worth knowing. **Rendering is a job, not a request**: a ten-minute
episode is one model call plus ~40 synthesis round trips, and an HTTP request
held open for minutes reads as a hang. `/publish/render` returns a job id and
the page polls. **Episode audio answers Range requests** (206) — an `<audio>`
element seeking, and every podcast client, ask for ranges; answering 200 with
the whole body makes seeking silently reload from the start.

---

## 6. Seams

What can be replaced, at what cost. This is the section to read before planning
any change.

| Seam | How | Cost |
|---|---|---|
| **Machine** | Pointer file + env; no hardcoded paths | Configuration only — [`mac-mini.md`](./mac-mini.md) is the record of doing it |
| **TTS backend** | `TTS_BACKENDS` in `lib/tts.js`, each with a `local` flag | Add an entry. Kokoro (82M, faster than real time on Apple Silicon) would make speech never leave the building |
| **Search backend** | `BACKENDS = [serper, tavily, brave]` in the search plugin | Add a plain object |
| **Model** | Borrowed from `ctx.agentDefaultModel.currentSelection()`, read per request | Change it in harness settings; nothing here to touch |
| **Source roster** | `lib/sources.js` — 72 feeds as data, editable from the settings page | Data |
| **Database** | All 27 statements in `store.js`, one `node:sqlite` import | **Expensive — see below** |

### Why the database is a one-way door

It looks swappable: the SQL is in one file behind one import. It is not, and
the reason is not the dialect.

`node:sqlite`'s `DatabaseSync` is **synchronous**, so `store.query()`,
`store.put()`, and `store.getSetting()` are synchronous. There are 45 call
sites and **zero** `await`s. Every network database is async. Swapping to
Postgres is not 27 statements — it is making the store async and then touching
every caller, every route, and both timers.

**This is the right trade, not an oversight.** Single writer, single machine,
80 MB, embedded: SQLite is the correct answer, and wrapping it in an async
abstraction would be paying a real cost for a migration that will probably
never happen. But know the price: the day two machines need to write the same
library, that is a refactor of the call layer, not a driver change.

---

## 7. Operating it

### Is it alive

```sh
curl -s localhost:3080/swarm-api/stats             # library opened, and from where
curl -s localhost:3080/swarm-api/collect/status    # timer running, and its last runs
curl -s localhost:3080/swarm-api/publish/schedule  # standing order, last result, `waiting`
curl -s -X POST localhost:3080/web-search-api/test \
     -H 'content-type: application/json' -d '{"backend":"serper"}'
```

`publish/schedule` reports `waiting` — how many new sources the next episode
would draw on. Zero every morning means *collection* is broken, not publishing.
The search check reports `via: "seam"` when it went through `ctx.web.search()`,
the same entry the model's `web_search` tool uses; `via: "backend"` proves only
that the backend works, not that the harness routes to it.

**None of these prove the page loads.** They are all server routes, and all six
passed once against a UI that could not render at all. Open the browser.

### Logs and lifecycle

```sh
tail -f ~/Library/Logs/dsh.log ~/Library/Logs/dsh.err
launchctl kickstart -k gui/$(id -u)/team.genesis.dsh    # restart
```

`launchctl bootstrap` / `bootout`, not `load` / `unload`. Collection history
also lives in the database (last 30 runs) and is rendered in the settings page,
because `ctx.logger` output does not reach this harness's stdout.

### Tests

```sh
cd dsh-agents-swarm && npm test        # 13 tests, node --test
```

They cover the scheduling logic specifically — date math, the catch-up window,
the watermark, the config whitelist — because every way that code can be wrong
is silent.

---

## 8. Failures that do not announce themselves

The most valuable thing in this document. Each of these has actually happened.

| Symptom | Cause |
|---|---|
| Enriched data never appears | Read went through `raw`, not `withColumns()` |
| Enrichment erased every hour | `put` overwrote instead of `COALESCE` |
| Podcast repeats itself | `createdAt` absent from `raw`; every comparison against `undefined` |
| Schedule never fires | `publishAt` unparseable reads as "no schedule". Now rejected on write |
| Rejection with an empty reason | `problems.push()` with no argument |
| Episodes store zero turns | `saveEpisode` checked `Array.isArray` against an object |
| Host B speaks in Host A's voice | Label matched only exact lowercase `"b"` |
| Plugin runs stale code | `ln -s` under Git Bash on Windows makes a directory **copy**. Check for `l…->`, not `d…` |
| Whole UI blank | Two plugins on one single slot at equal priority |
| Install "succeeds", audio mute | npm and pnpm block native build scripts and report it as a **warning**, exiting 0 |
| Library serves fine, translation fails | `.credentials.yaml` not moved — `settings.yaml` names the provider but not its key |
| Over-reported date comparisons | `datetime('now')` renders with a space, stored ISO uses `T`, and `'T' > ' '` |

A pattern runs through these: **the check that passes is not the check that
matters.** A route answering 200, an install exiting 0, a plugin reporting
itself enabled — none of them is evidence about the thing you actually wanted.

---

## 9. Where this stands

**Real and complete.** The source library (20,696 rows, reader, transcripts,
translation, on-demand thumbnails) and publishing (script, speech, episodes,
RSS, daily schedule). Both do things the chat window cannot: one is a reading
surface for a corpus too large to page through in conversation, the other
produces an artefact you can take with you.

**Empty.** Three of the five panel tabs — 洞察, 研究, 推演 — render a lede and
nothing else (`lib/client.js`, the ternary at line 3730). The five-stage
pipeline was copied from gens.team's backend module names
(`explore / insight / research / simulation`); it is their information
architecture, not one derived from how this gets used.

The open question is not scheduling but existence. Extracting claims,
digging into one, projecting it forward — the harness's chat window already
does all three, with tools and multi-turn context. Building a tab, a schema,
and a UI for each risks rebuilding the chat window worse. Either fill them with
something that is genuinely not chat-in-a-box, or cut them and ship two tabs
that are complete.

**Outstanding.**

- `sudo pmset -a sleep 0 disablesleep 1` on the Mac — not run; needs a
  password. `pmset -g` currently reports sleep prevented by an *application
  assertion*, which ends when that application quits. Everything else survives
  a reboot; this does not.
- The Windows copy at `D:\engineering\dsh-db\` is a point-in-time snapshot from
  the migration and goes stale immediately. Do not run collection on both.
- Local digital-human video stays behind an API. MuseTalk specifies CUDA; the
  Apple Silicon paths are community forks, and 16 GB shared with the OS means
  minutes per clip. The audio layer — the substance of the publish tab — runs
  on the Mac for nothing.

---

## Related

- [`mac-mini.md`](./mac-mini.md) — the migration, as carried out, including the
  four steps the first draft got wrong.
