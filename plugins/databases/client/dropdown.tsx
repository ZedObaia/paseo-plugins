import { useRpc, type PluginButtonContentProps, type PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { discoverRpc } from "../shared/contracts";
import { Button } from "./ui";

export function databaseDropdown(client: PluginClientContext) {
  let openRequest = 0;
  return function DatabaseDropdown({ theme, host, layout, workspaceId, close }: PluginButtonContentProps) {
    const discover = useRpc(discoverRpc);
    const query = useQuery({
      queryKey: ["databases", host.id, workspaceId],
      queryFn: () => discover({ workspaceId }),
      refetchInterval: 5000,
    });
    const connections =
      query.data?.connections.filter((connection) => connection.scope === "workspace") ?? [];
    const c = theme.colors;
    return (
      <View style={{ width: layout.compact ? undefined : 380, gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
          Databases
        </Text>
        {query.isPending ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ActivityIndicator size="small" color={c.foregroundMuted} />
            <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Looking for databases…</Text>
          </View>
        ) : query.error ? (
          <>
            <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>
              {query.error instanceof Error ? query.error.message : String(query.error)}
            </Text>
            <Button theme={theme} label="Retry" onPress={() => void query.refetch()} />
          </>
        ) : !connections.length ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
            No databases found for this worktree. Start its PostgreSQL container, add a connection or open a
            SQLite file in Manage connections.
          </Text>
        ) : null}
        {connections.length ? (
          <ScrollView style={{ maxHeight: 320 }}>
            {connections.map((connection) => (
              <Pressable
                key={connection.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${connection.name} in Studio`}
                onPress={() => {
                  close();
                  client.openScreen({
                    screenId: "studio",
                    params: {
                      workspaceId,
                      connectionId: connection.id,
                      openRequest: String(++openRequest),
                    },
                  });
                }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  padding: 10,
                  borderRadius: 6,
                  backgroundColor: pressed ? c.surface1 : c.surface0,
                })}
              >
                <Icon name="Database" size={17} color={c.foregroundMuted} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, fontWeight: "500" }}>
                    {connection.name}
                  </Text>
                  <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {connection.endpoint}
                  </Text>
                </View>
                <Icon name="ArrowUpRight" size={15} color={c.foregroundMuted} />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12 }}>
          <Button
            theme={theme}
            label="Manage connections"
            icon="Settings2"
            onPress={() => {
              close();
              client.openPanel("databases", { workspaceId, location: "workspace" });
            }}
          />
        </View>
      </View>
    );
  };
}
