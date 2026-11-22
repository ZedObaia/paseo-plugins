import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { MAX_ARCHIVE } from "../shared/copy";
import type { Permission } from "./rules";
import { cliError } from "./run";
import type { ListedPlugin } from "./parse";

type Json = Record<string, unknown>;

/** A JSON object from disk; a missing file is empty. One that doesn't parse is reported, not replaced. */
export async function readJson(file: string): Promise<Json> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} isn't valid JSON. Fix it, then try again.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${file} isn't a JSON object`);
  return value as Json;
}

/** Replaces the file in one step, keeping its permissions (~/.claude.json is private). */
export async function writeJson(file: string, value: Json): Promise<void> {
  const mode = await stat(file).then(
    (s) => s.mode & 0o777,
    () => 0o644,
  );
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.toolbox-${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(tmp, file);
}

// one edit at a time: two quick applies would otherwise read the same file and drop one
let queue: Promise<unknown> = Promise.resolve();
export function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

/** The folder's own Claude settings, which Claude Code keeps out of git. */
const localSettings = (cwd: string) => path.join(cwd, ".claude", "settings.local.json");

/** Skills the folder's local settings turn off (`skillOverrides`, which Claude's /skills writes too). */
export async function skillsOff(cwd: string): Promise<string[]> {
  const overrides = (await readJson(localSettings(cwd))).skillOverrides;
  if (!overrides || typeof overrides !== "object") return [];
  return Object.entries(overrides)
    .filter(([, value]) => value === "off")
    .map(([name]) => name);
}

/** Turns skills off for the folder, or back on by dropping the folder's override. */
export function setSkills(cwd: string, changes: { name: string; on: boolean }[]): Promise<void> {
  return serially(async () => {
    const file = localSettings(cwd);
    const settings = await readJson(file);
    const overrides: Json = { ...(settings.skillOverrides as Json | undefined) };
    for (const { name, on } of changes) {
      if (on) delete overrides[name];
      else overrides[name] = "off";
    }
    if (Object.keys(overrides).length) settings.skillOverrides = overrides;
    else delete settings.skillOverrides;
    await writeJson(file, settings);
  });
}

// What Claude Code 2.1 starts a project's entry in ~/.claude.json from. An entry we create has
// them too, since Claude reads an existing entry as it is, without filling in defaults.
const PROJECT_DEFAULTS = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

const globalConfig = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), ".claude.json");
/** Claude's own directory: user settings, skills and commands. */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

/** How Claude keys a folder in ~/.claude.json: its git checkout's root (a worktree's own), resolved. */
export async function projectKey(cwd: string): Promise<string> {
  const root = await execCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 }).then(
    (r) => r.stdout.trim() || cwd,
    () => cwd,
  );
  return (await realpath(root)).normalize("NFC");
}

/**
 * Turns MCP servers off or on for the folder: the `disabledMcpServers` list Claude's /mcp keeps
 * per project. Claude re-reads ~/.claude.json under its lock before each write, so its own writes
 * keep this change.
 */
export function setConnectors(cwd: string, changes: { name: string; on: boolean }[]): Promise<void> {
  // ponytail: no lock of our own; a Claude write landing between our read and rename loses this change
  return serially(async () => {
    const key = await projectKey(cwd);
    const file = globalConfig();
    const config = await readJson(file);
    const projects = { ...(config.projects as Record<string, Json> | undefined) };
    const entry: Json = projects[key] ?? { ...PROJECT_DEFAULTS };
    const disabled = new Set(
      Array.isArray(entry.disabledMcpServers) ? (entry.disabledMcpServers as string[]) : [],
    );
    for (const { name, on } of changes) {
      if (on) disabled.delete(name);
      else disabled.add(name);
    }
    projects[key] = { ...entry, disabledMcpServers: [...disabled] };
    await writeJson(file, { ...config, projects });
  });
}

/** A server's entry as its configuration file has it (variables unexpanded), to put back after a removal. */
export async function rawServer(
  cwd: string,
  name: string,
  scope: "user" | "local" | "project",
): Promise<Json | null> {
  let servers: unknown;
  if (scope === "project") servers = (await readJson(path.join(cwd, ".mcp.json"))).mcpServers;
  else {
    const config = await readJson(globalConfig());
    servers =
      scope === "user"
        ? config.mcpServers
        : (config.projects as Record<string, Json> | undefined)?.[await projectKey(cwd)]?.mcpServers;
  }
  const entry = (servers as Record<string, unknown> | undefined)?.[name];
  return entry && typeof entry === "object" ? (entry as Json) : null;
}

/** Every rule about MCP tools in the three settings files Claude reads for the folder. */
export async function mcpPermissions(cwd: string): Promise<Permission[]> {
  const files = [
    ["user", path.join(claudeDir(), "settings.json")],
    ["project", path.join(cwd, ".claude", "settings.json")],
    ["local", localSettings(cwd)],
  ] as const;
  const found: Permission[] = [];
  for (const [source, file] of files) {
    // a settings file Claude can't read either has no rules to show
    const permissions = (await readJson(file).catch(() => ({}) as Json)).permissions as Json | undefined;
    for (const behavior of ["allow", "ask", "deny"] as const) {
      const rules = permissions?.[behavior];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules)
        if (typeof rule === "string" && rule.startsWith("mcp__")) found.push({ rule, behavior, source });
    }
  }
  return found;
}

/** Puts one rule in the folder's local settings under `behavior`, or takes it out ("default"). */
export function setPermission(
  cwd: string,
  rule: string,
  behavior: "allow" | "ask" | "deny" | "default",
): Promise<void> {
  return serially(async () => {
    const file = localSettings(cwd);
    const settings = await readJson(file);
    const permissions: Json = { ...(settings.permissions as Json | undefined) };
    for (const b of ["allow", "ask", "deny"] as const) {
      const rules = (Array.isArray(permissions[b]) ? (permissions[b] as string[]) : []).filter(
        (r) => r !== rule,
      );
      if (b === behavior) rules.push(rule);
      if (rules.length) permissions[b] = rules;
      else delete permissions[b];
    }
    if (Object.keys(permissions).length) settings.permissions = permissions;
    else delete settings.permissions;
    await writeJson(file, settings);
  });
}

const SKILL_TEXT_LIMIT = 64 * 1024;

/**
 * Where a skill (or a command, its older form) is written, and what it says. A plugin's are
 * "plugin:skill"; one without a file is built into Claude Code.
 */
export async function skillFile(cwd: string, name: string, plugins: ListedPlugin[]) {
  const parts = name.split(":");
  if (parts.length > 2 || parts.some((p) => !p || p === "." || p === ".." || /[/\\]/.test(p)))
    throw new Error("Not a skill name");
  let candidates: [string, Place, string][];
  if (parts.length === 2) {
    const [plugin, skill] = parts;
    const dir = plugins.find((p) => p.id.split("@")[0] === plugin)?.installPath;
    candidates = dir
      ? [
          [`${plugin} plugin`, "other", path.join(dir, "skills", skill, "SKILL.md")],
          [`${plugin} plugin`, "other", path.join(dir, "commands", `${skill}.md`)],
        ]
      : [];
  } else {
    candidates = [
      ["This project", "project", path.join(cwd, ".claude", "skills", name, "SKILL.md")],
      ["Yours", "user", path.join(claudeDir(), "skills", name, "SKILL.md")],
      ["This project", "project", path.join(cwd, ".claude", "commands", `${name}.md`)],
      ["Yours", "user", path.join(claudeDir(), "commands", `${name}.md`)],
    ];
  }
  for (const [source, place, file] of candidates) {
    const found = await skillAt(source, place, file);
    if (found) return found;
  }
  return { source: "Built into Claude Code", place: "other" as const, path: null, content: "", files: [] };
}

/** The names of a project's own Claude skills (and commands, their older form), in its folder. */
export async function projectSkills(cwd: string): Promise<string[]> {
  const [skills, commands] = await Promise.all(
    ["skills", "commands"].map((dir) => readdir(path.join(cwd, ".claude", dir)).catch(() => [] as string[])),
  );
  return [...skills, ...commands.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))];
}

export type Place = "user" | "project" | "other";

/** A skill's file and the others in its folder, or null when it isn't there. */
export async function skillAt(source: string, place: Place, file: string) {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const files =
    path.basename(file) === "SKILL.md"
      ? (await readdir(path.dirname(file), { recursive: true })).filter((f) => f !== "SKILL.md").slice(0, 100)
      : [];
  const content = text.length > SKILL_TEXT_LIMIT ? `${text.slice(0, SKILL_TEXT_LIMIT)}\n…` : text;
  return { source, place, path: file, content, files };
}

/**
 * One of your skills as a gzipped tar of its folder (a command: its file), base64, with where it
 * sits in your home folder: the same place on another host is where it goes.
 */
export async function packSkill(skill: { place: Place; path: string | null }) {
  if (skill.place !== "user" || !skill.path)
    throw new Error("Only your own skills can be copied to other hosts");
  const item = path.basename(skill.path) === "SKILL.md" ? path.dirname(skill.path) : skill.path;
  const rel = path.relative(os.homedir(), item);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`${item} isn't in your home folder, so other hosts have no same place for it`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "toolbox-pack-"));
  try {
    const file = path.join(tmp, "skill.tgz");
    // the skills CLI links skills into each agent's folder: it packs what the link points to, and
    // keeps links inside a skill as links (a Python .venv's lead to the whole interpreter). Without
    // what belongs to the host it was made on, and macOS's extended attributes and ._ files.
    const real = await realpath(item);
    await execCommand(
      "tar",
      [
        "-czf",
        file,
        "--no-xattrs",
        ...[".git", "node_modules", ".venv", "venv", "__pycache__"].map((dir) => `--exclude=${dir}`),
        "-C",
        path.dirname(real),
        path.basename(real),
      ],
      { timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: "1" } },
    ).catch((error) => {
      const tooBig = (error as { killed?: boolean }).killed;
      throw new Error(
        `Couldn't pack ${path.basename(item)}: ${tooBig ? "it's too big to copy" : cliError(error)}`,
      );
    });
    // base64 is 4 characters for every 3 bytes
    const { size } = await stat(file);
    if (Math.ceil(size / 3) * 4 > MAX_ARCHIVE) {
      const kb = size / 1024;
      throw new Error(
        `${path.basename(item)} is ${kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`} packed; up to ${Math.floor((MAX_ARCHIVE * 3) / 4 / 1024)} KB can be copied`,
      );
    }
    return { path: rel.split(path.sep).join("/"), archive: (await readFile(file)).toString("base64") };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export type SkillSet = { title: string; source: string; skills: string[] };

/**
 * Skills that came together. The skills CLI (`npx skills add owner/repo`) records each skill's
 * repository in ~/.agents/.skill-lock.json; other skills, in the agent's skill folders (`dirs`),
 * may name an author in their SKILL.md (`metadata: author:`). Skills with neither aren't grouped.
 */
export async function skillSets(dirs: string[]): Promise<SkillSet[]> {
  const sets = new Map<string, SkillSet>();
  const add = (source: string, title: string, skill: string) => {
    const set = sets.get(source) ?? { title, source, skills: [] };
    if (!set.skills.includes(skill)) set.skills.push(skill);
    sets.set(source, set);
  };
  const lock = (
    await readJson(path.join(os.homedir(), ".agents", ".skill-lock.json")).catch(() => ({}) as Json)
  ).skills as Record<string, { source?: unknown }> | undefined;
  const fromLock = new Set<string>();
  for (const [skill, entry] of Object.entries(lock ?? {})) {
    if (typeof entry?.source !== "string") continue;
    const [owner, repo = owner] = entry.source.split("/");
    // "flutter/skills" says more as "flutter"
    add(entry.source, /^(agent-)?skills$/i.test(repo) ? owner : repo, skill);
    fromLock.add(skill);
  }
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const skill of names) {
      if (fromLock.has(skill)) continue;
      const head = (await readFile(path.join(dir, skill, "SKILL.md"), "utf8").catch(() => "")).slice(0, 4096);
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] ?? "";
      const author = /^\s*author:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(frontmatter)?.[1];
      if (author) add(`author:${author}`, author, skill);
    }
  }
  return [...sets.values()];
}
