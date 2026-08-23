#!/usr/bin/env bash
#
# Check that this machine's installation actually works.
#
# Not a smoke test of whether things are installed — a test of whether they
# DO anything. That distinction is the whole point. `ln -s` under Git Bash made
# a directory copy and the plugin ran stale code for an hour while reporting
# itself enabled; npm blocked build scripts for node-pty and koffi and reported
# it as a warning while exiting 0. In each case "installed" was true and
# "works" was false.
#
# It cuts the other way too, which is why these checks run the thing rather
# than reasoning about it. ERR_PNPM_IGNORED_BUILDS from msedge-tts looked like
# the same class of failure and was written up as one here — wrongly. That
# package ships its compiled output and speaks fine with every script blocked;
# the skipped script was a guard refusing non-pnpm installs. A check that only
# reads warnings would have produced a confident wrong answer in both
# directions.
#
# So each check below exercises the thing rather than looking for it, and says
# what to do when it fails. Run it any time something seems wrong, not only
# after installing.
#
#   ./doctor.sh            check the machine
#   ./doctor.sh --verbose  also print what each check found
set -uo pipefail

VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
PORT="${DSH_PORT:-3080}"
PASS=0; FAIL=0; WARN=0

ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m    %s\n' "$1"; [ "$VERBOSE" = 1 ] && [ -n "${2:-}" ] && printf '        %s\n' "$2"; return 0; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        \033[33m%s\033[0m\n' "$2"; return 0; }
warn() { WARN=$((WARN+1)); printf '  \033[33mwarn\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; return 0; }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

head "Runtime"

if ! command -v node >/dev/null 2>&1; then
  bad "node is not on PATH" "install Node 24+, then re-run"
else
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAJOR" -ge 24 ]; then
    ok "node $(node --version)"
  else
    # Not advice: node:sqlite is used unguarded, so an older Node does not
    # degrade, it throws on the first database call.
    bad "node $(node --version) is too old" "node 24+ is required; node:sqlite is used unguarded"
  fi
fi

command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm --version)" || warn "pnpm not found" "needed to install plugin dependencies: npm i -g pnpm"
if command -v dsh >/dev/null 2>&1; then
  ok "dsh $(dsh --version 2>/dev/null | tail -1)"
elif curl -fsS -m 5 "http://127.0.0.1:${DSH_PORT:-3080}/swarm-api/stats" >/dev/null 2>&1; then
  # A source checkout launched with tsx is a legitimate way to run this and
  # puts no `dsh` on PATH. Reporting that as a failure sends someone to install
  # a second copy of a harness that is already answering.
  ok "harness running from a source checkout" "no global dsh, and none needed"
else
  bad "dsh not found" "npm i -g @deepseek-ai/dsh"
fi

head "Profile"

if [ ! -f "$PROFILE/package.json" ]; then
  bad "no profile at $PROFILE" "run ./setup.sh"
else
  ok "profile manifest present" "$PROFILE/package.json"
  # Read it from INSIDE the directory with a relative path. Passing an absolute
  # one breaks under Git Bash, whose /c/Users/... is not a path Node on Windows
  # can open -- and the empty result then reads as "the plugin is not enabled",
  # which is a confident wrong answer about a profile that is perfectly fine.
  BUNDLES="$(cd "$PROFILE" && node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).dsh?.profile?.bundles?.join(' ') ?? ''" 2>/dev/null)"
  case "$BUNDLES" in
    *dsh-agents-swarm*) ok "dsh-agents-swarm is enabled" "bundles: $BUNDLES" ;;
    # The quietest failure in the whole install: pnpm add puts a plugin in
    # node_modules and nothing enables it. No error, no log line, no plugin.
    *) bad "dsh-agents-swarm installed but NOT enabled" "add it to dsh.profile.bundles in $PROFILE/package.json" ;;
  esac

  # Package names, which is how the profile installs them — the directory names
  # differ and looking for those found nothing on a scoped install.
  for plugin in @ai4gensteam/dsh-agents-swarm @ai4gensteam/dsh-web-search dsh-agent-presets; do
    link="$PROFILE/node_modules/$plugin"
    [ -e "$link" ] || { warn "$plugin not installed" "optional unless you use it"; continue; }
    if [ -L "$link" ]; then
      ok "$plugin is a real link" "-> $(readlink "$link")"
    elif [ -d "$link" ] && [ "$(uname -s)" != "Darwin" ] && [ "$(uname -s)" != "Linux" ]; then
      # Windows junctions are directories to `test -L`, so this is not
      # conclusive there; a stale COPY looks identical and is the actual hazard.
      warn "$plugin is a directory (junction or copy?)" "if it runs stale code, it is a copy: rm it and re-run ./setup.sh"
    else
      bad "$plugin is a directory COPY, not a link" "it will run stale code while reporting itself enabled: rm -rf '$link' && ./setup.sh"
    fi
  done
