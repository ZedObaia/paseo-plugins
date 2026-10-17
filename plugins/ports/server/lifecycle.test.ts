import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect, createServer as tcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ListenerAccess, listenerId } from "./identity";
import { Forwards } from "./links";
import { assign } from "./match";
import type { Listener } from "./processes";
import { startProxy } from "./proxy";
import { Records } from "./records";
import { workspaceListener } from "./scan";
import { Shares } from "./shares";

const listener = (port = 3000, extra: Partial<Listener> = {}): Listener => ({
  port,
  address: "127.0.0.1",
  name: "dev",
  detail: "node dev.js",
  identity: "node /work/a/dev.js",
  pid: 101,
  source: "process",
  cwd: "/work/a",
  workspaceId: "a",
  dirs: [],
  ...extra,
});

async function serving(text: string, port = 0): Promise<Server> {
  const server = createServer((_, res) => res.end(text));
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;

test("workspace actions select the exact listener and reject another workspace or a replaced server", () => {
  const a = listener();
  const b = listener(3000, { address: "127.0.0.2", cwd: "/work/b", workspaceId: "b", pid: 102 });
  const assigned = assign(
    [a, b],
    [
      { id: "a", dirs: ["/work/a"] },
      { id: "b", dirs: ["/work/b"] },
    ],
  );
  assert.equal(workspaceListener(assigned, { workspaceId: "b", id: listenerId(b) }), b);
  assert.throws(() => workspaceListener(assigned, { workspaceId: "b", id: listenerId(a) }), /no longer/);
  const replaced = new Map([["a", [listener(3000, { identity: "node /work/a/admin.js" })]]]);
  assert.throws(() => workspaceListener(replaced, { workspaceId: "a", id: listenerId(a) }), /no longer/);
});

test("HTTP and WebSocket traffic cannot inherit a link when another app takes the same port", async () => {
  const original = await serving("original");
  const target = listener(portOf(original));
  let current = [target];
  const access = new ListenerAccess(async () => current, 0);
  const proxy = await startProxy(target, null, access.guard(target));
  let replacement: Server | undefined;
  try {
    assert.equal(await (await fetch(proxy.url)).text(), "original");
    await close(original);
    replacement = await serving("private replacement", target.port);
    current = [listener(target.port, { cwd: "/work/private", identity: "node admin.js", pid: 202 })];
    assert.equal((await fetch(proxy.url)).status, 503);
    const upgrade = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1", () => {
        socket.write(
          "GET / HTTP/1.1\r\nHost: link.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk;
      });
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });
    assert.match(upgrade, /^HTTP\/1\.1 503/);
  } finally {
    proxy.close();
    await close(replacement ?? original);
  }
});

test("one read of the listeners serves a burst of requests", async () => {
  const target = listener();
  let reads = 0;
  const access = new ListenerAccess(async () => (reads++, [target]));
  const allowed = await Promise.all(Array.from({ length: 50 }, () => access.status(target)));
  assert.ok(allowed.every((status) => status === "present"));
  assert.equal(await access.status(target), "present");
  assert.equal(reads, 1);
});

test("the same server can restart, but a changed command cannot reuse its link", async () => {
  const target = listener();
  let current = [target];
  const canConnect = new ListenerAccess(async () => current, 0).guard(target);
  assert.equal(await canConnect(), true);
  current = [];
  assert.equal(await canConnect(), false);
  current = [listener(3000, { pid: 202 })];
  assert.equal(await canConnect(), true);
  current = [listener(3000, { identity: "node /other/dev.js", pid: 303 })];
  assert.equal(await canConnect(), false);
  current = [target];
  assert.equal(await canConnect(), false);
});

