import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnProcess } from "@getpaseo/plugin/server";
import { parse as parseToml, stringify as toToml } from "smol-toml";
import type { Behavior, Connector, Plugin, Rule } from "../shared/contracts";
import type { Agent } from "./agent";
import { projectKey, serially, skillAt, skillSets, type Place } from "./files";
import { keepOutOfGit, sharedInGit } from "./git";
import { callbackPort } from "./parse";
import { cache, findBin, lastLine, run } from "./run";
import { finishLogin, forgetLogin, LOGIN_TIMEOUT_MS, rememberRemoval, trackLogin } from "./sessions";

const bin = () => findBin("codex", [".local/bin"]);
const MISSING = "Codex isn't installed on this host. Install it, then try again.";
const codex = (args: string[], cwd: string) => run(bin(), args, cwd, MISSING);
const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

type Json = Record<string, unknown>;

/**
 * A `codex app-server` of our own, in the folder, for one job: JSON-RPC lines over stdio, the way
 * Paseo talks to Codex. It reads the folder's config as a chat there would.
 */
function appServer(cwd: string) {
  const child = spawnProcess(bin(), ["app-server"], { cwd, stdio: "pipe" });
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const listeners = new Set<(method: string, params: Json) => void>();
  let stderr = "";
  let sent = 0;
  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  child.on("error", (error) =>
    failAll((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(MISSING) : error),
  );
  child.on("exit", () => failAll(new Error(lastLine(stderr) ?? "Codex stopped before answering")));
  child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Json;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = message.id === undefined ? undefined : pending.get(message.id);
    if (waiting) {
      pending.delete(message.id!);
      if (message.error) waiting.reject(new Error(message.error.message ?? "Codex couldn't answer"));
      else waiting.resolve(message.result);
    } else if (message.method)
      for (const listener of listeners) listener(message.method, message.params ?? {});
  });
  const send = (method: string, params: unknown) =>
    new Promise<Json>((resolve, reject) => {
      const id = ++sent;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Codex took too long to answer"));
      }, 30_000);
      timer.unref();
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve((v ?? {}) as Json)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  // the client name Paseo uses too: Codex doesn't count it as a separate app in usage logs
  const ready = send("initialize", {
    clientInfo: { name: "codex_app_server_daemon", title: "Toolbox", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  }).then(() => child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`));
  ready.catch(() => {});
  return {
    request: async (method: string, params: unknown) => (await ready, send(method, params)),
    on: (listener: (method: string, params: Json) => void) => void listeners.add(listener),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

/** One job on a fresh app-server, closed after. */
async function withAppServer<T>(cwd: string, job: (server: ReturnType<typeof appServer>) => Promise<T>) {
  const server = appServer(cwd);
  try {
    return await job(server);
  } finally {
    server.close();
  }
}

type ServerConfig = {
  url?: string;
  command?: string;
  enabled?: boolean;
  disabled_tools?: string[];
  default_tools_approval_mode?: string;
  tools?: Record<string, { approval_mode?: string }>;
};
type Status = {
  name: string;
  authStatus?: string;
  pluginId?: string | null;
  tools?: Record<string, { name: string; annotations?: { readOnlyHint?: boolean } }>;
  toolsError?: unknown;
};
type Listed = {
  name: string;
  enabled: boolean;
  disabled_reason?: string | null;
  transport?: { type?: string; url?: string; command?: string; args?: string[] };
};
type SkillInfo = {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  scope: string;
  pluginId?: string | null;
};
type Look = {
  connectors: Connector[];
  plugins: Plugin[];
  skills: SkillInfo[];
  // servers the config defines, which a folder may override
  configured: Set<string>;
  // the folder's root, as Codex keys trust
  root: string;
  trusted: boolean;
  // effective config of each configured server, for writing rules from what applies now
  effective: Record<string, ServerConfig>;
};

const looks = cache<Look>();

// Codex's approval modes, as Allow and Ask; anything else (auto, writes) it decides itself, shown as Ask
const toBehavior = (mode: string | undefined): Behavior => (mode === "approve" ? "allow" : "ask");

function look(cwd: string, refresh: boolean): Promise<Look> {
  return looks.get(cwd, refresh, async () => {
    const [rpc, listedText, pluginsText, root] = await Promise.all([
      withAppServer(cwd, async (server) => {
        const config = await server.request("config/read", { cwd, includeLayers: true });
        const statuses: Status[] = [];
        let cursor: string | null = null;
        do {
          const page: Json = await server.request("mcpServerStatus/list", {
            detail: "toolsAndAuthOnly",
            cursor,
          });
          statuses.push(...((page.data as Status[]) ?? []));
          cursor = (page.nextCursor as string | null) ?? null;
        } while (cursor);
        const skills = await server.request("skills/list", { cwds: [cwd] });
        return { config, statuses, skills };
      }),
      codex(["mcp", "list", "--json"], cwd),
      codex(["plugin", "list", "--json"], cwd),
      projectKey(cwd),
    ]);
    const effective = ((rpc.config.config as Json)?.mcp_servers ?? {}) as Record<string, ServerConfig>;
    const projects = ((rpc.config.config as Json)?.projects ?? {}) as Record<
      string,
      { trust_level?: string }
    >;
    const userServers = (((rpc.config.layers as { name: { type: string }; config?: Json }[]) ?? []).find(
      (l) => l.name.type === "user",
    )?.config?.mcp_servers ?? {}) as Record<string, ServerConfig>;
    const listed = JSON.parse(listedText) as Listed[];
    const configured = new Set(
      Object.keys(effective).filter((n) => effective[n].url || effective[n].command),
    );

    const connectors = rpc.statuses.map((s): Connector => {
      const entry = listed.find((l) => l.name === s.name);
      const cfg = effective[s.name] ?? {};
      const fixedBy = configured.has(s.name)
        ? null
        : s.pluginId
          ? "the plugin that brings it"
          : "Codex itself";
      const disabled = new Set(cfg.disabled_tools ?? []);
      const ruleOf = (tool: string | null): Rule => ({
        behavior:
          tool && disabled.has(tool)
            ? "deny"
            : toBehavior((tool && cfg.tools?.[tool]?.approval_mode) || cfg.default_tools_approval_mode),
        lockedBy: fixedBy,
      });
      const names = [...Object.keys(s.tools ?? {}), ...[...disabled].filter((t) => !s.tools?.[t])];
      const t = entry?.transport;
      const error =
        typeof s.toolsError === "string" ? s.toolsError : s.toolsError ? JSON.stringify(s.toolsError) : "";
      return {
        name: s.name,
        target: t?.url ?? [t?.command ?? "", ...(t?.args ?? [])].join(" ").trim(),
        ...(entry?.enabled === false
          ? {
              state: "off" as const,
              // only a server the config defines is off because of a folder's switch
              detail: entry.disabled_reason ?? (fixedBy ? "Off" : "Off in this folder"),
            }
          : s.authStatus === "notLoggedIn"
            ? { state: "signin" as const, detail: "Needs sign-in" }
            : error
              ? {
                  state: "failed" as const,
                  detail: error.split("\n")[0].replace(/^MCP startup failed: /, ""),
                }
              : { state: "connected" as const, detail: "" }),
        scope: s.pluginId
          ? "plugin"
          : userServers[s.name]
            ? "user"
            : configured.has(s.name)
              ? "project"
              : "other",
        fixedBy,
        removable: Boolean(userServers[s.name]),
        tools: names.map((name) => ({
          name,
          readOnly: s.tools?.[name]?.annotations?.readOnlyHint === true,
          rule: ruleOf(name),
        })),
        rule: ruleOf(null),
      };
    });

    const installed =
      (JSON.parse(pluginsText) as { installed?: { pluginId: string; enabled?: boolean }[] }).installed ?? [];
    const plugins: Plugin[] = installed.map((p) => ({
      id: p.pluginId,
      enabled: p.enabled !== false,
      scope: "user",
      connectors: rpc.statuses.filter((s) => s.pluginId === p.pluginId).map((s) => s.name),
    }));
    const skills = (((rpc.skills.data as { skills?: SkillInfo[] }[]) ?? [])[0]?.skills ?? []).filter(
      (s, i, all) => all.findIndex((o) => o.name === s.name) === i,
    );
    return {
      connectors,
      plugins,
      skills,
      configured,
      root,
      trusted: projects[root]?.trust_level === "trusted",
      effective,
    };
  });
}

/** The folder's own Codex settings: a project .codex/config.toml, which Codex reads once trusted. */
const projectFile = (cwd: string) => path.join(cwd, ".codex", "config.toml");

const PROJECT_FILE = ".codex/config.toml";
const sharedFile = (cwd: string) => sharedInGit(cwd, PROJECT_FILE);

/**
 * Edits the folder's Codex file. An override for a server the config no longer defines would be an
 * incomplete server ("invalid transport") and stop Codex in the folder, so those are dropped.
 */
export function editProject(
  cwd: string,
  configured: Set<string>,
  edit: (servers: Record<string, Json>) => void,
) {
  return serially(async () => {
    if (await sharedFile(cwd))
      throw new Error(
        "This repository shares .codex/config.toml, so Toolbox won't write your switches there",
      );
    const file = projectFile(cwd);
    const text = await readFile(file, "utf8").catch(() => "");
    const doc = (text ? parseToml(text) : {}) as Json;
    const servers = { ...((doc.mcp_servers ?? {}) as Record<string, Json>) };
    edit(servers);
    for (const [name, entry] of Object.entries(servers)) {
      const defines = "url" in entry || "command" in entry;
      if (!defines && !configured.has(name)) delete servers[name];
      else if (entry.tools && !Object.keys(entry.tools as Json).length) delete entry.tools;
      if (!Object.keys(servers[name] ?? {}).length) delete servers[name];
    }
    if (Object.keys(servers).length) doc.mcp_servers = servers;
    else delete doc.mcp_servers;
    // nothing left of the folder's own settings: no file either
    if (!Object.keys(doc).length) return void (await rm(file, { force: true }));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, toToml(doc));
    await keepOutOfGit(cwd, PROJECT_FILE, "your Codex switches for this folder");
  });
}

/** A key path Codex's config writer reads: TOML keys quoted, so dots and @ stay inside a name. */
const keyPath = (...keys: string[]) =>
  keys.map((k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))).join(".");

/** Writes Codex's user config through Codex itself, which keeps its comments and layout. */
const writeUser = (cwd: string, edits: { keyPath: string; value: unknown }[]) =>
  withAppServer(cwd, (server) =>
    server.request("config/batchWrite", { edits: edits.map((e) => ({ ...e, mergeStrategy: "replace" })) }),
  );

export const codexAgent: Agent = {
  async list(cwd, refresh) {
    const found = await look(cwd, refresh);
    const sets = await skillSets([
      path.join(os.homedir(), ".agents", "skills"),
      path.join(codexHome(), "skills"),
      path.join(cwd, ".agents", "skills"),
      path.join(cwd, ".codex", "skills"),
    ]);
    const byPlugin = new Map<string, string[]>();
    for (const s of found.skills)
      if (s.pluginId) byPlugin.set(s.pluginId, [...(byPlugin.get(s.pluginId) ?? []), s.name]);
    const shared = await sharedFile(cwd);
    return {
      connectors: found.connectors,
      plugins: found.plugins,
      skills: found.skills.map((s) => ({ name: s.name, description: s.description, on: s.enabled })),
      skillsOff: [],
      projectSkills: found.skills.filter((s) => s.scope === "repo").map((s) => s.name),
      skillSets: [
        ...sets,
        ...[...byPlugin].map(([id, skills]) => ({
          title: `${id.split("@")[0]} plugin`,
          source: `plugin:${id}`,
          skills,
        })),
        {
          title: "Built into Codex",
          source: "builtin",
          skills: found.skills.filter((s) => s.scope === "system").map((s) => s.name),
        },
      ],
      scopes: { skills: "everywhere", plugins: "everywhere", tools: "listed" },
      addTo: ["folder", "everywhere"],
      notice: shared
        ? {
            text: "This repository shares .codex/config.toml, so Toolbox won't write your switches there.",
            action: null,
          }
        : found.trusted
          ? null
          : {
              text: "Codex ignores this folder's own settings until you trust it. Trusting also lets this repository's Codex hooks and skills run.",
              action: "trust",
            },
    };
  },

  async save(cwd, changes) {
    const found = await look(cwd, false);
    const connectors = changes.filter((c) => c.kind === "connector");
    for (const c of connectors)
      if (!found.configured.has(c.name))
        throw new Error(`${c.name} can't be turned off for a folder in Codex`);
    if (connectors.length)
      await editProject(cwd, found.configured, (servers) => {
        for (const { name, on } of connectors) {
          const entry = { ...(servers[name] ?? {}) };
          if (on) delete entry.enabled;
          else entry.enabled = false;
          servers[name] = entry;
        }
      });
    // Codex switches skills and plugins in your user config: every folder
    const skills = changes.filter((c) => c.kind === "skill");
    const plugins = changes.filter((c) => c.kind === "plugin");
    if (skills.length || plugins.length)
      await withAppServer(cwd, async (server) => {
        for (const { name, on } of skills) {
          const skill = found.skills.find((s) => s.name === name);
          if (!skill) throw new Error(`${name} isn't a Codex skill here`);
          await server.request("skills/config/write", { path: skill.path, enabled: on });
        }
        for (const { name, on } of plugins) {
          if (!found.plugins.some((p) => p.id === name))
            throw new Error(`${name} isn't an installed Codex plugin`);
          await server.request("config/batchWrite", {
            edits: [{ keyPath: keyPath("plugins", name, "enabled"), value: on, mergeStrategy: "replace" }],
          });
        }
      });
    looks.forget(cwd);
    // Paseo's Codex chat reads its config when it starts
    return { restart: changes.length > 0, commands: [] };
  },

  async add(cwd, name, where, server) {
    const found = await look(cwd, false);
    if (found.connectors.some((c) => c.name === name))
      throw new Error(`There's already a connector called ${name}`);
    if (where === "shared") throw new Error("Codex has no shared file for connectors");
    const entry: Json =
      server.type === "http"
        ? { url: server.url, ...(Object.keys(server.headers).length ? { http_headers: server.headers } : {}) }
        : {
            command: server.command,
            args: server.args,
            ...(Object.keys(server.env).length ? { env: server.env } : {}),
          };
    if (where === "everywhere")
      await writeUser(cwd, [{ keyPath: keyPath("mcp_servers", name), value: entry }]);
    else
      await editProject(cwd, found.configured, (servers) => {
        servers[name] = entry;
      });
    looks.forget(cwd);
    return where === "folder"
      ? `Added ${name} for this folder${found.trusted ? "" : ". Codex uses it once you trust the folder."}`
      : `Added ${name} for every project`;
  },

  async remove(cwd, name) {
    const found = await look(cwd, false);
    const connector = found.connectors.find((c) => c.name === name);
    if (!connector?.removable) throw new Error(`Codex can't remove ${name} from here`);
    // as written in your config, to put back exactly
    const user = parseToml(await readFile(path.join(codexHome(), "config.toml"), "utf8")) as Json;
    const entry = (user.mcp_servers as Record<string, Json> | undefined)?.[name];
    if (!entry) throw new Error(`Couldn't find ${name} in your Codex config`);
    await codex(["mcp", "remove", name], cwd);
    // the folder's overrides for it would now be an incomplete server
    const rest = new Set([...found.configured].filter((n) => n !== name));
    if (!(await sharedFile(cwd)) && (await readFile(projectFile(cwd), "utf8").catch(() => null)) !== null)
      await editProject(cwd, rest, () => {});
    looks.forget(cwd);
    return rememberRemoval(cwd, name, async () => {
      await writeUser(cwd, [{ keyPath: keyPath("mcp_servers", name), value: entry }]);
      looks.forget(cwd);
    });
  },

  async setRule(cwd, server, tool, behavior) {
    const found = await look(cwd, false);
    if (!found.configured.has(server))
      throw new Error(`Codex takes ${server}'s rules from where it comes from`);
    const known = found.connectors.find((c) => c.name === server)?.tools.map((t) => t.name) ?? [];
    await editProject(cwd, found.configured, (servers) => {
      const entry: Json = { ...(servers[server] ?? {}) };
      // the folder's list replaces your user config's, so it starts from what applies now
      const disabled = new Set(
        (entry.disabled_tools as string[]) ?? found.effective[server]?.disabled_tools ?? [],
      );
      const tools = { ...((entry.tools ?? {}) as Record<string, Json>) };
      const mode = behavior === "allow" ? "approve" : "prompt";
      if (tool === null) {
        if (behavior === "deny") for (const t of known) disabled.add(t);
        else {
          entry.default_tools_approval_mode = mode;
          disabled.clear();
        }
      } else if (behavior === "deny") {
        disabled.add(tool);
        delete tools[tool];
      } else {
        disabled.delete(tool);
        tools[tool] = { ...(tools[tool] ?? {}), approval_mode: mode };
      }
      entry.disabled_tools = [...disabled];
      entry.tools = tools;
      servers[server] = entry;
    });
    looks.forget(cwd);
    return { restart: true };
  },

  async skill(cwd, name) {
    const skill = (await look(cwd, false)).skills.find((s) => s.name === name);
    if (!skill) throw new Error(`${name} isn't a Codex skill here`);
    const [source, place]: [string, Place] =
      skill.scope === "system"
        ? ["Built into Codex", "other"]
        : skill.pluginId
          ? [`${skill.pluginId.split("@")[0]} plugin`, "other"]
          : skill.scope === "repo"
            ? ["This project", "project"]
            : ["Yours", "user"];
    return (
      (await skillAt(source, place, skill.path)) ?? {
        source,
        place,
        path: skill.path,
        content: "",
        files: [],
      }
    );
  },

  /**
   * Codex's own sign-in for a connector, on an app-server kept for it: Codex waits on this host's
   * localhost for the browser and says when it's done.
   */
  async login(cwd, name, again) {
    const found = await look(cwd, false);
    if (!found.connectors.some((c) => c.name === name)) throw new Error(`${name} isn't a connector here`);
    // nothing to sign out of is fine: the sign-in that follows says how it went
    if (again) await codex(["mcp", "logout", name], cwd).catch(() => {});
    const server = appServer(cwd);
    const { loginId, login } = trackLogin(() => server.close());
    try {
      const started = await server.request("mcpServer/oauth/login", {
        name,
        timeoutSecs: LOGIN_TIMEOUT_MS / 1000,
      });
      const url = started.authorizationUrl as string;
      login.callbackPort = callbackPort(url);
      server.on((method, params) => {
        if (
          method !== "mcpServer/oauthLogin/completed" ||
          (params.loginId && params.loginId !== started.loginId)
        )
          return;
        if (params.success) {
          finishLogin(login, "done", `Signed in to ${name}`);
          looks.forget(cwd);
        } else finishLogin(login, "failed", String(params.error ?? "Sign-in failed"));
        server.close();
        forgetLogin(loginId);
      });
      return { loginId, url };
    } catch (error) {
      finishLogin(login, "failed", (error as Error).message);
      forgetLogin(loginId);
      throw error;
    }
  },

  async trust(cwd) {
    const root = await projectKey(cwd);
    await writeUser(cwd, [{ keyPath: keyPath("projects", root, "trust_level"), value: "trusted" }]);
    looks.forget(cwd);
    return `Codex trusts ${path.basename(root)} now`;
  },
};
