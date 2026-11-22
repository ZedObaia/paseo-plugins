import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
assert.ok(
  !existsSync(path.join(path.dirname(require.resolve("db-studio/package.json")), "dist/web-dist")),
  "Remove the unused upstream frontend: npm run prepare:studio",
);

const catalog = JSON.parse(
  gunzipSync(await readFile(new URL("../assets/frontend-licenses.json.gz", import.meta.url))).toString(),
);
const versions = {};
for (const entry of catalog.entries) {
  if (entry.kind === "vendored") continue;
  const list = (versions[entry.name] ??= []);
  if (!list.includes(entry.version)) list.push(entry.version);
}
const response = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(versions),
});
assert.ok(response.ok, `Frontend advisory lookup failed: HTTP ${response.status}`);
const advisories = await response.json();
for (const [name, findings] of Object.entries(advisories))
  for (const finding of findings)
    console.error(`${name}: ${finding.severity} — ${finding.title} (${finding.url})`);
assert.equal(Object.keys(advisories).length, 0, "Bundled frontend has dependency advisories");
console.log(`No advisories for ${Object.keys(versions).length} bundled frontend packages`);
