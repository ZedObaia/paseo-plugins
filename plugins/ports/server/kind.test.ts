import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { createServer as tcpServer, type AddressInfo, type Server } from "node:net";
import { test } from "node:test";
import { kindOfReply, knownKind, PortKinds, probe } from "./kind";
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

async function listening<T extends Server | ReturnType<typeof httpServer>>(
  server: T,
): Promise<T & { port: number }> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return Object.assign(server, { port: (server.address() as AddressInfo).port });
}

test("knownKind recognizes databases and caches without asking them", () => {
  assert.equal(
    knownKind(listener({ name: "postgres", identity: "/usr/lib/postgresql/16/bin/postgres -D /data" })),
    "other",
  );
  assert.equal(knownKind(listener({ name: "redis-server", identity: "redis-server *:6379" })), "other");
  assert.equal(knownKind(listener({ name: "vite", identity: "node /app/node_modules/.bin/vite" })), null);
  const container = { source: "docker" as const, pid: null, name: "db", identity: "app-db-1" };
  assert.equal(knownKind(listener({ ...container, port: 51972, containerPort: 5432 })), "other");
  assert.equal(
    knownKind(listener({ ...container, name: "redis", port: 51973, containerPort: 7000 })),
    "other",
  );
  assert.equal(knownKind(listener({ ...container, name: "minio", port: 51975, containerPort: 9001 })), null);
});

test("kindOfReply: any HTTP answer for a process, a page for a container", () => {
  assert.equal(kindOfReply("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n", false), "web");
  assert.equal(kindOfReply("-ERR unknown command 'HEAD'\r\n", false), "other");
  assert.equal(kindOfReply("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n", true), "web");
  assert.equal(kindOfReply("HTTP/1.1 302 Found\r\nLocation: /login\r\n\r\n", true), "web");
  assert.equal(kindOfReply("HTTP/1.1 403 Forbidden\r\nContent-Type: application/xml\r\n\r\n", true), "other");
  assert.equal(kindOfReply("", true), "other");
});

test("probe tells web servers from others by asking once", async (t) => {
  const page = await listening(
    httpServer((_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<p>hi</p>")),
  );
  const api = await listening(
    httpServer((_, res) => res.writeHead(403, { "Content-Type": "application/xml" }).end("<Error/>")),
  );
  // speaks first, like MySQL or SSH
  const greeter = await listening(tcpServer((socket) => socket.write("5.7.0-mysql\0")));
  const silent = await listening(tcpServer(() => {}));
  t.after(() => [page, api, greeter, silent].forEach((server) => server.close()));
  const docker = { source: "docker" as const, pid: null };
  assert.equal(await probe(listener({ port: page.port })), "web");
  assert.equal(await probe(listener({ port: api.port })), "web");
  assert.equal(await probe(listener({ ...docker, port: page.port })), "web");
  assert.equal(await probe(listener({ ...docker, port: api.port })), "other");
  assert.equal(await probe(listener({ port: greeter.port })), "other");
  assert.equal(await probe(listener({ port: silent.port }), 300), "unknown");
});

test("PortKinds asks each server once, and again later when it didn't answer", async () => {
  const asked: number[] = [];
  const answers: Record<number, "web" | "other" | "unknown"> = {
    3000: "web",
    4000: "unknown",
    5000: "unknown",
  };
  const kinds = new PortKinds(async (l) => (asked.push(l.port), answers[l.port]));
  const app = listener({ port: 3000 });
  const starting = listener({ port: 4000 });
  const container = listener({ port: 5000, source: "docker", pid: null, identity: "app-web-1" });
  const db = listener({ port: 5432, name: "postgres" });
  await kinds.update([app, starting, container, db]);
  assert.deepEqual(asked.sort(), [3000, 4000, 5000]);
  // one that didn't answer counts as a web server if it's a process (still starting), not if it's a container
  assert.deepEqual(
    [kinds.get(app), kinds.get(starting), kinds.get(container), kinds.get(db)],
    ["web", "web", "other", "other"],
  );
  await kinds.update([app, starting, container, db]);
  assert.equal(asked.length, 3);
});
