import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { z } from "zod";
import { listRpc } from "../shared/contracts";

// Other plugins in the app (our status sidebar shows a phone on these workspaces) read which
// workspaces have a running device through this object, since one plugin can't call another's
// RPCs. One bridge per host the app loads Devices for; the sidebar keeps its own copy of this
// interface.

export interface DevicesBridge {
  readonly version: 1;
  /** Workspace ids with a booted device, each with its devices' names. */
  running(): ReadonlyMap<string, readonly string[]>;
  /** Called when that changes. The host is asked only while someone listens. */
  subscribe(listener: () => void): () => void;
}

type Registry = { __devicesBridges?: Set<DevicesBridge> };

const POLL_MS = 8_000;

/** The workspaces whose devices are booted, with those devices' names. */
export function runningByWorkspace(
  list: Pick<z.infer<typeof listRpc.output>, "devices" | "assignments">,
): Map<string, string[]> {
  const running = new Map<string, string[]>();
  for (const a of list.assignments) {
    const device = list.devices.find((d) => d.id === a.deviceId);
    if (device?.state === "booted")
      running.set(a.workspaceId, [...(running.get(a.workspaceId) ?? []), device.name]);
  }
  return running;
}

const same = (a: ReadonlyMap<string, readonly string[]>, b: ReadonlyMap<string, readonly string[]>) =>
  a.size === b.size && [...a].every(([id, names]) => b.get(id)?.join("\n") === names.join("\n"));

export function registerBridge(client: Pick<PluginClientContext, "rpc">): () => void {
  let running: ReadonlyMap<string, readonly string[]> = new Map();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll() {
    timer = undefined;
    try {
      const next = runningByWorkspace(await client.rpc(listRpc, {}));
      if (!same(next, running)) {
        running = next;
        for (const listener of listeners) listener();
      }
    } catch {
      // host offline or the plugin reloading: keep the last answer
    }
    if (listeners.size && timer === undefined) timer = setTimeout(poll, POLL_MS);
  }

  const bridge: DevicesBridge = {
    version: 1,
    running: () => running,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && timer === undefined) void poll();
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
  };
  const registry = globalThis as Registry;
  const bridges = (registry.__devicesBridges ??= new Set());
  bridges.add(bridge);
  return () => {
    bridges.delete(bridge);
    if (timer !== undefined) clearTimeout(timer);
    listeners.clear();
  };
}
