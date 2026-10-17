import { execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Access, Port, Provider, Sharing } from "../shared/contracts";
import { cloudflareOption, startQuickTunnel } from "./cloudflare";
import type { Forwards } from "./links";
import type { Listener } from "./processes";
import { newPassword, startProxy, type Proxy } from "./proxy";
import { listenerId } from "./identity";
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

type Target = Listener;

interface PrivateShare {
  target: Target;
  proxy: Proxy;
  httpsPort: number;
  url: string;
  record: ShareRecord;
  error?: string;
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
  error?: string;
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
async function answering(url: string, signal: AbortSignal, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal.aborted) throw new Error("Opening the public link was cancelled");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 5_000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: controller.signal });
      // 530: Cloudflare has the name but not yet the tunnel
      if (res.status !== 530) return;
    } catch {
      // not resolvable yet
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    await delay(1_000, undefined, { signal });
  }
  throw new Error("The tunnel did not become reachable. Try making the port public again.");
}

/**
 * Private and public shares of workspace ports. Private: `tailscale serve` on the tailnet, or a
 * forward where Tailscale has no HTTPS. Public: Tailscale Funnel or a Cloudflare quick tunnel.
 * Every share goes through its own proxy (see proxy.ts). Shares end when the user stops them,
 * when their server stops, and when the plugin stops; the plugin undoes leftovers when it starts.
 */
