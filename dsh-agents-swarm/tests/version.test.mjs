/**
 * The version is stated in two places. This is what keeps them equal.
 *
 * The Host half reads `package.json`, which cannot drift. The browser half
 * cannot — it is a plain file served as-is, with no build step and nothing to
 * import a manifest from — so its version is a constant, and a constant beside
 * a manifest is a constant that goes stale at the next release.
 *
 * That would be worse than showing nothing. The number exists so somebody can
 * answer "is the far machine running my code?", and a version string that
 * quietly stopped tracking reality answers it wrongly with full confidence.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_VERSION } from "../lib/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the host half reports the manifest's version", () => {
  assert.equal(PLUGIN_VERSION, manifest.version);
  // "unknown" is the fallback for a manifest that could not be read. It is the
  // right behaviour at runtime — a label must never stop the plugin starting —
  // and a bug here, where the file is plainly present.
  assert.notEqual(PLUGIN_VERSION, "unknown");
});

test("the browser half states the same version", () => {
  const client = readFileSync(join(root, "lib", "client.js"), "utf8");
  const found = /const CLIENT_VERSION = "([^"]+)"/.exec(client);
  assert.notEqual(found, null, "CLIENT_VERSION is missing from lib/client.js");
  assert.equal(
    found[1],
    manifest.version,
    `lib/client.js says ${found[1]} and package.json says ${manifest.version}; bump both`,
  );
});
