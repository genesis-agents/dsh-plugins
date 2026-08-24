# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
One directory per plugin; each is a self-contained package with its own
`package.json`.

| Plugin | On npm | What it does |
|---|---|---|
| [`dsh-agents-swarm`](./dsh-agents-swarm) | [`@ai4gensteam/dsh-agents-swarm`](https://www.npmjs.com/package/@ai4gensteam/dsh-agents-swarm) | A source library — 72 feeds on an hourly timer, a reader with transcripts and translation, and a publisher that turns what it collects into a podcast, a digest or a report |
| [`dsh-web-search-serper`](./dsh-web-search-serper) | [`@ai4gensteam/dsh-web-search`](https://www.npmjs.com/package/@ai4gensteam/dsh-web-search) | Web search for the `ctx.web` seam over interchangeable backends: Serper, Tavily, Brave |
| [`dsh-brand-mine`](./dsh-brand-mine) | — | A brand mark and wordmark in the sidebar and conversation hero slots |
| [`dsh-agent-presets`](./dsh-agent-presets) | — | Agent presets kept in git, published into the writable preset root at boot |

The directory name and the package name differ for the search plugin: the
directory kept `-serper` from when Serper was the only backend, the package did
not. What the harness resolves is always the **package** name.

## Install

You need a harness first — these are plugins for one, not programs:

```sh
npm install -g @deepseek-ai/dsh
dsh --version                  # verified against 0.1.1-rc.2
```

Then add the plugins to the profile's `package.json` and let the harness mount
them:

```jsonc
{
  "dependencies": {
    "@ai4gensteam/dsh-agents-swarm": "^0.3.2",
    "@ai4gensteam/dsh-web-search": "^0.3.2"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@ai4gensteam/dsh-agents-swarm",
        "@ai4gensteam/dsh-web-search"
      ]
    }
  }
}
```

```sh
cd ~/.dsh/profiles/web && npm install
dsh web --no-open        # then open http://127.0.0.1:3080
```

Bundle order is load order: a patch only sees what was applied before it, so a
bundle placed ahead of the one it customises gets overwritten by it.

Node 24 or newer — `dsh-agents-swarm` uses `node:sqlite` unguarded.

Each plugin's own README covers its settings and the keys it needs. Nothing
works without them, and none of them are in this repository.

## Develop against a checkout

```sh
git clone https://github.com/genesis-agents/dsh-plugins
cd dsh-plugins && ./deploy/setup.sh
```

`setup.sh` links every plugin into `~/.dsh/profiles/web` and installs their
dependencies. It is idempotent, safe to re-run after a pull, and it **merges** —
plugins in your profile that this repo does not own are left alone.

One argument, the only genuinely per-machine choice, is where the source
library lives:

```sh
./deploy/setup.sh                                # this machine owns it
./deploy/setup.sh https://box.tailnet.ts.net     # proxy to the machine that does
./deploy/setup.sh /srv/data/swarm-sources.sqlite # own one at a chosen path
```

Then `./deploy/doctor.sh` to check the result, and `./deploy/release-check.sh`
before trusting anything that was published.

## Why `lib/` is committed

A git install fetches sources, not build output, so a consumer running
`dsh plugin add github:...` would otherwise receive a package that cannot load.
The alternative is a self-contained `prepare` script — see
`docs/user/develop/basic/publish.md` in the harness repository and the
[turtle-ui](https://github.com/deepseek-harness/turtle-ui) example.

## Documentation

- [Architecture](./docs/architecture.md) — what runs where, the pipeline, the
  data, the seams, and a table of failures that do not announce themselves
- [Running it on a Mac mini](./docs/mac-mini.md) — a migration that was actually
  carried out, including the steps whose first draft was wrong
- [`deploy/`](./deploy/README.md) — setup, health check, self-update, release

## License

MIT
