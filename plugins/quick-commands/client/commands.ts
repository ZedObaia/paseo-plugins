import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { commandsFor, listRpc, pickCommand, runRpc, type QuickCommand } from "../shared/contracts";

// another app can change the commands: the Command Center catches up this often
const POLL_MS = 30_000;

const titleOf = (command: QuickCommand) =>
  command.projectId ? `Run ${command.label} (${command.projectName})` : `Run ${command.label}`;

/**
 * A "Run …" item in the Command Center for each command, kept in step with the saved list. The app
 * reads settings only inside components, so the list comes from the daemon, now and then and after
 * the settings screen saves. Paseo can't show an item only in some workspaces: one for another
 * project says so when picked.
 */
export function commandCenterItems(client: PluginClientContext): { refresh(): void; remove(): void } {
  const items = new Map<string, { shows: string; remove: PluginCleanup }>();
  let stopped = false;

  const show = (commands: QuickCommand[]) => {
    const current = new Set(commands.map((command) => command.id));
    for (const [id, item] of items) {
      if (current.has(id)) continue;
      item.remove();
      items.delete(id);
    }
    for (const command of commands) {
      const title = titleOf(command);
      const shows = `${title}\n${command.command}`;
      const item = items.get(command.id);
      if (item?.shows === shows) continue;
      item?.remove();
      const remove = client.addCommandCenterItem({
        id: `run-${command.id}`,
        title,
        icon: "SquareTerminal",
        keywords: ["quick command", command.command.trim().split("\n")[0]],
        context: "workspace",
        onSelect: async ({ rpc, workspace }) => {
          await rpc(runRpc, { workspaceId: workspace.id, commandId: command.id });
        },
      });
      items.set(command.id, { shows, remove });
    }
  };

  const refresh = () =>
    void client
      .rpc(listRpc, {})
      .then(({ commands }) => !stopped && show(commands))
      .catch(() => {
        // host offline or the plugin reloading: keep what's shown until the next answer
      });
  refresh();
  const timer = setInterval(refresh, POLL_MS);

  return {
    refresh,
    remove: () => {
      stopped = true;
      clearInterval(timer);
      for (const item of items.values()) item.remove();
      items.clear();
    },
  };
}

/** `/run dev` in the message box runs the workspace's command named dev, or the one starting with it. */
export function runCommand(client: PluginClientContext): PluginCleanup {
  return client.addSlashCommand({
    name: "run",
    description: "Run one of your quick commands in a new terminal",
    argumentHint: "<command name>",
    context: "workspace",
    onSubmit: async ({ args, rpc, workspace }) => {
      const { commands } = await rpc(listRpc, {});
      const command = pickCommand(commandsFor(commands, workspace.projectId), args);
      await rpc(runRpc, { workspaceId: workspace.id, commandId: command.id });
    },
  });
}
