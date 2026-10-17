import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { linkRpc, scanRpc, sharePublicRpc, unshareRpc, type Port } from "../shared/contracts";

// The app shares one query cache between its plugins and hosts: keys start with the host.
export const queryKey = (hostId: string) => [hostId, "ports", "scan"];

export const POLL_MS = 3_000;

/** Every workspace's ports on the host. */
export function useScan(hostId: string) {
  const scan = useRpc(scanRpc);
  return useQuery({ queryKey: queryKey(hostId), queryFn: () => scan({}), refetchInterval: POLL_MS });
}

/** The link to a port, setting it up first when it needs that. */
export async function portUrl(
  port: Port,
  link: (input: { port: number }) => Promise<{ url: string }>,
): Promise<string> {
  return port.needsLink ? (await link({ port: port.port })).url : port.url;
}

export function usePortRpcs() {
  return { link: useRpc(linkRpc), sharePublic: useRpc(sharePublicRpc), unshare: useRpc(unshareRpc) };
}

/** The Paseo service script's name, else the process or container name. */
export const portName = (port: Port) => port.service ?? port.name;

export const hostOf = (url: string) => url.replace(/^https?:\/\//, "");

export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/ requestType=.*$/, "").replace(/^Request failed: /, "")
    : String(error);
