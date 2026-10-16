import http from "node:http";
import type WebSocketType from "ws";
import type { Device } from "../shared/contracts";
import { run, sleep, waitFor } from "./exec";
import type { Frame } from "./frames";
import { dependencyFile, pluginRequire } from "./paths";

const WebSocket = pluginRequire("ws") as typeof WebSocketType;
const SERVE_SIM = dependencyFile("serve-sim", "dist/serve-sim.js");
// Inside the desktop app the plugin runs on Electron's binary; serve-sim wants a plain Node.
const NODE = process.versions.electron ? "node" : process.execPath;
const serveSim = (args: string[], timeoutMs = 30_000) => run(NODE, [SERVE_SIM, ...args], timeoutMs);
const simctl = (args: string[], timeoutMs?: number) => run("xcrun", ["simctl", ...args], timeoutMs);

export async function iosAvailability(): Promise<{ available: boolean; reason: string }> {
  if (process.platform !== "darwin") return { available: false, reason: "iOS simulators need a Mac" };
  try {
    await simctl(["help"], 10_000);
    return { available: true, reason: "" };
  } catch {
    return { available: false, reason: "Xcode command line tools (xcrun simctl) aren't installed" };
  }
}

type SimctlDevice = { udid: string; name: string; state: string; deviceTypeIdentifier: string };
const kinds = new Map<string, { type: string; runtime: string }>();

export async function listIos(): Promise<Omit<Device, "owned" | "error">[]> {
  const json = JSON.parse(await simctl(["list", "devices", "available", "-j"])) as { devices: Record<string, SimctlDevice[]> };
  const result: Omit<Device, "owned" | "error">[] = [];
  for (const [runtime, devices] of Object.entries(json.devices)) {
    if (!runtime.includes("SimRuntime.iOS-")) continue;
    const version = runtime.replace(/^.*SimRuntime\.iOS-/, "").replace(/-/g, ".");
    for (const d of devices) {
      kinds.set(d.udid, { type: d.deviceTypeIdentifier, runtime });
      result.push({
        id: `ios:${d.udid}`,
        platform: "ios",
        name: d.name,
        detail: `iOS ${version}`,
        state: d.state === "Booted" ? "booted" : d.state === "Booting" ? "booting" : "shutdown",
        kind: "simulator",
      });
    }
  }
  return result;
}

export async function bootIos(udid: string): Promise<void> {
  await simctl(["boot", udid]).catch((error: Error) => {
    if (!/current state: Booted/.test(error.message)) throw error;
  });
  await simctl(["bootstatus", udid, "-b"], 300_000);
}

export async function shutdownIos(udid: string): Promise<void> {
  await stopSession(udid);
  await simctl(["shutdown", udid]).catch((error: Error) => {
    if (!/current state: Shutdown/.test(error.message)) throw error;
  });
}

/** A new simulator of the same model and iOS version as `fromUdid`. */
export async function createIos(fromUdid: string, name: string): Promise<string> {
  if (!kinds.has(fromUdid)) await listIos();
  const kind = kinds.get(fromUdid);
  if (!kind) throw new Error("Unknown simulator");
  return (await simctl(["create", name, kind.type, kind.runtime], 120_000)).trim();
}

export async function deleteIos(udid: string): Promise<void> {
  await shutdownIos(udid);
  await simctl(["delete", udid], 60_000);
}

// --- live view: one serve-sim helper per booted simulator, used while a panel polls it ---

interface Session {
  udid: string;
  wsUrl: string;
  frame?: Frame;
  seq: number;
  lastUsed: number;
  closed: boolean;
  // consecutive stream failures; the helper is presumed dead after a few
  failures: number;
  stream?: http.ClientRequest;
  ws?: Promise<WebSocketType>;
}

const sessions = new Map<string, Promise<Session>>();
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function readStream(s: Session, url: string): void {
  if (s.closed) return;
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    // The helper exits with its simulator (or Simulator.app): forget it so the next call starts one.
    if (++s.failures >= 3) return void forgetSession(s);
    setTimeout(() => readStream(s, url), 1_000);
  };
  s.stream = http.get(url, (res) => {
    s.failures = 0;
    let pending = Buffer.alloc(0);
    res.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      // JPEG data byte-stuffs 0xFF, so FFD8...FFD9 delimits exactly one frame.
      for (;;) {
        const start = pending.indexOf(SOI);
        const end = start < 0 ? -1 : pending.indexOf(EOI, start + 2);
        if (end < 0) break;
        s.frame = { seq: ++s.seq, image: Buffer.from(pending.subarray(start, end + 2)) };
        pending = pending.subarray(end + 2);
      }
      if (pending.length > 16 * 1024 * 1024) pending = Buffer.alloc(0);
    });
    res.on("end", retry);
  });
  s.stream.on("error", retry);
}

