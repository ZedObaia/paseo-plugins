import type { Port } from "./contracts";

/**
 * A port's address on its own machine: localhost, unless it listens on one other address only.
 * Dev servers expect localhost: browsers treat it as secure, and OAuth callbacks and cookies are
 * set up for it.
 */
export function localAddress(port: Pick<Port, "address" | "port">): string {
  const a = port.address;
  const host =
    a === "0.0.0.0" || a === "::" || a === "::1" || a === "127.0.0.1"
      ? "localhost"
      : a.includes(":")
        ? `[${a}]`
        : a;
  return `${host}:${port.port}`;
}

/** The URL that opens a port on its own machine. */
export const localUrl = (port: Pick<Port, "address" | "port" | "protocol">) =>
  `${port.protocol === "https" ? "https" : "http"}://${localAddress(port)}`;
