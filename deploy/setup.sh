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
# Under Git Bash, `pwd` gives /d/engineering/... which pnpm on Windows cannot
# resolve -- the manifest is written, pnpm reports success, and the link is
# simply absent. cygpath turns it into a path the platform's own tools accept.
if command -v cygpath >/dev/null 2>&1; then REPO="$(cygpath -m "$REPO")"; fi
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"

# The bundle order is not cosmetic: patches apply in list order, so a bundle
# placed before the one it customizes is overwritten by it. Kept here, in git,
# so it is one decision rather than one per machine.
#
# Directory and package name are read separately because they differ. The
# profile links a DIRECTORY, but every other reference — the dependency key,
# the bundle list, the `name` in each plugin's cordis.patch.yml — is the
# PACKAGE name, which is what the Loader resolves. Linking under the directory
# name produced a profile that worked here and could never work from npm.
PLUGINS=(dsh-agents-swarm dsh-web-search-serper dsh-agent-presets)

# The package name a directory publishes under.
#
# Read from INSIDE the directory. Passing an absolute path breaks under Git
# Bash, whose /d/engineering/... is not a path Node on Windows can open -- the
# same trap that once made doctor.sh report a perfectly good profile as broken.
package_name() {
  ( cd "$REPO/$1" && node -p "require('./package.json').name" )
}

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
NAMES=()
for plugin in "${PLUGINS[@]}"; do NAMES+=("$(package_name "$plugin")"); done

# Merged into what is already there, not regenerated over it. This repo is not
# the only source of plugins on every machine: the always-on box carries two
# that live elsewhere, and a setup script that rebuilt the manifest from its
# own list deleted them without saying so. Anything this repo does not own is
# copied through untouched.
#
# Written by node rather than printf. The manifest has a foreign half now, and
# hand-emitting JSON around values somebody else wrote is how a stray quote
# turns a profile into a parse error on a machine nobody is watching.
DSH_REPO="$REPO" DSH_MANIFEST="$PROFILE/package.json" \
DSH_DIRS="${PLUGINS[*]}" DSH_NAMES="${NAMES[*]}" node --input-type=module -e '
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const repo = process.env.DSH_REPO;
const file = process.env.DSH_MANIFEST;
const dirs = process.env.DSH_DIRS.split(" ");
const names = process.env.DSH_NAMES.split(" ");
const BASE = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

let m = {};
if (existsSync(file)) {
  // A manifest we cannot parse is not a reason to stop: it is exactly the
  // state somebody runs this script to get out of.
  try { m = JSON.parse(readFileSync(file, "utf8")); } catch { m = {}; }
}
m.name = "dsh-profile-web";
m.private = true;
m.dependencies ??= {};
m.dsh ??= {};
m.dsh.profile ??= {};
m.dsh.profile.bundles ??= [];

// Ours under either name: the names we install under today, plus any key
// already pointing at one of our directories. That second half is what
// carries a rename onto a machine that still has the old name -- after a
// rename the path is the only thing the two versions still share.
const ours = new Set(names);
for (const [key, value] of Object.entries(m.dependencies)) {
  if (typeof value === "string" && dirs.some((d) => value.endsWith("/" + d))) ours.add(key);
}

const deps = {};
for (const [k, v] of Object.entries(m.dependencies)) if (!ours.has(k)) deps[k] = v;
names.forEach((n, i) => { deps[n] = "link:" + repo + "/" + dirs[i]; });
m.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));

// Bundle order is load order, and a patch only sees what was applied before
// it, so foreign bundles keep the position they were given. Ours go last, in
// the order this repo declares them.
const kept = m.dsh.profile.bundles.filter((b) => !ours.has(b) && !BASE.includes(b));
m.dsh.profile.bundles = [...BASE, ...kept, ...names];

writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
if (kept.length) process.stdout.write("  kept " + kept.length + " plugin(s) this repo does not own\n");
'
say "wrote profile manifest"

# pnpm builds the links from the `link:` values. Do NOT hand-link with `ln -sfn`
# — that leaves node_modules/.pnpm disagreeing with what is on disk.
( cd "$PROFILE" && pnpm install --silent )

# A real symlink, not a directory copy. Under Git Bash on Windows `ln -s`
# silently copies, and the result is a plugin frozen at the moment it was
# created: it loads, reports itself enabled, and runs stale code. Checked here
# rather than discovered an hour later.
for name in "${NAMES[@]}"; do
  link="$PROFILE/node_modules/$name"
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
