import { basename } from "node:path";
import { canonicalAddress } from "./address";
import { run } from "./exec";
import type { ProcessInfo, Socket } from "./processes";

/**
 * `lsof -F` output is one field per line, keyed by its first character: `p` starts a process,
 * `c` and `R` are its command name and parent, and each `n` is the name of one of its files.
 */
function fields(
  text: string,
  onProcess: (pid: number) => void,
  onField: (key: string, value: string) => void,
) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line[0] === "p") onProcess(Number(line.slice(1)));
    else onField(line[0], line.slice(1));
  }
}

/** Sockets and process names from `lsof -nP -iTCP -sTCP:LISTEN -FpcRn`. */
export function parseLsofListen(text: string) {
  const sockets: Socket[] = [];
  const names = new Map<number, string>();
  let pid = 0;
  fields(
    text,
    (p) => (pid = p),
    (key, value) => {
      if (key === "c") names.set(pid, value);
      if (key !== "n") return;
      const colon = value.lastIndexOf(":");
      const port = Number(value.slice(colon + 1));
      if (colon > 0 && Number.isInteger(port))
        sockets.push({ address: canonicalAddress(value.slice(0, colon)), port, pid });
    },
  );
  return { sockets, names };
}

/** Working directories from `lsof -a -d cwd -Fpn -p ...`. */
export function parseLsofCwd(text: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  fields(
    text,
    (p) => (pid = p),
    (key, value) => key === "n" && cwds.set(pid, value),
  );
  return cwds;
}

/** `ps -o pid=,<column>=` rows: the pid, then the rest of the line. */
export function parsePsColumns(text: string): Map<number, string> {
  const rows = new Map<number, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) rows.set(Number(match[1]), match[2].trim());
  }
  return rows;
}

/** macOS has no /proc: lsof finds the sockets and working directories, ps the process tree. */
export async function lsofSnapshot(daemonPid: number) {
  const [listen, table] = await Promise.all([
    run("lsof", ["-nP", "+c", "0", "-iTCP", "-sTCP:LISTEN", "-FpcRn"], 10_000, true),
    run("ps", ["-axo", "pid=,ppid="]),
  ]);
  const { sockets, names } = parseLsofListen(listen);
  const ppids = new Map([...parsePsColumns(table)].map(([pid, ppid]) => [pid, Number(ppid)]));
  // the listening processes and every process above them, up to the daemon
  const wanted = new Set<number>();
  for (const s of sockets) {
    for (let p = s.pid, depth = 0; p && p > 1 && p !== daemonPid && depth < 64; depth++) {
      wanted.add(p);
      p = ppids.get(p) ?? null;
    }
  }
  const pids = [...wanted].join(",");
  const [cwdText, commandText] = wanted.size
    ? await Promise.all([
        run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids], 10_000, true),
        run("ps", ["-ww", "-o", "pid=,command=", "-p", pids], 10_000, true),
      ])
    : ["", ""];
  const cwds = parseLsofCwd(cwdText);
  const commands = parsePsColumns(commandText);
  const lookup = (pid: number): ProcessInfo | null => {
    if (!ppids.has(pid)) return null;
    const command = commands.get(pid) ?? "";
    return {
      ppid: ppids.get(pid) ?? null,
      name: names.get(pid) ?? basename(command.split(" ")[0] ?? ""),
      command,
      cwd: cwds.get(pid) ?? null,
      workspaceId: null,
      envDirs: [],
    };
  };
  return { sockets, lookup };
}
