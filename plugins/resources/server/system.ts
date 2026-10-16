import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { App, ProcessInfo, Sample, Snapshot } from "../shared/contracts";
import { run } from "./exec";

let lastCpuPct: number | null = null;
let lastMemory: Pick<Snapshot, "memory" | "swap"> | null = null;
const history: Sample[] = [];
const HISTORY_POINTS = 120; // 10 minutes at one sample every 5 s

/**
 * Samples CPU, memory and swap every 5 s for as long as the plugin runs, so snapshots never wait
 * for a reading and the charts have the last 10 minutes even when nobody was looking.
 */
export function startSampler(): () => void {
  let previous = os.cpus();
  const tick = async () => {
    const current = os.cpus();
    let busy = 0;
    let total = 0;
    current.forEach((cpu, index) => {
      const before = previous[index]?.times;
      if (!before) return;
      const t = cpu.times;
      const idle = t.idle - before.idle;
      const all = t.user - before.user + (t.nice - before.nice) + (t.sys - before.sys) + (t.irq - before.irq) + idle;
      busy += all - idle;
      total += all;
    });
    previous = current;
    if (total > 0) lastCpuPct = (busy / total) * 100;
    lastMemory = await memory().catch(() => lastMemory);
    if (lastCpuPct === null || !lastMemory) return;
    const { memory: m, swap } = lastMemory;
    history.push({ t: Date.now(), cpu: lastCpuPct / 100, mem: m.usedBytes / m.totalBytes, swap: swap ? swap.usedBytes / swap.totalBytes : 0 });
    if (history.length > HISTORY_POINTS) history.splice(0, history.length - HISTORY_POINTS);
  };
  const first = setTimeout(tick, 1_000); // a first value soon after (re)start
  const timer = setInterval(tick, 5_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

async function meminfo(): Promise<Record<string, number>> {
  const text = await readFile("/proc/meminfo", "utf8");
  const values: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  return values;
}

async function memory(): Promise<Pick<Snapshot, "memory" | "swap">> {
  const totalBytes = os.totalmem();
  if (process.platform === "linux") {
    const m = await meminfo();
    return {
      memory: { totalBytes, usedBytes: totalBytes - (m.MemAvailable ?? os.freemem()) },
      swap: m.SwapTotal ? { totalBytes: m.SwapTotal, usedBytes: m.SwapTotal - (m.SwapFree ?? 0) } : null,
    };
  }
  // macOS: os.freemem() leaves out reclaimable cache; memory_pressure reports what is really free.
  const pressure = await run("memory_pressure", ["-Q"]).catch(() => "");
  const freePct = Number(/free percentage:\s*(\d+)/.exec(pressure)?.[1] ?? NaN);
  const usedBytes = Number.isFinite(freePct) ? totalBytes * (1 - freePct / 100) : totalBytes - os.freemem();
  const swapText = await run("sysctl", ["-n", "vm.swapusage"]).catch(() => "");
  const mb = (key: string) => Number(new RegExp(`${key} = ([\\d.]+)M`).exec(swapText)?.[1] ?? 0) * 1024 ** 2;
  return {
    memory: { totalBytes, usedBytes: Math.round(usedBytes) },
    swap: mb("total") ? { totalBytes: mb("total"), usedBytes: mb("used") } : null,
  };
}

/** Mount points mounted read-only: installer disk images, the sealed macOS system volume. */
async function readOnlyMounts(): Promise<Set<string>> {
  const result = new Set<string>();
  for (const line of (await run("mount", []).catch(() => "")).split("\n")) {
    const mount = readOnlyMount(line);
    if (mount) result.add(mount);
  }
  return result;
}

/** macOS: "dev on /path (apfs, local, read-only)"; Linux: "dev on /path type ext4 (ro,relatime)". */
export function readOnlyMount(line: string): string | null {
  const match = /^\S+ on (.+?) (?:type \S+ )?\(([^)]*)\)$/.exec(line);
  const options = match?.[2].split(",").map((option) => option.trim()) ?? [];
  return match && (options.includes("read-only") || options.includes("ro")) ? match[1] : null;
}

async function disks(): Promise<Snapshot["disks"]> {
  const [text, readOnly] = await Promise.all([run("df", ["-kP"]), readOnlyMounts()]);
  const seen = new Set<string>();
  const result: Snapshot["disks"] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const [device, size, used] = cols;
    const mount = cols.slice(5).join(" ");
    if (!device.startsWith("/dev/") || device.startsWith("/dev/loop") || seen.has(device)) continue;
    if (/^\/(boot|snap)(\/|$)/.test(mount) || readOnly.has(mount)) continue;
    // macOS: "/" is the sealed system snapshot; the Data volume holds everything you can fill.
    if (process.platform === "darwin" && mount !== "/System/Volumes/Data" && !mount.startsWith("/Volumes/")) continue;
    seen.add(device);
    result.push({
      mount: mount === "/System/Volumes/Data" ? "/" : mount,
      totalBytes: Number(size) * 1024,
      usedBytes: Number(used) * 1024,
    });
  }
  return result;
}

