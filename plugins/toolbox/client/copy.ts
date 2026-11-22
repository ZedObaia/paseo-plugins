import { getPaseoClient } from "@getpaseo/plugin/client";
import { ALREADY_THERE, COPY_EXIT, copyCommand } from "../shared/copy";

type PaseoApi = ReturnType<typeof getPaseoClient>;

/**
 * A workspace to open a terminal in: one the host has open, else one opened on a project it already
 * has. Plugins can't remove a project, so a host without one isn't given a temporary one.
 */
async function anyWorkspace(paseo: PaseoApi): Promise<{ id: string; root: string }> {
  const open = (await paseo.workspaces.list()).entries[0];
  if (open) return { id: open.id, root: open.projectRootPath };
  const project = (await paseo.projects.list()).projects[0];
  if (!project) throw new Error("Add a project on that host first: the copy runs in one of its terminals");
  const opened = await paseo.workspaces.open(project.projectRootPath);
  return { id: opened.id, root: project.projectRootPath };
}

/**
 * Puts a packed skill at `path` in that host's home folder. It runs in a terminal there: Paseo
 * offers plugins no other way to write on another host. "exists": it's there already and `replace`
 * wasn't asked for.
 */
export async function copyToHost(
  serverId: string,
  name: string,
  packed: { path: string; archive: string },
  replace: boolean,
): Promise<"copied" | "exists"> {
  const paseo = getPaseoClient(serverId);
  const workspace = await anyWorkspace(paseo);
  // ponytail: sh only; Windows hosts need a PowerShell form of the copy
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(workspace.root))
    throw new Error("Copying skills to Windows hosts isn't supported yet");
  const terminal = await paseo.terminals.create({
    workspaceId: workspace.id,
    name: `Copying ${name}`,
    ...copyCommand(packed.path, packed.archive, replace),
    size: { rows: 40, cols: 160 },
  });
  try {
    const deadline = Date.now() + 2 * 60_000;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      const output = (await terminal.capture({ stripAnsi: true })).lines.join("\n");
      const exit = COPY_EXIT.exec(output);
      if (!exit) continue;
      if (exit[1] === "0") return "copied";
      if (exit[1] === ALREADY_THERE) return "exists";
      const detail = output
        .slice(0, exit.index)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-2)
        .join(" ");
      throw new Error(detail || `The copy failed (exit ${exit[1]})`);
    }
    throw new Error("The copy took longer than 2 minutes");
  } finally {
    await terminal.kill().catch(() => {});
  }
}
