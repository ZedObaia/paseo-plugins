import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const workspace = z.object({
  cwd: z.string(),
  kind: z.string(),
  archivedAt: z.string().nullish(),
});

const project = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.string(),
  archivedAt: z.string().nullish(),
});
export type Project = z.infer<typeof project>;

export const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");
export const registryDir = () => join(paseoHome(), "projects");
export const registryFile = () => join(registryDir(), "workspaces.json");
export const projectsFile = () => join(registryDir(), "projects.json");

/**
 * Active records of one of Paseo's registry files. The plugin reads them itself, because a
 * plugin's daemon session only reaches Paseo from a hook or an RPC, and fetching has to start
 * before any app connects.
 */
async function readActive<T extends { archivedAt?: string | null }>(file: string, schema: z.ZodType<T>) {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    // a host that never had one
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) throw new Error(`${file} isn't a list`);
  return entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success && !parsed.data.archivedAt ? [parsed.data] : [];
  });
}

/** The directories of every active workspace. */
export async function activeWorkspaceDirectories(file = registryFile()): Promise<string[]> {
  return (await readActive(file, workspace)).map((w) => w.cwd);
}

/** The directories of the host's active git workspaces: worktrees and checkouts. */
export async function workspaceDirectories(file = registryFile()): Promise<string[]> {
  return (await readActive(file, workspace)).filter((w) => w.kind !== "directory").map((w) => w.cwd);
}

/** The host's active git projects. */
export async function gitProjects(file = projectsFile()): Promise<Project[]> {
  return (await readActive(file, project)).filter((p) => p.kind === "git");
}
