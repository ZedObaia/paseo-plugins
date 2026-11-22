import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { format } from "sql-formatter";
import { z } from "zod";
import { AgentJobs, conversationSchema } from "./agents";
import { completions } from "./completion";
import { connectionId, databaseType, postgresUrl, sqliteFile } from "./discovery";
import { MAX_ROWS, Postgres, type Column } from "./postgres";
import { stateDir } from "./state";

const sqlBody = z.object({ sql: z.string().trim().min(1).max(100000) });
const contextBody = z.object({ database: z.string().max(256).nullish() });
const completionBody = contextBody.extend({ text: z.string().max(100000) });
const generateBody = contextBody.extend({
  prompt: z.string().trim().min(1).max(20000),
  provider: z.string().min(1).max(200).optional(),
  history: conversationSchema.optional(),
});
const queryBody = z.object({ query: z.string().trim().min(1).max(100000) });
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
let assets: Promise<Record<string, string>> | undefined;
const getAssets = (directory: string) =>
  (assets ??= readFile(path.join(directory, "assets/studio.json.gz")).then(
    (data) => JSON.parse(gunzipSync(data).toString()) as Record<string, string>,
  ));

export function matchesSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function browserOrigin(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Browser address must be an origin, such as http://localhost:4000");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("Use HTTPS, or a localhost address for an SSH port forward");
  return url.origin;
}

function timeoutSignal(milliseconds: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref();
  return controller.signal;
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new Error("Expected application/json");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > 2 * 1024 * 1024) throw new Error("Request is too large (2 MiB maximum)");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a studio port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

export type Studio = {
  id: string;
  workspaceId: string;
  connectionUrl: string;
  provider?: string;
  origin?: string;
  url: string;
  port: number;
  readonly alive: boolean;
  close(): Promise<void>;
};

