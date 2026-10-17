import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { createServer as tcpServer, type AddressInfo, type Server } from "node:net";
import { test } from "node:test";
import { allowable, detectReply, Detections, knownProtocol, linkable, probe, type Detection } from "./kind";
import { listenerId } from "./identity";
import type { Listener } from "./processes";

const listener = (extra: Partial<Listener> = {}): Listener => ({
  port: 3000,
  address: "127.0.0.1",
  name: "node",
  detail: "node server.js",
  identity: "node server.js",
  pid: 1,
  source: "process",
  cwd: "/work",
  workspaceId: null,
  dirs: [],
  ...extra,
});
const container = (extra: Partial<Listener> = {}) =>
  listener({ source: "docker", pid: null, name: "app", identity: "app-1", instance: "c1", ...extra });

async function listening<T extends Server | ReturnType<typeof httpServer>>(
  server: T,
): Promise<T & { port: number }> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return Object.assign(server, { port: (server.address() as AddressInfo).port });
}

const http = (page: boolean): Detection => ({ protocol: "http", page });

test("knownProtocol skips only database and cache endpoints, port by port", () => {
  assert.equal(
    knownProtocol(
      listener({ name: "postgres", identity: "/usr/lib/postgresql/16/bin/postgres -D /data", port: 5433 }),
    ),
    "other",
  );
  assert.equal(
    knownProtocol(listener({ name: "redis-server", identity: "redis-server *:6380", port: 6380 })),
    "other",
  );
  assert.equal(knownProtocol(listener({ port: 6379 })), "other");
  assert.equal(knownProtocol(listener({ name: "vite", identity: "node /app/node_modules/.bin/vite" })), null);
  // RabbitMQ's AMQP port is skipped, its management UI is asked like anything else
  assert.equal(knownProtocol(container({ name: "rabbitmq", port: 51001, containerPort: 5672 })), "other");
  assert.equal(knownProtocol(container({ name: "rabbitmq", port: 51002, containerPort: 15672 })), null);
  assert.equal(
    knownProtocol(listener({ name: "beam.smp", identity: "beam.smp -- rabbit", port: 15672 })),
    null,
  );
  // a container's name doesn't decide anything on its own
  assert.equal(knownProtocol(container({ name: "redis", port: 51003, containerPort: 8080 })), null);
});

test("detectReply reads HTTP, HTTPS and anything else", () => {
  const reply = (text: string) => detectReply(Buffer.from(text, "latin1"));
  assert.deepEqual(reply("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"), http(false));
  assert.deepEqual(reply("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"), http(true));
  assert.deepEqual(reply("HTTP/1.1 302 Found\r\nLocation: /login\r\n\r\n"), http(true));
  assert.deepEqual(
    reply('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}'),
    http(false),
  );
  assert.deepEqual(
    reply("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nStarting"),
    http(false),
  );
  assert.deepEqual(detectReply(Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46])), {
    protocol: "https",
    page: false,
  });
  assert.deepEqual(reply("-ERR unknown command 'HEAD'\r\n"), { protocol: "other", page: false });
});

test("linkable needs an HTTP answer; containers also a page or your allowance", () => {
  const process = listener();
  const api = container();
  assert.equal(linkable(process, http(false), false), true);
  assert.equal(linkable(api, http(true), false), true);
  assert.equal(linkable(api, http(false), false), false);
  assert.equal(allowable(api, http(false)), true);
  assert.equal(linkable(api, http(false), true), true);
  for (const protocol of ["unknown", "https", "other"] as const)
    assert.equal(linkable(process, { protocol, page: false }, true), false);
  assert.equal(linkable(process, undefined, false), false);
});