function session(udid: string): Promise<Session> {
  const existing = sessions.get(udid);
  if (existing) return existing.then((s) => ((s.lastUsed = Date.now()), s));
  // The helper needs Simulator.app and launches it in front if it isn't running. Starting it
  // hidden first (-j) keeps it off the screen; a window the user opened stays as it is.
  const created = run("open", ["-g", "-j", "-a", "Simulator"])
    .catch(() => "")
    .then(() => serveSim(["--detach", "-q", udid], 60_000))
    .then((out) => {
    const info = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { streamUrl?: string; url?: string; wsUrl?: string };
    const streamUrl = info.streamUrl ?? `${info.url}/stream.mjpeg`;
    if (!info.wsUrl || !streamUrl.startsWith("http")) throw new Error("serve-sim returned no stream");
    const s: Session = { udid, wsUrl: info.wsUrl, seq: 0, lastUsed: Date.now(), closed: false, failures: 0 };
    readStream(s, streamUrl);
    return s;
  });
  sessions.set(udid, created);
  created.catch(() => sessions.delete(udid));
  return created;
}

function forgetSession(s: Session): void {
  s.closed = true;
  s.stream?.destroy();
  void sessions.get(s.udid)?.then((current) => current === s && sessions.delete(s.udid));
}

const isConnectionError = (error: unknown) => /ECONNREFUSED|ECONNRESET|socket hang up|closed/i.test(String(error));

/** Runs fn with the live session; if its helper is gone, starts a new helper and tries once more. */
async function withSession<T>(udid: string, fn: (s: Session) => Promise<T>): Promise<T> {
  const s = await session(udid);
  try {
    return await fn(s);
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    forgetSession(s);
    return fn(await session(udid));
  }
}

async function stopSession(udid: string): Promise<void> {
  const pending = sessions.get(udid);
  if (!pending) return;
  sessions.delete(udid);
  const s = await pending.catch(() => null);
  if (!s) return;
  s.closed = true;
  s.stream?.destroy();
  (await s.ws?.catch(() => null))?.close();
  await serveSim(["--kill", udid]).catch(() => {});
}

/** Stops the helpers nobody has looked at for a minute. */
export function startIdleReaper(): () => void {
  const timer = setInterval(async () => {
    for (const [udid, pending] of sessions) {
      const s = await pending.catch(() => null);
      if (s && Date.now() - s.lastUsed > 60_000) await stopSession(udid);
    }
  }, 15_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const udid of [...sessions.keys()]) void stopSession(udid);
  };
}

export async function iosFrame(udid: string): Promise<Frame | null> {
  const s = await session(udid);
  if (!s.frame) await waitFor(async () => Boolean(s.frame), 5_000, "the first frame").catch(() => {});
  return s.frame ?? null;
}

function socket(s: Session): Promise<WebSocketType> {
  s.ws ??= new Promise<WebSocketType>((resolve, reject) => {
    const ws = new WebSocket(s.wsUrl);
    ws.once("open", () => resolve(ws));
    ws.once("error", (error) => ((s.ws = undefined), reject(error)));
    ws.once("close", () => (s.ws = undefined));
  });
  return s.ws;
}

// serve-sim's control socket: tag 0x03, then the touch as JSON with x, y in 0..1
const touch = (ws: WebSocketType, type: "begin" | "move" | "end", x: number, y: number) =>
  ws.send(Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify({ type, x, y }))]));

export async function iosTap(udid: string, x: number, y: number, holdMs: number): Promise<void> {
  await withSession(udid, async (s) => {
    const ws = await socket(s);
    touch(ws, "begin", x, y);
    await sleep(Math.max(holdMs, 30));
    touch(ws, "end", x, y);
  });
}

export async function iosSwipe(udid: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number) {
  await withSession(udid, async (s) => {
    const ws = await socket(s);
    const steps = Math.max(2, Math.round(durationMs / 16));
    touch(ws, "begin", from.x, from.y);
    for (let i = 1; i < steps; i++) {
      await sleep(16);
      touch(ws, "move", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    }
    await sleep(16);
    touch(ws, "end", to.x, to.y);
  });
}

export async function iosText(udid: string, text: string): Promise<void> {
  await serveSim(["type", "-d", udid, "--", text]);
}

export async function iosButton(udid: string, button: string): Promise<void> {
  const name = { home: "home", lock: "lock" }[button];
  if (!name) throw new Error(`iOS simulators have no ${button} button`);
  await serveSim(["button", name, "-d", udid]);
}

export async function iosRotate(udid: string, orientation: "portrait" | "landscape"): Promise<void> {
  await serveSim(["rotate", orientation === "portrait" ? "portrait" : "landscape_left", "-d", udid]);
}
