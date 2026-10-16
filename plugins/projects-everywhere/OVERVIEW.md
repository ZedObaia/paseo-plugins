Projects everywhere shows which projects each of your Paseo hosts has and adds a project to several
hosts at once, so your laptop and a remote dev box can have the same projects without adding each
one by hand.

The **Projects everywhere** screen lists every project on every online host. Projects are matched
across hosts by their git remote; a folder without one is matched by its place in the home folder.
Each project shows which hosts have it, with a button to add it to the others or to all of them at
once.

**Add project to hosts** (on the screen, and in the Command Center) takes `owner/repo` for GitHub,
an https or ssh clone URL, or a folder such as `~/workspace/notes`, and the hosts to add it to.
`~` is each host's own home folder.

When you add a project with Paseo's own Add project, the plugin asks whether to add it to the
hosts that don't have it yet.

## How a project is added

On each host, the folder is added as a project, as Paseo's Add project does. If the folder doesn't
exist there and the project has a git remote, the plugin first clones it into that folder:

- The clone runs `git clone` in a terminal on that host, because Paseo gives plugins no other way
  to run a command there. A terminal belongs to a workspace, so it opens briefly in one of that
  host's existing projects and closes once the clone finishes.
- It uses that host's own git setup and credentials. Prompts are turned off, so a missing
  credential fails with git's error instead of waiting.
- Only https and ssh remotes are cloned.

The host needs git installed and at least one project already open in Paseo.

## Data and access

The plugin runs inside the Paseo app and talks to each host through the connection the app already
has. It reads each host's project list and adds projects; it doesn't read your files or send
anything elsewhere. A clone contacts the git remote from the host doing the clone.

Install it on the hosts you use. It reaches every host your app is connected to, including ones
without the plugin, but only while they're online and the app is open.
