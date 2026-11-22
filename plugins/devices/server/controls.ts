import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import type { controlRpc, controlsRpc } from "../shared/contracts";
import { APP_ID, PERMISSIONS, TEXT_SIZES, textSizeIndex, userApps } from "../shared/controls";
import { adb, androidFrame, serialOf, shell, shellQuote } from "./android";
import { run } from "./exec";
import { savePng } from "./frames";
import { simctl } from "./ios";
import { STATE_DIR } from "./state";

type Controls = z.infer<typeof controlsRpc.output>;
type Action = z.infer<typeof controlRpc.input>["action"];

// devices don't report a simulated location: the last one set here
const locations = new Map<string, { lat: number; lon: number } | null>();

async function target(deviceId: string): Promise<{ udid: string } | { serial: string }> {
  if (deviceId.startsWith("ios:")) return { udid: deviceId.slice(4) };
  const serial = await serialOf(deviceId);
  if (!serial) throw new Error("The device is off");
  return { serial };
}

const orNull = (work: Promise<string>) => work.then((out) => out.trim()).catch(() => null);
const flag = (value: string | null, on: string, off: string) =>
  value === on ? true : value === off ? false : null;

/** `simctl listapps` prints an old-style plist, which plutil turns into JSON. */
async function iosApps(udid: string) {
  const file = path.join(os.tmpdir(), `paseo-devices-apps-${udid}.plist`);
  await writeFile(file, await simctl(["listapps", udid]));
  try {
    return userApps(JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", file])));
  } finally {
    await rm(file, { force: true });
  }
}

async function androidApps(serial: string) {
  return (await shell(serial, "pm list packages -3"))
    .split("\n")
    .map((line) => line.trim().replace(/^package:/, ""))
    .filter((id) => APP_ID.test(id))
    .sort()
    .map((id) => ({ id, name: id }));
}

/** A booted device's settings as it reports them; what it can't say is null. */
export async function readControls(deviceId: string): Promise<Controls> {
  const t = await target(deviceId);
  const location = locations.get(deviceId) ?? null;
  if ("udid" in t) {
    const [appearance, size, contrast, apps] = await Promise.all([
      orNull(simctl(["ui", t.udid, "appearance"])),
      orNull(simctl(["ui", t.udid, "content_size"])),
      orNull(simctl(["ui", t.udid, "increase_contrast"])),
      iosApps(t.udid).catch(() => []),
    ]);
    return {
      appearance: appearance === "light" || appearance === "dark" ? appearance : null,
      textSize: size === null ? null : textSizeIndex("ios", size),
      contrast: flag(contrast, "enabled", "disabled"),
      airplane: null,
      location,
      apps,
    };
  }
  const [night, scale, airplane, apps] = await Promise.all([
    orNull(shell(t.serial, "cmd uimode night")),
    orNull(shell(t.serial, "settings get system font_scale")),
    orNull(shell(t.serial, "settings get global airplane_mode_on")),
    androidApps(t.serial).catch(() => []),
  ]);
  const mode = /Night mode: (\w+)/.exec(night ?? "")?.[1];
  return {
    appearance: mode === "yes" ? "dark" : mode === "no" ? "light" : null,
    // never set: Android's default
    textSize: scale === null ? null : textSizeIndex("android", scale === "null" ? "1" : scale),
    contrast: null,
    airplane: flag(airplane, "1", "0"),
    location,
    apps,
  };
}

/** Changes one setting; says what it did. */
export async function applyControl(deviceId: string, action: Action): Promise<string> {
  const t = await target(deviceId);
  const ios = "udid" in t;
  const only = (platform: "iOS" | "Android") => {
    throw new Error(`Only ${platform} devices have this setting`);
  };
  switch (action.kind) {
    case "appearance":
      if (ios) await simctl(["ui", t.udid, "appearance", action.value]);
      else await shell(t.serial, `cmd uimode night ${action.value === "dark" ? "yes" : "no"}`);
      return action.value === "dark" ? "Dark appearance" : "Light appearance";
    case "textSize": {
      const size = TEXT_SIZES[action.value];
      if (ios) await simctl(["ui", t.udid, "content_size", size.ios]);
      else await shell(t.serial, `settings put system font_scale ${size.android}`);
      return `Text size: ${size.label}`;
    }
    case "contrast":
      if (!ios) return only("iOS");
      await simctl(["ui", t.udid, "increase_contrast", action.value ? "enabled" : "disabled"]);
      return action.value ? "Increase Contrast on" : "Increase Contrast off";
    case "airplane":
      if (ios) return only("Android");
      await shell(t.serial, `cmd connectivity airplane-mode ${action.value ? "enable" : "disable"}`);
      return action.value ? "Airplane mode on" : "Airplane mode off";
    case "location": {
      const point = action.value;
      if (ios) {
        if (point) await simctl(["location", t.udid, "set", `${point.lat},${point.lon}`]);
        else await simctl(["location", t.udid, "clear"]);
      } else {
        // a USB phone uses its real location
        if (!t.serial.startsWith("emulator-")) throw new Error("Only emulators take a simulated location");
        if (!point) throw new Error("An emulator keeps its last location; set another one instead");
        await adb(["-s", t.serial, "emu", "geo", "fix", String(point.lon), String(point.lat)]);
      }
      locations.set(deviceId, point);
      return point ? `Location set to ${point.lat}, ${point.lon}` : "Location no longer simulated";
    }
    case "openUrl":
      if (ios) await simctl(["openurl", t.udid, action.url]);
      else await shell(t.serial, `am start -a android.intent.action.VIEW -d ${shellQuote(action.url)}`);
      return "Opened the link";
    case "permission": {
      const permission = PERMISSIONS[action.permission];
      const verb = action.grant ? "grant" : "revoke";
      if (ios) {
        if (!permission.ios) throw new Error(`iOS simulators can't set ${permission.label} access`);
        await simctl(["privacy", t.udid, verb, permission.ios, action.app]);
      } else {
        // fine and coarse location come together; an app may ask for only one of them
        const results = await Promise.allSettled(
          permission.android.map((name) => shell(t.serial, `pm ${verb} ${shellQuote(action.app)} ${name}`)),
        );
        const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failed && results.every((r) => r.status === "rejected")) throw failed.reason;
      }
      return `${permission.label} ${action.grant ? "allowed" : "denied"}`;
    }
    case "push": {
      if (!ios) return only("iOS");
      const file = path.join(os.tmpdir(), `paseo-devices-push-${process.pid}-${Date.now()}.json`);
      const alert = action.title ? { title: action.title, body: action.body } : action.body;
      await writeFile(file, JSON.stringify({ aps: { alert, sound: "default" } }));
      try {
        await simctl(["push", t.udid, action.app, file]);
      } finally {
        await rm(file, { force: true });
      }
      return "Notification sent";
    }
  }
}

