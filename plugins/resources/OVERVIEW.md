Resources shows what a Paseo host is spending its CPU, memory and disk on, and lets you clean up
Docker without leaving Paseo, on desktop or phone.

The sidebar row shows the host's CPU and memory use. The screen adds:

- CPU, memory and swap with the last 10 minutes as a chart, and free space per disk.
- Memory by app: processes grouped by app, so a dozen language servers or browser helpers show
  up as one line with a count. On macOS this includes compressed memory, like Activity Monitor,
  which is usually what fills swap.
- Processes grouped by Paseo workspace or project, with CPU and memory totals and expandable
  process lists. Switch to Top processes for the host-wide CPU or memory ranking.
- Docker: disk use by images, volumes, build cache and containers, the running containers, and
  each Compose project with its containers.

Actions:

- Stop a running container (tap its stop button twice), or all of them.
- Delete stopped containers, untagged images, unused anonymous volumes, the build cache or unused
  networks. Each asks first and says what it removes.
- Start, stop, restart or delete a container, and stop a Compose project or delete it with its
  volumes (its data) and networks. Both ask first.
- Terminate or force quit a process you own. Preview its current process tree to signal its
  descendants too. Each action asks first; tree previews expire after a minute and must be
  repeated if the tree changes. The daemon, this plugin and their supervisor processes are protected.

Memory is shown in binary units, like Activity Monitor; disk and Docker sizes in decimal units,
like Finder and Docker. A Compose project is marked stale when its containers were started from a folder that no longer
exists, such as a deleted worktree.

Works on macOS and Linux hosts. Docker features need the Docker CLI on the host. Install the plugin
on every host you want to watch and switch between them with the screen's host picker.

Grouping uses inherited Paseo workspace IDs on Linux, then process ancestry and unique working
folders. macOS uses ancestry and working folders. Shared folders are left unassigned rather than
choosing a workspace. Unregistered workspace IDs remain visible, including processes whose
workspace was archived. Project-root processes can appear without an active workspace. Group memory
is the sum of process memory, so shared pages can be counted more than once.

Tree actions target the previewed PIDs, not everything grouped under a workspace. Identities and
ownership are checked again before signalling. This is best-effort cleanup: detached processes,
children started during the action and restarted services may survive. A successful reply confirms
signals were sent, not that every process exited. Refresh to check for survivors.

The plugin reads `ps`, `top`, `df`, `mount`, `/proc`, `lsof`, `memory_pressure`, `sysctl` and the `docker`
CLI on the host. On Linux it reads its user’s process environments only to extract Paseo workspace
IDs; environment values are not sent to the app or logged. It sends metrics, process identities and
workspace/project labels only to your Paseo apps. Nothing goes to agents or third
parties, and nothing is installed or downloaded.
