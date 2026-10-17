Ports shows what each workspace is serving and lets you share it. A workspace with a listening
port gets a button in its header that opens its list of ports; the **Ports** panel (Command
Center, "Show open ports") shows the same list, in the Explorer on desktop and as a workspace tab
on phones. Each port has **Open**, **Copy link** and **Make public…**. Open uses Paseo's browser
on the desktop app and your browser on the web and on phones.

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

## Your own devices

Where Tailscale has HTTPS, a port's link is `https://<machine>.<tailnet>.ts.net:<port>`, with a
real certificate: phones need that for service workers, the camera and secure cookies. The first
time you open or copy it, the plugin runs
`tailscale serve --bg --https=<port> http://127.0.0.1:<proxy>`, which adds one tailnet-only entry
to the machine's serve settings (`tailscale serve status` lists it). It uses the server's own port
number when that's free on the machine's tailnet addresses, and another free port otherwise.

Elsewhere a link uses the address your devices reach the host at. By default that comes from
where the daemon listens: localhost when it listens on loopback, its address when it listens on
one (a Tailscale IP, say), and when it listens on every interface, a Tailscale address or else
another network address. If that's wrong, for example when you connect through the relay or an
SSH tunnel, set a host name or address under **Settings → Plugins → Ports → Links**. A server bound
to loopback only, like Vite by default, is forwarded: the plugin listens on the link address, on
the same port number when it's free, and relays each connection. Anyone who can reach that
address can use a forwarded port, so this is meant for a private network such as Tailscale.

Links over `tailscale serve`, and public links, go through a small HTTP proxy inside the plugin
on 127.0.0.1. It gives the server the Host header `localhost:<port>`, because dev servers such as
Vite refuse host names they don't know, and passes the address the browser used in
`X-Forwarded-Host`. It passes WebSocket upgrades through, so hot reload keeps working, and checks
the password when a public link has one.

## Public links

A port only becomes public when you press **Make public…**, read who will be able to open it, and
press **Make public**. The port then shows a **Public** box with the address and password and
buttons to open, copy and stop it.

- **Password.** Public links ask for one by default: the browser asks once, and any user name
  works with the 12 random characters the plugin generates for that link. Untick it for webhooks
  and other services that can't log in.
- **A random Cloudflare address**, the default. The plugin runs
  `cloudflared tunnel --url http://127.0.0.1:<proxy>`, a Cloudflare quick tunnel, and gives you the
  random `https://….trycloudflare.com` address it gets, which is new every time. It needs no
  Cloudflare account, and traffic passes through Cloudflare's network. Cloudflare offers quick
  tunnels for testing and development: they have no uptime guarantee, take up to 200 requests at
  a time, and don't support Server-Sent Events, so pages that stream updates that way need the
  Tailscale address. Nothing in Tailscale changes.
- **A stable Tailscale address**, offered when the tailnet allows Funnel. The plugin runs
  `tailscale funnel --bg --yes --https=<port> http://127.0.0.1:<proxy>`, which adds an entry to the
  machine's serve settings and turns Funnel on for it, publishing it at
  `https://<machine>.<tailnet>.ts.net:<port>`. Funnel only allows ports 443, 8443 and 10000, and
  turning it on for a port that already serves something would publish that too, so the plugin
  only picks one nothing serves: at most three public Funnel links per machine, fewer when some of
  those ports are taken. Names under `ts.net` are published in certificate transparency logs,
  where scanners find them.

### cloudflared

The plugin uses the `cloudflared` in the daemon's PATH, or in Homebrew's or `/usr/local/bin`, when
there is one. Otherwise the form offers to download it, and the button says so: **Download
cloudflared and make public**. Only that button downloads anything. The plugin then fetches
cloudflared 2026.10.1, Cloudflare's own build, from its releases on GitHub
(`github.com/cloudflare/cloudflared`): about 40 MB on Linux and 20 MB on macOS, for x64 and arm64.
It checks the file's size and SHA-256 against values built into the plugin, and the program's
SHA-256 against the checksum Cloudflare publishes for that release, and installs nothing if
either differs. It keeps the program in `plugin-data/ports/bin` under Paseo's home directory;
delete that folder to remove it.

## When links end

A public link ends when you stop it. Every link the plugin set up ends a few seconds after its
server stops listening, and when the plugin stops, reloads or is disabled. Tailscale's serve
settings belong to the whole machine and outlive the plugin and Paseo, so the plugin writes down
each entry it adds, and each cloudflared it starts, in `plugin-data/ports/shares.json` under
Paseo's home directory. When it starts, it removes what an earlier run left behind. It only
removes an entry that still serves exactly what the plugin set up, and never changes any other
serve or Funnel setting.

## Requirements and limits

- Linux and macOS hosts. On macOS the plugin uses lsof, and only the working directory ties a
  process to a workspace.
- It sees the processes of the user the daemon runs as. Container ports need the docker CLI and
  access to the Docker socket; Docker ports outside a Compose project aren't tied to a workspace.
- HTTPS links and Funnel need the Tailscale CLI, logged in, with HTTPS certificates turned on
  for the tailnet (admin console, DNS). On Linux the daemon's user must be root or Tailscale's
  operator: `sudo tailscale set --operator=$USER` once. Funnel also needs the `funnel` node
  attribute in the tailnet policy. The **Make public…** form says what's missing.
- The plugin can download cloudflared for Linux and macOS on x64 and arm64. Elsewhere, install
  it from Cloudflare for Cloudflare links.
- Without Tailscale HTTPS, links are `http://`. A server that only speaks HTTPS, or isn't a web
  server at all (a database), is still listed.
- The header button's list opens ports in your browser; open them from the panel to use Paseo's
  browser.
