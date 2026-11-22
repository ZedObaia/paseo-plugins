// Which workspaces have a running simulator or emulator, from the Devices plugin through the
// bridge it puts on globalThis (one per host), since one plugin can't call another's RPCs.

import { useEffect, useState } from "react";

/** What Devices' client/bridge.ts registers; kept in step with it by hand. */
interface DevicesBridge {
  readonly version: 1;
  running(): ReadonlyMap<string, readonly string[]>;
  subscribe(listener: () => void): () => void;
}

function bridges(): DevicesBridge[] {
  const set = (globalThis as { __devicesBridges?: Set<DevicesBridge> }).__devicesBridges;
  return set ? [...set].filter((bridge) => bridge.version === 1) : [];
}

const NONE: ReadonlyMap<string, readonly string[]> = new Map();

/** Running devices' names by workspace id, across the hosts Devices is loaded for. */
export function useRunningDevices(): ReadonlyMap<string, readonly string[]> {
  const [running, setRunning] = useState(NONE);
  useEffect(() => {
    const listening = new Map<DevicesBridge, () => void>();
    let shown = "";
    const read = () => {
      const merged = new Map<string, readonly string[]>();
      for (const bridge of listening.keys())
        for (const [id, names] of bridge.running()) merged.set(id, names);
      const key = JSON.stringify([...merged]);
      if (key === shown) return;
      shown = key;
      setRunning(merged);
    };
    // ponytail: rescans for bridges; Devices may load after us or reload. A registry event would replace it.
    const scan = () => {
      const current = bridges();
      for (const bridge of current) if (!listening.has(bridge)) listening.set(bridge, bridge.subscribe(read));
      for (const [bridge, stop] of listening)
        if (!current.includes(bridge)) {
          stop();
          listening.delete(bridge);
        }
      read();
    };
    scan();
    const timer = setInterval(scan, 15_000);
    return () => {
      clearInterval(timer);
      for (const stop of listening.values()) stop();
    };
  }, []);
  return running;
}
