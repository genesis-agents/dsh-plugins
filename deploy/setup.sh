#!/usr/bin/env bash
#
# Configure this machine's harness profile from what is in this repo.
#
# Idempotent, and safe to re-run after a `git pull` — that is the point. Every
# machine-independent choice (which plugins, in which order) lives in git; what
# is left is two per-machine decisions.
#
# The first is WHICH COPY of the plugins to run:
#
#   ./setup.sh                     link this checkout   -> the page says "dev"
#   ./setup.sh --release           install from npm     -> the page says "release"
#
# A machine somebody is developing on wants the checkout, because an edit shows
# up on the next restart. A machine that is only serving wants the published
# package, because that is the artifact everyone else gets, and running
# anything else means the thing you tested is not the thing that is running.
#
# Plugins marked `"private": true` are never published and stay linked in both
# modes; there is nothing on the registry to install.
#
# The second is WHERE THE LIBRARY LIVES:
#
#   ./setup.sh                                   this machine owns it
#   ./setup.sh https://box.tailnet.ts.net        it proxies to the one that does
#   ./setup.sh /srv/data/swarm-sources.sqlite    it owns one at a chosen path
#
# What this deliberately does NOT touch is `~/.dsh/settings.yaml` and
# `~/.dsh/.credentials.yaml`. Those hold API keys. A setup script that wrote
# them would either need secrets in git or would silently overwrite working
# credentials on the next run; both are worse than one manual step.
set -euo pipefail

MODE=""
PROFILE_NAME=web
LIBRARY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release)  MODE=release ;;
    --checkout) MODE=checkout ;;
    --profile)  PROFILE_NAME="${2:?--profile needs a name}"; shift ;;
    -h|--help)  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)         echo "unknown option: $1" >&2; exit 1 ;;
    *)          LIBRARY="$1" ;;
  esac
  shift
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Under Git Bash, `pwd` gives /d/engineering/... which pnpm on Windows cannot
# resolve -- the manifest is written, pnpm reports success, and the link is
# simply absent. cygpath turns it into a path the platform's own tools accept.
if command -v cygpath >/dev/null 2>&1; then REPO="$(cygpath -m "$REPO")"; fi
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/$PROFILE_NAME"

# The mode sticks to the PROFILE, beside the profile it describes. Per machine
# would be wrong as soon as there are two: a workstation wants its `web`
# profile on the published packages and a `dev` profile on the checkout at the
# same time, and one file for both means setting up the second demotes the
# first. The self-update runs this script with no arguments after every pull,
# so a mode that defaulted rather than persisted would demote the release box
# five minutes after somebody set it.
MODE_FILE="$PROFILE/.plugin-source"
LEGACY_MODE_FILE="$DSH_HOME/swarm-plugin-source.txt"
PREVIOUS_MODE=""
# An `if`, not `[ -f ] && VAR=`, which returns non-zero on a machine that has
# never run this and takes the whole script down under `set -e` -- on exactly
# the first run, where there is nothing to diagnose from.
if [ -f "$MODE_FILE" ]; then
  PREVIOUS_MODE="$(tr -d '[:space:]' < "$MODE_FILE")"
elif [ "$PROFILE_NAME" = web ] && [ -f "$LEGACY_MODE_FILE" ]; then
  # Where this used to live, when it was one setting for the machine.
  PREVIOUS_MODE="$(tr -d '[:space:]' < "$LEGACY_MODE_FILE")"
fi
if [ -n "$MODE" ]; then
  mkdir -p "$PROFILE"
  printf '%s\n' "$MODE" > "$MODE_FILE"
else
  MODE="$PREVIOUS_MODE"
  # Carry the old machine-wide answer into its new home, once.
  if [ -n "$MODE" ] && [ ! -f "$MODE_FILE" ]; then
    mkdir -p "$PROFILE"; printf '%s\n' "$MODE" > "$MODE_FILE"
  fi
fi
case "$MODE" in release|checkout) ;; *) MODE=checkout ;; esac

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

# Read from INSIDE the directory. Passing an absolute path breaks under Git
# Bash, whose /d/engineering/... is not a path Node on Windows can open -- the
# same trap that once made doctor.sh report a perfectly good profile as broken.
manifest_field() {
  ( cd "$REPO/$1" && node -p "String(require('./package.json').$2 ?? '')" )
}

