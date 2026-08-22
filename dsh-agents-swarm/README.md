# dsh-agents-swarm

The Agents Swarm surface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a sidebar entry, a full-frame page, and the local source library behind it.

## What it adds

| Slot | Occupant |
|---|---|
| `sidebar.footer.action` | The Agents Swarm entry, beside Settings |
| `shell.overlay` | The page, inset to the right of the sidebar so the navigation column stays |
| `settings.section` | A Sources page inside the shell's own Settings panel |

The page carries four stages — Sources, Insights, Research, Simulation — named
after the gens.team backend modules `explore / insight / research / simulation`.
Only Sources is implemented.

## The source library

`lib/store.js` owns a SQLite database of `Resource` rows, modelled on
gens.team's Prisma schema. It is NOT under `<dshHome>/storages`: the corpus is
the surviving copy of data migrated out of a service being retired, so it is an
asset rather than disposable harness state. The path resolves from
`DSH_SWARM_DB`, then `<dshHome>/swarm-library-location.txt`, then a default.

`ctx.storageDomain` was not used: it documents "no secondary indexes" and serves
reads from fully-resident memory, so every filter and page over a library of
this size would be a full scan. It is also unresolvable from a package outside
the harness checkout.

## Where the rows come from

- **Collectors** (`lib/collect.js`) — arXiv, Hacker News, and any RSS/Atom feed.
  Deterministic: plain fetch and parse, no model in the loop. A collector that
  asks an LLM to read a feed costs tokens per item, fails differently each run,
  and produces nothing that can be diffed.
- **Agents** — `source_library_search` and `source_library_add` are registered on
  `ctx.tools`, so any agent can search the library or add what a crawler cannot
  reach.
- **Seeding** (`/swarm-api/seed`) — a one-off migration from the upstream while
  it is still up. Never a read path.

## Transcripts

Four routes, tried in order, because no single one survives:

1. **cache** — a published video's captions do not change.
2. **timedtext** — free, and the route every implementation takes first. From
   some networks it answers 200 with an empty body; measured with and without
   `Origin` and `Referer`.
3. **gens.team** — works today, and is on its way out with the service.
4. **browser-assisted** — the durable one. The Host reads the watch page and
   extracts the signed caption URL, and the PAGE fetches it: YouTube grants the
   page origin CORS with credentials, so the visitor's own session travels with
   the request. No key, no third party.
5. **Supadata** — paid fallback, key in Settings → Sources.

`youtubetranscript.com` answers a block with HTTP 200 and well-formed caption
XML whose only cue is an apology; `isRelayFailure` is what keeps that apology
from being stored as the transcript.

## Note on `lib/`

`lib/` is hand-authored, not built. The harness's `clientBundle` preset depends
on three modules inside the checkout, and `docs/user/develop/basic/publish.md`
is explicit that a distributable plugin must not assume a sibling monorepo. The
browser bundle's artifact contract — `window.__ModuleLoader__.load({id, factory})`
resolving externals through the injected `require` — is written directly.

A published plugin should instead ship a self-contained `prepare` script, the way
[turtle-ui](https://github.com/deepseek-harness/turtle-ui) does. Until then there
is no separate `src/`: one file per concern under `lib/` IS the source, and a
stale `src/` that no longer matched it was removed rather than left to mislead.
