import { spawn, type ChildProcess } from "node:child_process";
import type { SharingOption } from "../shared/contracts";
import { findExecutable, isExecutable } from "./executables";

export const cloudflared = () => findExecutable("cloudflared");

export function cloudflareOption(platform: NodeJS.Platform, binary = cloudflared()): SharingOption {
  if (isExecutable(binary)) return { available: true, reason: null };
  return {
    available: false,
    reason:
      platform === "darwin"
        ? "cloudflared isn't installed. Install it with `brew install cloudflared`."
        : "cloudflared isn't in PATH. Install it from Cloudflare's package repository or its releases: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
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
    const child = spawn(cloudflared(), ["tunnel", "--no-autoupdate", "--url", target], {
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
