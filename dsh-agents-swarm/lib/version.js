/**
 * What version this is, read from the manifest rather than restated.
 *
 * Two halves of this plugin run in different places — the page is served by
 * the machine you opened, `/swarm-api` may be proxied to another — and they
 * can be different versions. That happened three times in one afternoon of
 * deployments: a route was written, pushed, and apparently absent, because the
 * machine answering it had not pulled. Each time cost twenty minutes of
 * looking at the wrong code.
 *
 * So the version is worth showing, and worth being true. Restating it in a
 * constant is how a version string starts lying: `package.json` is bumped at
 * release and the copy is not, and the page then reports a number that exists
 * nowhere.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This package's version.
 *
 * Read once at import. A failure here must not take the plugin down — the
 * version is a label, and refusing to start because a label could not be read
 * would be a far worse trade than showing "unknown".
 */
export const PLUGIN_VERSION = (() => {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
})();
