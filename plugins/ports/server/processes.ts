import { reach } from "./address";
import { lsofSnapshot } from "./lsof";
import { procfsProcess, procfsSockets } from "./procfs";

export interface Socket {
  address: string;
  port: number;
  /** Null when the socket belongs to another user, or to Docker's NAT rules. */
  pid: number | null;
}

export interface ProcessInfo {
  ppid: number | null;
  name: string;
  command: string;
  cwd: string | null;
  /** The workspace whose terminal it was started from. */
  workspaceId: string | null;
  /** Workspace paths Paseo put in its environment. */
  envDirs: string[];
}

/** A listening port and what ties it to a workspace, most telling first. */
export interface Listener {
  /** Full command or container name, used to distinguish servers with the same display name. */
  identity?: string;
  port: number;
  address: string;
  name: string;
  detail: string;
  pid: number | null;
  source: "process" | "docker";
  /** Where it runs: a process's working directory, a Compose project's directory. */
  cwd: string | null;
  workspaceId: string | null;
  /** Other directories it came from, for when the ones above aren't in a workspace. */
  dirs: string[];
}

/**
 * One listener per process and port, at its widest bind, tied to where it runs, the workspace
 * and paths Paseo put in its environment, and, when Paseo started it (from a terminal, script or
 * agent), where the processes between it and the daemon ran. The daemon's own children are
 * agents, plugins and terminal hosts, so their ports are Paseo's, not something the user started.
 */
export function toListeners(
  sockets: readonly Socket[],
  lookup: (pid: number) => ProcessInfo | null,
  daemonPid: number,
  selfPid: number,
): Listener[] {
  const widest = new Map<string, Socket & { pid: number }>();
  for (const s of sockets) {
    if (s.pid === null || s.pid === daemonPid || s.pid === selfPid) continue;
    const key = `${s.pid}:${s.port}`;
    const kept = widest.get(key);
    if (!kept || reach(s.address) > reach(kept.address)) widest.set(key, { ...s, pid: s.pid });
  }
  const listeners: Listener[] = [];
  for (const s of widest.values()) {
    const proc = lookup(s.pid);
    if (!proc || proc.ppid === daemonPid) continue;
    const starters: string[] = [];
    let underPaseo = false;
    let ppid = proc.ppid;
    for (let depth = 0; ppid !== null && ppid > 1 && depth < 64; depth++) {
      if (ppid === daemonPid) {
        underPaseo = true;
        break;
      }
      const parent = lookup(ppid);
      if (!parent) break;
      if (parent.cwd) starters.push(parent.cwd);
      ppid = parent.ppid;
    }
    listeners.push({
      identity: proc.command,
      port: s.port,
      address: s.address,
      name: displayName(proc.command) ?? proc.name,
      detail: shortCommand(proc.command),
      pid: s.pid,
      source: "process",
      cwd: proc.cwd,
      workspaceId: proc.workspaceId,
      dirs: [...new Set([...proc.envDirs, ...(underPaseo ? starters : [])])],
    });
  }
  return listeners;
}

/** "/usr/bin/node /home/me/app/node_modules/.bin/vite --port 5173" reads "node vite --port 5173". */
export const shortCommand = (command: string) =>
  command
    .split(" ")
    .map((token) => (token.startsWith("/") ? token.slice(token.lastIndexOf("/") + 1) : token))
    .join(" ");

const INTERPRETER = /^(node|nodejs|bun|deno|python[\d.]*|ruby|php|perl)$/;
const INLINE_CODE = new Set(["-e", "--eval", "-p", "--print", "-c"]);
// interpreter flags whose value is the next argument, not the script
const TAKES_VALUE = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--title",
  "-W",
  "-X",
]);

/**
 * What a process is running: an interpreter's script ("vite" for `node …/.bin/vite`,
 * "http.server" for `python3 -m http.server`), else its executable. Node names its main thread
 * "MainThread", which is all /proc's short name shows.
 */
export function displayName(command: string): string | null {
  const [exe, ...args] = command.split(" ").filter(Boolean);
  if (!exe) return null;
  const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  if (!INTERPRETER.test(base(exe))) return base(exe);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m" && args[i + 1]) return args[i + 1];
    // code on the command line has no script to name
    if (INLINE_CODE.has(args[i])) return base(exe);
    if (args[i] === "run" && base(exe) === "deno") continue;
    if (TAKES_VALUE.has(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("-")) return base(args[i]).replace(/\.(c|m)?(j|t)s$|\.py$/, "");
  }
  return base(exe);
}

function memo<T>(load: (pid: number) => T): (pid: number) => T {
  const seen = new Map<number, T>();
  return (pid) => {
    if (!seen.has(pid)) seen.set(pid, load(pid));
    return seen.get(pid)!;
  };
}

/** This machine's listening processes. Throws on platforms it can't read. */
export async function processListeners(): Promise<Listener[]> {
  // the plugin runs as a child of the daemon
  const daemonPid = process.ppid;
  if (process.platform === "linux")
    return toListeners(procfsSockets(), memo(procfsProcess), daemonPid, process.pid);
  if (process.platform === "darwin") {
    const { sockets, lookup } = await lsofSnapshot(daemonPid);
    return toListeners(sockets, lookup, daemonPid, process.pid);
  }
  throw new Error(`Finding ports isn't supported on ${process.platform}`);
}
