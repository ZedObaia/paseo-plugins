import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalAddress } from "./address";
import { containerListeners, parsePorts } from "./docker";
import { autoLinkHost } from "./links";
import { parseLsofCwd, parseLsofListen, parsePsColumns } from "./lsof";
import { assign } from "./match";
import { parseProcNetTcp, parseStatPpid } from "./procfs";
import { displayName, shortCommand, toListeners, type Listener, type ProcessInfo } from "./processes";
import { toPort, type Shared } from "./scan";

test("canonicalAddress spells each address one way", () => {
  assert.equal(canonicalAddress("*"), "0.0.0.0");
  assert.equal(canonicalAddress("[::]"), "::");
  assert.equal(canonicalAddress("0:0:0:0:0:0:0:1"), "::1");
  assert.equal(canonicalAddress("0:0:0:0:0:ffff:7f00:1"), "127.0.0.1");
  assert.equal(canonicalAddress("[::ffff:10.0.0.2]"), "10.0.0.2");
  assert.equal(canonicalAddress("100.111.26.0%tailscale0"), "100.111.26.0");
  assert.equal(canonicalAddress("fd7a:115c:a1e0:0:0:0:e639:1a01"), "fd7a:115c:a1e0::e639:1a01");
});

test("parseProcNetTcp keeps LISTEN sockets and decodes little-endian addresses", () => {
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0",
    "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0",
    "   2: 0100007F:A1B2 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0",
  ].join("\n");
  assert.deepEqual(
    [...parseProcNetTcp(tcp, true)],
    [
      ["111", { address: "127.0.0.1", port: 8080 }],
      ["222", { address: "0.0.0.0", port: 22 }],
    ],
  );
  const tcp6 = [
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000000000000000000001000000:10E1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0",
    "   1: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0",
  ].join("\n");
  assert.deepEqual(
    [...parseProcNetTcp(tcp6, true)],
    [
      ["444", { address: "::1", port: 4321 }],
      ["555", { address: "::", port: 3000 }],
    ],
  );
});

test("parseStatPpid reads past a command name with spaces and parens", () => {
  assert.equal(parseStatPpid("4242 (node (worker) 1) S 4200 4242 4200 0 -1"), 4200);
});

test("parsePorts reads published TCP ports and skips unpublished and UDP ones", () => {
  assert.deepEqual(
    parsePorts(
      "0.0.0.0:5434->5432/tcp, [::]:5434->5432/tcp, :::8080->80/tcp, 127.0.0.1:8000-8001->8000-8001/tcp, 6379/tcp, 0.0.0.0:53->53/udp",
    ),
    [
      { address: "0.0.0.0", port: 5434, containerPort: 5432 },
      { address: "::", port: 5434, containerPort: 5432 },
      { address: "::", port: 8080, containerPort: 80 },
      { address: "127.0.0.1", port: 8000, containerPort: 8000 },
      { address: "127.0.0.1", port: 8001, containerPort: 8001 },
    ],
  );
});

test("containerListeners ties a Compose container to its project directory", () => {
  const [minio] = containerListeners({
    ID: "c0ffee",
    Names: "app-minio-1",
    Image: "minio/minio",
    Ports: "0.0.0.0:9001->9001/tcp, [::]:9001->9001/tcp",
    Service: "minio",
    WorkingDir: "/work/app",
  });
  assert.deepEqual(minio, {
    identity: "app-minio-1",
    instance: "c0ffee",
    port: 9001,
    address: "0.0.0.0",
    containerPort: 9001,
    name: "minio",
    detail: "minio/minio",
    pid: null,
    source: "docker",
    cwd: "/work/app",
    workspaceId: null,
    dirs: [],
  });
});

test("parseLsofListen and parseLsofCwd read lsof's field output", () => {
  const listen =
    "p501\ncnode\nR500\nf23\nn*:5173\nf24\nn[::1]:9229\np777\ncPython\nR1\nf3\nn127.0.0.1:8000\n";
  assert.deepEqual(parseLsofListen(listen).sockets, [
    { address: "0.0.0.0", port: 5173, pid: 501 },
    { address: "::1", port: 9229, pid: 501 },
    { address: "127.0.0.1", port: 8000, pid: 777 },
  ]);
  assert.equal(parseLsofListen(listen).names.get(777), "Python");
  assert.deepEqual([...parseLsofCwd("p501\nfcwd\nn/work/app\n")], [[501, "/work/app"]]);
  assert.deepEqual(
    [...parsePsColumns("  501   500\n  777     1\n")],
    [
      [501, "500"],
      [777, "1"],
    ],
  );
});

