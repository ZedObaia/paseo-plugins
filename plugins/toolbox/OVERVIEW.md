Toolbox shows what your Claude, Codex and OpenCode chats can use (their connectors, skills and plugins) and
lets you switch them off and on, choose which tools run without asking, sign in to connectors,
remove connectors, and apply the change to a chat without losing the conversation. Each agent keeps
its settings its own way, so Toolbox writes them where that agent reads them; the Codex and
OpenCode sections below say what differs.

Open **Toolbox** from the + menu beside Files and Changes, with Command Center, "Open Toolbox", or
by typing `/toolbox` in a chat. It opens next to the chat; on a phone or a narrow window it opens as
a tab. It shows one agent at a time, and everything it lists and changes is that agent's. A switch at
the top says which (Claude, Codex or OpenCode) and picks another; under it, a row of chips shows
the workspace's chats with their agents, and the one Toolbox applies to: the chat you opened it
from, else the agent's most recent. An agent without a chat here gets what's saved for the chats
you start. It lists:

- **Connectors**: every MCP server the agent loads in the workspace's folder (your own, your
  plugins', and for Claude the ones synced from claude.ai), as the agent itself reports them there. The ones that need
  you come first, with **Connect** for those that need sign-in.
- **Skills**: your own skills, as the chat lists them, and the ones turned off here. Skills
  installed together are grouped under one row with a switch for all of them: those the
  [skills CLI](https://github.com/vercel-labs/skills) installed from one repository (it records
  that in `~/.agents/.skill-lock.json`), and those whose SKILL.md names the same author
  (`metadata: author:`). A set needs two skills or more; the rest are listed on their own. The
  skills built into Claude Code come last, as a set of their own. The project's own skills (in its
  `.claude/skills`, `.agents/skills` and the like) are listed first, under **This project**; the
  ones in every project (yours, plugins' and the agent's) under **Every project**.
- **Plugins**: the agent's plugins, with how many skills, commands and connectors each brings.