const INTERPRETER = /^(node|bun|deno|python[\d.]*|Python|ruby|perl|php|java)$/;
// java options whose value is the next word
const JAVA_VALUE_OPTIONS = new Set(["-cp", "-classpath", "--class-path", "-p", "--module-path", "-m", "--module"]);

/**
 * A readable name: the executable, or for interpreters the script or main class they run, so
 * a dozen node processes show up as "tsserver" and "playwright-mcp" instead of "node".
 */
export function processName(command: string, args: string): string {
  if (command.includes("/claude/versions/")) return "claude";
  const exe = path.basename(command.trim());
  if (!INTERPRETER.test(exe)) return exe;
  const words = args.trim().split(/\s+/).slice(1);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (exe === "java") {
      if (w === "-jar" && words[i + 1]) return path.basename(words[i + 1]);
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

/** macOS memory per process including compressed pages; `ps` RSS leaves those out. */
async function macFootprints(): Promise<Map<number, number>> {
  const text = await run("top", ["-l", "1", "-o", "mem", "-n", "200", "-stats", "pid,mem"], 20_000).catch(() => "");
  const unit: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  const result = new Map<number, number>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+([\d.]+)([BKMG])[+-]?\s*$/.exec(line);
    if (match) result.set(Number(match[1]), Number(match[2]) * unit[match[3]]);
  }
  return result;
}

async function processes(): Promise<Pick<Snapshot, "topCpu" | "topMemory" | "apps">> {
  const [psText, argsText, footprints] = await Promise.all([
    run("ps", ["-axo", "pid=,ppid=,pcpu=,pmem=,rss=,user=,comm="]),
    run("ps", ["-axo", "pid=,args="]),
    process.platform === "darwin" ? macFootprints() : Promise.resolve(new Map<number, number>()),
  ]);
  const args = new Map<number, string>();
  for (const line of argsText.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) args.set(Number(match[1]), match[2]);
  }
  const all: ProcessInfo[] = [];
  for (const line of psText.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    // skip what this plugin itself spawned (this very `ps`, docker CLI calls)
    if (!match || Number(match[2]) === process.pid) continue;
    const pid = Number(match[1]);
    all.push({
      pid,
      cpuPct: Number(match[3]),
      memPct: Number(match[4]),
      memBytes: footprints.get(pid) ?? Number(match[5]) * 1024,
      user: match[6],
      name: processName(match[7], args.get(pid) ?? ""),
    });
  }
  const top = (key: "cpuPct" | "memBytes") => [...all].sort((a, b) => b[key] - a[key]).slice(0, 12);
  const groups = new Map<string, App>();
  for (const p of all) {
    const name = appName(p.name);
    const g = groups.get(name) ?? { name, count: 0, memBytes: 0, cpuPct: 0 };
    groups.set(name, { name, count: g.count + 1, memBytes: g.memBytes + p.memBytes, cpuPct: g.cpuPct + p.cpuPct });
  }
  const apps = [...groups.values()].sort((a, b) => b.memBytes - a.memBytes).slice(0, 10);
  return { topCpu: top("cpuPct"), topMemory: top("memBytes"), apps };
}

export async function systemSnapshot(): Promise<Omit<Snapshot, "takenAt" | "docker">> {
  const cpus = os.cpus();
  const [mem, diskList, procs] = await Promise.all([lastMemory ?? memory(), disks(), processes()]);
  const [l1, l5, l15] = os.loadavg();
  return {
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      uptimeSec: os.uptime(),
      cpuModel: cpus[0]?.model.trim() ?? "unknown",
      cpuCount: cpus.length,
    },
    cpuPct: lastCpuPct,
    load: [l1, l5, l15],
    ...mem,
    disks: diskList,
    ...procs,
    history: [...history],
  };
}
