# dsh-web-search-serper

A [Serper](https://serper.dev)-backed `WebSearchProvider` for the DSH web
capability seam (`ctx.web`).

This is a **third-party plugin**. It imports nothing from the harness — every
capability it needs is reached through `ctx` at runtime, which is what the seam
actually requires. A plugin resolved from outside the harness checkout cannot
reach the harness's own packages, so an import would either fail outright or
pull in a second copy whose classes the harness does not recognise.

## Why it exists

The shipped roster selects `deepseek-official`, which resolves
`DEEPSEEK_API_KEY` at each search. A deployment running another model has no
such key, and then web search has no working provider at all — not a degraded
one, none.

## Install

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-web-search-serper": "link:D:/engineering/dsh-plugins/dsh-web-search-serper"
  },
  "dsh": { "profile": { "bundles": ["...", "dsh-web-search-serper"] } }
}
```

The bundle patch inserts the provider row **and** points `web` at it. Listing
the plugin without selecting it would leave the shipped provider in charge, so
the two go together; remove the `web` entry from `cordis.patch.yml` to keep the
provider installed but unselected.

## Where to configure it

Three places, in the order the plugin reads them:

1. `~/.dsh/settings.yaml` — the settings document, which the Settings dialog's
   **打开配置文件 / Open config file** button opens:

   ```yaml
   web-search-serper:
     apiKeyEnv: SERPER_API_KEY
     country: cn
   ```

2. The environment: `SERPER_API_KEY` (or whatever `apiKeyEnv` names).
3. The profile's `cordis.patch.yml`, as the composition layer under both.

The plugin also brings **its own page**: Settings → 网页搜索 / Web search, with
a key field, a state line, and a Test search button.

It has to bring one. Settings → Plugins renders a hand-picked set of
first-party namespaces — thirteen are registered on this deployment and three
get a card — so a third-party provider that registered only a namespace would
be configurable in a YAML file and nowhere a person would look. Registering
into `settings.section` sidesteps that: it is a `list` slot, so the page is
added beside Models and the rest rather than shadowing any of them.

The key itself is declared `role('secret')`, so it is stripped from every wire
descriptor and reported only as `{path: ["apiKey"], set: false|true}`. Prefer
`apiKeyEnv` regardless: a key in a config file is a key in a backup.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | — | The key itself. Prefer `apiKeyEnv`; a key in a config file is a key in a backup. |
| `apiKeyEnv` | `SERPER_API_KEY` | Environment variable to read the key from. |
| `baseURL` | `https://google.serper.dev` | `/search` is appended. Unparseable → unavailable. |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`. |
| `country` | (unset) | Serper's `gl`, e.g. `us`, `cn`. |
| `locale` | (unset) | Serper's `hl`, e.g. `en`, `zh-cn`. |

Absent key → the provider registers but reports itself **unavailable**.
Registering anyway is deliberate: a provider that refused to register would be
indistinguishable from one that is not installed, and the operator would have
no way to tell a missing key from a missing plugin. Startup says which it is.

## Mapping

Serper returns several result families in one response. `organic[]` becomes the
sources — `url` ← `link`, `title` ← `title`, `snippet` ← `snippet`,
`publishedAt` ← `date`. An `answerBox` (or, failing that, a `knowledgeGraph`
description) becomes `content`, because it IS a direct answer and dropping it
would discard the most useful part of the response.

An entry with no `link` is dropped; an entry with no `snippet` is **kept**,
unlike the Exa provider's rule — Serper's organic entries always carry a title
and a URL, and a titled link is still a usable source. Inventing a snippet
would lie; omitting the field does not.

`publishedAt` carries Serper's `date`, which is a relative phrase (`2 days
ago`) rather than a timestamp. It is passed through as the string it is.

## Failures

Redirects are refused rather than followed — the target would be chosen by
whoever answered, and the API key travels in the header. HTTP errors, network
failures and unparseable bodies surface with code `WEB_PROVIDER_ERROR`; an
aborted request surfaces as `WEB_ABORTED`, including an abort that fires while
the body is being read (cancellation is not a provider error).

## Known limitation

The error carries a `code`, but it is not the harness's own `WebError` class
(see above). `core/tools` attaches `{name, code}` as structured error metadata
only for its own error class, so a failure from here reaches the model as its
message without that metadata. The seam does not catch or re-wrap provider
errors, so nothing else is affected.
