import path from "node:path";
import { spawnProcess } from "@getpaseo/plugin/server";
import type { Change, Connector } from "../shared/contracts";
import type { Agent } from "./agent";
import {
  claudeDir,
  mcpPermissions,
  rawServer,
  setConnectors,
  setPermission,
  setSkills,
  projectSkills,
  skillFile,
  skillSets,
  skillsOff,
} from "./files";
import {
  callbackPort,
  loginUrl,
  parsePluginList,
  plainText,
  shellQuote,
  toConnectors,
  type Found,
  type ListedPlugin,
  type ServerStatus,
} from "./parse";
import { ruleFor, ruleView } from "./rules";
import { cache, cliError, findBin, lastLine, run, sleep } from "./run";
import { LOGIN_TIMEOUT_MS, finishLogin, forgetLogin, rememberRemoval, trackLogin } from "./sessions";

const bin = () => findBin("claude", [".local/bin", ".claude/local"]);
const MISSING = "Claude Code isn't installed on this host. Install it, then try again.";
const claude = (args: string[], cwd: string, timeout?: number) => run(bin(), args, cwd, MISSING, timeout);

/**
 * Asks a headless Claude in the folder about its MCP servers, the way the Agent SDK does
 * (`mcp_status`): their state, where each is configured, and their tools; and which of its
 * commands and skills are built in. It sends no prompt, so no model runs; hooks are off and no
 * session is saved. Servers still connecting are asked about again for a while.
 */
async function mcpStatus(cwd: string): Promise<{ servers: ServerStatus[]; builtin: string[] }> {
  const child = spawnProcess(
    bin(),
    [
      "-p",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--verbose",
      "--no-session-persistence",
      `--settings=${JSON.stringify({ disableAllHooks: true })}`,
    ],
    { cwd, stdio: "pipe" },
  );
  const answers = new Map<string, (response: ControlResponse) => void>();
  let stderr = "";
  const ended = new Promise<never>((_, reject) => {
    child.on("error", (error) =>
      reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(MISSING) : error),
    );
    child.on("exit", () => reject(new Error(lastLine(stderr) ?? "Claude stopped before answering")));
  });
  ended.catch(() => {});
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      try {
        const message = JSON.parse(line) as { type?: string; response?: ControlResponse };
        if (message.type === "control_response" && message.response)
          answers.get(message.response.request_id)?.(message.response);
      } catch {
        // not a JSON line
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
  let sent = 0;
  const ask = (subtype: string) => {
    const id = `toolbox-${++sent}`;
    const answer = new Promise<ControlResponse>((resolve) => answers.set(id, resolve));
    child.stdin.write(
      `${JSON.stringify({ type: "control_request", request_id: id, request: { subtype } })}\n`,
    );
    const late = sleep(30_000).then(() => Promise.reject(new Error("Claude took too long to answer")));
    return Promise.race([answer, ended, late]).then((r) => {
      if (r.subtype === "error") throw new Error(r.error ?? "Claude couldn't answer");
      return r.response ?? {};
    });
  };
  try {
    const commands = ((await ask("initialize")).commands ?? []) as { name: string; builtin?: boolean }[];
    const builtin = commands.filter((c) => c.builtin).map((c) => c.name);
    const until = Date.now() + 20_000;
    for (;;) {
      const servers = ((await ask("mcp_status")).mcpServers ?? []) as ServerStatus[];
      if (!servers.some((s) => s.status === "pending") || Date.now() > until) return { servers, builtin };
      await sleep(1_000);
    }
  } finally {
    child.stdin.end();
    child.kill();
  }
}

type ControlResponse = {
  subtype: string;
  request_id: string;
  response?: { mcpServers?: unknown; commands?: unknown };
  error?: string;
};

type Listing = { connectors: Found[]; plugins: ListedPlugin[]; builtin: string[] };
const looks = cache<Listing>();

function listing(cwd: string, refresh: boolean): Promise<Listing> {
  return looks.get(cwd, refresh, async () => {
    const [{ servers, builtin }, plugins] = await Promise.all([
      mcpStatus(cwd),
      claude(["plugin", "list", "--json"], cwd),
    ]);
    return { connectors: toConnectors(servers), plugins: parsePluginList(plugins), builtin };
  });
}

