# Running everything on the Mac mini

**Done.** This describes a migration that was carried out, on
`genesiss-mac-mini` (macOS 26.3.1, Apple Silicon, 16 GB), reached over
Tailscale at `100.92.251.1` as user `genesis`. Where the first draft of this
guide guessed wrong, the step now says what actually worked and what the wrong
version looked like — those are the parts worth reading if you do it again on
another machine.

## Why move at all

Two things here only work on a machine that stays on:

- **Collection.** The roster is 72 feeds on an hourly timer. A laptop that
  sleeps collects nothing while it sleeps, and the timer counts from process
  start, so every wake restarts the clock rather than catching up.
- **Publishing.** The 发布 tab holds a standing order: a time of day, how many
  of the newest sources to draw on, and how long the episode should run. An
  episode generated at 07:00 is only useful if something was awake at 07:00 to
  generate it.

The database moving is a consequence, not the point: it has to sit on the same
machine as the process that writes it. **Do not put the SQLite file on a
network share** — the store opens it in WAL mode, and WAL does not work over a
network filesystem. It needs shared memory that SMB and NFS cannot provide.

## What moved

| | From | To | Verified |
|---|---|---|---|
| The library | `D:\engineering\dsh-db\swarm-sources.sqlite` | `~/engineering/dsh-db/` | `integrity_check: ok`, 20,696 rows |
| Paper thumbnails | `D:\engineering\dsh-db\thumbnails\` | beside the library | 150 files. Rescued from presigned URLs that have since expired — **not re-fetchable** |
| Episodes | `D:\engineering\dsh-db\episodes\` | beside the library | 3 files, playable over the RSS enclosure |
| Plugins | `D:\engineering\dsh-plugins\` | cloned from GitHub | 13/13 tests pass on arm64 |
| Profile | `~/.dsh/profiles/web/` | rewritten with macOS paths | all four are real symlinks |
| Settings + credentials | `~/.dsh/settings.yaml`, `~/.dsh/.credentials.yaml` | same paths | search returns `via: "seam"` |
| Presets | `~/.dsh/.agent-presets/` | republished at boot | `dsh-agent-presets` writes its own |

The database is not a copy to keep in sync — it is **the** library now. The
Windows copy at `D:\engineering\dsh-db\` is a point-in-time snapshot from the
moment of the move and goes stale immediately. Do not run collection on both.

## Steps

The machine started bare: no Node, no pnpm, no Homebrew, no `~/.dsh`.
Everything below installs into the user's own directory, so none of it needs
an administrator password. That matters more than it sounds — the one step
that DOES need `sudo` is the one still outstanding at the bottom.

### 1. Node

`node:sqlite` is used unguarded, so Node 24 or newer. Installed from the
official arm64 tarball rather than Homebrew, which would have meant installing
Homebrew and the Xcode command line tools first:

```sh
V=$(curl -fsSL https://nodejs.org/dist/index.json     | python3 -c "import json,sys;print([r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v24.')][0])")
mkdir -p ~/.local/node
curl -fsSL "https://nodejs.org/dist/$V/node-$V-darwin-arm64.tar.xz"   | tar -xJ -C ~/.local/node --strip-components=1
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zprofile
```

Put it on `PATH` in the same breath. Without that, `node` itself runs but
`npm` does not: npm's shebang is `#!/usr/bin/env node`, so it fails with
`env: node: No such file or directory` — which reads like a broken install
rather than a missing `PATH` entry.

### 2. The harness and the plugins

The harness does not have to be cloned. It publishes as `@deepseek-ai/dsh`,
same version as the working checkout:

```sh
npm config set allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs --location=user
npm i -g pnpm @deepseek-ai/dsh
git clone https://github.com/genesis-agents/dsh-plugins.git ~/engineering/dsh-plugins
for p in dsh-agents-swarm dsh-web-search-serper dsh-brand-mine dsh-agent-presets; do
  (cd ~/engineering/dsh-plugins/$p && pnpm install)
done
```

The `allow-scripts` line is not optional and is easy to skip: npm blocks build
scripts for `node-pty` and `koffi` — both native — and reports it as a
*warning* while exiting 0. The install looks fine and the failure arrives later.
`msedge-tts` has the same shape on the pnpm side, which is why
`dsh-agents-swarm/pnpm-workspace.yaml` now approves it in the repo.

`dsh-agents-swarm` needs its own dependencies (`jsdom`, `@mozilla/readability`,
`turndown`, `msedge-tts`) because a linked plugin resolves from its real path,
not from the profile.

Check the plugin runs on this architecture before going further:

```sh
cd ~/engineering/dsh-plugins/dsh-agents-swarm && node --test tests/*.test.mjs
```

### 3. The library

Copy while **nothing is running**, so the WAL is folded back in first:

```sh
# on Windows, with dsh stopped
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('D:/engineering/dsh-db/swarm-sources.sqlite');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
```

Then copy `dsh-db/` whole — database, `thumbnails/`, `episodes/` — to
`~/engineering/dsh-db/` on the Mac, and check it arrived intact:

```sh
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.HOME+'/engineering/dsh-db/swarm-sources.sqlite');console.log(d.prepare('PRAGMA integrity_check').get());console.log(d.prepare('SELECT COUNT(*) n FROM resources').get())"
```

Expect `ok` and 20,696 (or more, if collection has run since).

### 4. Point the harness at it

```sh
echo "$HOME/engineering/dsh-db/swarm-sources.sqlite" > ~/.dsh/swarm-library-location.txt
```

The thumbnail and episode directories are derived from that path, so they need
no separate configuration — which is exactly why they live beside it.

### 5. The profile

Recreate rather than copy: `~/.dsh/profiles/web/package.json` names
`link:D:/engineering/...`, and those paths do not exist on macOS. Write the
same file with macOS paths, then let pnpm build the links — do NOT hand-link
with `ln -sfn`, which the first draft of this guide said to do. `pnpm install`
in the profile directory creates them from the `link:` values, and doing it by
hand leaves `node_modules/.pnpm` disagreeing with what is on disk.

```sh
mkdir -p ~/.dsh/profiles/web
# same package.json, with link:/Users/<you>/engineering/dsh-plugins/<plugin>
cd ~/.dsh/profiles/web && pnpm install
ls -la node_modules | grep dsh-     # every one must show as l… ->, not d…
```

That last check is not ceremony. On the Windows box `ln -s` under Git Bash
produced a real directory **copy** instead of a link, and the result was a
plugin frozen at the moment it was created — it loaded, reported itself
enabled, and ran stale code for an hour before the cause was found. On macOS
they come out as real symlinks.

### 6. Keys

Two files, and the second is the one that is easy to miss:

| File | Holds |
|---|---|
| `~/.dsh/settings.yaml` | the Serper key, the model *choice*, the locale |
| `~/.dsh/.credentials.yaml` | `OPENAI_API_KEY` and `DEEPSEEK_API_KEY` |

`settings.yaml` names the model provider but not its key — it says
`apiKeyEnv: OPENAI_API_KEY`, and the value lives in `.credentials.yaml`
(leading dot, easy to miss in an `ls`). Move that one too, or the library
comes up fine, serves every row, and then fails at the first translation or
script with nothing obviously wrong.

```sh
scp ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml you@mac:/Users/you/.dsh/
ssh you@mac 'chmod 600 ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml'
```

Neither file holds a Windows path, so they transfer as they are.

### 7. Start it

```sh
dsh web --no-open
```

Not `dsh --profile web web` and not `dsh web --profile web`: `web` IS the alias
for `--profile web`, and passing both gives
`web takes none of parent --profile, --patch, ...` or `unknown option
'--profile'`. Both errors go to the log, not the terminal, if you started it
with `nohup`.

## Reaching it

**`https://genesiss-mac-mini.taild38208.ts.net`** — from any device signed
into the tailnet. No tunnel, no key, no per-machine setup. A new laptop needs
only Tailscale.

That is `tailscale serve`, which publishes the port to the tailnet *only*:

```sh
tailscale serve --bg --https=443 3080     # persists across reboots
tailscale serve status
tailscale serve --https=443 off           # to withdraw it
```

Two things have to be true for this to work, and both are already done:

- **The harness must trust the hostname.** The browser's origin is no longer
  loopback, so the `/api` trust fence rejects it. `--trusted-host
  genesiss-mac-mini.taild38208.ts.net` is in the launchd plist.
- **The feed must know it is behind TLS.** Tailscale Serve terminates HTTPS and
  speaks plain http to the process. The RSS enclosures used to hardcode
  `http://`, which pointed every episode at a port nothing listens on — the
  feed parsed, listed everything, and downloaded nothing. It now reads
  `x-forwarded-proto`.

Verify both at once, since a feed that lists episodes proves nothing about
whether they play:

```sh
curl -s https://genesiss-mac-mini.taild38208.ts.net/swarm-api/publish/feed.xml   | grep -oE '<enclosure url="[^"]+"' | head -1        # must be https://
```

### Know what this exposes

Every device on the tailnet can now reach the harness, and this deployment runs
the `danger-full-access` permission preset — an agent with a shell. Tailnet-only
means devices you own and have authenticated, which is a different thing from
the LAN or the internet, but it is broader than loopback. If that is not the
trade you want, `tailscale serve --https=443 off` and use a tunnel instead:

```sh
ssh -N -L 3080:127.0.0.1:3080 genesis@100.92.251.1
```

The tunnel is per-machine and dies with its shell — it is the right tool for an
occasional connection from one trusted box, and the wrong one for "open it on
my phone".

**Do not use `--host 0.0.0.0`.** That publishes the same shell to the whole
home network, which holds guests' phones and appliances that receive firmware
from their vendors.

## What a home machine changes, and what it does not

**Does not change: what the collectors can reach.** Everything the Host fetches
server-side — the 72 feeds, `og:image` for thumbnails, the reader view, the
transcript fallbacks — goes out over the same kind of residential connection it
does today, so a source that opens now still opens there. A machine in a data
centre would not have that property: bot protection treats hosting ranges far
more harshly than consumer ones, and the sites already refusing this
installation (McKinsey, behind a bot check) are the mild end of that.

**Does not change: YouTube transcripts.** That fetch runs in the BROWSER, not
on the Host — it carries the viewer's own YouTube session, which is the only
reason it works at all. It keeps working from wherever the browser is, and is
indifferent to where the Host moved.

**Does change: what "local" means for speech.** Episodes are currently spoken
by Edge's read-aloud endpoint, which is free and keyless but sends each line to
Microsoft. On a machine in the house, a local backend (Kokoro, 82M parameters,
several times faster than real time on Apple Silicon) makes that literally
true: the script never leaves the building. On a rented machine it would only
mean a different company's data centre.

## Keeping it running

`launchd`, so it starts at boot and restarts if it dies.
`~/Library/LaunchAgents/team.genesis.dsh.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>team.genesis.dsh</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/genesis/.local/node/bin/node</string>
    <string>/Users/genesis/.local/node/bin/dsh</string>
    <string>web</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/genesis/.local/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>/Users/genesis</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/genesis</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/genesis/Library/Logs/dsh.log</string>
  <key>StandardErrorPath</key><string>/Users/genesis/Library/Logs/dsh.err</string>
</dict>
</plist>
```

Node is named explicitly as the program, with `dsh` as its first argument, and
`PATH` is set in `EnvironmentVariables`. launchd does not read `.zprofile`, so
a plist that just says `dsh` finds nothing — and a Node installed under
`~/.local` is not on the default `PATH` either.

```sh
plutil -lint ~/Library/LaunchAgents/team.genesis.dsh.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/team.genesis.dsh.plist
```

`bootstrap`/`bootout`, not `load`/`unload` — the latter still works but is
deprecated and reports failures less clearly. Kill the process once and watch
it come back; `KeepAlive` that has never been tested is a guess:

```sh
kill -9 $(pgrep -f 'dsh web'); sleep 3
curl -s localhost:3080/swarm-api/stats     # answers again within a couple of seconds
```

### Sleep — the one step still outstanding

```sh
sudo pmset -a sleep 0 disablesleep 1
```

This needs an administrator password and has NOT been run. `pmset -g` currently
reports `sleep 0 (sleep prevented by Claude)`, which is an *assertion held by a
running application*, not a setting: if that application quits, the machine
becomes free to sleep again, and both timers stop with it. Everything else here
survives a reboot; this does not survive an app quitting.

## Checking it actually works

In this order, because each answers a different question:

```sh
curl -s localhost:3080/swarm-api/stats            # the library opened, and where from
curl -s localhost:3080/swarm-api/collect/status   # the timer is running, and its last run
curl -s localhost:3080/swarm-api/publish/schedule # the standing order, and what it did last
curl -s -X POST localhost:3080/web-search-api/test -d '{"backend":"serper"}' \
     -H 'content-type: application/json'          # search reaches the network
```

`publish/schedule` also reports `waiting` — how many new sources the next
episode would draw on. If that is zero every morning, collection is the thing
that is broken, not publishing.

The search check reports `via: "seam"` when the search went through
`ctx.web.search()` — the same entry the model's `web_search` tool uses. `via:
"backend"` means it only proved the backend works, not that the harness routes
to it.

## What does not move

**Local digital-human video.** The Mac mini can synthesise speech comfortably —
Kokoro is 82M parameters and runs several times faster than real time on Apple
Silicon — but lip-sync video is another matter. MuseTalk's own README specifies
CUDA and does not mention Apple Silicon; the Mac paths are community forks and
ComfyUI nodes. On 16 GB of unified memory shared with the OS, expect minutes per
clip rather than something interactive.

That is an argument for keeping the video backend behind an API for now, not an
argument against the Mac mini: the audio layer, which is the substance of the
publish tab, runs there for nothing.
