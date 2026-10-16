import type { PluginServerContext } from "@getpaseo/plugin/server";
import { assignRpc, createRpc, frameRpc, inputRpc, listRpc, powerRpc, type Device } from "./shared/contracts";
import * as android from "./server/android";
import { injectDeviceTools, writeAgentConfig } from "./server/agents";
import { encode, forget, type Frame } from "./server/frames";
import * as ios from "./server/ios";
import { assignments, isOwned, loadState, setAssignment, setOwned } from "./server/state";

// Boots run in the background (they outlast the client's 60 s RPC timeout); the list reports them.
const booting = new Map<string, Promise<void>>();
const failures = new Map<string, string>();

function track(deviceId: string, work: Promise<unknown>): void {
  failures.delete(deviceId);
  const done = work
    .then(async () => {
      // an emulator that came back under a new serial: point its workspace's agents at it
      for (const a of assignments().filter((x) => x.deviceId === deviceId)) await writeAgentConfig(a);
    })
    .catch((error: unknown) => void failures.set(deviceId, error instanceof Error ? error.message : String(error)))
    .finally(() => booting.delete(deviceId));
  booting.set(deviceId, done);
}

let availability: { at: number; value: ReturnType<typeof checkAvailability> } | null = null;
const checkAvailability = () => Promise.all([ios.iosAvailability(), android.androidAvailability()]);
function available() {
  if (!availability || Date.now() - availability.at > 60_000) availability = { at: Date.now(), value: checkAvailability() };
  return availability.value;
}

async function listDevices(): Promise<Device[]> {
  const [iosOk, androidOk] = await available();
  const lists = await Promise.all([iosOk.available ? ios.listIos() : [], androidOk.available ? android.listAndroid() : []]);
  const devices: Device[] = lists.flat().map((d) => ({
    ...d,
    state: booting.has(d.id) ? "booting" : d.state,
    owned: isOwned(d.id),
    error: failures.get(d.id) ?? null,
  }));
  // a new emulator isn't in `adb devices` for its first seconds
  for (const id of booting.keys()) {
    if (devices.some((d) => d.id === id)) continue;
    const platform = id.startsWith("ios:") ? "ios" : "android";
    devices.push({ id, platform, name: "Starting…", detail: "", state: "booting", kind: platform === "ios" ? "simulator" : "emulator", owned: isOwned(id), error: null });
  }
  return devices;
}

async function frameOf(deviceId: string): Promise<Frame | null> {
  if (deviceId.startsWith("ios:")) return ios.iosFrame(deviceId.slice(4));
  const serial = await android.serialOf(deviceId);
  if (!serial) throw new Error("The emulator is off");
  return android.androidFrame(serial);
}

async function serial(deviceId: string): Promise<string> {
  const s = await android.serialOf(deviceId);
  if (!s) throw new Error("The emulator is off");
  return s;
}

export default function contribute(server: PluginServerContext) {
  const ready = loadState();
  const stopReaper = ios.startIdleReaper();
  injectDeviceTools(server, ready);

  server.handle(listRpc, async () => {
    await ready;
    const [[iosOk, androidOk], devices] = await Promise.all([available(), listDevices()]);
    return { ios: iosOk, android: androidOk, devices, assignments: [...assignments()] };
  });

  server.handle(assignRpc, async ({ deviceId, takeOver, ...workspace }) => {
    await ready;
    const message = await setAssignment(workspace, deviceId, takeOver);
    const mine = assignments().find((a) => a.workspaceId === workspace.workspaceId);
    if (mine) await writeAgentConfig(mine);
    return { message };
  });

  server.handle(createRpc, async ({ from, ...workspace }) => {
    await ready;
    let deviceId: string;
    if (from.startsWith("ios:")) {
      const source = (await ios.listIos()).find((d) => d.id === from);
      const udid = await ios.createIos(from.slice(4), `${source?.name ?? "iPhone"} (${workspace.workspaceName})`);
      deviceId = `ios:${udid}`;
      track(deviceId, ios.bootIos(udid));
    } else if (from.startsWith("avd:")) {
      // a read-only instance: runs next to the AVD's normal one, forgets its changes on shutdown
      const started = await android.launchAvd(from.slice(4), true);
      deviceId = `android:${started.serial}`;
      track(deviceId, started.ready);
    } else {
      throw new Error("Only simulators and emulators can be duplicated");
    }
    await setOwned(deviceId, true);
    await setAssignment(workspace, deviceId, false);
    return { deviceId, message: "Starting a new device for this workspace" };
  });

  server.handle(powerRpc, async ({ deviceId, action }) => {
    await ready;
    if (action === "boot") {
      if (deviceId.startsWith("ios:")) track(deviceId, ios.bootIos(deviceId.slice(4)));
      else if (deviceId.startsWith("avd:")) {
        if (await android.serialOf(deviceId)) return { deviceId, message: "Already running" };
        track(deviceId, (await android.launchAvd(deviceId.slice(4), false)).ready);
      } else throw new Error("This device is already on");
      return { deviceId, message: "Booting" };
    }
    forget(deviceId);
    if (action === "shutdown") {
      if (deviceId.startsWith("ios:")) await ios.shutdownIos(deviceId.slice(4));
      else await android.shutdownAndroid(await serial(deviceId));
      return { deviceId, message: "Shut down" };
    }
    if (!isOwned(deviceId)) throw new Error("Only devices created here can be deleted");
    if (deviceId.startsWith("ios:")) await ios.deleteIos(deviceId.slice(4));
    else await android.shutdownAndroid(await serial(deviceId)).catch(() => {});
    await setOwned(deviceId, false);
    return { deviceId, message: "Deleted" };
  });

  server.handle(frameRpc, async ({ deviceId, maxWidth, since }) => {
    try {
      const frame = await frameOf(deviceId);
      if (!frame) return { status: "unavailable" as const, reason: "Waiting for the first picture" };
      if (frame.seq === since) return { status: "same" as const, seq: frame.seq };
      const e = await encode(deviceId, frame, maxWidth);
      return { status: "frame" as const, seq: e.seq, jpeg: e.jpeg, width: e.width, height: e.height };
    } catch (error) {
      return { status: "unavailable" as const, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  server.handle(inputRpc, async ({ deviceId, input }) => {
    if (deviceId.startsWith("ios:")) {
      const udid = deviceId.slice(4);
      if (input.kind === "tap") await ios.iosTap(udid, input.x, input.y, input.holdMs);
      else if (input.kind === "swipe") await ios.iosSwipe(udid, input.from, input.to, input.durationMs);
      else if (input.kind === "text") await ios.iosText(udid, input.text);
      else if (input.kind === "button") await ios.iosButton(udid, input.button);
      else await ios.iosRotate(udid, input.orientation);
      return { ok: true as const };
    }
    const s = await serial(deviceId);
    if (input.kind === "tap") await android.androidTap(s, input.x, input.y, input.holdMs);
    else if (input.kind === "swipe") await android.androidSwipe(s, input.from, input.to, input.durationMs);
    else if (input.kind === "text") await android.androidText(s, input.text);
    else if (input.kind === "button") await android.androidButton(s, input.button);
    else await android.androidRotate(s, input.orientation);
    return { ok: true as const };
  });

  return () => stopReaper();
}
