import { listenerId, type ListenerAccess } from "./identity";
import { linkable, type Detections } from "./kind";
import type { Listener } from "./processes";

/**
 * Whether a linked server still gets links, asked by the watchdog while links exist. It checks
 * the listener on the port now: a restart there is a new process or container, asked again
 * rather than trusting the answer the old one gave. A server that's gone or replaced isn't this
 * check's to judge; the watchdog ends its links on its own.
 */
export function stillLinkable(
  access: ListenerAccess,
  detections: Detections,
  allowed: () => ReadonlySet<string>,
): (target: Listener) => Promise<boolean> {
  return async (target) => {
    const current = await access.current(target);
    if (!current) return true;
    await detections.update([current], false);
    return linkable(current, detections.get(current), allowed().has(listenerId(current)));
  };
}
