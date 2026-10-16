import http from "node:http";
import type WebSocketType from "ws";
import type { Device } from "../shared/contracts";
import { run, sleep, waitFor } from "./exec";
import type { Frame } from "./frames";
import { ADDON_NODE, dependencyFile, pluginRequire } from "./paths";

const WebSocket = pluginRequire("ws") as typeof WebSocketType;
const SERVE_SIM = dependencyFile("serve-sim", "dist/serve-sim.js");
const serveSim = (args: string[], timeoutMs = 30_000) =>
  run(ADDON_NODE, [SERVE_SIM, ...args], timeoutMs).catch((error: Error) => {
    if (/ENOENT/.test(error.message))
      throw new Error("The live view needs Node.js 20 or newer installed on this Mac");
    throw error;
  });
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
  const json = JSON.parse(await simctl(["list", "devices", "available", "-j"])) as {
    devices: Record<string, SimctlDevice[]>;
  };
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
  // a boot already running (another client, or the agent) is fine: bootstatus waits for it
  await simctl(["boot", udid]).catch((error: Error) => {
    if (!/current state: Boot(ed|ing)/.test(error.message)) throw error;
  });
  await simctl(["bootstatus", udid, "-b"], 300_000);
}

export async function shutdownIos(udid: string): Promise<void> {
  await stopSession(udid);
  landscape.delete(udid); // a simulator starts up in portrait
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
//
// The helper listens on 127.0.0.1 without authentication and allows any web origin, so a page
// open in this Mac's browser could watch the stream or send touches while it runs. Helpers are
// stopped as soon as no panel has polled them for IDLE_MS.

const IDLE_MS = 30_000;

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
    // a helper that dies mid-stream only closes the response: no "end", no request error
    res.on("close", retry);
    // one that lost its simulator answers 404, which counts as a failure too
    if (res.statusCode !== 200) return void res.resume();
    s.failures = 0;
    let pending = Buffer.alloc(0);
    res.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      // JPEG data byte-stuffs 0xFF, so FFD8...FFD9 delimits exactly one frame.
      for (;;) {
        const start = pending.indexOf(SOI);
        const end = start < 0 ? -1 : pending.indexOf(EOI, start + 2);
        if (end < 0) break;
        const image = pending.subarray(start, end + 2);
        // the helper re-sends an unchanged screen; keeping its seq lets a polling panel skip it
        if (!s.frame?.image.equals(image)) s.frame = { seq: ++s.seq, image: Buffer.from(image) };
        pending = pending.subarray(end + 2);
      }
      if (pending.length > 16 * 1024 * 1024) pending = Buffer.alloc(0);
    });
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
      const info = JSON.parse(out.trim().split("\n").pop() ?? "{}") as {
        streamUrl?: string;
        url?: string;
        wsUrl?: string;
      };
      const streamUrl = info.streamUrl ?? `${info.url}/stream.mjpeg`;
      if (!info.wsUrl || !streamUrl.startsWith("http")) throw new Error("serve-sim returned no stream");
      const s: Session = {
        udid,
        wsUrl: info.wsUrl,
        seq: 0,
        lastUsed: Date.now(),
        closed: false,
        failures: 0,
      };
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
  void sessions.get(s.udid)?.then(
    (current) => current === s && sessions.delete(s.udid),
    () => {}, // a newer session that failed to start is already removed by its own handler
  );
}

const isConnectionError = (error: unknown) =>
  /ECONNREFUSED|ECONNRESET|socket hang up|closed|No serve-sim server/i.test(String(error));

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

/** Stops the helpers no panel is looking at. */
export function startIdleReaper(): () => Promise<void> {
  const timer = setInterval(async () => {
    for (const [udid, pending] of sessions) {
      const s = await pending.catch(() => null);
      if (s && Date.now() - s.lastUsed > IDLE_MS) await stopSession(udid);
    }
  }, 10_000);
  timer.unref();
  // the helpers accept any web origin: make sure they're gone when the plugin stops
  return async () => {
    clearInterval(timer);
    await Promise.all([...sessions.keys()].map(stopSession));
  };
}

// serve-sim streams the screen in portrait whatever the orientation, so a landscape app arrives
// sideways. Simulators rotated from the panel are tracked here: their picture is turned upright
// and touches are mapped back onto the portrait screen.
// ponytail: a rotation made by an agent or in Simulator.app isn't seen; rotating from the panel
// puts it right. simctl doesn't report the orientation of a phone simulator.
const landscape = new Set<string>();

export async function iosFrame(udid: string): Promise<Frame | null> {
  const s = await session(udid);
  if (!s.frame) await waitFor(async () => Boolean(s.frame), 5_000, "the first frame").catch(() => {});
  return s.frame ? { ...s.frame, rotate: landscape.has(udid) ? 90 : 0 } : null;
}

/** A point on the picture as shown to the same point on the portrait screen. */
const onScreen = (udid: string, p: { x: number; y: number }) =>
  landscape.has(udid) ? { x: p.y, y: 1 - p.x } : p;

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
  const at = onScreen(udid, { x, y });
  await withSession(udid, async (s) => {
    const ws = await socket(s);
    touch(ws, "begin", at.x, at.y);
    await sleep(Math.max(holdMs, 30));
    touch(ws, "end", at.x, at.y);
  });
}

export async function iosSwipe(
  udid: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  durationMs: number,
) {
  const from = onScreen(udid, start);
  const to = onScreen(udid, end);
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

// The CLI commands below talk to the running helper, so they go through withSession too.

export async function iosText(udid: string, text: string): Promise<void> {
  await withSession(udid, () => serveSim(["type", "-d", udid, "--", text]));
}

export async function iosButton(udid: string, button: string): Promise<void> {
  const name = { home: "home", lock: "lock" }[button];
  if (!name) throw new Error(`iOS simulators have no ${button} button`);
  await withSession(udid, () => serveSim(["button", name, "-d", udid]));
}

export async function iosRotate(udid: string, orientation: "portrait" | "landscape"): Promise<void> {
  await withSession(udid, () =>
    serveSim(["rotate", orientation === "portrait" ? "portrait" : "landscape_left", "-d", udid]),
  );
  if (orientation === "landscape") landscape.add(udid);
  else landscape.delete(udid);
}
