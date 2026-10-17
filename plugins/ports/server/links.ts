import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { canonicalAddress, isLoopback, isWildcard, urlHost } from "./address";
import type { Listener } from "./processes";

/** The daemon's listen setting, resolved the way the daemon resolves it. */
export function daemonListen(): string {
  if (process.env.PASEO_LISTEN) return process.env.PASEO_LISTEN;
  try {
    const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (typeof config?.daemon?.listen === "string") return config.daemon.listen;
  } catch {
    // no config file: the default below
  }
  return `127.0.0.1:${process.env.PORT ?? 6767}`;
}

/** This machine's IPv4 addresses that aren't loopback. */
function networkAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === "IPv4")
    .map((i) => i!.address);
}

// Tailscale hands out addresses in 100.64.0.0/10
const isTailscale = (address: string) => {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b >= 64 && b < 128;
};

/**
 * Where the app reaches this machine, judging by where the daemon listens: localhost when it
 * listens on loopback or a socket (the app runs here), its address when it listens on one, and
 * when it listens everywhere, a Tailscale address before any other.
 */
export function autoLinkHost(listen: string, addresses: string[]): string {
  if (listen.startsWith("/") || listen.startsWith("unix://")) return "localhost";
  const host = canonicalAddress(listen.slice(0, Math.max(listen.lastIndexOf(":"), 0)));
  if (isLoopback(host)) return "localhost";
  if (!isWildcard(host)) return host;
  return addresses.find(isTailscale) ?? addresses[0] ?? "localhost";
}

export const linkHost = (setting: string) =>
  setting.trim() || autoLinkHost(daemonListen(), networkAddresses());

interface Forward {
  server: Server;
  /** Where it listens: the target's port when that was free. */
  port: number;
  target: { address: string; port: number };
  sockets: Set<Socket>;
}

/**
 * Loopback-only ports, made reachable at the link host. Each forward relays raw TCP, so HTTP,
 * WebSockets and hot reload all pass through, and it stops when its port stops listening.
 */
export class Forwards {
  private forwards = new Map<number, Forward>();

  get(port: number): Forward | undefined {
    return this.forwards.get(port);
  }

  async open(listener: Listener, host: string): Promise<number> {
    const existing = this.forwards.get(listener.port);
    if (existing) return existing.port;
    const bind = isIP(host) ? host : (await lookup(host)).address;
    if (!Object.values(networkInterfaces()).some((list) => list?.some((i) => i.address === bind)))
      throw new Error(`${host} isn't an address of this machine, so ports can't be forwarded to it`);
    const target = { address: listener.address, port: listener.port };
    const sockets = new Set<Socket>();
    const server = createServer((incoming) => {
      const outgoing = connect(target.port, target.address);
      for (const socket of [incoming, outgoing]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {
          incoming.destroy();
          outgoing.destroy();
        });
      }
      incoming.pipe(outgoing).pipe(incoming);
    });
    // the same port number keeps links and hot-reload clients that hardcode it working;
    // if something already has it on that address, any free port will do
    const port = await listen(server, bind, listener.port).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") throw error;
      return listen(server, bind, 0);
    });
    this.forwards.set(listener.port, { server, port, target, sockets });
    console.log(`forwarding ${urlHost(bind)}:${port} to ${urlHost(target.address)}:${target.port}`);
    return port;
  }

  close(port: number): void {
    const forward = this.forwards.get(port);
    if (!forward) return;
    this.forwards.delete(port);
    forward.server.close();
    for (const socket of forward.sockets) socket.destroy();
    console.log(`stopped forwarding port ${port}`);
  }

  /** Stops forwards whose port no longer listens on loopback. */
  prune(listening: readonly Listener[]): void {
    for (const [port, forward] of this.forwards) {
      const still = listening.some((l) => l.port === port && l.address === forward.target.address);
      if (!still) this.close(port);
    }
  }

  closeAll(): void {
    for (const port of [...this.forwards.keys()]) this.close(port);
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}
