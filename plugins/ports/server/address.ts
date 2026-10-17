import { isIP } from "node:net";

/**
 * One spelling per address: no brackets or zone, IPv6 compressed, and IPv4-mapped IPv6
 * (::ffff:127.0.0.1) as plain IPv4. lsof's "*" and an empty host mean every interface.
 */
export function canonicalAddress(raw: string): string {
  const address = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (address === "*" || address === "") return "0.0.0.0";
  if (isIP(address) !== 6) return address;
  const groups = expand(address);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff)
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  // the longest run of two or more zero groups becomes "::"
  let best = { at: -1, length: 1 };
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.length) best = { at: i, length: j - i };
    i = j === i ? i + 1 : j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.at < 0) return hex.join(":");
  return `${hex.slice(0, best.at).join(":")}::${hex.slice(best.at + best.length).join(":")}`;
}

function expand(address: string): number[] {
  let text = address;
  const v4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

export const isWildcard = (address: string) => address === "0.0.0.0" || address === "::";
export const isLoopback = (address: string) =>
  address === "::1" || address === "localhost" || address.startsWith("127.");

/** Wider binds reach more: every interface, then one network interface, then loopback. */
export const reach = (address: string) => (isWildcard(address) ? 2 : isLoopback(address) ? 0 : 1);

/** The host part of a URL: IPv6 addresses go in brackets. */
export const urlHost = (host: string) => (isIP(host) === 6 ? `[${host}]` : host);
