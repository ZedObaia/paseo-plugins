import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COPY_EXIT, copyCommand } from "../shared/copy";
import { buildItems, groupSkills, parsePairs, skillMarkdown, splitCommand } from "../shared/items";
import { editProject } from "./codex";
import { decide, editFolder, rulesOf, toolsOf } from "./opencode";
import { effectiveRule, ruleFor, ruleName, ruleView } from "./rules";
import {
  mcpPermissions,
  packSkill,
  rawServer,
  setConnectors,
  setPermission,
  setSkills,
  skillFile,
  skillSets,
  skillsOff,
} from "./files";
import { callbackPort, loginUrl, parsePluginList, shellQuote, toConnectors } from "./parse";

test("toConnectors keeps state, scope, tools and target from Claude's mcp_status, and no headers", () => {
  const connectors = toConnectors([
    {
      name: "plugin:playwright:playwright",
      status: "connected",
      scope: "dynamic",
      source: "plugin",
      config: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
      tools: [
        { name: "browser_close", annotations: { destructive: true } },
        { name: "browser_snapshot", annotations: { readOnly: true } },
      ],
    },
    {
      name: "stitch",
      status: "needs-auth",
      scope: "user",
      source: "user",
      config: { type: "http", url: "https://stitch.googleapis.com/mcp", headers: { "X-Key": "secret" } },
    } as never,
    { name: "claude.ai Linear", status: "disabled", scope: "claudeai", source: "claudeai", config: {} },
    {
      name: "pencil",
      status: "failed",
      scope: "local",
      error: "ENOENT: ENOENT: no such file or directory",
      config: { command: "/x" },
    },
    { name: "team", status: "pending", scope: "project" },
  ]);
  assert.deepEqual(connectors, [
    {
      name: "plugin:playwright:playwright",
      target: "npx @playwright/mcp@latest",
      state: "connected",
      detail: "",
      scope: "plugin",
      tools: [
        { name: "browser_close", readOnly: false },
        { name: "browser_snapshot", readOnly: true },
      ],
    },
    {
      name: "stitch",
      target: "https://stitch.googleapis.com/mcp",
      state: "signin",
      detail: "Needs sign-in",
      scope: "user",
      tools: [],
    },
    {
      name: "claude.ai Linear",
      target: "",
      state: "off",
      detail: "Off in this folder",
      scope: "claudeai",
      tools: [],
    },
    {
      name: "pencil",
      target: "/x",
      state: "failed",
      detail: "ENOENT: no such file or directory",
      scope: "local",
      tools: [],
    },
    { name: "team", target: "", state: "pending", detail: "Still connecting", scope: "project", tools: [] },
  ]);
  assert.ok(!JSON.stringify(connectors).includes("secret"));
});

test("parsePluginList names each plugin's servers the way Claude does", () => {
  const output = JSON.stringify([
    {
      id: "figma@claude-plugins-official",
      scope: "user",
      enabled: true,
      installPath: "/p/figma",
      mcpServers: { figma: { type: "http" } },
    },
    { id: "frontend-design@claude-plugins-official", scope: "user", enabled: false },
    { id: "cowork@synced", scope: "synced" },
  ]);
  assert.deepEqual(parsePluginList(output), [
    {
      id: "figma@claude-plugins-official",
      enabled: true,
      scope: "user",
      connectors: ["plugin:figma:figma"],
      installPath: "/p/figma",
    },
    {
      id: "frontend-design@claude-plugins-official",
      enabled: false,
      scope: "user",
      connectors: [],
      installPath: null,
    },
    { id: "cowork@synced", enabled: true, scope: "synced", connectors: [], installPath: null },
  ]);
});

test("loginUrl finds the address inside the terminal's hyperlink escapes", () => {
  const url = "https://mcp.linear.app/authorize?response_type=code&state=abc";
  const output =
    'Starting authentication for "web"…\r\nVisit this URL to authorize:\r\n  ' +
    `\x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\n\r\nWaiting for authorization… (^C to cancel)\r\n`;
  assert.equal(loginUrl(output), url);
  assert.equal(
    callbackPort(
      "https://a.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A61933%2Fcallback&state=x",
    ),
    61933,
  );
  assert.equal(callbackPort("https://a.example/authorize?redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb"), null);
  assert.equal(loginUrl('Starting authentication for "web"…\r\n'), null);
});

