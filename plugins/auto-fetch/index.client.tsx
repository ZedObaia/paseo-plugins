import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FetchSettings } from "./client/settings";
import { attachRpc, fetchNowRpc, importWorktreesRpc } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  // hands the daemon side the Paseo API, which adding a new project's worktrees needs
  client.rpc(attachRpc, {}).catch((error) => console.warn("[auto-fetch] attach failed", error));
  const keywords = ["git", "fetch", "pull", "worktree", "remote", "sync"];
  client.addSettingsScreen({ id: "fetch", title: "Fetching", icon: "RefreshCw", Component: FetchSettings });
  client.addCommandCenterItem({
    id: "fetch-workspace",
    title: "Fetch this workspace's repository",
    icon: "RefreshCw",
    keywords,
    context: "workspace",
    async onSelect({ rpc, workspace }) {
      await rpc(fetchNowRpc, { directory: workspace.directory });
    },
  });
  client.addCommandCenterItem({
    id: "fetch-all",
    title: "Fetch every repository",
    icon: "RefreshCw",
    keywords,
    context: "global",
    async onSelect({ rpc, openSettings }) {
      await rpc(fetchNowRpc, {});
      openSettings("fetch");
    },
  });
  client.addCommandCenterItem({
    id: "import-worktrees",
    title: "Add this project's worktrees as workspaces",
    icon: "FolderGit2",
    keywords: ["git", "worktree", "import", "existing", "workspace"],
    context: "workspace",
    async onSelect({ rpc, workspace }) {
      await rpc(importWorktreesRpc, { projectId: workspace.projectId });
    },
  });
  return () => {};
}
