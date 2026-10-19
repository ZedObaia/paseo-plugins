import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const workspace = z.object({
  cwd: z.string(),
  worktreeRoot: z.string().nullish(),
  kind: z.string(),
  projectId: z.string().nullish(),
  archivedAt: z.string().nullish(),
});

const project = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.string(),
  displayName: z.string().nullish(),
  customName: z.string().nullish(),
  archivedAt: z.string().nullish(),
});
export type Project = z.infer<typeof project>;

export const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");
export const registryDir = () => join(paseoHome(), "projects");
export const registryFile = () => join(registryDir(), "workspaces.json");
export const projectsFile = () => join(registryDir(), "projects.json");

/**
 * The records of one of Paseo's registry files. The plugin reads them itself, because a plugin's
 * daemon session only reaches Paseo from a hook or an RPC, and fetching has to start before any
 * app connects.
 */
async function readRecords<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    // a host that never had one
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) throw new Error(`${file} isn't a list`);
  return entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const readActive = async <T extends { archivedAt?: string | null }>(file: string, schema: z.ZodType<T>) =>
  (await readRecords(file, schema)).filter((record) => !record.archivedAt);

/**
 * Directories a project's worktree import leaves alone: every active workspace's, and those of
 * the project's archived ones, since archiving a worktree's workspace says to keep it out.
 */
export async function takenDirectories(projectId: string, file = registryFile()): Promise<string[]> {
  return (await readRecords(file, workspace))
    .filter((w) => !w.archivedAt || w.projectId === projectId)
    .flatMap((w) => (w.worktreeRoot ? [w.cwd, w.worktreeRoot] : [w.cwd]));
}

/** The directories of the host's active git workspaces: worktrees and checkouts. */
export async function workspaceDirectories(file = registryFile()): Promise<string[]> {
  return (await readActive(file, workspace)).filter((w) => w.kind !== "directory").map((w) => w.cwd);
}

/** The host's active git projects. */
export async function gitProjects(file = projectsFile()): Promise<Project[]> {
  return (await readActive(file, project)).filter((p) => p.kind === "git");
}
