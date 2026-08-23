#!/usr/bin/env bash
#
# Keep the always-on box on the current commit, by itself.
#
# The box runs a checkout, and a checkout only moves when somebody pulls. That
# somebody was a person, and the person forgot — three times in one afternoon,
# each time presenting as a feature that was written, pushed, and apparently
# absent, and each time diagnosed by reading the wrong machine's code first.
#
# The first fix was to SHOW the disagreement in the UI. That was the wrong
# shape: a version mismatch is not information for a reader, it is a deployment
# step that did not happen. Reporting it makes the person the deployment
# system. So the box pulls for itself and the display went back to being a
# version number.
#
# Pulls only fast-forwards, and only restarts when something actually changed:
# a restart resets the collection timer, and a box that restarted every five
# minutes would collect nothing while reporting itself as collecting hourly.
set -uo pipefail

REPO="${1:-$HOME/engineering/dsh-plugins}"
SERVICE="${2:-team.genesis.dsh}"
LOG="${LOG:-$HOME/Library/Logs/dsh-autoupdate.log}"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

cd "$REPO" 2>/dev/null || { say "no repository at $REPO"; exit 1; }

BEFORE="$(git rev-parse HEAD 2>/dev/null)" || { say "not a git checkout"; exit 1; }

# Fetch and fast-forward only. A merge or a rebase here could produce a state
# nobody has ever tested, on a machine nobody is watching.
git fetch --quiet origin 2>>"$LOG" || { say "fetch failed"; exit 1; }
REMOTE="$(git rev-parse origin/main)"

[ "$BEFORE" = "$REMOTE" ] && exit 0

# Local edits mean somebody is working here, and pulling over that would
# discard their work or stop on a conflict. Neither is this script's decision.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "local changes present; leaving $BEFORE alone"
  exit 0
fi

if ! git merge --ff-only --quiet "$REMOTE" 2>>"$LOG"; then
  # Diverged rather than behind — upstream was rewritten, which happens every
  # time a branch is squashed and force-pushed after being pushed once.
  #
  # On THIS machine that is not ambiguous. It never commits; its whole job is
  # to be whatever origin/main is, and the working tree was checked clean two
  # lines up. So it rewinds, loudly, because a hard reset is the one operation
  # here that can destroy something and the log is the only place anybody would
  # find out.
  say "diverged from origin; resetting $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$REMOTE")"
  if ! git reset --hard --quiet "$REMOTE" 2>>"$LOG"; then
    say "reset failed; leaving $(git rev-parse --short HEAD) in place"
    exit 1
  fi
fi

say "updated $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$REMOTE")"

# Dependencies can change with the code, and a plugin whose imports moved will
# fail to load rather than run slightly wrong.
for plugin in dsh-agents-swarm dsh-web-search-serper dsh-agent-presets; do
  [ -f "$plugin/package.json" ] || continue
  ( cd "$plugin" && pnpm install --silent >>"$LOG" 2>&1 ) || say "pnpm install failed in $plugin"
done

launchctl kickstart -k "gui/$(id -u)/$SERVICE" >>"$LOG" 2>&1

# Confirm it came back. A restart that leaves the box down is worse than the
# stale version it replaced, and this is the only moment anything is watching.
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:${DSH_PORT:-3080}/swarm-api/stats" >/dev/null 2>&1; then
    say "restarted and answering"
    exit 0
  fi
  sleep 1
done
say "WARNING restarted but not answering after 60s"
exit 1