export async function startStudio(options: {
  directory: string;
  pluginDir: string;
  workspaceId: string;
  url: string;
  provider?: string;
  browserOrigin?: string;
  paseo: PluginHandlerContext["paseo"];
}): Promise<Studio> {
  if (databaseType(options.url) === "sqlite") options.url = await sqliteFile(options.url, options.directory);
  else postgresUrl(options.url);
  const origin = browserOrigin(options.browserOrigin);
  const web = await getAssets(options.pluginDir);
  const id = randomUUID();
  const token = randomBytes(32).toString("hex");
  const cookie = `paseo_db_${id.replaceAll("-", "")}`;
  const configDir = path.join(stateDir(), "studios", connectionId(options.workspaceId));
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const emptyEnv = path.join(configDir, "empty.env");
  await writeFile(emptyEnv, "", { mode: 0o600 });
  const backendPort = await freePort();
  const backend = `http://127.0.0.1:${backendPort}`;
  const child = spawn(
    process.versions.electron ? "node" : process.execPath,
    [
      path.join(options.pluginDir, "node_modules/db-studio/dist/index.js"),
      "--env",
      emptyEnv,
      "--port",
      String(backendPort),
      "--no-open",
    ],
    {
      cwd: options.directory,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(backendPort),
        DATABASE_URL: options.url,
        DB_STUDIO_CONFIG_DIR: configDir,
        DB_STUDIO_TELEMETRY: "0",
        NODE_ENV: "production",
        DB_STUDIO_SERVER_URL: backend,
        SENTRY_DSN: "",
        SENTRY_AUTH_TOKEN: "",
      },
    },
  );
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  let type = databaseType(options.url);
  let database = type === "pg" ? new Postgres(options.url) : undefined;
  const jobs = new AgentJobs(options.paseo, options.workspaceId, options.provider);
  let closed = false;
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.close();
    await database?.close();
    if (child.pid && !spawnError && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
      timer.unref();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      clearTimeout(timer);
    }
  };
  child.once("exit", () => {
    if (!closed) void close();
  });

  async function syncConnection(request: IncomingMessage) {
    const upstream = await fetch(`${backend}/api/connections`, { signal: timeoutSignal(5000) });
    const { data } = (await upstream.json()) as {
      data: { active: { id: string; dbType: string; connectionId: string } | null };
    };
    if (!data.active || !["pg", "sqlite"].includes(data.active.dbType))
      throw new Error("Select a PostgreSQL or SQLite connection first");
    const sent = request.headers["x-connection-id"];
    if (sent && sent !== data.active.connectionId)
      throw new Error("The connection changed. Reload the studio before continuing.");
    const saved = JSON.parse(await readFile(path.join(configDir, "connections.json"), "utf8")) as {
      connections: { id: string; url: string }[];
    };
    const connection = saved.connections.find((c) => c.id === data.active!.id);
    if (!connection) throw new Error("The active connection is no longer saved. Reconnect in the studio.");
    const next = databaseType(connection.url);
    if (next === "sqlite") {
      await database?.close();
      database = undefined;
    } else if (database) await database.setUrl(connection.url);
    else database = new Postgres(connection.url);
    type = next;
  }

  async function sqliteQuery(query: string) {
    const result = await fetch(`${backend}/api/sqlite/query?db=main`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: timeoutSignal(45000),
    });
    const payload = (await result.json()) as {
      error?: string;
      message?: string;
      data: {
        columns: string[];
        rows: Record<string, unknown>[];
        rowCount: number;
        duration: number;
        message?: string;
      };
    };
    if (!result.ok) throw new Error(payload.error ?? payload.message ?? "SQLite query failed");
    return payload.data;
  }

  async function schema(name?: string): Promise<Column[]> {
    if (database) return database.schema(name);
    const result = await sqliteQuery(`SELECT 'main' AS schema, m.name AS "table", p.name AS "column",
      p.type AS type, NOT p."notnull" AS nullable
      FROM sqlite_schema m JOIN pragma_table_xinfo(m.name) p
      WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' AND p.hidden != 1
      ORDER BY m.name, p.cid`);
    return result.rows.map((row) => ({ ...row, nullable: !!row.nullable, description: null }) as Column);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    try {
      const host = request.headers.host ?? "";
      const address = server.address();
      const localPort = typeof address === "object" && address ? address.port : 0;
      const allowed = new Set([
        `127.0.0.1:${localPort}`,
        `localhost:${localPort}`,
        ...(origin ? [new URL(origin).host] : []),
      ]);
      if (!allowed.has(host)) {
        json(response, { error: "Host not allowed" }, 403);
        return;
      }
      const requestUrl = new URL(request.url ?? "/", `http://${host}`);
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/" &&
        matchesSecret(requestUrl.searchParams.get("token") ?? undefined, token)
      ) {
        response.writeHead(303, {
          location: "/",
          "set-cookie": `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${origin?.startsWith("https:") ? "; Secure" : ""}`,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      const suppliedCookie = request.headers.cookie
        ?.split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${cookie}=`))
        ?.slice(cookie.length + 1);
      if (!matchesSecret(suppliedCookie, token)) {
        json(response, { error: "Open this studio from the Databases panel in Paseo" }, 401);
        return;
      }
      if (request.headers.origin && !new Set([`http://${host}`, origin]).has(request.headers.origin)) {
        json(response, { error: "Origin not allowed" }, 403);
        return;
      }
      const pathname = requestUrl.pathname;
      if (request.method === "GET" && pathname === "/paseo/models") {
        json(response, { models: await jobs.models() });
        return;
      }
      if (pathname.startsWith("/paseo/jobs/")) {
        const jobId = pathname.slice("/paseo/jobs/".length);
        if (request.method === "DELETE") await jobs.cancel(jobId);
        else if (request.method !== "GET") {
          json(response, { error: "Method not allowed" }, 405);
          return;
        }
        json(response, jobs.get(jobId));
        return;
      }
      if (request.method === "POST" && pathname === "/paseo/format") {
        const input = sqlBody.parse(await body(request));
        await syncConnection(request);
        json(response, { sql: format(input.sql, { language: type === "sqlite" ? "sqlite" : "postgresql" }) });
        return;
      }
      if (request.method === "POST" && pathname === "/paseo/cancel") {
        await body(request);
        await syncConnection(request);
        if (!database)
          throw new Error("SQLite query cancellation is not supported. Stop Studio to end a long query.");
        await database.cancel();
        json(response, { ok: true });
        return;
      }
      if (request.method === "POST" && pathname === "/paseo/completions") {
        const input = completionBody.parse(await body(request));
        await syncConnection(request);
        json(response, completions(await schema(input.database ?? undefined), input.text));
        return;
      }
      if (request.method === "POST" && pathname === "/paseo/generate") {
        const input = generateBody.parse(await body(request));
        await syncConnection(request);
        json(
          response,
          await jobs.start(input.prompt, await schema(input.database ?? undefined), {
            provider: input.provider,
            history: input.history,
            dialect: type,
          }),
        );
        return;
      }
      if (request.method === "POST" && /^\/api\/(pg|sqlite)\/query\/?$/.test(pathname)) {
        const input = queryBody.parse(await body(request));
        await syncConnection(request);
        if (!pathname.startsWith(`/api/${type}/`)) throw new Error("The connection changed. Reload Studio.");
        const result = database
          ? await database.execute(input.query, requestUrl.searchParams.get("db") ?? undefined)
          : await sqliteQuery(input.query);
        if (result.rows.length > MAX_ROWS) {
          result.rows = result.rows.slice(0, MAX_ROWS);
          result.message = `Showing the first ${MAX_ROWS} of ${result.rowCount} rows. Add LIMIT or a filter to narrow the result.`;
        }
        json(response, { data: result });
        return;
      }
      // The fork uses Paseo agents exclusively; no requests or keys go to the upstream AI proxy.
      if (pathname === "/api/chat/limit" && request.method === "GET") {
        json(response, { remaining: 0, used: 0, limit: 0 });
        return;
      }
      if (pathname.startsWith("/api/chat")) {
        json(response, { error: "Use Ask Paseo to generate queries" }, 404);
        return;
      }
      if (pathname.startsWith("/api/telemetry")) {
        json(response, { data: { enabled: false, installationId: "", appVersion: "1.20.0" } });
        return;
      }
      if (pathname.startsWith("/api/")) {
        const raw = ["GET", "HEAD"].includes(request.method ?? "GET")
          ? undefined
          : JSON.stringify(await body(request));
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (typeof request.headers["x-connection-id"] === "string")
          headers["x-connection-id"] = request.headers["x-connection-id"];
        const result = await fetch(`${backend}${pathname}${requestUrl.search}`, {
          method: request.method,
          headers,
          body: raw,
          signal: timeoutSignal(45000),
          redirect: "error",
        });
        response.writeHead(result.status, {
          "content-type": result.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        });
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, { error: "Method not allowed" }, 405);
        return;
      }
      const key = web[pathname] ? pathname : path.extname(pathname) ? null : "/index.html";
      if (!key || !web[key]) {
        json(response, { error: "Not found" }, 404);
        return;
      }
      response.writeHead(200, {
        "content-type": types[path.extname(key)] ?? "application/octet-stream",
        "cache-control": "private, no-cache",
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
      });
      response.end(request.method === "HEAD" ? undefined : Buffer.from(web[key], "base64"));
    } catch (error) {
      if (!response.headersSent)
        json(
          response,
          {
            error:
              error instanceof z.ZodError
                ? "Invalid request"
                : error instanceof Error
                  ? error.message
                  : "Request failed",
          },
          400,
        );
      else response.destroy();
    }
  }

  try {
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      if (spawnError) throw new Error(`db-studio could not start: ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "db-studio could not connect. Check the database URL, credentials, port or SQLite file permissions.",
        );
      try {
        ready = (await fetch(`${backend}/api/databases/current`, { signal: timeoutSignal(1000) })).ok;
      } catch {
        /* Wait for the managed child to listen. */
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error("db-studio did not start within 20 seconds");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start the studio gateway");
    return {
      id,
      workspaceId: options.workspaceId,
      connectionUrl: options.url,
      provider: options.provider,
      origin,
      port: address.port,
      get alive() {
        return !closed;
      },
      url: `${origin ?? `http://127.0.0.1:${address.port}`}/?token=${token}`,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
