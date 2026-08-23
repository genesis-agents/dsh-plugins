#!/usr/bin/env bash
#
# Configure this machine's harness profile from what is in this repo.
#
# Idempotent, and safe to re-run after a `git pull` — that is the point. Every
# machine-independent choice (which plugins, in which order) lives in git;
# everything genuinely per-machine reduces to ONE value, the library:
#
#   ./setup.sh                                   this machine owns the library
#   ./setup.sh https://box.tailnet.ts.net        it proxies to the one that does
#   ./setup.sh /srv/data/swarm-sources.sqlite    it owns one at a chosen path
#
# What this deliberately does NOT touch is `~/.dsh/settings.yaml` and
# `~/.dsh/.credentials.yaml`. Those hold API keys. A setup script that wrote
# them would either need secrets in git or would silently overwrite working
# credentials on the next run; both are worse than one manual step.
set -euo pipefail

LIBRARY="${1:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"

# The bundle order is not cosmetic: patches apply in list order, so a bundle
# placed before the one it customizes is overwritten by it. Kept here, in git,
# so it is one decision rather than one per machine.
PLUGINS=(dsh-agents-swarm dsh-web-search-serper dsh-agent-presets)

say() { printf '  %s\n' "$*"; }

command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
# `node:sqlite` is used unguarded, so this is a hard floor rather than advice.
[ "$NODE_MAJOR" -ge 24 ] || { echo "node 24+ required, found $(node --version)" >&2; exit 1; }

echo "repo:    $REPO"
echo "profile: $PROFILE"

# ── plugin dependencies ────────────────────────────────────────────────────
# Each plugin resolves its own dependencies from its real path, not from the
# profile, because the profile links to it rather than copying it.
for plugin in "${PLUGINS[@]}"; do
  if [ -f "$REPO/$plugin/package.json" ]; then
    ( cd "$REPO/$plugin" && pnpm install --silent )
    say "deps: $plugin"
  fi
done

# ── the profile manifest ───────────────────────────────────────────────────
mkdir -p "$PROFILE"
{
  printf '{\n  "name": "dsh-profile-web",\n  "private": true,\n  "dependencies": {\n'
  for i in "${!PLUGINS[@]}"; do
    comma=","; [ "$i" -eq $(( ${#PLUGINS[@]} - 1 )) ] && comma=""
    printf '    "%s": "link:%s/%s"%s\n' "${PLUGINS[$i]}" "$REPO" "${PLUGINS[$i]}" "$comma"
  done
  printf '  },\n  "dsh": {\n    "profile": {\n      "bundles": [\n'
  printf '        "@deepseek-ai/dsh-base",\n        "@deepseek-ai/dsh-web-app",\n'
  for i in "${!PLUGINS[@]}"; do
    comma=","; [ "$i" -eq $(( ${#PLUGINS[@]} - 1 )) ] && comma=""
    printf '        "%s"%s\n' "${PLUGINS[$i]}" "$comma"
  done
  printf '      ]\n    }\n  }\n}\n'
} > "$PROFILE/package.json"
say "wrote profile manifest"

# pnpm builds the links from the `link:` values. Do NOT hand-link with `ln -sfn`
# — that leaves node_modules/.pnpm disagreeing with what is on disk.
( cd "$PROFILE" && pnpm install --silent )

# A real symlink, not a directory copy. Under Git Bash on Windows `ln -s`
# silently copies, and the result is a plugin frozen at the moment it was
# created: it loads, reports itself enabled, and runs stale code. Checked here
# rather than discovered an hour later.
for plugin in "${PLUGINS[@]}"; do
  link="$PROFILE/node_modules/$plugin"
  [ -e "$link" ] || { echo "missing: $link" >&2; exit 1; }
  [ -L "$link" ] || [ -d "$link" ] || { echo "not linked: $link" >&2; exit 1; }
done
say "linked ${#PLUGINS[@]} plugin(s)"

# ── the one per-machine value ──────────────────────────────────────────────
POINTER="$DSH_HOME/swarm-library-location.txt"
if [ -n "$LIBRARY" ]; then
  printf '%s\n' "$LIBRARY" > "$POINTER"
  case "$LIBRARY" in
    http://*|https://*) say "library: proxying $LIBRARY (no database, no timers here)" ;;
    *)                  say "library: this machine owns $LIBRARY" ;;
  esac
elif [ -f "$POINTER" ]; then
  say "library: unchanged ($(cat "$POINTER"))"
else
  say "library: default — this machine owns $DSH_HOME/swarm/swarm-sources.sqlite"
fi

echo
echo "next:"
echo "  dsh web --no-open        # then open http://127.0.0.1:3080"
case "$LIBRARY" in
  http://*|https://*) ;;
  *) echo "  keys go in $DSH_HOME/settings.yaml and $DSH_HOME/.credentials.yaml" ;;
esac
