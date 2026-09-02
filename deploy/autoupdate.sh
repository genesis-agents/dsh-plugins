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

# ── in-flight work ──────────────────────────────────────────────────────────
#
# A RESTART KILLS A RUNNING MISSION, and this script had no idea missions
# existed. Measured: a push landed while s3-collect was fetching, the box
# kickstarted three minutes later, and the mission died `runtime_crashed` —
# "the process died during s3-collect" — an hour of paced fetching thrown away
# by a deployment nobody had asked to happen now.
#
# The check goes HERE, before the fast-forward, so a deferred tick leaves the
# checkout exactly as it was. Deferring after the pull would leave the tree on
# new code while the old process is still serving from memory, and the profile
# symlinks point at that tree — so the next lazy import would get half of an
# update nobody restarted into.
#
# BOUNDED, because a mission that hangs must not freeze deployment for ever.
# Past the bound it restarts anyway and says so: every mission arms resume on
# a crash, so the cost of proceeding is a resume, and the cost of never
# updating is a box that drifts until somebody notices.
DEFER_MARK="${DEFER_MARK:-$HOME/.dsh-autoupdate-deferred-since}"
DEFER_MAX="${DEFER_MAX:-7200}"

# AN INSIGHT PASS IS IN-FLIGHT WORK TOO, and this script did not know it.
#
# The mission check below has existed since a push killed a mission mid-fetch.
# The insight pass is the same shape and was not covered: it makes up to twenty
# model calls over minutes, and a restart during one strands its `running`
# marker, which the tab then draws as a progress bar over a process that no
# longer exists. Measured three times in one afternoon, each time by a deploy I
# made myself while a pass was mid-corroboration.
#
# STALENESS IS THE TEST, NOT THE FLAG. `manualRunInFlight` is true only for a
# pass started by the running host process, so it is false for the scheduled
# pass — the unattended one, and therefore the one most likely to be hit. A
# record whose stamp moved in the last four minutes is a live pass whatever
# started it; anything older is already stranded and deferring for it would
# defer for ever.
running_pass() {
  curl -fsS -m 5 "http://127.0.0.1:${DSH_PORT:-3080}/swarm-api/insights/status" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{
        const j=JSON.parse(d).data||{};
        const live=[j.insightLastManualRun,j.insightLastRun].filter(r=>r&&r.running===true)
          .some(r=>Date.now()-Date.parse(r.at||"")<4*60*1000);
        process.stdout.write(j.manualRunInFlight===true||live?"1":"0");
      }catch(e){process.stdout.write("")}})' 2>/dev/null
}

running_missions() {
  curl -fsS -m 5 "http://127.0.0.1:${DSH_PORT:-3080}/swarm-api/missions/list?status=running" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String((j.data&&j.data.missions||[]).length))}catch(e){process.stdout.write("")}})' 2>/dev/null
}

# Either kind of in-flight work defers the update. Summed rather than checked
# separately so the deferral logic below stays one branch: what matters is
# whether ANYTHING is mid-flight, not which of the two it is.
LIVE="$(running_missions)"
PASS="$(running_pass)"
# STRING CONCATENATION WOULD HAVE WORKED AND IS NOT WHAT THIS SAYS. $LIVE is
# compared with -gt 0 below, so appending a digit happens to test true — and
# leaves a variable whose value is a lie about how many things are running.
# An empty answer from either probe is "cannot ask", which the note below
# already reads as "proceed": a box that is not answering has no work to
# protect and probably needs the update.
case "$LIVE" in ""|*[!0-9]*) LIVE=0 ;; esac
case "$PASS" in ""|*[!0-9]*) PASS=0 ;; esac
LIVE=$(( LIVE + PASS ))
# An EMPTY answer is not zero. A box that is down, or a plugin that did not
# mount, cannot be asked what it is running — and treating "cannot ask" as
# "nothing is running" is how this check would pass at exactly the moment it
# is least able to. No answer means proceed, because a box that is not
# answering has no mission to protect and probably needs the update.
if [ -n "$LIVE" ] && [ "$LIVE" -gt 0 ] 2>/dev/null; then
  SINCE="$(cat "$DEFER_MARK" 2>/dev/null || true)"
  NOW="$(date +%s)"
  case "$SINCE" in ''|*[!0-9]*) SINCE="$NOW"; printf '%s' "$NOW" > "$DEFER_MARK" ;; esac
  WAITED=$(( NOW - SINCE ))
  if [ "$WAITED" -lt "$DEFER_MAX" ]; then
    say "deferring $(git rev-parse --short "$REMOTE"): $LIVE mission(s) running (${WAITED}s so far, giving up at ${DEFER_MAX}s)"
    exit 0
  fi
  say "WARNING proceeding over $LIVE running mission(s) after ${WAITED}s; resume is armed for each"
fi
rm -f "$DEFER_MARK"

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
  bash "$REPO/deploy/setup.sh" >>"$LOG" 2>&1
}

answers() { curl -fsS -m 2 "http://127.0.0.1:${DSH_PORT:-3080}/swarm-api/stats" >/dev/null 2>&1; }

# Restart and wait for it to actually answer. Answering is the test, not
# exiting zero: the harness starts, fails to mount a plugin, and stays up
# serving a page with the feature missing.
restart_and_wait() {
  launchctl kickstart -k "gui/$(id -u)/$SERVICE" >>"$LOG" 2>&1
  for _ in $(seq 1 60); do
    answers && return 0
    sleep 1
  done
  return 1
}

# Both halves have to succeed. `apply_profile` used to log its own failure and
# carry on, so a profile that could not be built still counted as a deployment
# -- the restart then found the OLD code still installed, it answered, and the
# run reported success while the update had not landed. That is the same shape
# as every other bug in this file: a check that passes while the thing it is
# checking is broken.
if apply_profile; then
  if restart_and_wait; then
    say "restarted and answering"
    exit 0
  fi
  REASON="did not answer in 60s"
else
  REASON="profile would not build"
fi

# Roll back. The previous revision was serving a minute ago, and a box that is
# up on yesterday's code is worth more than one that is down on today's --
# especially here, where nobody is watching and the only alternative was a
# warning nobody read.
#
# Transient failures land here too. A version published a minute ago is not
# resolvable yet -- the registry rebuilds the document installs resolve against
# a little after the version itself lands -- so the install fails, this rewinds,
# and the tick five minutes later succeeds. Converging slowly is the right trade
# against reporting a deployment that did not happen.
say "WARNING $(git rev-parse --short "$REMOTE") $REASON; rolling back to $(git rev-parse --short "$BEFORE")"
if ! git reset --hard --quiet "$BEFORE" 2>>"$LOG"; then
  say "FAILED rollback checkout; box is down on $(git rev-parse --short HEAD)"
  exit 1
fi
if apply_profile && restart_and_wait; then
  # Deliberately still an error exit: the update failed and something should
  # say so, even though the box is serving again.
  say "rolled back to $(git rev-parse --short "$BEFORE") and answering"
  exit 1
fi
# Asked rather than assumed. When the rollback fails at the profile step
# nothing has been restarted, so the box is still serving whatever it had --
# and saying it is down sends somebody to fix a machine that is working.
if answers; then
  say "FAILED could not deploy $(git rev-parse --short "$REMOTE") and could not rebuild $(git rev-parse --short "$BEFORE"); still serving what was already running"
else
  say "FAILED box is down on $(git rev-parse --short HEAD)"
fi
exit 1
