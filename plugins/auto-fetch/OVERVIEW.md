Auto fetch keeps your worktrees in Paseo and up to date. When you add a project, its existing git
worktrees become workspaces. Every few minutes it runs `git fetch --all --prune` in each
repository that has a worktree or checkout in Paseo on this host, so ahead and behind counts,
diffs against the base branch, and new worktrees reflect what's on the remote. It runs on the
daemon, so it keeps fetching while no app is connected.

Paseo fetches `origin` itself, every three minutes, but only while an app is watching a workspace
of that repository, and git's scheduled `git maintenance` prefetch downloads commits without moving
`origin/*`. Auto fetch also fetches when nobody is watching, fetches every remote (a worktree for a
pull request from a fork tracks the fork's remote), and moves local branches forward.

## Fast-forwarding local branches

A worktree that Paseo creates for an agent, or from the CLI, branches from your local `main`, and
its behind count compares against local `main`, which a fetch doesn't move. So after each fetch
the plugin moves a local branch up to the remote branch it tracks when:

- the branch is only behind it, with no commits of its own;
- no worktree has it checked out, and none is rebasing it.

That's what `git pull` would do if you checked the branch out, and it doesn't touch any files.
A branch checked out in your main checkout, like `main` often is, stays where it is. Each move is
in the branch's reflog as `auto-fetch: fast-forward to origin/<branch>`. Turn this off under
**Settings → Plugins → Auto fetch → Fetching**.

## Worktrees of a new project

Adding a project in Paseo gives it no workspaces, and Paseo doesn't look for worktrees you made
with git or another tool. When you add a project, the plugin gives each of its linked worktrees
that has no workspace yet its own, in that project and named after its branch, within a few
seconds. The main checkout gets none, as when Paseo adds a project, and nothing runs in the
worktrees. Only projects added after the plugin was installed count as new; for one you already
have, run **Add this project's worktrees as workspaces** from the Command Center in any of its
workspaces. Turn this off under **Settings → Plugins → Auto fetch → Fetching**, **New projects**.

The plugin needs a connected app to create workspaces: Paseo gives a plugin access to its API
only while answering the app or a hook. A project added from the CLI while no app is connected
gets its workspaces when an app next connects.

## New worktrees

A worktree for a new chat starts from the latest commit on the remote. When the app branches from
a remote branch, like `origin/main`, Paseo fetches that branch first. When an agent or the CLI
creates a worktree, Paseo branches from your local `main` instead, which is only as new as your
last pull. So when a new worktree would branch from a local branch, the plugin points it at the
remote branch that one tracks, and Paseo fetches it before branching. The worktree's ahead and
behind counts then compare against the remote branch. A local branch with commits of its own is
used as it is. Turn this off under **New worktrees**, **Start from the remote branch**.

Checking out an existing branch in a new worktree, or branching from a local branch the plugin
leaves alone, waits for a fetch of the repository and a fast-forward of the branch first, at most
15 seconds, unless the repository was fetched in the last minute.

The app's default base is the branch your project folder is on. With the folder on a feature
branch, a new chat starts from that branch, not from `main`; pick `main` in the base picker.

## Settings and status

**Settings → Plugins → Auto fetch → Fetching** has the switches above, sets how often each
repository is fetched, from every minute to every hour (five minutes by default), and lists each
repository with when it was last fetched, the branches it moved forward in the last day, the error
from a fetch that failed, and **Fetch now**. The Command Center has **Fetch this workspace's repository** and **Fetch every
repository**.

## Limits

- Fetches run as the daemon's user and never ask for credentials. A remote that needs a password
  or a passphrase the SSH agent doesn't hold fails, and the repository shows git's error. A
  repository that keeps failing is fetched less often, down to once an hour, until it works again.
- Repositories are fetched one at a time, and each fetch has two minutes.
- The plugin finds projects and workspaces in Paseo's lists under its home directory, so it only
  sees the daemon it's installed on. It keeps the projects it has seen in
  `plugin-data/auto-fetch/projects.json` there.