fi

head "Library"

POINTER="$DSH_HOME/swarm-library-location.txt"
VALUE="${DSH_SWARM_LIBRARY:-}"
[ -z "$VALUE" ] && [ -f "$POINTER" ] && VALUE="$(tr -d '\r\n' < "$POINTER")"

case "$VALUE" in
  http://*|https://*)
    ok "this machine PROXIES to $VALUE" "no database, no timers here"
    BASE="${VALUE%/}"
    case "$BASE" in */swarm-api) ;; *) BASE="$BASE/swarm-api" ;; esac
    START=$(date +%s%N 2>/dev/null || echo 0)
    BODY="$(curl -fsS -m 20 "$BASE/stats" 2>/dev/null)"
    if [ -n "$BODY" ]; then
      MS=$(( ($(date +%s%N 2>/dev/null || echo 0) - START) / 1000000 ))
      ROWS="$(printf '%s' "$BODY" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.total' 2>/dev/null || echo '?')"
      ok "remote library answers" "$ROWS rows, ${MS}ms"
    else
      bad "cannot reach the remote library" "check the other machine is up and reachable: curl $BASE/stats"
    fi
    ;;
  "")
    DB="$DSH_HOME/swarm/swarm-sources.sqlite"
    ok "this machine OWNS the library (default location)" "$DB"
    ;;
  *)
    DB="$VALUE"
    ok "this machine OWNS the library" "$DB"
    ;;
esac

if [ -n "${DB:-}" ]; then
  if [ ! -f "$DB" ]; then
    warn "database does not exist yet" "it is created on first start; that is normal for a fresh install"
  else
    # `node -e` receives the path as an argument rather than interpolated, and
    # the caller passes a native path; see the note above about Git Bash.
    RESULT="$(node -e "
      const {DatabaseSync}=require('node:sqlite');
      try {
        const d=new DatabaseSync(process.argv[1],{readOnly:true});
        const i=d.prepare('PRAGMA integrity_check').get().integrity_check;
        const n=d.prepare('SELECT COUNT(*) n FROM resources').get().n;
        console.log(i+'|'+n); d.close();
      } catch (e) { console.log('ERROR|'+e.message); }
    " "$DB" 2>/dev/null | tail -1)"
    case "$RESULT" in
      ok\|*) ok "database opens and is intact" "${RESULT#ok|} rows" ;;
      *)     bad "database problem" "${RESULT#*|}" ;;
    esac
    MEDIA="$(dirname "$DB")"
    [ -d "$MEDIA/thumbnails" ] && ok "thumbnails present" "$(ls "$MEDIA/thumbnails" 2>/dev/null | wc -l | tr -d ' ') files" || warn "no thumbnails directory yet" "created on demand"
    [ -d "$MEDIA/episodes" ]   && ok "episodes present" "$(ls "$MEDIA"/episodes/*.mp3 2>/dev/null | wc -l | tr -d ' ') files" || warn "no episodes directory yet" "created on first publish"
  fi
fi

head "Capabilities"

SWARM="$REPO/dsh-agents-swarm"
if [ -d "$SWARM/node_modules" ]; then
  MISSING=""
  for dep in jsdom @mozilla/readability turndown msedge-tts; do
    [ -d "$SWARM/node_modules/$dep" ] || MISSING="$MISSING $dep"
  done
  [ -z "$MISSING" ] && ok "plugin dependencies installed" || bad "missing dependencies:$MISSING" "cd $SWARM && pnpm install"
