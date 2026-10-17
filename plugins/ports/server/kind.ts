import { connect } from "node:net";
import { listenerId } from "./identity";
import type { Listener } from "./processes";
import { upstreamOf } from "./proxy";

/**
 * What a port speaks, from its answer to one request. `unknown`: it hasn't answered yet, so it
 * gets no links until it does.
 */
export type Protocol = "http" | "https" | "other" | "unknown";

export interface Detection {
  protocol: Protocol;
  /** Its HTTP answer was a web page: HTML, or a redirect. */
  page: boolean;
}

const unknown: Detection = { protocol: "unknown", page: false };

// Programs that only speak their own protocol on every port they open, and the default ports of
// such services. These are never sent a request (Postgres and Redis log a stranger's), so they
// stay out of links without a probe. Programs that also serve HTTP on some port, like RabbitMQ's
// management UI, aren't listed: each of their ports is asked.
const NOT_HTTP_PROGRAMS =
  /^(postgres|postmaster|mysqld|mariadbd|redis-server|valkey-server|keydb-server|mongod|mongos|memcached|sshd|epmd)$/;
const NOT_HTTP_PORTS = new Set([
  22, 1433, 1521, 2181, 3306, 4222, 5432, 5672, 6379, 9042, 9092, 11211, 27017,
]);

const program = (command: string | undefined) => {
  const first = (command ?? "").split(" ")[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
};

/** What an endpoint is without asking it: a database or cache program, or its default port. */
export function knownProtocol(listener: Listener): Protocol | null {
  const port = listener.source === "docker" ? listener.containerPort : listener.port;
  if (port !== undefined && NOT_HTTP_PORTS.has(port)) return "other";
  if (
    listener.source === "process" &&
    (NOT_HTTP_PROGRAMS.test(listener.name) || NOT_HTTP_PROGRAMS.test(program(listener.identity)))
  )
    return "other";
  return null;
}

/** What an answer says: an HTTP status line is HTTP, a TLS record is HTTPS, anything else isn't either. */
export function detectReply(reply: Buffer): Detection {
  // a TLS server answers plain text with an alert (0x15) or a handshake (0x16) record
  if (reply.length >= 2 && (reply[0] === 0x15 || reply[0] === 0x16) && reply[1] === 0x03)
    return { protocol: "https", page: false };
  const text = reply.toString("latin1");
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(text);
  if (!status) return { protocol: "other", page: false };
  const code = Number(status[1]);
  return {
    protocol: "http",
    page: (code >= 300 && code < 400) || /^content-type:\s*text\/html/im.test(text),
  };
}

/**
 * Asks a port once what it speaks. A process gets `HEAD /` without a Host header: Node's HTTP
 * servers refuse that before any app code runs, so a dev server doesn't build a page to answer,
 * while servers that accept it answer as for any request. A container gets `GET /` asking for
 * HTML, to tell a web console from an API. A server that speaks first (MySQL, SSH, SMTP) isn't
 * HTTP. No answer in time, or a refused connection, is `unknown`.
 */
export function probe(listener: Listener, timeoutMs = 1_500): Promise<Detection> {
  const { connectTo, port } = upstreamOf(listener.address, listener.port);
  const request =
    listener.source === "docker"
      ? `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nAccept: text/html\r\nUser-Agent: Paseo-Ports\r\nConnection: close\r\n\r\n`
      : "HEAD / HTTP/1.1\r\nUser-Agent: Paseo-Ports\r\nConnection: close\r\n\r\n";
  return new Promise((resolve) => {
    const socket = connect(port, connectTo);
    const chunks: Buffer[] = [];
    let size = 0;
    let asked = false;
    let ask: ReturnType<typeof setTimeout> | undefined;
    const reply = () => Buffer.concat(chunks);
    const done = (detection: Detection) => {
      clearTimeout(ask);
      clearTimeout(timer);
      socket.destroy();
      resolve(detection);
    };
    const timer = setTimeout(() => done(size ? detectReply(reply()) : unknown), timeoutMs);
    socket.once("connect", () => {
      ask = setTimeout(() => {
        asked = true;
        socket.write(request);
      }, 100);
    });
    socket.on("data", (chunk: Buffer) => {
      if (!asked) return done({ protocol: "other", page: false });
      chunks.push(chunk);
      size += chunk.length;
      const text = reply().toString("latin1");
      if (text.includes("\r\n\r\n") || size > 8_192 || !text.startsWith("HTTP/".slice(0, Math.min(5, size))))
        done(detectReply(reply()));
    });
    socket.once("end", () => done(size ? detectReply(reply()) : { protocol: "other", page: false }));
    socket.once("error", () => done(size ? detectReply(reply()) : unknown));
  });
}

/**
 * Whether a port gets links: an HTTP server, if it's a process (a dev server or API), serves a
 * page (a container's web console), or you allowed it. A container's other HTTP endpoints, like
 * MinIO's storage API, are services for programs, so they wait for you to allow them.
 */
export function linkable(listener: Listener, detection: Detection | undefined, allowed: boolean): boolean {
  if (detection?.protocol !== "http") return false;
  return listener.source === "process" || detection.page || allowed;
}

/** An HTTP server that doesn't get links unless you allow it. */
export const allowable = (listener: Listener, detection: Detection | undefined) =>
  detection?.protocol === "http" && listener.source === "docker" && !detection.page;

// how long an answer holds before the port is asked again
const SETTLED_MS = 10 * 60_000;
// a container whose HTTP answer wasn't a page may still be starting: ask again sooner, backing off
const NOT_A_PAGE_MS = [30_000, 60_000, 120_000, 300_000];
// no answer yet: backing off, up to two minutes
const UNANSWERED_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 120_000];

