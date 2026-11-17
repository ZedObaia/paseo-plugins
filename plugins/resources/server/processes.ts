import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { open, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProcessGroup, ProcessInfo } from "../shared/contracts";
import { run } from "./exec";

type Paseo = PluginHandlerContext["paseo"];
export type ProcessMetrics = Omit<ProcessInfo, "identity" | "canSignal">;
export interface ProcessIdentity {
  pid: number;
  ppid: number;
  uid: number;
  identity: string;
}
export interface ProcessObservation extends ProcessInfo {
  uid: number | null;
  cwd: string | null;
  workspaceId: string | null;
}
export interface WorkspaceLocation {
  id: string | null;
  name: string;
  projectId: string;
  projectName: string;
  directory: string;
}

const gone = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(String(error.code));

/** Only the workspace identity leaves the reader; environment contents are never returned or logged. */
export function workspaceFromEnvironment(buffer: Buffer): string | null {
  const key = Buffer.from("PASEO_WORKSPACE_ID=");
  let offset = 0;
  while (offset < buffer.length) {
    const found = buffer.indexOf(key, offset);
    if (found < 0) return null;
    const start = found + key.length;
    const end = buffer.indexOf(0, start);
    if ((found === 0 || buffer[found - 1] === 0) && end > start)
      return buffer.subarray(start, end).toString();
    offset = start;
  }
  return null;
}

export function parseLinuxIdentity(pid: number, text: string, uid: number): ProcessIdentity | null {
  const end = text.lastIndexOf(")");
  if (end < 0 || Number(text.slice(0, text.indexOf(" "))) !== pid) return null;
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const birth = fields[19];
  if (!Number.isInteger(ppid) || !birth || !/^\d+$/.test(birth) || fields[0] === "Z") return null;
  return { pid, ppid, uid, identity: `linux:${birth}` };
}

export function parseMacIdentities(text: string): Map<number, ProcessIdentity> {
  const result = new Map<number, ProcessIdentity>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, uid, birth] = match;
    result.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      uid: Number(uid),
      identity: `darwin:${birth}`,
    });
  }
  return result;
}

async function macIdentities(): Promise<Map<number, ProcessIdentity>> {
  return parseMacIdentities(await run("ps", ["-axo", "pid=,ppid=,uid=,lstart="]));
}

export async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  try {
    if (process.platform === "darwin") return (await macIdentities()).get(pid) ?? null;
    if (process.platform !== "linux") return null;
    const [text, info] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), stat(`/proc/${pid}`)]);
    return parseLinuxIdentity(pid, text, info.uid);
  } catch (error) {
    if (gone(error)) return null;
    throw error;
  }
}

export function protectedAncestors(
  rows: readonly Pick<ProcessInfo, "pid" | "ppid">[],
  selfPid: number,
): Set<number> {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  const protectedIds = new Set<number>([1]);
  let pid = selfPid;
  while (pid > 1 && !protectedIds.has(pid)) {
    protectedIds.add(pid);
    pid = parents.get(pid) ?? 1;
  }
  return protectedIds;
}

export function parseCwds(text: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith("n/") && pid) result.set(pid, line.slice(1));
  }
  return result;
}

async function linuxLocation(pid: number) {
  try {
    const cwd = await readlink(`/proc/${pid}/cwd`).catch((error) => {
      if (gone(error)) return null;
      throw error;
    });
    const file = await open(`/proc/${pid}/environ`, "r");
    try {
      // Bound reads even if a process has a very large launch environment.
      const buffer = Buffer.allocUnsafe(128 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return { cwd, workspaceId: workspaceFromEnvironment(buffer.subarray(0, bytesRead)) };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (gone(error)) return { cwd: await readlink(`/proc/${pid}/cwd`).catch(() => null), workspaceId: null };
    throw error;
  }
}

/** Bounded parallel /proc reads; never run one command or inspect arguments per process. */
export async function observeProcesses(
  rows: ProcessMetrics[],
  options: { locations?: boolean } = {},
): Promise<ProcessObservation[]> {
  const uid = process.getuid?.();
  const protectedIds = protectedAncestors(rows, process.pid);
  const mac = process.platform === "darwin";
  const identities = mac ? await macIdentities() : new Map<number, ProcessIdentity>();
  const cwds =
    mac && options.locations !== false && uid !== undefined
      ? parseCwds(await run("lsof", ["-a", "-u", String(uid), "-d", "cwd", "-Fpn"]).catch(() => ""))
      : new Map<number, string>();
  const result: ProcessObservation[] = [];
  for (let i = 0; i < rows.length; i += 12) {
    const batch = await Promise.all(
      rows.slice(i, i + 12).map(async (row) => {
        const identity = mac ? (identities.get(row.pid) ?? null) : await inspectProcess(row.pid);
        const sameProcess = identity?.ppid === row.ppid;
        const owned = sameProcess && uid !== undefined && identity.uid === uid;
        let location: Pick<ProcessObservation, "cwd" | "workspaceId"> = {
          cwd: cwds.get(row.pid) ?? null,
          workspaceId: null,
        };
        if (owned && !mac && options.locations !== false) location = await linuxLocation(row.pid);
        return {
          ...row,
          ...location,
          identity: sameProcess ? identity.identity : null,
          uid: sameProcess ? identity.uid : null,
          canSignal: owned && !protectedIds.has(row.pid),
        };
      }),
    );
    result.push(...batch);
  }
  return result;
}

/** A fresh identity table for actions, independent of the cached metrics snapshot. */
export async function processTable(): Promise<ProcessObservation[]> {
  const text = await run("ps", ["-axo", "pid=,ppid=,comm="]);
  const rows: ProcessMetrics[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match)
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        name: path.basename(match[3]),
        user: "",
        cpuPct: 0,
        memBytes: 0,
      });
  }
  return observeProcesses(rows, { locations: false });
}

