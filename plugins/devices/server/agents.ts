import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { Assignment } from "../shared/contracts";
import { serialOf } from "./android";
import { dependencyFile } from "./paths";
import { STATE_DIR, assignmentFor } from "./state";

const AGENT_DEVICE = dependencyFile("agent-device", "bin/agent-device.mjs");
const configFile = (workspaceId: string) =>
  path.join(STATE_DIR, "agent-device", `${workspaceId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/**
 * agent-device reads this per workspace: its named session is locked to the workspace's device,
 * so an agent can't drive (or take over) another workspace's simulator. Rewritten whenever the
 * assignment changes or an emulator comes back under a new serial.
 */
export async function writeAgentConfig(assignment: Assignment): Promise<string> {
  const session = `paseo-${assignment.workspaceId}`;
  let config: Record<string, string> = { session, sessionLock: "strip" };
  if (assignment.deviceId.startsWith("ios:")) config = { ...config, platform: "ios", udid: assignment.deviceId.slice(4) };
  else {
    const serial = await serialOf(assignment.deviceId);
    config = serial ? { ...config, platform: "android", serial } : { session, platform: "android" };
  }
  const file = configFile(assignment.workspaceId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** Agents started in a workspace that has a device get agent-device's MCP tools for it. */
export function injectDeviceTools(server: PluginServerContext, ready: Promise<void>) {
  server.before("agent.create", async ({ request }) => {
    await ready;
    const assignment = assignmentFor(request.config.cwd);
    if (!assignment) return undefined;
    const file = await writeAgentConfig(assignment);
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          device: {
            type: "stdio",
            command: "node",
            args: [AGENT_DEVICE, "mcp"],
            env: { AGENT_DEVICE_CONFIG: file, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" },
          },
        },
      },
    };
  });
}
