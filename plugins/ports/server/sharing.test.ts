import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { test } from "node:test";
import { parseTunnelUrl } from "./cloudflare";
import { authorized, newPassword, rewriteLocation, startProxy, upstreamHeaders, upstreamOf } from "./proxy";
import { leftoverPlan, type ShareRecord } from "./records";
import {
  canOperate,
  chooseFunnelPort,
  parseServeConfig,
  parseStatus,
  servesOnly,
  tailscaleOptions,
  type TailscaleState,
} from "./tailscale";

// trimmed from `tailscale status --json` on a machine with HTTPS and Funnel
const STATUS = {
  BackendState: "Running",
  CertDomains: ["devbox.tail96d4f9.ts.net"],
  Self: {
    DNSName: "devbox.tail96d4f9.ts.net.",
    TailscaleIPs: ["100.111.26.0", "fd7a:115c:a1e0::e639:1a01"],
    CapMap: {
      funnel: null,
      https: null,
      "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000": null,
      "https://tailscale.com/cap/is-admin": null,
    },
  },
};

// `tailscale serve status --json` with the devbox's own 443 entry and a Funnel the plugin made
const SERVE = {
  TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true }, "22022": { TCPForward: "127.0.0.1:22" } },
  Web: {
    "devbox.tail96d4f9.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
    "devbox.tail96d4f9.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:40001" } } },
  },
  AllowFunnel: { "devbox.tail96d4f9.ts.net:8443": true },
};

test("parseStatus reads the name, addresses, HTTPS and Funnel", () => {
  assert.deepEqual(parseStatus(STATUS), {
    backendState: "Running",
    dnsName: "devbox.tail96d4f9.ts.net",
    addresses: ["100.111.26.0", "fd7a:115c:a1e0::e639:1a01"],
    https: true,
    funnel: true,
    funnelPorts: [443, 8443, 10000],
  });
  const plain = parseStatus({
    BackendState: "Running",
    CertDomains: null,
    Self: { DNSName: "box.tail1.ts.net.", CapMap: { "https://tailscale.com/cap/funnel": null } },
  });
  assert.equal(plain.https, false);
  // the long form of the attribute counts, and Funnel's usual ports apply when none are listed
  assert.equal(plain.funnel, true);
  assert.deepEqual(plain.funnelPorts, [443, 8443, 10000]);
  assert.equal(parseStatus({ BackendState: "NeedsLogin", Self: {} }).dnsName, null);
});

test("canOperate allows root, the operator, and the macOS app's user", () => {
  const zeyad = { username: "zeyad", uid: 1001 };
  assert.equal(canOperate({ OperatorUser: "zeyad" }, zeyad, "linux"), true);
  assert.equal(canOperate({ OperatorUser: "" }, zeyad, "linux"), false);
  assert.equal(canOperate(null, zeyad, "linux"), false);
  assert.equal(canOperate(null, { username: "root", uid: 0 }, "linux"), true);
  assert.equal(canOperate(null, zeyad, "darwin"), true);
});

test("parseServeConfig and servesOnly tell the plugin's ports from others", () => {
  const config = parseServeConfig(SERVE);
  assert.deepEqual(config.get(443), {
    https: true,
    tcpForward: null,
    handlers: { "/": "http://127.0.0.1:3773" },
    funnel: false,
  });
  assert.equal(config.get(8443)?.funnel, true);
  assert.equal(servesOnly(config, 8443, "http://127.0.0.1:40001"), true);
  assert.equal(servesOnly(config, 8443, "http://127.0.0.1:40002"), false);
  assert.equal(servesOnly(config, 22022, "127.0.0.1:22"), false);
  assert.equal(servesOnly(config, 10000, "http://127.0.0.1:40001"), false);
  // a second path on the plugin's port means someone added to it
  const added = parseServeConfig({
    Web: {
      "x.ts.net:8443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:40001" }, "/docs": { Path: "/srv/docs" } },
      },
    },
  });
  assert.equal(servesOnly(added, 8443, "http://127.0.0.1:40001"), false);
  assert.equal(parseServeConfig({}).size, 0);
});

test("chooseFunnelPort skips ports that serve something or that another process holds", () => {
  const config = parseServeConfig(SERVE);
  const free = () => true;
  assert.equal(chooseFunnelPort([443, 8443, 10000], config, free), 10000);
  assert.equal(
    chooseFunnelPort([443, 8443, 10000], parseServeConfig({ TCP: { "443": { HTTPS: true } } }), free),
    8443,
  );
  assert.equal(
    chooseFunnelPort([443, 8443, 10000], parseServeConfig({}), (port) => port !== 443),
    8443,
  );
  assert.equal(
    chooseFunnelPort([443, 8443, 10000], config, (port) => port !== 10000),
    null,
  );
});

