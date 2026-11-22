import type { PluginAgentCommandContext, PluginClientContext } from "@getpaseo/plugin/client";
import { preferChat } from "./client/focus";
import { toolboxPanel } from "./client/location";
import { ToolboxPanel } from "./client/panel";

/** From a chat: the workspace's Toolbox, showing that chat. */
function openFromChat({ workspace, agent, openPanel }: PluginAgentCommandContext) {
  preferChat(workspace.id, agent.id);
  const { id, location } = toolboxPanel();
  openPanel(id, { location });
}

export default function contribute(client: PluginClientContext) {
  // the same panel twice, so each "+" menu lists it once: see client/location.ts
  const cleanups = [
    client.addWorkspacePanel({
      id: "toolbox",
      title: "Toolbox",
      icon: "Blocks",
      context: "workspace",
      locations: ["explorer"],
      Component: ToolboxPanel,
    }),
    client.addWorkspacePanel({
      id: "toolbox-tab",
      title: "Toolbox",
      icon: "Blocks",
      context: "workspace",
      locations: ["workspace"],
      Component: ToolboxPanel,
    }),
    client.addCommandCenterItem({
      id: "open-toolbox",
      title: "Open Toolbox",
      icon: "Blocks",
      keywords: ["skills", "mcp", "connectors", "plugins", "tools", "permissions", "sign in", "reload"],
      context: "agent",
      onSelect: openFromChat,
    }),
    client.addSlashCommand({
      name: "toolbox",
      description: "Show this chat's skills, connectors and plugins",
      argumentHint: "",
      context: "agent",
      onSubmit: openFromChat,
    }),
  ];
  return () => {
    for (const cleanup of cleanups) void cleanup();
  };
}
