import { createServer } from "node:net";
import { userInfo } from "node:os";
import type { SharingOption } from "../shared/contracts";
import { run } from "./exec";
import { findExecutable } from "./executables";

// The CLI is in PATH on Linux and with Homebrew; the macOS app ships it inside the bundle.
const tailscale = () => findExecutable("tailscale", ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);

const FUNNEL_CAP = "funnel";
const FUNNEL_CAP_URL = "https://tailscale.com/cap/funnel";
const FUNNEL_PORTS_CAP = "https://tailscale.com/cap/funnel-ports";
// what Funnel allows when the tailnet doesn't list its ports
const DEFAULT_FUNNEL_PORTS = [443, 8443, 10000];

export interface TailscaleStatus {
  /** "Running" once logged in and connected. */
  backendState: string;
  /** The machine's MagicDNS name, without the trailing dot. */
  dnsName: string | null;
  addresses: string[];
  /** HTTPS certificates are on for this machine's name. */
  https: boolean;
  funnel: boolean;
  funnelPorts: number[];
}

/** The parts of `tailscale status --json` that decide what can be shared. */
export function parseStatus(json: unknown): TailscaleStatus {
  const status = (json ?? {}) as {
    BackendState?: string;
    CertDomains?: string[] | null;
    Self?: { DNSName?: string; TailscaleIPs?: string[]; CapMap?: Record<string, unknown> | null };
  };
  const self = status.Self ?? {};
  const dnsName = self.DNSName ? self.DNSName.replace(/\.$/, "") : null;
  const caps = Object.keys(self.CapMap ?? {});
  const portsCap = caps.find((cap) => cap.startsWith(`${FUNNEL_PORTS_CAP}?`));
  const listed = portsCap
    ? (new URLSearchParams(portsCap.slice(portsCap.indexOf("?") + 1)).get("ports") ?? "")
        .split(",")
        .map(Number)
        .filter((p) => Number.isInteger(p) && p > 0)
    : [];
  return {
    backendState: status.BackendState ?? "Unknown",
    dnsName,
    addresses: self.TailscaleIPs ?? [],
    https: !!dnsName && (status.CertDomains ?? []).includes(dnsName),
    funnel: caps.includes(FUNNEL_CAP) || caps.includes(FUNNEL_CAP_URL),
    funnelPorts: listed.length ? listed : DEFAULT_FUNNEL_PORTS,
  };
}

/**
 * Whether this user can change serve settings: root, the operator `tailscale set --operator`
 * named, or anyone on macOS, where the app answers the signed-in user's CLI.
 */
export function canOperate(
  prefs: unknown,
  user: { username: string; uid: number },
  platform: NodeJS.Platform,
): boolean {
  if (user.uid === 0 || platform === "darwin") return true;
  return (prefs as { OperatorUser?: string } | null)?.OperatorUser === user.username;
}

/** One HTTPS port in the serve config, as `tailscale serve status --json` shows it. */
export interface ServedPort {
  https: boolean;
  /** Set when the port relays raw TCP instead of serving web handlers. */
  tcpForward: string | null;
  /** Path to proxy target, file path or text: whatever each web handler serves. */
  handlers: Record<string, string>;
  funnel: boolean;
}

export function parseServeConfig(json: unknown): Map<number, ServedPort> {
  const config = (json ?? {}) as {
    TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
    AllowFunnel?: Record<string, boolean>;
  };
  const ports = new Map<number, ServedPort>();
  const at = (port: number) => {
    let entry = ports.get(port);
    if (!entry) ports.set(port, (entry = { https: false, tcpForward: null, handlers: {}, funnel: false }));
    return entry;
  };
  const portOf = (hostPort: string) => Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
  for (const [key, tcp] of Object.entries(config.TCP ?? {})) {
    const entry = at(Number(key));
    entry.https = !!tcp.HTTPS;
    entry.tcpForward = tcp.TCPForward ?? null;
  }
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const entry = at(portOf(hostPort));
    for (const [path, handler] of Object.entries(web.Handlers ?? {}))
      entry.handlers[path] = handler.Proxy ?? handler.Path ?? handler.Text ?? "";
  }
  for (const [hostPort, on] of Object.entries(config.AllowFunnel ?? {}))
    if (on) at(portOf(hostPort)).funnel = true;
  return ports;
}

/** The port serves exactly what the plugin set up there: one handler, proxying to `target`. */
export function servesOnly(config: Map<number, ServedPort>, port: number, target: string): boolean {
  const entry = config.get(port);
  if (!entry || entry.tcpForward) return false;
  const handlers = Object.entries(entry.handlers);
  return handlers.length === 1 && handlers[0][0] === "/" && handlers[0][1] === target;
}

