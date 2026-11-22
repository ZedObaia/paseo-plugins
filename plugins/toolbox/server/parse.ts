import type { Connector, Plugin } from "../shared/contracts";

/** A connector as an agent reports it, before Toolbox adds what the folder's rules say. */
export type Found = Omit<Connector, "fixedBy" | "removable" | "rule" | "tools"> & {
  tools: { name: string; readOnly: boolean }[];
};

/** One server in the answer to the Agent SDK's `mcp_status` request, as Claude Code 2.1 gives it. */
export type ServerStatus = {
  name: string;
  status: string;
  error?: string;
  scope?: string;
  source?: string;
  config?: { type?: string; url?: string; command?: string; args?: string[] };
  tools?: { name: string; annotations?: { readOnly?: boolean; [hint: string]: unknown } }[];
};

/** What the panel shows of each server. Its headers and environment stay on the host. */
export function toConnectors(servers: ServerStatus[]): Found[] {
  return servers.map((s) => ({
    name: s.name,
    target:
      s.config?.type === "stdio" || s.config?.command
        ? [s.config.command ?? "", ...(s.config.args ?? [])].join(" ").trim()
        : (s.config?.url ?? ""),
    ...stateOf(s),
    scope:
      s.source === "plugin"
        ? "plugin"
        : s.source === "claudeai" || s.scope === "claudeai"
          ? "claudeai"
          : s.scope === "user" || s.scope === "local" || s.scope === "project"
            ? s.scope
            : "other",
    // MCP takes any tool that isn't read-only to be destructive unless it says otherwise, so only
    // read-only tells the user something
    tools: (s.tools ?? []).map((t) => ({ name: t.name, readOnly: t.annotations?.readOnly === true })),
  }));
}

function stateOf(s: ServerStatus): Pick<Found, "state" | "detail"> {
  switch (s.status) {
    case "connected":
      return { state: "connected", detail: "" };
    case "needs-auth":
      return { state: "signin", detail: "Needs sign-in" };
    case "disabled":
      return { state: "off", detail: "Off in this folder" };
    case "pending":
      return { state: "pending", detail: "Still connecting" };
    case "failed":
      // "ENOENT: ENOENT: …": said once
      return { state: "failed", detail: (s.error ?? "Failed to start").replace(/^(\w+): \1: /, "$1: ") };
    default:
      return { state: "warning", detail: s.error ?? s.status };
  }
}

export type ListedPlugin = Plugin & { installPath: string | null };

/** `claude plugin list --json`, keeping what the panel shows and where each plugin lives. */
export function parsePluginList(output: string): ListedPlugin[] {
  const listed = JSON.parse(output) as {
    id: string;
    enabled?: boolean;
    scope?: string;
    installPath?: string;
    mcpServers?: Record<string, unknown>;
  }[];
  return listed.map((p) => ({
    id: p.id,
    enabled: p.enabled !== false,
    scope: p.scope ?? "user",
    // how Claude names a plugin's servers
    connectors: Object.keys(p.mcpServers ?? {}).map((s) => `plugin:${p.id.split("@")[0]}:${s}`),
    installPath: p.installPath ?? null,
  }));
}

// terminal escapes `claude mcp login` prints under a pseudo-terminal: colors, cursor moves, and
// OSC 8 hyperlinks that wrap the URL in "ESC ] 8 ;; <url> BEL"
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;

export const plainText = (output: string) => output.replace(ESCAPES, "").replace(/\r/g, "");

/** The address `claude mcp login` asks the user to visit, once it has printed it. */
export function loginUrl(output: string): string | null {
  const text = plainText(output);
  const after = text.indexOf("Visit this URL to authorize:");
  if (after < 0) return null;
  return /https:\/\/\S+/.exec(text.slice(after))?.[0] ?? null;
}

/** The localhost port Claude's sign-in waits on, from the redirect address inside the URL it prints. */
export function callbackPort(url: string): number | null {
  try {
    const r = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    return ["localhost", "127.0.0.1"].includes(r.hostname) && r.port ? Number(r.port) : null;
  } catch {
    return null;
  }
}

/** POSIX shell quoting, for util-linux `script -c`, which takes the command as one string. */
export const shellQuote = (args: string[]) => args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
