import type { PluginServerContext } from "@getpaseo/plugin/server";
import { commandSettings, listRpc, runRpc } from "./shared/contracts";
import { runCommand } from "./server/run";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(commandSettings);
  const saved = async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Quick commands' settings don't read: ${state.error}`);
    return { commands: state.values.commands, revision: state.revision };
  };

  server.handle(listRpc, saved);
  server.handle(runRpc, async ({ workspaceId, commandId, pressEnter }, { paseo }) => {
    const command = (await saved()).commands.find((other) => other.id === commandId);
    if (!command) throw new Error("That quick command was deleted.");
    return runCommand(paseo, command, workspaceId, pressEnter ?? command.pressEnter);
  });

  return () => {};
}
