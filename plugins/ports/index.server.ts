import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  forwardRpc,
  linkSettings,
  scanRpc,
  sharePrivateRpc,
  sharePublicRpc,
  unshareRpc,
} from "./shared/contracts";
import { isLoopback, urlHost } from "./server/address";
import { Forwards, linkHost } from "./server/links";
import { scan, type Scan } from "./server/scan";
import { Shares } from "./server/shares";

// Every open panel and header polls; a scan this recent answers them all.
const FRESH_MS = 1_500;

export default function contribute(server: PluginServerContext) {
  const forwards = new Forwards();
  const shares = new Shares(forwards);
  let hostSetting = "";
  let last: { at: number; scan: Scan } | undefined;
  let running: Promise<Scan> | undefined;

  const refresh = ({ paseo }: PluginHandlerContext) =>
    (running ??= scan(paseo, linkHost(hostSetting), forwards, shares)
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
    if (state.status !== "ready" || state.values.linkHost === hostSetting) return;
    hostSetting = state.values.linkHost;
    // forwards listen on the old address
    forwards.closeAll();
    last = undefined;
  };
  settings.read().then(keep, (error) => console.error("reading settings failed:", error));
  const unsubscribe = settings.subscribe(keep);

  /** A port some workspace holds, from a scan that starts now: the only ports the plugin exposes. */
  const workspacePort = async (context: PluginHandlerContext, port: number) => {
    const fresh = await refresh(context);
    const listener = fresh.attributed.find((l) => l.port === port);
    if (!listener) throw new Error(`Nothing in a workspace listens on port ${port}`);
    return { listener, host: fresh.host };
  };
  const forward = async (context: PluginHandlerContext, port: number) => {
    const { listener, host } = await workspacePort(context, port);
    if (!isLoopback(listener.address)) throw new Error(`Port ${port} doesn't need forwarding`);
    if (isLoopback(host)) return `http://localhost:${port}`;
    const at = await forwards.open(listener, host);
    shares.watchForwards();
    return `http://${urlHost(host)}:${at}`;
  };
  const changed = <T>(result: T) => ((last = undefined), result);

  server.handle(scanRpc, async (_, context) => (await current(context)).output);
  server.handle(forwardRpc, async ({ port }, context) => changed({ url: await forward(context, port) }));
  server.handle(sharePrivateRpc, async ({ port }, context) => {
    const { listener } = await workspacePort(context, port);
    const url = await shares.sharePrivate(listener);
    if (url) return changed({ url });
    // no HTTPS on this tailnet: the link stays HTTP, forwarded when the server is on loopback
    if (!isLoopback(listener.address)) {
      const { https } = await shares.sharing();
      throw new Error(https.reason ?? "Tailscale HTTPS isn't available");
    }
    return changed({ url: await forward(context, port) });
  });
  server.handle(sharePublicRpc, async ({ port, provider, access }, context) => {
    const { listener } = await workspacePort(context, port);
    return changed(await shares.sharePublic(listener, provider, access));
  });
  server.handle(unshareRpc, async ({ port, level }) => changed((await shares.unshare(port, level), {})));

  return async () => {
    unsubscribe();
    await shares.stopAll();
  };
}