/**
 * A Funnel port nothing serves yet. Turning Funnel on for a port that already serves something
 * would make that public too, so a port in the serve config never qualifies, and neither does
 * one another process holds on the machine's tailnet addresses.
 */
export function chooseFunnelPort(
  allowed: readonly number[],
  config: Map<number, ServedPort>,
  free: (port: number) => boolean,
): number | null {
  return allowed.find((port) => !config.has(port) && free(port)) ?? null;
}

export interface TailscaleState {
  status: TailscaleStatus | null;
  config: Map<number, ServedPort>;
  operator: boolean;
  /** Why Tailscale can't be used at all, when it can't. */
  problem: string | null;
}

const unavailable = (reason: string): SharingOption => ({ available: false, reason });
const available: SharingOption = { available: true, reason: null };

/** What a private HTTPS share and a Funnel share need, and what's missing for each. */
export function tailscaleOptions(
  state: TailscaleState,
  user: string,
): { https: SharingOption; funnel: SharingOption } {
  const { status } = state;
  if (state.problem || !status) {
    const off = unavailable(state.problem ?? "Tailscale isn't answering.");
    return { https: off, funnel: off };
  }
  if (!status.https) {
    const off = unavailable(
      "HTTPS certificates are off for this tailnet. Turn on HTTPS in the Tailscale admin console, under DNS.",
    );
    return { https: off, funnel: off };
  }
  if (!state.operator) {
    const off = unavailable(
      `The daemon's user (${user}) can't change Tailscale's serve settings. Run \`sudo tailscale set --operator=${user}\` once.`,
    );
    return { https: off, funnel: off };
  }
  if (!status.funnel)
    return {
      https: available,
      funnel: unavailable(
        "The tailnet's policy doesn't allow Funnel on this machine. Add the funnel attribute for it in the admin console's access controls.",
      ),
    };
  const free = status.funnelPorts.filter((port) => !state.config.has(port));
  return {
    https: available,
    funnel: free.length
      ? available
      : unavailable(`Funnel's ports (${status.funnelPorts.join(", ")}) all serve something already.`),
  };
}

const json = async (args: string[]) => JSON.parse((await run(tailscale(), args, 8_000)) || "{}");

/** Reads Tailscale's status, prefs and serve config; missing or stopped Tailscale is a problem, not an error. */
export async function readTailscale(): Promise<TailscaleState> {
  const empty = { status: null, config: new Map(), operator: false };
  let status: TailscaleStatus;
  try {
    status = parseStatus(await json(["status", "--json"]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...empty,
      problem: /ENOENT/.test(message)
        ? "Tailscale isn't installed on this host."
        : `Tailscale didn't answer: ${message}`,
    };
  }
  if (status.backendState !== "Running")
    return { ...empty, status, problem: `Tailscale isn't connected (it's ${status.backendState}).` };
  const [config, prefs] = await Promise.all([
    json(["serve", "status", "--json"]).then(parseServeConfig),
    json(["debug", "prefs"]).catch(() => null),
  ]);
  const user = userInfo();
  return { status, config, operator: canOperate(prefs, user, process.platform), problem: null };
}

/** Whether nothing holds `port` on any of these addresses. */
export async function isFree(addresses: readonly string[], port: number): Promise<boolean> {
  for (const address of addresses) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, address, () => probe.close(() => resolve(true)));
    });
    if (!ok) return false;
  }
  return true;
}

/** A port the OS says is free on the first address, checked on the others too. */
export async function freePort(addresses: readonly string[]): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, addresses[0], () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    if (port && (await isFree(addresses, port))) return port;
  }
  throw new Error("Couldn't find a free port on the tailnet addresses");
}

const tailscaleCommand = async (args: string[]) => {
  try {
    await run(tailscale(), args, 15_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/access denied|permission|operator/i.test(message))
      throw new Error(
        `Tailscale refused to change serve settings for ${userInfo().username}. Run \`sudo tailscale set --operator=${userInfo().username}\` once.`,
      );
    throw error;
  }
};

/** `https://<name>:<port>` on the tailnet, proxying to `target`. */
export const serve = (httpsPort: number, target: string) =>
  tailscaleCommand(["serve", "--bg", `--https=${httpsPort}`, target]);
export const funnel = (httpsPort: number, target: string) =>
  tailscaleCommand(["funnel", "--bg", "--yes", `--https=${httpsPort}`, target]);
/** Removes a port's serve config; `funnel` also turns Funnel off for it. */
export const unserve = (kind: "serve" | "funnel", httpsPort: number) =>
  tailscaleCommand([kind, `--https=${httpsPort}`, "off"]);

export const httpsUrl = (dnsName: string, port: number) =>
  port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;
