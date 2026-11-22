import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { ScrollView } from "react-native";
import { CommandList } from "./list";

/** The workspace's commands in a tab or the Explorer: on phones, where there's no header button. */
export function commandPanel(client: PluginClientContext): ComponentType<PluginWorkspacePanelProps> {
  return function QuickCommandsPanel({ theme, layout, workspaceId }) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
        contentContainerStyle={{ padding: layout.compact ? 12 : 16 }}
      >
        <CommandList
          theme={theme}
          compact={layout.compact}
          workspaceId={workspaceId}
          edit={() => client.openSettings("commands")}
        />
      </ScrollView>
    );
  };
}