test("shellQuote keeps every argument whole", () => {
  assert.equal(
    shellQuote(["claude", "mcp", "login", "claude.ai Linear"]),
    "'claude' 'mcp' 'login' 'claude.ai Linear'",
  );
  assert.equal(shellQuote(["it's"]), `'it'\\''s'`);
});

test("setSkills turns skills off in the folder's local settings and back on, keeping the rest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-"));
  const file = path.join(dir, ".claude", "settings.local.json");
  await setSkills(dir, [
    { name: "deslop", on: false },
    { name: "seo-audit", on: false },
  ]);
  assert.deepEqual(await skillsOff(dir), ["deslop", "seo-audit"]);
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), model: "opus" }));
  await setSkills(dir, [
    { name: "deslop", on: true },
    { name: "seo-audit", on: true },
  ]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { model: "opus" });
});

test("setConnectors keeps the folder's disabledMcpServers in ~/.claude.json, starting a new entry from Claude's defaults", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "toolbox-config-"));
  const file = path.join(configDir, ".claude.json");
  await writeFile(
    file,
    JSON.stringify({ numStartups: 3, projects: { "/other": { disabledMcpServers: ["x"] } } }),
    {
      mode: 0o600,
    },
  );
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    await setConnectors(dir, [
      { name: "claude.ai Linear", on: false },
      { name: "pencil", on: false },
    ]);
    await setConnectors(dir, [{ name: "pencil", on: true }]);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
  const config = JSON.parse(await readFile(file, "utf8"));
  const entry = config.projects[await realpath(dir)];
  assert.deepEqual(entry.disabledMcpServers, ["claude.ai Linear"]);
  assert.deepEqual(entry.allowedTools, []);
  assert.equal(entry.hasTrustDialogAccepted, false);
  assert.deepEqual(config.projects["/other"], { disabledMcpServers: ["x"] });
  assert.equal(config.numStartups, 3);
});

// what buildItems doesn't look at
const FIXED = { fixedBy: null, removable: false, rule: { behavior: "ask" as const, lockedBy: null } };

test("buildItems puts what needs the user first and labels where each thing comes from", () => {
  const lists = buildItems(
    "claude",
    {
      skills: null,
      connectors: [
        {
          name: "github",
          target: "https://api.githubcopilot.com/mcp (HTTP)",
          state: "connected",
          detail: "",
          scope: "user",
          tools: [],
          ...FIXED,
        },
        {
          name: "pencil",
          target: "/Applications/Pencil.app/mcp",
          state: "off",
          detail: "Off in this folder",
          scope: "user",
          tools: [],
          ...FIXED,
        },
        {
          name: "claude.ai Linear",
          target: "https://mcp.linear.app/mcp",
          state: "signin",
          detail: "Needs sign-in",
          scope: "claudeai",
          tools: [],
          ...FIXED,
        },
        {
          name: "plugin:figma:figma",
          target: "https://mcp.figma.com/mcp (HTTP)",
          state: "failed",
          detail: "HTTP 500",
          scope: "plugin",
          tools: [],
          ...FIXED,
        },
      ],
      plugins: [
        {
          id: "figma@claude-plugins-official",
          enabled: true,
          scope: "user",
          connectors: ["plugin:figma:figma"],
        },
        { id: "cowork@synced", enabled: true, scope: "synced", connectors: [] },
      ],
      skillsOff: ["seo-audit"],
    },
    [
      { name: "deslop", description: "Remove AI slop", kind: "skill" },
      { name: "figma:figma-use", description: "Use Figma", kind: "skill" },
      { name: "figma:figma-sync", description: "Sync", kind: "command" },
      { name: "compact", description: "Compact", kind: "command" },
    ],
  );
  assert.deepEqual(
    lists.connector.map((i) => [i.title, i.meta, i.tone, i.on, i.signin]),
    [
      ["Linear", "Needs sign-in · claude.ai", "warning", true, true],
      ["figma", "HTTP 500", "danger", true, false],
      ["github", "api.githubcopilot.com", "muted", true, false],
      ["pencil", "Off in this folder · /Applications/Pencil.app/mcp", "muted", false, false],
    ],
  );
  assert.deepEqual(
    lists.skill.map((i) => [i.name, i.meta, i.on]),
    [
      ["deslop", "Remove AI slop", true],
      ["seo-audit", "Off in this folder", false],
    ],
  );
  assert.deepEqual(
    lists.plugin.map((i) => [i.title, i.meta]),
    [
      ["cowork", "From claude.ai"],
      ["figma", "1 skill · 1 command · 1 connector"],
    ],
  );
});

