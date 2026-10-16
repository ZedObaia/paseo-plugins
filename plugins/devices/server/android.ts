import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type * as GrpcType from "@grpc/grpc-js";
import type * as ProtoLoaderType from "@grpc/proto-loader";
import type { Device } from "../shared/contracts";
import { run, runBuffer, waitFor } from "./exec";
import type { Frame } from "./frames";
import { pluginRequire } from "./paths";

const SDK = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(os.homedir(), process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk"),
].find((dir): dir is string => Boolean(dir && existsSync(dir)));
const ADB = SDK && existsSync(path.join(SDK, "platform-tools/adb")) ? path.join(SDK, "platform-tools/adb") : "adb";
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
  if (process.platform === "darwin") return [path.join(os.homedir(), "Library/Caches/TemporaryItems/avd/running")];
  const uid = os.userInfo().uid;
  return [process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, path.join(os.homedir(), ".android")].map((d) => path.join(d, "avd/running"));
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
      const get = (key: string) => new RegExp(`^${key.replace(".", "\\.")}=(.*)$`, "m").exec(text)?.[1]?.trim();
      const port = Number(get("port.serial"));
      if (port) result.set(port, { avd: get("avd.name") ?? "", grpcPort: Number(get("grpc.port")) || undefined, token: get("grpc.token") });
    }
  }
  return result;
}

// Extra instances started by this plugin with -read-only (several can run from one AVD).
const extras = new Set<string>();

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
    if (!serial || !status) continue;
    const port = /^emulator-(\d+)$/.exec(serial)?.[1];
    if (port) {
      const avd = running.get(Number(port))?.avd ?? "";
      if (avd && !extras.has(serial) && !primary.has(avd)) {
        primary.set(avd, serial);
        continue;
      }
      result.push({ id: `android:${serial}`, platform: "android", name: avd ? `${avd.replace(/_/g, " ")} (extra)` : serial, detail: avd || "emulator", state: "booted", kind: "emulator" });
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
  for (const avd of avdText.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("INFO"))) {
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

/** "avd:<name>" -> the serial of that AVD's running normal instance; "android:<serial>" -> serial. */
export async function serialOf(deviceId: string): Promise<string | null> {
  if (deviceId.startsWith("android:")) return deviceId.slice("android:".length);
  const avd = deviceId.slice("avd:".length);
  const running = runningEmulators();
  const serials = (await adb(["devices"])).split("\n").map((l) => l.split(/\s+/)[0]);
  for (const serial of serials) {
    const port = Number(/^emulator-(\d+)$/.exec(serial ?? "")?.[1]);
    if (port && running.get(port)?.avd === avd && !extras.has(serial)) return serial;
  }
  return null;
}

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer().once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

/**
 * Starts an AVD headless with a token-protected, localhost-only gRPC port. Returns its serial at
 * once and `ready`, which settles when Android finished booting (that can take minutes).
 */
export async function launchAvd(avd: string, readOnly: boolean): Promise<{ serial: string; ready: Promise<void> }> {
  const used = new Set((await adb(["devices"])).split("\n").map((l) => l.split(/\s+/)[0]));
  let port = 0;
  for (let p = 5554; p <= 5680 && !port; p += 2) {
    if (!used.has(`emulator-${p}`) && (await portFree(p)) && (await portFree(p + 1)) && (await portFree(8554 + p - 5554))) port = p;
  }
  if (!port) throw new Error("No free emulator port");
  const serial = `emulator-${port}`;
  const args = ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-port", String(port), "-grpc", String(8554 + port - 5554), "-grpc-use-token"];
  // Detached: emulators keep running across plugin reloads and daemon restarts.
  spawn(EMULATOR, readOnly ? [...args, "-read-only"] : args, { detached: true, stdio: "ignore" }).unref();
  if (readOnly) extras.add(serial);
  const ready = waitFor(
    async () => (await adb(["-s", serial, "shell", "getprop", "sys.boot_completed"], 5_000)).trim() === "1",
    300_000,
    `${avd} to boot`,
  );
  return { serial, ready };
}

export async function shutdownAndroid(serial: string): Promise<void> {
  if (!serial.startsWith("emulator-")) throw new Error("A USB device can't be powered off from here");
  await adb(["-s", serial, "emu", "kill"]);
  extras.delete(serial);
  clients.delete(serial);
}

// --- frames: emulator gRPC (fast, already scaled) or screencap for USB devices ---

const grpc = pluginRequire("@grpc/grpc-js") as typeof GrpcType;
const protoLoader = pluginRequire("@grpc/proto-loader") as typeof ProtoLoaderType;
type ScreenshotReply = { image: Buffer; format: { width: number; height: number } };
interface Controller {
  getScreenshot(req: object, meta: GrpcType.Metadata, cb: (error: Error | null, reply: ScreenshotReply) => void): void;
}
let controllerClass: (new (address: string, creds: GrpcType.ChannelCredentials, options: object) => Controller) | undefined;
const clients = new Map<string, { controller: Controller; meta: GrpcType.Metadata }>();
const sizes = new Map<string, { width: number; height: number }>();
let seq = 0;

function controllerFor(serial: string) {
  const cached = clients.get(serial);
  if (cached) return cached;
  const info = runningEmulators().get(Number(/^emulator-(\d+)$/.exec(serial)?.[1]));
  if (!info?.grpcPort || !SDK) return null;
  if (!controllerClass) {
    const definition = protoLoader.loadSync(path.join(SDK, "emulator/lib/emulator_controller.proto"), { keepCase: true, enums: String, defaults: true });
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
        client.controller.getScreenshot({ format: "RGB888" }, client.meta, (error, r) => (error ? reject(error) : resolve(r))),
      );
      const { width, height } = reply.format;
      sizes.set(serial, { width, height });
      return { seq: ++seq, image: reply.image, raw: { width, height } };
    } catch {
      clients.delete(serial); // fall back to screencap below; reconnect next time
    }
  }
  return { seq: ++seq, image: await runBuffer(ADB, ["-s", serial, "exec-out", "screencap", "-p"], 20_000) };
}

