import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const platformSchema = z.enum(["ios", "android"]);

/**
 * "ios:<udid>" or "android:<adb serial>" (an AVD that isn't running is "avd:<name>"). The part
 * after the prefix goes to simctl, adb and serve-sim as an argument, so it can't start with "-".
 */
export const deviceId = z.string().regex(/^(ios|android|avd):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

/** A touch held this long is a long press, on both platforms. */
export const LONG_PRESS_MS = 450;

const device = z.object({
  id: deviceId,
  platform: platformSchema,
  name: z.string(),
  // iOS runtime ("iOS 26.5") or the AVD an emulator runs
  detail: z.string(),
  state: z.enum(["booted", "booting", "shutdown"]),
  kind: z.enum(["simulator", "emulator", "avd", "physical"]),
  // created by this plugin for a workspace: offered for deletion
  owned: z.boolean(),
  // why the last boot failed, until the next attempt
  error: z.string().nullable(),
});
export type Device = z.infer<typeof device>;

const assignment = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  directory: z.string(),
  deviceId,
});
export type Assignment = z.infer<typeof assignment>;

export const listRpc = defineRpc({
  name: "devices.list",
  input: z.object({}),
  output: z.object({
    ios: z.object({ available: z.boolean(), reason: z.string() }),
    android: z.object({ available: z.boolean(), reason: z.string() }),
    devices: z.array(device),
    assignments: z.array(assignment),
  }),
});

const workspace = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string(),
  directory: z.string().min(1),
});

/** Gives a device to a workspace (deviceId null: release). Refuses a device another workspace holds unless takeOver. */
export const assignRpc = defineRpc({
  name: "devices.assign",
  input: workspace.extend({ deviceId: deviceId.nullable(), takeOver: z.boolean().default(false) }),
  output: z.object({ message: z.string() }),
});

/** A fresh device for one workspace: a new simulator like `from`, or another instance of an AVD. */
export const createRpc = defineRpc({
  name: "devices.create",
  input: workspace.extend({ from: deviceId }),
  output: z.object({ deviceId, message: z.string() }),
});

export const powerRpc = defineRpc({
  name: "devices.power",
  input: z.object({ deviceId, action: z.enum(["boot", "shutdown", "delete"]) }),
  output: z.object({ deviceId, message: z.string() }),
});

export const frameRpc = defineRpc({
  name: "devices.frame",
  input: z.object({
    deviceId,
    maxWidth: z.number().int().min(120).max(1600),
    since: z.number().int().default(-1),
  }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("frame"),
      seq: z.number().int(),
      jpeg: z.string(),
      width: z.number(),
      height: z.number(),
    }),
    // nothing newer than `since`
    z.object({ status: z.literal("same"), seq: z.number().int() }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
  ]),
});

const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

export const inputRpc = defineRpc({
  name: "devices.input",
  input: z.object({
    deviceId,
    input: z.discriminatedUnion("kind", [
      point.extend({ kind: z.literal("tap"), holdMs: z.number().int().min(0).max(5000).default(60) }),
      z.object({
        kind: z.literal("swipe"),
        from: point,
        to: point,
        durationMs: z.number().int().min(50).max(5000),
      }),
      z.object({ kind: z.literal("text"), text: z.string().min(1).max(2000) }),
      z.object({
        kind: z.literal("button"),
        button: z.enum(["home", "back", "lock", "volumeUp", "volumeDown", "appSwitch"]),
      }),
      z.object({ kind: z.literal("rotate"), orientation: z.enum(["portrait", "landscape"]) }),
    ]),
  }),
  output: z.object({ ok: z.literal(true) }),
});
