import { existsSync } from "node:fs";
import type { RpcInput } from "@getpaseo/plugin";
import type { Container, DockerProject, Snapshot, dockerActionRpc } from "../shared/contracts";
import { jsonLines, parseSize, run } from "./exec";

const PROJECT = "com.docker.compose.project";
const SERVICE = "com.docker.compose.service";
const WORKING_DIR = "com.docker.compose.project.working_dir";

// The daemon's PATH may miss Docker Desktop's CLI; the first one that exists wins.
const DOCKER =
  [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    "/usr/bin/docker",
  ].find((candidate) => existsSync(candidate)) ?? "docker";

const docker = (args: string[], timeoutMs?: number) => run(DOCKER, args, timeoutMs);
const lines = (text: string) => text.split("\n").filter(Boolean);

type DfRow = { Type: string; Size: string; Reclaimable: string };
type PsRow = {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  Project: string;
  Service: string;
  WorkingDir: string;
};
type StatsRow = { ID: string; CPUPerc: string; MemUsage: string };

// Label values can contain commas (Compose's depends_on does), so ask Docker for just the labels
// needed, each JSON-encoded, rather than splitting the combined .Labels string.
const label = (key: string) => `{{json (.Label "${key}")}}`;
const PS_FORMAT = `{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}},"Ports":{{json .Ports}},"Project":${label(PROJECT)},"Service":${label(SERVICE)},"WorkingDir":${label(WORKING_DIR)}}`;
const VOLUME_PROJECT_FORMAT = label(PROJECT);

/** Unused unnamed volumes: what "Delete unused anonymous volumes" removes, and nothing else. */
async function anonymousVolumes(): Promise<string[]> {
  return lines(await docker(["volume", "ls", "-q", "-f", "dangling=true"])).filter((name) =>
    /^[0-9a-f]{64}$/.test(name),
  );
}

export async function dockerSnapshot(): Promise<Snapshot["docker"]> {
  try {
    return await collect();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: /ENOENT/.test(reason) ? "Docker isn't installed" : `Docker didn't answer: ${reason}`,
    };
  }
}

async function collect(): Promise<Snapshot["docker"]> {
  const version = (await docker(["version", "--format", "{{.Server.Version}}"], 5_000)).trim();
  const [dfText, psText, danglingImages, anonymous, volumeProjects] = await Promise.all([
    docker(["system", "df", "--format", "{{json .}}"], 30_000),
    docker(["ps", "-a", "--format", PS_FORMAT]),
    docker(["images", "-q", "-f", "dangling=true"]).then(lines),
    anonymousVolumes(),
    docker(["volume", "ls", "--format", VOLUME_PROJECT_FORMAT]).then((text) =>
      lines(text).map((l) => JSON.parse(l) as string),
    ),
  ]);
  const rows = jsonLines<PsRow>(psText);
  const stats = rows.some((row) => row.State === "running")
    ? jsonLines<StatsRow>(
        await docker(["stats", "--no-stream", "--format", "{{json .}}"], 15_000).catch(() => ""),
      )
    : [];
  const statsById = new Map(stats.map((row) => [row.ID.slice(0, 12), row]));

  const df = new Map(jsonLines<DfRow>(dfText).map((row) => [row.Type, row]));
  const usage = (type: string) => ({
    sizeBytes: parseSize(df.get(type)?.Size),
    reclaimableBytes: parseSize(df.get(type)?.Reclaimable),
  });

  const projects = new Map<string, DockerProject>();
  const projectOf = (name: string) => {
    let entry = projects.get(name);
    if (!entry) projects.set(name, (entry = { name, workingDir: null, stale: false, volumes: 0 }));
    return entry;
  };

  // Projects with at least one container started from a directory that still exists. A project
  // is stale only when none was: one container left over from a deleted worktree doesn't count.
  const live = new Set<string>();
  const containerList: Container[] = rows.map((row) => {
    const project = row.Project || null; // a missing label comes back as ""
    if (project) {
      const entry = projectOf(project);
      const dir = row.WorkingDir || null;
      if (dir && existsSync(dir)) {
        live.add(project);
        entry.workingDir = dir;
      } else entry.workingDir ??= dir;
    }
    const s = statsById.get(row.ID.slice(0, 12));
    // `docker stats` prints "--" for a container it couldn't read, such as one that just stopped
    const cpuPct = s ? Number.parseFloat(s.CPUPerc) : Number.NaN;
    const memory = s?.MemUsage.split("/")[0].trim() ?? "";
    return {
      id: row.ID,
      name: row.Names,
      image: row.Image,
      state: row.State,
      status: row.Status,
      ports: row.Ports,
      project,
      service: row.Service || null,
      cpuPct: Number.isFinite(cpuPct) ? cpuPct : null,
      memBytes: /^\d/.test(memory) ? parseSize(memory) : null,
    };
  });
  // Volumes carry no working_dir, so a project with only volumes left (after `compose down`) is
  // never stale: that is also how a stopped dev database looks.
  for (const name of volumeProjects) if (name) projectOf(name).volumes += 1;
  for (const entry of projects.values()) entry.stale = entry.workingDir !== null && !live.has(entry.name);

  return {
    available: true,
    version,
    images: usage("Images"),
    containers: usage("Containers"),
    volumes: usage("Local Volumes"),
    buildCache: usage("Build Cache"),
    danglingImages: danglingImages.length,
    anonymousVolumes: anonymous.length,
    containerList,
    projects: [...projects.values()].sort(
      (a, b) => Number(b.stale) - Number(a.stale) || a.name.localeCompare(b.name),
    ),
  };
}

