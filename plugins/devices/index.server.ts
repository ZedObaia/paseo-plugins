import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  agentSettings,
  assignRpc,
  controlRpc,
  controlsRpc,
  createRpc,
  frameRpc,
  inputRpc,
  listRpc,
  powerRpc,
  screenshotRpc,
  screenshotSearchRpc,
  thumbnailRpc,
  type Device,
} from "./shared/contracts";
import { applyControl, readControls, screenshot } from "./server/controls";
import * as android from "./server/android";
import { PICKER_SOCKET, injectDeviceTools, syncAgentConfigs } from "./server/agents";
import { encode, forget, thumbnail, type Frame } from "./server/frames";
import * as ios from "./server/ios";
import { servePicker, type Picker } from "./server/picker";
import {
  addAssignment,
  agentToolsOn,
  assignments,
  holderOf,
  isOwned,
  loadState,
  owned,
  removeAssignment,
  setAgentTools,
  setOwned,
  setTarget,
  targetOf,
} from "./server/state";

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
  // A held device that left the host (unplugged, deleted in Xcode, or a listing that failed for a
  // moment) stays its workspace's: shown, so it can be released, and back when it returns.
  for (const { deviceId: id } of assignments()) {
    if (devices.some((d) => d.id === id)) continue;
    devices.push({
      id,
      platform: id.startsWith("ios:") ? "ios" : "android",
      name: "Missing device",
      detail: "not on this host",
      state: "shutdown",
      // nothing to turn on, off, copy or delete: it can only be released
      kind: "physical",
      owned: false,
      error: null,
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
  // The Agent tools setting: off until read, and if it can't be read.
  const settings = server.registerSettings(agentSettings);
  const apply = (s: Awaited<ReturnType<typeof settings.read>>) =>
    setAgentTools(s.status === "ready" && s.values.agentTools);
  let changed = false;
  const ready = loadState()
    .then(() => settings.read())
    .then((s) => void (changed || apply(s)))
    .catch((error) => console.error("reading settings:", error))
    // files from before an update, or for an emulator that changed while the daemon was down
    .then(() => syncAgentConfigs().catch((error) => console.error("syncing agent-device configs:", error)));
  // agents already running read their workspace's file on every call: turning agent tools off
  // takes their devices away at once
  const stopSettings = settings.subscribe(async (s) => {
    changed = true;
    apply(s);
    await ready;
    await syncAgentConfigs().catch((error) => console.error("syncing agent-device configs:", error));
  });
  const stopReaper = ios.startIdleReaper();
  injectDeviceTools(server, ready);

  // Agents switch between their workspace's devices, or take a free simulator or emulator. A USB
  // phone is the user's own: agents only drive one the user added to their workspace.
  const usable = (d: Device, workspaceId: string) =>
    d.kind !== "physical" || holderOf(d.id)?.workspaceId === workspaceId;
  const OFF = "The user hasn't turned on agent tools; they do that in the Devices plugin's settings";
  const picker: Picker = {
    async list(workspace) {
      await ready;
      if (!agentToolsOn()) return OFF;
      const target = targetOf(workspace.workspaceId)?.deviceId;
      return withStatus((await listDevices()).devices)
        .filter((d) => usable(d, workspace.workspaceId))
        .map((d) => {
          const holder = holderOf(d.id);
          const held = !holder
            ? "free"
            : holder.workspaceId !== workspace.workspaceId
              ? `in use by ${holder.workspaceName}`
              : d.id === target
                ? "this workspace's, the device tools drive it"
                : "this workspace's";
          return `${d.id}: ${d.name}${d.detail ? ` (${d.detail})` : ""}, ${d.state}, ${held}`;
        })
        .join("\n");
    },
    async use(workspace, deviceId) {
      await ready;
      if (!agentToolsOn()) throw new Error(OFF);
      const listed = (await listDevices()).devices;
      const device = withStatus(listed).find((d) => d.id === deviceId);
      if (!device) throw new Error("No such device on this host; call list_devices");
      // listed so the user can release or delete it, not to be driven: a held device that left the
      // host, or an emulator copy that failed to start (it ran read-only, so it can't start again)
      if (!booting.has(deviceId) && !listed.some((d) => d.id === deviceId))
        throw new Error(`${device.name} isn't on this host right now; use another device`);
      if (!usable(device, workspace.workspaceId))
        throw new Error(`${device.name} is a USB device: only the user can add it to a workspace`);
      // another workspace's device stays theirs
      await addAssignment(workspace, deviceId, false);
      await setTarget(workspace.workspaceId, deviceId);
      // a USB phone that's offline can't be turned on from here
      if (device.state === "shutdown" && device.kind !== "physical") boot(deviceId);
      await syncAgentConfigs();
      listing = null;
      return device.state === "booted"
        ? `The device tools drive ${device.name} now`
        : `The device tools drive ${device.name} now; they reach it once it's on`;
    },
  };
  const stopPicker = servePicker(PICKER_SOCKET, picker);

  server.handle(listRpc, async () => {
    await ready;
    const { devices, ...platforms } = await listDevices();
    return { ...platforms, devices: withStatus(devices), assignments: [...assignments()] };
  });

  server.handle(assignRpc, async ({ deviceId, takeOver, release, ...workspace }) => {
    await ready;
    if (release) {
      // a panel a poll behind mustn't release a device another workspace took meanwhile
      if (!(await removeAssignment(workspace.workspaceId, deviceId)))
        throw new Error("It isn't this workspace's device any more");
      await syncAgentConfigs();
      return { message: "Released the device" };
    }
    if (!booting.has(deviceId) && !(await listDevices()).devices.some((d) => d.id === deviceId)) {
      throw new Error("That device isn't on this host");
    }
    const result = await addAssignment(workspace, deviceId, takeOver);
    await syncAgentConfigs();
    return { message: result };
  });

  // An archived workspace gives its devices back. One made for it ("New copy") is turned off, not
  // deleted: archiving can be undone, and a simulator keeps its data until someone deletes it.
  server.on("workspace.archived", async ({ workspace }) => {
    await ready;
    const held = assignments().filter((a) => a.workspaceId === workspace.id);
    if (!held.length) return;
    for (const { deviceId } of held) {
      // another workspace may have taken it over while an earlier copy turned off
      if (!(await removeAssignment(workspace.id, deviceId))) continue;
      if (isOwned(deviceId))
        await turnOff(deviceId).catch((error) => console.error("turning off", deviceId, error));
    }
    await syncAgentConfigs();
    listing = null;
  });

  server.handle(createRpc, async ({ from, ...workspace }) => {
    await ready;
    let deviceId: string;
    if (from.startsWith("ios:")) {
      const simulators = await ios.listIos();
      const source = simulators.find((d) => d.id === from);
      const base = `${source?.name ?? "iPhone"} (${workspace.workspaceName})`;
      // a second copy for one workspace is "… 2", so the panel's switcher tells them apart
      let name = base;
      for (let n = 2; simulators.some((d) => d.name === name); n++) name = `${base} ${n}`;
      const udid = await ios.createIos(from.slice(4), name);
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
    await addAssignment(workspace, deviceId, false);
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
      else if (input.kind === "key") await ios.iosKey(udid, input.key);
      else await ios.iosRotate(udid, input.orientation);
      return { ok: true as const };
    }
    const s = await serial(deviceId);
    if (input.kind === "tap") await android.androidTap(s, input.x, input.y, input.holdMs);
    else if (input.kind === "swipe") await android.androidSwipe(s, input.from, input.to, input.durationMs);
    else if (input.kind === "text") await android.androidText(s, input.text);
    else if (input.kind === "button") await android.androidButton(s, input.button);
    else if (input.kind === "key") await android.androidKey(s, input.key);
    else await android.androidRotate(s, input.orientation);
    return { ok: true as const };
  });

  server.handle(controlsRpc, ({ deviceId }) => readControls(deviceId));
  server.handle(controlRpc, async ({ deviceId, action }) => ({
    message: await applyControl(deviceId, action),
  }));

  // The "+" menu's Device screen picker: each running device's screen, saved as a PNG on this
  // host. The attachment is text naming the file, which agents on the host open as an image.
  server.handle(screenshotSearchRpc, async ({ query }) => {
    await ready;
    const words = query.trim().toLowerCase();
    const on = withStatus((await listDevices()).devices).filter(
      (d) => d.state === "booted" && d.name.toLowerCase().includes(words),
    );
    const items = await Promise.all(
      on.map(async (d) => {
        const file = await screenshot(d.id).catch(() => null);
        if (!file) return [];
        const holder = holderOf(d.id)?.workspaceName;
        const what = `${d.name}${d.detail ? ` (${d.detail})` : ""}`;
        return [
          {
            id: file,
            // the picker shows "identifier title"; the chip, the source and the identifier
            identifier: d.detail || (d.platform === "ios" ? "iOS" : "Android"),
            title: `${d.name} screen`,
            subtitle: holder,
            url: pathToFileURL(file).href,
            text:
              `A screenshot of ${what}${holder ? `, ${holder}'s device` : ""}, taken just now, is ` +
              `saved at ${file}. Open that image file to see the screen.`,
            resourceType: "screenshot",
          },
        ];
      }),
    );
    return { items: items.flat() };
  });

  server.handle(thumbnailRpc, ({ path }) => thumbnail(path));

  server.handle(screenshotRpc, async ({ deviceId }) => {
    const file = await screenshot(deviceId, true);
    return { path: file, png: (await readFile(file)).toString("base64") };
  });

  return () => {
    stopSettings();
    stopReaper();
    stopPicker();
  };
}