test("displayName names an interpreter's script, else the executable", () => {
  assert.equal(displayName("node /tmp/app/node_modules/.bin/vite"), "vite");
  assert.equal(displayName("/usr/bin/node --inspect server.mjs"), "server");
  assert.equal(displayName("python3 -m http.server 8000 --bind 127.0.0.1"), "http.server");
  assert.equal(displayName("python3.12 manage.py runserver"), "manage");
  assert.equal(displayName("deno run --allow-net main.ts"), "main");
  assert.equal(displayName("/usr/local/bin/cloudflared tunnel run"), "cloudflared");
  assert.equal(
    displayName(
      "/usr/bin/node --require /app/node_modules/tsx/dist/preflight.cjs --import file:///app/loader.mjs --conditions=source src/index.ts",
    ),
    "index",
  );
  assert.equal(displayName(`node -e require("http").createServer()`), "node");
  assert.equal(displayName("python3 -c import http.server"), "python3");
  assert.equal(displayName("node"), "node");
  assert.equal(displayName(""), null);
});

test("shortCommand drops the directories of absolute paths", () => {
  assert.equal(
    shortCommand("/usr/bin/node /work/app/node_modules/.bin/vite --port 5173"),
    "node vite --port 5173",
  );
});

test("toListeners skips Paseo's own processes and follows ones Paseo started", () => {
  const DAEMON = 100;
  const proc = (ppid: number, cwd: string, more: Partial<ProcessInfo> = {}): ProcessInfo => ({
    ppid,
    name: "node",
    command: "node",
    cwd,
    workspaceId: null,
    envDirs: [],
    ...more,
  });
  const procs: Record<number, ProcessInfo> = {
    110: proc(DAEMON, "/work/a"), // an agent
    120: proc(110, "/work/a"), // its shell
    130: proc(120, "/tmp", { workspaceId: "wks_a", envDirs: ["/work/a"] }),
    300: proc(1, "/work/b"), // a shell Paseo didn't start
    200: proc(300, "/home/me", { envDirs: ["/work/x"] }),
  };
  const listeners = toListeners(
    [
      { address: "127.0.0.1", port: 6767, pid: DAEMON },
      { address: "127.0.0.1", port: 9999, pid: 110 },
      { address: "127.0.0.1", port: 8000, pid: 130 },
      { address: "0.0.0.0", port: 8000, pid: 130 },
      { address: "127.0.0.1", port: 5037, pid: 200 },
      { address: "0.0.0.0", port: 5432, pid: null },
    ],
    (pid) => procs[pid] ?? null,
    DAEMON,
    999,
  );
  assert.deepEqual(
    listeners.map((l) => [l.port, l.address, l.cwd, l.workspaceId, l.dirs]),
    [
      [8000, "0.0.0.0", "/tmp", "wks_a", ["/work/a"]],
      // where its parent ran only counts for processes Paseo started
      [5037, "127.0.0.1", "/home/me", null, ["/work/x"]],
    ],
  );
});

const listener = (
  port: number,
  where: Partial<Pick<Listener, "cwd" | "workspaceId" | "dirs">>,
  address = "0.0.0.0",
): Listener => ({
  port,
  address,
  name: "node",
  detail: "node",
  pid: 1,
  source: "process",
  cwd: null,
  workspaceId: null,
  dirs: [],
  ...where,
});