test("effectiveRule lets any deny win, then ask, then allow, and asks without a rule", () => {
  const server = "claude.ai Linear";
  assert.equal(ruleName(server), "mcp__claude_ai_Linear");
  const rules = [
    { rule: "mcp__claude_ai_Linear", behavior: "allow" as const, source: "user" as const },
    { rule: "mcp__claude_ai_Linear__delete_issue", behavior: "deny" as const, source: "local" as const },
    { rule: "mcp__claude_ai_Linear__create_issue", behavior: "ask" as const, source: "project" as const },
  ];
  assert.deepEqual(effectiveRule(rules, server, "list_issues"), { behavior: "allow", source: "user" });
  assert.deepEqual(effectiveRule(rules, server, "delete_issue"), { behavior: "deny", source: "local" });
  assert.deepEqual(effectiveRule(rules, server, "create_issue"), { behavior: "ask", source: "project" });
  assert.deepEqual(effectiveRule([], server, "x"), { behavior: "ask", source: null });
  // Ask writes a rule only when something else would allow the tool
  assert.deepEqual(ruleFor(rules, server, "list_issues", "ask"), {
    rule: "mcp__claude_ai_Linear__list_issues",
    behavior: "ask",
  });
  assert.deepEqual(ruleFor([], server, "list_issues", "ask"), {
    rule: "mcp__claude_ai_Linear__list_issues",
    behavior: "default",
  });
  assert.deepEqual(ruleFor(rules, server, null, "deny"), { rule: "mcp__claude_ai_Linear", behavior: "deny" });
  // a deny the folder doesn't own can't be changed here
  assert.deepEqual(ruleView(rules, server, "delete_issue"), { behavior: "deny", lockedBy: null });
  assert.deepEqual(
    ruleView([{ rule: "mcp__claude_ai_Linear", behavior: "deny", source: "user" }], server, "x"),
    { behavior: "deny", lockedBy: "your user settings" },
  );
});

