import { chmodSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Assignment } from "../shared/contracts";

export type Workspace = Omit<Assignment, "deviceId">;

/** What an agent in a workspace without a device can do: see the devices it may use, and take one. */
export interface Picker {
  list(workspace: Workspace): Promise<string>;
  use(workspace: Workspace, deviceId: string): Promise<string>;
}

const TOOLS = [
  {
    name: "list_devices",
    description:
      "The simulators and emulators the user allowed agents to drive, whether each is on, and which workspace holds it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "use_device",
    description:
      "Makes a free device from list_devices this workspace's device and turns it on. The device tools drive it from then on, and the user sees it in the workspace's Device panel.",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string", description: "An id from list_devices" } },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
];

type Message = {
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: { deviceId?: unknown } };
};

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The answer to one MCP message from an agent in `workspace`; null for a notification. */
export async function reply(message: Message, workspace: Workspace, picker: Picker) {
  if (message.id === undefined) return null;
  const result = (value: object) => ({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize":
      return result({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "paseo-devices", version: "1.0.0" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = message.params ?? {};
      try {
        let answer: string;
        if (name === "list_devices") answer = await picker.list(workspace);
        else if (name === "use_device") answer = await picker.use(workspace, String(args?.deviceId ?? ""));
        else throw new Error(`Unknown tool ${name}`);
        return result({ content: [{ type: "text", text: answer }] });
      } catch (error) {
        return result({ content: [{ type: "text", text: text(error) }], isError: true });
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported method ${message.method}` },
      };
  }
}

/**
 * Answers agents' picker bridges (server/picker-bridge.mjs), one POST per MCP message with the
 * agent's workspace in the query, on a Unix socket only this user can open.
 */
export function servePicker(socketPath: string, picker: Picker): () => void {
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", async () => {
      let answer: object | null;
      try {
        const workspace = new URL(req.url ?? "/", "http://picker").searchParams.get("workspace");
        answer = await reply(JSON.parse(body) as Message, JSON.parse(workspace ?? "") as Workspace, picker);
      } catch (error) {
        answer = { jsonrpc: "2.0", id: null, error: { code: -32700, message: text(error) } };
      }
      res.end(answer ? JSON.stringify(answer) : "");
    });
  });
  server.on("error", (error) => console.error("device picker:", error));
  mkdirSync(path.dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true });
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  return () => server.close();
}
