import { defineAttachmentSource, defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { APP_ID, PERMISSION_IDS, TEXT_SIZES } from "./controls";

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

/**
 * Adds a device to a workspace's devices, or with release takes it away from the workspace.
 * Refuses a device another workspace holds unless takeOver.
 */
export const assignRpc = defineRpc({
  name: "devices.assign",
  input: workspace.extend({
    deviceId,
    takeOver: z.boolean().default(false),
    release: z.boolean().default(false),
  }),
  output: z.object({ message: z.string() }),
});

/** A fresh device for one workspace: a new simulator like `from`, or another instance of an AVD. */
export const createRpc = defineRpc({
  name: "devices.create",
  input: workspace.extend({ from: deviceId }),
  output: z.object({ deviceId, message: z.string() }),
});

/**
 * Whether agents get agent-device tools for their workspace's devices. Off until the user turns it
 * on, after being told what it installs: the first time an agent drives a device, agent-device
 * installs its helpers there.
 */
export const agentSettings = defineSettings({
  id: "agents",
  scope: "host",
  version: 1,
  schema: z.object({ agentTools: z.boolean().default(false) }),
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

export const KEYS = ["backspace", "enter", "tab", "escape", "left", "right", "up", "down"] as const;
export type Key = (typeof KEYS)[number];

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
      // keys typed on the live screen that aren't text
      z.object({ kind: z.literal("key"), key: z.enum(KEYS) }),
    ]),
  }),
  output: z.object({ ok: z.literal(true) }),
});

/** An app installed by the user, for permissions and push notifications. */
const appId = z.string().regex(APP_ID);
const appearance = z.enum(["light", "dark"]);
const location = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });

/** A booted device's settings, as it reports them (null: it can't say, or the platform has none). */
export const controlsRpc = defineRpc({
  name: "devices.controls",
  input: z.object({ deviceId }),
  output: z.object({
    appearance: appearance.nullable(),
    // a step of TEXT_SIZES
    textSize: z.number().int().nullable(),
    // iOS: Increase Contrast
    contrast: z.boolean().nullable(),
    // Android: airplane mode
    airplane: z.boolean().nullable(),
    // the last location set here; devices don't report a simulated one
    location: location.nullable(),
    apps: z.array(z.object({ id: appId, name: z.string() })),
  }),
});

/** Changes one setting on a booted device, the way a tester would in its Settings app. */
export const controlRpc = defineRpc({
  name: "devices.control",
  input: z.object({
    deviceId,
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("appearance"), value: appearance }),
      z.object({
        kind: z.literal("textSize"),
        value: z
          .number()
          .int()
          .min(0)
          .max(TEXT_SIZES.length - 1),
      }),
      z.object({ kind: z.literal("contrast"), value: z.boolean() }),
      z.object({ kind: z.literal("airplane"), value: z.boolean() }),
      // null: stop simulating one (iOS)
      z.object({ kind: z.literal("location"), value: location.nullable() }),
      // a web page or a deep link into an app
      z.object({
        kind: z.literal("openUrl"),
        url: z
          .string()
          .max(2000)
          .regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/, "A URL like https://example.com or myapp://path"),
      }),
      z.object({
        kind: z.literal("permission"),
        app: appId,
        permission: z.enum(PERMISSION_IDS),
        grant: z.boolean(),
      }),
      // iOS simulators only
      z.object({
        kind: z.literal("push"),
        app: appId,
        title: z.string().max(200),
        body: z.string().min(1).max(2000),
      }),
    ]),
  }),
  output: z.object({ message: z.string() }),
});

/** The screens of the host's running devices, saved as PNG files, for the "+" menu's picker. */
export const screenshotSearchRpc = defineRpc({
  name: "devices.screenshots",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

export const screenshotAttachments = defineAttachmentSource({
  id: "screens",
  title: "Device screen",
  icon: "Smartphone",
  pickerTitle: "Attach a device's screen",
  searchPlaceholder: "Device name",
  search: screenshotSearchRpc,
});

/** A small JPEG of a screenshot an agent saved with agent-device, for its chat's timeline. */
export const thumbnailRpc = defineRpc({
  name: "devices.thumbnail",
  input: z.object({ path: z.string().regex(/^\/.+\.(png|jpe?g)$/i) }),
  output: z.object({ jpeg: z.string(), width: z.number(), height: z.number() }),
});

/** A device's screen now, as a PNG for the app to copy; kept on the host for a day too. */
export const screenshotRpc = defineRpc({
  name: "devices.screenshot",
  input: z.object({ deviceId }),
  output: z.object({ path: z.string(), png: z.string() }),
});