test("tailscaleOptions says what's missing", () => {
  const ready: TailscaleState = {
    status: parseStatus(STATUS),
    config: parseServeConfig({ TCP: { "443": { HTTPS: true } } }),
    operator: true,
    problem: null,
  };
  assert.deepEqual(tailscaleOptions(ready, "zeyad"), {
    https: { available: true, reason: null },
    funnel: { available: true, reason: null },
  });
  const notInstalled = tailscaleOptions(
    { status: null, config: new Map(), operator: false, problem: "Tailscale isn't installed on this host." },
    "zeyad",
  );
  assert.equal(notInstalled.https.reason, "Tailscale isn't installed on this host.");
  assert.match(tailscaleOptions({ ...ready, operator: false }, "zeyad").https.reason!, /--operator=zeyad/);
  assert.match(
    tailscaleOptions({ ...ready, status: { ...ready.status!, https: false } }, "zeyad").funnel.reason!,
    /HTTPS certificates are off/,
  );
  const noFunnel = tailscaleOptions({ ...ready, status: { ...ready.status!, funnel: false } }, "zeyad");
  assert.equal(noFunnel.https.available, true);
  assert.match(noFunnel.funnel.reason!, /funnel attribute/);
  const full = tailscaleOptions({ ...ready, config: parseServeConfig(SERVE) }, "zeyad");
  assert.equal(full.funnel.available, true);
  const allUsed = parseServeConfig({ TCP: { "443": {}, "8443": {}, "10000": {} } });
  assert.match(
    tailscaleOptions({ ...ready, config: allUsed }, "zeyad").funnel.reason!,
    /all serve something/,
  );
});

test("leftoverPlan undoes only what is still exactly the plugin's", () => {
  const config = parseServeConfig(SERVE);
  const records: ShareRecord[] = [
    // still serves the plugin's old proxy: remove
    { kind: "funnel", httpsPort: 8443, target: "http://127.0.0.1:40001" },
    // now serves something else: leave it
    { kind: "serve", httpsPort: 443, target: "http://127.0.0.1:40002" },
    // already gone: nothing to do
    { kind: "serve", httpsPort: 5173, target: "http://127.0.0.1:40003" },
    // still the tunnel the plugin started: stop it
    { kind: "cloudflared", pid: 4242, target: "http://127.0.0.1:40004" },
    // the pid belongs to something else now
    { kind: "cloudflared", pid: 4343, target: "http://127.0.0.1:40005" },
    // exited
    { kind: "cloudflared", pid: 4444, target: "http://127.0.0.1:40006" },
  ];
  const commands: Record<number, string> = {
    4242: "/usr/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:40004",
    4343: "node server.js",
  };
  const plan = leftoverPlan(records, config, (pid) => commands[pid] ?? null);
  assert.deepEqual(plan.unserve, [{ kind: "funnel", httpsPort: 8443 }]);
  assert.deepEqual(plan.kill, [4242]);
  assert.deepEqual(plan.changed, [records[1]]);
  // without Tailscale's config nothing is turned off
  assert.deepEqual(leftoverPlan(records, null, () => null).unserve, []);
});

test("upstreamOf connects to loopback and names the host dev servers accept", () => {
  assert.deepEqual(upstreamOf("::1", 5173), { connectTo: "::1", port: 5173, host: "localhost:5173" });
  assert.deepEqual(upstreamOf("0.0.0.0", 3000), {
    connectTo: "127.0.0.1",
    port: 3000,
    host: "localhost:3000",
  });
  assert.deepEqual(upstreamOf("::", 3000), { connectTo: "::1", port: 3000, host: "localhost:3000" });
  assert.deepEqual(upstreamOf("192.168.1.20", 8080), {
    connectTo: "192.168.1.20",
    port: 8080,
    host: "192.168.1.20:8080",
  });
});

test("upstreamHeaders rewrites Host, a same-origin Origin, and drops the share's password", () => {
  const raw = [
    "Host",
    "devbox.tail96d4f9.ts.net:8443",
    "Origin",
    "https://devbox.tail96d4f9.ts.net:8443",
    "Authorization",
    "Basic eDpzZWNyZXQ=",
    "Connection",
    "keep-alive",
    "Accept",
    "text/html",
  ];
  assert.deepEqual(upstreamHeaders(raw, "localhost:5173", { upgrade: false, stripAuthorization: true }), [
    "Origin",
    "http://localhost:5173",
    "Accept",
    "text/html",
    "Host",
    "localhost:5173",
    "X-Forwarded-Host",
    "devbox.tail96d4f9.ts.net:8443",
    "X-Forwarded-Proto",
    "https",
  ]);
  const foreign = upstreamHeaders(
    ["Host", "a.trycloudflare.com", "Origin", "https://evil.example", "X-Forwarded-Proto", "https"],
    "localhost:5173",
    { upgrade: false, stripAuthorization: false },
  );
  assert.deepEqual(foreign, [
    "Origin",
    "https://evil.example",
    "X-Forwarded-Proto",
    "https",
    "Host",
    "localhost:5173",
    "X-Forwarded-Host",
    "a.trycloudflare.com",
  ]);
  const upgrade = upstreamHeaders(
    ["Host", "h", "Connection", "Upgrade", "Upgrade", "websocket"],
    "localhost:5173",
    { upgrade: true, stripAuthorization: false },
  );
  assert.deepEqual(upgrade.slice(0, 4), ["Connection", "Upgrade", "Upgrade", "websocket"]);
});

