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
