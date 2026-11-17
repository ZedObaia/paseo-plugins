import { randomUUID } from "node:crypto";
import type { ProcessIdentity, ProcessObservation } from "./processes";
import { inspectProcess, processTable, protectedAncestors } from "./processes";

type Signal = "SIGTERM" | "SIGKILL";
interface ProcessActionsPort {
  list(): Promise<ProcessObservation[]>;
  inspect(pid: number): Promise<ProcessIdentity | null>;
  signal(pid: number, signal: Signal): void;
  selfPid: number;
  uid: number | undefined;
  now(): number;
  token(): string;
}
interface TreePreview {
  expiresAt: number;
  members: ProcessObservation[];
}

/** Descendants before parents, with cycle detection even if the OS sample was inconsistent. */
export function processTree(rows: ProcessObservation[], rootPid: number): ProcessObservation[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const root = byPid.get(rootPid);
  if (!root) throw new Error("That process exited. Refresh the process list.");
  const children = new Map<number, ProcessObservation[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const found: ProcessObservation[] = [];
  const seen = new Set<number>();
  function visit(row: ProcessObservation) {
    if (seen.has(row.pid)) throw new Error("The process tree changed. Refresh the process list.");
    seen.add(row.pid);
    if (seen.size > 512) throw new Error("This tree exceeds 512 processes. Use the host's process tools.");
    for (const child of children.get(row.pid) ?? []) visit(child);
    found.push(row);
  }
  visit(root);
  return found;
}

export function createProcessActions(
  port: ProcessActionsPort = {
    list: processTable,
    inspect: inspectProcess,
    signal: (pid, signal) => process.kill(pid, signal),
    selfPid: process.pid,
    uid: process.getuid?.(),
    now: Date.now,
    token: randomUUID,
  },
) {
  const previews = new Map<string, TreePreview>();
  const assertOwned = (
    row: Pick<ProcessObservation, "pid" | "uid" | "identity">,
    protectedIds: Set<number>,
  ) => {
    if (row.pid < 2 || protectedIds.has(row.pid))
      throw new Error("The daemon, this plugin and their supervisors are protected.");
    if (port.uid === undefined || row.uid !== port.uid || !row.identity)
      throw new Error("Only processes with a verified identity owned by your user can be stopped.");
  };
  async function currentTarget(pid: number, identity: string) {
    const rows = await port.list();
    const row = rows.find((entry) => entry.pid === pid);
    if (!row || row.identity !== identity)
      throw new Error("That process exited or its PID was reused. Refresh the process list.");
    const protectedIds = protectedAncestors(rows, port.selfPid);
    assertOwned(row, protectedIds);
    return { row, rows, protectedIds };
  }
  async function send(member: ProcessObservation, signal: Signal): Promise<boolean> {
    const current = await port.inspect(member.pid);
    if (!current || current.identity !== member.identity) return false;
    if (current.uid !== port.uid) throw new Error("Process ownership changed. Refresh the process list.");
    try {
      port.signal(member.pid, signal);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  }
  return {
    async signal(pid: number, identity: string, signal: Signal) {
      const { row } = await currentTarget(pid, identity);
      if (!(await send(row, signal)))
        throw new Error("That process exited or its PID was reused. Refresh the process list.");
      return { message: `Sent ${signal} to ${pid}` };
    },
    async preview(pid: number, identity: string) {
      const { rows, protectedIds } = await currentTarget(pid, identity);
      const members = processTree(rows, pid);
      for (const member of members) assertOwned(member, protectedIds);
      for (const [token, preview] of previews) if (preview.expiresAt <= port.now()) previews.delete(token);
      if (previews.size >= 50) previews.delete(previews.keys().next().value!);
      const token = port.token();
      const expiresAt = port.now() + 60_000;
      previews.set(token, { members, expiresAt });
      return {
        token,
        expiresAt,
        processes: [...members].reverse().map((member) => ({ pid: member.pid, name: member.name })),
      };
    },
    async signalTree(token: string, signal: Signal) {
      const preview = previews.get(token);
      previews.delete(token);
      if (!preview || preview.expiresAt <= port.now())
        throw new Error("The tree preview expired. Preview it again before stopping it.");
      const root = preview.members.at(-1)!;
      const { rows, protectedIds } = await currentTarget(root.pid, root.identity!);
      const current = processTree(rows, root.pid);
      const expected = new Map(preview.members.map((member) => [member.pid, member]));
      const unchanged =
        current.length === expected.size &&
        current.every((member) => {
          const previous = expected.get(member.pid);
          return (
            previous?.identity === member.identity &&
            previous.ppid === member.ppid &&
            previous.uid === member.uid
          );
        });
      if (!unchanged)
        throw new Error("The tree changed since the preview. Preview it again before stopping it.");
      for (const member of current) assertOwned(member, protectedIds);
      let sent = 0;
      for (const member of current) if (await send(member, signal)) sent++;
      // A signal is a request, not proof of exit. Detached/new descendants and service restarts
      // require a new snapshot; never widen the action to a process group or directory match.
      return {
        message: `Sent ${signal} to ${sent} of ${current.length} previewed processes. Refresh to check for survivors.`,
      };
    },
  };
}
