import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type * as GrpcType from "@grpc/grpc-js";
import type * as ProtoLoaderType from "@grpc/proto-loader";
import { LONG_PRESS_MS, deviceId, type Device } from "../shared/contracts";
import { run, runBuffer, waitFor } from "./exec";
import type { Frame } from "./frames";
import { pluginRequire } from "./paths";
import { isOwned } from "./state";

const SDK = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(os.homedir(), process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk"),
].find((dir): dir is string => Boolean(dir && existsSync(dir)));
const ADB =
  SDK && existsSync(path.join(SDK, "platform-tools/adb")) ? path.join(SDK, "platform-tools/adb") : "adb";
const EMULATOR = SDK ? path.join(SDK, "emulator/emulator") : "emulator";
const adb = (args: string[], timeoutMs?: number) => run(ADB, args, timeoutMs);

export async function androidAvailability(): Promise<{ available: boolean; reason: string }> {
  try {
    await adb(["version"], 10_000);
    return { available: true, reason: "" };
  } catch {
    return { available: false, reason: "Android SDK platform-tools (adb) aren't installed" };
  }
}

// --- running emulators: the emulator writes pid_<pid>.ini with its ports and gRPC token ---

interface Running {
  avd: string;
  grpcPort?: number;
  token?: string;
}

function discoveryDirs(): string[] {
  if (process.platform === "darwin")
    return [path.join(os.homedir(), "Library/Caches/TemporaryItems/avd/running")];
  const uid = os.userInfo().uid;
  return [process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, path.join(os.homedir(), ".android")].map((d) =>
    path.join(d, "avd/running"),
  );
}

/** Console port (the N in emulator-N) to what that live emulator published. */
function runningEmulators(): Map<number, Running> {
  const result = new Map<number, Running>();
  for (const dir of discoveryDirs().filter(existsSync)) {
    for (const file of readdirSync(dir).filter((f) => /^pid_\d+\.ini$/.test(f))) {
      const pid = Number(file.slice(4, -4));
      try {
        process.kill(pid, 0);
      } catch {
        continue; // stale file from an emulator that exited
      }
      const text = readFileSync(path.join(dir, file), "utf8");
      const get = (key: string) =>
        new RegExp(`^${key.replace(".", "\\.")}=(.*)$`, "m").exec(text)?.[1]?.trim();
      const port = Number(get("port.serial"));
      if (port)
        result.set(port, {
          avd: get("avd.name") ?? "",
          grpcPort: Number(get("grpc.port")) || undefined,
          token: get("grpc.token"),
        });
    }
  }
  return result;
}

/** A "New copy": an extra read-only instance of an AVD that this plugin started for a workspace. */
const isCopy = (serial: string) => isOwned(`android:${serial}`);

export async function listAndroid(): Promise<Omit<Device, "owned" | "error">[]> {
  const [devicesText, avdText] = await Promise.all([
    adb(["devices", "-l"]),
    existsSync(EMULATOR) ? run(EMULATOR, ["-list-avds"]).catch(() => "") : Promise.resolve(""),
  ]);
  const running = runningEmulators();
  const primary = new Map<string, string>(); // AVD name -> serial of its normal instance
  const result: Omit<Device, "owned" | "error">[] = [];
  for (const line of devicesText.split("\n").slice(1)) {
    const [serial, status] = line.trim().split(/\s+/);
    // a serial the contract can't carry (`adb connect [fe80::1]:5555`) would fail the whole list
    if (!serial || !status || !deviceId.safeParse(`android:${serial}`).success) continue;
    const port = /^emulator-(\d+)$/.exec(serial)?.[1];
    if (port) {
      const avd = running.get(Number(port))?.avd ?? "";
      if (avd && !isCopy(serial) && !primary.has(avd)) {
        primary.set(avd, serial);
        continue;
      }
      const name = avd ? `${avd.replace(/_/g, " ")} (${serial})` : serial;
      const detail = isCopy(serial) ? "Android emulator, read-only copy" : "Android emulator";
      result.push({
        id: `android:${serial}`,
        platform: "android",
        name,
        detail,
        state: "booted",
        kind: "emulator",
      });
      continue;
    }
    const model = /model:(\S+)/.exec(line)?.[1]?.replace(/_/g, " ") ?? serial;
    result.push({
      id: `android:${serial}`,
      platform: "android",
      name: model,
      detail: status === "device" ? "USB device" : `USB device (${status})`,
      state: status === "device" ? "booted" : "shutdown",
      kind: "physical",
    });
  }
  for (const avd of avdText
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("INFO"))) {
    result.unshift({
      id: `avd:${avd}`,
      platform: "android",
      name: avd.replace(/_/g, " "),
      detail: "Android emulator",
      state: primary.has(avd) ? "booted" : "shutdown",
      kind: "avd",
    });
  }
  return result;
}

