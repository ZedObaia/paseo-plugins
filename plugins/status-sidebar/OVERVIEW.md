# Default view (plugin)

A replica of Paseo's own **Default view** sidebar, built on the plugin API so it can be extended. It
copies the default view's layout, sizes, colors, icons, hover and selected states:

- A **Bots** section when the Fawzy plugin is installed: each bot with its chats underneath, its
  progress and whether a chat needs you. A chat opens in Paseo like any other agent. Pressing a bot
  opens its home, its avatar turns into a chevron that folds its chats, and + opens the home ready to
  type a new chat.
- A **bell** with a count of what needs you. Pressing it lists only those chats and workspaces, most
  urgent first; pressing it again brings everything back.
- A running chat or workspace shows a spinner and its current step with a progress bar ("2 of 4 ·
  Running the test suite"). Every agent the host opens, on any provider, is told to keep its task
  list current (Claude's tasks, Codex's plan, other agents' todos) or call the `report_progress`
  tool this plugin gives it; Claude Code's task tools are switched on for it. A line an agent leaves
  behind clears when its turn ends. Fawzy's bots can also use `set_status`.
- Bots and Workspaces fold away from their headers.
- One **Workspaces** section: pinned workspaces first, marked with a pin, then the projects. Its
  sliders menu has grouping by project or status, sort, title source, the row items it can show
  (branch, project, host, labels, diff stats or last activity), host, project and label filters,
  and Show background.
- Project rows with their colored square, a chevron on hover, the status of a collapsed project, and
  **+** for a new workspace. Workspace rows with their status, title, last activity, and on hover
  archive and the workspace menu (copy path or branch, rename, pin, archive).
- The hover card beside a workspace row on desktop and web: its pull request, diff, host, branch
  and path (both copy on press), and its CI checks, which open on GitHub.
- Archiving a worktree asks first only when it has uncommitted changes or unpushed commits, as in
  Paseo.
- Hovered rows are a clear step brighter than Paseo's, and the selected row brighter still.
- Choices are kept per device.

Select it under **Settings → Sidebar → Sidebar view**.

Left out for now: pull requests and checks on the rows themselves, services, unread marks, uploaded
project icons, label colors, other plugins' row items, manual ordering and the project menu.

Needs Paseo 0.16 (beta) or later.
