import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { frontendNotices, inventory, writeFrontendCatalog } from "./licenses.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const revision = "48e80fface43d5b0b8145e5296fab6103ca99cd0"; // db-studio v1.20.0
const temp = await mkdtemp(path.join(tmpdir(), "paseo-dbstudio-build-"));
try {
  const response = await fetch(`https://codeload.github.com/husamql3/db-studio/tar.gz/${revision}`);
  if (!response.ok) throw new Error(`db-studio download failed: ${response.status}`);
  await writeFile(path.join(temp, "source.tar.gz"), Buffer.from(await response.arrayBuffer()));
  execFileSync("tar", ["-xzf", "source.tar.gz"], { cwd: temp });
  const source = path.join(temp, `db-studio-${revision}`);
  execFileSync("git", ["apply", path.join(plugin, "server/studio-dependencies.patch")], { cwd: source });
  execFileSync("git", ["apply", path.join(plugin, "server/studio.patch")], { cwd: source });
  await copyFile(
    path.join(plugin, "server/assistant.tsx.txt"),
    path.join(source, "packages/web/src/components/chat/chat-sidebar.tsx"),
  );
  await copyFile(
    path.join(plugin, "server/studio-vite.config.ts.txt"),
    path.join(source, "packages/web/paseo-vite.config.ts"),
  );
  execFileSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: source,
    stdio: "inherit",
  });
  execFileSync("bun", ["run", "typecheck"], {
    cwd: path.join(source, "packages/web"),
    stdio: "inherit",
  });
  execFileSync("bun", ["run", "build", "--config", "paseo-vite.config.ts"], {
    cwd: path.join(source, "packages/web"),
    stdio: "inherit",
    env: {
      ...process.env,
      SENTRY_AUTH_TOKEN: "",
      VITE_SENTRY_DSN: "",
      VITE_POSTHOG_KEY: "",
      VITE_API_URL: "",
    },
  });
  const licenses = await frontendNotices(source, "frontend");
  licenses.push({
    name: "db-studio",
    version: "1.20.0",
    license: "Apache-2.0",
    scopes: ["frontend"],
    repository: "https://github.com/husamql3/db-studio",
    notices: [
      { file: "LICENSE", text: await readFile(path.join(source, "LICENSE"), "utf8") },
      { file: "AUTHORS", text: await readFile(path.join(source, "AUTHORS"), "utf8") },
    ],
  });
  await writeFrontendCatalog(licenses, revision);
  const files = {};
  const root = path.join(source, "packages/web/dist");
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else
        files[`/${path.relative(root, file).split(path.sep).join("/")}`] = (await readFile(file)).toString(
          "base64",
        );
    }
  }
  await collect(root);
  files["/third-party-licenses.json"] = Buffer.from(JSON.stringify(licenses)).toString("base64");
  await mkdir(path.join(plugin, "assets"), { recursive: true });
  await writeFile(path.join(plugin, "assets/studio.json.gz"), gzipSync(JSON.stringify(files), { level: 9 }));
  await copyFile(path.join(source, "LICENSE"), path.join(plugin, "assets/DB-STUDIO-LICENSE"));
  await copyFile(path.join(source, "AUTHORS"), path.join(plugin, "assets/DB-STUDIO-AUTHORS"));
  await inventory();
  console.log(`Built ${Object.keys(files).length} db-studio assets from ${revision}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
