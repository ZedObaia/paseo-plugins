import assert from "node:assert/strict";
import { test } from "node:test";
import { reclaimed } from "./docker";
import { parseSize } from "./exec";
import {
  appName,
  parseDf,
  parseLinuxTop,
  parseMacTop,
  parseProcStat,
  parsePs,
  processName,
  readOnlyMount,
} from "./system";

test("docker sizes, SI and binary units", () => {
  assert.equal(parseSize("1.2GB"), 1_200_000_000);
  assert.equal(parseSize("23.4MiB"), Math.round(23.4 * 1024 ** 2));
  assert.equal(parseSize("0B"), 0);
  assert.equal(parseSize("6.3GB (32%)"), 6_300_000_000);
  assert.equal(parseSize(undefined), 0);
});

test("reclaimed space from docker and from buildx", () => {
  assert.equal(reclaimed("Deleted Images:\n...\nTotal reclaimed space: 1.2GB\n"), "1.2GB");
  assert.equal(reclaimed("ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t12MB\nTotal:\t6.3GB\n"), "6.3GB");
  assert.equal(reclaimed(""), "0B");
});

test("read-only mounts on macOS and Linux, not errors=remount-ro", () => {
  assert.equal(
    readOnlyMount("/dev/disk9s1 on /Volumes/Paseo 0.11.4-arm64 (hfs, local, read-only, quarantine)"),
    "/Volumes/Paseo 0.11.4-arm64",
  );
  assert.equal(readOnlyMount("/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)"), null);
  assert.equal(readOnlyMount("/dev/sda1 on / type ext4 (rw,relatime,errors=remount-ro)"), null);
  assert.equal(readOnlyMount("/dev/loop3 on /snap/core type squashfs (ro,nodev)"), "/snap/core");
});

test("df: free space is Available, macOS shows the Data volume as /", () => {
  const mac = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1s1 971350180 11950000 117000000 10% /
/dev/disk3s5 971350180 840000000 117000000 88% /System/Volumes/Data
/dev/disk9s1 500000 480000 20000 96% /Volumes/Paseo 0.11.4-arm64
/dev/disk5s1 2000000 1000000 1000000 50% /Volumes/Backup Disk`;
  assert.deepEqual(parseDf(mac, new Set(["/", "/Volumes/Paseo 0.11.4-arm64"]), "darwin"), [
    { mount: "/", totalBytes: 971350180 * 1024, usedBytes: 840000000 * 1024, freeBytes: 117000000 * 1024 },
    {
      mount: "/Volumes/Backup Disk",
      totalBytes: 2000000 * 1024,
      usedBytes: 1000000 * 1024,
      freeBytes: 1000000 * 1024,
    },
  ]);
  const linux = `Filesystem 1024-blocks Used Available Capacity Mounted on
rpool/ROOT/ubuntu 100000 40000 60000 40% /
tmpfs 8000 0 8000 0% /run
/dev/sda16 900000 100000 800000 12% /boot
/dev/sdb1 200000 50000 140000 27% /data`;
  assert.deepEqual(
    parseDf(linux, new Set(), "linux").map((d) => d.mount),
    ["/", "/data"],
  );
});

test("ps rows, including commands with spaces", () => {
  const rows = parsePs(
    "  412     1  12.5  20480 zeyad    /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n   88     1   0.0    512 root     launchd\n",
  );
  assert.deepEqual(rows[0], {
    pid: 412,
    ppid: 1,
    cpuPct: 12.5,
    rssBytes: 20480 * 1024,
    user: "zeyad",
    command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  assert.equal(rows.length, 2);
});

test("macOS top footprints with suffixes and +/- markers", () => {
  const map = parseMacTop(
    "Processes: 600 total\nPID    MEM  \n28875  5649M+\n0      4605M\n412    823K-\n7      2G\n",
  );
  assert.equal(map.get(28875), 5649 * 1024 ** 2);
  assert.equal(map.get(412), 823 * 1024);
  assert.equal(map.get(7), 2 * 1024 ** 3);
});

test("Linux top: %CPU from the second frame", () => {
  const frame = (cpu: string) => `top - 10:00:00 up 1 day
Tasks: 2 total
    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
   1234 zeyad     20   0  100000  20000   1000 R  ${cpu}   0.1   1:00.00 node server.js
      1 root      20   0   20000   2000   1000 S   0.0   0.0   0:01.00 systemd
`;
  const map = parseLinuxTop(frame("99.0") + frame("12.5"));
  assert.equal(map.get(1234), 12.5);
  assert.equal(map.get(1), 0);
  assert.equal(parseLinuxTop("no frames").size, 0);
});

test("/proc/stat totals include iowait, softirq and steal", () => {
  const times = parseProcStat("cpu  100 10 50 1000 40 5 5 30 0 0\ncpu0 1 2 3 4 5 6 7 8\n");
  assert.deepEqual(times, {
    busy: 100 + 10 + 50 + 5 + 5 + 30,
    total: 100 + 10 + 50 + 5 + 5 + 30 + 1000 + 40,
    steal: 30,
  });
  assert.equal(parseProcStat("intr 1 2 3"), null);
});

test("process names: scripts and main classes instead of interpreters", () => {
  assert.equal(
    processName(
      "/opt/homebrew/bin/node",
      "node /x/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot",
    ),
    "tsserver",
  );
  assert.equal(
    processName("node", "node /Users/z/.npm/_npx/98/node_modules/.bin/playwright-mcp"),
    "playwright-mcp",
  );
  assert.equal(
    processName(
      "/usr/bin/java",
      "java -Xmx2g -cp /a/b.jar:/c.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10",
    ),
    "GradleDaemon",
  );
  assert.equal(processName("java", "java -jar /opt/tools/thing.jar serve"), "thing.jar");
  assert.equal(
    processName(
      "java",
      "java --add-opens java.base/java.lang=ALL-UNNAMED -cp k.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon --x",
    ),
    "KotlinCompileDaemon",
  );
  assert.equal(
    processName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ""),
    "Google Chrome",
  );
  assert.equal(processName("node", "node"), "node");
  assert.equal(processName("(node)", ""), "node");
  assert.equal(
    processName(
      "/Users/z/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless",
      "x -avd Pixel",
    ),
    "Android emulator",
  );
});

test("process names: tools that run under their version number", () => {
  assert.equal(processName("/Users/z/.local/share/claude/versions/2.1.294", "claude --resume x"), "claude");
  assert.equal(
    processName(
      "/Users/z/.local/share/claude/versions/2.1.299",
      "/Users/z/.local/share/claude/versions/2.1.299 --session-id x",
    ),
    "claude",
  );
  assert.equal(processName("2.1.294", "claude --dangerously-skip-permissions"), "claude");
});

test("app groups fold helper processes into their app", () => {
  assert.equal(appName("Google Chrome Helper (Renderer)"), "Google Chrome");
  assert.equal(appName("Paseo Helper"), "Paseo");
  assert.equal(appName("Codex (Renderer)"), "Codex");
  assert.equal(appName("tsserver"), "tsserver");
});
