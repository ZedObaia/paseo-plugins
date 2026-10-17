import { connect } from "node:net";
import { listenerId } from "./identity";
import type { Listener } from "./processes";
import { upstreamOf } from "./proxy";

/**
 * Whether a port gets links. Web servers do: dev servers, APIs, and containers' web consoles.
 * Databases, caches, queues and other services don't: a browser can't use them, and a public
 * link to one would only expose it.
 */
export type PortKind = "web" | "other";

// Recognized by name, so they're never sent a stranger's request (Postgres and Redis log one).
const NOT_WEB_PROGRAMS =
  /^(postgres|postmaster|mysqld|mariadbd|redis-server|redis|valkey-server|valkey|mongod|mongos|mongo|memcached|sshd|beam\.smp|epmd|rabbitmq|clickhouse-server|etcd|nats-server|cockroach|mysql|mariadb|postgresql|keydb|dragonfly)$/;
// Containers' own ports for the same kinds of service.
const NOT_WEB_CONTAINER_PORTS = new Set([
  22, 1433, 1521, 2181, 3306, 4222, 5432, 5672, 6379, 9042, 9092, 11211, 26257, 27017,
]);

const program = (command: string | undefined) => {
  const first = (command ?? "").split(" ")[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
};

/** What a port is, when its program or container port says so without asking it. */
export function knownKind(listener: Listener): PortKind | null {
  if (listener.source === "docker")
    return (listener.containerPort !== undefined && NOT_WEB_CONTAINER_PORTS.has(listener.containerPort)) ||
      NOT_WEB_PROGRAMS.test(listener.name)
      ? "other"
      : null;
  return NOT_WEB_PROGRAMS.test(listener.name) || NOT_WEB_PROGRAMS.test(program(listener.identity))
    ? "other"
    : null;
}

/**
 * What a port's answer to an HTTP request says about it. Any HTTP answer makes a process a web
 * server. A container also needs to serve a page (HTML, or a redirect to one): the ones that
 * answer HTTP with something else, like MinIO's storage API, are services for other programs.
 */
export function kindOfReply(reply: string, needsPage: boolean): PortKind {
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(reply);
  if (!status) return "other";
  if (!needsPage) return "web";
  const code = Number(status[1]);
  if (code >= 300 && code < 400) return "web";
  return /^content-type:\s*text\/html/im.test(reply) ? "web" : "other";
}

/**
 * Asks a port once whether it speaks HTTP. A process gets `HEAD /` without a Host header, which
 * Node's HTTP servers turn down before any app code runs, so a dev server doesn't build a page to
 * answer it. A container gets `GET /` asking for HTML, to tell a web console from an API. A server
 * that speaks first (MySQL, SSH, SMTP) isn't a web server. "unknown": it didn't answer in time.
 */
export function probe(listener: Listener, timeoutMs = 1_500): Promise<PortKind | "unknown"> {
  const needsPage = listener.source === "docker";
  const { connectTo, port } = upstreamOf(listener.address, listener.port);
  const request = needsPage
    ? `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nAccept: text/html\r\nUser-Agent: Paseo-Ports\r\nConnection: close\r\n\r\n`
    : "HEAD / HTTP/1.1\r\nUser-Agent: Paseo-Ports\r\nConnection: close\r\n\r\n";
  return new Promise((resolve) => {
    const socket = connect(port, connectTo);
    let reply = "";
    let asked = false;
    let ask: ReturnType<typeof setTimeout> | undefined;
    const done = (kind: PortKind | "unknown") => {
      clearTimeout(ask);
      clearTimeout(timer);
      socket.destroy();
      resolve(kind);
    };
    const timer = setTimeout(() => done(reply ? kindOfReply(reply, needsPage) : "unknown"), timeoutMs);
    socket.once("connect", () => {
      ask = setTimeout(() => {
        asked = true;
        socket.write(request);
      }, 100);
    });
    socket.on("data", (chunk) => {
      if (!asked) return done("other");
      reply += chunk.toString("latin1");
      if (reply.includes("\r\n\r\n") || reply.length > 8_192) done(kindOfReply(reply, needsPage));
    });
    socket.once("end", () => done(reply ? kindOfReply(reply, needsPage) : "other"));
    socket.once("error", () => done(reply ? kindOfReply(reply, needsPage) : "unknown"));
  });
}

// a server that didn't answer is asked again after this long; until then a process counts as a
// web server (one that's still starting) and a container doesn't
const RETRY_MS = 15_000;

/** Each server's kind, asked once and kept while it runs; a restart keeps its identity. */
export class PortKinds {
  private kinds = new Map<string, { kind: PortKind; until: number }>();

  constructor(private readonly ask = probe) {}

  get(listener: Listener): PortKind | undefined {
    return knownKind(listener) ?? this.kinds.get(listenerId(listener))?.kind;
  }

  /** Works out the kinds of these listeners, asking only those not known yet. */
  async update(listeners: readonly Listener[]): Promise<void> {
    const now = Date.now();
    const seen = new Set<string>();
    await Promise.all(
      listeners.map(async (listener) => {
        const id = listenerId(listener);
        seen.add(id);
        if (knownKind(listener)) return;
        const known = this.kinds.get(id);
        if (known && known.until > now) return;
        const kind = await this.ask(listener);
        this.kinds.set(
          id,
          kind === "unknown"
            ? { kind: listener.source === "docker" ? "other" : "web", until: now + RETRY_MS }
            : { kind, until: Number.POSITIVE_INFINITY },
        );
      }),
    );
    for (const id of this.kinds.keys()) if (!seen.has(id)) this.kinds.delete(id);
  }
}
