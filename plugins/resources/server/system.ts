import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HISTORY_SAMPLES,
  SAMPLE_SECONDS,
  type App,
  type ProcessInfo,
  type Sample,
  type Snapshot,
} from "../shared/contracts";
import { run } from "./exec";

type Memory = Pick<Snapshot, "memory" | "swap">;
type CpuTimes = { busy: number; total: number; steal: number };

let lastCpu: { pct: number; stealPct: number | null } | null = null;
let lastMemory: Memory | null = null;
const history: Sample[] = [];

/** Linux /proc/stat totals. Unlike os.cpus() they include iowait, softirq and steal. */
export function parseProcStat(text: string): CpuTimes | null {
  const fields = /^cpu\s+(.+)$/m.exec(text)?.[1].trim().split(/\s+/).map(Number);
  if (!fields || fields.length < 8) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait, steal };
}

async function cpuTimes(): Promise<CpuTimes> {
  if (process.platform === "linux") {
    const times = parseProcStat(await readFile("/proc/stat", "utf8"));
    if (times) return times;
  }
  let busy = 0;
  let idle = 0;
  for (const { times: t } of os.cpus()) {
    busy += t.user + t.nice + t.sys + t.irq;
    idle += t.idle;
  }
  return { busy, total: busy + idle, steal: 0 };
}

/**
 * Samples CPU, memory and swap every SAMPLE_SECONDS for as long as the plugin runs, so snapshots
 * never wait for a reading and the charts cover the last 10 minutes even when nobody was looking.
 */
export function startSampler(): () => void {
  let previous: CpuTimes | null = null;
  const tick = async () => {
    const current = await cpuTimes().catch(() => null);
    if (current && previous && current.total > previous.total) {
      const elapsed = current.total - previous.total;
      lastCpu = {
        pct: ((current.busy - previous.busy) / elapsed) * 100,
        stealPct: process.platform === "linux" ? ((current.steal - previous.steal) / elapsed) * 100 : null,
      };
    }
    previous = current ?? previous;
    lastMemory = await memory().catch(() => lastMemory);
    if (!lastCpu || !lastMemory) return;
    const { memory: m, swap } = lastMemory;
    history.push({
      cpu: lastCpu.pct / 100,
      mem: m.usedBytes / m.totalBytes,
      swap: swap ? swap.usedBytes / swap.totalBytes : 0,
    });
    if (history.length > HISTORY_SAMPLES) history.splice(0, history.length - HISTORY_SAMPLES);
  };
  void tick(); // the baseline the first reading is measured against
  const first = setTimeout(() => void tick(), 1_000);
  const timer = setInterval(() => void tick(), SAMPLE_SECONDS * 1_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

async function memory(): Promise<Memory> {
  const totalBytes = os.totalmem();
  if (process.platform === "linux") {
    const m: Record<string, number> = {};
    for (const match of (await readFile("/proc/meminfo", "utf8")).matchAll(/^(\w+):\s+(\d+)/gm))
      m[match[1]] = Number(match[2]) * 1024;
    return {
      memory: { totalBytes, usedBytes: totalBytes - (m.MemAvailable ?? os.freemem()) },
      swap: m.SwapTotal ? { totalBytes: m.SwapTotal, usedBytes: m.SwapTotal - (m.SwapFree ?? 0) } : null,
    };
  }
  // macOS: os.freemem() leaves out reclaimable cache; memory_pressure reports what is really free.
  const [pressure, swapText] = await Promise.all([
    run("memory_pressure", ["-Q"]).catch(() => ""),
    run("sysctl", ["-n", "vm.swapusage"]).catch(() => ""),
  ]);
  const freePct = Number(/free percentage:\s*(\d+)/.exec(pressure)?.[1] ?? NaN);
  const usedBytes = Number.isFinite(freePct) ? totalBytes * (1 - freePct / 100) : totalBytes - os.freemem();
  const mib = (key: string) => Number(new RegExp(`${key} = ([\\d.]+)M`).exec(swapText)?.[1] ?? 0) * 1024 ** 2;
  return {
    memory: { totalBytes, usedBytes: Math.round(usedBytes) },
    swap: mib("total") ? { totalBytes: mib("total"), usedBytes: mib("used") } : null,
  };
}

/** macOS: "dev on /path (apfs, local, read-only)"; Linux: "dev on /path type ext4 (ro,relatime)". */
export function readOnlyMount(line: string): string | null {
  const match = /^\S+ on (.+?) (?:type \S+ )?\(([^)]*)\)$/.exec(line);
  const options = match?.[2].split(",").map((option) => option.trim()) ?? [];
  return match && (options.includes("read-only") || options.includes("ro")) ? match[1] : null;
}

/** `df -kP` output to the disks worth showing; free space is df's Available, not size minus used. */
export function parseDf(text: string, readOnly: ReadonlySet<string>, platform: string): Snapshot["disks"] {
  const seen = new Set<string>();
  const result: Snapshot["disks"] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const [device, size, used, available] = cols;
    const mount = cols.slice(5).join(" ");
    if (seen.has(device) || readOnly.has(mount) || /^\/(boot|snap)(\/|$)/.test(mount)) continue;
    if (platform === "darwin") {
      // "/" is the sealed system snapshot; the Data volume holds everything you can fill
      if (mount !== "/System/Volumes/Data" && !mount.startsWith("/Volumes/")) continue;
    } else if (mount !== "/" && (!device.startsWith("/dev/") || device.startsWith("/dev/loop"))) {
      continue; // tmpfs and friends; a ZFS or overlay root is kept by its mount point
    }
    seen.add(device);
    result.push({
      mount: mount === "/System/Volumes/Data" ? "/" : mount,
      totalBytes: Number(size) * 1024,
      usedBytes: Number(used) * 1024,
      freeBytes: Number(available) * 1024,
    });
  }
  return result;
}

