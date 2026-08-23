/**
 * What version this is, and whether it is the released one.
 *
 * Two halves of this plugin run in different places — the page is served by
 * the machine you opened, `/swarm-api` may be proxied to another — and they
 * can be different versions. That happened three times in one afternoon of
 * deployments: a route was written, pushed, and apparently absent, because the
 * machine answering it had not pulled.
 *
 * A version number alone does not settle it, because a working checkout and a
 * published release both say `0.1.0` while being different code. The number is
 * bumped at release; everything between two releases shares it. So the channel
 * is reported beside it: a release is what npm installed, a checkout is
 * whatever is currently on disk, and only the second one can be ahead of what
 * the version claims.
 *
 * The version itself is read from the manifest rather than restated. A
 * constant beside a manifest is how a version string starts lying: one gets
 * bumped and the other does not, and the page then reports a number that
 * exists nowhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The package's own directory, with symlinks already resolved by the loader. */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read the manifest's version.
 *
 * A failure here must not take the plugin down. The version is a label, and
 * refusing to start because a label could not be read is a far worse trade
 * than showing "unknown".
 */
function readVersion() {
  try {
    const parsed = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The commit a checkout is sitting on, read without running git.
 *
 * Shelling out would be the obvious way and is the wrong one here: it costs a
 * process at every boot, needs git on PATH, and fails differently on every
 * platform — all to read a file that is forty bytes of plain text. A ref can
 * also be packed rather than loose, which is why both are tried.
 * @param gitDir - the repository's `.git` directory.
 * @returns the short hash, or undefined.
 */
function readCommit(gitDir) {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    // Detached HEAD holds the hash directly.
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);

    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (ref === undefined) return undefined;

    const loose = join(gitDir, ...ref.split("/"));
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim().slice(0, 7);

    // Packed: a repository that has been gc'd keeps its refs in one file.
    const packed = join(gitDir, "packed-refs");
    if (!existsSync(packed)) return undefined;
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      const [hash, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{40}$/i.test(hash ?? "")) return hash.slice(0, 7);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which channel this copy came from.
 *
 * `node_modules` in the path is the signal, and it is a reliable one: npm and
 * pnpm both install there and nothing else does, while a checkout resolves to
 * wherever it was cloned. A LINKED plugin is a checkout reached through a
 * symlink, and Node resolves that link before this file ever sees a path —
 * which is the behaviour that makes the check work at all, so it is asserted
 * rather than assumed by reporting the directory alongside the verdict.
 * @returns `{ channel, commit, dir }`.
 */
function readChannel() {
  const inNodeModules = PACKAGE_DIR.includes(`${sep}node_modules${sep}`)
    || PACKAGE_DIR.endsWith(`${sep}node_modules`);
  if (inNodeModules) return { channel: "release", commit: undefined };

  // Walk up for a repository. Stopping at the filesystem root rather than a
  // fixed depth: a checkout can sit at any depth inside its repository.
  let dir = PACKAGE_DIR;
  for (let step = 0; step < 8; step++) {
    const gitDir = join(dir, ".git");
    if (existsSync(gitDir)) return { channel: "checkout", commit: readCommit(gitDir) };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Neither installed nor under version control: a copied directory, or a
  // tarball unpacked by hand. Saying so beats claiming either.
  return { channel: "unmanaged", commit: undefined };
}

const channel = readChannel();

/** This package's version, from its manifest. */
export const PLUGIN_VERSION = readVersion();

/** `release` (installed), `checkout` (working tree), or `unmanaged`. */
export const PLUGIN_CHANNEL = channel.channel;

/** The commit a checkout sits on; undefined for a release. */
export const PLUGIN_COMMIT = channel.commit;

/** Where this copy actually lives, so the channel verdict can be checked. */
export const PLUGIN_DIR = PACKAGE_DIR;

/**
 * The version as a person would say it.
 * @returns e.g. `0.1.0` for a release, `0.1.0+f973d0c` for a checkout.
 */
export function versionLabel() {
  if (PLUGIN_CHANNEL === "release") return PLUGIN_VERSION;
  return PLUGIN_COMMIT === undefined ? `${PLUGIN_VERSION}+dev` : `${PLUGIN_VERSION}+${PLUGIN_COMMIT}`;
}
