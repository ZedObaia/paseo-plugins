Linear shows each project's Linear issues in Paseo and starts agents on them, from as many Linear
accounts as you have. The **Linear** button in a workspace's header opens its **Linear** panel, as
do the **+** menus of the tab bar and the Explorer and the Command Center ("Show Linear issues").
The panel asks for a personal API key the first time, then for what this Paseo project shows: all
the issues of one of your accounts, or as many of its teams, projects and saved views as you tick,
on one board. It lists them as a board with a column per status in a workspace tab, and grouped by
status in the Explorer or on a phone. Each Paseo project keeps its own link, covering all its
workspaces and worktrees, so one can follow your work account and another a side project.
**Change**, under the name, changes what's ticked or unlinks it, and **Projects** in Linear's
settings lists every project with its link, to link many at once.

**Mine** keeps the issues assigned to you, **Done** adds completed and canceled ones, and the search
box matches titles, descriptions and identifiers like `ENG-123`. The labels on the listed issues
filter it further. A saved view brings its own filters, and these narrow it down.

Tap an issue for its actions:

- **New worktree** starts an agent in a new worktree on the issue's Linear branch (like
  `zeyad/eng-123-fix-login`), or on that branch again if an earlier worktree left it behind.
- **This workspace** starts it in the workspace the panel is open in.
- **Details** opens its description and latest comments, formatted with their images, with a box
  to add a comment as your account.
- **Status** moves the issue to another status of its team, and **Assign to me** takes it.
- The arrow opens it in Linear.

The agent's first message is the issue: its title, link, status, priority, assignee, project,
labels, description and latest comments, and what the Paseo project is linked to. It uses the model,
mode and thinking setting of your latest chat in that project, or of your latest chat anywhere;
start one chat in Paseo first if you have none. Agents working on an issue show on its card, the
ones started from it and the ones given it later, and opening one jumps to its chat.

To start from an issue in any project, use Paseo's own **New workspace**: **Attach Linear issue** in
its **+** menu searches your accounts like the pill does. With **New worktree**, the worktree goes on
the issue's Linear branch, unless you named a branch or picked an existing one, and is named after
the issue, and the new chat shows the issue on its pill. With **Local** the agent gets the issue in
its message, and **Attach only** puts it on the pill.

Each chat shows its issue on the pill above its message box, like **ENG-123** for an agent started
from that issue. A chat without one shows **Work on an issue**, which searches all your accounts: an
identifier finds that issue, other words search titles and descriptions, and nothing lists your open
issues, then everyone's. With several accounts each issue says which one it's from. The arrow keys
and Enter pick one. Add a message if you like, check the text the agent will get, and **Send**, or
**Attach only** to make it the chat's issue without sending anything. Without a message it asks the
agent to work on the issue, and to use Linear's tools, if it has them, for anything the text leaves
out. While the agent is working it's **Send and steer**, which adds the issue to the current turn.

Once a chat has an issue, its pill opens that issue as Linear has it now. **Send again** sends its
latest text, after new comments or edits, with a message if you like. **Change** gives the chat
another issue, **Detach** takes it off, and the arrow opens it in Linear. **Linear issue** in the
chat's **+** menu attaches an issue to the message you're writing instead, without changing the
pill.

Two commands do the same from the message box, for an issue you know the identifier of:
`/linear ENG-123`, with a message after it if you like, sends the issue to the chat and makes it the
chat's issue. `/linear-new ENG-123` starts an agent on it in a tab of its own in the workspace, from
a new chat's box, which has no pill yet; it uses the model of your latest chat, not the one picked
in that box. When two of your accounts each have an `ENG-123`, they ask you to pick it instead.

## Setup

Make a personal API key in Linear under **Settings → Account → Security & access**, and paste it
into the **Linear** panel the first time you open it. Each key is one Linear account, in one Linear
workspace; add more under **Accounts** in Linear's settings in Paseo (**Settings → Plugins**, then
Linear's **…** menu), or with **Add another Linear account** while linking a project. Linear checks
each key before it's saved, and adding an account again replaces its key. **Remove** asks once more,
since Linear shows a key only when you make it. `LINEAR_API_KEY` in the daemon's environment counts
as one more account. Accounts and links are saved on the host, so another Paseo host has its own.

It needs Paseo 0.11.4 or later, and works in the desktop, web and phone apps.

## Agent tools

Agents get Linear's own MCP server, `https://mcp.linear.app/mcp`, so they can find, create and edit
issues, comments and projects whenever you ask them to. They sign in as the account their project is
linked to, as `linear`. In a project that isn't linked they get every account, each as its own
server named after its workspace (`linear-acme`) when there are several. A project linked to an
account you removed gives its agents none until it's linked again. **Accounts** in Linear's settings
switches the tools to **Read only** (Linear's `/mcp/readonly` endpoint) or **Off**. It applies to
agents started after the change; Paseo's own background agents, like the ones that write commit
messages, never get it. An agent configured with its own `linear` MCP server keeps that one.

Agents that get the tools are also told, after any instructions they already have, that a Linear
issue reaches them as an attachment, that it's their task unless the message says otherwise, and to
use the tools for what it leaves out, like sub-issues, related issues and older comments. They're
told to change an issue in Linear, like its status or comments, only when asked.

## Limits

- A board shows the 200 most recently updated issues that match its filters, and says so when
  there are more.
- There's no dragging cards between columns: **Status** moves them.
- **Details** shows the 20 latest comments. Tables and embeds in them show as plain text.
- Label filters come from the issues listed, not from every label in Linear.
- Pi agents get no Linear tools: Paseo can't give MCP servers to Pi.
- Commands can't suggest issues as you type: they take an identifier. The pill and **+** menus
  search.
- An issue attached from a chat's **+** menu doesn't change its pill, since plugins aren't told what
  a message carried; only **New workspace** passes its first message's issue on, for a new worktree.
  **Attach only** sets it.
- A pill another app changed catches up within a minute. Agents started from an issue before
  version 0.3.0 get their issue on the pill once it's looked up in Linear, among the 200 most
  recently updated agents.
- Phones show a board icon where the web and desktop apps show Linear's logo.

## Security and data

The keys are stored in `plugin-data/linear/accounts.json` under Paseo's home directory, readable
only by the user running the daemon. Apps never get them back, only the workspace, name and email
each connects as. A key does go into the MCP configuration of each new agent that gets its account's
tools, to sign in to Linear's MCP server. Each chat's issue, its identifier, title, link and account,
is kept in `plugin-data/linear/chats.json` next to them.

The plugin talks to `api.linear.app`, and agents to `mcp.linear.app`, only once a key is set.
**Details** shows an issue's images by loading them in the app straight from where they're stored;
for the ones in Linear's own storage it asks Linear for links that work without a key for an hour,
so the app never gets the key. An issue you send or start an agent on, and whatever agents read with
Linear's tools, becomes part of their conversation, so it goes to the agent's model provider like
anything else you send.

Linear's logo comes from [Simple Icons](https://simpleicons.org) (CC0). Linear is a trademark of its
owner; this plugin isn't made or endorsed by Linear.
