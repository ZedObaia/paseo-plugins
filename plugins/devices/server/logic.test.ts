import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import type { Device } from "../shared/contracts";
import { splitDevices } from "../shared/select";

// state.ts picks its file from PASEO_HOME at import time: point it at a throwaway folder first
let state: typeof import("./state");
before(async () => {
  process.env.PASEO_HOME = mkdtempSync(path.join(os.tmpdir(), "devices-test-"));
  state = await import("./state");
  await state.loadState();
});

const A = { workspaceId: "a", workspaceName: "Checkout", directory: "/w/app" };
const B = { workspaceId: "b", workspaceName: "Onboarding", directory: "/w/app-worktrees/onboarding" };

test("a held device isn't silently taken by another workspace", async () => {
  await state.addAssignment(A, "ios:1", false);
  await assert.rejects(state.addAssignment(B, "ios:1", false), /In use by Checkout/);
  assert.equal(state.holderOf("ios:1")?.workspaceId, "a");
  assert.equal(await state.addAssignment(B, "ios:1", true), "Taken over from Checkout");
  assert.equal(state.holderOf("ios:1")?.workspaceId, "b");
  assert.equal(state.assignments().filter((x) => x.workspaceId === "a").length, 0);
});

test("a workspace holds several devices; agents drive one; release frees one", async () => {
  await state.addAssignment(A, "ios:2", false);
  await state.addAssignment(A, "android:emulator-5554", false);
  await state.addAssignment(A, "ios:3", false);
  const mine = () =>
    state
      .assignments()
      .filter((x) => x.workspaceId === "a")
      .map((x) => x.deviceId);
  assert.deepEqual(mine(), ["ios:2", "android:emulator-5554", "ios:3"]);
  // none until the user turns agent tools on; then the first added until agents choose
  assert.equal(state.targetOf("a"), undefined);
  state.setAgentTools(true);
  assert.equal(state.targetOf("a")?.deviceId, "ios:2");
  await state.setTarget("a", "android:emulator-5554");
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  await state.setTarget("a", "ios:3");
  assert.equal(state.targetOf("a")?.deviceId, "ios:3");
  // only the workspace holding it can release it (a panel a poll behind can't take it from another)
  assert.equal(await state.removeAssignment("b", "ios:3"), false);
  assert.equal(await state.removeAssignment("a", "ios:3"), true);
  assert.deepEqual(mine(), ["ios:2", "android:emulator-5554"]);
  assert.equal(state.holderOf("ios:3"), undefined);
  assert.equal(state.targetOf("a")?.deviceId, "ios:2");
  // releasing forgets that agents chose it: back again, it doesn't take over from the current one
  await state.setTarget("a", "android:emulator-5554");
  await state.addAssignment(A, "ios:3", false);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  // turning agent tools off takes every device from agents; back on, they're where they were
  state.setAgentTools(false);
  assert.equal(state.targetOf("a"), undefined);
  state.setAgentTools(true);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  // a device the workspace no longer holds can't become its target
  await state.removeAssignment("a", "ios:3");
  await state.setTarget("a", "ios:3");
  await state.addAssignment(A, "ios:3", false);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  for (const id of mine()) await state.removeAssignment("a", id);
  state.setAgentTools(false);
});

test("agents in a subfolder of a workspace find its device; the deepest workspace wins", async () => {
  await state.addAssignment({ workspaceId: "root", workspaceName: "Root", directory: "/w" }, "ios:4", false);
  assert.equal(state.assignmentFor("/w/app-worktrees/onboarding/src")?.workspaceId, "b");
  assert.equal(state.assignmentFor("/w/other")?.workspaceId, "root");
  assert.equal(state.assignmentFor("/wx"), undefined);
});

