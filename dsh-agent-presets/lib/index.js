/**
 * Preset-sync plugin, Host half.
 *
 * `dsh-agent-presets` only scans real directories: `discovery.ts` filters with
 * `Dirent.isDirectory()`, which is false for a Windows junction or a POSIX
 * symlink, so a link from the writable root back to a checkout is skipped
 * silently. Configuring an extra root does not help either — `apps/cli`
 * overwrites `roots` with its own shipped root while composing the profile.
 * Copying is therefore the supported way to publish presets kept under version
 * control, and it is what the third-party `dsh-liangshen` plugin does.
 *
 * Only ids this package owns are written; anything else already in the
 * writable root is left untouched.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Composition file that marks a directory as a preset. */
const COMPOSITION_FILE = 'agent.cordis.yml'

/** Directories that can never be a preset id. */
const SKIP = new Set(['lib', 'node_modules', '.git', '.github'])

/** A leading `~` followed by either path separator. */
const HOME_PREFIX = /^~[/\\]/

/** Expand a leading `~` in a path, platform-style. */
function expandHome(path, home = homedir()) {
  if (path === '~') return home
  if (HOME_PREFIX.test(path)) return join(home, path.slice(2))
  return path
}

/**
 * Resolve the DSH home directory: the environment override wins, the platform
 * home fallback follows.
 * @param env - process environment to read `DSH_HOME` from.
 * @param home - platform home directory fallback (test seam).
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/**
 * List the preset ids this package ships.
 * @param root - package root to scan.
 * @returns directory names that carry a composition file.
 */
export function bundledPresetIds(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((child) => child.isDirectory() && !SKIP.has(child.name))
    .map((child) => child.name)
    .filter((id) => existsSync(join(root, id, COMPOSITION_FILE)))
}

/**
 * Copy every bundled preset into the writable preset root.
 * @returns the ids that were published.
 */
export function syncPresets() {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const target = join(resolveDshHome(), '.agent-presets')
  const ids = bundledPresetIds(packageRoot)
  for (const id of ids) {
    cpSync(join(packageRoot, id), join(target, id), { recursive: true, force: true })
  }
  return ids
}

/** Host plugin body — publish the bundled presets, then contribute nothing. */
export function apply() {
  syncPresets()
}
