import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { isLoopback, isWildcard, urlHost } from "./address";

/** Where to connect for a server bound to `address`, and the Host header it accepts. */
export function upstreamOf(address: string, port: number) {
  const connectTo = address === "0.0.0.0" ? "127.0.0.1" : address === "::" ? "::1" : address;
  // dev servers that check Host (Vite's allowedHosts, for one) always accept localhost
  const host =
    isLoopback(address) || isWildcard(address) ? `localhost:${port}` : `${urlHost(address)}:${port}`;
  return { connectTo, port, host };
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The request headers to send upstream, as raw name/value pairs. Host becomes one the server
 * accepts, and Origin follows it when the page made the request to itself, so same-origin checks
 * still pass. The address the browser used goes in X-Forwarded-Host. The share's own password is
 * dropped: it isn't the app's. An upgrade keeps its Connection and Upgrade headers.
 */
export function upstreamHeaders(
  raw: readonly string[],
  upstreamHost: string,
  { upgrade, stripAuthorization }: { upgrade: boolean; stripAuthorization: boolean },
): string[] {
  const out: string[] = [];
  let publicHost: string | null = null;
  let proto: string | null = null;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (name === "host") publicHost = raw[i + 1];
    if (name === "x-forwarded-proto") proto = raw[i + 1];
  }
  const scheme = proto ?? "https";
  for (let i = 0; i < raw.length; i += 2) {
    const [name, value] = [raw[i], raw[i + 1]];
    const key = name.toLowerCase();
    if (key === "host") continue;
    if (key === "authorization" && stripAuthorization) continue;
    if (HOP_BY_HOP.has(key) && !(upgrade && (key === "connection" || key === "upgrade"))) continue;
    if (key === "origin" && publicHost && value === `${scheme}://${publicHost}`) {
      out.push(name, `http://${upstreamHost}`);
      continue;
    }
    out.push(name, value);
  }
  out.push("Host", upstreamHost);
  if (publicHost && !raw.some((_, i) => i % 2 === 0 && raw[i].toLowerCase() === "x-forwarded-host"))
    out.push("X-Forwarded-Host", publicHost);
  if (!proto) out.push("X-Forwarded-Proto", scheme);
  return out;
}

/** A redirect to the server's own address goes to the address the browser used instead. */
export function rewriteLocation(location: string, upstreamHost: string, publicOrigin: string): string {
  for (const origin of [`http://${upstreamHost}`, `https://${upstreamHost}`])
    if (location === origin || location.startsWith(`${origin}/`))
      return publicOrigin + location.slice(origin.length);
  return location;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/** Basic auth with any user name and this password. */
export function authorized(header: string | undefined, password: string): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  return decoded.includes(":") && timingSafeEqual(digest(given), digest(password));
}

// no 0/o, 1/l/i: easy to read out and type on a phone
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** Twelve random characters in three groups, about 59 bits. */
export function newPassword(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export interface Proxy {
  /** http://127.0.0.1:<port>, what Tailscale or cloudflared sends traffic to. */
  url: string;
  close(): void;
}

/**
 * An HTTP proxy on loopback in front of a shared server: it rewrites Host so dev servers that
 * reject unknown hosts answer, passes WebSocket upgrades through (hot reload keeps working), and
 * asks for the password when the share has one.
 */
export function startProxy(
  target: { address: string; port: number },
  password: string | null,
): Promise<Proxy> {
  const upstream = upstreamOf(target.address, target.port);
  const sockets = new Set<Socket>();
  const realm = `Port ${target.port}`;
  const allowed = (req: IncomingMessage) =>
    password === null || authorized(req.headers.authorization, password);

  const server = createServer((req, res) => {
    if (!allowed(req)) {
      res.writeHead(401, {
        "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`,
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("This link needs a password.\n");
      return;
    }
    const publicOrigin = `${req.headers["x-forwarded-proto"] ?? "https"}://${req.headers.host ?? upstream.host}`;
    const outgoing = request(
      {
        host: upstream.connectTo,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req.rawHeaders, upstream.host, {
          upgrade: false,
          stripAuthorization: password !== null,
        }),
      },
      (incoming) => {
        const headers: string[] = [];
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          const [name, value] = [incoming.rawHeaders[i], incoming.rawHeaders[i + 1]];
          if (HOP_BY_HOP.has(name.toLowerCase())) continue;
          headers.push(
            name,
            name.toLowerCase() === "location" ? rewriteLocation(value, upstream.host, publicOrigin) : value,
          );
        }
        res.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, headers);
        incoming.pipe(res);
      },
    );
    outgoing.on("error", () => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Nothing answered on port ${target.port}.\n`);
    });
    req.pipe(outgoing);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (!allowed(req)) {
      socket.end(
        `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${realm}"\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    const outgoing = connect(upstream.port, upstream.connectTo);
    sockets.add(outgoing);
    outgoing.on("close", () => sockets.delete(outgoing));
    const headers = upstreamHeaders(req.rawHeaders, upstream.host, {
      upgrade: true,
      stripAuthorization: password !== null,
    });
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < headers.length; i += 2) lines.push(`${headers[i]}: ${headers[i + 1]}`);
    outgoing.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) outgoing.write(head);
    socket.pipe(outgoing).pipe(socket);
    for (const s of [socket, outgoing])
      s.on("error", () => {
        socket.destroy();
        outgoing.destroy();
      });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close() {
          server.close();
          for (const socket of sockets) socket.destroy();
        },
      });
    });
  });
}