else
  bad "plugin dependencies not installed" "cd $SWARM && pnpm install"
fi

# Presence in node_modules proves nothing about whether speech works: the
# network path needs a token the endpoint issues, the WebSocket has its own
# handshake, and any of it can fail while the package sits there looking
# installed. So this synthesises a real utterance.
if [ -d "$SWARM/node_modules/msedge-tts" ]; then
  SPOKE="$(cd "$SWARM" && node -e "
    import('./lib/tts.js')
      .then((m) => m.synthesize('检查语音合成。', m.DEFAULT_HOSTS.a))
      .then((b) => console.log('BYTES:' + b.length))
      .catch((e) => console.log('ERR:' + String(e && e.message || e)));
  " 2>/dev/null | tail -1)"
  case "$SPOKE" in
    BYTES:*) [ "${SPOKE#BYTES:}" -gt 1000 ] && ok "speech synthesis works" "${SPOKE#BYTES:} bytes, no key needed" || bad "speech returned almost nothing" "${SPOKE}" ;;
    *)       bad "speech synthesis failed" "${SPOKE#ERR:} — check pnpm-workspace.yaml approves the msedge-tts build" ;;
  esac
fi

if [ -f "$SWARM/tests/library.test.mjs" ]; then
  # Extracted without anchoring on the leading glyph. `node --test` prefixes its
  # summary with U+2139, and `^.` matches one BYTE rather than one character in
  # a C locale -- so an anchored pattern silently matches nothing on macOS and
  # reported a passing suite as failing. Found by running this on both machines.
  T="$(cd "$SWARM" && node --test tests/*.test.mjs 2>&1 | grep -aoE '(pass|fail) [0-9]+' | tr '\n' ' ')"
  case "$T" in
    "")         bad "could not read the test result" "run it directly: cd $SWARM && npm test" ;;
    *"fail 0"*) ok "plugin tests pass" "$T" ;;
    *)          bad "plugin tests failing" "$T — run: cd $SWARM && npm test" ;;
  esac
fi

head "Credentials"

# Presence only. The values are never read, printed, or logged here.
if [ -f "$DSH_HOME/.credentials.yaml" ]; then
  N="$(grep -cE '^[[:space:]]+[A-Z_]+:' "$DSH_HOME/.credentials.yaml" 2>/dev/null || echo 0)"
  [ "$N" -gt 0 ] && ok "$N credential(s) configured" || warn "credentials file is empty" "translation and scripts need a model key"
else
  # Only the owner needs these: a proxying machine makes no model calls.
  case "$VALUE" in
    http://*|https://*) ok "no credentials needed here" "the machine that owns the library makes the model calls" ;;
    *) bad "no $DSH_HOME/.credentials.yaml" "the library will serve rows and then fail at the first translation" ;;
  esac
fi

head "Service"

if curl -fsS -m 10 "http://127.0.0.1:$PORT/swarm-api/stats" >/dev/null 2>&1; then
  ok "harness answering on 127.0.0.1:$PORT"
  case "$VALUE" in
    http://*|https://*) ;;
    *)
      INTERVAL="$(curl -fsS -m 10 "http://127.0.0.1:$PORT/swarm-api/collect/status" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.intervalMinutes' 2>/dev/null || echo '?')"
      [ "$INTERVAL" = "0" ] && warn "collection is off" "set an interval in Settings" || ok "collection every ${INTERVAL} minutes"
      AT="$(curl -fsS -m 10 "http://127.0.0.1:$PORT/swarm-api/publish/schedule" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.publishAt || "off"' 2>/dev/null || echo '?')"
      [ "$AT" = "off" ] && warn "no daily episode scheduled" "set a time in the Publish tab" || ok "daily episode at $AT"
      ;;
  esac
else
  warn "harness not running on 127.0.0.1:$PORT" "start it: dsh web --no-open"
fi

printf '\n\033[1m%d ok, %d warn, %d FAIL\033[0m\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || printf '\033[31mFix the FAIL lines above; each one names what to do.\033[0m\n'
exit $(( FAIL > 0 ? 1 : 0 ))
