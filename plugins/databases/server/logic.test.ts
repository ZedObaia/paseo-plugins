import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { format } from "sql-formatter";
import { parseAnswer } from "./agents";
import { completions } from "./completion";
import {
  dockerConnections,
  discover,
  environmentConnections,
  endpoint,
  postgresUrl,
  type DockerContainer,
  type HostInventory,
} from "./discovery";
import { browserOrigin, matchesSecret } from "./studio";
import type { Column } from "./postgres";

test("Compose containers are mapped to the exact worktree and wildcard bindings become loopback", () => {
  const container: DockerContainer = {
    Id: "db",
    Name: "/feature-db",
    State: { Running: true },
    Config: {
      Image: "pgvector/pgvector:pg17",
      Env: ["POSTGRES_USER=dev", "POSTGRES_PASSWORD=p=a@ss", "POSTGRES_DB=app"],
      Labels: { "com.docker.compose.project.working_dir": "/work/feature" },
    },
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55432" }] } },
  };
  const [connection] = dockerConnections([container], "/work/feature");
  assert.equal(connection.scope, "workspace");
  assert.equal(connection.endpoint, "127.0.0.1:55432/app");
  assert.equal(decodeURIComponent(new URL(connection.url).password), "p=a@ss");
  assert.equal(connection.endpoint.includes("ss"), false);
  assert.equal(dockerConnections([container], "/work/feature-other")[0].scope, "host");
  container.NetworkSettings.Ports = { "5432/tcp": null };
  assert.deepEqual(dockerConnections([container], "/work/feature"), []);
});

test("environment discovery never inherits another worktree's parent .env", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-db-env-"));
  const child = path.join(root, "child");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(child);
  try {
    await writeFile(path.join(root, ".env"), "DATABASE_URL=postgresql://wrong:secret@localhost/parent");
    await writeFile(
      path.join(child, ".env.local"),
      'DATABASE_URL="postgresql://dev:secret@localhost:5433/feature"\nOTHER_SECRET=hidden\n',
    );
    assert.equal((await environmentConnections(child))[0].name, "feature");
    await rm(path.join(child, ".env.local"));
    assert.deepEqual(await environmentConnections(child), []);
    await writeFile(path.join(child, ".env"), "PGHOST=/tmp\nPGPORT=5433\nPGDATABASE=feature\nPGUSER=dev");
    const [socket] = await environmentConnections(child);
    assert.equal(new URL(socket.url).searchParams.get("host"), "/tmp");
    assert.equal(socket.endpoint, "/tmp/.s.PGSQL.5433/feature");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attaching a host database changes only that worktree and does not duplicate its connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-db-scope-"));
  const url = "postgresql://dev:secret@localhost:5433/app";
  const connection = {
    id: "host-db",
    url,
    name: "app",
    endpoint: "localhost:5433/app",
    source: "host" as const,
    type: "pg" as const,
    scope: "host" as const,
    detail: "Local listener",
    needsCredentials: true,
  };
  const host: HostInventory = { containers: [], connections: [connection], notices: [] };
  try {
    const attached = await discover(root, [{ ...connection, source: "saved", scope: "workspace" }], host);
    assert.equal(attached.connections.length, 1);
    assert.equal(attached.connections[0].scope, "workspace");
    const otherWorktree = await discover(root, [], host);
    assert.equal(otherWorktree.connections[0].scope, "host");
    assert.equal(host.connections[0].scope, "host");
    await writeFile(path.join(root, ".env"), `DATABASE_URL=${url}`);
    assert.equal((await discover(root, [], host)).connections.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connection validation and display keep passwords out of endpoints", () => {
  assert.equal(endpoint("postgresql://user:password@localhost/test?sslmode=require"), "localhost:5432/test");
  assert.throws(() => postgresUrl("mysql://localhost/test"));
  assert.throws(() => postgresUrl("postgresql://localhost"));
});

const columns: Column[] = [
  { schema: "public", table: "users", column: "id", type: "integer", nullable: false, description: null },
  { schema: "public", table: "users", column: "email", type: "text", nullable: false, description: null },
  { schema: "audit", table: "UserEvents", column: "event", type: "text", nullable: true, description: null },
];
test("completion uses live schemas, tables, column types and table aliases", () => {
  assert.equal(completions(columns, "SELECT * FROM public.us")[0].label, "users");
  assert.deepEqual(
    completions(columns, "SELECT * FROM users u WHERE u.em").map((item) => item.label),
    ["email"],
  );
  assert.equal(completions(columns, "SELECT * FROM audit.U")[0].insertText, '"UserEvents"');
  assert.equal(completions(columns, "SELECT users.id, users.em")[0].detail, "text");
});

test("SQL formatting preserves quoted content and comments", () => {
  const sql = "select 'A   B, C AND D' as value, $$X WHERE Y$$ as body -- leave this comment\nfrom users";
  const formatted = format(sql, { language: "postgresql" });
  assert.ok(formatted.includes("'A   B, C AND D'"));
  assert.ok(formatted.includes("$$X WHERE Y$$"));
  assert.ok(formatted.includes("-- leave this comment"));
});

test("gateway origins and session secrets refuse unauthenticated or insecure addresses", () => {
  assert.equal(browserOrigin("http://localhost:4000/"), "http://localhost:4000");
  assert.equal(browserOrigin("https://db.example.com"), "https://db.example.com");
  for (const invalid of [
    "http://public.example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "file:///tmp/studio",
  ])
    assert.throws(() => browserOrigin(invalid));
  assert.ok(matchesSecret("secret", "secret"));
  assert.equal(matchesSecret(undefined, "secret"), false);
  assert.equal(matchesSecret("different-length", "secret"), false);
  assert.equal(matchesSecret("secrex", "secret"), false);
});

test("agent output is validated rather than treated as an executable response", () => {
  assert.equal(parseAnswer('```json\n{"sql":"SELECT 1","explanation":"A constant"}\n```').sql, "SELECT 1");
  assert.throws(() => parseAnswer('{"sql":42}'));
  assert.throws(() => parseAnswer("SELECT 1"));
});
