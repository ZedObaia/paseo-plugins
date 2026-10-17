Ports shows what each workspace is serving and lets you share it. A workspace with a listening
port gets a button in its header listing its ports, and the **Ports** panel (Command Center,
"Show open ports") lists them with the process or container behind each one. It opens in the
Explorer on desktop and as a workspace tab on phones.
Press a port to open it: in Paseo's browser on the desktop app, and in your browser on the web and
on phones. Each port's **Share** button makes it reachable at HTTPS on your own devices, or by
anyone with the link.

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

## Links

Without sharing, a port's link uses the address your devices reach the host at. By default that
comes from where the daemon listens: localhost when it listens on loopback, its address when it
listens on one (a Tailscale IP, say), and when it listens on every interface, a Tailscale address
or else another network address. If that's wrong, for example when you connect through the relay
or an SSH tunnel, set a host name or address under **Settings → Plugins → Ports → Links**.

A server bound to loopback only, like Vite by default, can't be reached from another machine.
Opening or copying one on a remote host forwards it: the plugin listens on the link address, on
the same port number when it's free, and relays each connection, WebSockets and hot reload
included. Anyone who can reach the link address can use a forwarded port, with no
authentication, so this is meant for a private network such as Tailscale.

## Sharing

Nothing is shared until you choose to, port by port. Each share goes through a small HTTP proxy
inside the plugin, listening on 127.0.0.1. It gives the server the Host header `localhost:<port>`,
because dev servers such as Vite refuse requests for host names they don't know, and passes the
address the browser used in `X-Forwarded-Host`. It passes WebSocket upgrades through, so hot
reload keeps working, and it checks the password when the share has one.

### Private: only my devices

The port becomes reachable by the devices on your tailnet, over HTTPS. The plugin runs
`tailscale serve --bg --https=<port> http://127.0.0.1:<proxy>`, so the link becomes
`https://<machine>.<tailnet>.ts.net:<port>` with a real certificate. Phones need that for service
workers, the camera and secure cookies. It uses the server's own port number when that's free on
the machine's tailnet addresses, and another free port otherwise. This adds one tailnet-only entry
to the machine's serve settings, which `tailscale serve status` lists.

Where Tailscale has no HTTPS, a private share is the forward described under Links, over HTTP,
and nothing in Tailscale changes.

### Public: anyone with the link

A port only becomes public after you confirm it, and the panel then shows a **Public** badge with
the address, the password if there is one, and buttons to copy them and to stop. Choose how:

- **Tailscale Funnel.** The plugin runs
  `tailscale funnel --bg --yes --https=<port> http://127.0.0.1:<proxy>`, which adds an entry to the
  machine's serve settings and turns Funnel on for it, publishing it on the internet at
  `https://<machine>.<tailnet>.ts.net:<port>`. Funnel only allows ports 443, 8443 and 10000, and
  turning it on for a port that already serves something would publish that too, so the plugin
  only picks one nothing serves. That makes at most three public Funnel shares per machine, fewer
  when some of those ports are taken. The address stays the same, and names under `ts.net` are
  published in certificate transparency logs, where scanners find them, so Funnel shares default
  to a password.
- **Cloudflare quick tunnel.** The plugin runs `cloudflared tunnel --url http://127.0.0.1:<proxy>`
  and gives you the random `https://….trycloudflare.com` address it gets, which is new every time.
  It needs no Cloudflare account; traffic passes through Cloudflare's network. Nothing in
  Tailscale changes.

And who can open it:

- **Anyone with the password**, for people such as clients. The browser asks once; any user name
  works with the password the plugin generates (12 random characters) for that share.
- **Anyone with the link**, for webhooks and other services that can't log in.

### When shares end

A share ends when you stop it, a few seconds after its server stops listening, and when the
plugin stops, reloads or is disabled. Tailscale's serve settings belong to the whole machine and
outlive the plugin and Paseo, so the plugin writes down each entry it adds, and each cloudflared
it starts, in `plugin-data/ports/shares.json` under Paseo's home directory. When it starts, it
removes what an earlier run left behind. It only removes an entry that still serves exactly what
the plugin set up, and never changes any other serve or Funnel setting.

## Requirements and limits

- Linux and macOS hosts. On macOS the plugin uses lsof, and only the working directory ties a
  process to a workspace.
- It sees the processes of the user the daemon runs as. Container ports need the docker CLI and
  access to the Docker socket; Docker ports outside a Compose project aren't tied to a workspace.
- Private HTTPS and Funnel need the Tailscale CLI, logged in, with HTTPS certificates turned on
  for the tailnet (admin console, DNS). On Linux the daemon's user must be root or Tailscale's
  operator: `sudo tailscale set --operator=$USER` once. Funnel also needs the `funnel` node
  attribute in the tailnet policy. The Share dialog says which of these is missing.
- Cloudflare quick tunnels need `cloudflared` in the daemon's PATH. The plugin doesn't install
  it: on macOS run `brew install cloudflared`, on Linux use Cloudflare's packages.
- Unshared links are `http://`. A server that only speaks HTTPS, or isn't a web server at all (a
  database), is still listed.
- The header button opens ports in your browser; open them from the panel to use Paseo's browser.
