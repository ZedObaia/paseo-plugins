import { spawn, type ChildProcess } from "node:child_process";
import type { SharingOption } from "../shared/contracts";
import { assetFor, cloudflaredPath, CLOUDFLARED_VERSION } from "./cloudflared";

/**
 * Cloudflare quick tunnels work when cloudflared is on the host, or once the plugin has downloaded
 * it; otherwise the form offers the download (see cloudflared.ts) where the plugin has one.
 */
export function cloudflareOption(
  platform: NodeJS.Platform,
  arch: string,
  found: string | null = cloudflaredPath(),
): SharingOption {
  if (found) return { available: true, reason: null, download: null };
  const asset = assetFor(platform, arch);
  if (asset)
    return {
      available: false,
      reason: null,
      download: { version: CLOUDFLARED_VERSION, sizeBytes: asset.size },
    };
  return {
    available: false,
    reason:
      "cloudflared isn't installed, and the plugin has no download of it for this system. Install it from Cloudflare: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
    download: null,
  };
}

/** The quick tunnel's address in cloudflared's log, once it prints it. */
export function parseTunnelUrl(text: string): string | null {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0] ?? null;
}

// cloudflared logs this once Cloudflare's edge accepts the tunnel, a moment after the address
const REGISTERED = /Registered tunnel connection/;

/**
 * A Cloudflare quick tunnel to `target`: a random https://….trycloudflare.com address that needs
 * no account and lasts as long as the process. Resolves once the tunnel is registered.
 */
export function startQuickTunnel(
  target: string,
  onSpawn: (pid: number) => void,
  timeoutMs = 45_000,
): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const binary = cloudflaredPath();
    if (!binary) return reject(new Error("cloudflared isn't installed"));
    const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", target], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid) onSpawn(child.pid);
    let log = "";
    let url: string | null = null;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`cloudflared didn't open a tunnel in ${timeoutMs / 1000} s`)),
      timeoutMs,
    );
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => {
      const last = log.trim().split("\n").slice(-2).join(" ");
      fail(new Error(`cloudflared exited (${code ?? "signal"})${last ? `: ${last}` : ""}`));
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      // it keeps logging for as long as it runs: keep only what's needed to start
      if (settled) return;
      log = (log + chunk).slice(-8_000);
      url ??= parseTunnelUrl(log);
      if (url && REGISTERED.test(log)) {
        settled = true;
        clearTimeout(timer);
        resolve({ url, child });
      }
    });
  });
}
