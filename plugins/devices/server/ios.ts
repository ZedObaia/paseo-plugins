import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type WebSocketType from "ws";
import type { Device } from "../shared/contracts";
import { keyEvents } from "../shared/keyboard";
import { run, sleep, waitFor } from "./exec";
import type { Frame } from "./frames";
import { ADDON_NODE, PLUGIN_DIR, pluginRequire } from "./paths";

const WebSocket = pluginRequire("ws") as typeof WebSocketType;
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

// --- live view: serve-sim's capture and input, in a helper that only this plugin can reach ---
//
// The helper (server/ios-helper.mjs) serves every simulator's stream and input socket on a Unix
// socket in a folder only this user can open; it has no TCP port, so web pages and other
// machines can't reach it. It runs while a panel shows a simulator and stops IDLE_MS after the
// last one closes, or with the plugin.

const IDLE_MS = 30_000;
const helperPath = (udid: string, endpoint: string) => `/.sim/helper/${encodeURIComponent(udid)}/${endpoint}`;

interface Helper {
  child: ChildProcess;
  // in a new owner-only temp folder: Unix socket paths are limited to 104 bytes, too short for a
  // deep PASEO_HOME
  socket: string;
}

let helper: Promise<Helper> | null = null;

function startHelper(): Promise<Helper> {
  if (helper) return helper;
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-devices-"));
  const socket = path.join(dir, "ios.sock");
  const started = new Promise<Helper>((resolve, reject) => {
    // stdin stays open: the helper exits when this process does
    const child = spawn(ADDON_NODE, [path.join(PLUGIN_DIR, "server", "ios-helper.mjs"), socket], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4_000)));
    child.stdout.on(
      "data",
      (chunk: Buffer) => chunk.toString().includes("ready") && resolve({ child, socket }),
    );
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new Error("The live view needs Node.js 20 or newer installed on this Mac")
          : error,
      ),
    );
    child.once("exit", (code) => {
      rmSync(dir, { recursive: true, force: true });
      if (helper === started) helper = null;
      for (const pending of sessions.values()) void pending.then(forgetSession, () => {});
      const reason = /^\w*Error\b.*$/m.exec(stderr)?.[0] ?? stderr.trim().split("\n").pop() ?? "";
      reject(new Error(`The live view helper stopped (${code ?? "killed"}): ${reason}`));
    });
  });
  helper = started;
  started.catch(() => {
    if (helper === started) helper = null;
  });
  return started;
}

function stopHelper(): void {
  const running = helper;
  helper = null;
  void running?.then(
    ({ child }) => child.kill(),
    () => {},
  );
}

interface Session {
  udid: string;
  socket: string;
  frame?: Frame;
  seq: number;
  lastUsed: number;
  closed: boolean;
  // consecutive stream failures; the simulator is presumed gone after a few
  failures: number;
  stream?: http.ClientRequest;
  ws?: Promise<WebSocketType>;
}

const sessions = new Map<string, Promise<Session>>();
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function readStream(s: Session): void {
  if (s.closed) return;
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    // a simulator that shut down (or quit with Simulator.app) ends its stream: forget it after a
    // few tries, so the next call starts over
    if (++s.failures >= 3) return void forgetSession(s);
    setTimeout(() => readStream(s), 1_000);
  };
  s.stream = http.get({ socketPath: s.socket, path: helperPath(s.udid, "stream.mjpeg") }, (res) => {
    // a stream cut off mid-way only closes the response: no "end", no request error
    res.on("close", retry);
    // a simulator that isn't booted answers 404, which counts as a failure too
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
        // an unchanged screen keeps its seq, so a polling panel can skip it
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
  // Capture needs Simulator.app; starting it hidden (-j) keeps it off the screen, and a window
  // the user opened stays as it is.
  const created = run("open", ["-g", "-j", "-a", "Simulator"])
    .catch(() => "")
    .then(startHelper)
    .then(({ socket }) => {
      const s: Session = { udid, socket, seq: 0, lastUsed: Date.now(), closed: false, failures: 0 };
      readStream(s);
      return s;
    });
  sessions.set(udid, created);
  created.catch(() => sessions.delete(udid));
  return created;
}

function forgetSession(s: Session): void {
  s.closed = true;
  s.stream?.destroy();
  void s.ws?.then(
    (ws) => ws.close(),
    () => {},
  );
  void sessions.get(s.udid)?.then(
    (current) => current === s && sessions.delete(s.udid),
    () => {}, // a newer session that failed to start is already removed by its own handler
  );
}

const isConnectionError = (error: unknown) =>
  /ECONNREFUSED|ENOENT|ECONNRESET|socket hang up|closed/i.test(String(error));

/** Runs fn with the live session; if the helper went away, starts it again and tries once more. */
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
  if (s) forgetSession(s);
}

/** Closes the sessions no panel is looking at, and the helper once none are left. */
export function startIdleReaper(): () => Promise<void> {
  const timer = setInterval(async () => {
    for (const [udid, pending] of sessions) {
      const s = await pending.catch(() => null);
      if (s && Date.now() - s.lastUsed > IDLE_MS) await stopSession(udid);
    }
    if (sessions.size === 0) stopHelper();
  }, 10_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await Promise.all([...sessions.keys()].map(stopSession));
    stopHelper();
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
    const ws = new WebSocket(`ws+unix://${s.socket}:${helperPath(s.udid, "ws")}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", (error) => ((s.ws = undefined), reject(error)));
    ws.once("close", () => (s.ws = undefined));
  });
  return s.ws;
}

// serve-sim's input socket: a tag byte, then the message as JSON
const TOUCH = 3;
const BUTTON = 4;
const KEY = 6;
const ORIENTATION = 7;
const send = (ws: WebSocketType, tag: number, message: object) =>
  ws.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(message))]));

// touches are in 0..1 of the portrait screen
const touch = (ws: WebSocketType, type: "begin" | "move" | "end", x: number, y: number) =>
  send(ws, TOUCH, { type, x, y });

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

export async function iosText(udid: string, text: string): Promise<void> {
  const events = keyEvents(text);
  await withSession(udid, async (s) => {
    const ws = await socket(s);
    for (const event of events) {
      send(ws, KEY, event);
      await sleep(4);
    }
  });
}

export async function iosButton(udid: string, button: string): Promise<void> {
  if (button !== "home" && button !== "lock") throw new Error(`iOS simulators have no ${button} button`);
  await withSession(udid, async (s) => send(await socket(s), BUTTON, { button }));
}

export async function iosRotate(udid: string, orientation: "portrait" | "landscape"): Promise<void> {
  await withSession(udid, async (s) =>
    send(await socket(s), ORIENTATION, {
      orientation: orientation === "portrait" ? "portrait" : "landscape_left",
    }),
  );
  if (orientation === "landscape") landscape.add(udid);
  else landscape.delete(udid);
}
