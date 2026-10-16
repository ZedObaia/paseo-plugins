import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { pct, ratio } from "./client/format";
import { ResourcesScreen, useSnapshot } from "./client/screen";

// The sidebar shows CPU and memory of the host the app is looking at, refreshed slowly.
function ResourcesItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const s = useSnapshot(15_000).data;
  const summary = s ? `${s.cpuPct === null ? "–" : pct(s.cpuPct)} · ${pct(ratio(s.memory.usedBytes, s.memory.totalBytes) * 100)}` : "";
  return (
    <SidebarRow
      icon="Gauge"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
      trailing={summary ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{summary}</Text> : undefined}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Resources", Component: ResourcesScreen });
  client.addSidebarHeaderItem({ id: "main", title: "Resources", Component: ResourcesItem });
  return () => {};
}