const SHOTS = path.join(STATE_DIR, "screenshots");
const DAY_MS = 24 * 60 * 60 * 1000;
// the picker searches as the user types: one capture per device every few seconds
const recent = new Map<string, { at: number; file: Promise<string> }>();

/**
 * Saves a booted device's screen as a PNG under the plugin's data and returns its path. `fresh`:
 * not one from the last few seconds (the copy button; the picker searches as you type).
 */
export function screenshot(deviceId: string, fresh = false): Promise<string> {
  const hit = recent.get(deviceId);
  if (!fresh && hit && Date.now() - hit.at < 5_000) return hit.file;
  const file = capture(deviceId);
  recent.set(deviceId, { at: Date.now(), file });
  file.catch(() => recent.delete(deviceId));
  return file;
}

async function capture(deviceId: string): Promise<string> {
  await mkdir(SHOTS, { recursive: true });
  // a day is plenty for an agent to open one it was given
  for (const name of await readdir(SHOTS)) {
    const old = path.join(SHOTS, name);
    if (Date.now() - (await stat(old)).mtimeMs > DAY_MS) await rm(old, { force: true });
  }
  const file = path.join(
    SHOTS,
    `${deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
  );
  const t = await target(deviceId);
  if ("udid" in t) await simctl(["io", t.udid, "screenshot", file], 20_000);
  else await savePng(await androidFrame(t.serial), file);
  return file;
}
