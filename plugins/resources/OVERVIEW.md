Resources shows what a Paseo host is spending its CPU, memory and disk on, and lets you clean up
Docker from Paseo, on desktop or phone.

The sidebar row shows the host's CPU and memory use. The screen adds swap, free disk space, the
top processes by CPU or memory, and Docker: images, containers, volumes and build cache with how
much of each can be reclaimed, and each Compose project with its containers.

Actions, each confirmed first:

- Terminate or force quit a process you own.
- Start, stop, restart or remove a container.
- Stop a Compose project, or remove it with its volumes (its data) and networks.
- Delete stopped containers, dangling images, unused anonymous volumes, the build cache or unused
  networks.

A project is marked stale when its containers were started from a folder that no longer exists,
such as a deleted worktree. Data comes from `ps`, `df`, `mount`, `/proc` or `memory_pressure`, and
the `docker` CLI on the daemon host; nothing leaves that machine. Install it on every host you
want to watch and pick the host in the screen's host picker. Docker features need the Docker CLI
on the daemon host.
