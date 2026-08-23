# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

One directory per plugin; each is a self-contained package with its own
`package.json`.

| Plugin | What it does |
|---|---|
| `dsh-brand-mine` | Genesis honeycomb mark, the `Genesis Harness` wordmark, and a `deepseek` origin badge, in the sidebar and conversation Hero brand slots |
| `dsh-agents-swarm` | The Agents sidebar entry, its page, and the local source library behind it |
| `dsh-web-search-serper` | Web search for the `ctx.web` seam over interchangeable backends (Serper, Tavily, Brave), with a settings page |
| `dsh-agent-presets` | Agent presets kept in git, published into the writable preset root at boot |

## Install locally

```sh
dsh plugin --profile web add link:D:/engineering/dsh-plugins/<name>
dsh plugin --profile web remove <name>
```

A plugin's browser half is served as a dynamic bundle, independent of the Vite
static shell — restart `dsh` after changing `lib/client.js`; a repository
rebuild is not required.

## Note on `lib/`

`lib/` is committed rather than ignored. A git install fetches sources, not
build output, so a consumer running `dsh plugin add github:...` would otherwise
receive a package that cannot load. The alternative is a self-contained
`prepare` script — see `docs/user/develop/basic/publish.md` in the harness
repository and the [turtle-ui](https://github.com/deepseek-harness/turtle-ui)
example.
