import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The agents Toolbox manages, by Paseo's provider ID. */
export const PROVIDERS = ["claude", "codex", "opencode"] as const;
export const provider = z.enum(PROVIDERS);
export type Provider = z.infer<typeof provider>;

/** The folder a chat runs in. Its per-folder switches are read and written there. */
const cwd = z.string().min(1).max(4096);

const behavior = z.enum(["allow", "ask", "deny"]);
export type Behavior = z.infer<typeof behavior>;

/** What the agent does when a chat calls a tool, and what keeps it so if it can't be changed here. */
const rule = z.object({
  behavior,
  // "your user settings": a setting this folder can't override
  lockedBy: z.string().nullable(),
});
export type Rule = z.infer<typeof rule>;

const tool = z.object({
  name: z.string(),
  // the server says it only reads
  readOnly: z.boolean(),
  rule,
});
export type Tool = z.infer<typeof tool>;

/**
 * An MCP server as the agent has it in a folder, by the agent's own name for it: "github",
 * "plugin:figma:figma" for a Claude plugin's, "claude.ai Linear" for one synced from claude.ai.
 */
const connector = z.object({
  name: z.string(),
  // its address or command line, never its headers or environment
  target: z.string(),
  state: z.enum(["connected", "signin", "off", "failed", "warning", "pending"]),
  // the agent's words for anything but connected: the error, or what's wrong
  detail: z.string(),
  // where it's configured: user (every project), local (this folder), project (shared with the
  // repository), a plugin, claude.ai, or something else
  scope: z.enum(["user", "local", "project", "plugin", "claudeai", "other"]),
  // the folder can turn it off; null, or why it can't ("it comes with a plugin")
  fixedBy: z.string().nullable(),
  // Toolbox can remove it from where it's configured
  removable: z.boolean(),
  tools: z.array(tool),
  // for all its tools
  rule,
});
export type Connector = z.infer<typeof connector>;

const plugin = z.object({
  // "figma@claude-plugins-official"
  id: z.string(),
  enabled: z.boolean(),
  // user, project, local, or synced from claude.ai
  scope: z.string(),
  // names of its MCP servers, as in Connector.name
  connectors: z.array(z.string()),
});
export type Plugin = z.infer<typeof plugin>;

const skillSet = z.object({ title: z.string(), source: z.string(), skills: z.array(z.string()) });

/** A skill as an agent lists it for a folder, when it does (Claude's come from the chat instead). */
const skill = z.object({ name: z.string(), description: z.string(), on: z.boolean() });

export const listRpc = defineRpc({
  name: "toolbox.list",
  input: z.object({ provider, cwd, refresh: z.boolean().default(false) }),
  output: z.object({
    connectors: z.array(connector),
    plugins: z.array(plugin),
    // null: the chat lists its own skills (Claude)
    skills: z.array(skill).nullable(),
    // skills this folder turns off, which the chat no longer lists (Claude)
    skillsOff: z.array(z.string()),
    // skills of the project's own, in its folder; the rest are in every project
    projectSkills: z.array(z.string()),
    // skills installed together: from one repository by the skills CLI, by one author, by a
    // plugin, or with the agent itself
    skillSets: z.array(skillSet),
    // where switches for skills and plugins apply: this folder, every folder (Codex), or nowhere
    // (OpenCode can't switch plugins one at a time); and whether connectors' tools are known here
    // (OpenCode only learns them inside a chat)
    scopes: z.object({
      skills: z.enum(["folder", "everywhere"]),
      plugins: z.enum(["folder", "everywhere", "none"]),
      tools: z.enum(["listed", "unknown"]),
    }),
    // where a new connector can go: this folder, every project, or the repository's shared file
    addTo: z.array(z.enum(["folder", "everywhere", "shared"])),
    // something to tell the user before switches here do anything, with the action that fixes it
    notice: z.object({ text: z.string(), action: z.enum(["trust"]).nullable() }).nullable(),
  }),
});

const change = z.object({
  kind: z.enum(["connector", "skill", "plugin"]),
  name: z.string().min(1).max(512),
  on: z.boolean(),
});
export type Change = z.infer<typeof change>;

/**
 * Saves the changes, then brings the chat up to date: Claude's skills and plugins reload in
 * place; anything else (or `restart`, after a sign-in) restarts the chat with its history.
 * Without a chat, it only saves: the agent reads them when a chat starts.
 */
export const applyRpc = defineRpc({
  name: "toolbox.apply",
  input: z.object({
    provider,
    cwd,
    agentId: z.string().min(1).nullable(),
    changes: z.array(change).max(200),
    restart: z.boolean().default(false),
  }),
  output: z.object({ message: z.string() }),
});