interface Entry {
  /** The running process or container the detection is for. */
  instance: string;
  detection: Detection;
  /** The detection is from an earlier instance, kept until this one answers. */
  carried: boolean;
  attempts: number;
  next: number;
}

const instanceOf = (listener: Listener) => `${listener.source}:${listener.instance ?? listener.pid ?? ""}`;

/**
 * Each server's detection, kept for the process or container instance it came from and asked
 * again when it expires. A restart (a new pid or container) is asked again at once; until it
 * answers, the last answer stands, so a dev server that restarts keeps its links. A port that
 * stops answering keeps its last real answer too.
 */
export class Detections {
  private entries = new Map<string, Entry>();
  /** Servers you asked to check though their port is a database's or cache's, by identity. */
  checked: ReadonlySet<string> = new Set();

  constructor(
    private readonly ask: (listener: Listener) => Promise<Detection> = probe,
    private readonly now = () => Date.now(),
  ) {}

  /** Not asked: a database's or cache's port, unless you asked to check it. */
  skips(listener: Listener): boolean {
    return this.known(listener) !== null;
  }

  private known(listener: Listener): Protocol | null {
    return this.checked.has(listenerId(listener)) ? null : knownProtocol(listener);
  }

  get(listener: Listener): Detection | undefined {
    const known = this.known(listener);
    if (known) return { protocol: known, page: false };
    return this.entries.get(listenerId(listener))?.detection;
  }

  /**
   * Asks the listeners that are due. `all`: these are every listener there is, so the ones not
   * among them are forgotten.
   */
  async update(listeners: readonly Listener[], all = true): Promise<void> {
    const seen = new Set<string>();
    await Promise.all(
      listeners.map(async (listener) => {
        const id = listenerId(listener);
        seen.add(id);
        if (this.known(listener)) return;
        const instance = instanceOf(listener);
        const entry = this.entries.get(id);
        if (entry && entry.instance === instance && entry.next > this.now()) return;
        const answer = await this.ask(listener);
        this.entries.set(id, this.settle(listener, entry, instance, answer));
      }),
    );
    if (all) for (const id of this.entries.keys()) if (!seen.has(id)) this.entries.delete(id);
  }

  private settle(listener: Listener, entry: Entry | undefined, instance: string, answer: Detection): Entry {
    const same = entry?.instance === instance;
    const attempts = same ? entry.attempts + 1 : 0;
    const at = (waits: number[]) => this.now() + waits[Math.min(attempts, waits.length - 1)];
    if (answer.protocol !== "unknown") {
      // only a container needs a page, so only its answer is worth asking again soon
      const notAPage = listener.source === "docker" && answer.protocol === "http" && !answer.page;
      return {
        instance,
        detection: answer,
        carried: false,
        attempts,
        next: notAPage ? at(NOT_A_PAGE_MS) : this.now() + SETTLED_MS,
      };
    }
    // no answer: the last real one stands, from this instance for as long as it runs, or from
    // the instance before a restart for a few tries
    const last = entry && entry.detection.protocol !== "unknown" ? entry.detection : null;
    const carried = !same || entry.carried;
    const keep = last !== null && !(carried && attempts >= 3);
    return {
      instance,
      detection: keep ? last : unknown,
      carried: keep && carried,
      attempts,
      next: at(UNANSWERED_MS),
    };
  }
}
