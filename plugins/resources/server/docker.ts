import { existsSync } from "node:fs";
import type { RpcInput } from "@getpaseo/plugin";
import type { Container, DockerProject, Snapshot, dockerActionRpc } from "../shared/contracts";
import { jsonLines, labels, parseSize, run } from "./exec";

const PROJECT = "com.docker.compose.project";

// The daemon's PATH may miss Docker Desktop's CLI; the first one that exists wins.
const DOCKER =
  ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker", "/usr/bin/docker"].find(
    (candidate) => existsSync(candidate),
  ) ?? "docker";

const docker = (args: string[], timeoutMs?: number) => run(DOCKER, args, timeoutMs);

type DfRow = { Type: string; TotalCount: string; Size: string; Reclaimable: string };
type PsRow = { ID: string; Names: string; Image: string; State: string; Status: string; Ports: string; Labels: string };
type StatsRow = { ID: string; CPUPerc: string; MemUsage: string };
type VolumeRow = { Name: string; Labels: string };

export async function dockerSnapshot(): Promise<Snapshot["docker"]> {
  let version: string;
  try {
    version = (await docker(["version", "--format", "{{.Server.Version}}"], 5_000)).trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, reason: /ENOENT/.test(reason) ? "Docker isn't installed" : reason };
  }

  const [dfText, psText, imagesText, danglingVolumesText, volumesText] = await Promise.all([
    docker(["system", "df", "--format", "{{json .}}"]),
    docker(["ps", "-a", "--format", "{{json .}}"]),
    docker(["images", "-f", "dangling=true", "--format", "{{.Size}}"]),
    docker(["volume", "ls", "-q", "-f", "dangling=true"]),
    docker(["volume", "ls", "--format", "{{json .}}"]),
  ]);
  const rows = jsonLines<PsRow>(psText);
  const stats = rows.some((row) => row.State === "running")
    ? jsonLines<StatsRow>(await docker(["stats", "--no-stream", "--format", "{{json .}}"], 15_000).catch(() => ""))
    : [];
  const statsById = new Map(stats.map((row) => [row.ID.slice(0, 12), row]));

  const df = new Map(jsonLines<DfRow>(dfText).map((row) => [row.Type, row]));
  const usage = (type: string) => {
    const row = df.get(type);
    return {
      count: Number(row?.TotalCount ?? 0),
      sizeBytes: parseSize(row?.Size),
      reclaimableBytes: parseSize(row?.Reclaimable),
    };
  };

  const projects = new Map<string, DockerProject>();
  const projectOf = (name: string) => {
    let entry = projects.get(name);
    if (!entry) projects.set(name, (entry = { name, workingDir: null, stale: false, volumes: 0 }));
    return entry;
  };

  // Projects with at least one container started from a directory that still exists. A project
  // is stale only when none was: one container left from a deleted worktree doesn't count.
  const live = new Set<string>();
  const containerList: Container[] = rows.map((row) => {
    const l = labels(row.Labels);
    const project = l[PROJECT] ?? null;
    if (project) {
      const entry = projectOf(project);
      const dir = l[`${PROJECT}.working_dir`] ?? null;
      if (dir && existsSync(dir)) {
        live.add(project);
        entry.workingDir = dir;
      } else entry.workingDir ??= dir;
    }
    const s = statsById.get(row.ID.slice(0, 12));
    return {
      id: row.ID,
      name: row.Names,
      image: row.Image,
      state: row.State,
      status: row.Status,
      ports: row.Ports,
      project,
      service: l[`${PROJECT}.service`] ?? null,
      cpuPct: s ? Number.parseFloat(s.CPUPerc) : null,
      memBytes: s ? parseSize(s.MemUsage.split("/")[0]) : null,
    };
  });
  // Volumes carry no working_dir, so a project with only volumes left (e.g. after `compose down`)
  // is never called stale: that is also how a stopped dev database looks.
  for (const volume of jsonLines<VolumeRow>(volumesText)) {
    const project = labels(volume.Labels)[PROJECT];
    if (project) projectOf(project).volumes += 1;
  }
  for (const entry of projects.values()) entry.stale = entry.workingDir !== null && !live.has(entry.name);

  const danglingSizes = imagesText.split("\n").filter(Boolean);
  return {
    available: true,
    version,
    images: usage("Images"),
    containers: usage("Containers"),
    volumes: usage("Local Volumes"),
    buildCache: usage("Build Cache"),
    danglingImages: { count: danglingSizes.length, sizeBytes: danglingSizes.reduce((sum, s) => sum + parseSize(s), 0) },
    // `volume prune` removes only anonymous volumes (64-hex names); unused named ones belong to
    // stopped compose stacks and show under their project instead.
    danglingVolumes: danglingVolumesText.split("\n").filter((name) => /^[0-9a-f]{64}$/.test(name)).length,
    containerList,
    projects: [...projects.values()].sort((a, b) => Number(b.stale) - Number(a.stale) || a.name.localeCompare(b.name)),
  };
}

const ids = async (kind: "ps" | "volume" | "network", project: string, all = true) => {
  const filter = ["--filter", `label=${PROJECT}=${project}`];
  const args = kind === "ps" ? ["ps", ...(all ? ["-a"] : []), "-q", ...filter] : [kind, "ls", "-q", ...filter];
  return (await docker(args)).split("\n").filter(Boolean);
};

const DONE = { start: "Started", stop: "Stopped", restart: "Restarted", remove: "Removed" } as const;

const reclaimed = (output: string) => /Total reclaimed space:\s*(.+)/.exec(output)?.[1]?.trim() ?? "0B";

export async function dockerAction(input: RpcInput<typeof dockerActionRpc>): Promise<{ message: string }> {
  switch (input.kind) {
    case "container":
      await docker(input.action === "remove" ? ["rm", "-f", input.id] : [input.action, input.id], 60_000);
      return { message: `${DONE[input.action]} ${input.id.slice(0, 12)}` };
    case "project": {
      // One call per object: Docker Desktop has answered batch removals with 404s.
      const containers = await ids("ps", input.project, input.action === "remove");
      for (const id of containers) await docker(input.action === "remove" ? ["rm", "-f", id] : ["stop", id], 60_000);
      if (input.action === "stop") return { message: `Stopped ${containers.length} containers of ${input.project}` };
      const volumes = await ids("volume", input.project);
      for (const id of volumes) await docker(["volume", "rm", id]);
      const networks = await ids("network", input.project);
      for (const id of networks) await docker(["network", "rm", id]);
      return {
        message: `Removed ${input.project}: ${containers.length} containers, ${volumes.length} volumes, ${networks.length} networks`,
      };
    }
    case "prune": {
      const command = {
        containers: ["container", "prune", "-f"],
        images: ["image", "prune", "-f"],
        volumes: ["volume", "prune", "-f"],
        "build-cache": ["builder", "prune", "-f"],
        networks: ["network", "prune", "-f"],
      }[input.target];
      const output = await docker(command, 300_000);
      return { message: input.target === "networks" ? "Removed unused networks" : `Freed ${reclaimed(output)}` };
    }
  }
}