async function disks(): Promise<Snapshot["disks"]> {
  // -l: local filesystems only, so a dead network mount can't hang or fail the listing
  const [text, mounts] = await Promise.all([run("df", ["-kPl"]), run("mount", []).catch(() => "")]);
  const readOnly = new Set(
    mounts
      .split("\n")
      .map(readOnlyMount)
      .filter((m): m is string => m !== null),
  );
  return parseDf(text, readOnly, process.platform);
}

const INTERPRETER = /^(node|bun|deno|python[\d.]*|Python|ruby|perl|php|java)$/;
const VERSION = /^\d+(\.\d+)+$/;
// java options whose value is the next word
const JAVA_VALUE_OPTIONS = new Set([
  "-cp",
  "-classpath",
  "--class-path",
  "-p",
  "--module-path",
  "-m",
  "--module",
]);

/**
 * A readable name: the executable, or for interpreters the script or main class they run, so a
 * dozen node processes show up as "tsserver" and "playwright-mcp" instead of "node".
 */
export function processName(command: string, args: string): string {
  // the Android emulator runs as qemu-system-<arch> from the SDK's emulator folder
  if (command.includes("/emulator/qemu/")) return "Android emulator";
  const words = args.trim().split(/\s+/);
  // macOS ps shows "(node)" when it can't read a process's arguments
  let exe = path.basename(command.trim().replace(/^\((.+)\)$/, "$1"));
  // tools installed as .../<tool>/versions/<x.y.z> (Claude Code) run under their version number
  if (VERSION.test(exe)) {
    const argv0 = path.basename(words[0] ?? "");
    exe =
      argv0 && !VERSION.test(argv0)
        ? argv0
        : path.basename(path.dirname(path.dirname(command.trim()))) || exe;
  }
  if (!INTERPRETER.test(exe)) return exe;
  const rest = words.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (exe === "java") {
      if (w === "-jar" && rest[i + 1]) return path.basename(rest[i + 1]);
      if (JAVA_VALUE_OPTIONS.has(w)) i++;
      // option values ("java.base/java.lang=ALL-UNNAMED") have / or =; a main class has neither
      else if (!w.startsWith("-") && !/[=/]/.test(w)) return w.split(".").pop() || exe;
      continue;
    }
    if (!w.startsWith("-")) return path.basename(w).replace(/\.(m?js|cjs|ts|py|rb|pl|php)$/, "") || exe;
  }
  return exe;
}

/** Groups an app's helper processes under the app: "Google Chrome Helper (Renderer)" -> "Google Chrome". */
export function appName(name: string): string {
  if (name === "com.apple.Virtualization.VirtualMachine") return "Virtual machines (Docker…)";
  return name.replace(/ Helper( \([^)]*\))?$/, "").replace(/ \((Renderer|GPU|Plugin|Service)\)$/, "");
}

type PsRow = { pid: number; ppid: number; cpuPct: number; rssBytes: number; user: string; command: string };

/** `ps -axo pid=,ppid=,pcpu=,rss=,user=,comm=` */
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPct: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      user: match[5],
      command: match[6].trim(),
    });
  }
  return rows;
}

