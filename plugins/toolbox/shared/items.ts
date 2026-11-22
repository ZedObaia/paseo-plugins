import type { Change, Connector, Plugin, Provider } from "./contracts";

export const AGENT_NAMES: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/** One of the chat's commands, as Paseo lists them: Claude's skills have `kind: "skill"`. */
export type Command = { name: string; description: string; kind?: "command" | "skill" };

export type Item = {
  kind: Change["kind"];
  // what a change names: Claude's server name, the skill's name, the plugin's id
  name: string;
  title: string;
  meta: string;
  tone: "muted" | "warning" | "danger";
  // as Claude has it in the folder now
  on: boolean;
  // offers Connect
  signin: boolean;
  // changing it restarts the chat: Claude connects to MCP servers when a chat starts
  restarts: boolean;
  // a skill installed with others: shown under their set's row
  set?: { title: string; source: string };
  // a skill of the project's own, not in every project
  project?: boolean;
};

// what needs the user comes first
const RANK: Record<Connector["state"], number> = {
  signin: 0,
  failed: 1,
  warning: 2,
  pending: 3,
  connected: 4,
  off: 5,
};

/** "mcp.linear.app" for an address, the command line otherwise. (React Native's URL has no host.) */
export function shortTarget(target: string): string {
  const host = /^https?:\/\/([^/\s?#]+)/.exec(target)?.[1];
  if (host) return host;
  return target.length > 48 ? `${target.slice(0, 47)}…` : target;
}

export function connectorItem(c: Connector): Item {
  const plugin = /^plugin:([^:]+):(.+)$/.exec(c.name);
  const synced = c.name.startsWith("claude.ai ");
  const title = plugin ? plugin[2] : synced ? c.name.slice("claude.ai ".length) : c.name;
  const source = plugin ? `${plugin[1]} plugin` : synced ? "claude.ai" : shortTarget(c.target);
  return {
    kind: "connector",
    name: c.name,
    title,
    meta:
      c.state === "connected"
        ? source
        : c.state === "off" || c.state === "signin"
          ? `${c.detail} · ${source}`
          : c.detail,
    tone:
      c.state === "failed" ? "danger" : c.state === "connected" || c.state === "off" ? "muted" : "warning",
    on: c.state !== "off",
    signin: c.state === "signin",
    restarts: true,
  };
}

const byTitle = (a: Item, b: Item) => a.title.localeCompare(b.title);
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The panel's three lists. Codex lists its skills for the folder; Claude's are the chat's own, plus
 * those the folder turns off (which it no longer lists). A Claude plugin's skills aren't switched
 * one by one: Claude ties them to the plugin.
 */
export function buildItems(
  provider: Provider,
  listing: {
    connectors: Connector[];
    plugins: Plugin[];
    skills: { name: string; description: string; on: boolean }[] | null;
    skillsOff: string[];
    projectSkills?: string[];
    skillSets?: { title: string; source: string; skills: string[] }[];
    scopes?: { skills: "folder" | "everywhere" };
  },
  commands: Command[] | undefined,
): Record<Change["kind"], Item[]> {
  // Codex and OpenCode chats read every switch when they start
  const restartsAll = provider !== "claude";
  const connectors = listing.connectors
    .map((c) => ({ c, item: connectorItem(c) }))
    .sort((a, b) => RANK[a.c.state] - RANK[b.c.state] || byTitle(a.item, b.item))
    .map(({ item }) => item);

  const off = new Set(listing.skillsOff);
  const ofProject = new Set(listing.projectSkills);
  const own = (commands ?? []).filter((c) => c.kind === "skill" && !c.name.includes(":"));
  const offWords = listing.scopes?.skills === "everywhere" ? "Off everywhere" : "Off in this folder";
  const skills: Item[] = (
    listing.skills ?? [
      ...own.map((s) => ({ name: s.name, description: s.description, on: !off.has(s.name) })),
      ...[...off]
        .filter((name) => !own.some((s) => s.name === name))
        .map((name) => ({ name, description: "", on: false })),
    ]
  )
    .map(({ name, description, on }) => ({
      kind: "skill" as const,
      name,
      title: name,
      meta: on ? description : offWords,
      tone: "muted" as const,
      on,
      signin: false,
      restarts: restartsAll,
      project: ofProject.has(name),
    }))
    .sort(byTitle);
  // a set is worth a row when the chat has two of its skills or more
  for (const set of listing.skillSets ?? []) {
    const members = skills.filter((s) => set.skills.includes(s.name));
    if (members.length < 2) continue;
    for (const s of members) (s as Item).set = { title: set.title, source: set.source };
  }

  const plugins: Item[] = listing.plugins
    .map((p) => {
      const [title, marketplace = ""] = p.id.split("@");
      const mine = (commands ?? []).filter((c) => c.name.startsWith(`${title}:`));
      const skillCount = listing.skills
        ? (listing.skillSets?.find((s) => s.source === `plugin:${p.id}`)?.skills.length ?? 0)
        : mine.filter((c) => c.kind === "skill").length;
      const parts = [
        skillCount ? plural(skillCount, "skill") : "",
        mine.length > skillCount ? plural(mine.length - skillCount, "command") : "",
        p.connectors.length ? plural(p.connectors.length, "connector") : "",
      ].filter(Boolean);
      return {
        kind: "plugin" as const,
        name: p.id,
        title,
        meta: parts.join(" · ") || (p.scope === "synced" ? "From claude.ai" : marketplace),
        tone: "muted" as const,
        on: p.enabled,
        signin: false,
        // /reload-plugins doesn't reconnect a plugin's MCP servers
        restarts: restartsAll || p.connectors.length > 0,
      };
    })
    .sort(byTitle);

  return { connector: connectors, skill: skills, plugin: plugins };
}

/** Where a connector is configured, in words. */
export function scopeText(c: Connector, provider: Provider): string {
  if (provider === "codex")
    return c.scope === "user"
      ? "Yours, in every project"
      : c.scope === "project"
        ? "In this project's .codex/config.toml"
        : c.scope === "plugin"
          ? "From a Codex plugin"
          : "Comes with Codex";
  if (provider === "opencode")
    return c.scope === "user"
      ? "Yours, in every project"
      : c.scope === "local"
        ? "Only in this folder"
        : "In this project's OpenCode config";
  switch (c.scope) {
    case "user":
      return "Yours, in every project";
    case "local":
      return "Only in this folder";
    case "project":
      return "In this project's .mcp.json, shared with everyone using the repository";
    case "plugin":
      return `From the ${/^plugin:([^:]+):/.exec(c.name)?.[1] ?? ""} plugin`;
    case "claudeai":
      return "From your claude.ai account";
    default:
      return "Added for this chat by Paseo or a plugin";
  }
}

/** Where a set came from, in words: "pbakaus/impeccable" or "by AgriciDaniel"; a built-in set's title says it. */
export const setSource = (source: string) =>
  source === "builtin" ? "" : source.startsWith("author:") ? `by ${source.slice("author:".length)}` : source;

export type SkillGroup = { title: string; source: string; skills: Item[] };

/** The skills as the panel lists them: sets and single skills in name order, then Claude's own. */
export function groupSkills(skills: Item[]): (Item | SkillGroup)[] {
  const groups = new Map<string, SkillGroup>();
  const out: (Item | SkillGroup)[] = [];
  for (const skill of skills) {
    if (!skill.set) {
      out.push(skill);
      continue;
    }
    let group = groups.get(skill.set.source);
    if (!group) {
      group = { title: skill.set.title, source: skill.set.source, skills: [] };
      groups.set(skill.set.source, group);
      out.push(group);
    }
    group.skills.push(skill);
  }
  const last = (e: Item | SkillGroup) => ("skills" in e && e.source === "builtin" ? 1 : 0);
  return out.sort((a, b) => last(a) - last(b) || a.title.localeCompare(b.title));
}

/**
 * A skill's file as Markdown to show. Its YAML frontmatter becomes a code block: as Markdown, its
 * `---` lines would be a rule and a heading.
 */
export function skillMarkdown(content: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(content);
  return front ? `\`\`\`yaml\n${front[1]}\n\`\`\`\n\n${content.slice(front[0].length)}` : content;
}

/** A command line as the words a shell would pass: spaces split, quotes keep spaces in. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || word) words.push(word);
      word = "";
      started = false;
    } else word += ch;
  }
  if (started || word) words.push(word);
  return words;
}

/** "Name: value" or "KEY=value" lines as pairs; blank lines are skipped, a line without `sep` is an error. */
export function parsePairs(text: string, sep: ":" | "="): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(sep);
    if (at <= 0)
      throw new Error(
        `"${line}" needs a ${sep === ":" ? "colon, like Authorization: Bearer …" : "=, like API_KEY=…"}`,
      );
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return pairs;
}
