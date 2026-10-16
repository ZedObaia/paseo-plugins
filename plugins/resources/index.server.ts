import type { PluginServerContext } from "@getpaseo/plugin/server";
import { dockerActionRpc, signalProcessRpc, snapshotRpc, type Snapshot } from "./shared/contracts";
import { dockerAction, dockerSnapshot } from "./server/docker";
import { startSampler, systemSnapshot } from "./server/system";

/**
 * Serves the last value at once and refreshes it in the background once it's older than
 * maxAgeMs (stale-while-revalidate). Only the very first call waits. Docker's `system df` and
 * `stats` take seconds on a busy machine, so polling clients never wait on them.
 */
function cachedSource<T>(load: () => Promise<T>, maxAgeMs: number) {
  let value: T | undefined;
  let at = 0;
  let running: Promise<T> | undefined;
  const refresh = () =>
    (running ??= load()
      .then((next) => ((value = next), (at = Date.now()), next))
      .finally(() => (running = undefined)));
  return {
    async get(): Promise<T> {
      if (value === undefined) return refresh();
      if (Date.now() - at > maxAgeMs) refresh().catch((error) => console.error("refresh failed", error));
      return value;
    },
    refresh,
  };
}

export default function contribute(server: PluginServerContext) {
  const stopSampler = startSampler();
  // `top` (macOS process memory) takes about a second, so refresh at most every 5 s
  const system = cachedSource(systemSnapshot, 5_000);
  const docker = cachedSource(dockerSnapshot, 8_000);

  server.handle(snapshotRpc, async (): Promise<Snapshot> => {
    const [s, d] = await Promise.all([system.get(), docker.get()]);
    return { takenAt: Date.now(), ...s, docker: d };
  });
  server.handle(dockerActionRpc, async (input) => {
    const result = await dockerAction(input);
    await docker.refresh(); // the next poll shows the result of the action
    return result;
  });
  server.handle(signalProcessRpc, async ({ pid, signal }) => {
    if (pid === process.pid || pid === process.ppid) throw new Error("That's the Paseo daemon; restart it instead");
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") throw new Error(`Not allowed: ${pid} belongs to another user`);
      if (code === "ESRCH") throw new Error(`${pid} already exited`);
      throw error;
    }
    await system.refresh();
    return { message: `Sent ${signal} to ${pid}` };
  });
  return () => stopSampler();
}