/** macOS `top -l 1 -stats pid,mem`: footprint per process, including compressed pages. */
export function parseMacTop(text: string): Map<number, number> {
  const unit: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  const result = new Map<number, number>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+([\d.]+)([BKMG])[+-]?\s*$/.exec(line);
    if (match) result.set(Number(match[1]), Number(match[2]) * unit[match[3]]);
  }
  return result;
}

/**
 * Linux `top -b -n 2 -d 0.5`: %CPU per pid from the second frame, i.e. over the last half
 * second. procps `ps` reports the average since each process started instead.
 */
export function parseLinuxTop(text: string): Map<number, number> {
  const frames = text.split(/^\s*PID\s/m);
  const last = frames.at(-1) ?? "";
  const header = ["PID", ...(last.split("\n")[0] ?? "").trim().split(/\s+/)];
  const cpuColumn = header.indexOf("%CPU");
  const result = new Map<number, number>();
  if (frames.length < 2 || cpuColumn < 0) return result;
  for (const line of last.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[0]);
    const cpu = Number(cols[cpuColumn]);
    if (Number.isInteger(pid) && pid > 0 && Number.isFinite(cpu)) result.set(pid, cpu);
  }
  return result;
}

async function processes(): Promise<Pick<Snapshot, "topCpu" | "topMemory" | "apps">> {
  const mac = process.platform === "darwin";
  const [psText, argsText, footprints, recentCpu] = await Promise.all([
    run("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,user=,comm="]),
    run("ps", ["-axo", "pid=,args="]),
    mac
      ? run("top", ["-l", "1", "-o", "mem", "-n", "200", "-stats", "pid,mem"], 20_000)
          .then(parseMacTop)
          .catch(() => new Map<number, number>())
      : new Map<number, number>(),
    mac
      ? new Map<number, number>()
      : run("top", ["-b", "-n", "2", "-d", "0.5", "-w", "512"])
          .then(parseLinuxTop)
          .catch(() => new Map<number, number>()),
  ]);
  const args = new Map<number, string>();
  for (const match of argsText.matchAll(/^\s*(\d+)\s+(.*)$/gm)) args.set(Number(match[1]), match[2]);

  const all: ProcessInfo[] = parsePs(psText)
    // skip what this plugin itself spawned: this very `ps`, `top`, docker CLI calls
    .filter((p) => p.ppid !== process.pid)
    .map((p) => ({
      pid: p.pid,
      name: processName(p.command, args.get(p.pid) ?? ""),
      user: p.user,
      cpuPct: recentCpu.get(p.pid) ?? p.cpuPct,
      memBytes: footprints.get(p.pid) ?? p.rssBytes,
    }));
  const top = (key: "cpuPct" | "memBytes") => [...all].sort((a, b) => b[key] - a[key]).slice(0, 12);
  const groups = new Map<string, App>();
  for (const p of all) {
    const name = appName(p.name);
    const g = groups.get(name);
    groups.set(name, { name, count: (g?.count ?? 0) + 1, memBytes: (g?.memBytes ?? 0) + p.memBytes });
  }
  const apps = [...groups.values()].sort((a, b) => b.memBytes - a.memBytes).slice(0, 10);
  return { topCpu: top("cpuPct"), topMemory: top("memBytes"), apps };
}

export async function summary(): Promise<{
  cpuPct: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
}> {
  const { memory: m } = lastMemory ?? (await memory());
  return { cpuPct: lastCpu?.pct ?? null, memUsedBytes: m.usedBytes, memTotalBytes: m.totalBytes };
}

/** Everything but Docker. A failing part comes back empty rather than failing the whole view. */
export async function systemSnapshot(): Promise<Omit<Snapshot, "docker">> {
  const [mem, diskList, procs] = await Promise.all([
    lastMemory ?? memory(),
    disks().catch((error) => (console.error("disks:", error), [])),
    processes().catch(
      (error) => (console.error("processes:", error), { topCpu: [], topMemory: [], apps: [] }),
    ),
  ]);
  const [l1, l5, l15] = os.loadavg();
  return {
    takenAt: Date.now(),
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      uptimeSec: os.uptime(),
      cpuCount: os.cpus().length,
    },
    cpuPct: lastCpu?.pct ?? null,
    stealPct: lastCpu?.stealPct ?? null,
    load: [l1, l5, l15],
    ...mem,
    disks: diskList,
    ...procs,
    history: [...history],
  };
}
