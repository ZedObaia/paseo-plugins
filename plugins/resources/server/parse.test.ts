import assert from "node:assert/strict";
import { test } from "node:test";
import { labels, parseSize } from "./exec";
import { readOnlyMount } from "./system";

test("docker sizes, SI and binary units", () => {
  assert.equal(parseSize("1.2GB"), 1_200_000_000);
  assert.equal(parseSize("23.4MiB"), Math.round(23.4 * 1024 ** 2));
  assert.equal(parseSize("0B"), 0);
  assert.equal(parseSize("6.3GB (32%)"), 6_300_000_000);
  assert.equal(parseSize(undefined), 0);
});

test("docker labels", () => {
  assert.deepEqual(labels("com.docker.compose.project=chapbook,a=b=c"), {
    "com.docker.compose.project": "chapbook",
    a: "b=c",
  });
  assert.deepEqual(labels(""), {});
});

test("read-only mounts on macOS and Linux, not errors=remount-ro", () => {
  assert.equal(readOnlyMount("/dev/disk9s1 on /Volumes/Paseo 0.11.4-arm64 (hfs, local, read-only, quarantine)"), "/Volumes/Paseo 0.11.4-arm64");
  assert.equal(readOnlyMount("/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)"), null);
  assert.equal(readOnlyMount("/dev/sda1 on / type ext4 (rw,relatime,errors=remount-ro)"), null);
  assert.equal(readOnlyMount("/dev/loop3 on /snap/core type squashfs (ro,nodev)"), "/snap/core");
});

test("process names: scripts and main classes instead of interpreters", () => {
  const { processName } = require("./system") as typeof import("./system");
  assert.equal(processName("/opt/homebrew/bin/node", "node /x/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot"), "tsserver");
  assert.equal(processName("node", "node /Users/z/.npm/_npx/98/node_modules/.bin/playwright-mcp"), "playwright-mcp");
  assert.equal(processName("/usr/bin/java", "java -Xmx2g -cp /a/b.jar:/c.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10"), "GradleDaemon");
  assert.equal(processName("java", "java -jar /opt/tools/thing.jar serve"), "thing.jar");
  assert.equal(processName("java", "java --add-opens java.base/java.lang=ALL-UNNAMED -cp k.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon --x"), "KotlinCompileDaemon");
  assert.equal(processName("/Users/z/.local/share/claude/versions/2.1.294", "2.1.294 --resume x"), "claude");
  assert.equal(processName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ""), "Google Chrome");
  assert.equal(processName("node", "node"), "node");
});

test("app groups fold helper processes into their app", () => {
  const { appName } = require("./system") as typeof import("./system");
  assert.equal(appName("Google Chrome Helper (Renderer)"), "Google Chrome");
  assert.equal(appName("Paseo Helper"), "Paseo");
  assert.equal(appName("Codex (Renderer)"), "Codex");
  assert.equal(appName("tsserver"), "tsserver");
});
