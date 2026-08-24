# deploy

Configuration that is not code and not documentation: what a machine needs to
run this deployment, kept in git so a reinstall does not have to rediscover it.

| File | Goes on | What it is for |
|---|---|---|
| `remote-picker.yml` | the always-on box | Choosing a workspace silently doing nothing, when nobody is sitting at that machine |

That is the whole list, and it used to be longer. A tunnel supervisor lived
here too — see the last section for why it does not any more.

---

## Two machines, one library

The library must share a machine with the process that writes it: the store
opens it in WAL mode, and WAL needs shared memory a network share cannot
provide. The machine that stays on is usually headless; the machine you work at
usually sleeps. So:

- **The always-on box** owns the library and runs both timers. Nothing else.
- **Your workstation** runs its own harness, serves the page from `127.0.0.1`,
  and forwards only `/swarm-api/*` to the box.

```sh
# on the workstation
DSH_SWARM_REMOTE=https://your-box.tailnet.ts.net dsh web --no-open
```

Set that and the plugin opens no database and starts no timers — it becomes a
proxy. Leave it unset and the machine is the collector. **Which machine owns
the library is a decision, not something to detect**: two collectors would
fetch all 72 feeds twice into two diverging libraries and publish two podcasts,
so nothing here guesses.

Both halves of that arrangement matter:

- **The page is local**, so it never crosses the network. All fifteen API
  methods the harness pins to loopback — settings, credentials, native dialogs
  — keep working, and the workstation's own directory picker opens on the
  screen you are looking at.
- **Only library data crosses**, server to server. Measured over a tailnet:
  40 ms for the library stats, 55 ms for twenty resources, 123 ms for a 1.5 MB
  episode.

A single-machine deployment needs none of this. Do not set `DSH_SWARM_REMOTE`,
open the browser at that machine, and stop reading.

---

## `remote-picker.yml`

The harness picks its directory-chooser at boot from what it can infer about
the operator: loopback bind, no SSH launch, and a servable display resolve to
`native` (an OS folder dialog); anything ambiguous resolves to `browse` (a
directory list rendered in the page).

On a headless always-on box that inference lands wrong, and the reason is worth
keeping. `directory-picker-auto` explicitly handles the remote-operator case —
its own comment says a native chooser "would open on the unattended server" —
but it detects that case through `SSH_CONNECTION`. A host started by **launchd**
was not launched over SSH, so the signal is absent, the resolver sees darwin
plus a loopback bind, and mounts `native`. The dialog then opens on a machine
nobody is sitting at, and the browser waits for a click that cannot happen.

The judgement was right; the signal for it does not exist under launchd. So the
interaction is pinned instead, which is what the auto module documents as the
alternative to its row.

```sh
dsh --profile web --patch ~/.dsh/patches/remote-picker.yml --no-open
```

Two things cost time here and are easy to repeat:

- **`--patch` belongs to the parent, not to `web`.** `dsh web --patch …` fails
  with *"web takes none of parent --profile, --patch, …"* — into the log, not
  the terminal, so under launchd it presents as a restart loop.
- **A patch's `name` is a guard, not a setter.** Giving an id a different name
  does not rename the entry; it fails the match and the patch is skipped with a
  warning. Replacing an entry means `disabled: true` plus an `insert`.

Confirm the composition before booting it:

```sh
dsh --profile web --patch <file> --dump-config | grep -A2 directory-picker
```

This file is only needed on the box. A workstation serving its own page wants
the native picker and gets it without help.

---

## A new workstation

1. Install Tailscale, sign in.
2. `npm i -g @deepseek-ai/dsh`, clone this repo, `pnpm install` in each plugin.
3. Recreate `~/.dsh/profiles/web/package.json` with local paths, `pnpm install`.
4. `DSH_SWARM_REMOTE=https://your-box.tailnet.ts.net dsh web --no-open`

