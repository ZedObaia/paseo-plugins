Auto fetch keeps your worktrees in Paseo and up to date. When you add a project, its existing git
worktrees become workspaces. Every few minutes it runs `git fetch --all --prune` in each
repository that has a worktree or checkout in Paseo on this host, so ahead and behind counts,
diffs against the base branch, and new worktrees reflect what's on the remote. It runs on the
daemon, so it keeps fetching while no app is connected.

Paseo fetches `origin` itself, every three minutes, but only while an app is watching a workspace
of that repository, and git's scheduled `git maintenance` prefetch downloads commits without moving
`origin/*`. Auto fetch also fetches when nobody is watching, fetches every remote (a worktree for a
pull request from a fork tracks the fork's remote), and moves local branches forward.

## Worktrees of a new project

Adding a project in Paseo gives it no workspaces, and Paseo doesn't look for worktrees you made
with git or another tool. When you add a project, the plugin gives each of its linked worktrees
that has no workspace yet its own, in that project and named after its branch, within a few
seconds. The main checkout gets none, as when Paseo adds a project, and nothing runs in the
worktrees. Only projects added after the plugin was installed count as new.

While any project has worktrees without a workspace, a row at the bottom of the sidebar says how
many, like **2 worktrees to add**. It lists those projects with their worktrees' branches and an
**Add** button each, and goes away once every worktree has a workspace. From inside a workspace,
**Add this project's worktrees as workspaces** in the Command Center does the same for its
project. A worktree whose workspace you archived in that project stays out. Hide the row under
**Settings → Sidebar** if you don't want it.

The plugin can create workspaces once an app connects or a workspace or agent is created. After
the daemon starts or the plugin reloads, a project added from the CLI may wait for that first
connection. Imports continue when the app disconnects. If importing a new project fails, it is
tried again on the next check. The sidebar shows imports in progress and their errors.

## New worktrees

A worktree for a new chat starts from the latest commit on the remote. When the app branches from
a remote branch, like `origin/main`, Paseo fetches that branch first. When an agent or the CLI
creates a worktree, Paseo branches from your local `main` instead, which is only as new as your
last pull. So when a new worktree would branch from a local branch, the plugin points it at the
remote branch that one tracks, and Paseo fetches it before branching. The worktree's ahead and
behind counts then compare against the remote branch. A local branch with commits of its own is
used as it is.

Checking out an existing branch in a new worktree, or branching from a local branch the plugin
leaves alone, waits for a fetch of the repository and a fast-forward of the branch first, at most
15 seconds, unless the repository was fetched in the last minute.

The app's default base is the branch your project folder is on. With the folder on a feature
branch, a new chat starts from that branch, not from `main`; pick `main` in the base picker.

## Fast-forwarding local branches

A fetch moves `origin/main`, not your local `main`. So after each fetch the plugin moves a local
branch up to the remote branch it tracks when:

- the branch is only behind it, with no commits of its own;
- no worktree has it checked out, and none is rebasing it.

That's what `git pull` would do if you checked the branch out, and it doesn't touch any files.
A branch checked out in your main checkout, like `main` often is, stays where it is. Each move is
in the branch's reflog as `auto-fetch: fast-forward to origin/<branch>`.

## Setup

Nothing to set up. Fetches use the `git` on the daemon's PATH and the credentials git already has
there, such as an SSH agent or a credential helper. It needs Paseo 0.11.4 or later, and works in
the desktop, web and phone apps. It runs on the daemon it's installed on, so install it on each
host whose worktrees you want in Paseo and kept fetched.

## Settings and status

Open **Settings → Plugins**, then Auto fetch's **…** menu, **Fetching**:

- **Fetch every**: how often each repository is fetched, from every minute to every hour (five
  minutes by default).
- **Fast-forward local branches**, **Start from the remote branch** and **Add their worktrees as
  workspaces**: each behaviour above, all on by default.
- **Repositories**: each repository with when it was last fetched, the branches it moved forward
  in the last day, the error from a fetch that failed, and **Fetch now**.

The Command Center also has **Fetch this workspace's repository** and **Fetch every repository**.

## Data and what it changes

The plugin talks only to your git remotes, through git, and to the Paseo daemon it runs in. It
sends nothing to agents or their model providers, adds no agent tools, and sends no prompts.

- It reads Paseo's project and workspace lists under Paseo's home directory, and runs git in those
  repositories.
- It changes local branches only by fast-forwarding them as above, and changes a new worktree's
  base branch only as described under **New worktrees**.
- It creates workspaces for existing worktrees, and never deletes or archives one.
- It keeps the projects it has seen in `plugin-data/auto-fetch/projects.json` under Paseo's home
  directory, and its settings with Paseo's plugin settings.

## Limits

- Fetches run as the daemon's user and never ask for credentials. A remote that needs a password
  or a passphrase the SSH agent doesn't hold fails, and the repository shows git's error. A
  repository that keeps failing is fetched less often, down to once an hour, until it works again.
- Repositories are fetched one at a time, and each fetch has two minutes.
- It only sees the projects of the daemon it's installed on.
