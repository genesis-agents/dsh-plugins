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

# Overridable so the same script can watch a checkout somewhere else.
REPO="${1:-$HOME/engineering/dsh-plugins}"
SERVICE="${2:-team.genesis.dsh}"
LOG="${LOG:-$HOME/Library/Logs/dsh-autoupdate.log}"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

cd "$REPO" 2>/dev/null || { say "no repository at $REPO"; exit 1; }

# Checked rather than assumed. Under launchd the PATH is whatever the plist
# says, which is not the PATH of the shell anybody tested this in -- and the
# failure mode is not a crash: dependencies quietly fail to install and the
# box restarts into a tree that no longer matches its lockfiles.
for tool in git node pnpm; do
  command -v "$tool" >/dev/null || { say "$tool is not on PATH ($PATH)"; exit 1; }
done

# The starting revision survives a re-exec (see below), because after one the
# checkout has already moved and asking git again would report nothing to do.
BEFORE="${DSH_AUTOUPDATE_BEFORE:-$(git rev-parse HEAD 2>/dev/null)}"
[ -n "$BEFORE" ] || { say "not a git checkout"; exit 1; }

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

# If this script changed in the pull, start the new one over.
#
# bash reads a script from disk by byte offset as it runs, so replacing the
# file underneath a running shell does not reload it -- it keeps reading, at
# the old offset, out of the new bytes. That produced a run that pulled with
# one version and deployed with the version it had just replaced. The guard
# variable makes this happen at most once.
if [ "${DSH_AUTOUPDATE_BEFORE:-}" = "" ] && ! git diff --quiet "$BEFORE" HEAD -- deploy/autoupdate.sh; then
  say "autoupdate.sh changed in this update; restarting with the new one"
  DSH_AUTOUPDATE_BEFORE="$BEFORE" exec bash "$REPO/deploy/autoupdate.sh" "$REPO" "$SERVICE"
fi

say "updated $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$REMOTE")"

# Reconcile the profile with the code that just arrived, every time.
#
# Pulling alone is not deploying. A commit can rename a plugin -- and one did:
# the package moved under a scope, the checkout here updated to match, and the
# profile went on linking the old name. The Loader imports the name in the
# patch file, could not find it, and the box stayed down until somebody went
# looking -- with nothing in this log but a warning nobody was reading.
# setup.sh is idempotent and merges what it does not own,
# so running it on every update costs a few seconds and closes that gap.
apply_profile() {
  bash "$REPO/deploy/setup.sh" >>"$LOG" 2>&1 || say "setup.sh failed"
}

# Restart and wait for it to actually answer. Answering is the test, not
# exiting zero: the harness starts, fails to mount a plugin, and stays up
# serving a page with the feature missing.
restart_and_wait() {
  launchctl kickstart -k "gui/$(id -u)/$SERVICE" >>"$LOG" 2>&1
  for _ in $(seq 1 60); do
    curl -fsS -m 2 "http://127.0.0.1:${DSH_PORT:-3080}/swarm-api/stats" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

apply_profile
if restart_and_wait; then
  say "restarted and answering"
  exit 0
fi

# Roll back. The previous revision was serving a minute ago, and a box that is
# up on yesterday's code is worth more than one that is down on today's --
# especially here, where nobody is watching and the only alternative was a
# warning nobody read.
say "WARNING $(git rev-parse --short "$REMOTE") did not answer in 60s; rolling back to $(git rev-parse --short "$BEFORE")"
if ! git reset --hard --quiet "$BEFORE" 2>>"$LOG"; then
  say "FAILED rollback checkout; box is down on $(git rev-parse --short HEAD)"
  exit 1
fi
apply_profile
if restart_and_wait; then
  # Deliberately still an error exit: the update failed and something should
  # say so, even though the box is serving again.
  say "rolled back to $(git rev-parse --short "$BEFORE") and answering"
  exit 1
fi
say "FAILED box is down on $(git rev-parse --short "$BEFORE") after rollback"
exit 1
