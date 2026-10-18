import { getPaseoClient } from "@getpaseo/plugin/client";
import { CLONE_EXIT, CLONEABLE, cloneCommand, isWindowsPath, type HostProject, type Target } from "./model";

/** An RPC error without the transport details Paseo appends. */
export const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/ requestType=.*$/, "")
    .replace(/^Request failed: /, "");

export async function listProjects(serverId: string): Promise<HostProject[]> {
  const { projects } = await getPaseoClient(serverId).projects.list();
  return projects.map((p) => ({
    serverId,
    projectId: p.projectId,
    key: p.projectKey,
    name: p.projectDisplayName,
    root: p.projectRootPath,
  }));
}

/**
 * Adds the folder as a project on the host, as Paseo's own Add project does (~ is the host's home).
 * A missing folder is cloned first when the target has a remote.
 */
export async function addProject(
  serverId: string,
  target: Target,
  onProgress: (text: string) => void,
): Promise<"added" | "cloned"> {
  const paseo = getPaseoClient(serverId);
  try {
    await paseo.workspaces.open(target.path);
    return "added";
  } catch (error) {
    if (!target.cloneUrl || !/Directory not found/i.test(message(error))) throw error;
  }
  onProgress("Cloning…");
  await clone(paseo, target.cloneUrl, target.path);
  await paseo.workspaces.open(target.path);
  return "cloned";
}

type PaseoApi = ReturnType<typeof getPaseoClient>;

/**
 * A workspace to open a terminal in: one the host has open, else one opened on a project it already
 * has (Paseo's own clone adds a project without opening it). Plugins can't remove a project, so a
 * host without one isn't given a temporary one.
 */
async function anyWorkspace(paseo: PaseoApi): Promise<{ id: string; root: string }> {
  const open = (await paseo.workspaces.list()).entries[0];
  if (open) return { id: open.id, root: open.projectRootPath };
  const project = (await paseo.projects.list()).projects[0];
  if (!project)
    throw new Error(
      "No projects here yet. Add one with Paseo's Add project first: the clone runs in one of its terminals",
    );
  const opened = await paseo.workspaces.open(project.projectRootPath);
  return { id: opened.id, root: project.projectRootPath };
}

/**
 * Clones in a terminal on that host: Paseo offers plugins no other way to run a command there. A
 * terminal belongs to a workspace, so it opens in one of the host's projects and closes when done.
 */
async function clone(paseo: PaseoApi, url: string, path: string): Promise<void> {
  if (!CLONEABLE.test(url)) throw new Error(`Only https and ssh remotes can be cloned: ${url}`);
  const workspace = await anyWorkspace(paseo);
  const terminal = await paseo.terminals.create({
    workspaceId: workspace.id,
    name: `Cloning ${path.split("/").pop()}`,
    ...cloneCommand(isWindowsPath(workspace.root), url, path),
    size: { rows: 40, cols: 160 },
  });
  try {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      const output = (await terminal.capture({ stripAnsi: true })).lines.join("\n");
      const exit = CLONE_EXIT.exec(output);
      if (!exit) continue;
      if (exit[1] === "0") return;
      const detail = output
        .slice(0, exit.index)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-2)
        .join(" ");
      throw new Error(detail || `git clone failed (exit ${exit[1]})`);
    }
    throw new Error("The clone took longer than 10 minutes");
  } finally {
    await terminal.kill().catch(() => {});
  }
}
