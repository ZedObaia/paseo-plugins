import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import { parse } from "dotenv";
import type { Connection } from "../shared/contracts";

const exec = promisify(execFile);
export type Candidate = Connection & { url: string };
export const connectionId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export const databaseType = (url: string): "pg" | "sqlite" => (url.startsWith("sqlite://") ? "sqlite" : "pg");

export async function sqliteFile(file: string, directory: string): Promise<string> {
  const value = file.trim().replace(/^sqlite:\/\//, "");
  const expanded = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
  const absolute = path.resolve(directory, expanded.startsWith("file:") ? fileURLToPath(expanded) : expanded);
  let handle;
  try {
    handle = await open(absolute, "r");
    if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    if (!header.equals(Buffer.from("SQLite format 3\0"))) throw new Error("Not a SQLite database");
    return `sqlite://${await realpath(absolute)}`;
  } catch (error) {
    throw new Error(`Cannot open SQLite file: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle?.close();
  }
}

export function postgresUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Use a PostgreSQL connection URL");
  if (!url.hostname || !url.pathname.slice(1))
    throw new Error("The connection needs a host and database name");
  return url;
}

export function endpoint(value: string): string {
  if (databaseType(value) === "sqlite") return value.slice("sqlite://".length);
  const url = postgresUrl(value);
  const socket = url.searchParams.get("host");
  if (socket?.startsWith("/"))
    return `${socket}/.s.PGSQL.${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
  return `${url.hostname}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
}

function candidate(
  url: string,
  source: Connection["source"],
  scope: Connection["scope"],
  detail: string,
  name?: string,
): Candidate {
  const parsed = postgresUrl(url);
  return {
    id: connectionId(`${source}:${parsed.href}`),
    url: parsed.href,
    source,
    scope,
    detail,
    name: name ?? decodeURIComponent(parsed.pathname.slice(1)),
    type: "pg",
    endpoint: endpoint(url),
    needsCredentials: !parsed.username,
  };
}

export type DockerContainer = {
  Id: string;
  Name: string;
  Config: { Image: string; Env?: string[]; Labels?: Record<string, string> };
  State: { Running: boolean };
  NetworkSettings: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
  Mounts?: { Source?: string }[];
};

export function dockerConnections(containers: DockerContainer[], directory: string): Candidate[] {
  const result: Candidate[] = [];
  for (const container of containers) {
    if (!container.State.Running) continue;
    const env = Object.fromEntries(
      (container.Config.Env ?? [])
        .filter((entry) => entry.includes("="))
        .map((entry) => {
          const i = entry.indexOf("=");
          return [entry.slice(0, i), entry.slice(i + 1)];
        }),
    );
    const ports = container.NetworkSettings.Ports ?? {};
    if (
      !/(?:postgres|postgis|pgvector|timescale)/i.test(container.Config.Image) &&
      !env.POSTGRES_DB &&
      !("5432/tcp" in ports)
    )
      continue;
    const binding = ports[`${env.PGPORT || "5432"}/tcp`]?.find((p) => p.HostIp !== "::");
    if (!binding) continue;
    const host = ["0.0.0.0", "::", ""].includes(binding.HostIp) ? "127.0.0.1" : binding.HostIp;
    const url = new URL(`postgresql://${host.includes(":") ? `[${host}]` : host}:${binding.HostPort}/`);
    url.username = env.POSTGRES_USER || "postgres";
    url.password = env.POSTGRES_PASSWORD || "";
    url.pathname = `/${env.POSTGRES_DB || env.POSTGRES_USER || "postgres"}`;
    const labels = container.Config.Labels ?? {};
    const workingDir = labels["com.docker.compose.project.working_dir"];
    const belongs =
      (workingDir && path.resolve(workingDir) === path.resolve(directory)) ||
      container.Mounts?.some((m) => m.Source && path.resolve(m.Source) === path.resolve(directory));
    const entry = candidate(
      url.href,
      "docker",
      belongs ? "workspace" : "host",
      `${container.Config.Image} · ${labels["com.docker.compose.service"] || "container"}`,
      container.Name.replace(/^\//, ""),
    );
    entry.id = connectionId(`docker:${container.Id}`);
    entry.needsCredentials = !env.POSTGRES_PASSWORD && env.POSTGRES_HOST_AUTH_METHOD !== "trust";
    result.push(entry);
  }
  return result;
}

export async function environmentConnections(directory: string): Promise<Candidate[]> {
  const result: Candidate[] = [];
  // Only this worktree: a parent repository's .env can point at another branch's database.
  for (const file of [".env.local", ".env.development.local", ".env.development", ".env"]) {
    let values: Record<string, string>;
    try {
      values = parse(await readFile(path.join(directory, file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const [key, value] of Object.entries(values)) {
      if (!/(?:DATABASE_URL|POSTGRES_URL|PG_URL)$/.test(key) || !/^postgres(?:ql)?:\/\//.test(value))
        continue;
      try {
        result.push(candidate(value, "environment", "workspace", `${file} · ${key}`));
      } catch {
        /* Incomplete templates are not connections. */
      }
    }
    if (values.PGHOST && values.PGDATABASE) {
      const url = new URL("postgresql://localhost/");
      if (values.PGHOST.startsWith("/")) url.searchParams.set("host", values.PGHOST);
      else url.hostname = values.PGHOST;
      url.port = values.PGPORT || "5432";
      url.pathname = `/${values.PGDATABASE}`;
      url.username = values.PGUSER || "";
      url.password = values.PGPASSWORD || "";
      result.push(candidate(url.href, "environment", "workspace", `${file} · PGHOST`));
    }
  }
  return result.filter((c, i) => result.findIndex((other) => other.url === c.url) === i);
}

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => {
      const probe = Buffer.alloc(8);
      probe.writeInt32BE(8);
      probe.writeInt32BE(80877103, 4);
      socket.write(probe);
    });
    socket.once("data", (data) => finish(data[0] === 83 || data[0] === 78));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

export type HostInventory = {
  containers: DockerContainer[];
  connections: Candidate[];
  notices: string[];
};

export async function inspectHost(): Promise<HostInventory> {
  const notices: string[] = [];
  const connections: Candidate[] = [];
  let containers: DockerContainer[] = [];
  const docker =
    [
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    ].find(existsSync) ?? "docker";
  try {
    const { stdout } = await exec(docker, ["ps", "-q"], { timeout: 5000 });
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) {
      const { stdout: inspected } = await exec(docker, ["inspect", ...ids], {
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      });
      containers = JSON.parse(inspected) as DockerContainer[];
      const unpublished = containers.filter(
        (c) =>
          c.State.Running &&
          /(?:postgres|postgis|pgvector|timescale)/i.test(c.Config.Image) &&
          !Object.values(c.NetworkSettings.Ports ?? {}).some((p) => p?.length),
      );
      if (unpublished.length)
        notices.push(
          `${unpublished.length} PostgreSQL container(s) have no published port. Publish a loopback port to connect from Paseo.`,
        );
    }
  } catch {
    notices.push("Docker is unavailable; project connections and host discovery still work.");
  }

  const ports = new Set([5432]);
  try {
    const { stdout } = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    let postgres = false;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("c")) postgres = /postgres/i.test(line.slice(1));
      if (postgres && line.startsWith("n")) {
        const port = /:(\d+)$/.exec(line)?.[1];
        if (port) ports.add(Number(port));
      }
    }
  } catch {
    /* A bounded standard-port probe also works without lsof. */
  }
  for (const port of ports) {
    if (!(await listening(port))) continue;
    const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
    url.username = userInfo().username;
    const entry = candidate(
      url.href,
      "host",
      "host",
      "Local listener · credentials may be required",
      `PostgreSQL on host :${port}`,
    );
    entry.needsCredentials = true;
    connections.push(entry);
  }
  for (const directory of ["/tmp", "/var/run/postgresql"]) {
    let sockets: string[];
    try {
      sockets = await readdir(directory);
    } catch {
      continue;
    }
    for (const socket of sockets) {
      const port = /^\.s\.PGSQL\.(\d+)$/.exec(socket)?.[1];
      if (!port) continue;
      const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
      url.username = userInfo().username;
      url.searchParams.set("host", directory);
      const entry = candidate(
        url.href,
        "host",
        "host",
        "Local Unix socket · credentials may be required",
        `PostgreSQL socket :${port}`,
      );
      entry.needsCredentials = true;
      connections.push(entry);
    }
  }
  return { containers, connections, notices };
}

export async function discover(directory: string, saved: Candidate[] = [], host?: HostInventory) {
  const inventory = host ?? (await inspectHost());
  const connections = [
    ...(await environmentConnections(directory)),
    ...dockerConnections(inventory.containers, directory),
  ];
  connections.push(
    ...inventory.connections
      .filter((local) => !connections.some((connection) => connection.endpoint === local.endpoint))
      .map((connection) => ({ ...connection })),
  );
  for (const savedConnection of saved) {
    const found = connections.find((connection) => connection.url === savedConnection.url);
    if (!found) connections.push(savedConnection);
    else if (found.scope === "host") {
      found.scope = "workspace";
      found.detail += " · Added to this workspace";
    }
  }
  connections.sort(
    (a, b) =>
      Number(b.scope === "workspace") - Number(a.scope === "workspace") || a.name.localeCompare(b.name),
  );
  return {
    connections: connections.filter(
      (connection, index) => connections.findIndex((other) => other.url === connection.url) === index,
    ),
    notices: inventory.notices,
  };
}