test("probe tells HTTP servers from others by asking once", async (t) => {
  const page = await listening(
    httpServer((_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<p>hi</p>")),
  );
  const json = await listening(
    httpServer((_, res) => res.writeHead(200, { "Content-Type": "application/json" }).end("{}")),
  );
  const greeter = await listening(tcpServer((socket) => socket.write("5.7.0-mysql\0")));
  const silent = await listening(tcpServer(() => {}));
  t.after(() => [page, json, greeter, silent].forEach((server) => server.close()));
  assert.deepEqual(await probe(listener({ port: json.port })), http(false));
  assert.deepEqual(await probe(container({ port: page.port })), http(true));
  // the same JSON API is an HTTP server as a container too; whether it gets links is policy
  assert.deepEqual(await probe(container({ port: json.port })), http(false));
  assert.deepEqual(await probe(listener({ port: greeter.port })), { protocol: "other", page: false });
  assert.deepEqual(await probe(listener({ port: silent.port }), 300), { protocol: "unknown", page: false });
});

test("a server that never answers gets no links", async () => {
  const silent = listener({ port: 4000 });
  const detections = new Detections(async () => ({ protocol: "unknown", page: false }));
  await detections.update([silent]);
  assert.equal(linkable(silent, detections.get(silent), false), false);
});

test("Detections ask again when answers expire, on a new instance, and soon after a non-page answer", async () => {
  let now = 0;
  const answers = new Map<string, Detection[]>();
  const asked: string[] = [];
  const detections = new Detections(
    async (l) => {
      const key = `${l.port}:${l.instance ?? l.pid}`;
      asked.push(key);
      return answers.get(String(l.port))!.shift()!;
    },
    () => now,
  );
  const app = listener({ port: 3000, pid: 10 });
  const console = container({ port: 9001 });
  answers.set("3000", [http(false), http(false), http(false)]);
  answers.set("9001", [http(false), http(true), http(true)]);
  await detections.update([app, console]);
  assert.equal(linkable(console, detections.get(console), false), false);
  // a container that answered "503 Starting" is asked again within a minute and can become a page
  now = 31_000;
  await detections.update([app, console]);
  assert.equal(linkable(console, detections.get(console), false), true);
  assert.deepEqual(asked, ["3000:10", "9001:c1", "9001:c1"]);
  // a restart is a new instance: asked at once
  await detections.update([{ ...app, pid: 11 }, console]);
  assert.equal(asked.at(-1), "3000:11");
  // a settled answer expires after ten minutes
  now += 10 * 60_000 + 1;
  await detections.update([{ ...app, pid: 11 }, console]);
  assert.equal(asked.filter((key) => key === "3000:11").length, 2);
});

test("Detections keep a real answer through a missed one, and a restart's only for a few tries", async () => {
  let now = 0;
  const replies: Detection[] = [http(false), { protocol: "unknown", page: false }];
  const detections = new Detections(
    async () => replies.shift() ?? { protocol: "unknown", page: false },
    () => now,
  );
  const app = listener({ port: 3000, pid: 10 });
  await detections.update([app]);
  now += 10 * 60_000 + 1;
  await detections.update([app]);
  // busy for a moment: still an HTTP server
  assert.deepEqual(detections.get(app), http(false));
  // restarted and not answering: the old answer holds for three tries, then it's unknown
  const restarted = { ...app, pid: 11 };
  for (let attempt = 0; attempt < 3; attempt++) {
    await detections.update([restarted]);
    assert.deepEqual(detections.get(restarted), http(false), `attempt ${attempt}`);
    now += 200_000;
  }
  await detections.update([restarted]);
  assert.deepEqual(detections.get(restarted), { protocol: "unknown", page: false });
});

test("a database's port you ask to check is asked like any other", async () => {
  const app = listener({ port: 5432, name: "node", identity: "node api.js" });
  const asked: number[] = [];
  const detections = new Detections(async (l) => (asked.push(l.port), http(false)));
  await detections.update([app]);
  assert.equal(detections.skips(app), true);
  assert.deepEqual(detections.get(app), { protocol: "other", page: false });
  detections.checked = new Set([listenerId(app)]);
  await detections.update([app]);
  assert.equal(detections.skips(app), false);
  assert.deepEqual(asked, [5432]);
  assert.equal(linkable(app, detections.get(app), false), true);
});
