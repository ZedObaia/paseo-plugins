import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { Assignment } from "../shared/contracts";
import { serialOf } from "./android";
import { NODE, NODE_ENV, dependencyFile } from "./paths";
import { STATE_DIR, agentToolsAllowed, assignmentFor, assignments } from "./state";

const AGENT_DEVICE = dependencyFile("agent-device", "bin/agent-device.mjs");
const CONFIG_DIR = path.join(STATE_DIR, "agent-device");
const configFile = (workspaceId: string) =>
  path.join(CONFIG_DIR, `${workspaceId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/**
 * agent-device reads this file on every tool call, so agents follow it as soon as it changes. It
 * names the workspace's device and a session named after that device: a session stays on the
 * device it first used, so a new device needs a new session.
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
 * Brings every workspace's file in line with the assignments and deletes the others. A missing
 * file fails every agent-device call, which is how agents lose a device that was released, taken
 * over or deleted. Runs after every change; one sync at a time.
 */
export function syncAgentConfigs(): Promise<void> {
  syncing = syncing
    .catch(() => {})
    .then(async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      const keep = new Set<string>();
      for (const assignment of assignments()) keep.add(path.basename(await writeAgentConfig(assignment)));
      for (const name of await readdir(CONFIG_DIR))
        if (!keep.has(name)) await rm(path.join(CONFIG_DIR, name), { force: true });
    });
  return syncing;
}

/**
 * Agents started in a workspace get agent-device's MCP tools for its device once the user has
 * allowed agent tools on that device: agent-device installs its helpers there on first use.
 */
export function injectDeviceTools(server: PluginServerContext, ready: Promise<void>) {
  server.before("agent.create", async ({ request }) => {
    // Paseo's own background agents (commit messages, PR descriptions) don't drive devices
    if (request.config.internal) return undefined;
    await ready;
    const assignment = assignmentFor(request.config.cwd);
    if (!assignment || !agentToolsAllowed(assignment.deviceId)) return undefined;
    // picks up an emulator started outside the plugin since the last change
    await syncAgentConfigs().catch((error) => console.error("syncing agent-device configs:", error));
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          device: {
            type: "stdio",
            command: NODE,
            args: [AGENT_DEVICE, "mcp"],
            env: {
              ...NODE_ENV,
              AGENT_DEVICE_CONFIG: configFile(assignment.workspaceId),
              AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
            },
          },
        },
      },
    };
  });
}
