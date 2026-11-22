import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { commandCenterItems, runCommand } from "./client/commands";
import { headerButtons } from "./client/header";
import { commandPanel } from "./client/panel";
import { CommandSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  const items = commandCenterItems(client);
  const removers = [
    client.addSettingsScreen({
      id: "commands",
      title: "Commands",
      icon: "SquareTerminal",
      Component: (props: PluginSurfaceProps) => <CommandSettings {...props} onSaved={items.refresh} />,
    }),
    client.addWorkspacePanel({
      id: "commands",
      title: "Quick commands",
      icon: "SquareTerminal",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: commandPanel(client),
    }),
    client.addCommandCenterItem({
      id: "edit",
      title: "Edit quick commands",
      icon: "SquareTerminal",
      keywords: ["quick commands", "add command"],
      context: "global",
      onSelect: () => client.openSettings("commands"),
    }),
    runCommand(client),
  ];
  const removeHeaderButtons = headerButtons(client);
  return () => {
    removeHeaderButtons();
    items.remove();
    for (const remove of removers) remove();
  };
}
