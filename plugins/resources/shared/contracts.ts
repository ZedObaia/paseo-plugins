import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const bytes = z.number().nonnegative();

const processInfo = z.object({
  pid: z.number().int(),
  name: z.string(),
  user: z.string(),
  cpuPct: z.number(),
  memPct: z.number(),
  rssBytes: bytes,
});

const container = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  ports: z.string(),
  project: z.string().nullable(),
  service: z.string().nullable(),
  cpuPct: z.number().nullable(),
  memBytes: bytes.nullable(),
});

const project = z.object({
  name: z.string(),
  workingDir: z.string().nullable(),
  // Its containers were started from a directory that no longer exists (e.g. a deleted worktree).
  stale: z.boolean(),
  volumes: z.number().int(),
});

const usage = z.object({ count: z.number().int(), sizeBytes: bytes, reclaimableBytes: bytes });

const docker = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    version: z.string(),
    images: usage,
    containers: usage,
    volumes: usage,
    buildCache: usage,
    // untagged images; no size: `docker images` sizes count shared layers once per image
    danglingImages: z.number().int(),
    // anonymous volumes no container uses: what `docker volume prune` removes
    danglingVolumes: z.number().int(),
    containerList: z.array(container),
    projects: z.array(project),
  }),
]);

export const snapshotSchema = z.object({
  takenAt: z.number(),
  host: z.object({
    hostname: z.string(),
    platform: z.string(),
    arch: z.string(),
    uptimeSec: z.number(),
    cpuModel: z.string(),
    cpuCount: z.number().int(),
  }),
  // null until the sampler has two readings to compare
  cpuPct: z.number().nullable(),
  load: z.tuple([z.number(), z.number(), z.number()]),
  memory: z.object({ totalBytes: bytes, usedBytes: bytes }),
  swap: z.object({ totalBytes: bytes, usedBytes: bytes }).nullable(),
  disks: z.array(z.object({ mount: z.string(), totalBytes: bytes, usedBytes: bytes })),
  topCpu: z.array(processInfo),
  topMemory: z.array(processInfo),
  docker,
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type ProcessInfo = z.infer<typeof processInfo>;
export type Container = z.infer<typeof container>;
export type DockerProject = z.infer<typeof project>;

export const snapshotRpc = defineRpc({
  name: "resources.snapshot",
  input: z.object({}),
  output: snapshotSchema,
});

// Docker ids, names and compose project names: no shell is involved, but keep them boring anyway.
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

export const pruneTargets = ["containers", "images", "volumes", "build-cache", "networks"] as const;

export const dockerActionRpc = defineRpc({
  name: "resources.docker",
  input: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("container"),
      action: z.enum(["start", "stop", "restart", "remove"]),
      id: ref,
    }),
    // remove = its containers, volumes and networks (the data is gone)
    z.object({ kind: z.literal("project"), action: z.enum(["stop", "remove"]), project: ref }),
    z.object({ kind: z.literal("prune"), target: z.enum(pruneTargets) }),
  ]),
  output: z.object({ message: z.string() }),
});

export const signalProcessRpc = defineRpc({
  name: "resources.process.signal",
  input: z.object({ pid: z.number().int().min(2), signal: z.enum(["SIGTERM", "SIGKILL"]) }),
  output: z.object({ message: z.string() }),
});
