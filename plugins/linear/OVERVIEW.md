Linear shows each project's Linear issues in Paseo and starts agents on them, from as many Linear
accounts as you have. The **Linear** button in a workspace's header opens its **Linear** panel, as
do the **+** menus of the tab bar and the Explorer and the Command Center ("Show Linear issues").
The panel asks for a personal API key the first time, then for what this Paseo project shows: all
the issues of one of your accounts, or as many of its teams, projects and saved views as you tick,
on one board. It lists them as a board with a column per status in a workspace tab, and grouped by
status in the Explorer or on a phone. Each Paseo project keeps its own link, covering all its
workspaces and worktrees, so one can follow your work account and another a side project.
**Change**, under the name, changes what's ticked or unlinks it, and **Settings → Plugins → Linear →
Projects** lists every project with its link, to link many at once.

**Mine** keeps the issues assigned to you, **Done** adds completed and canceled ones, and the search
box matches titles, descriptions and identifiers like `ENG-123`. The labels on the listed issues
filter it further. A saved view brings its own filters, and these narrow it down.

Tap an issue for its actions:

- **New worktree** starts an agent in a new worktree on the issue's Linear branch (like
  `zeyad/eng-123-fix-login`), or on that branch again if an earlier worktree left it behind.
- **This workspace** starts it in the workspace the panel is open in.
- **Status** moves the issue to another status of its team, and **Assign to me** takes it.
- The arrow opens it in Linear.

The agent's first message is the issue: its title, link, status, priority, assignee, project,
labels, description and latest comments, and what the Paseo project is linked to. It uses the
model, mode and thinking setting of your latest chat in that project, or of your latest chat
anywhere; start one chat in Paseo first if you have none. Agents started from an issue show on its
card, and opening one jumps to its chat.

To give a chat an issue, press **Work on an issue** above its message box. It searches all your
accounts: an identifier finds that issue, other words search titles and descriptions, and nothing
lists your open issues, then everyone's. With several accounts each issue says which one it's from.
The arrow keys and Enter pick one. Add a message if you like, check the text the agent will get, and
**Send**. While the agent is working it's **Send and steer**, which adds the issue to the current
turn. **Linear issue** in the chat's **+** menu attaches one to the message you're writing instead.

## Accounts

Each personal API key is one Linear account, in one Linear workspace. Add more in **Settings →
Plugins → Linear → Accounts** (or **Add another Linear account** while linking a project); Linear
checks each key before it's saved, and adding an account again replaces its key. **Remove** asks
once more, since Linear shows a key only when you make it; projects linked to a removed account ask
to be linked again. `LINEAR_API_KEY` in the daemon's environment counts as one more account.

Make a key in Linear under **Settings → Account → Security & access**. Accounts and links are saved
on the host, so another Paseo host has its own.

## Agent tools

Agents get Linear's own MCP server, `https://mcp.linear.app/mcp`, so they can find, create and edit
issues, comments and projects whenever you ask them to. They sign in as the account their project is
linked to, as `linear`. In a project that isn't linked they get every account, each as its own
server named after its workspace (`linear-acme`) when there are several. **Settings → Plugins →
Linear → Accounts** switches it to **Read only** (Linear's `/mcp/readonly` endpoint) or **Off**. It
applies to agents started after the change; Paseo's own background agents, like the ones that write
commit messages, never get it. An agent configured with its own `linear` MCP server keeps that one.

## Limits

- A board shows the 200 most recently updated issues that match its filters, and says so when
  there are more.
- There's no dragging cards between columns: **Status** moves them.
- Label filters come from the issues listed, not from every label in Linear.

## Security and data

The keys are stored in `plugin-data/linear/accounts.json` under Paseo's home directory, readable only
by the user running the daemon. Apps never get them back, only the workspace, name and email each
connects as. A key does go into the MCP configuration of each new agent that gets its account's
tools, to sign in to Linear's MCP server.

The plugin talks to `api.linear.app`, and agents to `mcp.linear.app`, only once a key is set. An
issue's text becomes part of the agent's prompt, so it goes to the agent's model provider like
anything else you send.

Linear's logo comes from [Simple Icons](https://simpleicons.org) (CC0). Linear is a trademark of its
owner; this plugin isn't made or endorsed by Linear.
