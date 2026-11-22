import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { QuickCommand } from "../shared/contracts";
import { dotenvFor, workspaceEnv } from "./env";
import { launch, shellKind, waitForPrompt } from "./shell";

type Paseo = PluginHandlerContext["paseo"];

// the shell deletes the run's files as it starts: this is for one that never does
const TEMP_LIFETIME_MS = 60_000;

const isFolder = (path: string) =>
  stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );

/** Closes the terminals a command's earlier runs left in the workspace: they're named after it. */
async function closeEarlierRuns(paseo: Paseo, workspaceId: string, label: string): Promise<void> {
  const { entries } = await paseo.terminals.list({ workspaceId });
  await Promise.all(
    entries
      .filter((terminal) => terminal.name === label)
      .map((terminal) => paseo.terminals.ref(terminal.id).kill()),
  );
}

/**
 * Runs a command in a new terminal in the workspace, named after it: your shell, with the
 * workspace's variables, in the workspace's folder or the command's own folder in it.
 */
export async function runCommand(
  paseo: Paseo,
  command: QuickCommand,
  workspaceId: string,
  pressEnter: boolean,
): Promise<{ terminalId: string }> {
  // Paseo's terminals start the daemon's SHELL, else sh
  const shell = process.env.SHELL || "/bin/sh";
  if (process.platform === "win32") throw new Error("Quick commands run on macOS and Linux hosts for now.");
  const kind = shellKind(shell);
  if (!kind)
    throw new Error(
      `Quick commands can't hand variables to ${basename(shell)} yet: only sh, bash, zsh and fish.`,
    );

  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) throw new Error("That workspace is gone.");
  if (command.projectId && command.projectId !== workspace.projectId)
    throw new Error(`${command.label} is for ${command.projectName || "another project"}, not this one.`);
  const cwd = resolve(workspace.workspaceDirectory, command.folder);
  if (!(await isFolder(cwd))) throw new Error(`This workspace has no ${command.folder} folder.`);

  const env = {
    ...(command.loadDotenv ? await dotenvFor(workspace, cwd) : {}),
    ...(await workspaceEnv(workspace)),
  };
  if (command.replace) await closeEarlierRuns(paseo, workspaceId, command.label);

  const tempDir = await mkdtemp(join(tmpdir(), "paseo-quick-commands-"));
  const run = launch(shell, kind, env, command.label, command.command, pressEnter, tempDir);
  for (const { path, text } of run.files) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, text, { mode: 0o600 });
  }
  setTimeout(() => void rm(tempDir, { recursive: true, force: true }), TEMP_LIFETIME_MS).unref();

  const terminal = await paseo.terminals
    .create({ workspaceId, cwd, name: command.label, command: run.command, args: run.args })
    .catch(async (error: unknown) => {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    });
  if (run.type !== null) {
    await waitForPrompt(async () => (await terminal.capture()).lines.join("\n"));
    terminal.write(run.type);
  }
  return { terminalId: terminal.id };
}