Flipping switches collects your changes in a bar at the bottom. **Apply** saves them and brings
the chat up to date: skills and plugins reload in place, with Claude's own `/reload-skills` and
`/reload-plugins`. A connector change, a plugin that brings connectors, a sign-in or a removal
restarts the chat instead (Paseo's Reload agent), because Claude connects to MCP servers when a
chat starts. The conversation stays. While the chat is working, Apply waits until it finishes its
turn. In a workspace without a chat, **Save** keeps them for the chats you start. Codex and
OpenCode chats restart for any change.

## Details

Press a connector or a skill for its details.

A connector's details say where it's configured (yours in every project, this folder only, the
project's shared `.mcp.json`, a plugin, or your claude.ai account), its address or command, and
its tools, with the ones that only read marked. Each tool has **Allow**, **Ask** or **Block**,
and **All tools** sets the whole connector. Allow runs the tool without asking; Block stops the
agent using it, whatever mode the chat is in. A choice is saved at once, for the folder, and the
chat follows it from its next tool call.

**Remove…** deletes the connector from Claude's configuration where it's defined, with
`claude mcp remove`, after saying what that reaches: every project for one of yours, everyone
using the repository for `.mcp.json`. **Undo** puts it back exactly as it was written, environment
references and all, for half an hour. A plugin's connectors go with the plugin, and claude.ai's
are removed in claude.ai's settings.

A skill's details show what it says it's for, where its file is, and the file itself, rendered as
Markdown with its frontmatter as YAML at the top.

## Copying a skill to another host

A skill of your own, in your home folder's skills (`~/.claude/skills`, `~/.agents/skills`,
`~/.codex/skills`, OpenCode's), has **Copy to other hosts** in its details: a **Copy** button for
each of your other hosts, and **Copy to all** for every one that's online. It goes in the same
folder on that host, so the same agent finds it there; chats there that start afterwards have it.
A skill the skills CLI linked into an agent's folder arrives as the skill itself, not the link.

- One that's there already isn't touched: the host says **Already there**, with **Replace**.
- Paseo gives plugins no other way to write on another host, so the copy runs in a terminal there,
  in one of its projects, and closes when done. The host doesn't need Toolbox, but it needs a
  project in Paseo.
- The skill's folder is packed without what belongs to the host it was made on (`.git`,
  `node_modules`, a Python `.venv`, `venv` or `__pycache__`), and can be about 440 KB packed at
  most. Links inside it stay links.
- A project's own skills don't have the button: they're in the project's folder, and usually travel
  with its repository.

## Adding a connector

**Add** beside Connectors takes a name, then either a web address (with optional headers) or a
command to start on this computer (with optional environment variables), and where it goes: this
folder only, every project, or for Claude the repository's shared `.mcp.json`, to commit for
everyone (Claude asks each person before using one from there). Values are saved as you type them;
most web connectors sign in instead, with **Connect** once added. Claude's are added with `claude mcp
add-json`; Codex's go in your `~/.codex/config.toml`, through Codex, or the folder's
`.codex/config.toml`. An open chat picks the new connector up when it restarts, which the bar
offers.

**Also add to** puts the same connector in the other agents too, for the same place, each in its own
settings (only Claude reads a shared `.mcp.json`). The agent you're on gets it first; if another
can't take it (it isn't installed, or already has one by that name), Toolbox says which and why.

## Where changes go

Switches apply to the folder, so every chat in it shares them. Paseo usually gives each task its
own worktree, which makes that one chat. They are written where Claude Code itself keeps them, so a
Claude you run in a terminal there sees the same thing:

- A skill off: `"skillOverrides": { "<skill>": "off" }` in the folder's
  `.claude/settings.local.json`. Turning it back on removes that line.
- A plugin off or on: `claude plugin disable|enable <plugin> --scope local`, which writes
  `enabledPlugins` in the same file.
- A tool's Allow, Ask or Block: a rule such as `mcp__github__create_issue` under `permissions` in
  the same file. Ask writes a rule only when another setting would allow the tool.
- A connector off: its name in the folder's `disabledMcpServers` in `~/.claude.json`, the list
  Claude's `/mcp` keeps. The folder is its git checkout's root.

A plugin's own skills turn on and off with the plugin: Claude doesn't switch them one by one. A
tool blocked in your user settings or the project's shared settings shows as blocked and can't be
changed here.

## Signing in

**Connect** runs `claude mcp login <connector>` on the host and opens its sign-in page in your
browser. When the browser is on the same computer as Paseo's host, it returns to Claude by itself
and the connector is ready. On a phone, or with a remote host, the browser ends on a
`http://localhost:…` page that can't load: paste that address into the box under the connector,
and Toolbox hands it to Claude on the host. A sign-in waits ten minutes, and **Cancel** stops it.
Afterwards the chat needs a restart to use the connector, which the bar offers.

A connector's details also have, as Claude Code's `/mcp` does:

- **Reconnect** restarts the chat (Paseo's Reload agent), which reconnects its connectors and
  keeps its history. Paseo gives plugins no way to reconnect one connector inside a running chat,
  and Claude refuses `/mcp reconnect` in a chat it runs for an app. It waits while the chat is
  working, and also takes care of a restart the bar was offering. Without a chat, it checks the
  connector again.
- **Sign in again**, for a web connector or a claude.ai one, signs it out first (`claude mcp
logout`, `codex mcp logout` or `opencode mcp logout`), then signs in as **Connect** does. Until
  you finish in the browser, the connector stays signed out.

## Codex

Codex reads a folder's own settings from a project `.codex/config.toml`, and only once you've
trusted the folder: until then the panel says so, with **Trust** (it writes the trust to your
`~/.codex/config.toml`, as Codex itself does, and also lets that repository's Codex hooks and skills
run).

- Connector switches and tool rules go in the folder's `.codex/config.toml`, which Toolbox keeps out
  of git in the repository's `.git/info/exclude`. A repository that commits its own
  `.codex/config.toml` is left alone, and the panel says why. Toolbox only writes a server there
  that your config defines: an override for any other would stop Codex in that folder, so one left
  behind by a removal is cleaned up.
- **Allow** sets the tool's `approval_mode = "approve"`, **Ask** sets `"prompt"`, and **Block** adds
  it to the server's `disabled_tools`. A Codex chat follows them after a restart.
- Codex switches skills and plugins in your user config, for every folder at once
  (`[[skills.config]]`, `[plugins."…"] enabled`), so the panel says "everywhere" for them. It writes
  those through Codex's own app-server, which keeps your file's comments and layout.
- Connectors that come with a Codex plugin, or with Codex itself, can't be switched or ruled per
  folder: their rows say so.
- **Remove** runs `codex mcp remove` for a connector in your user config; **Undo** puts it back as
  written. **Connect** uses Codex's own sign-in, with the same paste box for other devices.

To list connectors, tools and skills, Toolbox starts `codex app-server` in the folder, asks it what
Paseo asks, and stops it; no model runs.

## OpenCode

OpenCode reads a folder's `.opencode/opencode.json` after the project's shared `opencode.json`, so
that's where Toolbox writes your switches for the folder, kept out of git in the repository's
`.git/info/exclude`. A repository that commits its own `.opencode/opencode.json` is left alone, and
the panel says why.

- A connector off or on: `"enabled": false` or `true` under its name in `mcp`.
- A skill off or on: `"deny"` or `"allow"` for it under `permission` → `"skill*"`. OpenCode reads its
  own permission names (`skill`, `bash`, …) before any others, so a `"*"` rule, which
  `"permission": "allow"` is, would override a plain `skill` rule; `skill*` names the same
  permission but comes after `"*"`.
- **Allow**, **Ask** or **Block** for a connector: `"<server>_*"` under `permission`. OpenCode lists a
  connector's tools only to a chat, so its rules here are for all of a connector's tools. Block
  takes them away from the chat.
- **Add** writes `mcp` in the folder's file or in your `~/.config/opencode/opencode.json`; **Remove**
  takes it out of the file it came from, and **Undo** puts it back as written. Connectors from the
  project's shared files can be switched but not removed. OpenCode loads plugins as code, with
  nothing to switch, so there's no Plugins section.
- **Connect** uses OpenCode's own sign-in. OpenCode waits for the browser on
  `http://127.0.0.1:19876` unless something else listens there; Toolbox does, and hands OpenCode the
  code, so the paste box works for other devices too. A sign-in already waiting there, in an
  OpenCode window, has to finish first.

Paseo keeps one OpenCode server for its chats, and OpenCode reads its config once. After every
change Toolbox has that server read it again, as OpenCode's own settings do: it disposes the
folder, or, for a change to your own config, asks OpenCode to save that file through its own config
writer, which reloads it. To list connectors and skills, Toolbox starts an `opencode serve` of its
own, without OpenCode plugins and behind a one-time password, asks it what Paseo asks, and stops it;
no model runs.

## How it looks

For Claude, to list connectors and their tools, Toolbox starts Claude in the folder without a prompt and asks
it what the Agent SDK asks (`mcp_status`), then stops it. No model runs, hooks are off and no
session is saved. Claude starts the local connectors while it looks, which takes a few seconds; the
result is kept for a minute, and the refresh button looks again. Connectors' headers and
environment stay on the host.

## Requirements and limits

- Paseo 0.13 or newer, on the host and in the app.
- Claude, Codex and OpenCode chats: Claude Code 2.1 or newer, the Codex CLI, or OpenCode 1.19 or
  newer, on the host (on the daemon's PATH, in `~/.local/bin`, or for OpenCode in
  `~/.opencode/bin`).
- Toolbox reads and writes OpenCode's JSON files, not `opencode.jsonc` with comments: a connector
  you keep there can be switched but not removed from here.
- Signing in to a Claude connector needs a macOS or Linux host: it runs Claude's sign-in under
  `script`, which gives it the terminal it asks for.
- A skill or plugin you turned off elsewhere (your user settings, the project's shared settings)
  can't be turned back on from here.
- Copying a skill to another host needs a macOS or Linux host at each end, with `tar` and `base64`;
  Windows hosts can't take one yet.
