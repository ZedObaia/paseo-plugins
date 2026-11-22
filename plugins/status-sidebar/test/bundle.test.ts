import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Paseo's bundler copies every export of a namespace import eagerly (for Hermes). On iOS that
// touches React Native getters for native modules the app lacks, and the app crashes at launch.
test("client code never namespace-imports a module the host provides", () => {
  const files = ["index.client.tsx", ...readdirSync("client").map((name) => join("client", name))];
  const offenders = files.filter((file) =>
    /import \* as \w+ from "(react|react-native|zod|@tanstack\/react-query|@getpaseo\/[^"]+)"/.test(
      readFileSync(file, "utf8"),
    ),
  );
  assert.deepEqual(offenders, []);
});