say() { printf '  %s\n' "$*"; }

command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
# `node:sqlite` is used unguarded, so this is a hard floor rather than advice.
[ "$NODE_MAJOR" -ge 24 ] || { echo "node 24+ required, found $(node --version)" >&2; exit 1; }

echo "repo:    $REPO"
echo "profile: $PROFILE"
echo "mode:    $MODE"

# ── what each plugin contributes to the manifest ───────────────────────────
# A published plugin in release mode comes from the registry, pinned to the
# version this checkout represents. Caret rather than exact, so a patch release
# lands on the next run without a commit here, and a major never does.
NAMES=(); VALUES=(); LINKED=0; INSTALLED=0
for plugin in "${PLUGINS[@]}"; do
  [ -f "$REPO/$plugin/package.json" ] || continue
  NAMES+=("$(manifest_field "$plugin" name)")
  if [ "$MODE" = release ] && [ "$(manifest_field "$plugin" private)" != "true" ]; then
    VALUES+=("^$(manifest_field "$plugin" version)")
    INSTALLED=$((INSTALLED + 1))
  else
    VALUES+=("link:$REPO/$plugin")
    LINKED=$((LINKED + 1))
    # A linked plugin resolves its own dependencies from its real path, not
    # from the profile, because the profile points at it rather than copying
    # it. An installed one arrives from the registry with its own already.
    ( cd "$REPO/$plugin" && pnpm install --silent )
  fi
done

# ── the profile manifest ───────────────────────────────────────────────────
mkdir -p "$PROFILE"

# Changing mode starts the profile's node_modules over.
#
# pnpm reuses what it finds, and what it finds after a link is a symlink into
# the checkout plus that checkout's own store. Installing over it made pnpm try
# to import the linked package's dependencies as symlinks into the profile,
# which on Windows needs a privilege it does not have -- ERR_PNPM_EPERM, after
# which the profile still pointed at the checkout while the manifest said
# registry. Deleting is cheap and mode changes are rare; leaving the old shape
# behind is how a release box goes on serving a development build.
if [ -n "$PREVIOUS_MODE" ] && [ "$PREVIOUS_MODE" != "$MODE" ] && [ -d "$PROFILE/node_modules" ]; then
  say "mode changed: $PREVIOUS_MODE -> $MODE, rebuilding node_modules from scratch"
  rm -rf "$PROFILE/node_modules" "$PROFILE/pnpm-lock.yaml"
fi

# Merged into what is already there, not regenerated over it. This repo is not
# the only source of plugins on every machine: the always-on box carries two
# that live elsewhere, and a setup script that rebuilt the manifest from its
# own list deleted them without saying so. Anything this repo does not own is
# copied through untouched.
#
# Written by node rather than printf. The manifest has a foreign half now, and
# hand-emitting JSON around values somebody else wrote is how a stray quote
# turns a profile into a parse error on a machine nobody is watching.
DSH_MANIFEST="$PROFILE/package.json" DSH_DIRS="${PLUGINS[*]}" \
DSH_NAMES="${NAMES[*]}" DSH_VALUES="${VALUES[*]}" node --input-type=module -e '
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const file = process.env.DSH_MANIFEST;
const dirs = process.env.DSH_DIRS.split(" ");
const names = process.env.DSH_NAMES.split(" ");
const values = process.env.DSH_VALUES.split(" ");
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
names.forEach((n, i) => { deps[n] = values[i]; });
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

