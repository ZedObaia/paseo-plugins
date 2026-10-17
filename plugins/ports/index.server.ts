import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  installCloudflaredRpc,
  linkRpc,
  linkSettings,
  scanRpc,
  sharePublicRpc,
  unshareRpc,
  type PortTarget,
} from "./shared/contracts";
import { isLoopback, urlHost } from "./server/address";
import { installCloudflared } from "./server/cloudflared";
import { Detections, linkable } from "./server/kind";
import { listenerId } from "./server/identity";
import { Forwards, linkHost } from "./server/links";
import { scan, toPort, workspaceListener, type Scan } from "./server/scan";
import type { Listener } from "./server/processes";
import { stillLinkable } from "./server/policy";
import { Shares } from "./server/shares";

// Every open panel and header polls; a scan this recent answers them all.
const FRESH_MS = 1_500;

/** Why a port gets no links: links need a positive HTTP answer, and some need your allowance. */
function noLinks(listener: Listener, protocol: string | undefined): string {
  const port = `Port ${listener.port}`;
  if (protocol === "http") return `${port} doesn't serve a web page. Allow links for it first.`;
  if (protocol === "https") return `${port} only speaks HTTPS, which Ports doesn't make links for yet.`;
  if (protocol === "other") return `${port} isn't a web server, so Ports doesn't make links to it.`;
  return `${port} hasn't answered as a web server yet. Try again in a moment.`;
}

export default function contribute(server: PluginServerContext) {
  const forwards = new Forwards();
  const shares = new Shares(forwards);
  const detections = new Detections();
  let hostSetting = "";
  let allowed: ReadonlySet<string> = new Set();
  const getsLinks = (listener: Listener) =>
    linkable(listener, detections.get(listener), allowed.has(listenerId(listener)));
  shares.stillLinkable = stillLinkable(forwards.access, detections, () => allowed);
  let last: { at: number; scan: Scan } | undefined;
  let running: Promise<Scan> | undefined;

  const refresh = ({ paseo }: PluginHandlerContext) =>
    (running ??= scan(paseo, linkHost(hostSetting), forwards, shares, detections, allowed)
      .then((next) => ((last = { at: Date.now(), scan: next }), next))
      .finally(() => (running = undefined)));
  // Answers with the last scan and refreshes it in the background once it's stale, so polls
  // never wait on `docker ps`; only the first one, and the one after a change, waits.
  const current = async (context: PluginHandlerContext): Promise<Scan> => {
    if (!last) return refresh(context);
    // reading /proc blocks for a moment: answer first
    if (Date.now() - last.at > FRESH_MS)
      setImmediate(() => refresh(context).catch((error) => console.error("scan failed:", error)));
    return last.scan;
  };

  const settings = server.registerSettings(linkSettings);
  const keep = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    allowed = new Set(state.values.allowed);
    detections.checked = new Set(state.values.checked);
    last = undefined;
    if (state.values.linkHost === hostSetting) return;
    hostSetting = state.values.linkHost;
    // forwards listen on the old address
    forwards.closeAll();
  };
  settings.read().then(keep, (error) => console.error("reading settings failed:", error));
  const unsubscribe = settings.subscribe(keep);

  /** A port some workspace holds, from a scan that starts now: the only ports the plugin exposes. */
  const workspacePort = async (context: PluginHandlerContext, target: PortTarget) => {
    // a scan already running may predate the action; a failed one doesn't block it
    await running?.catch(() => {});
    const fresh = await refresh(context);
    const listener = workspaceListener(fresh.attributed, target);
    if (!getsLinks(listener)) throw new Error(noLinks(listener, detections.get(listener)?.protocol));
    return { listener, host: fresh.host };
  };
  const changed = <T>(result: T) => ((last = undefined), result);

  server.handle(scanRpc, async (_, context) => (await current(context)).output);
  server.handle(linkRpc, async (target, context) => {
    const { listener, host } = await workspacePort(context, target);
    const https = await shares.sharePrivate(listener);
    if (https) return changed({ url: https });
    // no HTTPS on this tailnet: the link host, through a forward when the server is on loopback
    if (isLoopback(listener.address) && !isLoopback(host)) {
      const at = await forwards.open(listener, host);
      shares.watchForwards();
      return changed({ url: `http://${urlHost(host)}:${at}` });
    }
    return { url: toPort(listener, host, { forwardedAt: null, privateUrl: null, public: null }, null).url };
  });
  server.handle(sharePublicRpc, async ({ provider, access, ...target }, context) => {
    const { listener } = await workspacePort(context, target);
    return changed(await shares.sharePublic(listener, provider, access));
  });
  server.handle(installCloudflaredRpc, async () => {
    // a slow connection takes longer than a request may: the app asks again until it's done
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      installCloudflared().then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), 40_000))),
    ]);
    clearTimeout(timer);
    return changed({ done });
  });
  server.handle(unshareRpc, async ({ id, level }) => {
    try {
      await shares.unshare(id, level);
      return {};
    } finally {
      last = undefined;
    }
  });

  return async () => {
    unsubscribe();
    await shares.stopAll();
  };
}
