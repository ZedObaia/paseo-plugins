import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  dockerActionRpc,
  signalProcessRpc,
  snapshotRpc,
  summaryRpc,
  type Snapshot,
} from "./shared/contracts";
import { dockerAction, dockerSnapshot } from "./server/docker";
import { startSampler, summary, systemSnapshot } from "./server/system";

/**
 * Serves the last value at once and refreshes it in the background once it's older than
 * maxAgeMs (stale-while-revalidate); only the very first call waits. Docker's `system df` and
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
      if (Date.now() - at > maxAgeMs) refresh().catch((error) => console.error("refresh failed:", error));
      return value;
    },
    /**
     * A load that starts after now: one already running may have read the state before an
     * action changed it. Waits at most maxWaitMs; the next poll picks up a slower load.
     */
    async reload(maxWaitMs: number): Promise<void> {
      const fresh = (running ?? Promise.resolve())
        .catch(() => {})
        .then(refresh)
        .catch((error) => console.error("reload failed:", error));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([fresh, new Promise((resolve) => (timer = setTimeout(resolve, maxWaitMs)))]);
      clearTimeout(timer);
    },
  };
}

// The client gives up on a request after 60 s. A Docker action that takes longer (a big build
// cache prune) keeps running and is answered with this; the screen catches up when it's done.
const ACTION_REPLY_MS = 45_000;

export default function contribute(server: PluginServerContext) {
  const stopSampler = startSampler();
  // `top` (process memory on macOS, recent CPU on Linux) takes about a second: refresh every 5 s at most
  const system = cachedSource(systemSnapshot, 5_000);
  const docker = cachedSource(dockerSnapshot, 8_000);

  server.handle(summaryRpc, () => summary());
  server.handle(snapshotRpc, async (): Promise<Snapshot> => {
    const [s, d] = await Promise.all([system.get(), docker.get()]);
    return { ...s, docker: d };
  });
  server.handle(dockerActionRpc, async (input) => {
    const done = dockerAction(input).then(async (result) => {
      await docker.reload(5_000);
      return result;
    });
    // the reply below may already have gone out when a slow action fails
    done.catch((error) => console.error("docker action failed:", error));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<{ message: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ message: "Still running; the numbers update when it's done" }),
        ACTION_REPLY_MS,
      );
    });
    try {
      return await Promise.race([done, slow]);
    } finally {
      clearTimeout(timer);
    }
  });
  server.handle(signalProcessRpc, async ({ pid, signal }) => {
    if (pid === process.pid || pid === process.ppid)
      throw new Error("That's the Paseo daemon; restart it instead");
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") throw new Error(`Not allowed: ${pid} belongs to another user`);
      if (code === "ESRCH") throw new Error(`${pid} already exited`);
      throw error;
    }
    await system.reload(5_000);
    return { message: `Sent ${signal} to ${pid}` };
  });
  return () => stopSampler();
}
