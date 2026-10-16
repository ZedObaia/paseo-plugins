Resources shows what a Paseo host is spending its CPU, memory and disk on, and lets you clean up
Docker without leaving Paseo, on desktop or phone.

The sidebar row shows the host's CPU and memory use. The screen adds:

- CPU, memory and swap with the last 10 minutes as a chart, and free space per disk.
- Memory by app: processes grouped by app, so a dozen language servers or browser helpers show
  up as one line with a count. On macOS this includes compressed memory, like Activity Monitor,
  which is usually what fills swap.
- The top processes by CPU or memory.
- Docker: disk use by images, volumes, build cache and containers, the running containers, and
  each Compose project with its containers.

Actions:

- Stop a running container (tap its stop button twice), or all of them.
- Delete stopped containers, untagged images, unused anonymous volumes, the build cache or unused
  networks. Each asks first and says what it removes.
- Start, stop, restart or delete a container, and stop a Compose project or delete it with its
  volumes (its data) and networks. Both ask first.
- Terminate or force quit a process you own. Asks first.

Memory is shown in binary units, like Activity Monitor; disk and Docker sizes in decimal units,
like Finder and Docker. A Compose project is marked stale when its containers were started from a folder that no longer
exists, such as a deleted worktree.

Works on macOS and Linux hosts. Docker features need the Docker CLI on the host. Install the plugin
on every host you want to watch and switch between them with the screen's host picker.

The plugin reads `ps`, `top`, `df`, `mount`, `/proc`, `memory_pressure`, `sysctl` and the `docker`
CLI on the host and sends the results only to your Paseo apps. Nothing goes to agents or third
parties, and nothing is installed or downloaded.
