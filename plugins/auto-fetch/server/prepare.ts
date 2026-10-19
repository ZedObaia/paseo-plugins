import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { remoteBase } from "./base";
import { deadline } from "./deadline";
import type { Fetcher } from "./fetcher";
import { wait } from "./wait";

type Request = PluginBeforeRequests["workspace.create"];

/** The whole preparation shares one budget, including settings and project lookup. */
export async function prepareWorktree(
  request: Request,
  context: PluginHookContext,
  ready: Promise<unknown>,
  fromRemote: () => boolean,
  fetcher: Pick<Fetcher, "fresh">,
  waitMs = 15_000,
): Promise<Request | undefined> {
  const { source } = request;
  if (source.kind !== "worktree") return;
  if (source.checkoutSource || source.githubPrNumber || source.refName?.startsWith("refs/remotes/")) return;
  const { signal, dispose } = deadline(waitMs, context.signal);
  return wait(
    (async () => {
      await ready;
      if (signal.aborted) return;
      const cwd =
        source.cwd ??
        (await context.paseo.projects.list()).projects.find((p) => p.projectId === source.projectId)
          ?.projectRootPath;
      if (signal.aborted) return;
      if (!cwd) return;
      const dir = cwd.replace(/^~(?=$|\/)/, () => homedir());
      if (fromRemote() && source.action !== "checkout") {
        const base = await remoteBase(dir, source.refName || source.baseBranch, { signal });
        if (signal.aborted) return;
        if (base) return { ...request, source: { ...source, refName: base } };
      }
      await fetcher.fresh(dir, 60_000, waitMs);
      return undefined;
    })().catch((error) => {
      if (!signal.aborted) console.error("preparing a new worktree failed:", error);
      return undefined;
    }),
    waitMs,
  ).finally(dispose);
}
