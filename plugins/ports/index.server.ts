import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { forwardRpc, linkSettings, scanRpc, unforwardRpc } from "./shared/contracts";
import { isLoopback, urlHost } from "./server/address";
import { Forwards, linkHost } from "./server/links";
import { scan, type Scan } from "./server/scan";

// Every open panel and header polls; a scan this recent answers them all.
const FRESH_MS = 1_500;

export default function contribute(server: PluginServerContext) {
  const forwards = new Forwards();
  let hostSetting = "";
  let last: { at: number; scan: Scan } | undefined;
  let running: Promise<Scan> | undefined;

  const refresh = ({ paseo }: PluginHandlerContext) =>
    (running ??= scan(paseo, linkHost(hostSetting), forwards)
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

  server.handle(scanRpc, async (_, context) => (await current(context)).output);
  server.handle(forwardRpc, async ({ port }, context) => {
    const { attributed, host } = await refresh(context);
    const listener = attributed.find((l) => l.port === port && isLoopback(l.address));
    if (!listener) throw new Error(`Port ${port} isn't listening on loopback in a workspace`);
    if (isLoopback(host)) return { url: `http://localhost:${port}` };
    const at = await forwards.open(listener, host);
    last = undefined;
    return { url: `http://${urlHost(host)}:${at}` };
  });
  server.handle(unforwardRpc, ({ port }) => {
    forwards.close(port);
    last = undefined;
    return {};
  });

  return () => {
    unsubscribe();
    forwards.closeAll();
  };
}