export class Shares {
  private privates = new Map<string, PrivateShare>();
  private publics = new Map<string, PublicShare>();
  private state: { at: number; value: Promise<TailscaleState> } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private missingSince = new Map<string, number>();
  private watch: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private stopping = false;
  private lifetime = new AbortController();
  readonly ready: Promise<void>;
  /**
   * Whether a server still gets links. The watchdog asks while links exist, so a port that stops
   * qualifying loses them even when no app is open to scan.
   */
  stillLinkable: ((target: Listener) => Promise<boolean>) | undefined;

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
      cloudflare: cloudflareOption(process.platform, process.arch),
    };
  }

  /** What the scan reports for a port. */
  describe(id: string): { privateUrl: string | null; privateError?: string; public: Port["public"] } {
    const pub = this.publics.get(id);
    return {
      privateUrl: this.privates.get(id)?.url ?? null,
      privateError: this.privates.get(id)?.error,
      public: pub
        ? {
            url: pub.url,
            provider: pub.provider,
            access: pub.access,
            password: pub.password,
            ...(pub.error ? { error: pub.error } : {}),
          }
        : null,
    };
  }

  /** Over HTTPS at the machine's tailnet name; null when Tailscale has no HTTPS here. */
  sharePrivate(listener: Listener): Promise<string | null> {
    return this.serial(async () => {
      if (this.stopping) throw new Error("The Ports plugin is stopping");
      const id = listenerId(listener);
      const existing = this.privates.get(id);
      if (existing?.error)
        throw new Error("This link has stopped. Retry Stop forwarding to finish its cleanup.");
      if (existing) return existing.url;
      const state = await this.tailscale(0);
      if (!tailscaleOptions(state, userInfo().username).https.available || !state.status?.dnsName)
        return null;
      const { addresses, dnsName } = state.status;
      // the HTTPS link replaces a forward over HTTP, which would hold the port number
      this.forwards.close(id);
      const sameNumber =
        !state.config.has(listener.port) && (await isFree(addresses, listener.port)) ? listener.port : null;
      let httpsPort = sameNumber ?? (await freePort(addresses));
      while (state.config.has(httpsPort)) httpsPort = await freePort(addresses);
      const target = listener;
      const allowed = this.forwards.access.guard(target);
      const proxy = await startProxy(target, null, () =>
        this.stopping ? Promise.resolve(false) : allowed(),
      );
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
      this.privates.set(id, { target, proxy, httpsPort, url, record });
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
      if (this.stopping) throw new Error("The Ports plugin is stopping");
      const id = listenerId(listener);
      const existing = this.publics.get(id);
      if (existing) throw new Error(`Port ${listener.port} is already public at ${existing.url}`);
      const target = listener;
      const password = access === "password" ? newPassword() : null;
      const allowed = this.forwards.access.guard(target);
      const proxy = await startProxy(target, password, () =>
        this.stopping ? Promise.resolve(false) : allowed(),
      );
      try {
        const share =
          provider === "funnel"
            ? await this.openFunnel(target, proxy, access, password)
            : await this.openTunnel(target, proxy, access, password);
        this.publics.set(id, share);
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
    const option = cloudflareOption(process.platform, process.arch);
    if (!option.available) throw new Error(option.reason ?? "cloudflared isn't available");
    let record: ShareRecord | undefined;
    let recorded: Promise<void> = Promise.resolve();
    let started: Awaited<ReturnType<typeof startQuickTunnel>>;
    try {
      started = await startQuickTunnel(
        proxy.url,
        (pid) => {
          record = { kind: "cloudflared", pid, target: proxy.url };
          recorded = this.records.add(record);
          void recorded.catch(() => {});
        },
        30_000,
        this.lifetime.signal,
      );
    } catch (error) {
      await recorded.catch(() => {});
      if (record) await this.records.remove(record);
      throw error;
    }
    const { url, child } = started;
    const startup = new AbortController();
    let exitError: Error | undefined;
    const abort = () => {
      child.kill();
      startup.abort();
    };
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    if (this.stopping) abort();
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
      exitError = new Error(`cloudflared exited (${code ?? "signal"})`);
      startup.abort();
      const id = listenerId(target);
      if (this.publics.get(id) !== share) return;
      console.error(`cloudflared for port ${target.port} exited (${code ?? "signal"}); the share ended`);
      this.publics.delete(id);
      proxy.close();
      void this.records
        .remove(share.record)
        .catch((error) => console.error("recording tunnel exit failed:", error));
    });
    try {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("cloudflared exited before its link was ready");
      await recorded;
      await answering(url, startup.signal);
      if (startup.signal.aborted) throw exitError ?? new Error("Opening the public link was cancelled");
      return share;
    } catch (error) {
      child.kill();
      proxy.close();
      await this.records.remove(share.record);
      throw exitError ?? error;
    } finally {
      this.lifetime.signal.removeEventListener("abort", abort);
    }
  }

  unshare(id: string, level: "private" | "public"): Promise<void> {
    if (level === "private") {
      this.forwards.close(id);
      this.privates.get(id)?.proxy.block();
    } else {
      this.publics.get(id)?.proxy.block();
      this.publics.get(id)?.child?.kill();
    }
    return this.serial(async () => {
      if (level === "private") {
        this.forwards.close(id);
        const share = this.privates.get(id);
        if (!share) return;
        share.proxy.block();
        try {
          await this.unserveOwn("serve", share.httpsPort, share.proxy.url);
          share.proxy.close();
          await this.records.remove(share.record);
          this.privates.delete(id);
        } catch (error) {
          share.error = `Forwarding stopped; cleanup needs a retry: ${error instanceof Error ? error.message : String(error)}`;
          throw error;
        }
        console.log(`stopped sharing port ${share.target.port} privately`);
        return;
      }
      const share = this.publics.get(id);
      if (!share) return;
      share.child?.kill();
      share.proxy.block();
      try {
        if (share.httpsPort !== null) await this.unserveOwn("funnel", share.httpsPort, share.proxy.url);
        share.proxy.close();
        await this.records.remove(share.record);
        this.publics.delete(id);
      } catch (error) {
        share.error = `Public access stopped; cleanup needs a retry: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
      console.log(`stopped sharing port ${share.target.port} publicly`);
    });
  }

  /** Turns a port's serve config off, unless someone has changed it since the plugin set it up. */
  private async unserveOwn(kind: "serve" | "funnel", httpsPort: number, target: string): Promise<void> {
    const state = await this.tailscale(0);
    if (state.problem) throw new Error(state.problem);
    if (!state.config.has(httpsPort)) return;
    if (!servesOnly(state.config, httpsPort, target)) {
      if (Object.values(state.config.get(httpsPort)!.handlers).includes(target))
        throw new Error(
          `Tailscale port ${httpsPort} was changed and still routes to this link. Remove that route before retrying cleanup.`,
        );
      console.log(`left ${kind} on port ${httpsPort} alone: it serves something else now`);
      return;
    }
    await unserve(kind, httpsPort);
    this.state = undefined;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    this.lifetime.abort();
    if (this.watch) clearInterval(this.watch);
    this.watch = undefined;
    this.forwards.stop();
    for (const share of this.privates.values()) share.proxy.block();
    for (const share of this.publics.values()) {
      share.proxy.block();
      share.child?.kill();
    }
    await this.queue;
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
    if (this.stopping) return;
    this.watch ??= setInterval(() => {
      if (this.checking) return;
      this.checking = true;
      void this.check()
        .catch((error) => console.error("checking shared ports failed:", error))
        .finally(() => {
          this.checking = false;
        });
    }, WATCH_MS);
  }

  watchForwards(): void {
    this.startWatching();
  }

  /** Whether the plugin shares this server, privately or publicly. */
  has(id: string): boolean {
    return this.privates.has(id) || this.publics.has(id);
  }

  /** Ends every link to a server: its public link, then its tailnet link or forward. */
  /**
   * Ends every link to a server. Both levels stop carrying traffic before this returns its
   * promise; removing them from Tailscale and stopping the tunnel wait their turn behind other
   * sharing work.
   */
  async endLinks(id: string): Promise<void> {
    const ending = [this.unshare(id, "public"), this.unshare(id, "private")];
    await Promise.all(
      ending.map((done) => done.catch((error) => console.error("ending a link failed:", error))),
    );
  }

  private async check(): Promise<void> {
    const targets = new Map<string, Target>();
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
      if (this.publics.get(port)?.error)
        await this.unshare(port, "public").catch((error) =>
          console.error("retrying public cleanup failed:", error),
        );
      if (this.privates.get(port)?.error)
        await this.unshare(port, "private").catch((error) =>
          console.error("retrying private cleanup failed:", error),
        );
      const status = await this.forwards.access.status(target).catch(() => "missing" as const);
      if (status === "present") {
        this.missingSince.delete(port);
        // a checker that fails leaves links alone; the next check asks again
        if (this.stillLinkable && !(await this.stillLinkable(target).catch(() => true))) {
          console.log(`port ${target.port} no longer gets links; ending them`);
          await this.endLinks(port);
        }
        continue;
      }
      const since = this.missingSince.get(port) ?? now;
      this.missingSince.set(port, since);
      if (status !== "replaced" && now - since < GONE_AFTER_MS) continue;
      this.missingSince.delete(port);
      console.log(`port ${target.port} stopped or changed owner; ending its shares`);
      await this.endLinks(port);
    }
  }
}