const DONE = { start: "Started", stop: "Stopped", restart: "Restarted", remove: "Deleted" } as const;

/** "Total reclaimed space: 1.2GB" (docker) or "Total:\t1.2GB" (buildx, behind `docker builder prune`). */
export const reclaimed = (output: string) => /Total(?: reclaimed space)?:\s*(\S+)/.exec(output)?.[1] ?? "0B";

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const projectObjects = async (kind: "ps" | "volume" | "network", project: string) =>
  lines(
    await docker([
      ...(kind === "ps" ? ["ps", "-a"] : [kind, "ls"]),
      "-q",
      "--filter",
      `label=${PROJECT}=${project}`,
    ]),
  );

export async function dockerAction(input: RpcInput<typeof dockerActionRpc>): Promise<{ message: string }> {
  switch (input.kind) {
    case "containers": {
      // one call for all of them: docker stops (and removes) them in parallel
      await docker(
        input.action === "remove" ? ["rm", "-f", ...input.names] : [input.action, ...input.names],
        55_000,
      );
      const what = input.names.length === 1 ? input.names[0] : count(input.names.length, "container");
      return { message: `${DONE[input.action]} ${what}` };
    }
    case "project": {
      if (input.action === "stop") {
        const running = lines(await docker(["ps", "-q", "--filter", `label=${PROJECT}=${input.project}`]));
        if (running.length) await docker(["stop", ...running], 55_000);
        return { message: `Stopped ${count(running.length, "container")} of ${input.project}` };
      }
      const containers = await projectObjects("ps", input.project);
      if (containers.length) await docker(["rm", "-f", ...containers], 55_000);
      const volumes = await projectObjects("volume", input.project);
      if (volumes.length) await docker(["volume", "rm", ...volumes]);
      const networks = await projectObjects("network", input.project);
      if (networks.length) await docker(["network", "rm", ...networks]);
      return {
        message: `Deleted ${input.project}: ${count(containers.length, "container")}, ${count(volumes.length, "volume")}, ${count(networks.length, "network")}`,
      };
    }
    case "prune": {
      if (input.target === "volumes") {
        // not `volume prune`: before Docker 23 (and on Podman) it also deletes unused named volumes
        const names = await anonymousVolumes();
        if (names.length) await docker(["volume", "rm", ...names]);
        return { message: `Deleted ${count(names.length, "volume")}` };
      }
      if (input.target === "networks") {
        await docker(["network", "prune", "-f"]);
        return { message: "Deleted unused networks" };
      }
      const command = { containers: "container", images: "image", "build-cache": "builder" }[input.target];
      return { message: `Freed ${reclaimed(await docker([command, "prune", "-f"], 300_000))}` };
    }
  }
}