test("featured devices: on, held, owned, Android, and newest-iOS iPhones", () => {
  const d = (id: string, name: string, detail: string, extra: Partial<Device> = {}): Device => ({
    id,
    platform: id.startsWith("ios") ? "ios" : "android",
    name,
    detail,
    state: "shutdown",
    kind: "simulator",
    owned: false,
    error: null,
    ...extra,
  });
  const devices = [
    d("ios:old", "iPhone 17", "iOS 26.4"),
    d("ios:new", "iPhone 17", "iOS 26.5"),
    d("ios:ipad", "iPad mini", "iOS 26.5"),
    d("ios:on", "iPad Air", "iOS 26.4", { state: "booted" }),
    d("ios:held", "iPhone Air", "iOS 26.4"),
    d("avd:pixel", "Pixel", "Android emulator", { kind: "avd" }),
  ];
  const { main, rest } = splitDevices(devices, new Set(["ios:held"]));
  assert.deepEqual(main.map((x) => x.id).sort(), ["avd:pixel", "ios:held", "ios:new", "ios:on"]);
  assert.deepEqual(rest.map((x) => x.id).sort(), ["ios:ipad", "ios:old"]);
});

test("typing: US keyboard usages, shift around capitals and symbols", async () => {
  const { keyEvents } = await import("../shared/keyboard");
  assert.deepEqual(keyEvents("a1"), [
    { type: "down", usage: 4 },
    { type: "up", usage: 4 },
    { type: "down", usage: 30 },
    { type: "up", usage: 30 },
  ]);
  assert.deepEqual(
    keyEvents("A?").map((e) => `${e.type}:${e.usage}`),
    ["down:225", "down:4", "up:4", "up:225", "down:225", "down:56", "up:56", "up:225"],
  );
  assert.equal(keyEvents("hi there\r\n").length, 18);
  assert.throws(() => keyEvents("é"), /can't type "é"/);
});

test("a deleted copy leaves its workspace and the agents' choice", async () => {
  state.setAgentTools(true);
  await state.addAssignment(A, "ios:6", false);
  await state.setOwned("android:emulator-5556", true);
  await state.addAssignment(A, "android:emulator-5556", false);
  await state.setTarget("a", "android:emulator-5556");
  await state.setOwned("android:emulator-5556", false);
  assert.equal(state.holderOf("android:emulator-5556"), undefined);
  assert.equal(state.targetOf("a")?.deviceId, "ios:6");
  await state.removeAssignment("a", "ios:6");
  state.setAgentTools(false);
});

test("every RPC contract is valid (defineRpc throws on load otherwise)", async () => {
  await assert.doesNotReject(import("../shared/contracts"));
});

test("the picker answers an agent's MCP messages over stdio, in its own workspace", async () => {
  const { spawn } = await import("node:child_process");
  const { servePicker } = await import("./picker");
  const socket = path.join(mkdtempSync(path.join(os.tmpdir(), "picker-")), "picker.sock");
  const used: string[] = [];
  const stop = servePicker(socket, {
    list: async (w) => `devices for ${w.workspaceName}`,
    use: async (w, id) => {
      if (id === "ios:held") throw new Error("In use by Checkout");
      used.push(`${w.workspaceId}:${id}`);
      return "ok";
    },
  });
  const bridge = spawn(process.execPath, [path.join(import.meta.dirname, "picker-bridge.mjs")], {
    env: { PASEO_DEVICES_SOCKET: socket, PASEO_DEVICES_WORKSPACE: JSON.stringify(B) },
  });
  const call = (id: number, name: string, args = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  bridge.stdin.end(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      call(3, "list_devices"),
      call(4, "use_device", { deviceId: "ios:held" }),
      call(5, "use_device", { deviceId: "ios:1" }),
    ].join("\n") + "\n",
  );
  let out = "";
  for await (const chunk of bridge.stdout) out += chunk;
  stop();
  const answers = out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // the notification gets no answer
  assert.deepEqual(
    answers.map((a) => a.id),
    [1, 2, 3, 4, 5],
  );
  assert.equal(answers[0].result.capabilities.tools !== undefined, true);
  assert.deepEqual(
    answers[1].result.tools.map((t: { name: string }) => t.name),
    ["list_devices", "use_device"],
  );
  assert.equal(answers[2].result.content[0].text, "devices for Onboarding");
  assert.deepEqual(
    [answers[3].result.isError, answers[3].result.content[0].text],
    [true, "In use by Checkout"],
  );
  assert.deepEqual(used, ["b:ios:1"]);
});

test("an agent's shell command: agent-device's arguments, a plain summary and its screenshot", async () => {
  const { agentDeviceArgs, describe, screenshotPath, shellWords } = await import("../shared/timeline");
  assert.deepEqual(shellWords(`a 'b c' "d \\"e\\"" f\\ g && h|i`), [
    "a",
    "b c",
    'd "e"',
    "f g",
    "&&",
    "h",
    "|",
    "i",
  ]);
  const cmd = "/Users/me/.paseo/plugin-data/devices/bin/wks_1/agent-device";
  assert.deepEqual(agentDeviceArgs(`cd app && ${cmd} press @e12 --settle; echo done`), [
    "press",
    "@e12",
    "--settle",
  ]);
  assert.deepEqual(agentDeviceArgs(`agent-device fill 'label="Email"' "me@example.com"`), [
    "fill",
    'label="Email"',
    "me@example.com",
  ]);
  assert.equal(agentDeviceArgs("npm test"), null);
  assert.equal(describe(["press", "@e12", "--settle"]), "Tapped @e12");
  assert.equal(describe(["open", "com.acme.shop", "--foreground"]), "Opened com.acme.shop");
  assert.equal(describe(["--help"]), "Read agent-device's help");
  assert.equal(describe(["frobnicate", "x"]), "agent-device frobnicate x");
  assert.equal(screenshotPath(["screenshot", "/tmp/a.png"], "", null), "/tmp/a.png");
  assert.equal(screenshotPath(["screenshot", "./shots/a.png"], "", "/w/app"), "/w/app/shots/a.png");
  assert.equal(screenshotPath(["screenshot"], "Saved screenshot: /tmp/s/1.png\n", null), "/tmp/s/1.png");
  assert.equal(screenshotPath(["snapshot"], "/tmp/x.png", null), null);
});

test("device settings: text size steps per platform, and typed locations", async () => {
  const { TEXT_SIZES, parseLocation, textSizeIndex } = await import("../shared/controls");
  assert.equal(TEXT_SIZES[textSizeIndex("ios", "large\n")!]!.label, "Default");
  assert.equal(textSizeIndex("ios", "accessibility-large"), null);
  assert.equal(TEXT_SIZES[textSizeIndex("android", "1.3")!]!.label, "Larger");
  assert.equal(TEXT_SIZES[textSizeIndex("android", "1.12")!]!.label, "Large");
  assert.equal(textSizeIndex("android", "null"), null);
  assert.deepEqual(parseLocation(" 52.52, 13.405 "), { lat: 52.52, lon: 13.405 });
  assert.deepEqual(parseLocation("-33.8 151.2"), { lat: -33.8, lon: 151.2 });
  assert.equal(parseLocation("91, 0"), null);
  assert.equal(parseLocation("Berlin"), null);
});

test("a simulator's apps: user apps only, test runners and option-like ids left out", async () => {
  const { userApps } = await import("../shared/controls");
  const { controlRpc } = await import("../shared/contracts");
  assert.deepEqual(
    userApps({
      "com.example.shop": { ApplicationType: "User", CFBundleDisplayName: "Shop" },
      "com.apple.Preferences": { ApplicationType: "System", CFBundleDisplayName: "Settings" },
      ".xctrunner": { ApplicationType: "User", CFBundleName: "ShopUITests-Runner" },
      "com.callstack.agentdevice.runner.uitests.xctrunner": { ApplicationType: "User" },
      "-rf": { ApplicationType: "User" },
      "com.example.admin": { ApplicationType: "User", CFBundleName: "Admin" },
    }),
    [
      { id: "com.example.admin", name: "Admin" },
      { id: "com.example.shop", name: "Shop" },
    ],
  );
  const permission = (app: string) =>
    controlRpc.input.safeParse({
      deviceId: "ios:1",
      action: { kind: "permission", app, permission: "photos", grant: true },
    }).success;
  assert.equal(permission("com.example.shop"), true);
  assert.equal(permission(".odd.id"), true);
  assert.equal(permission("--reset"), false);
  assert.equal(permission("a b"), false);
});
