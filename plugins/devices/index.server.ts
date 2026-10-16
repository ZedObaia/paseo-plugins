import type { PluginServerContext } from "@getpaseo/plugin/server";
import { assignRpc, createRpc, frameRpc, inputRpc, listRpc, powerRpc, type Device } from "./shared/contracts";
import * as android from "./server/android";
import { injectDeviceTools, syncAgentConfigs } from "./server/agents";
import { encode, forget, type Frame } from "./server/frames";
import * as ios from "./server/ios";
import { assignments, isOwned, loadState, owned, setAssignment, setOwned } from "./server/state";

type Platform = { available: boolean; reason: string };
type Listed = Omit<Device, "owned" | "error">;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Boots run in the background (they outlast the client's 60 s RPC timeout); the list reports them.
const booting = new Map<string, Promise<void>>();
// why the last boot failed, until the device is on or a new boot starts
const failures = new Map<string, string>();

function track(deviceId: string, work: Promise<unknown>): void {
  failures.delete(deviceId);
  const done: Promise<void> = work
    // an emulator that came back under a new serial: point its workspace's agents at it
    .then(() => syncAgentConfigs().catch((error) => console.error("syncing agent-device configs:", error)))
    // a boot that was cancelled (the device turned off meanwhile) isn't a failure
    .catch(
      (error: unknown) => void (booting.get(deviceId) === done && failures.set(deviceId, message(error))),
    )
    .finally(() => {
      if (booting.get(deviceId) === done) booting.delete(deviceId);
      listing = null;
    });
  booting.set(deviceId, done);
}

let availability: { at: number; value: Promise<[Platform, Platform]> } | null = null;
function available() {
  if (!availability || Date.now() - availability.at > 60_000) {
    availability = {
      at: Date.now(),
      value: Promise.all([ios.iosAvailability(), android.androidAvailability()]),
    };
  }
  return availability.value;
}

/** One platform's devices; a failure (adb restarting, simctl busy) leaves the other platform's list alone. */
async function listPlatform(
  platform: Platform,
  load: () => Promise<Listed[]>,
): Promise<{ platform: Platform; devices: Listed[] }> {
  if (!platform.available) return { platform, devices: [] };
  try {
    return { platform, devices: await load() };
  } catch (error) {
    return {
      platform: { available: false, reason: `Couldn't list devices: ${message(error)}` },
      devices: [],
    };
  }
}

async function loadListing() {
  const [iosOk, androidOk] = await available();
  const [iosList, androidList] = await Promise.all([
    listPlatform(iosOk, ios.listIos),
    listPlatform(androidOk, android.listAndroid),
  ]);
  if (androidList.platform.available) {
    // An emulator copy that stopped outside the plugin (a crash, a reboot) can't come back: it ran
    // read-only. Forget it, or the next emulator on its port would be taken for the copy.
    const listed = new Set(androidList.devices.map((d) => d.id));
    const gone = owned().filter(
      (id) =>
        id.startsWith("android:") &&
        !listed.has(id) &&
        !booting.has(id) &&
        !failures.has(id) &&
        // adb can briefly list nothing (another tool restarting its server)
        !android.emulatorRunning(id.slice("android:".length)),
    );
    for (const id of gone) await setOwned(id, false);
    if (gone.length) await syncAgentConfigs();
  }
  return {
    ios: iosList.platform,
    android: androidList.platform,
    devices: [...iosList.devices, ...androidList.devices],
  };
}

// Every client's sidebar polls the list and each poll runs simctl, adb and the emulator: share
// one run for a couple of seconds. Anything that changes devices clears it.
let listing: { at: number; value: ReturnType<typeof loadListing> } | null = null;
function listDevices() {
  if (!listing || Date.now() - listing.at > 2_000) listing = { at: Date.now(), value: loadListing() };
  return listing.value;
}

function withStatus(listed: Listed[]): Device[] {
  const devices: Device[] = listed.map((d) => {
    if (d.state === "booted") failures.delete(d.id);
    return {
      ...d,
      state: booting.has(d.id) ? "booting" : d.state,
      owned: isOwned(d.id),
      error: failures.get(d.id) ?? null,
    };
  });
  // A new emulator isn't in `adb devices` for its first seconds, and a copy that failed to start
  // never is: show both until they boot or are deleted.
  for (const id of new Set([...booting.keys(), ...failures.keys()])) {
    if (devices.some((d) => d.id === id) || (!booting.has(id) && !isOwned(id))) continue;
    const platform = id.startsWith("ios:") ? "ios" : "android";
    devices.push({
      id,
      platform,
      name: "New copy",
      detail: "",
      state: booting.has(id) ? "booting" : "shutdown",
      kind: platform === "ios" ? "simulator" : "emulator",
      owned: isOwned(id),
      error: failures.get(id) ?? null,
    });
  }
  return devices;
}

async function serial(deviceId: string): Promise<string> {
  const s = await android.serialOf(deviceId);
  if (!s) throw new Error("The emulator is off");
  return s;
}

const frameOf = (deviceId: string): Promise<Frame | null> =>
  deviceId.startsWith("ios:") ? ios.iosFrame(deviceId.slice(4)) : serial(deviceId).then(android.androidFrame);

function boot(deviceId: string): void {
  if (deviceId.startsWith("ios:")) return track(deviceId, ios.bootIos(deviceId.slice(4)));
  if (!deviceId.startsWith("avd:")) throw new Error("Only simulators and emulators can be turned on here");
  // tracked before the first await, so a second request sees it booting
  track(
    deviceId,
    (async () => {
      if (await android.serialOf(deviceId)) return;
      await (
        await android.launchAvd(deviceId.slice(4), false)
      ).ready;
    })(),
  );
}

/** An emulator copy can't come back once off (it runs read-only from its AVD): it is forgotten. */
async function turnOff(deviceId: string): Promise<void> {
  forget(deviceId);
  // stops tracking a boot in progress, so its failure isn't reported
  booting.delete(deviceId);
  failures.delete(deviceId);
  if (deviceId.startsWith("ios:")) return ios.shutdownIos(deviceId.slice(4));
  await android.shutdownAndroid(await serial(deviceId));
  if (deviceId.startsWith("android:") && isOwned(deviceId)) await setOwned(deviceId, false);
}

/** Deletes a device this plugin created: the simulator with its data, or the emulator copy. */
async function deleteOwned(deviceId: string): Promise<void> {
  forget(deviceId);
  failures.delete(deviceId);
  if (deviceId.startsWith("ios:")) await ios.deleteIos(deviceId.slice(4));
  else await android.shutdownAndroid(await serial(deviceId)).catch(() => {}); // already gone is fine
  await setOwned(deviceId, false);
}

export default function contribute(server: PluginServerContext) {
  // files from before an update, or for an emulator that changed while the daemon was down
  const ready = loadState().then(() =>
    syncAgentConfigs().catch((error) => console.error("syncing agent-device configs:", error)),
  );
  const stopReaper = ios.startIdleReaper();
  injectDeviceTools(server, ready);

  server.handle(listRpc, async () => {
    await ready;
    const { devices, ...platforms } = await listDevices();
    return { ...platforms, devices: withStatus(devices), assignments: [...assignments()] };
  });

  server.handle(assignRpc, async ({ deviceId, takeOver, ...workspace }) => {
    await ready;
    if (deviceId && !booting.has(deviceId) && !(await listDevices()).devices.some((d) => d.id === deviceId)) {
      throw new Error("That device isn't on this host");
    }
    const result = await setAssignment(workspace, deviceId, takeOver);
    await syncAgentConfigs();
    return { message: result };
  });

  // An archived workspace gives its device back. One made for it ("New copy") is turned off, not
  // deleted: archiving can be undone, and a simulator keeps its data until someone deletes it.
  server.on("workspace.archived", async ({ workspace }) => {
    await ready;
    const held = assignments().find((a) => a.workspaceId === workspace.id);
    if (!held) return;
    await setAssignment(held, null, false);
    if (isOwned(held.deviceId))
      await turnOff(held.deviceId).catch((error) => console.error("turning off", held.deviceId, error));
    await syncAgentConfigs();
    listing = null;
  });

  server.handle(createRpc, async ({ from, ...workspace }) => {
    await ready;
    let deviceId: string;
    if (from.startsWith("ios:")) {
      const source = (await ios.listIos()).find((d) => d.id === from);
      const udid = await ios.createIos(
        from.slice(4),
        `${source?.name ?? "iPhone"} (${workspace.workspaceName})`,
      );
      deviceId = `ios:${udid}`;
      track(deviceId, ios.bootIos(udid));
    } else if (from.startsWith("avd:")) {
      // a read-only instance: runs next to the AVD's own one and forgets its changes when it stops
      const started = await android.launchAvd(from.slice(4), true);
      deviceId = `android:${started.serial}`;
      track(deviceId, started.ready);
    } else {
      throw new Error("Only simulators and emulators can be copied");
    }
    await setOwned(deviceId, true);
    await setAssignment(workspace, deviceId, false);
    await syncAgentConfigs();
    listing = null;
    return { deviceId, message: "Starting a new device for this workspace" };
  });

  server.handle(powerRpc, async ({ deviceId, action }) => {
    await ready;
    try {
      if (action === "boot") {
        if (booting.has(deviceId)) return { deviceId, message: "Already starting" };
        boot(deviceId);
        return { deviceId, message: "Starting" };
      }
      if (action === "shutdown") await turnOff(deviceId);
      else if (isOwned(deviceId)) await deleteOwned(deviceId);
      else throw new Error("Only devices created here can be deleted");
      await syncAgentConfigs();
      return { deviceId, message: action === "shutdown" ? "Turned off" : "Deleted" };
    } finally {
      listing = null;
    }
  });

  server.handle(frameRpc, async ({ deviceId, maxWidth, since }) => {
    try {
      const frame = await frameOf(deviceId);
      if (!frame) return { status: "unavailable" as const, reason: "Waiting for the first picture" };
      if (frame.seq === since) return { status: "same" as const, seq: frame.seq };
      const e = await encode(deviceId, frame, maxWidth);
      return { status: "frame" as const, seq: e.seq, jpeg: e.jpeg, width: e.width, height: e.height };
    } catch (error) {
      return { status: "unavailable" as const, reason: message(error) };
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
