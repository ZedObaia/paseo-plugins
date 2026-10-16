import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessInfo, Snapshot } from "../shared/contracts";
import { run } from "./exec";

let lastCpuPct: number | null = null;

/** Samples overall CPU use every 2 s so a snapshot never waits for a second reading. */
export function startCpuSampler(): () => void {
  let previous = os.cpus();
  const timer = setInterval(() => {
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
  }, 2_000);
  timer.unref();
  return () => clearInterval(timer);
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

async function processes(): Promise<Pick<Snapshot, "topCpu" | "topMemory">> {
  const text = await run("ps", ["-axo", "pid=,pcpu=,pmem=,rss=,user=,comm="]);
  const all: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    all.push({
      pid: Number(match[1]),
      cpuPct: Number(match[2]),
      memPct: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      user: match[5],
      name: path.basename(match[6].trim()),
    });
  }
  const top = (key: "cpuPct" | "rssBytes") => [...all].sort((a, b) => b[key] - a[key]).slice(0, 12);
  return { topCpu: top("cpuPct"), topMemory: top("rssBytes") };
}

export async function systemSnapshot(): Promise<Omit<Snapshot, "takenAt" | "docker">> {
  const cpus = os.cpus();
  const [mem, diskList, procs] = await Promise.all([memory(), disks(), processes()]);
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
  };
}
