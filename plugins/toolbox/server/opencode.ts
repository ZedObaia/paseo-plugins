import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnProcess } from "@getpaseo/plugin/server";
import type { Behavior, Connector } from "../shared/contracts";
import type { Agent } from "./agent";
import { readJson, serially, skillAt, skillSets, writeJson } from "./files";
import { keepOutOfGit, sharedInGit } from "./git";
import { cache, findBin, lastLine, run } from "./run";
import { finishLogin, forgetLogin, rememberRemoval, trackLogin } from "./sessions";

const bin = () => findBin("opencode", [".opencode/bin", ".local/bin"]);
const MISSING = "OpenCode isn't installed on this host. Install it, then try again.";

type Json = Record<string, unknown>;

const configDir = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode");
/** Your OpenCode config, for every project: the first of these that exists, as OpenCode's own writer picks. */
function userFile(): string {
  const files = ["opencode.jsonc", "opencode.json", "config.json"].map((f) => path.join(configDir(), f));
  return files.find((f) => existsSync(f)) ?? files[1];
}

/** The folder's own OpenCode file, which OpenCode reads after the project's shared opencode.json. */
const FOLDER_FILE = ".opencode/opencode.json";
const folderFile = (cwd: string) => path.join(cwd, ".opencode", "opencode.json");

type Api = { url: string; auth: string | null };

