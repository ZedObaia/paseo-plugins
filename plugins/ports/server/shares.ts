import { execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { userInfo } from "node:os";
import type { Access, Port, Provider, Sharing } from "../shared/contracts";
import { cloudflareOption, startQuickTunnel } from "./cloudflare";
import type { Forwards } from "./links";
import type { Listener } from "./processes";
import { newPassword, startProxy, upstreamOf, type Proxy } from "./proxy";
import { leftoverPlan, Records, type ShareRecord } from "./records";
import {
  chooseFunnelPort,
  freePort,
  funnel,
  httpsUrl,
  isFree,
  readTailscale,
  serve,
  servesOnly,
  tailscaleOptions,
  unserve,
  type TailscaleState,
} from "./tailscale";

interface Target {
  address: string;
  port: number;
}

interface PrivateShare {
  target: Target;
  proxy: Proxy;
  httpsPort: number;
  url: string;
  record: ShareRecord;
}

interface PublicShare {
  target: Target;
  proxy: Proxy;
  provider: Provider;
  access: Access;
  password: string | null;
  url: string;
  record: ShareRecord;
  /** Funnel's port, or the tunnel process. */
  httpsPort: number | null;
  child: ChildProcess | null;
}

// A server that restarts (Vite does on a config change) is gone for a moment: only a port
// that stays closed this long ends its shares.
const GONE_AFTER_MS = 6_000;
const WATCH_MS = 3_000;
const STATE_MAX_AGE_MS = 15_000;

function commandOf(pid: number): string | null {
  try {
    if (process.platform === "linux")
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * A new quick tunnel's name takes a few seconds to resolve and route: wait until it answers, so
 * the first person to open the link doesn't get a DNS error. Any answer will do, a 401 included.
 */
async function answering(url: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5_000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: abort.signal });
      // 530: Cloudflare has the name but not yet the tunnel
      if (res.status !== 530) return;
    } catch {
      // not resolvable yet
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const accepts = (target: Target) =>
  new Promise<boolean>((resolve) => {
    const { connectTo, port } = upstreamOf(target.address, target.port);
    const socket = connect(port, connectTo);
    socket.setTimeout(1_500);
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });

/**
 * Private and public shares of workspace ports. Private: `tailscale serve` on the tailnet, or a
 * forward where Tailscale has no HTTPS. Public: Tailscale Funnel or a Cloudflare quick tunnel.
 * Every share goes through its own proxy (see proxy.ts). Shares end when the user stops them,
 * when their server stops, and when the plugin stops; the plugin undoes leftovers when it starts.
 */
export class Shares {
  private privates = new Map<number, PrivateShare>();
  private publics = new Map<number, PublicShare>();
  private state: { at: number; value: Promise<TailscaleState> } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private missingSince = new Map<number, number>();
  private watch: ReturnType<typeof setInterval> | undefined;
  readonly ready: Promise<void>;

  constructor(
    private readonly forwards: Forwards,
    private readonly records = new Records(),
  ) {
    this.ready = this.cleanUpLeftovers().catch((error) =>
      console.error("cleaning up old shares failed:", error),
    );
  }

  private async cleanUpLeftovers(): Promise<void> {
    const records = await this.records.load();
    if (!records.length) return;
    const state = await readTailscale();
    const config = state.status && !state.problem ? state.config : null;
    const plan = leftoverPlan(records, config, commandOf);
    const failed = new Set<number>();
    for (const { kind, httpsPort } of plan.unserve) {
      try {
        await unserve(kind, httpsPort);
        console.log(`removed ${kind} on port ${httpsPort}, left from an earlier run`);
      } catch (error) {
        failed.add(httpsPort);
        console.error(`removing ${kind} on port ${httpsPort}, left from an earlier run, failed:`, error);
      }
    }
    for (const pid of plan.kill) {
      try {
        process.kill(pid);
        console.log(`stopped cloudflared ${pid}, left from an earlier run`);
      } catch {
        // it exited meanwhile
      }
    }
    for (const r of plan.changed)
      if (r.kind !== "cloudflared")
        console.log(`left ${r.kind} on port ${r.httpsPort} alone: it serves something else now`);
    await this.records.clear();
    // what Tailscale didn't answer about, or refused to remove, is tried again next time
    for (const r of records)
      if (r.kind !== "cloudflared" && (!config || failed.has(r.httpsPort))) await this.records.add(r);
  }

  // one change to Tailscale or the records at a time, so two shares never pick the same port
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.ready).then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  private tailscale(maxAgeMs = STATE_MAX_AGE_MS): Promise<TailscaleState> {
    if (!this.state || Date.now() - this.state.at > maxAgeMs) {
      const value = readTailscale();
      this.state = { at: Date.now(), value };
      value.catch(() => (this.state = undefined));
    }
    return this.state.value;
  }

  async sharing(): Promise<Sharing> {
    const state = await this.tailscale();
    const { https, funnel } = tailscaleOptions(state, userInfo().username);
    return {
      tailnetName: state.status?.dnsName ?? null,
      https,
      funnel,
      cloudflare: cloudflareOption(process.platform),
    };
  }

  /** What the scan reports for a port. */
  describe(port: number): { privateUrl: string | null; public: Port["public"] } {
    const pub = this.publics.get(port);
    return {
      privateUrl: this.privates.get(port)?.url ?? null,
      public: pub
        ? { url: pub.url, provider: pub.provider, access: pub.access, password: pub.password }
        : null,
    };
  }

  /** Over HTTPS at the machine's tailnet name; null when Tailscale has no HTTPS here. */
  sharePrivate(listener: Listener): Promise<string | null> {
    return this.serial(async () => {
      const existing = this.privates.get(listener.port);
      if (existing) return existing.url;
      const state = await this.tailscale(0);
      if (!tailscaleOptions(state, userInfo().username).https.available || !state.status?.dnsName)
        return null;
      const { addresses, dnsName } = state.status;
      // the HTTPS link replaces a forward over HTTP, which would hold the port number
      this.forwards.close(listener.port);
      const sameNumber =
        !state.config.has(listener.port) && (await isFree(addresses, listener.port)) ? listener.port : null;
      let httpsPort = sameNumber ?? (await freePort(addresses));
      while (state.config.has(httpsPort)) httpsPort = await freePort(addresses);
      const target = { address: listener.address, port: listener.port };
      const proxy = await startProxy(target, null);
      const record: ShareRecord = { kind: "serve", httpsPort, target: proxy.url };
      try {
        await this.records.add(record);
        await serve(httpsPort, proxy.url);
      } catch (error) {
        proxy.close();
        await this.records.remove(record);
        throw error;
      }
      const url = httpsUrl(dnsName, httpsPort);
      this.privates.set(listener.port, { target, proxy, httpsPort, url, record });
      this.state = undefined;
      this.startWatching();
      console.log(`shared port ${listener.port} privately at ${url}`);
      return url;
    });
  }

  sharePublic(
    listener: Listener,
    provider: Provider,
    access: Access,
  ): Promise<{ url: string; password: string | null }> {
    return this.serial(async () => {
      const existing = this.publics.get(listener.port);
      if (existing) throw new Error(`Port ${listener.port} is already public at ${existing.url}`);
      const target = { address: listener.address, port: listener.port };
      const password = access === "password" ? newPassword() : null;
      const proxy = await startProxy(target, password);
      try {
        const share =
          provider === "funnel"
            ? await this.openFunnel(target, proxy, access, password)
            : await this.openTunnel(target, proxy, access, password);
        this.publics.set(listener.port, share);
        this.startWatching();
        console.log(`shared port ${listener.port} publicly at ${share.url} (${provider}, ${access})`);
        return { url: share.url, password };
      } catch (error) {
        proxy.close();
        throw error;
      }
    });
  }

  private async openFunnel(
    target: Target,
    proxy: Proxy,
    access: Access,
    password: string | null,
  ): Promise<PublicShare> {
    const state = await this.tailscale(0);
    const option = tailscaleOptions(state, userInfo().username).funnel;
    if (!option.available || !state.status?.dnsName)
      throw new Error(option.reason ?? "Funnel isn't available");
    const { addresses, dnsName, funnelPorts } = state.status;
    const free = new Set<number>();
    for (const port of funnelPorts)
      if (!state.config.has(port) && (await isFree(addresses, port))) free.add(port);
    const httpsPort = chooseFunnelPort(funnelPorts, state.config, (port) => free.has(port));
    if (httpsPort === null)
      throw new Error(`Funnel's ports (${funnelPorts.join(", ")}) are all in use on this machine`);
    const record: ShareRecord = { kind: "funnel", httpsPort, target: proxy.url };
    await this.records.add(record);
    try {
      await funnel(httpsPort, proxy.url);
    } catch (error) {
      await this.records.remove(record);
      throw error;
    }
    this.state = undefined;
    const url = httpsUrl(dnsName, httpsPort);
    return { target, proxy, provider: "funnel", access, password, url, record, httpsPort, child: null };
  }

  private async openTunnel(
    target: Target,
    proxy: Proxy,
    access: Access,
    password: string | null,
  ): Promise<PublicShare> {
    const option = cloudflareOption(process.platform);
    if (!option.available) throw new Error(option.reason ?? "cloudflared isn't available");
    let record: ShareRecord | undefined;
    let started: Awaited<ReturnType<typeof startQuickTunnel>>;
    try {
      started = await startQuickTunnel(proxy.url, (pid) => {
        record = { kind: "cloudflared", pid, target: proxy.url };
        void this.records.add(record);
      });
    } catch (error) {
      if (record) await this.records.remove(record);
      throw error;
    }
    const { url, child } = started;
    await answering(url);
    const share: PublicShare = {
      target,
      proxy,
      provider: "cloudflare",
      access,
      password,
      url,
      record: record ?? { kind: "cloudflared", pid: child.pid ?? 0, target: proxy.url },
      httpsPort: null,
      child,
    };
    child.once("exit", (code) => {
      if (this.publics.get(target.port) !== share) return;
      console.error(`cloudflared for port ${target.port} exited (${code ?? "signal"}); the share ended`);
      this.publics.delete(target.port);
      proxy.close();
      void this.records.remove(share.record);
    });
    return share;
  }

  unshare(port: number, level: "private" | "public"): Promise<void> {
    return this.serial(async () => {
      if (level === "private") {
        this.forwards.close(port);
        const share = this.privates.get(port);
        if (!share) return;
        this.privates.delete(port);
        await this.unserveOwn("serve", share.httpsPort, share.proxy.url);
        share.proxy.close();
        await this.records.remove(share.record);
        console.log(`stopped sharing port ${port} privately`);
        return;
      }
      const share = this.publics.get(port);
      if (!share) return;
      this.publics.delete(port);
      if (share.httpsPort !== null) await this.unserveOwn("funnel", share.httpsPort, share.proxy.url);
      share.child?.kill();
      share.proxy.close();
      await this.records.remove(share.record);
      console.log(`stopped sharing port ${port} publicly`);
    });
  }

  /** Turns a port's serve config off, unless someone has changed it since the plugin set it up. */
  private async unserveOwn(kind: "serve" | "funnel", httpsPort: number, target: string): Promise<void> {
    const state = await this.tailscale(0);
    if (!state.config.has(httpsPort)) return;
    if (!servesOnly(state.config, httpsPort, target)) {
      console.log(`left ${kind} on port ${httpsPort} alone: it serves something else now`);
      return;
    }
    await unserve(kind, httpsPort);
    this.state = undefined;
  }

  async stopAll(): Promise<void> {
    if (this.watch) clearInterval(this.watch);
    this.watch = undefined;
    const ports = new Set([...this.privates.keys(), ...this.publics.keys()]);
    await Promise.all(
      [...ports].flatMap((port) => [
        this.unshare(port, "public").catch((error) =>
          console.error(`stopping public share ${port} failed:`, error),
        ),
        this.unshare(port, "private").catch((error) =>
          console.error(`stopping private share ${port} failed:`, error),
        ),
      ]),
    );
    this.forwards.closeAll();
  }

  /** Every few seconds, while anything is shared or forwarded: ends what a stopped server left. */
  private startWatching(): void {
    this.watch ??= setInterval(() => void this.check(), WATCH_MS);
  }

  watchForwards(): void {
    this.startWatching();
  }

  private async check(): Promise<void> {
    const targets = new Map<number, Target>();
    for (const [port, s] of this.privates) targets.set(port, s.target);
    for (const [port, s] of this.publics) targets.set(port, s.target);
    for (const [port, f] of this.forwards.entries()) targets.set(port, f.target);
    if (!targets.size) {
      clearInterval(this.watch);
      this.watch = undefined;
      return;
    }
    const now = Date.now();
    for (const [port, target] of targets) {
      if (await accepts(target)) {
        this.missingSince.delete(port);
        continue;
      }
      const since = this.missingSince.get(port) ?? now;
      this.missingSince.set(port, since);
      if (now - since < GONE_AFTER_MS) continue;
      this.missingSince.delete(port);
      console.log(`port ${port} stopped listening; ending its shares`);
      await this.unshare(port, "public").catch((error) =>
        console.error(`ending public share ${port} failed:`, error),
      );
      await this.unshare(port, "private").catch((error) =>
        console.error(`ending private share ${port} failed:`, error),
      );
    }
  }
}
