#!/usr/bin/env bash
#
# Boot a real harness on nothing but the published packages.
#
# This exists because everything short of it passed while the package was
# unusable. `npm pack` was clean, the install was clean, importing the package
# worked, and its own tests passed inside the installed copy — all of which
# reach for the package directly. None of them asks a harness to MOUNT it,
# which is the only thing a consumer will ever do.
#
# Two failures hid behind that gap at once. The Loader imports the `name` in
# `cordis.patch.yml`, so a stale one fails at boot with "cannot find package".
# The browser half registers through `__ModuleLoader__.load({ id })`, and a
# stale id there fetches 200, runs, registers nothing, and the sidebar entry
# simply never appears — no error anywhere.
#
# So: a throwaway DSH_HOME, a profile whose only dependencies come from the
# registry, a real boot, and a check that the routes AND the browser bundle
# came up.
#
#   ./release-check.sh 0.3.1 0.3.2
set -uo pipefail

SWARM_VERSION="${1:-latest}"
SEARCH_VERSION="${2:-latest}"
PORT="${PORT:-3091}"
HARNESS="${HARNESS:-D:/engineering/deepseek-harness}"
WORK="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/release-check.$$")"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }

cleanup() {
  [ -n "${HARNESS_PID:-}" ] && kill "$HARNESS_PID" 2>/dev/null
  # The directory holds a throwaway library and profile; nothing here is worth
  # keeping and leaving it behind would accumulate a copy per run.
  rm -rf "$WORK" 2>/dev/null
}
trap cleanup EXIT

export DSH_HOME="$WORK/home"
mkdir -p "$DSH_HOME/profiles/web"

cat > "$DSH_HOME/profiles/web/package.json" <<JSON
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@ai4gensteam/dsh-agents-swarm": "$SWARM_VERSION",
    "@ai4gensteam/dsh-web-search": "$SEARCH_VERSION"
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
JSON

echo "installing from the registry into $DSH_HOME"
# --prefer-online, because npm resolves against a cached packument and a
# version published minutes ago is not in it yet: the version endpoint
# answers 200 while `npm install` reports "no matching version found". A
# release check that fails on its own cache checks nothing.
( cd "$DSH_HOME/profiles/web" && npm install --silent --prefer-online ) >/dev/null 2>&1 \
  && ok "installed" || { bad "npm install failed"; exit 1; }

for pkg in dsh-agents-swarm dsh-web-search; do
  DIR="$DSH_HOME/profiles/web/node_modules/@ai4gensteam/$pkg"
  [ -d "$DIR" ] || { bad "$pkg missing after install"; continue; }
  # The channel is read from the installed copy: a release must not report
  # itself as a checkout, which would mean it shipped with a .git above it.
  CH="$( cd "$DIR" && node --input-type=module -e \
         "const m = await import('./lib/version.js'); process.stdout.write(m.PLUGIN_CHANNEL)" 2>/dev/null )"
  [ "$CH" = "release" ] && ok "$pkg reports channel=release" || bad "$pkg reports channel=$CH"
done

echo "booting a harness on port $PORT"
( cd "$HARNESS" && DSH_HOME="$DSH_HOME" node --import tsx/esm apps/cli/src/bin.ts web --no-open --port "$PORT" ) \
  > "$WORK/boot.log" 2>&1 &
HARNESS_PID=$!

for _ in $(seq 1 60); do
  curl -fsS -m 2 "http://127.0.0.1:$PORT/swarm-api/stats" >/dev/null 2>&1 && break
  sleep 1
done

if curl -fsS -m 5 "http://127.0.0.1:$PORT/swarm-api/stats" >/dev/null 2>&1; then
  ok "harness booted and the library answers"
else
  # The boot log is the only place the loader's own error appears.
  bad "harness did not come up" "$(grep -oE 'failed to (import|apply) loader entry[^\"]*' "$WORK/boot.log" | head -1)"
  exit 1
fi

curl -fsS -m 5 "http://127.0.0.1:$PORT/web-search-api/version" >/dev/null 2>&1 \
  && ok "search plugin mounted" || bad "search plugin did not mount"

# The browser half. A bundle that 404s and a bundle that loads without
# registering are different failures and both leave the page working, so the
# status alone is not enough — but it is the half that can be checked without
# a browser, and the sysverify script covers the other half.
for pkg in dsh-agents-swarm dsh-web-search; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/plugins/@ai4gensteam/$pkg/client.js")"
  [ "$CODE" = "200" ] && ok "$pkg client bundle served" || bad "$pkg client bundle: HTTP $CODE"
done

# Registration is what actually failed last time, and it is visible from the
# bundle's own text: the id it hands the loader must equal the package name.
for pkg in dsh-agents-swarm dsh-web-search; do
  ID="$(curl -fsS -m 5 "http://127.0.0.1:$PORT/plugins/@ai4gensteam/$pkg/client.js" 2>/dev/null \
        | grep -oE 'id: *"[^"]+"' | head -1 | sed 's/.*"\(.*\)"/\1/')"
  [ "$ID" = "@ai4gensteam/$pkg" ] && ok "$pkg registers as its own name" || bad "$pkg registers as '$ID'"
done

printf '\n\033[1m%d ok, %d FAIL\033[0m\n' "$PASS" "$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
