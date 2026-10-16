import { useRpc, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { pct, ratio } from "./client/format";
import { ResourcesScreen } from "./client/screen";
import { queryKey } from "./client/ui";
import { summaryRpc } from "./shared/contracts";

// CPU and memory of the host the app is looking at, in the sidebar row.
function ResourcesItem({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const fetchSummary = useRpc(summaryRpc);
  const s = useQuery({
    queryKey: queryKey(host.id, "summary"),
    queryFn: () => fetchSummary({}),
    refetchInterval: 15_000,
  }).data;
  const summary = s
    ? `${s.cpuPct === null ? "–" : pct(s.cpuPct)} · ${pct(ratio(s.memUsedBytes, s.memTotalBytes) * 100)}`
    : "";
  return (
    <SidebarRow
      icon="Gauge"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
      trailing={
        summary ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{summary}</Text>
        ) : undefined
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Resources", Component: ResourcesScreen });
  client.addSidebarHeaderItem({ id: "main", title: "Resources", Component: ResourcesItem });
  return () => {};
}