const avdSerials = new Map<string, { serial: string | null; at: number }>();

/** "avd:<name>" -> the serial of that AVD's running normal instance; "android:<serial>" -> serial. */
export async function serialOf(id: string): Promise<string | null> {
  if (id.startsWith("android:")) return id.slice("android:".length);
  // frames and input ask several times a second while a panel is open
  const known = avdSerials.get(id);
  if (known && Date.now() - known.at < 2_000) return known.serial;
  const avd = id.slice("avd:".length);
  const running = runningEmulators();
  const serials = (await adb(["devices"])).split("\n").map((l) => l.split(/\s+/)[0]);
  const serial =
    serials.find((s) => {
      const port = Number(/^emulator-(\d+)$/.exec(s ?? "")?.[1]);
      return port && running.get(port)?.avd === avd && !isCopy(s);
    }) ?? null;
  avdSerials.set(id, { serial, at: Date.now() });
  return serial;
}

/** Whether an emulator process for this serial is alive, whatever `adb devices` says. */
export const emulatorRunning = (serial: string) =>
  runningEmulators().has(Number(/^emulator-(\d+)$/.exec(serial)?.[1]));

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer().once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

// The emulator listens on console port N (its serial is emulator-N) and adb port N + 1. The gRPC
// port sits at the same offset from 8554, the emulator's own default.
const FIRST_CONSOLE_PORT = 5554;
const LAST_CONSOLE_PORT = 5680;
const grpcPortFor = (consolePort: number) => 8554 + consolePort - FIRST_CONSOLE_PORT;

// Ports taken by launches whose emulator hasn't bound them yet: that takes a few seconds, so
// `adb devices` and a test bind can't tell two launches apart.
const reserved = new Set<number>();

async function reservePort(): Promise<number> {
  const used = new Set((await adb(["devices"])).split("\n").map((l) => l.split(/\s+/)[0]));
  for (let p = FIRST_CONSOLE_PORT; p <= LAST_CONSOLE_PORT; p += 2) {
    if (reserved.has(p) || used.has(`emulator-${p}`)) continue;
    reserved.add(p);
    if ((await portFree(p)) && (await portFree(p + 1)) && (await portFree(grpcPortFor(p)))) return p;
    reserved.delete(p);
  }
  throw new Error("No free emulator port");
}

/**
 * Starts an AVD headless with a token-protected, localhost-only gRPC port. Returns its serial at
 * once and `ready`, which settles when Android finished booting (that can take minutes).
 */
