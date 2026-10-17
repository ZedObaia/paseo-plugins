import { existsSync } from "node:fs";
import { canonicalAddress, reach } from "./address";
import { run } from "./exec";
import type { Listener } from "./processes";

// The daemon's PATH may miss Docker Desktop's CLI; the first one that exists wins.
const DOCKER =
  [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    "/usr/bin/docker",
  ].find((candidate) => existsSync(candidate)) ?? "docker";

// Label values can contain commas, so ask for the labels needed, each JSON-encoded.
const label = (key: string) => `{{json (.Label "${key}")}}`;
const PS_FORMAT = `{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"Ports":{{json .Ports}},"Service":${label("com.docker.compose.service")},"WorkingDir":${label("com.docker.compose.project.working_dir")}}`;

type PsRow = {
  ID?: string;
  Names: string;
  Image: string;
  Ports: string;
  Service: string;
  WorkingDir: string;
};

/**
 * Published TCP ports from `docker ps`'s Ports column, e.g.
 * "0.0.0.0:5434->5432/tcp, [::]:5434->5432/tcp, 127.0.0.1:8000-8001->8000-8001/tcp, 6379/tcp".
 * Unpublished ports ("6379/tcp") have no host side and are left out.
 */
export function parsePorts(text: string): { address: string; port: number; containerPort: number }[] {
  const ports: { address: string; port: number; containerPort: number }[] = [];
  for (const entry of text.split(", ")) {
    const match = /^(.*):(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/tcp$/.exec(entry.trim());
    if (!match) continue;
    const first = Number(match[2]);
    const last = Math.min(Number(match[3] ?? first), first + 31);
    for (let port = first; port <= last; port++)
      ports.push({
        address: canonicalAddress(match[1]),
        port,
        containerPort: Number(match[4]) + port - first,
      });
  }
  return ports;
}

/**
 * When each container last started, by short ID, from `docker inspect --format '{{.Id}}
 * {{.State.StartedAt}}'`. A restarted container keeps its ID but not its start time.
 */
export function parseStartTimes(text: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [id, startedAt] = line.trim().split(" ");
    if (id && startedAt) times.set(id.slice(0, 12), startedAt);
  }
  return times;
}

/**
 * A container's published ports, each at its widest bind, tied to its Compose project's directory.
 * Its instance is its ID and start time: a new container, or a restart of this one, is a new one.
 */
export function containerListeners(row: PsRow, startedAt?: string): Listener[] {
  const widest = new Map<number, { address: string; containerPort: number }>();
  for (const { address, port, containerPort } of parsePorts(row.Ports)) {
    const kept = widest.get(port);
    if (kept === undefined || reach(address) > reach(kept.address))
      widest.set(port, { address, containerPort });
  }
  return [...widest].map(([port, { address, containerPort }]) => ({
    identity: row.Names,
    instance: startedAt ? `${row.ID}@${startedAt}` : row.ID,
    port,
    address,
    containerPort,
    name: row.Service || row.Names,
    detail: row.Image,
    pid: null,
    source: "docker" as const,
    cwd: row.WorkingDir || null,
    workspaceId: null,
    dirs: [],
  }));
}

let reported = false;

/** Ports of running containers; none when Docker is missing or not answering. */
export async function dockerListeners(): Promise<Listener[]> {
  try {
    const text = await run(DOCKER, ["ps", "--format", PS_FORMAT], 5_000);
    reported = false;
    const rows = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PsRow)
      .filter((row) => row.Ports.includes("->"));
    const ids = rows.flatMap((row) => (row.ID ? [row.ID] : []));
    // without start times a restart only shows once its answer expires
    const started = ids.length
      ? parseStartTimes(
          await run(DOCKER, ["inspect", "--format", "{{.Id}} {{.State.StartedAt}}", ...ids], 5_000).catch(
            () => "",
          ),
        )
      : new Map<string, string>();
    return rows.flatMap((row) =>
      containerListeners(row, row.ID ? started.get(row.ID.slice(0, 12)) : undefined),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // without Docker there is nothing to say; a broken one is worth one line in the logs
    if (!/ENOENT/.test(reason) && !reported) console.error("docker ps failed:", reason);
    reported = true;
    return [];
  }
}
