import type { Device } from "./contracts";

const iosVersion = (d: Device) => Number(/iOS (\d+(?:\.\d+)?)/.exec(d.detail)?.[1] ?? 0);

/**
 * The devices worth showing first: anything on, held by a workspace or created here, every
 * Android device, and iPhones on the newest installed iOS. Everything else is `rest`.
 */
export function splitDevices(devices: Device[], heldIds: ReadonlySet<string>) {
  const newest = Math.max(0, ...devices.filter((d) => d.platform === "ios").map(iosVersion));
  const main: Device[] = [];
  const rest: Device[] = [];
  for (const d of devices) {
    const featured =
      d.state !== "shutdown" ||
      heldIds.has(d.id) ||
      d.owned ||
      d.platform === "android" ||
      (iosVersion(d) === newest && d.name.startsWith("iPhone"));
    (featured ? main : rest).push(d);
  }
  return { main, rest };
}