export async function launchAvd(
  avd: string,
  readOnly: boolean,
): Promise<{ serial: string; ready: Promise<void> }> {
  if (!existsSync(EMULATOR))
    throw new Error("The Android emulator isn't installed (Android SDK emulator package)");
  const port = await reservePort();
  const serial = `emulator-${port}`;
  avdSerials.clear();
  const args = [
    "-avd",
    avd,
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-port",
    String(port),
    "-grpc",
    String(grpcPortFor(port)),
    "-grpc-use-token",
  ];
  // Detached: emulators keep running across plugin reloads and daemon restarts.
  const child = spawn(EMULATOR, readOnly ? [...args, "-read-only"] : args, {
    detached: true,
    stdio: "ignore",
  });
  const failed = new Promise<never>((_, reject) => {
    child.once("error", reject);
    // before Android booted, an exit is always a failure: a missing system image, the AVD already
    // running without -read-only, no hypervisor
    child.once("exit", (code, signal) =>
      reject(
        new Error(
          `The emulator stopped before ${avd} booted (${signal ?? `exit ${code}`}); run \`emulator -avd ${avd}\` to see why`,
        ),
      ),
    );
  });
  child.unref();
  const ready = Promise.race([
    waitFor(
      async () => (await adb(["-s", serial, "shell", "getprop", "sys.boot_completed"], 5_000)).trim() === "1",
      300_000,
      `${avd} to boot`,
    ),
    failed,
  ]);
  const release = () => void reserved.delete(port);
  ready.then(release, release);
  return { serial, ready };
}

export async function shutdownAndroid(serial: string): Promise<void> {
  if (!serial.startsWith("emulator-")) throw new Error("A USB device can't be powered off from here");
  await adb(["-s", serial, "emu", "kill"]);
  dropClient(serial);
  avdSerials.clear();
  lastFrames.delete(serial);
  // `emu kill` returns while the emulator is still listed: until it's gone, a copy would look like
  // its AVD's own instance
  const gone = async () =>
    !(await adb(["devices"])).split("\n").some((line) => line.startsWith(`${serial}\t`));
  await waitFor(gone, 20_000, `${serial} to stop`).catch(() => {});
}

// --- frames: the emulator's gRPC screenshot (milliseconds, full resolution) or screencap for USB devices (about a second) ---

const grpc = pluginRequire("@grpc/grpc-js") as typeof GrpcType;
const protoLoader = pluginRequire("@grpc/proto-loader") as typeof ProtoLoaderType;
type ScreenshotReply = { image: Buffer; format: { width: number; height: number } };
interface Controller {
  getScreenshot(
    req: object,
    meta: GrpcType.Metadata,
    options: GrpcType.CallOptions,
    cb: (error: Error | null, reply: ScreenshotReply) => void,
  ): void;
  setPhysicalModel(
    req: object,
    meta: GrpcType.Metadata,
    options: GrpcType.CallOptions,
    cb: (error: Error | null) => void,
  ): void;
  close(): void;
}
let controllerClass:
  | (new (address: string, creds: GrpcType.ChannelCredentials, options: object) => Controller)
  | undefined;
const clients = new Map<string, { controller: Controller; meta: GrpcType.Metadata }>();
const sizes = new Map<string, { width: number; height: number }>();
let seq = 0;

// a paused or stuck emulator never answers: give up well before the client's 60 s timeout
const deadline = () => ({ deadline: Date.now() + 5_000 });

// A still screen keeps its seq, so a polling panel gets "same" rather than the picture again.
const lastFrames = new Map<string, Frame>();
function remember(serial: string, frame: Omit<Frame, "seq">): Frame {
  const last = lastFrames.get(serial);
  if (last && last.image.equals(frame.image)) return last;
  const next = { ...frame, seq: ++seq };
  lastFrames.set(serial, next);
  return next;
}

function dropClient(serial: string): void {
  clients.get(serial)?.controller.close();
  clients.delete(serial);
}

function controllerFor(serial: string) {
  const cached = clients.get(serial);
  if (cached) return cached;
  const info = runningEmulators().get(Number(/^emulator-(\d+)$/.exec(serial)?.[1]));
  if (!info?.grpcPort || !SDK) return null;
  if (!controllerClass) {
    const definition = protoLoader.loadSync(path.join(SDK, "emulator/lib/emulator_controller.proto"), {
      keepCase: true,
      enums: String,
      defaults: true,
    });
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      android: { emulation: { control: { EmulatorController: NonNullable<typeof controllerClass> } } };
    };
    controllerClass = pkg.android.emulation.control.EmulatorController;
  }
  const meta = new grpc.Metadata();
  if (info.token) meta.add("authorization", `Bearer ${info.token}`);
  const controller = new controllerClass(`127.0.0.1:${info.grpcPort}`, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
  });
  const entry = { controller, meta };
  clients.set(serial, entry);
  return entry;
}