/** Plugins on or off for the folder alone, the way `claude plugin` does it: its local settings. */
async function setPlugins(cwd: string, changes: { name: string; on: boolean }[]): Promise<void> {
  for (const { name, on } of changes)
    await claude(["plugin", on ? "enable" : "disable", name, "--scope", "local", "--json"], cwd);
}

/**
 * `claude mcp login` signs in only with a terminal, and `script` gives it one. Its input is a
 * pipe kept open for the sign-in's length: macOS's script can't read from Node's socket, and
 * input that ended would end the sign-in. When script ends, so does everything else in its group.
 */
function loginCommand(args: string[]): string {
  const login =
    process.platform === "darwin"
      ? `script -qF /dev/null ${shellQuote(args)}`
      : process.platform === "linux"
        ? `script -qfec ${shellQuote([shellQuote(args)])} /dev/null`
        : null;
  if (!login)
    throw new Error(
      "Signing in from Paseo needs a macOS or Linux host. Run `claude mcp login` in a terminal.",
    );
  return `sleep ${LOGIN_TIMEOUT_MS / 1000} | ${login} & wait $!; kill 0`;
}

/** The last thing Claude said, minus its prompts, as the reason a sign-in failed. */
function lastWords(output: string): string {
  const lines = plainText(output)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(Waiting for authorization|Or paste the redirect URL)/.test(l));
  return lines.at(-1) ?? "Sign-in stopped";
}

const ofKind = (changes: Change[], kind: Change["kind"]) => changes.filter((c) => c.kind === kind);

