import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { canonicalAddress, isLoopback, isWildcard, urlHost } from "./address";
import type { Listener } from "./processes";
import { ListenerAccess, listenerId } from "./identity";

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
  target: Listener;
  sockets: Set<Socket>;
}

/**
 * Loopback-only ports, made reachable at the link host. Each forward relays raw TCP, so HTTP,
 * WebSockets and hot reload all pass through. Shares stops it when its port stops listening.
 */
export class Forwards {
  private forwards = new Map<string, Forward>();
  private opening = new Map<string, Promise<number>>();
  private generation = 0;
  private stopped = false;

  constructor(readonly access = new ListenerAccess()) {}

  get(id: string): Forward | undefined {
    return this.forwards.get(id);
  }

  open(listener: Listener, host: string): Promise<number> {
    if (this.stopped) return Promise.reject(new Error("The Ports plugin is stopping"));
    const id = listenerId(listener);
    const existing = this.forwards.get(id);
    if (existing) return Promise.resolve(existing.port);
    const pending = this.opening.get(id);
    if (pending) return pending;
    const next = this.start(listener, host, id, this.generation).finally(() => this.opening.delete(id));
    this.opening.set(id, next);
    return next;
  }

  private async start(listener: Listener, host: string, id: string, generation: number): Promise<number> {
    const bind = isIP(host) ? host : (await lookup(host)).address;
    if (!Object.values(networkInterfaces()).some((list) => list?.some((i) => i.address === bind)))
      throw new Error(`${host} isn't an address of this machine, so ports can't be forwarded to it`);
    const target = listener;
    const sockets = new Set<Socket>();
    const canConnect = this.access.guard(listener);
    let closed = false;
    const server = createServer(async (incoming) => {
      sockets.add(incoming);
      incoming.on("close", () => sockets.delete(incoming));
      incoming.on("error", () => incoming.destroy());
      if (!(await canConnect()) || closed || incoming.destroyed) return void incoming.destroy();
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
    if (generation !== this.generation) {
      closed = true;
      server.close();
      for (const socket of sockets) socket.destroy();
      throw new Error("The link settings changed while forwarding was being set up. Try again.");
    }
    server.on("close", () => {
      closed = true;
    });
    this.forwards.set(id, { server, port, target, sockets });
    console.log(`forwarding ${urlHost(bind)}:${port} to ${urlHost(target.address)}:${target.port}`);
    return port;
  }

  close(id: string): void {
    const forward = this.forwards.get(id);
    if (!forward) return;
    this.forwards.delete(id);
    forward.server.close();
    for (const socket of forward.sockets) socket.destroy();
    console.log(`stopped forwarding port ${forward.target.port}`);
  }

  entries(): IterableIterator<[string, Forward]> {
    return this.forwards.entries();
  }

  closeAll(): void {
    this.generation++;
    for (const id of [...this.forwards.keys()]) this.close(id);
  }

  stop(): void {
    this.stopped = true;
    this.closeAll();
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
