# dsh-web-search-serper

Web search for the DSH web capability seam (`ctx.web`), over interchangeable
backends: **Serper**, **Tavily**, and **Brave Search**.

This is a **third-party plugin**. It imports nothing from the harness — every
capability it needs is reached through `ctx` at runtime, which is what the seams
actually require. A plugin resolved from outside the harness checkout cannot
reach the harness's own packages, so an import would either fail outright or
pull in a second copy whose classes the harness does not recognise. The one
dependency is a schema library, because the settings service needs a schema
object it can call — and it duck-types it, so a locally installed copy is fine.

## Why it exists

The shipped roster selects `deepseek-official`, which resolves
`DEEPSEEK_API_KEY` at each search. A deployment running another model has no
such key, and then web search has no working provider at all — not a degraded
one, none.

## One provider, several backends

`ctx.web` selects exactly ONE search provider, by id, and reads that id once
when the service is constructed. So several search methods cannot be built by
registering several providers: the seam would still use one, and changing which
would mean editing composition config and restarting.

So one provider registers and routes internally. The seam keeps its
single-provider model, and switching backends becomes a settings write that
takes effect on the next search.

This is also why the settings page shows a **choice** rather than a row of
toggles. The reference's tool page can enable many at once because its model
picks a tool per call; showing switches that cannot all be on would
misrepresent what this seam does.

## Configuring it

Settings → **网页搜索 / Web search**. Each backend has a key field, a state
pill, and a Test button that runs a real search through the same code path a
model's search takes.

It brings its own page because Settings → Plugins renders a hand-picked set of
first-party namespaces — thirteen are registered on this deployment and three
get a card. `settings.section` is a `list` slot, so the page is added beside
Models and the rest rather than shadowing any of them.

Keys may also come from the environment: `SERPER_API_KEY`, `TAVILY_API_KEY`,
`BRAVE_API_KEY`. Prefer that — a key in a config file is a key in a backup.
The key field is declared `role('secret')`, so it is stripped from every wire
descriptor; a GET reports only whether one is stored and where it comes from.

## Adding a backend

A backend is a plain object in `lib/backends.js`: an id, a label, its key's
environment variable, how to build the request, and how to map the answer.
Everything else — key resolution, error classification, the settings page —
is shared, so a new one is a file's worth of code and one array entry.

## Mapping

| | sources from | `content` from |
|---|---|---|
| Serper | `organic[]` | `answerBox`, else `knowledgeGraph.description` |
| Tavily | `results[]` | `answer` |
| Brave | `web.results[]` | — (returns none) |

An entry with no URL is dropped; an entry with no snippet is **kept** — these
services always carry a title and a URL, and a titled link is still a usable
source. Inventing a snippet would lie; omitting the field does not.

`publishedAt` carries whatever recency the service reports, which for Serper
and Brave is a relative phrase (`2 days ago`) rather than a timestamp. It is
passed through as the string it is.

## Failures

Redirects are refused rather than followed — the target would be chosen by
whoever answered, and the API key travels in the request. HTTP errors, network
failures and unparseable bodies surface with code `WEB_PROVIDER_ERROR`; an
aborted request surfaces as `WEB_ABORTED`, including an abort that fires while
the body is being read, because cancellation is not a provider error.

## Known limitation

The error carries a `code`, but it is not the harness's own `WebError` class
(see above). `core/tools` attaches `{name, code}` as structured error metadata
only for its own class, so a failure from here reaches the model as its message
without that metadata. The seam does not catch or re-wrap provider errors, so
nothing else is affected.
