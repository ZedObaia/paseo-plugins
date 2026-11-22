Quick commands are your own shell commands for Paseo's workspaces. Save one for every project or
for one project, then run it in any of their workspaces: it opens a new terminal in the workspace
and runs it in your shell, with the workspace's branch, paths and ports in variables.

Run a command from:

- the **Quick commands** button in a workspace's header, which lists the workspace's commands,
  its project's first;
- the **Quick commands** panel, in the Explorer on desktop or as a workspace tab. On phones, where
  Paseo 0.12 shows no plugin buttons in the header, this is the way in;
- **Run …** in the Command Center;
- `/run <name>` in the message box, with the command's name or its start.

Each command also has a button to type it in without running it, for one you finish yourself.

## Setting up commands

**Settings → Plugins → Quick commands → Commands** lists them; there can be 40. Each has:

- **Name**: on its button and its terminal's tab, and what `/run` takes. Each name is used once.
- **Command**: one or more lines for your shell, run in order as if pasted.
- **For**: every project, or one project.
- **Folder**: where it runs inside the workspace, like `apps/web`.
- **Run it**: off, the command is typed in without pressing Enter.
- **Replace its last run**: closes the terminal its last run left in that workspace first, so a
  dev server restarts instead of piling up terminals.
- **Load .env**: exports the variables in the workspace's `.env`, and in the folder's `.env` when it
  runs in another folder, which wins. A new worktree has no `.env` (git ignores it) unless its
  setup copies one, so a missing file is read from the same place in the project's own checkout.
  Values are read the way dotenv reads them, without expanding `$OTHER` in them.

Commands are saved on the host and shared by every app connected to it. They aren't part of the
repository: for commands everyone working on it should have, use the scripts in its `paseo.json`.

## Variables

Every run has the variables Paseo gives `paseo.json` scripts, so a command copied from one works
the same:

- `PASEO_WORKTREE_PATH`: the workspace's folder.
- `PASEO_SOURCE_CHECKOUT_PATH`: the project's own checkout.
- `PASEO_BRANCH_NAME`: the branch checked out, empty when it's detached.
- `PASEO_WORKTREE_PORT`: the port Paseo gave a worktree it created.
- `PASEO_SERVICE_<NAME>_PORT` and `PASEO_SERVICE_<NAME>_URL`: each of the workspace's `paseo.json`
  services, like `PASEO_SERVICE_WEB_PORT` for one named web.

Paseo itself sets `PASEO_WORKSPACE_ID` in every terminal.

## How it runs

The terminal starts the daemon's shell (`$SHELL`), as Paseo's own terminals do, in the workspace's
folder. The plugin writes the variables to a file only your user can read, in the system's
temporary folder; the shell reads and deletes it as it starts, so the values never show in the
process list.

With bash, the command runs as the shell starts, after your `~/.bashrc`, so the terminal's tab shows
the command's name while it runs. It goes into the shell's history, and Ctrl+C stops it and leaves
you at a prompt. With zsh, sh and fish, the plugin waits for the first prompt and types the
command, and the tab shows what's running. Either way the shell stays open after the command ends.

## Data and permissions

Commands run as the daemon's user, with everything that user can do, like any terminal. To build
the variables the plugin reads the workspace's git files, Paseo's worktree metadata and, when
asked, `.env` files. It sends nothing anywhere, and nothing reaches agents or their model
providers. Anyone who can change this host's plugin settings can change the commands.

## Limits

- macOS and Linux hosts, with bash, zsh, sh, dash, ksh or fish as the daemon's shell. Windows hosts
  aren't supported yet.
- Paseo doesn't switch to a terminal a plugin opens: the new terminal is the last tab, and a
  message says it started.
- The Command Center lists every command in every workspace; one for another project says so when
  picked.
- Needs Paseo 0.12 or later.
