import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { realpathSync } from "node:fs";
import type { Port, scanRpc } from "../shared/contracts";
import { isLoopback, isWildcard, urlHost } from "./address";
import { dockerListeners } from "./docker";
import type { Forwards } from "./links";
import { assign } from "./match";
import { processListeners, type Listener } from "./processes";
import type { Shares } from "./shares";

type Paseo = PluginHandlerContext["paseo"];
type Workspace = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];

export interface Scan {
  output: RpcOutput<typeof scanRpc>;
  host: string;
  /** Ports some workspace holds: the only ones the plugin forwards or shares. */
  attributed: Listener[];
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
  public: Port["public"];
}

/**
 * How the app opens a port. One shared privately over HTTPS opens at its tailnet name. Otherwise
 * one bound everywhere opens at the link host, and one bound to a single interface at that
 * interface's address. One bound to loopback only opens at localhost when the app runs on this
 * machine, and otherwise through a forward at the link host.
 */
export function toPort(listener: Listener, host: string, shared: Shared, service: string | null): Port {
  const local = isLoopback(host);
  const loopback = isLoopback(listener.address);
  const at =
    isWildcard(listener.address) || (loopback && !local) ? host : loopback ? "localhost" : listener.address;
  const forwarded = shared.forwardedAt !== null;
  return {
    port: listener.port,
    address: listener.address,
    name: listener.name,
    detail: listener.detail,
    pid: listener.pid,
    source: listener.source,
    service,
    url: shared.privateUrl ?? `http://${urlHost(at)}:${shared.forwardedAt ?? listener.port}`,
    needsForward: loopback && !local && !forwarded && !shared.privateUrl,
    private: shared.privateUrl ? { https: true } : forwarded ? { https: false } : null,
    public: shared.public,
  };
}

export async function scan(paseo: Paseo, host: string, forwards: Forwards, shares: Shares): Promise<Scan> {
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
  const output: Scan["output"] = { workspaces: {}, linkHost: host, sharing, error };
  for (const [id, ports] of assigned) {
    output.workspaces[id] = ports.map((l) =>
      toPort(
        l,
        host,
        { forwardedAt: forwards.get(l.port)?.port ?? null, ...shares.describe(l.port) },
        services.get(id)?.find((s) => s.port === l.port)?.scriptName ?? null,
      ),
    );
  }
  return { output, host, attributed: [...assigned.values()].flat() };
}
