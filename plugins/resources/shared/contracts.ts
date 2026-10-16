import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The background sampler's period and how many samples the charts keep (10 minutes). */
export const SAMPLE_SECONDS = 5;
export const HISTORY_SAMPLES = 120;

const bytes = z.number().nonnegative();

const processInfo = z.object({
  pid: z.number().int(),
  name: z.string(),
  user: z.string(),
  cpuPct: z.number(),
  // macOS: footprint including compressed memory, as in Activity Monitor; Linux: resident memory
  memBytes: bytes,
});

// processes grouped by app: "Google Chrome" for all its helpers, "tsserver" for every tsserver
const app = z.object({ name: z.string(), count: z.number().int(), memBytes: bytes });

// one sample per SAMPLE_SECONDS, oldest first; each value is a used fraction 0..1
const sample = z.object({ cpu: z.number(), mem: z.number(), swap: z.number() });

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
  // every container was started from a directory that no longer exists, e.g. a deleted worktree
  stale: z.boolean(),
  volumes: z.number().int(),
});

// `docker system df`: reclaimable = not used by any container
const usage = z.object({ sizeBytes: bytes, reclaimableBytes: bytes });

const docker = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    version: z.string(),
    images: usage,
    containers: usage,
    volumes: usage,
    buildCache: usage,
    // untagged images; no size, since `docker images` counts shared layers once per image
    danglingImages: z.number().int(),
    // unnamed volumes no container uses
    anonymousVolumes: z.number().int(),
    containerList: z.array(container),
    projects: z.array(project),
  }),
]);

const snapshotSchema = z.object({
  // when the host numbers were collected; they're served from a cache refreshed in the background
  takenAt: z.number(),
  host: z.object({
    hostname: z.string(),
    platform: z.string(),
    arch: z.string(),
    uptimeSec: z.number(),
    cpuCount: z.number().int(),
  }),
  // null until the sampler has two readings to compare
  cpuPct: z.number().nullable(),
  // Linux only: CPU time the hypervisor gave to other guests (a noisy neighbour on a VPS)
  stealPct: z.number().nullable(),
  load: z.tuple([z.number(), z.number(), z.number()]),
  memory: z.object({ totalBytes: bytes, usedBytes: bytes }),
  swap: z.object({ totalBytes: bytes, usedBytes: bytes }).nullable(),
  disks: z.array(z.object({ mount: z.string(), totalBytes: bytes, usedBytes: bytes, freeBytes: bytes })),
  topCpu: z.array(processInfo),
  topMemory: z.array(processInfo),
  apps: z.array(app),
  history: z.array(sample),
  docker,
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type ProcessInfo = z.infer<typeof processInfo>;
export type App = z.infer<typeof app>;
export type Sample = z.infer<typeof sample>;
export type Container = z.infer<typeof container>;
export type DockerProject = z.infer<typeof project>;

/** CPU and memory only, from the background sampler: cheap enough for the sidebar to poll. */
export const summaryRpc = defineRpc({
  name: "resources.summary",
  input: z.object({}),
  output: z.object({ cpuPct: z.number().nullable(), memUsedBytes: bytes, memTotalBytes: bytes }),
});

export const snapshotRpc = defineRpc({
  name: "resources.snapshot",
  input: z.object({}),
  output: snapshotSchema,
});

// Container names and Compose project names go to the docker CLI as arguments. The leading
// character can't be "-", so a name can never be read as an option.
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

const pruneTargets = ["containers", "images", "volumes", "build-cache", "networks"] as const;
export type PruneTarget = (typeof pruneTargets)[number];

export const dockerActionRpc = defineRpc({
  name: "resources.docker",
  input: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("containers"),
      action: z.enum(["start", "stop", "restart", "remove"]),
      names: z.array(ref).min(1).max(500),
    }),
    // remove = its containers, volumes (the data) and networks
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