/** One call to an OpenCode server's API, for a folder when there's a `cwd`. */
async function call<T = Json>(
  api: Api,
  method: string,
  route: string,
  cwd: string | null,
  body?: unknown,
): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);
  try {
    const res = await fetch(`${api.url}${route}${cwd ? `?directory=${encodeURIComponent(cwd)}` : ""}`, {
      method,
      headers: {
        ...(api.auth ? { authorization: api.auth } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
    });
    const text = await res.text();
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // a plain-text answer
    }
    if (!res.ok) {
      const e = value as { data?: { message?: string }; message?: string; error?: string } | string;
      throw new Error(
        (typeof e === "string" ? e : (e?.data?.message ?? e?.message ?? e?.error)) ||
          `OpenCode answered ${res.status}`,
      );
    }
    return value as T;
  } catch (error) {
    if (abort.signal.aborted) throw new Error("OpenCode took too long to answer");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An `opencode serve` of our own, without OpenCode plugins and behind a password: OpenCode's API,
 * as Paseo uses it. It reads each folder's config as a chat there would.
 */
function serve(): Promise<Api & { stop(): void }> {
  const password = randomBytes(18).toString("base64url");
  const child = spawnProcess(bin(), ["serve", "--pure", "--port", "0"], {
    cwd: os.tmpdir(),
    stdio: "pipe",
    env: { ...process.env, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password },
  });
  return new Promise((resolve, reject) => {
    let said = "";
    const fail = (error: Error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("OpenCode took too long to start")), 30_000);
    child.on("error", (error) =>
      fail((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(MISSING) : error),
    );
    child.on("exit", () => fail(new Error(lastLine(said) ?? "OpenCode stopped before starting")));
    // read all it says, so it never waits on a full pipe
    const read = (chunk: Buffer) => {
      said = (said + chunk.toString("utf8")).slice(-8192);
      const url = /listening on (http:\/\/\S+)/.exec(said)?.[1];
      if (!url) return;
      clearTimeout(timer);
      resolve({
        url,
        auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        stop: () => child.kill(),
      });
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
  });
}

/** Paseo's own OpenCode servers, which its chats use: Paseo records each one it starts. */
async function paseoServers(): Promise<Api[]> {
  const dir = path.join(
    process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
    "runtime",
    "managed-processes",
  );
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const auth = password
    ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`).toString("base64")}`
    : null;
  const found: Api[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const record = await readJson(path.join(dir, name)).catch(() => ({}) as Json);
    const port = (record.metadata as { port?: unknown } | undefined)?.port;
    if (
      (record.owner as { provider?: string } | undefined)?.provider !== "opencode" ||
      typeof port !== "number"
    )
      continue;
    try {
      process.kill(record.pid as number, 0);
    } catch {
      continue;
    }
    found.push({ url: `http://127.0.0.1:${port}`, auth });
  }
  return found;
}

/**
 * Has Paseo's OpenCode read the config again, as OpenCode's own settings do. A folder's file is read
 * again once OpenCode disposes the folder; yours only when OpenCode's own writer changes the file, so
 * it's asked to save it as it is: Toolbox ends the JSON with a newline and OpenCode doesn't, so it
 * saves, reloads, and disposes every folder.
 */
async function refreshPaseo(cwd: string, user: boolean): Promise<void> {
  // ponytail: a server that doesn't answer is on its way out; its chats get the change when Paseo starts OpenCode again
  for (const api of await paseoServers())
    await (
      user ? call(api, "PATCH", "/global/config", null, {}) : call(api, "POST", "/instance/dispose", cwd)
    ).catch(() => {});
}

/** OpenCode's wildcards: * is any run of characters, ? one. */
const wild = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "s",
  ).test(value);

/**
 * What OpenCode's `permission` config says for a permission (a tool's name, "skill") and pattern:
 * its rules in order, the last that matches deciding. With none, OpenCode allows.
 */
export function decide(permission: unknown, name: string, pattern = "*"): Behavior {
  const rules: [string, string, unknown][] =
    typeof permission === "string"
      ? [["*", "*", permission]]
      : Object.entries((permission ?? {}) as Json).flatMap(([key, value]): [string, string, unknown][] =>
          typeof value === "string"
            ? [[key, "*", value]]
            : Object.entries((value ?? {}) as Json).map(([p, v]): [string, string, unknown] => [key, p, v]),
        );
  let behavior: Behavior = "allow";
  for (const [key, p, v] of rules)
    if ((v === "allow" || v === "ask" || v === "deny") && wild(key, name) && wild(p, pattern)) behavior = v;
  return behavior;
}

/** A pattern for all of a server's tools, which OpenCode names `<server>_<tool>`. */
export const toolsOf = (server: string) => `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`;

/** The folder's own rules to add to: a single word ("ask") is OpenCode's short way to write `"*"`. */
export const rulesOf = (own: unknown): Json =>
  own && typeof own === "object" ? { ...(own as Json) } : typeof own === "string" ? { "*": own } : {};

/**
 * Where the folder's skill switches go. OpenCode reads its own permissions (`skill`, `bash`, …)
 * before any others, so a `"*"` rule ("permission": "allow" is one) always comes after `skill` and
 * wins. `skill*` names the same permission but isn't one of OpenCode's, so it stays after `"*"`.
 */
const SKILL_RULES = "skill*";

/**
 * Edits the folder's own OpenCode file. An entry for a server nothing else defines would be an
 * incomplete server, which stops OpenCode in the folder, so those go.
 */
export function editFolder(cwd: string, configured: Set<string>, edit: (doc: Json) => void) {
  return serially(async () => {
    if (await sharedInGit(cwd, FOLDER_FILE))
      throw new Error(`This repository shares ${FOLDER_FILE}, so Toolbox won't write your switches there`);
    const file = folderFile(cwd);
    const doc = await readJson(file);
    edit(doc);
    const servers = { ...((doc.mcp ?? {}) as Record<string, Json>) };
    for (const [name, entry] of Object.entries(servers))
      if (!Object.keys(entry).length || (!("type" in entry) && !configured.has(name))) delete servers[name];
    if (Object.keys(servers).length) doc.mcp = servers;
    else delete doc.mcp;
    // nothing left of the folder's own settings (OpenCode adds a $schema): no file either
    if (Object.keys(doc).every((k) => k === "$schema")) return void (await rm(file, { force: true }));
    await writeJson(file, doc);
    await keepOutOfGit(cwd, FOLDER_FILE, "your OpenCode switches for this folder");
  });
}

/** Edits your OpenCode config, then has Paseo's OpenCode read it again. */
async function editUser(cwd: string, edit: (servers: Record<string, Json>) => void) {
  await serially(async () => {
    const file = userFile();
    const doc = await readJson(file);
    const servers = { ...((doc.mcp ?? {}) as Record<string, Json>) };
    edit(servers);
    doc.mcp = servers;
    await writeJson(file, doc);
  });
  looks.forget(cwd);
  await refreshPaseo(cwd, true);
}

type Status = { status: string; error?: string };
type SkillInfo = { name: string; description: string; location: string; content: string };
type ServerEntry = { type?: string; url?: string; command?: string[]; oauth?: unknown };
type Look = {
  connectors: Connector[];
  skills: (SkillInfo & { on: boolean })[];
  servers: Record<string, ServerEntry>;
  // servers some file defines, which the folder's file may switch
  configured: Set<string>;
  permission: unknown;
};

const looks = cache<Look>();

/** A skill in the folder, not one of yours or OpenCode's own. */
const inProject = (cwd: string, s: SkillInfo) =>
  s.location !== "<built-in>" && !path.relative(cwd, s.location).startsWith("..");

function stateOf(s: Status, offHere: boolean): Pick<Connector, "state" | "detail"> {
  switch (s.status) {
    case "connected":
      return { state: "connected", detail: "" };
    case "disabled":
      return { state: "off", detail: offHere ? "Off in this folder" : "Off" };
    case "needs_auth":
      return { state: "signin", detail: "Needs sign-in" };
    default:
      return { state: "failed", detail: s.error?.split("\n")[0] ?? "Didn't start" };
  }
}

function look(cwd: string, refresh: boolean): Promise<Look> {
  return looks.get(cwd, refresh, async () => {
    const server = await serve();
    const [statuses, skills, config] = await Promise.all([
      call<Record<string, Status>>(server, "GET", "/mcp", cwd),
      call<SkillInfo[]>(server, "GET", "/skill", cwd),
      call(server, "GET", "/config", cwd),
    ]).finally(() => server.stop());
    // a file OpenCode reads isn't always one Toolbox can (comments): then it's someone else's
    const [own, user] = await Promise.all([
      readJson(folderFile(cwd)).catch(() => ({}) as Json),
      readJson(userFile()).catch(() => ({}) as Json),
    ]);
    const servers = (config.mcp ?? {}) as Record<string, ServerEntry>;
    const ownServers = (own.mcp ?? {}) as Record<string, Json>;
    const userServers = (user.mcp ?? {}) as Record<string, Json>;
    const { permission } = config;
    const connectors = Object.entries(statuses).map(([name, s]): Connector => {
      const entry = servers[name] ?? {};
      const scope = ownServers[name]?.type ? "local" : userServers[name]?.type ? "user" : "project";
      return {
        name,
        target: entry.url ?? (entry.command ?? []).join(" "),
        ...stateOf(s, ownServers[name]?.enabled === false),
        scope,
        fixedBy: null,
        removable: scope === "local" || scope === "user",
        // OpenCode lists a server's tools only to a chat
        tools: [],
        rule: { behavior: decide(permission, toolsOf(name)), lockedBy: null },
      };
    });
    return {
      connectors,
      skills: skills
        .filter((s, i, all) => all.findIndex((o) => o.name === s.name) === i)
        .map((s) => ({ ...s, on: decide(permission, "skill", s.name) !== "deny" })),
      servers,
      configured: new Set(Object.keys(servers).filter((n) => servers[n].type)),
      permission,
    };
  });
}

export const opencodeAgent: Agent = {
  async list(cwd, refresh) {
    const found = await look(cwd, refresh);
    const home = os.homedir();
    const sets = await skillSets([
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
      path.join(configDir(), "skills"),
      path.join(configDir(), "skill"),
      path.join(cwd, ".agents", "skills"),
      path.join(cwd, ".claude", "skills"),
      path.join(cwd, ".opencode", "skills"),
      path.join(cwd, ".opencode", "skill"),
    ]);
    const shared = await sharedInGit(cwd, FOLDER_FILE);
    return {
      connectors: found.connectors,
      plugins: [],
      skills: found.skills.map((s) => ({ name: s.name, description: s.description, on: s.on })),
      skillsOff: [],
      projectSkills: found.skills.filter((s) => inProject(cwd, s)).map((s) => s.name),
      skillSets: [
        ...sets,
        {
          title: "Built into OpenCode",
          source: "builtin",
          skills: found.skills.filter((s) => s.location === "<built-in>").map((s) => s.name),
        },
      ],
      scopes: { skills: "folder", plugins: "none", tools: "unknown" },
      addTo: ["folder", "everywhere"],
      notice: shared
        ? {
            text: `This repository shares ${FOLDER_FILE}, so Toolbox won't write your switches there.`,
            action: null,
          }
        : null,
    };
  },

  async save(cwd, changes) {
    const found = await look(cwd, false);
    for (const { kind, name } of changes) {
      if (kind === "plugin") throw new Error("OpenCode doesn't turn plugins on and off one at a time");
      if (kind === "connector" && !found.configured.has(name))
        throw new Error(`${name} isn't an OpenCode connector here`);
    }
    if (changes.length)
      await editFolder(cwd, found.configured, (doc) => {
        const servers = { ...((doc.mcp ?? {}) as Record<string, Json>) };
        const permission = rulesOf(doc.permission);
        const skills = rulesOf(permission[SKILL_RULES]);
        // set either way: something else may have turned it off
        for (const { kind, name, on } of changes)
          if (kind === "connector") servers[name] = { ...(servers[name] ?? {}), enabled: on };
          else skills[name] = on ? "allow" : "deny";
        doc.mcp = servers;
        if (changes.some((c) => c.kind === "skill"))
          doc.permission = { ...permission, [SKILL_RULES]: skills };
      });
    looks.forget(cwd);
    await refreshPaseo(cwd, false);
    // Paseo's chat keeps OpenCode's old tools until it restarts
    return { restart: true, commands: [] };
  },

  async add(cwd, name, where, server) {
    const found = await look(cwd, false);
    if (found.connectors.some((c) => c.name === name) || found.servers[name])
      throw new Error(`There's already a connector called ${name}`);
    if (where === "shared") throw new Error("Toolbox doesn't write OpenCode's shared project file");
    const entry: Json =
      server.type === "http"
        ? {
            type: "remote",
            url: server.url,
            ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
          }
        : {
            type: "local",
            command: [server.command, ...server.args],
            ...(Object.keys(server.env).length ? { environment: server.env } : {}),
          };
    if (where === "everywhere") {
      await editUser(cwd, (servers) => {
        servers[name] = entry;
      });
      return `Added ${name} for every project`;
    }
    await editFolder(cwd, found.configured, (doc) => {
      doc.mcp = { ...((doc.mcp ?? {}) as Json), [name]: entry };
    });
    looks.forget(cwd);
    await refreshPaseo(cwd, false);
    return `Added ${name} for this folder`;
  },

  async remove(cwd, name) {
    const found = await look(cwd, false);
    const connector = found.connectors.find((c) => c.name === name);
    if (!connector?.removable) throw new Error(`OpenCode can't remove ${name} from here`);
    // as written, to put back exactly
    let entry: Json | undefined;
    if (connector.scope === "local") {
      await editFolder(cwd, found.configured, (doc) => {
        const servers = { ...((doc.mcp ?? {}) as Record<string, Json>) };
        entry = servers[name];
        delete servers[name];
        doc.mcp = servers;
      });
      looks.forget(cwd);
      await refreshPaseo(cwd, false);
    } else {
      // the folder's switches for it would be an incomplete server once it's gone
      if (existsSync(folderFile(cwd)) && !(await sharedInGit(cwd, FOLDER_FILE)))
        await editFolder(cwd, new Set([...found.configured].filter((n) => n !== name)), () => {});
      await editUser(cwd, (servers) => {
        entry = servers[name];
        delete servers[name];
      });
    }
    if (!entry) throw new Error(`Couldn't find ${name} where OpenCode has it`);
    const removed = entry;
    return rememberRemoval(cwd, name, async () => {
      if (connector.scope === "user")
        return editUser(cwd, (servers) => {
          servers[name] = removed;
        });
      await editFolder(cwd, found.configured, (doc) => {
        doc.mcp = { ...((doc.mcp ?? {}) as Json), [name]: removed };
      });
      looks.forget(cwd);
      await refreshPaseo(cwd, false);
    });
  },

  async setRule(cwd, server, tool, behavior) {
    if (tool !== null) throw new Error("OpenCode's rules here are for all of a connector's tools");
    const found = await look(cwd, false);
    if (!found.servers[server]) throw new Error(`${server} isn't an OpenCode connector here`);
    await editFolder(cwd, found.configured, (doc) => {
      doc.permission = { ...rulesOf(doc.permission), [toolsOf(server)]: behavior };
    });
    looks.forget(cwd);
    await refreshPaseo(cwd, false);
    return { restart: true };
  },

  async skill(cwd, name) {
    const skill = (await look(cwd, false)).skills.find((s) => s.name === name);
    if (!skill) throw new Error(`${name} isn't an OpenCode skill here`);
    if (skill.location === "<built-in>")
      return { source: "Built into OpenCode", place: "other", path: null, content: skill.content, files: [] };
    const [source, place] = inProject(cwd, skill)
      ? ["This project", "project" as const]
      : ["Yours", "user" as const];
    return (
      (await skillAt(source, place, skill.location)) ?? {
        source,
        place,
        path: skill.location,
        content: skill.content,
        files: [],
      }
    );
  },

  /**
   * OpenCode's own sign-in, on a server kept for it. OpenCode waits for the browser on a localhost
   * port unless something already listens there: Toolbox does, and hands OpenCode the code, from the
   * browser or from an address pasted from another device.
   */
  async login(cwd, name, again) {
    const entry = (await look(cwd, false)).servers[name];
    if (!entry) throw new Error(`${name} isn't an OpenCode connector here`);
    if (entry.type !== "remote") throw new Error(`${name} runs on this host: there's nothing to sign in to`);
    // nothing to sign out of is fine ("No credentials found"): the sign-in that follows says how it went
    if (again) await run(bin(), ["mcp", "logout", name], cwd, MISSING).catch(() => {});
    const oauth = (entry.oauth && typeof entry.oauth === "object" ? entry.oauth : {}) as {
      redirectUri?: string;
      callbackPort?: number;
    };
    const redirect = new URL(
      oauth.redirectUri ?? `http://127.0.0.1:${oauth.callbackPort ?? 19876}/mcp/oauth/callback`,
    );
    const port = Number(redirect.port || 80);
    const server = await serve();
    let state: string | null = null;
    const listener = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== redirect.pathname) return void res.writeHead(404).end();
      const code = url.searchParams.get("code");
      const answer = (text: string) =>
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(`${text}\n`);
      if (!state || url.searchParams.get("state") !== state)
        return answer("This isn't the sign-in Toolbox is waiting for.");
      const finish = (ok: boolean, message: string) => {
        finishLogin(login, ok ? "done" : "failed", message);
        login.stop();
        forgetLogin(loginId);
        answer(`${message}. You can close this tab.`);
      };
      if (!code) return finish(false, url.searchParams.get("error_description") ?? "Sign-in was refused");
      call<Status>(server, "POST", `/mcp/${encodeURIComponent(name)}/auth/callback`, cwd, { code }).then(
        (s) => {
          looks.forget(cwd);
          if (s.status !== "connected") return finish(false, s.error ?? "Sign-in failed");
          finish(true, `Signed in to ${name}`);
          void refreshPaseo(cwd, false);
        },
        (error: Error) => finish(false, error.message),
      );
    });
    const { loginId, login } = trackLogin(() => {
      listener.close();
      server.stop();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", resolve);
      }).catch(() => {
        throw new Error(
          `Another sign-in is waiting on port ${port}, perhaps in OpenCode. Finish it, then try again.`,
        );
      });
      const started = await call<{ authorizationUrl?: string; oauthState?: string }>(
        server,
        "POST",
        `/mcp/${encodeURIComponent(name)}/auth`,
        cwd,
      );
      if (!started.authorizationUrl) {
        finishLogin(login, "done", `Signed in to ${name}`);
        login.stop();
        forgetLogin(loginId);
        looks.forget(cwd);
        return { loginId, url: null };
      }
      state = started.oauthState ?? new URL(started.authorizationUrl).searchParams.get("state");
      login.callbackPort = port;
      return { loginId, url: started.authorizationUrl };
    } catch (error) {
      finishLogin(login, "failed", (error as Error).message);
      forgetLogin(loginId);
      throw error;
    }
  },

  async trust() {
    throw new Error("OpenCode reads every folder's settings: there's nothing to trust");
  },
};
