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
const PS_FORMAT = `{"Names":{{json .Names}},"Image":{{json .Image}},"Ports":{{json .Ports}},"Service":${label("com.docker.compose.service")},"WorkingDir":${label("com.docker.compose.project.working_dir")}}`;

type PsRow = { Names: string; Image: string; Ports: string; Service: string; WorkingDir: string };

/**
 * Published TCP ports from `docker ps`'s Ports column, e.g.
 * "0.0.0.0:5434->5432/tcp, [::]:5434->5432/tcp, 127.0.0.1:8000-8001->8000-8001/tcp, 6379/tcp".
 * Unpublished ports ("6379/tcp") have no host side and are left out.
 */
export function parsePorts(text: string): { address: string; port: number }[] {
  const ports: { address: string; port: number }[] = [];
  for (const entry of text.split(", ")) {
    const match = /^(.*):(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp$/.exec(entry.trim());
    if (!match) continue;
    const first = Number(match[2]);
    const last = Math.min(Number(match[3] ?? first), first + 31);
    for (let port = first; port <= last; port++) ports.push({ address: canonicalAddress(match[1]), port });
  }
  return ports;
}

/** A container's published ports, each at its widest bind, tied to its Compose project's directory. */
export function containerListeners(row: PsRow): Listener[] {
  const widest = new Map<number, string>();
  for (const { address, port } of parsePorts(row.Ports)) {
    const kept = widest.get(port);
    if (kept === undefined || reach(address) > reach(kept)) widest.set(port, address);
  }
  return [...widest].map(([port, address]) => ({
    port,
    address,
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
    return text
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => containerListeners(JSON.parse(line) as PsRow));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // without Docker there is nothing to say; a broken one is worth one line in the logs
    if (!/ENOENT/.test(reason) && !reported) console.error("docker ps failed:", reason);
    reported = true;
    return [];
  }
}