export async function androidFrame(serial: string): Promise<Frame> {
  const client = controllerFor(serial);
  if (client) {
    try {
      const reply = await new Promise<ScreenshotReply>((resolve, reject) =>
        client.controller.getScreenshot({ format: "RGB888" }, client.meta, deadline(), (error, r) =>
          error ? reject(error) : resolve(r),
        ),
      );
      const { width, height } = reply.format;
      sizes.set(serial, { width, height });
      return remember(serial, { image: reply.image, raw: { width, height } });
    } catch {
      dropClient(serial); // fall back to screencap below; reconnect next time
    }
  }
  const png = await runBuffer(ADB, ["-s", serial, "exec-out", "screencap", "-p"], 20_000);
  // the PNG header (IHDR) holds the screen size as currently rotated, which taps are measured in
  if (png.length >= 24) sizes.set(serial, { width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  return remember(serial, { image: png });
}

// --- input through adb, in the screen's current (rotated) pixels ---

/** The screen size from the last frame; before any, `wm size` (always portrait, so not kept). */
async function size(serial: string) {
  const known = sizes.get(serial);
  if (known) return known;
  const match = /(\d+)x(\d+)\s*$/.exec((await adb(["-s", serial, "shell", "wm", "size"])).trim());
  return { width: Number(match?.[1] ?? 1080), height: Number(match?.[2] ?? 1920) };
}

const shell = (serial: string, command: string) => adb(["-s", serial, "shell", command]);

async function px(serial: string, p: { x: number; y: number }) {
  const s = await size(serial);
  return `${Math.round(p.x * (s.width - 1))} ${Math.round(p.y * (s.height - 1))}`;
}

export async function androidTap(serial: string, x: number, y: number, holdMs: number) {
  const at = await px(serial, { x, y });
  await shell(serial, holdMs >= LONG_PRESS_MS ? `input swipe ${at} ${at} ${holdMs}` : `input tap ${at}`);
}

export async function androidSwipe(
  serial: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
) {
  await shell(serial, `input swipe ${await px(serial, from)} ${await px(serial, to)} ${durationMs}`);
}

/** `input text` takes %s for spaces; single-quote the rest for the device shell. */
export async function androidText(serial: string, text: string) {
  await shell(serial, `input text '${text.replace(/ /g, "%s").replace(/'/g, "'\\''")}'`);
}

const KEYS: Record<string, number> = {
  home: 3,
  back: 4,
  lock: 26,
  volumeUp: 24,
  volumeDown: 25,
  appSwitch: 187,
};

export async function androidButton(serial: string, button: string) {
  await shell(serial, `input keyevent ${KEYS[button]}`);
}

export async function androidRotate(serial: string, orientation: "portrait" | "landscape") {
  const client = controllerFor(serial);
  if (client) {
    // An emulator's screenshots follow its virtual rotation sensor, not user_rotation: turn the
    // sensor, with auto-rotate on so Android follows it.
    await shell(serial, "settings put system accelerometer_rotation 1");
    const data = [0, 0, orientation === "portrait" ? 0 : 90];
    await new Promise<void>((resolve, reject) =>
      client.controller.setPhysicalModel(
        { target: "ROTATION", value: { data } },
        client.meta,
        deadline(),
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  } else {
    await shell(
      serial,
      `settings put system accelerometer_rotation 0; settings put system user_rotation ${orientation === "portrait" ? 0 : 1}`,
    );
  }
  sizes.delete(serial);
}