# pnpm builds both kinds of dependency from the manifest. Do NOT hand-link with
# `ln -sfn` — that leaves node_modules/.pnpm disagreeing with what is on disk.
#
# Retried exactly once, and only for one error.
#
# pnpm refuses to run a dependency's lifecycle scripts until somebody decides
# about that dependency, writes `<name>: set this to true or false` into the
# profile's pnpm-workspace.yaml, and exits non-zero — after everything real has
# already succeeded, which under `set -e` killed this script. Somebody has to
# answer, and the answer here is no: this profile mounts plugins, it does not
# build anything, and a lifecycle script is arbitrary code running at install
# time. So the placeholders are answered `false`, out loud, and the install is
# retried once.
#
# Today that is exactly one package, msedge-tts, whose only script is
# `preinstall: npx only-allow pnpm` — a guard that refuses non-pnpm installs
# and produces nothing. Speech still synthesises with it blocked; that was
# checked rather than assumed.
#
# Matching the error rather than ignoring the exit code keeps a genuine install
# failure fatal.
install_profile() {
  local out
  out="$( cd "$PROFILE" && pnpm install 2>&1 )" && return 0
  case "$out" in
    *ERR_PNPM_IGNORED_BUILDS*)
      local ws="$PROFILE/pnpm-workspace.yaml"
      if [ -f "$ws" ] && grep -q 'set this to true or false' "$ws"; then
        say "denied build scripts: $(grep -oE '^  [^:]+: set this to true or false' "$ws" | sed 's/^  //; s/:.*//' | tr '\n' ' ')"
        # Through a temp file rather than `sed -i`: BSD sed, which is what
        # macOS ships, reads the next argument as a backup suffix and fails on
        # the expression instead -- so the in-place form works on the machine
        # it was written on and breaks on the box it was written for. Only the
        # placeholder line pnpm just wrote is touched; anything already
        # answered keeps its answer.
        sed 's/: set this to true or false$/: false/' "$ws" > "$ws.new" && mv "$ws.new" "$ws"
      fi
      ( cd "$PROFILE" && pnpm install --silent ) && return 0
      ;;
  esac
  printf '%s\n' "$out" >&2
  return 1
}
install_profile

# Present, and of the kind this mode asked for. A release box running a
# symlinked checkout reports itself as a development build and serves code
# nobody published; that is the failure this check exists to name.
for i in "${!NAMES[@]}"; do
  path="$PROFILE/node_modules/${NAMES[$i]}"
  [ -e "$path" ] || { echo "missing: $path" >&2; exit 1; }
  case "${VALUES[$i]}" in
    link:*) [ -L "$path" ] || [ -d "$path" ] || { echo "not linked: $path" >&2; exit 1; } ;;
    *)
      # Under Git Bash on Windows `ln -s` silently copies, so "is a directory"
      # cannot tell an install from a link. What the plugin reports can: the
      # channel is inferred from whether the code sits under node_modules.
      CH="$( cd "$path" && node --input-type=module -e \
             'const m = await import("./lib/version.js"); process.stdout.write(m.PLUGIN_CHANNEL)' 2>/dev/null || echo unknown )"
      [ "$CH" = release ] || [ "$CH" = unknown ] \
        || { echo "${NAMES[$i]} came from the registry but reports channel=$CH" >&2; exit 1; }
      # And it has to be the version that was asked for. An install can succeed
      # while resolving something older -- a stale packument lists yesterday's
      # versions, and a lockfile happily pins one -- which leaves a box serving
      # code from before the fix it was updated to get, reporting success.
      GOT="$( cd "$path" && node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0 )"
      node -e '
        const [got, want] = process.argv.slice(1).map((v) => v.split(".").map(Number));
        const cmp = got[0] - want[0] || got[1] - want[1] || got[2] - want[2];
        process.exit(cmp >= 0 ? 0 : 1);
      ' "$GOT" "${VALUES[$i]#^}" \
        || { echo "${NAMES[$i]}: asked for ${VALUES[$i]}, got $GOT" >&2; exit 1; }
      ;;
  esac
done
[ "$INSTALLED" -gt 0 ] && say "installed $INSTALLED plugin(s) from the registry"
[ "$LINKED" -gt 0 ] && say "linked $LINKED plugin(s) from this checkout"

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
if [ "$PROFILE_NAME" = web ]; then
  echo "  dsh web --no-open        # then open http://127.0.0.1:3080"
else
  # `--profile` belongs to `dsh`, not to `dsh web`. The other order is
  # accepted-looking and fails with "unknown option '--profile'".
  echo "  dsh --profile $PROFILE_NAME web --no-open"
fi
case "$LIBRARY" in
  http://*|https://*) ;;
  *) echo "  keys go in $DSH_HOME/settings.yaml and $DSH_HOME/.credentials.yaml" ;;
esac
