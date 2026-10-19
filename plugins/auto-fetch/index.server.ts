import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { watch, type FSWatcher } from "node:fs";
import { attachRpc, fetchNowRpc, fetchSettings, importWorktreesRpc, statusRpc } from "./shared/contracts";
import { remoteBase } from "./server/base";
import { Fetcher } from "./server/fetcher";
import { commonDir, fastForward, fetchAll, mainPath } from "./server/git";
import { Importer, knownProjectsFile } from "./server/importer";
import {
  activeWorkspaceDirectories,
  gitProjects,
  paseoHome,
  registryDir,
  workspaceDirectories,
} from "./server/registry";
import { worktreesToAdd } from "./server/worktrees";

type Paseo = PluginHandlerContext["paseo"];

// Each repository has its own schedule; this is only how often the plugin looks.
const TICK_MS = 15_000;
// Paseo times out a before hook at 30 s, and an RPC at 30 s.
const BEFORE_CREATE_WAIT_MS = 15_000;
const FETCH_NOW_WAIT_MS = 25_000;

export default function contribute(server: PluginServerContext) {
  const fetcher = new Fetcher({ commonDir, mainPath, fetchAll, fastForward }, () => workspaceDirectories());
  const importer = new Importer({
    projects: () => gitProjects(),
    workspaceDirs: () => activeWorkspaceDirectories(),
    worktreesToAdd,
    file: knownProjectsFile(paseoHome()),
  });

  let fromRemote = true;
  const settings = server.registerSettings(fetchSettings);
  const keep = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    fetcher.intervalMs = state.values.intervalMinutes * 60_000;
    fetcher.fastForward = state.values.fastForward;
    importer.enabled = state.values.importWorktrees;
    fromRemote = state.values.fromRemote;
  };
  // the first tick waits for the saved settings
  const ready = settings.read().then(keep, (error) => console.error("reading settings failed:", error));
  const unsubscribe = settings.subscribe(keep);

  // Paseo hands the API to RPCs and hooks only. The app calls attachRpc when it loads, so the
  // plugin has it from then on; until then, new projects wait.
  let paseo: Paseo | undefined;
  const checkProjects = async () => {
    await ready;
    await importer
      .check(paseo?.workspaces)
      .catch((error) => console.error("checking projects failed:", error));
  };
  const attach = (context: { paseo: Paseo }) => {
    if (paseo) return;
    paseo = context.paseo;
    void checkProjects();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = async () => {
    await checkProjects();
    await fetcher.tick().catch((error) => console.error("fetching failed:", error));
    if (!stopped) timer = setTimeout(loop, TICK_MS);
  };
  timer = setTimeout(loop, 2_000);

  // a project added in the app gets its worktrees in a moment, not at the next tick
  let watcher: FSWatcher | undefined;
  let soon: ReturnType<typeof setTimeout> | undefined;
  try {
    watcher = watch(registryDir(), () => {
      clearTimeout(soon);
      soon = setTimeout(() => void checkProjects(), 500);
    });
    watcher.on("error", () => watcher?.close());
  } catch {
    // no projects yet: the tick finds the first one
  }

  // A new worktree starts from the refs it finds. Paseo fetches a remote base branch, and the
  // change request a checkout is for, right before it creates the worktree. A local base, like the
  // main that agents and the CLI branch from, is only as new as your last pull: the plugin swaps it
  // for the remote branch it tracks, or else fetches and moves it forward first, waiting at most
  // BEFORE_CREATE_WAIT_MS.
  server.before("workspace.create", async ({ request }, context) => {
    attach(context);
    const { source } = request;
    if (source.kind !== "worktree") return;
    if (source.checkoutSource || source.githubPrNumber || source.refName?.startsWith("refs/remotes/")) return;
    try {
      const dir =
        source.cwd ??
        (await context.paseo.projects.list()).projects.find((p) => p.projectId === source.projectId)
          ?.projectRootPath;
      if (!dir) return;
      if (fromRemote && source.action !== "checkout") {
        const base = await remoteBase(dir, source.refName || source.baseBranch);
        if (base) return { ...request, source: { ...source, refName: base } };
      }
      await fetcher.fresh(dir, 60_000, BEFORE_CREATE_WAIT_MS);
    } catch (error) {
      console.error("preparing a new worktree failed:", error);
    }
  });
  server.on("workspace.created", (_, context) => attach(context));
  server.on("agent.created", (_, context) => attach(context));

  server.handle(attachRpc, (_, context) => (attach(context), {}));
  server.handle(statusRpc, (_, context) => (attach(context), fetcher.status()));
  server.handle(fetchNowRpc, async (target, context) => {
    attach(context);
    await fetcher.fetchNow(target, FETCH_NOW_WAIT_MS);
    return fetcher.status();
  });
  server.handle(importWorktreesRpc, async ({ projectId }, context) => {
    attach(context);
    const project = (await gitProjects()).find((p) => p.projectId === projectId);
    if (!project) throw new Error("That project isn't a git repository.");
    return { added: await importer.importProject(context.paseo.workspaces, project) };
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(soon);
    watcher?.close();
    unsubscribe();
    fetcher.stop();
  };
}