export async function listLocations(paseo: Paseo): Promise<WorkspaceLocation[]> {
  const result: WorkspaceLocation[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const entry of page.entries) {
      const dir = entry.workspaceDirectory ?? entry.projectRootPath;
      result.push({
        id: entry.id,
        name: entry.name,
        projectId: entry.projectId,
        projectName: entry.projectDisplayName,
        directory: await realpath(dir).catch(() => dir),
      });
    }
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  const { projects } = await paseo.projects.list();
  for (const project of projects) {
    result.push({
      id: null,
      name: `${project.projectDisplayName} (project root)`,
      projectId: project.projectId,
      projectName: project.projectDisplayName,
      directory: await realpath(project.projectRootPath).catch(() => project.projectRootPath),
    });
  }
  return result;
}

type Attribution = ProcessGroup["processes"][number]["attribution"];
interface Assignment {
  workspace: WorkspaceLocation;
  attribution: Attribution;
}
const inside = (cwd: string, directory: string) =>
  cwd === directory || cwd.startsWith(`${directory.replace(/\/$/, "")}/`);

/** IDs are authority; ancestry and unique directory matches are explicitly labelled evidence. */
export function groupProcesses(rows: ProcessObservation[], workspaces: WorkspaceLocation[]): ProcessGroup[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const memo = new Map<number, Assignment | null>();
  function assign(row: ProcessObservation, visiting = new Set<number>()): Assignment | null {
    if (memo.has(row.pid)) return memo.get(row.pid) ?? null;
    if (visiting.has(row.pid)) return null;
    visiting.add(row.pid);
    let found: Assignment | null = null;
    if (row.workspaceId) {
      const workspace = byId.get(row.workspaceId) ?? {
        id: row.workspaceId,
        name: "Unregistered workspace",
        projectId: "",
        projectName: "Unregistered workspaces",
        directory: row.cwd ?? "",
      };
      found = { workspace, attribution: "identity" };
    } else {
      const parent = byPid.get(row.ppid);
      const inherited = parent ? assign(parent, visiting) : null;
      if (inherited) found = { workspace: inherited.workspace, attribution: "ancestor" };
      else if (row.cwd) {
        const cwd = row.cwd.replace(/ \(deleted\)$/, "");
        const matches = workspaces
          .filter((workspace) => inside(cwd, workspace.directory))
          .sort((a, b) => b.directory.length - a.directory.length);
        const nearest = matches.filter(
          (workspace) => workspace.directory.length === matches[0]?.directory.length,
        );
        const actualWorkspaces = nearest.filter((workspace) => workspace.id !== null);
        const candidates = actualWorkspaces.length ? actualWorkspaces : nearest;
        if (candidates.length === 1) found = { workspace: candidates[0], attribution: "directory" };
      }
    }
    visiting.delete(row.pid);
    memo.set(row.pid, found);
    return found;
  }
  const groups = new Map<string, ProcessGroup>();
  for (const row of rows) {
    const assignment = assign(row);
    const workspace = assignment?.workspace;
    const key = workspace?.id ?? (workspace ? `project:${workspace.projectId}` : "unassigned");
    let group = groups.get(key);
    if (!group) {
      group = {
        workspaceId: workspace?.id ?? null,
        workspaceName: workspace?.name ?? "Unassigned",
        projectId: workspace?.projectId || null,
        projectName: workspace?.projectName ?? "Unassigned",
        directory: workspace?.directory || null,
        cpuPct: 0,
        memBytes: 0,
        processes: [],
      };
      groups.set(key, group);
    }
    group.cpuPct += row.cpuPct;
    group.memBytes += row.memBytes;
    // Do not serialize uid, environment keys or raw working directories per process.
    const { uid: _uid, cwd: _cwd, workspaceId: _workspaceId, ...processInfo } = row;
    group.processes.push({ ...processInfo, attribution: assignment?.attribution ?? "unassigned" });
  }
  return [...groups.values()].sort((a, b) => b.memBytes - a.memBytes);
}