test("setPermission keeps one rule per tool in the folder's local settings, and mcpPermissions reads all three files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "toolbox-config-"));
  await writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({ permissions: { allow: ["mcp__github", "Bash(ls:*)"] } }),
  );
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    await setPermission(dir, "mcp__github__delete_repo", "deny");
    await setPermission(dir, "mcp__github__create_issue", "ask");
    await setPermission(dir, "mcp__github__create_issue", "allow");
    await setPermission(dir, "mcp__github__delete_repo", "default");
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, ".claude", "settings.local.json"), "utf8")), {
      permissions: { allow: ["mcp__github__create_issue"] },
    });
    assert.deepEqual(await mcpPermissions(dir), [
      { rule: "mcp__github", behavior: "allow", source: "user" },
      { rule: "mcp__github__create_issue", behavior: "allow", source: "local" },
    ]);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("rawServer reads a server as written, for each scope Claude keeps them in", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "toolbox-config-"));
  const key = await realpath(dir);
  await writeFile(
    path.join(configDir, ".claude.json"),
    JSON.stringify({
      mcpServers: { stitch: { type: "http", url: "https://s", headers: { K: "${KEY}" } } },
      projects: { [key]: { mcpServers: { mine: { command: "cat" } } } },
    }),
  );
  await writeFile(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "npx" } } }));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    assert.deepEqual(await rawServer(dir, "stitch", "user"), {
      type: "http",
      url: "https://s",
      headers: { K: "${KEY}" },
    });
    assert.deepEqual(await rawServer(dir, "mine", "local"), { command: "cat" });
    assert.deepEqual(await rawServer(dir, "team", "project"), { command: "npx" });
    assert.equal(await rawServer(dir, "team", "user"), null);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("skillFile finds your skills, a project's and a plugin's, and refuses paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "toolbox-config-"));
  const pluginDir = await mkdtemp(path.join(os.tmpdir(), "toolbox-plugin-"));
  await mkdir(path.join(configDir, "skills", "deslop", "scripts"), { recursive: true });
  await writeFile(path.join(configDir, "skills", "deslop", "SKILL.md"), "---\nname: deslop\n---\nBody");
  await writeFile(path.join(configDir, "skills", "deslop", "scripts", "run.sh"), "");
  await mkdir(path.join(dir, ".claude", "skills", "seo"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "skills", "seo", "SKILL.md"), "Project skill");
  await mkdir(path.join(pluginDir, "skills", "figma-use"), { recursive: true });
  await writeFile(path.join(pluginDir, "skills", "figma-use", "SKILL.md"), "Plugin skill");
  const plugins = [{ id: "figma@x", enabled: true, scope: "user", connectors: [], installPath: pluginDir }];
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const mine = await skillFile(dir, "deslop", plugins);
    assert.equal(mine.source, "Yours");
    assert.equal(mine.place, "user");
    assert.match(mine.content, /Body/);
    assert.deepEqual(mine.files.sort(), ["scripts", path.join("scripts", "run.sh")].sort());
    assert.equal((await skillFile(dir, "seo", plugins)).source, "This project");
    assert.equal((await skillFile(dir, "seo", plugins)).place, "project");
    assert.equal((await skillFile(dir, "figma:figma-use", plugins)).content, "Plugin skill");
    assert.deepEqual(await skillFile(dir, "claude-api", plugins), {
      source: "Built into Claude Code",
      place: "other",
      path: null,
      content: "",
      files: [],
    });
    await assert.rejects(skillFile(dir, "..", plugins), /Not a skill name/);
    await assert.rejects(skillFile(dir, "a/b", plugins), /Not a skill name/);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("skillSets groups skills by the repository the skills CLI got them from, else by their author", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "toolbox-home-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "toolbox-config-"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-"));
  await mkdir(path.join(home, ".agents"), { recursive: true });
  await writeFile(
    path.join(home, ".agents", ".skill-lock.json"),
    JSON.stringify({
      skills: {
        polish: { source: "pbakaus/impeccable" },
        audit: { source: "pbakaus/impeccable" },
        "flutter-test": { source: "flutter/skills" },
      },
    }),
  );
  for (const [name, author] of [
    ["seo", "AgriciDaniel"],
    ["seo-audit", "AgriciDaniel"],
    ["deslop", null],
  ] as const) {
    await mkdir(path.join(configDir, "skills", name), { recursive: true });
    const meta = author ? `metadata:\n  author: ${author}\n` : "";
    await writeFile(path.join(configDir, "skills", name, "SKILL.md"), `---\nname: ${name}\n${meta}---\nBody`);
  }
  const before = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    assert.deepEqual(await skillSets([path.join(configDir, "skills"), path.join(dir, ".claude", "skills")]), [
      { title: "impeccable", source: "pbakaus/impeccable", skills: ["polish", "audit"] },
      { title: "flutter", source: "flutter/skills", skills: ["flutter-test"] },
      { title: "AgriciDaniel", source: "author:AgriciDaniel", skills: ["seo", "seo-audit"] },
    ]);
  } finally {
    process.env.HOME = before.HOME;
    if (before.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before.CLAUDE_CONFIG_DIR;
  }
});