// --- input through adb, in the screen's current (rotated) pixels ---

async function size(serial: string) {
  const known = sizes.get(serial);
  if (known) return known;
  const match = /(\d+)x(\d+)\s*$/.exec((await adb(["-s", serial, "shell", "wm", "size"])).trim());
  const result = { width: Number(match?.[1] ?? 1080), height: Number(match?.[2] ?? 1920) };
  sizes.set(serial, result);
  return result;
}

const shell = (serial: string, command: string) => adb(["-s", serial, "shell", command]);

async function px(serial: string, p: { x: number; y: number }) {
  const s = await size(serial);
  return `${Math.round(p.x * (s.width - 1))} ${Math.round(p.y * (s.height - 1))}`;
}

export async function androidTap(serial: string, x: number, y: number, holdMs: number) {
  const at = await px(serial, { x, y });
  await shell(serial, holdMs > 400 ? `input swipe ${at} ${at} ${holdMs}` : `input tap ${at}`);
}

export async function androidSwipe(serial: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number) {
  await shell(serial, `input swipe ${await px(serial, from)} ${await px(serial, to)} ${durationMs}`);
}

/** `input text` takes %s for spaces; single-quote the rest for the device shell. */
export async function androidText(serial: string, text: string) {
  await shell(serial, `input text '${text.replace(/ /g, "%s").replace(/'/g, "'\\''")}'`);
}

const KEYS: Record<string, number> = { home: 3, back: 4, lock: 26, volumeUp: 24, volumeDown: 25, appSwitch: 187 };

export async function androidButton(serial: string, button: string) {
  await shell(serial, `input keyevent ${KEYS[button]}`);
}

export async function androidRotate(serial: string, orientation: "portrait" | "landscape") {
  await shell(serial, `settings put system accelerometer_rotation 0; settings put system user_rotation ${orientation === "portrait" ? 0 : 1}`);
  sizes.delete(serial);
}
