import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/** What the env is built from: the parts of Paseo's workspace record it uses. */
export interface WorkspaceLike {
  workspaceDirectory: string;
  projectRootPath: string;
  scripts: readonly {
    scriptName: string;
    type: "script" | "service";
    port: number | null;
    proxyUrl: string | null;
  }[];
}

/** Where git keeps a checkout's data: its `.git` folder, or the one a worktree's `.git` file names. */
export async function gitDir(root: string): Promise<string | null> {
  const dotGit = join(root, ".git");
  try {
    const raw = /gitdir:\s*(.+)/.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
    if (!raw) return null;
    return isAbsolute(raw) ? raw : resolve(root, raw);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EISDIR" ? dotGit : null;
  }
}

/** The branch checked out, from git's HEAD file: empty when it's detached. */
export async function branchIn(gitDirectory: string): Promise<string> {
  const head = await readFile(join(gitDirectory, "HEAD"), "utf8").catch(() => "");
  return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? "";
}

/** The port Paseo gave a worktree it made, kept in its metadata beside git's. */
export async function worktreePort(gitDirectory: string): Promise<number | null> {
  try {
    const metadata = JSON.parse(await readFile(join(gitDirectory, "paseo", "worktree.json"), "utf8"));
    const port = metadata?.version === 2 ? metadata.runtime?.worktreePort : null;
    return typeof port === "number" ? port : null;
  } catch {
    return null;
  }
}

/** `PASEO_SERVICE_<NAME>_PORT` for a service named `my-api`: Paseo's own spelling. */
export const serviceEnvName = (scriptName: string) =>
  scriptName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * The variables paseo.json's scripts see, so a command copied from one works the same: its paths,
 * its branch, the worktree's port, and the ports and links of the workspace's services.
 */
export async function workspaceEnv(workspace: WorkspaceLike): Promise<Record<string, string>> {
  const directory = workspace.workspaceDirectory;
  const env: Record<string, string> = {
    PASEO_SOURCE_CHECKOUT_PATH: workspace.projectRootPath,
    PASEO_WORKTREE_PATH: directory,
  };
  const git = await gitDir(directory);
  if (git) {
    env.PASEO_BRANCH_NAME = await branchIn(git);
    const port = await worktreePort(git);
    if (port !== null) env.PASEO_WORKTREE_PORT = String(port);
  }
  for (const script of workspace.scripts) {
    if (script.type !== "service") continue;
    const name = serviceEnvName(script.scriptName);
    if (script.port !== null) env[`PASEO_SERVICE_${name}_PORT`] = String(script.port);
    if (script.proxyUrl) env[`PASEO_SERVICE_${name}_URL`] = script.proxyUrl;
  }
  return env;
}

// dotenv's own line pattern: `KEY=value`, `export KEY=value`, quoted values over several lines
const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
// a shell can't export the dotted or dashed names dotenv also takes
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A .env file's variables as dotenv reads them, without expanding `$OTHER` in values. */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of text.replace(/\r\n?/g, "\n").matchAll(LINE)) {
    const [, key, raw = ""] = match;
    if (!SHELL_NAME.test(key)) continue;
    const trimmed = raw.trim();
    let value = trimmed.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (trimmed[0] === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    values[key] = value;
  }
  return values;
}

async function readDotenv(path: string): Promise<Record<string, string> | null> {
  try {
    return parseDotenv(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The `.env` of the workspace's folder, then of the folder the command runs in, which wins. A new
 * worktree has none (git ignores it) unless its setup copies one, so a missing one is read from the
 * same place in the project's own checkout.
 */
export async function dotenvFor(workspace: WorkspaceLike, cwd: string): Promise<Record<string, string>> {
  const folders = [""];
  const inner = relative(workspace.workspaceDirectory, cwd);
  if (inner) folders.push(inner);
  let values: Record<string, string> = {};
  for (const folder of folders) {
    const found =
      (await readDotenv(join(workspace.workspaceDirectory, folder, ".env"))) ??
      (await readDotenv(join(workspace.projectRootPath, folder, ".env")));
    if (found) values = { ...values, ...found };
  }
  return values;
}
