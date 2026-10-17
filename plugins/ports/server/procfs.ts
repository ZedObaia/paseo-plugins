import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { endianness } from "node:os";
import { canonicalAddress } from "./address";
import type { Socket } from "./processes";

/**
 * LISTEN sockets in a /proc/net/tcp or tcp6 table, by socket inode. The kernel prints each 32-bit
 * word of an address in host byte order, so on little-endian machines every word reads backwards.
 */
export function parseProcNetTcp(
  text: string,
  littleEndian = endianness() === "LE",
): Map<string, { address: string; port: number }> {
  const sockets = new Map<string, { address: string; port: number }>();
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [hexAddress, hexPort] = f[1].split(":");
    const bytes: number[] = [];
    for (let w = 0; w < hexAddress.length; w += 8) {
      const word = hexAddress
        .slice(w, w + 8)
        .match(/../g)!
        .map((b) => parseInt(b, 16));
      bytes.push(...(littleEndian ? word.reverse() : word));
    }
    sockets.set(f[9], { address: formatAddress(bytes), port: parseInt(hexPort, 16) });
  }
  return sockets;
}

function formatAddress(bytes: number[]): string {
  if (bytes.length === 4) return bytes.join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return canonicalAddress(groups.join(":"));
}

/** The ppid field of /proc/<pid>/stat; the command name before it can hold spaces and parens. */
export function parseStatPpid(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const link = (path: string) => {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
};

/** Listening sockets with the process holding each, read straight from /proc. */
export function procfsSockets(): Socket[] {
  const byInode = new Map([
    ...parseProcNetTcp(read("/proc/net/tcp") ?? ""),
    ...parseProcNetTcp(read("/proc/net/tcp6") ?? ""),
  ]);
  const owner = new Map<string, number>();
  // /proc lists pids in ascending order, so a socket shared by a server's workers goes to the
  // oldest process, usually the one that forked them
  for (const entry of readdirSync("/proc")) {
    if (owner.size === byInode.size) break;
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // gone, or another user's
    }
    for (const fd of fds) {
      const target = link(`/proc/${entry}/fd/${fd}`);
      const inode = target?.startsWith("socket:[") ? target.slice(8, -1) : null;
      if (inode && byInode.has(inode) && !owner.has(inode)) owner.set(inode, Number(entry));
    }
  }
  return [...byInode].map(([inode, s]) => ({ ...s, pid: owner.get(inode) ?? null }));
}

const ENV_DIRS = ["PASEO_WORKTREE_PATH", "PASEO_AGENT_CWD"];
const envValue = (env: string[], key: string) =>
  env.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;

export function procfsProcess(pid: number) {
  const stat = read(`/proc/${pid}/stat`);
  if (stat === null) return null;
  const env = (read(`/proc/${pid}/environ`) ?? "").split("\0");
  return {
    ppid: parseStatPpid(stat),
    name: (read(`/proc/${pid}/comm`) ?? "").trim(),
    command: (read(`/proc/${pid}/cmdline`) ?? "").split("\0").join(" ").trim(),
    cwd: link(`/proc/${pid}/cwd`),
    // Paseo's terminals set it
    workspaceId: envValue(env, "PASEO_WORKSPACE_ID"),
    envDirs: ENV_DIRS.map((key) => envValue(env, key)).filter((dir): dir is string => !!dir),
  };
}