test("buildItems and groupSkills put two or more skills of one set under the set, singles flat, built-in last", () => {
  const lists = buildItems(
    "claude",
    {
      skills: null,
      connectors: [],
      plugins: [],
      skillsOff: [],
      skillSets: [
        { title: "impeccable", source: "pbakaus/impeccable", skills: ["polish", "audit", "not-here"] },
        { title: "flutter", source: "flutter/skills", skills: ["flutter-test"] },
        { title: "Built into Claude Code", source: "builtin", skills: ["claude-api", "simplify", "compact"] },
      ],
    },
    [
      { name: "polish", description: "", kind: "skill" },
      { name: "audit", description: "", kind: "skill" },
      { name: "flutter-test", description: "", kind: "skill" },
      { name: "deslop", description: "", kind: "skill" },
      { name: "simplify", description: "", kind: "skill" },
      { name: "claude-api", description: "", kind: "skill" },
      { name: "compact", description: "", kind: "command" },
    ],
  );
  const grouped = groupSkills(lists.skill).map((e) =>
    "skills" in e ? [e.title, e.skills.map((s) => s.name)] : e.name,
  );
  assert.deepEqual(grouped, [
    "deslop",
    "flutter-test",
    ["impeccable", ["audit", "polish"]],
    // Claude's own skills come last
    ["Built into Claude Code", ["claude-api", "simplify"]],
  ]);
});

test("editProject keeps the folder's Codex file out of git, drops overrides for unknown servers, and leaves a shared file alone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-codex-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  const file = path.join(dir, ".codex", "config.toml");
  const configured = new Set(["echo", "dotted.name"]);
  await editProject(dir, configured, (servers) => {
    servers.echo = { enabled: false };
    servers["dotted.name"] = { disabled_tools: ["x"], tools: { y: { approval_mode: "approve" } } };
    // an override for a server no layer defines would stop Codex in the folder
    servers.gone = { enabled: false };
  });
  const text = await readFile(file, "utf8");
  assert.match(text, /\[mcp_servers\.echo\]\nenabled = false/);
  assert.match(text, /\[mcp_servers\."dotted\.name"\.tools\.y\]/);
  assert.doesNotMatch(text, /gone/);
  assert.match(
    await readFile(path.join(dir, ".git", "info", "exclude"), "utf8"),
    /^\/\.codex\/config\.toml$/m,
  );
  assert.equal(git("status", "--short").toString(), "");
  // the last override gone, the file goes too
  await editProject(dir, new Set(), () => {});
  assert.equal(existsSync(file), false);
  // a file the repository shares is the team's
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "# team\n");
  git("add", "-f", ".codex/config.toml");
  await assert.rejects(
    editProject(dir, configured, (servers) => void (servers.echo = { enabled: false })),
    /shares \.codex\/config\.toml/,
  );
  assert.equal(await readFile(file, "utf8"), "# team\n");
});

test("splitCommand and parsePairs read the add form the way a shell and a config would", () => {
  assert.deepEqual(splitCommand("npx -y @playwright/mcp@latest"), ["npx", "-y", "@playwright/mcp@latest"]);
  assert.deepEqual(splitCommand(` node "/My Tools/server.js" --name='a b' "" `), [
    "node",
    "/My Tools/server.js",
    "--name=a b",
    "",
  ]);
  assert.deepEqual(parsePairs("Authorization: Bearer x:y\n\nX-Team: core", ":"), {
    Authorization: "Bearer x:y",
    "X-Team": "core",
  });
  assert.deepEqual(parsePairs("API_KEY=a=b", "="), { API_KEY: "a=b" });
  assert.throws(() => parsePairs("no separator", "="), /needs a =/);
});

