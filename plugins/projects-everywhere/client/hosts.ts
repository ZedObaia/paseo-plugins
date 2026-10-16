import { getPaseoClient } from "@getpaseo/plugin/client";
import { CLONEABLE, type HostProject, type Target } from "./model";

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

const EXIT = /__PROJECTS_EVERYWHERE_EXIT_(\d+)__/;

// Runs as `sh -c SCRIPT sh <url> <folder>`, so neither value is parsed by a shell. Prompts are off,
// so a missing credential fails rather than waiting for input; only https and ssh transports are
// allowed. The terminal stays open once git exits until the plugin has read the result: Paseo
// drops a terminal's output when its command ends.
const SCRIPT = [
  'dest=$2; case $dest in "~/"*) dest=$HOME/${dest#"~/"};; esac',
  'mkdir -p "$(dirname "$dest")" &&',
  '  GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https:ssh GIT_SSH_COMMAND="ssh -o BatchMode=yes" git clone -- "$1" "$dest"',
  'printf "\\n__PROJECTS_EVERYWHERE_EXIT_%s__\\n" "$?"',
  "exec sleep 600",
].join("\n");

/**
 * Clones in a terminal on that host: Paseo offers plugins no other way to run a command there. A
 * terminal belongs to a workspace, so it opens in one the host already has and closes when done.
 */
async function clone(paseo: PaseoApi, url: string, path: string): Promise<void> {
  if (!CLONEABLE.test(url)) throw new Error(`Only https and ssh remotes can be cloned: ${url}`);
  const workspace = (await paseo.workspaces.list()).entries[0];
  if (!workspace)
    throw new Error("Open any project on this host first: the clone runs in one of its terminals");
  const terminal = await paseo.terminals.create({
    workspaceId: workspace.id,
    name: `Cloning ${path.split("/").pop()}`,
    command: "sh",
    args: ["-c", SCRIPT, "sh", url, path],
    size: { rows: 40, cols: 160 },
  });
  try {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      const output = (await terminal.capture({ stripAnsi: true })).lines.join("\n");
      const exit = EXIT.exec(output);
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
