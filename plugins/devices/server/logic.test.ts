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
  await state.setAssignment(A, "ios:1", false);
  await assert.rejects(state.setAssignment(B, "ios:1", false), /In use by Checkout/);
  assert.equal(state.holderOf("ios:1")?.workspaceId, "a");
  assert.equal(await state.setAssignment(B, "ios:1", true), "Taken over from Checkout");
  assert.equal(state.holderOf("ios:1")?.workspaceId, "b");
  assert.equal(state.assignments().filter((x) => x.workspaceId === "a").length, 0);
});

test("one device per workspace; release frees it", async () => {
  await state.setAssignment(A, "ios:2", false);
  await state.setAssignment(A, "ios:3", false);
  assert.deepEqual(
    state
      .assignments()
      .filter((x) => x.workspaceId === "a")
      .map((x) => x.deviceId),
    ["ios:3"],
  );
  assert.equal(await state.setAssignment(A, null, false), "Released the device");
  assert.equal(state.holderOf("ios:3"), undefined);
});

test("agents in a subfolder of a workspace find its device; the deepest workspace wins", async () => {
  await state.setAssignment({ workspaceId: "root", workspaceName: "Root", directory: "/w" }, "ios:4", false);
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
    agentTools: false,
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

test("agent tools are off until allowed per device, and forgotten with a deleted copy", async () => {
  assert.equal(state.agentToolsAllowed("ios:5"), false);
  await state.allowAgentTools("ios:5", true);
  assert.equal(state.agentToolsAllowed("ios:5"), true);
  await state.allowAgentTools("ios:5", false);
  assert.equal(state.agentToolsAllowed("ios:5"), false);
  await state.setOwned("android:emulator-5556", true);
  await state.allowAgentTools("android:emulator-5556", true);
  await state.setOwned("android:emulator-5556", false);
  assert.equal(state.agentToolsAllowed("android:emulator-5556"), false);
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