test("rewriteLocation sends redirects to the server's own address back to the shared one", () => {
  const origin = "https://devbox.tail96d4f9.ts.net:8443";
  assert.equal(rewriteLocation("http://localhost:5173/login", "localhost:5173", origin), `${origin}/login`);
  assert.equal(rewriteLocation("http://localhost:5173", "localhost:5173", origin), origin);
  assert.equal(rewriteLocation("/login", "localhost:5173", origin), "/login");
  assert.equal(
    rewriteLocation("http://localhost:51730/x", "localhost:5173", origin),
    "http://localhost:51730/x",
  );
});

test("authorized takes any user name with the password", () => {
  const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString("base64")}`;
  assert.equal(authorized(basic("anyone:abcd-efgh-jkmn"), "abcd-efgh-jkmn"), true);
  assert.equal(authorized(basic(":abcd-efgh-jkmn"), "abcd-efgh-jkmn"), true);
  assert.equal(authorized(basic("anyone:wrong"), "abcd-efgh-jkmn"), false);
  assert.equal(authorized(basic("abcd-efgh-jkmn"), "abcd-efgh-jkmn"), false);
  assert.equal(authorized(undefined, "abcd-efgh-jkmn"), false);
  assert.equal(authorized("Bearer abcd-efgh-jkmn", "abcd-efgh-jkmn"), false);
  assert.match(newPassword(), /^[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}$/);
  assert.notEqual(newPassword(), newPassword());
});

test("parseTunnelUrl finds the quick tunnel's address in cloudflared's log", () => {
  const log = [
    "2026-10-17T08:01:02Z INF Requesting new quick Tunnel on trycloudflare.com...",
    "2026-10-17T08:01:04Z INF |  https://duo-legends-brother-angela.trycloudflare.com                                    |",
  ].join("\n");
  assert.equal(parseTunnelUrl(log), "https://duo-legends-brother-angela.trycloudflare.com");
  assert.equal(parseTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com..."), null);
});

test("the proxy gets past a dev server's Host check, asks for the password, and passes upgrades", async () => {
  // a stand-in for Vite: only answers Host localhost, and accepts WebSocket-style upgrades
  const dev = createServer((req, res) => {
    if (req.headers.host !== `localhost:${(dev.address() as AddressInfo).port}`) {
      res.writeHead(403).end("Blocked request. This host is not allowed.");
      return;
    }
    res.writeHead(302, {
      Location: `http://${req.headers.host}/next`,
      "X-Seen-Host": `${req.headers["x-forwarded-host"]}`,
    });
    res.end();
  });
  dev.on("upgrade", (req, socket) => {
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => dev.listen(0, "127.0.0.1", resolve));
  const target = { address: "127.0.0.1", port: (dev.address() as AddressInfo).port };
  const proxy = await startProxy(target, "abcd-efgh-jkmn");
  const proxyPort = Number(new URL(proxy.url).port);
  const get = (headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxyPort, path: "/", headers }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on("error", reject);
      req.end();
    });
  const auth = `Basic ${Buffer.from("x:abcd-efgh-jkmn").toString("base64")}`;
  try {
    const denied = await get({ Host: "devbox.tail96d4f9.ts.net:8443" });
    assert.equal(denied.status, 401);
    assert.match(String(denied.headers["www-authenticate"]), /^Basic realm=/);
    const ok = await get({ Host: "devbox.tail96d4f9.ts.net:8443", Authorization: auth });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers["x-seen-host"], "devbox.tail96d4f9.ts.net:8443");
    assert.equal(ok.headers.location, "https://devbox.tail96d4f9.ts.net:8443/next");
    const upgraded = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxyPort, "127.0.0.1", () =>
        socket.write(
          `GET /hmr HTTP/1.1\r\nHost: devbox.tail96d4f9.ts.net:8443\r\nAuthorization: ${auth}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        ),
      );
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    assert.match(upgraded, /^HTTP\/1\.1 101/);
    assert.match(upgraded, new RegExp(`X-Seen-Host: localhost:${target.port}`));
  } finally {
    proxy.close();
    dev.close();
  }
});
