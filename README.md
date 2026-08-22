# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

One directory per plugin; each is a self-contained package with its own
`package.json`.

| Plugin | What it does |
|---|---|
| `dsh-brand-mine` | Fills the sidebar and conversation Hero brand slots with a custom mark and wordmark |

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
