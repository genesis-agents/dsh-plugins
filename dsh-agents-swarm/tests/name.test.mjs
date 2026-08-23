/**
 * The package name appears in three places. This keeps them one name.
 *
 * `package.json` is what npm publishes under. `cordis.patch.yml` is the module
 * specifier the Loader imports. `lib/client.js` is the id the browser bundle
 * registers itself as. All three must agree, and none of them is checked by
 * anything else.
 *
 * They did not agree. The package was published under a scope while the patch
 * and the bundle kept the old unscoped name — so it packaged, installed, and
 * imported perfectly, and could not be MOUNTED by anyone who installed it. The
 * harness reported "cannot find package", then, once that was fixed, "loaded
 * without registering". Two separate failures from one disagreement, both of
 * them invisible to any check that did not boot a real harness.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;

test("the loader patch imports the published name", () => {
  const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
  const found = /^\s*name:\s*'([^']+)'/m.exec(patch);
  assert.notEqual(found, null, "cordis.patch.yml has no name:");
  assert.equal(found[1], name, `cordis.patch.yml imports ${found[1]}, package is ${name}`);
});

test("the browser bundle registers under the published name", () => {
  const client = readFileSync(join(root, "lib", "client.js"), "utf8");
  const found = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*"([^"]+)"/.exec(client);
  assert.notEqual(found, null, "lib/client.js has no __ModuleLoader__.load id");
  assert.equal(found[1], name, `client.js registers as ${found[1]}, package is ${name}`);
});