No key exchange, no tunnel, no port forwarding. See
[`../docs/mac-mini.md`](../docs/mac-mini.md) for the box, and
[`../docs/architecture.md`](../docs/architecture.md) for why it splits this way.

---

## What used to be here

An SSH tunnel and a supervisor to keep it alive. The workstation ran no harness
of its own, so every byte of the UI — page, plugin bundles, fonts — was pulled
through one long-lived forwarded TCP session.

It failed repeatedly, and each failure looked like the service being down. An
ssh session can lose its far end and keep running: the process is alive, the
port is still bound, and every request hangs. The supervisor written to catch
that grew a health probe, then a stale-port reaper, then a socket probe to
replace an `Invoke-WebRequest` that hung inside the health check itself — three
rounds of fixes for a design that should not have existed. Under it, an 11 KB
plugin bundle that takes 60 ms server-to-server timed out over and over and
surfaced in the browser as *"Failed to load plugins"*.

The lesson is not that the supervisor needed a fourth round. It is that putting
a whole UI on the wire to reach a database was the wrong shape, and no amount
of supervision fixes a wrong shape.

## Which copy a machine runs

```sh
./setup.sh --release     # install from npm  -> the page says "release"
./setup.sh --checkout    # link this tree    -> the page says "dev"
```

Remembered per profile in `<profile>/.plugin-source`, so the self-update — which
runs `setup.sh` with no arguments after every pull — keeps whatever was set.
Serving machines run `--release`; a `dev` profile linked to the checkout sits
beside it for development:

```sh
./setup.sh --profile dev --checkout
dsh --profile dev --no-open --port 3095     # --profile belongs to dsh, not dsh web
```

Switching modes rebuilds the profile's `node_modules` from scratch. pnpm reuses
what it finds, and what it finds after a link is a symlink into the checkout —
installing over it leaves a release profile still pointing at the working tree.

## Releasing

Three steps, and the third is the one that matters.

```sh
# 1. bump both halves — a test fails if they disagree
#    dsh-agents-swarm/package.json  and  lib/client.js's CLIENT_VERSION
cd dsh-agents-swarm && npm test && npm publish --access public

# 2. only now push the bump
git push

# 3. let the box pick it up (five minutes, or force it)
ssh box 'cd ~/engineering/dsh-plugins && bash deploy/autoupdate.sh'

# 4. verify what was published, not what was committed
./release-check.sh 0.3.3 0.3.2
```

Publish before pushing, in that order. A release box installs the caret of the
version the checkout names, so the bump commit is what moves it — push first
and the box pulls a version the registry does not have yet, fails to install,
and rolls back.

Step 3 installs the published versions into a throwaway `DSH_HOME` and boots a
real harness on them. Everything cheaper than that has been passed by a package
nobody could mount: `npm pack` was clean, the install was clean, importing the
package worked, and its own tests passed inside the installed copy — because
all of those reach for the package directly, and a consumer never does. The
harness resolves the `name` in `cordis.patch.yml`, and the page registers the
`id` in `client.js`. Both were stale, and only a boot said so.

The harness it boots comes from npm as well — `@deepseek-ai/dsh@latest`, cached
under `~/.cache/dsh-release-check` and refreshed when the published version
moves. **The first run is slow** — over fifteen minutes on a Windows
filesystem, because the harness is a large tree. Do not wrap it in a timeout;
an interrupted install leaves an empty `node_modules` and the next run fails at
boot instead of at the install. It used to boot the checkout next door through `tsx`, which left the
important word unverified: "can somebody else install this?" answered by a
harness nobody else has, built from sources nobody else fetches. Pass
`HARNESS=/path/to/deepseek-harness` to go back to the checkout while iterating;
leave it unset for the answer that counts.

Give the registry a minute. A version published seconds ago answers on its own
URL while `npm install` still reports "no matching version found", because npm
resolves against a cached packument; `release-check.sh` passes `--prefer-online`
for exactly that reason.