test("concurrent forwarding creates one tracked link, and a replacement cannot receive TCP traffic", async () => {
  const original = await serving("original");
  const target = listener(portOf(original));
  let current = [target];
  const forwards = new Forwards(new ListenerAccess(async () => current, 0));
  let replacement: Server | undefined;
  try {
    const ports = await Promise.all([forwards.open(target, "127.0.0.1"), forwards.open(target, "127.0.0.1")]);
    assert.equal(ports[0], ports[1]);
    assert.equal([...forwards.entries()].length, 1);
    assert.equal(await (await fetch(`http://127.0.0.1:${ports[0]}`)).text(), "original");
    await close(original);
    replacement = await serving("private replacement", target.port);
    current = [listener(target.port, { cwd: "/private", identity: "node admin.js" })];
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(ports[0], "127.0.0.1", () =>
        socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"),
      );
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk;
      });
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
    });
    assert.equal(received, "");
  } finally {
    forwards.closeAll();
    await close(replacement ?? original);
  }
});

const TAILSCALE = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.PORTS_TEST_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'status') {
  console.log(JSON.stringify({BackendState:'Running',CertDomains:['review.ts.net'],Self:{DNSName:'review.ts.net.',TailscaleIPs:['127.0.0.1'],CapMap:{funnel:null}}}));
} else if (args[0] === 'debug') {
  console.log(JSON.stringify({OperatorUser:require('node:os').userInfo().username}));
} else if (args[1] === 'status') {
  if (state.failStatus) { console.error('simulated configuration failure'); process.exit(1); }
  console.log(JSON.stringify(state.config));
} else {
  const port = args.find(a => a.startsWith('--https=')).slice(8);
  if (args.at(-1) === 'off') {
    if (state.failStop) { console.error('simulated permission failure'); process.exit(1); }
    delete state.config.TCP[port];
    delete state.config.Web['review.ts.net:' + port];
  } else {
    state.config.TCP[port] = {HTTPS:true};
    state.config.Web['review.ts.net:' + port] = {Handlers:{'/':{Proxy:args.at(-1)}}};
  }
  fs.writeFileSync(file, JSON.stringify(state));
}
`;

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "ports-lifecycle-"));
  const previousPath = process.env.PATH;
  const previousState = process.env.PORTS_TEST_STATE;
  const stateFile = join(dir, "tailscale.json");
  await writeFile(stateFile, JSON.stringify({ config: { TCP: {}, Web: {} }, failStop: false }));
  await writeFile(join(dir, "tailscale"), TAILSCALE, { mode: 0o755 });
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  process.env.PORTS_TEST_STATE = stateFile;
  const dev = await serving("development app");
  const target = listener(portOf(dev));
  const forwards = new Forwards(new ListenerAccess(async () => [target], 0));
  const recordsFile = join(dir, "shares.json");
  const shares = new Shares(forwards, new Records(recordsFile));
  await shares.ready;
  t.after(async () => {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.failStop = false;
    await writeFile(stateFile, JSON.stringify(state));
    await shares.stopAll();
    await close(dev);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.PORTS_TEST_STATE;
    else process.env.PORTS_TEST_STATE = previousState;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, stateFile, recordsFile, shares, target };
}

for (const level of ["private", "public"] as const) {
  test(`failed ${level} cleanup blocks traffic, stays visible, and can be retried`, async (t) => {
    const { stateFile, recordsFile, shares, target } = await fixture(t);
    if (level === "public") await shares.sharePublic(target, "funnel", "open");
    else await shares.sharePrivate(target);
    const record = (await new Records(recordsFile).load())[0];
    assert.equal(await (await fetch(record.target)).text(), "development app");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.failStop = true;
    await writeFile(stateFile, JSON.stringify(state));
    const id = listenerId(target);
    await assert.rejects(shares.unshare(id, level), /Tailscale refused/);
    assert.equal((await fetch(record.target)).status, 503);
    const reuse = tcpServer();
    const unavailable = once(reuse, "error");
    reuse.listen(Number(new URL(record.target).port), "127.0.0.1");
    const [error] = await unavailable;
    assert.equal(error.code, "EADDRINUSE");
    assert.ok(level === "public" ? shares.describe(id).public?.error : shares.describe(id).privateError);
    assert.equal((await new Records(recordsFile).load()).length, 1);
    state.failStop = false;
    await writeFile(stateFile, JSON.stringify(state));
    await shares.unshare(id, level);
    assert.equal((await new Records(recordsFile).load()).length, 0);
    assert.equal(level === "public" ? shares.describe(id).public : shares.describe(id).privateUrl, null);
  });
}

test("a tunnel that exits during readiness is rejected and its recovery record is removed", async (t) => {
  const { dir, recordsFile, shares, target } = await fixture(t);
  await writeFile(
    join(dir, "cloudflared"),
    `#!/usr/bin/env node
