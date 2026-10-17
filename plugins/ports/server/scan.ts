import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { realpathSync } from "node:fs";
import type { Port, PortTarget, scanRpc } from "../shared/contracts";
import { isLoopback, isWildcard, urlHost } from "./address";
import { dockerListeners } from "./docker";
import type { Forwards } from "./links";
import { assign } from "./match";
import { processListeners, type Listener } from "./processes";
import type { Shares } from "./shares";
import { listenerId } from "./identity";
import { allowable, linkable, type Detection, type Detections } from "./kind";

type Paseo = PluginHandlerContext["paseo"];
type Workspace = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];

export interface Scan {
  output: RpcOutput<typeof scanRpc>;
  host: string;
  /** Ports some workspace holds: the only ones the plugin forwards or shares. */
  attributed: Map<string, Listener[]>;
}

export function workspaceListener(attributed: Scan["attributed"], target: PortTarget): Listener {
  const listener = attributed.get(target.workspaceId)?.find((l) => listenerId(l) === target.id);
  if (!listener)
    throw new Error("That server is no longer in this workspace. Refresh the ports and try again.");
  return listener;
}

async function listWorkspaces(paseo: Paseo): Promise<Workspace[]> {
  const all: Workspace[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list(cursor ? { page: { limit: 200, cursor } } : undefined);
    all.push(...page.entries);
    cursor = (page.pageInfo.hasMore && page.pageInfo.nextCursor) || undefined;
  } while (cursor);
  return all;
}

const resolved = (dir: string) => {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
};

/** A worktree's directory; the others work in their project's root. */
const directoryOf = (w: Workspace) =>
  w.workspaceDirectory ?? (w.workspaceKind === "worktree" ? null : w.projectRootPath);

export interface Shared {
  /** Where its forward listens, if it has one. */
  forwardedAt: number | null;
  /** Its HTTPS address on the tailnet, when shared privately with `tailscale serve`. */
  privateUrl: string | null;
  privateError?: string;
  public: Port["public"];
}

/**
 * How the app opens a port. One shared privately over HTTPS opens at its tailnet name, and where
 * Tailscale has HTTPS every port gets that link when it's first opened. Otherwise one bound
 * everywhere opens at the link host, and one bound to a single interface at that interface's
 * address. One bound to loopback only opens at localhost when the app runs on this machine, and
 * otherwise through a forward at the link host.
 */
export function toPort(
  listener: Listener,
  host: string,
  shared: Shared,
  service: string | null,
  tailnetHttps = false,
  kind: { detection: Detection; links: boolean; allowable: boolean; allowed: boolean } = {
    detection: { protocol: "http", page: true },
    links: true,
    allowable: false,
    allowed: false,
  },
): Port {
  const local = isLoopback(host);
  const loopback = isLoopback(listener.address);
  const at =
    isWildcard(listener.address) || (loopback && !local) ? host : loopback ? "localhost" : listener.address;
  const forwarded = shared.forwardedAt !== null;
  return {
    id: listenerId(listener),
    port: listener.port,
    address: listener.address,
    name: listener.name,
    detail: listener.detail,
    pid: listener.pid,
    source: listener.source,
    service,
    url: shared.privateUrl ?? `http://${urlHost(at)}:${shared.forwardedAt ?? listener.port}`,
    protocol: kind.detection.protocol,
    links: kind.links,
    allowable: kind.allowable,
    allowed: kind.allowed,
    reach: !loopback || local ? `${urlHost(at)}:${listener.port}` : null,
    needsLink: kind.links && !shared.privateUrl && (tailnetHttps || (loopback && !local && !forwarded)),
    private: shared.privateUrl
      ? { https: true, ...(shared.privateError ? { error: shared.privateError } : {}) }
      : forwarded
        ? { https: false }
        : null,
    public: shared.public,
  };
}

export async function scan(
  paseo: Paseo,
  host: string,
  forwards: Forwards,
  shares: Shares,
  detections: Detections,
  allowed: ReadonlySet<string>,
): Promise<Scan> {
  let error: string | null = null;
  const [workspaces, processes, containers, sharing] = await Promise.all([
    listWorkspaces(paseo),
    processListeners().catch((e: unknown) => {
      error = e instanceof Error ? e.message : String(e);
      return [];
    }),
    dockerListeners(),
    shares.sharing(),
  ]);
  // containers first: a published port also shows up as a docker-proxy process
  const listeners = [...containers, ...processes];
  const live = workspaces.filter((w) => !w.archivingAt);
  const dirs = live.flatMap((w) => {
    const dir = directoryOf(w);
    return dir ? [{ id: w.id, dirs: [...new Set([dir, resolved(dir)])] }] : [];
  });
  const assigned = assign(listeners, dirs);
  const services = new Map(live.map((w) => [w.id, w.scripts.filter((s) => s.type === "service")]));
  const attributed = [...assigned.values()].flat();
  await detections.update(attributed);
  const kindOf = (l: Listener) => {
    const detection = detections.get(l) ?? { protocol: "unknown" as const, page: false };
    const id = listenerId(l);
    return {
      detection,
      links: linkable(l, detection, allowed.has(id)),
      allowable: allowable(l, detection),
      allowed: allowed.has(id),
    };
  };
  // a port that no longer gets links, because its answer changed or you took back your allowance,
  // loses the ones it has; shares blocks their traffic at once
  for (const l of attributed) {
    const id = listenerId(l);
    if (kindOf(l).links || !(forwards.get(id) || shares.has(id))) continue;
    console.log(`port ${l.port} no longer gets links; ending them`);
    void shares.endLinks(id);
  }
  const output: Scan["output"] = { workspaces: {}, linkHost: host, sharing, error };
  for (const [id, ports] of assigned) {
    output.workspaces[id] = ports.map((l) =>
      toPort(
        l,
        host,
        { forwardedAt: forwards.get(listenerId(l))?.port ?? null, ...shares.describe(listenerId(l)) },
        services.get(id)?.find((s) => s.port === l.port)?.scriptName ?? null,
        sharing.https.available,
        kindOf(l),
      ),
    );
  }
  return { output, host, attributed: assigned };
}