test("decide reads OpenCode's permission config: the last matching rule wins, and nothing matching allows", () => {
  assert.equal(decide(undefined, toolsOf("echo")), "allow");
  assert.equal(decide("ask", toolsOf("echo")), "ask");
  const permission = {
    "*": "ask",
    edit: "deny",
    "echo_*": "allow",
    echo_ping: "deny",
    skill: { "*": "allow", "seo-*": "deny" },
  };
  // a rule for one tool isn't the connector's
  assert.equal(decide(permission, toolsOf("echo")), "allow");
  assert.equal(decide(permission, toolsOf("other")), "ask");
  assert.equal(decide(permission, "skill", "seo-audit"), "deny");
  assert.equal(decide(permission, "skill", "polish"), "allow");
  assert.equal(decide({ skill: "deny" }, "skill", "polish"), "deny");
  // OpenCode names tools <server>_<tool>, with anything but letters, digits, - and _ as _
  assert.equal(toolsOf("my.server"), "my_server_*");
  // OpenCode lists its own permissions first: a "*" after them wins over `skill`, not over `skill*`
  const merged = { skill: { polish: "deny" }, "*": "allow", "skill*": { "seo-*": "deny" } };
  assert.equal(decide(merged, "skill", "polish"), "allow");
  assert.equal(decide(merged, "skill", "seo-audit"), "deny");
  // a single word is short for "*"
  assert.deepEqual(rulesOf("ask"), { "*": "ask" });
  assert.deepEqual(rulesOf({ x: "deny" }), { x: "deny" });
  assert.deepEqual(rulesOf(undefined), {});
});

test("editFolder keeps the folder's OpenCode file out of git, drops switches for unknown servers, and leaves a shared file alone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-opencode-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  const file = path.join(dir, ".opencode", "opencode.json");
  const configured = new Set(["echo"]);
  await editFolder(dir, configured, (doc) => {
    doc.mcp = {
      echo: { enabled: false },
      // defined here, so it stays whatever else knows it
      mine: { type: "remote", url: "https://example.com/mcp" },
      // a switch for a server nothing defines would stop OpenCode in the folder
      gone: { enabled: false },
    };
    doc.permission = { "*": "allow", "echo_*": "deny" };
  });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    mcp: { echo: { enabled: false }, mine: { type: "remote", url: "https://example.com/mcp" } },
    permission: { "*": "allow", "echo_*": "deny" },
  });
  assert.match(
    await readFile(path.join(dir, ".git", "info", "exclude"), "utf8"),
    /^\/\.opencode\/opencode\.json$/m,
  );
  // nothing left of the folder's own settings but the $schema OpenCode adds: no file either
  await editFolder(dir, new Set(), (doc) => {
    doc.$schema = "https://opencode.ai/config.json";
    delete doc.permission;
    delete (doc.mcp as Record<string, unknown>).mine;
  });
  assert.equal(existsSync(file), false);
  await writeFile(file, "{}\n");
  git("add", "-f", ".opencode/opencode.json");
  await assert.rejects(
    editFolder(dir, configured, (doc) => void (doc.mcp = { echo: { enabled: false } })),
    /shares \.opencode\/opencode\.json/,
  );
  assert.equal(await readFile(file, "utf8"), "{}\n");
});

/** Runs the copy command with `home` as HOME; resolves with the exit code it prints. */
function runCopy(home: string, rel: string, archive: string, replace: boolean): Promise<string> {
  const { command, args } = copyCommand(rel, archive, replace);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, HOME: home } });
    let out = "";
    child.stdout.on("data", (data) => {
      out += data;
      const exit = COPY_EXIT.exec(out);
      // it waits for the plugin to read this before it ends
      if (exit) child.kill();
    });
    child.on("error", reject);
    child.on("exit", () => resolve(COPY_EXIT.exec(out)?.[1] ?? "none"));
  });
}