test("assign gives a port to where it runs, then the workspace that started it, then its other directories", () => {
  const workspaces = [
    { id: "home", dirs: ["/home/me"] },
    { id: "app", dirs: ["/home/me/app"] },
    { id: "app-too", dirs: ["/home/me/app/"] },
    { id: "tree", dirs: ["/wt/fox", "/private/wt/fox"] },
  ];
  const result = assign(
    [
      listener(5173, { cwd: "/home/me/app/web" }),
      listener(3000, { cwd: "/home/me/other" }),
      listener(4000, { cwd: "/private/wt/fox/api" }),
      listener(5000, { cwd: "/", dirs: ["/home/me/appendix", "/wt/fox"] }),
      listener(6000, { cwd: "/elsewhere" }),
      listener(5173, { cwd: "/home/me/app" }, "127.0.0.1"),
      listener(7000, { cwd: "/tmp", workspaceId: "tree", dirs: ["/home/me"] }),
      listener(7100, { cwd: "/home/me/app", workspaceId: "tree" }),
      listener(7200, { cwd: "/tmp", workspaceId: "archived", dirs: ["/home/me/other"] }),
    ],
    workspaces,
  );
  assert.deepEqual(
    Object.fromEntries([...result].map(([id, ports]) => [id, ports.map((p) => `${p.address}:${p.port}`)])),
    {
      app: ["0.0.0.0:5173", "0.0.0.0:7100"],
      "app-too": ["0.0.0.0:5173", "0.0.0.0:7100"],
      home: ["0.0.0.0:3000", "0.0.0.0:5000", "0.0.0.0:7200"],
      tree: ["0.0.0.0:4000", "0.0.0.0:7000"],
    },
  );
});

test("autoLinkHost follows where the daemon listens", () => {
  const addresses = ["192.168.1.20", "100.101.102.103"];
  assert.equal(autoLinkHost("127.0.0.1:6767", addresses), "localhost");
  assert.equal(autoLinkHost("/run/paseo.sock", addresses), "localhost");
  assert.equal(autoLinkHost("100.111.26.0:6767", addresses), "100.111.26.0");
  assert.equal(autoLinkHost("0.0.0.0:6767", addresses), "100.101.102.103");
  assert.equal(autoLinkHost("[::]:6767", ["192.168.1.20"]), "192.168.1.20");
});

test("toPort links each bind where the app can reach it", () => {
  const none: Shared = { forwardedAt: null, privateUrl: null, public: null };
  const at = (address: string, host: string, shared: Partial<Shared> = {}) => {
    const p = toPort(listener(5173, {}, address), host, { ...none, ...shared }, null);
    return [p.url, p.needsLink, p.private];
  };
  assert.deepEqual(at("127.0.0.1", "localhost"), ["http://localhost:5173", false, null]);
  assert.deepEqual(at("::", "localhost"), ["http://localhost:5173", false, null]);
  assert.deepEqual(at("0.0.0.0", "100.1.2.3"), ["http://100.1.2.3:5173", false, null]);
  assert.deepEqual(at("192.168.1.20", "100.1.2.3"), ["http://192.168.1.20:5173", false, null]);
  assert.deepEqual(at("::1", "100.1.2.3"), ["http://100.1.2.3:5173", true, null]);
  assert.deepEqual(at("127.0.0.1", "box.tailnet.ts.net", { forwardedAt: 41000 }), [
    "http://box.tailnet.ts.net:41000",
    false,
    { https: false },
  ]);
  assert.deepEqual(at("::", "fd7a::1"), ["http://[fd7a::1]:5173", false, null]);
  // with Tailscale HTTPS every port gets its tailnet link when it's first opened
  const tailnet = toPort(listener(5173, {}, "0.0.0.0"), "100.1.2.3", none, null, true);
  assert.deepEqual([tailnet.url, tailnet.needsLink], ["http://100.1.2.3:5173", true]);
  assert.deepEqual(at("::1", "100.1.2.3", { privateUrl: "https://box.tailnet.ts.net:5173" }), [
    "https://box.tailnet.ts.net:5173",
    false,
    { https: true },
  ]);
});

test("toPort gives a port that doesn't get links none, only where it can be reached", () => {
  const none: Shared = { forwardedAt: null, privateUrl: null, public: null };
  const db = (address: string, host: string) => {
    const p = toPort(listener(5432, {}, address), host, none, null, true, {
      detection: { protocol: "other", page: false },
      links: false,
      allowable: false,
      allowed: false,
    });
    return [p.links, p.protocol, p.needsLink, p.reach];
  };
  assert.deepEqual(db("0.0.0.0", "100.1.2.3"), [false, "other", false, "100.1.2.3:5432"]);
  assert.deepEqual(db("127.0.0.1", "100.1.2.3"), [false, "other", false, null]);
  assert.deepEqual(db("127.0.0.1", "localhost"), [false, "other", false, "localhost:5432"]);
});
