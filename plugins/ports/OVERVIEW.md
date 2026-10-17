Ports shows what each workspace is serving. A workspace with a listening port gets a button in
its header listing its ports, and the **Ports** panel in the Explorer (or Command Center, "Show
open ports") lists them with the process or container behind each one. Press a port to open it:
in Paseo's browser on the desktop app, and in your browser on the web and on phones.

## How ports find their workspace

Every few seconds the plugin reads the host's listening TCP ports and gives each one to a
workspace by:

- the directory its process runs in, so `npm run dev` in a worktree shows up in that worktree;
- the workspace whose terminal started it, for a server started after leaving the workspace
  directory (Linux only);
- for Docker Compose containers, the project directory Compose records, so a worktree's own
  database and storage containers show up in it.

When several workspaces hold that directory, the deepest one wins, so a worktree inside a
project's folder keeps its own ports. Agents, plugins and other processes Paseo runs itself are
left out. A port the workspace's Paseo services were given is labelled with the service's name.

## Links from another machine

Links use the address your devices reach the host at. By default that comes from where the daemon
listens: localhost when it listens on loopback, its address when it listens on one (a Tailscale
IP, say), and when it listens on every interface, a Tailscale address or else another network
address. If that's wrong, for example when you connect through the relay or an SSH tunnel, set a
host name or address under **Settings → Plugins → Ports → Links**.

A server bound to loopback only, like Vite by default, can't be reached from another machine.
Opening or copying one on a remote host forwards it: the plugin listens on the link address, on
the same port number when it's free, and relays each connection, WebSockets and hot reload
included. The panel marks forwarded ports and can stop them. A forward also stops when its server
does and when the plugin stops. Anyone who can reach the link address can use a forwarded port,
with no authentication, so forward on a private network such as Tailscale.

## Requirements and limits

- Linux and macOS hosts. On macOS the plugin uses lsof, and only the working directory ties a
  process to a workspace.
- It sees the processes of the user the daemon runs as. Container ports need the docker CLI and
  access to the Docker socket; Docker ports outside a Compose project aren't tied to a workspace.
- Links are `http://`. A server that only speaks HTTPS, or isn't a web server at all (a database),
  is still listed.
- The header button opens ports in your browser; open them from the panel to use Paseo's browser.