test("packSkill packs one of your skills, and the copy puts it in the same place in another home, replacing only when asked", async () => {
  const from = await mkdtemp(path.join(os.tmpdir(), "toolbox-from-"));
  const to = await mkdtemp(path.join(os.tmpdir(), "toolbox-to-"));
  // linked into Claude's folder, as the skills CLI installs (here under another name), with a
  // virtualenv of its own and a link inside it
  const real = path.join(from, ".agents", "skills", "deslop-src");
  await mkdir(path.join(real, "scripts"), { recursive: true });
  await mkdir(path.join(real, ".venv"), { recursive: true });
  await writeFile(path.join(real, "SKILL.md"), "Body");
  await writeFile(path.join(real, "scripts", "run.sh"), "echo hi");
  await writeFile(path.join(real, ".venv", "pyvenv.cfg"), "");
  await symlink("scripts/run.sh", path.join(real, "run"));
  await mkdir(path.join(from, ".claude", "skills"), { recursive: true });
  await symlink("../../.agents/skills/deslop-src", path.join(from, ".claude", "skills", "deslop"));
  const home = process.env.HOME;
  process.env.HOME = from;
  let packed: { path: string; archive: string };
  try {
    packed = await packSkill({
      place: "user",
      path: path.join(from, ".claude", "skills", "deslop", "SKILL.md"),
    });
    await assert.rejects(
      packSkill({ place: "project", path: path.join(from, "x", "SKILL.md") }),
      /Only your own/,
    );
    await assert.rejects(
      packSkill({ place: "user", path: path.join(to, "x", "SKILL.md") }),
      /isn't in your home/,
    );
  } finally {
    process.env.HOME = home;
  }
  assert.equal(packed.path, ".claude/skills/deslop");

  const copied = path.join(to, ".claude", "skills", "deslop");
  assert.equal(await runCopy(to, packed.path, packed.archive, false), "0");
  assert.equal(await readFile(path.join(copied, "SKILL.md"), "utf8"), "Body");
  assert.equal(await readFile(path.join(copied, "scripts", "run.sh"), "utf8"), "echo hi");
  assert.ok((await lstat(copied)).isDirectory(), "the skill itself, not the link");
  assert.ok((await lstat(path.join(copied, "run"))).isSymbolicLink(), "links inside it stay links");
  assert.ok(!existsSync(path.join(copied, ".venv")), "not its virtualenv");

  await writeFile(path.join(copied, "SKILL.md"), "Changed there");
  assert.equal(await runCopy(to, packed.path, packed.archive, false), "3");
  assert.equal(await readFile(path.join(copied, "SKILL.md"), "utf8"), "Changed there");
  assert.equal(await runCopy(to, packed.path, packed.archive, true), "0");
  assert.equal(await readFile(path.join(copied, "SKILL.md"), "utf8"), "Body");

  // never anywhere but a skill's place in the home folder
  for (const rel of [
    "",
    ".claude",
    ".claude/skills",
    "../x/skills/deslop",
    ".claude/skills/../../x",
    "/tmp/skills/x",
  ])
    assert.equal(await runCopy(to, rel, packed.archive, true), "2", rel);
  assert.ok(existsSync(path.join(to, ".claude", "skills", "deslop", "SKILL.md")));
});

test("buildItems marks the project's own skills", () => {
  const lists = buildItems(
    "codex",
    {
      connectors: [],
      plugins: [],
      skills: [
        { name: "seo", description: "", on: true },
        { name: "deslop", description: "", on: true },
      ],
      skillsOff: [],
      projectSkills: ["seo"],
    },
    undefined,
  );
  assert.deepEqual(
    lists.skill.map((i) => [i.name, i.project]),
    [
      ["deslop", false],
      ["seo", true],
    ],
  );
});

test("skillMarkdown shows a skill's frontmatter as YAML, and leaves the rest as it is", () => {
  assert.equal(
    skillMarkdown("---\nname: deslop\ndescription: Remove slop\n---\n# Deslop\n\nText\n\n---\n"),
    "```yaml\nname: deslop\ndescription: Remove slop\n```\n\n# Deslop\n\nText\n\n---\n",
  );
  assert.equal(skillMarkdown("---\r\nname: x\r\n---\r\nBody"), "```yaml\nname: x\n```\n\nBody");
  assert.equal(
    skillMarkdown("# Command\n\n---\nnot frontmatter\n---\n"),
    "# Command\n\n---\nnot frontmatter\n---\n",
  );
});
