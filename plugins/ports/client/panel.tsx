import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView, Text } from "react-native";
import { useScan } from "./data";
import { PortList } from "./ports";

/** The workspace's open ports, as a workspace tab or in the Explorer. */
export function PortsPanel({ theme, layout, host, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const c = theme.colors;
  const data = useScan(host.id).data;
  const openBrowser = navigation?.openBrowser;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 16, gap: 12 }}
    >
      <PortList
        theme={theme}
        hostId={host.id}
        workspaceId={workspaceId}
        openInApp={openBrowser ? (url) => openBrowser({ url, workspaceId }) : undefined}
      />
      {data ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {data.sharing.https.available && data.sharing.tailnetName
            ? `Links open at https://${data.sharing.tailnetName} on your tailnet.`
            : `Links open at ${data.linkHost}. Change it in Settings, Plugins, Ports.`}
        </Text>
      ) : null}
    </ScrollView>
  );
}