process.stderr.write('https://review-test.trycloudflare.com\\nRegistered tunnel connection\\n');
setTimeout(() => process.exit(1), 30);
`,
    { mode: 0o755 },
  );
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    await delay(150);
    return new Response(null, { status: 200 });
  });
  try {
    await assert.rejects(shares.sharePublic(target, "cloudflare", "open"), /cloudflared exited/);
    assert.equal(shares.describe(listenerId(target)).public, null);
    assert.equal((await new Records(recordsFile).load()).length, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test("Tailscale configuration failures disable sharing without losing cleanup records", async (t) => {
  const { stateFile, recordsFile, shares, target } = await fixture(t);
  await shares.sharePublic(target, "funnel", "open");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.failStatus = true;
  await writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(shares.unshare(listenerId(target), "public"), /Couldn't read Tailscale/);
  const sharing = await shares.sharing();
  assert.equal(sharing.https.available, false);
  assert.equal(sharing.funnel.available, false);
  assert.match(sharing.https.reason ?? "", /configuration failure/);
  assert.equal((await new Records(recordsFile).load()).length, 1);
  state.failStatus = false;
  await writeFile(stateFile, JSON.stringify(state));
});

test("stopping the plugin cancels a tunnel still starting and prevents new shares", async (t) => {
  const { dir, recordsFile, shares, target } = await fixture(t);
  await writeFile(join(dir, "cloudflared"), `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`, {
    mode: 0o755,
  });
  const started = assert.rejects(shares.sharePublic(target, "cloudflare", "open"), /cancelled/);
  const until = Date.now() + 3_000;
  while (!(await new Records(recordsFile).load()).length && Date.now() < until) await delay(10);
  assert.equal((await new Records(recordsFile).load()).length, 1);
  await shares.stopAll();
  await started;
  assert.equal((await new Records(recordsFile).load()).length, 0);
  await assert.rejects(shares.sharePublic(target, "cloudflare", "open"), /stopping/);
});

test("a changed Tailscale entry cannot release a proxy port it still references", async (t) => {
  const { stateFile, recordsFile, shares, target } = await fixture(t);
  await shares.sharePublic(target, "funnel", "open");
  const record = (await new Records(recordsFile).load())[0];
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const entry = Object.values(state.config.Web)[0] as { Handlers: Record<string, unknown> };
  entry.Handlers["/docs"] = { Text: "another service" };
  await writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(shares.unshare(listenerId(target), "public"), /still routes to this link/);
  assert.equal((await fetch(record.target)).status, 503);
  assert.equal((await new Records(recordsFile).load()).length, 1);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).config, state.config);
  delete entry.Handlers["/docs"];
  await writeFile(stateFile, JSON.stringify(state));
  await shares.unshare(listenerId(target), "public");
  assert.equal(shares.describe(listenerId(target)).public, null);
});

test("a port that stops qualifying for links loses its forward", async () => {
  const server = await serving("api");
  const target = listener(portOf(server));
  const forwards = new Forwards(new ListenerAccess(async () => [target], 0));
  const dir = await mkdtemp(join(tmpdir(), "ports-requalify-"));
  const shares = new Shares(forwards, new Records(join(dir, "shares.json")));
  try {
    await forwards.open(target, "127.0.0.1");
    assert.equal([...forwards.entries()].length, 1);
    shares.stillLinkable = async () => false;
    await (shares as unknown as { check(): Promise<void> }).check();
    assert.equal([...forwards.entries()].length, 0);
  } finally {
    await shares.stopAll();
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});
