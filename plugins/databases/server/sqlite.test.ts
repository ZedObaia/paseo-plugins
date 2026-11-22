import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createPaseoClient } from "@getpaseo/client";
import { discover, sqliteFile } from "./discovery";
import { savedConnections, saveConnection } from "./state";
import { startStudio } from "./studio";

test("SQLite paths require an existing database and remain attached to their workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-sqlite-path-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = directory;
  try {
    const file = path.join(directory, "my # database.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL)");
    db.close();
    await symlink(file, path.join(directory, "linked.sqlite"));
    const url = await sqliteFile("./linked.sqlite", directory);
    assert.equal(url, `sqlite://${await realpath(file)}`);
    assert.equal(await sqliteFile(pathToFileURL(file).href, directory), url);
    await saveConnection("workspace", url);
    const saved = await savedConnections("workspace");
    assert.equal(saved[0].type, "sqlite");
    assert.equal(saved[0].endpoint, await realpath(file));
    assert.deepEqual(await savedConnections("other-workspace"), []);
    const found = await discover(directory, saved, { containers: [], connections: [], notices: [] });
    assert.equal(found.connections[0].name, "my # database.sqlite");
    await assert.rejects(sqliteFile("missing.sqlite", directory), /Cannot open SQLite file/);
    await assert.rejects(readFile(path.join(directory, "missing.sqlite")), /ENOENT/);
    await writeFile(path.join(directory, "fake.db"), "Not SQLite");
    await assert.rejects(sqliteFile("fake.db", directory), /Not a SQLite database/);
    await assert.rejects(sqliteFile(".", directory), /Not a regular file/);
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite Studio browses and edits a real file with completion, formatting and capped results", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-sqlite-studio-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = directory;
  const file = path.join(directory, "test.sqlite");
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, "Display Name" TEXT)');
  db.exec("INSERT INTO users VALUES (1, 'test@example.com', 'Test User')");
  db.close();
  const paseo = createPaseoClient({ url: "ws://127.0.0.1:1/ws" });
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  try {
    studio = await startStudio({
      directory,
      pluginDir: path.resolve(import.meta.dirname, ".."),
      workspaceId: "sqlite-test",
      url: await sqliteFile(file, directory),
      paseo,
    });
    const origin = new URL(studio.url).origin;
    assert.equal((await fetch(origin)).status, 401);
    const bootstrap = await fetch(studio.url, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const headers = {
      cookie: bootstrap.headers.get("set-cookie")!.split(";")[0],
      "content-type": "application/json",
    };
    const post = async (route: string, input: unknown) => {
      const response = await fetch(`${origin}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      return payload;
    };
    const tables = await (await fetch(`${origin}/api/sqlite/tables?db=main`, { headers })).json();
    assert.equal(tables.data[0].tableName, "users");
    const columns = await (
      await fetch(`${origin}/api/sqlite/tables/users/columns?db=main`, { headers })
    ).json();
    assert.ok(columns.data.some((c: { columnName: string }) => c.columnName === "email"));
    const suggestions = await post("/paseo/completions", {
      text: "SELECT * FROM users u WHERE u.em",
      database: "main",
    });
    assert.equal(suggestions[0].label, "email");
    assert.match(
      (await post("/paseo/format", { sql: "select [Display Name], 'a  b' from users limit 1" })).sql,
      /\[Display Name\]/,
    );
    assert.equal(
      (await post("/api/sqlite/query?db=main", { query: "SELECT 9007199254740993 AS id" })).data.rows[0].id,
      "9007199254740993",
    );
    const result = (
      await post("/api/sqlite/query?db=main", {
        query: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 1200) SELECT x FROM n",
      })
    ).data;
    assert.equal(result.rows.length, 1000);
    assert.equal(result.rowCount, 1200);
    assert.match(result.message, /first 1000/);
    await post("/api/sqlite/query?db=main", {
      query: "UPDATE users SET email = 'edited@example.com' WHERE id = 1",
    });
    const verify = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(verify.prepare("SELECT email FROM users WHERE id = 1").get()!.email, "edited@example.com");
    } finally {
      verify.close();
    }
    const transaction = await fetch(`${origin}/api/sqlite/query?db=main`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "BEGIN" }),
    });
    assert.equal(transaction.status, 400);
    assert.match((await transaction.json()).error, /Transaction statements/);
    if (process.env.PASEO_SQLITE_BROWSER_CHECK === "1") {
      console.log(`BROWSER_CHECK_URL=${studio.url}`);
      await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
    }
  } finally {
    await studio?.close();
    await paseo.dispose();
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