export const claudeAgent: Agent = {
  async list(cwd, refresh) {
    const [found, off, permissions, sets, ofProject] = await Promise.all([
      listing(cwd, refresh),
      skillsOff(cwd),
      mcpPermissions(cwd),
      skillSets([path.join(claudeDir(), "skills"), path.join(cwd, ".claude", "skills")]),
      projectSkills(cwd),
    ]);
    const connectors: Connector[] = found.connectors.map((c) => ({
      ...c,
      fixedBy: null,
      removable: c.scope === "user" || c.scope === "local" || c.scope === "project",
      rule: ruleView(permissions, c.name, null),
      tools: c.tools.map((t) => ({ ...t, rule: ruleView(permissions, c.name, t.name) })),
    }));
    return {
      connectors,
      // where plugins are installed stays on the host
      plugins: found.plugins.map(({ installPath: _, ...p }) => p),
      skills: null,
      skillsOff: off,
      projectSkills: ofProject,
      // Claude's own skills are a set of their own
      skillSets: [...sets, { title: "Built into Claude Code", source: "builtin", skills: found.builtin }],
      scopes: { skills: "folder", plugins: "folder", tools: "listed" },
      addTo: ["folder", "everywhere", "shared"],
      notice: null,
    };
  },

  async save(cwd, changes) {
    // only what Claude lists here: names go into Claude's files and onto its command line
    const known = await listing(cwd, false);
    const connectors = ofKind(changes, "connector");
    const plugins = ofKind(changes, "plugin");
    const skills = ofKind(changes, "skill");
    for (const c of connectors)
      if (!known.connectors.some((k) => k.name === c.name))
        throw new Error(`${c.name} isn't a connector here`);
    for (const p of plugins)
      if (!known.plugins.some((k) => k.id === p.name)) throw new Error(`${p.name} isn't an installed plugin`);
    if (skills.length) await setSkills(cwd, skills);
    if (connectors.length) await setConnectors(cwd, connectors);
    if (plugins.length) await setPlugins(cwd, plugins);
    looks.forget(cwd);
    // Claude connects to MCP servers when a chat starts, a plugin's included; the rest reloads in place
    const bringsConnectors = plugins.some(
      (p) => known.plugins.find((k) => k.id === p.name)?.connectors.length,
    );
    return {
      restart: connectors.length > 0 || bringsConnectors,
      commands: [
        ...(skills.length ? ["/reload-skills"] : []),
        ...(plugins.length ? ["/reload-plugins"] : []),
      ],
    };
  },

  async add(cwd, name, where, server) {
    if ((await listing(cwd, false)).connectors.some((c) => c.name === name))
      throw new Error(`There's already a connector called ${name}`);
    const entry =
      server.type === "http"
        ? {
            type: "http",
            url: server.url,
            ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
          }
        : {
            type: "stdio",
            command: server.command,
            args: server.args,
            ...(Object.keys(server.env).length ? { env: server.env } : {}),
          };
    // Claude's own scopes: local is this folder, user every project, project the shared .mcp.json
    const scope = { folder: "local", everywhere: "user", shared: "project" }[where];
    await claude(["mcp", "add-json", name, JSON.stringify(entry), "--scope", scope], cwd);
    looks.forget(cwd);
    return where === "shared"
      ? `Added ${name} to .mcp.json. Commit it to share it.`
      : `Added ${name} ${where === "folder" ? "for this folder" : "for every project"}`;
  },

  async remove(cwd, name) {
    const connector = (await listing(cwd, false)).connectors.find((c) => c.name === name);
    if (!connector) throw new Error(`${name} isn't a connector here`);
    const { scope } = connector;
    if (scope !== "user" && scope !== "local" && scope !== "project")
      throw new Error(
        scope === "plugin"
          ? "It comes with a plugin: turn the plugin off or uninstall it instead"
          : scope === "claudeai"
            ? "It comes from claude.ai: remove it in claude.ai's connector settings"
            : "Claude can't remove this one",
      );
    // as written, variables unexpanded, to put back exactly
    const entry = await rawServer(cwd, name, scope);
    if (!entry) throw new Error(`Couldn't find ${name} in Claude's ${scope} settings`);
    await claude(["mcp", "remove", name, "--scope", scope], cwd);
    looks.forget(cwd);
    return rememberRemoval(cwd, name, async () => {
      await claude(["mcp", "add-json", name, JSON.stringify(entry), "--scope", scope], cwd);
      looks.forget(cwd);
    });
  },

  async setRule(cwd, server, tool, behavior) {
    const { rule, behavior: written } = ruleFor(await mcpPermissions(cwd), server, tool, behavior);
    await setPermission(cwd, rule, written);
    // Claude follows its settings from the chat's next tool call
    return { restart: false };
  },

  async skill(cwd, name) {
    return skillFile(cwd, name, (await listing(cwd, false)).plugins);
  },

  /**
   * Starts Claude's sign-in for a connector and resolves with the address to open. Claude listens
   * on this host's localhost for the browser to come back; from another device, the user pastes
   * the address the browser landed on instead.
   */
  async login(cwd, name, again) {
    if (!(await listing(cwd, false)).connectors.some((c) => c.name === name))
      throw new Error(`${name} isn't a connector here`);
    // nothing to sign out of is fine: the sign-in that follows says how it went
    if (again) await claude(["mcp", "logout", name], cwd).catch(() => {});
    const command = loginCommand([bin(), "mcp", "login", name, "--no-browser"]);
    // its own process group, so stopping it stops script, claude and the sleep together
    const child = spawnProcess("/bin/sh", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const { loginId, login } = trackLogin(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    });
    let output = "";
    child.on("exit", () => {
      finishLogin(login, "failed", lastWords(output));
      forgetLogin(loginId);
    });
    return new Promise((resolve, reject) => {
      const read = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        // "Authenticated with "linear". Its tools are now available…", or "…but it's currently disabled"
        const ok = /Authenticated with "[^"]*"[^\n]*/.exec(plainText(output));
        if (ok) {
          finishLogin(login, "done", ok[0]);
          looks.forget(cwd);
        }
        // no address when Claude could sign in without the browser
        const url = loginUrl(output);
        if (url && login.callbackPort === null) login.callbackPort = callbackPort(url);
        if (url || ok) resolve({ loginId, url });
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.on("error", (error) => {
        finishLogin(login, "failed", cliError(error));
        reject(new Error(cliError(error)));
      });
      child.on("exit", () => reject(new Error(lastWords(output))));
    });
  },

  async trust() {
    throw new Error("Claude reads this folder's settings without being asked to trust it");
  },
};
