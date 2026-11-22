import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { Assignment } from "../shared/contracts";
import { serialOf } from "./android";
import { NODE, NODE_ENV, PLUGIN_DIR, dependencyFile } from "./paths";
import type { Workspace } from "./picker";
import { STATE_DIR, agentToolsOn, assignmentFor, assignments, isInside, targetOf } from "./state";

const AGENT_DEVICE = dependencyFile("agent-device", "bin/agent-device.mjs");
const CONFIG_DIR = path.join(STATE_DIR, "agent-device");
export const PICKER_SOCKET = path.join(STATE_DIR, "picker.sock");
const safe = (workspaceId: string) => workspaceId.replace(/[^A-Za-z0-9_-]/g, "_");
const configFile = (workspaceId: string) => path.join(CONFIG_DIR, `${safe(workspaceId)}.json`);
// one agent-device command per workspace, bound to its config file
const commandFile = (workspaceId: string) => path.join(STATE_DIR, "bin", safe(workspaceId), "agent-device");
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The agent-device command line for a workspace's agents: agent-device, on the device its config
 * file names. With no file (agent tools off, or no device) it fails without starting agent-device,
 * so it never reaches a device the user didn't give agents.
 */
async function writeCommand(workspaceId: string): Promise<string> {
  const file = commandFile(workspaceId);
  const config = configFile(workspaceId);
  const env = { ...NODE_ENV, AGENT_DEVICE_CONFIG: config, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    `${file}.tmp`,
    [
      "#!/bin/sh",
      "# Paseo's Devices plugin: agent-device for one workspace's agents, on its device.",
      `[ -f ${quote(config)} ] || { echo "No device for agents: agent tools are off, or this workspace has none. Use device-picker's list_devices and use_device." >&2; exit 1; }`,
      ...Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`),
      `exec ${quote(NODE)} ${quote(AGENT_DEVICE)} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(`${file}.tmp`, 0o755);
  await rename(`${file}.tmp`, file);
  return file;
}

/**
 * agent-device reads this file on every command, so agents follow it as soon as it changes. It
 * names the device the workspace's agents drive and a session named after that device: a session
 * stays on the device it first used, so a new device needs a new session.
 */
async function writeAgentConfig(assignment: Assignment): Promise<string> {
  let target: { platform: "ios"; udid: string } | { platform: "android"; serial: string };
  if (assignment.deviceId.startsWith("ios:"))
    target = { platform: "ios", udid: assignment.deviceId.slice(4) };
  else {
    // An AVD that is off has no serial yet. Name one that can't match: without a serial,
    // agent-device would pick any running emulator, possibly another workspace's.
    const serial = await serialOf(assignment.deviceId).catch(() => null);
    target = { platform: "android", serial: serial ?? "off" };
  }
  const device = target.platform === "ios" ? target.udid : target.serial;
  const session = `paseo-${assignment.workspaceId}-${device}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const file = configFile(assignment.workspaceId);
  await writeFile(
    `${file}.tmp`,
    `${JSON.stringify({ session, sessionLock: "strip", ...target }, null, 2)}\n`,
  );
  await rename(`${file}.tmp`, file);
  return file;
}

let syncing = Promise.resolve();

/**
 * Brings every workspace's file in line with the device its agents drive (targetOf) and deletes
 * the others. Files are only written while the user has agent tools on, so turning them off takes
 * every device from agents already running: the missing file fails every agent-device call, and
 * agent-device never installs its helpers without consent. A device that was released, taken over
 * or deleted is left for another of the workspace's devices, if there is one. Runs after every
 * change, the setting included; one sync at a time.
 */
export function syncAgentConfigs(): Promise<void> {
  syncing = syncing
    .catch(() => {})
    .then(async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      const keep = new Set<string>();
      for (const workspaceId of new Set(assignments().map((a) => a.workspaceId))) {
        const target = targetOf(workspaceId);
        if (target) keep.add(path.basename(await writeAgentConfig(target)));
      }
      for (const name of await readdir(CONFIG_DIR))
        if (!keep.has(name)) await rm(path.join(CONFIG_DIR, name), { force: true });
    });
  return syncing;
}

type PaseoApi = PluginHookContext["paseo"];

/** The Paseo workspace containing cwd (the deepest one), whether or not it holds a device. */
async function workspaceAt(paseo: PaseoApi, cwd: string): Promise<Workspace | null> {
  const entries: Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    entries.push(...page.entries);
    cursor = page.pageInfo?.nextCursor ?? undefined;
  } while (cursor);
  const found = entries
    .filter((w) => isInside(cwd, w.workspaceDirectory))
    .sort((a, b) => b.workspaceDirectory.length - a.workspaceDirectory.length)[0];
  return found
    ? { workspaceId: found.id, workspaceName: found.title ?? found.name, directory: found.workspaceDirectory }
    : null;
}

/** How to drive a device, said once to each agent instead of loading agent-device's 59 MCP tools. */
const instructions = (command: string, hasDevice: boolean) =>
  [
    `To see and drive this workspace's iOS simulator or Android emulator, run \`${command}\`: the ` +
      "agent-device command line, bound to the device this workspace's agents use. Start with " +
      `\`${command} --help\`, and \`${command} help workflow\` for the full guide; write its commands ` +
      "out in full, as that help says. To switch to another of the workspace's devices, or take a free " +
      "simulator or emulator, call `device-picker`'s list_devices, then use_device.",
    hasDevice
      ? ""
      : "This workspace has no device yet, so the command fails until it has one: call list_devices, " +
        "then use_device with a free device.",
  ]
    .filter(Boolean)
    .join(" ");

/**
 * Once the user has turned agent tools on, agents started in a workspace get the agent-device
 * command line for one of its devices (agent-device installs its helpers there on first use) and
 * the picker, to switch between the workspace's devices or take a free simulator or emulator. The
 * command line costs an agent a paragraph of instructions, where agent-device's MCP server would
 * add 59 tools (about 64k tokens) to every agent; it follows its config file, rewritten on every
 * change.
 */
export function injectDeviceTools(server: PluginServerContext, ready: Promise<void>) {
  server.before("agent.create", async ({ request }, { paseo }) => {
    const { config } = request;
    // Paseo's own background agents (commit messages, PR descriptions) don't drive devices
    if (config.internal) return undefined;
    await ready;
    if (!agentToolsOn()) return undefined;
    const workspace = assignmentFor(config.cwd) ?? (await workspaceAt(paseo, config.cwd).catch(() => null));
    if (!workspace) return undefined;
    // picks up an emulator started outside the plugin since the last change
    await syncAgentConfigs().catch((error) => console.error("syncing agent-device configs:", error));
    const command = await writeCommand(workspace.workspaceId);
    const prompt = instructions(command, Boolean(targetOf(workspace.workspaceId)));
    return {
      ...request,
      config: {
        ...config,
        mcpServers: {
          ...config.mcpServers,
          "device-picker": {
            type: "stdio" as const,
            command: NODE,
            args: [path.join(PLUGIN_DIR, "server", "picker-bridge.mjs")],
            env: {
              ...NODE_ENV,
              PASEO_DEVICES_SOCKET: PICKER_SOCKET,
              PASEO_DEVICES_WORKSPACE: JSON.stringify(workspace),
            },
          },
        },
        systemPrompt: [config.systemPrompt, prompt].filter(Boolean).join("\n\n"),
      },
    };
  });
}
