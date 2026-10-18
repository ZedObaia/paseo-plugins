import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
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
 * still pass. The address the browser used goes in X-Forwarded-Host. The share's own password, and
 * the cookie a browser got for entering it, are dropped: they aren't the app's. An upgrade keeps
 * its Connection and Upgrade headers.
 */
export function upstreamHeaders(
  raw: readonly string[],
  upstreamHost: string,
  {
    upgrade,
    stripAuthorization,
    stripCookie,
  }: { upgrade: boolean; stripAuthorization: boolean; stripCookie?: string },
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
    if (key === "cookie" && stripCookie) {
      const kept = value
        .split(/;\s*/)
        .filter((pair) => pair && !pair.startsWith(`${stripCookie}=`))
        .join("; ");
      if (kept) out.push(name, kept);
      continue;
    }
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

const samePassword = (given: string, password: string) =>
  timingSafeEqual(digest(given.trim()), digest(password));

/** Whether the Cookie header holds this cookie with this value. */
export function hasCookie(header: string | undefined, name: string, value: string): boolean {
  const pair = (header ?? "").split(/;\s*/).find((p) => p.startsWith(`${name}=`));
  return !!pair && timingSafeEqual(digest(pair.slice(name.length + 1)), digest(value));
}

/** Where the password page posts to; never passed on to the app. */
export const LOGIN_PATH = "/__paseo_ports/login";

/** A path on this site to go back to after the password page, never another site. */
export const returnPath = (to: string | null | undefined) =>
  to && /^\/(?![/\\])[^\r\n]*$/.test(to) ? to : "/";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page a browser gets for a link with a password: a field that posts it, so it works where
 * the browser shows no Basic auth prompt, like Paseo's own browser.
 */
export function passwordPage(port: number, to: string, wrong: boolean): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Password needed · port ${port}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111413; color: #fafafa; font: 16px/1.5 system-ui, sans-serif; }
  form { width: min(320px, calc(100vw - 48px)); display: grid; gap: 12px; }
  h1 { margin: 0; font-size: 20px; }
  p { margin: 0; color: ${wrong ? "#d8847b" : "#a1a5a4"}; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 8px; }
  input { border: 1px solid #2f3534; background: #1e2120; color: inherit; }
  button { border: 0; background: #20744a; color: #fff; cursor: pointer; }
</style>
<form method="post" action="${LOGIN_PATH}">
  <h1>This link needs a password</h1>
  <p>${wrong ? "That password isn't right. Try again." : "Ask whoever shared it with you."}</p>
  <input type="password" name="password" aria-label="Password" autocomplete="current-password" autocapitalize="none" autofocus required>
  <input type="hidden" name="to" value="${escapeHtml(returnPath(to))}">
  <button>Open</button>
</form>
</html>
`;
}

/** A request body as text, up to `limit` bytes; anything longer is refused. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too long"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
  /** Refuses traffic while retaining the binding until external routes have been removed. */
  block(): void;
  close(): void;
}

/**
 * An HTTP proxy on loopback in front of a shared server: it rewrites Host so dev servers that
 * reject unknown hosts answer, passes WebSocket upgrades through (hot reload keeps working), and
 * asks for the password when the share has one: a browser opening a page gets a password page,
 * and the password gets it a cookie for the rest of the share; anything else, like a webhook or
 * curl, gets a Basic auth challenge.
 */
export function startProxy(
  target: { address: string; port: number },
  password: string | null,
  canConnect: () => Promise<boolean> = async () => true,
): Promise<Proxy> {
  const upstream = upstreamOf(target.address, target.port);
  const sockets = new Set<Socket>();
  const realm = `Port ${target.port}`;
  // one per share, so entering the password lasts as long as the share; named for the port, since
  // a machine's Funnel links share a host name and cookies don't keep ports apart
  const session = randomBytes(32).toString("base64url");
  const cookie = `__Host-paseo-port-${target.port}`;
  let closed = false;
  let blocked = false;
  const allowed = (req: IncomingMessage) =>
    password === null ||
    authorized(req.headers.authorization, password) ||
    hasCookie(req.headers.cookie, cookie, session);
  const page = (res: ServerResponse, to: string, wrong: boolean) => {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(passwordPage(target.port, to, wrong));
  };

  async function login(req: IncomingMessage, res: ServerResponse, password: string) {
    if (req.method !== "POST") return page(res, "/", false);
    const form = new URLSearchParams(await readBody(req, 8_192).catch(() => ""));
    const to = returnPath(form.get("to"));
    if (!samePassword(form.get("password") ?? "", password)) return page(res, to, true);
    res.writeHead(303, {
      Location: to,
      "Set-Cookie": `${cookie}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      "Cache-Control": "no-store",
    });
    res.end();
  }

  const server = createServer(async (req, res) => {
    if (blocked) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("This link has stopped.\n");
      return;
    }
    if (password !== null && new URL(req.url ?? "/", "http://x").pathname === LOGIN_PATH)
      return void (await login(req, res, password));
    if (!allowed(req)) {
      // a page a browser opens; Paseo's own browser shows no Basic auth prompt
      if ((req.method === "GET" || req.method === "HEAD") && /text\/html/.test(req.headers.accept ?? ""))
        return page(res, req.url ?? "/", false);
      res.writeHead(401, {
        "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`,
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("This link needs a password.\n");
      return;
    }
    if (!(await canConnect().catch(() => false)) || closed || blocked) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("The original server is no longer available.\n");
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
          stripCookie: password === null ? undefined : cookie,
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

  server.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    if (blocked) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (!allowed(req)) {
      socket.end(
        `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${realm}"\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    if (!(await canConnect().catch(() => false)) || closed || blocked || socket.destroyed) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const outgoing = connect(upstream.port, upstream.connectTo);
    sockets.add(outgoing);
    outgoing.on("close", () => sockets.delete(outgoing));
    const headers = upstreamHeaders(req.rawHeaders, upstream.host, {
      upgrade: true,
      stripAuthorization: password !== null,
      stripCookie: password === null ? undefined : cookie,
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
        block() {
          blocked = true;
          for (const socket of sockets) socket.destroy();
        },
        close() {
          blocked = true;
          closed = true;
          server.close();
          for (const socket of sockets) socket.destroy();
        },
      });
    });
  });
}