/** A new MCP server: on the web at a URL, or a command the agent starts on this host. */
const newServer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    url: z
      .string()
      .regex(/^https?:\/\/\S+$/, "The address starts with https://")
      .max(2048),
    headers: z.record(
      z.string().regex(/^[A-Za-z0-9-]{1,128}$/, "Header names are letters, digits and -"),
      z.string().max(4096),
    ),
  }),
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64),
    env: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Variable names are letters, digits and _"),
      z.string().max(4096),
    ),
  }),
]);
export type NewServer = z.infer<typeof newServer>;
export type Where = "folder" | "everywhere" | "shared";

/** Adds an MCP server to the agent's configuration, where the user chose. */
export const addRpc = defineRpc({
  name: "toolbox.add",
  input: z.object({
    provider,
    cwd,
    // a name every agent takes as is, and that names its tools (mcp__<name>__…)
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Use letters, digits, - and _"),
    where: z.enum(["folder", "everywhere", "shared"]),
    server: newServer,
  }),
  output: z.object({ message: z.string() }),
});

/**
 * Removes a connector from the agent's configuration where it's defined. The host keeps what was
 * removed for a while, so `undoId` can put it back.
 */
export const removeRpc = defineRpc({
  name: "toolbox.remove",
  input: z.object({ provider, cwd, name: z.string().min(1).max(512) }),
  output: z.object({ message: z.string(), undoId: z.string() }),
});

export const restoreRpc = defineRpc({
  name: "toolbox.restore",
  input: z.object({ undoId: z.string().min(1) }),
  output: z.object({ message: z.string() }),
});

/**
 * Sets Allow, Ask or Block for a connector's tool (`tool` null: all its tools), for the folder.
 * `restart`: the chat follows it after a restart (Codex); Claude follows it on its next call.
 */
export const permissionRpc = defineRpc({
  name: "toolbox.permission",
  input: z.object({
    provider,
    cwd,
    server: z.string().min(1).max(512),
    tool: z.string().min(1).max(512).nullable(),
    behavior,
  }),
  output: z.object({ restart: z.boolean() }),
});

/** Trusts the folder, so the agent reads its project settings (Codex; OpenCode reads every folder's). */
export const trustRpc = defineRpc({
  name: "toolbox.trust",
  input: z.object({ provider, cwd }),
  output: z.object({ message: z.string() }),
});

/** A skill's file, for its details. */
export const skillRpc = defineRpc({
  name: "toolbox.skill",
  input: z.object({ provider, cwd, name: z.string().min(1).max(512) }),
  output: z.object({
    // "Yours", "This project", "figma plugin", "Built into Claude Code"
    source: z.string(),
    // in your own skill folder (yours, which can be copied to other hosts), the project's, or
    // with a plugin or the agent itself
    place: z.enum(["user", "project", "other"]),
    path: z.string().nullable(),
    content: z.string(),
    // other files in its folder
    files: z.array(z.string()),
  }),
});

/**
 * One of your skills packed to copy to another host: its folder (a command's file) as a gzipped
 * tar, and where it sits in your home folder, which is where it goes there.
 */
export const packRpc = defineRpc({
  name: "toolbox.skill-pack",
  input: z.object({ provider, cwd, name: z.string().min(1).max(512) }),
  // ".claude/skills/deslop"; base64
  output: z.object({ path: z.string(), archive: z.string() }),
});

/**
 * Starts the agent's own sign-in for a connector; the client opens `url` in a browser. `again`
 * signs it out first, as Claude Code's Re-authenticate does, so the sign-in starts afresh.
 */
export const loginRpc = defineRpc({
  name: "toolbox.login",
  input: z.object({ provider, cwd, name: z.string().min(1).max(512), again: z.boolean().default(false) }),
  // null: signed in without needing the browser
  output: z.object({ loginId: z.string(), url: z.string().nullable() }),
});

/**
 * A sign-in's progress. `paste` hands the agent the address the browser landed on, for a browser
 * on another device: its redirect to this host's localhost can't arrive by itself.
 */
export const loginStatusRpc = defineRpc({
  name: "toolbox.login-status",
  input: z.object({ loginId: z.string().min(1), paste: z.string().max(8192).optional() }),
  output: z.object({ state: z.enum(["waiting", "done", "failed"]), message: z.string() }),
});

/** Stops a sign-in the user gave up on. */
export const loginCancelRpc = defineRpc({
  name: "toolbox.login-cancel",
  input: z.object({ loginId: z.string().min(1) }),
  output: z.object({ ok: z.literal(true) }),
});
