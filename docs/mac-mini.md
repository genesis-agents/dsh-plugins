# Running everything on the Mac mini

Written against this deployment: a Windows desktop that has been the host, and
a Mac mini that should take over. **Untested** — it is derived from how this
installation is actually wired, not from having run it there. Every step says
what to check, so a wrong assumption surfaces at that step rather than three
steps later.

## Why move at all

Two things here only work on a machine that stays on:

- **Collection.** The roster is 72 feeds on an hourly timer. A laptop that
  sleeps collects nothing while it sleeps, and the timer counts from process
  start, so every wake restarts the clock rather than catching up.
- **Publishing.** An episode generated at 06:00 is only useful if something
  was awake at 06:00 to generate it.

The database moving is a consequence, not the point: it has to sit on the same
machine as the process that writes it. **Do not put the SQLite file on a
network share** — the store opens it in WAL mode, and WAL does not work over a
network filesystem. It needs shared memory that SMB and NFS cannot provide.

## What has to move

| | Where it is now | Notes |
|---|---|---|
| The library | `D:\engineering\dsh-db\swarm-sources.sqlite` | 82 MB; 20,696 rows. The only copy. |
| Paper thumbnails | `D:\engineering\dsh-db\thumbnails\` | 150 files. Rescued from presigned URLs that have since expired — not re-fetchable. |
| Episodes | `D:\engineering\dsh-db\episodes\` | Created by the publish tab, beside the database for the same reason. |
| Plugins | `D:\engineering\dsh-plugins\` | Clone from GitHub instead of copying. |
| Profile | `~/.dsh/profiles/web/` | `package.json` names Windows paths — see below. |
| Settings | `~/.dsh/settings.yaml` | **Holds API keys.** Move it deliberately, not with a bulk copy. |
| Presets | `~/.dsh/.agent-presets/` | `dsh-agent-presets` republishes its own at boot; anything hand-edited there is not in git. |

## Steps

### 1. Node

`node:sqlite` is used unguarded, so Node 24 or newer. Check first:

```sh
node --version   # must be >= 24
```

### 2. The repositories

```sh
git clone https://github.com/genesis-agents/dsh-plugins.git ~/engineering/dsh-plugins
cd ~/engineering/dsh-plugins/dsh-agents-swarm && pnpm install
cd ../dsh-web-search-serper && npm install
```

`dsh-agents-swarm` needs its own dependencies (`jsdom`, `@mozilla/readability`,
`turndown`, `msedge-tts`) because a linked plugin resolves from its real path,
not from the profile.

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
`link:D:/engineering/...`, and those paths do not exist on macOS. Edit the
dependency values to the new absolute paths, then re-link. On macOS the links
are ordinary symlinks:

```sh
cd ~/.dsh/profiles/web/node_modules
ln -sfn ~/engineering/dsh-plugins/dsh-agents-swarm      dsh-agents-swarm
ln -sfn ~/engineering/dsh-plugins/dsh-brand-mine        dsh-brand-mine
ln -sfn ~/engineering/dsh-plugins/dsh-agent-presets     dsh-agent-presets
ln -sfn ~/engineering/dsh-plugins/dsh-web-search-serper dsh-web-search-serper
ls -la | grep dsh-          # every one must show as l… ->, not d…
```

That last check is not ceremony. On the Windows box `ln -s` under Git Bash
produced a real directory **copy** instead of a link, and the result was a
plugin frozen at the moment it was created — it loaded, reported itself
enabled, and ran stale code for an hour before the cause was found.

### 6. Keys

Copy the values, not the file — `settings.yaml` on the Mac will accumulate its
own state. The ones that matter:

```yaml
web-search:
  active: serper
  backends:
    serper:
      apiKey: ...
```

Or export them in the launch environment instead (`SERPER_API_KEY`), which
keeps them out of a file that gets backed up.

## Reaching it from the Windows box

**Use an SSH tunnel. Do not bind to `0.0.0.0`.**

```sh
ssh -N -L 3080:127.0.0.1:3080 you@macmini.local
```

Then open `http://127.0.0.1:3080` on Windows as before. The harness keeps
listening only on loopback, the browser still sees a loopback origin, and the
`/api` trust fence needs no exception.

`dsh --profile web --host 0.0.0.0 --trusted-host macmini.local:3080` also
works and needs no tunnel. It is offered here only to be dismissed: this
deployment runs with the `danger-full-access` permission preset, which means an
agent with a shell on that machine. Binding it to the LAN publishes that shell
to every device on the network, with no authentication in front of it. The
tunnel costs one command and removes the entire question.

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
    <string>/usr/local/bin/node</string>
    <string>--import</string><string>tsx/esm</string>
    <string>apps/cli/src/bin.ts</string>
    <string>web</string><string>--no-open</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/engineering/deepseek-harness</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/dsh.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/dsh.err</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/team.genesis.dsh.plist
```

Then stop the Mac from sleeping, or the timer stops with it:

```sh
sudo pmset -a sleep 0 disablesleep 1
```

## Checking it actually works

In this order, because each answers a different question:

```sh
curl -s localhost:3080/swarm-api/stats            # the library opened, and where from
curl -s localhost:3080/swarm-api/collect/status   # the timer is running, and its last run
curl -s -X POST localhost:3080/web-search-api/test -d '{"backend":"serper"}' \
     -H 'content-type: application/json'          # search reaches the network
```

The last one reports `via: "seam"` when the search went through
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
