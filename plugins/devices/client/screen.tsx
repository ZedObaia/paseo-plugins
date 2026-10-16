import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { Device } from "../shared/contracts";
import { stateLabel, useAction, useDeviceRpcs, useDevices } from "./data";
import { splitDevices } from "../shared/select";
import { Button, Card, Pill } from "./ui";

/** Every device on this host, which workspace holds it, and power/cleanup actions. */
export function DevicesScreen({ theme, layout, navigation }: PluginScreenProps) {
  const devices = useDevices();
  const { power, assign } = useDeviceRpcs();
  const { busy, perform } = useAction();
  const [showAll, setShowAll] = useState(false);
  const c = theme.colors;
  const data = devices.data;
  if (!data) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.surface0 }}>
        {devices.error ? <Text style={{ color: c.statusDanger }}>{String(devices.error)}</Text> : <ActivityIndicator color={c.foregroundMuted} />}
      </View>
    );
  }
  const holder = (d: Device) => data.assignments.find((a) => a.deviceId === d.id);
  // what's on or held first; the long tail of idle simulators after
  const { main, rest } = splitDevices(data.devices, new Set(data.assignments.map((a) => a.deviceId)));
  const sorted = [...(showAll ? data.devices : main)].sort(
    (a, b) => Number(b.state !== "shutdown") - Number(a.state !== "shutdown") || Number(Boolean(holder(b))) - Number(Boolean(holder(a))),
  );
  const on = data.devices.filter((d) => d.state !== "shutdown").length;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 12, maxWidth: 900, width: "100%", alignSelf: "center" }}>
      <Text style={{ color: c.foregroundMuted }}>
        {on} on · {data.assignments.length} held by workspaces · open a workspace's Device panel to see and control its device
      </Text>
      {[data.ios, data.android]
        .filter((p) => !p.available)
        .map((p) => (
          <Text key={p.reason} style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {p.reason}
          </Text>
        ))}
      <Card theme={theme}>
        {sorted.map((d, index) => {
          const h = holder(d);
          return (
            <View key={d.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderTopWidth: index ? 1 : 0, borderTopColor: c.border, flexWrap: "wrap" }}>
              <View style={{ flex: 1, minWidth: 160 }}>
                <Text style={{ color: c.foreground }} numberOfLines={1}>
                  {d.name}
                </Text>
                <Pill theme={theme} label={`${d.detail} · ${stateLabel(d)}`} tone={d.error ? "danger" : d.state === "booted" ? "success" : "muted"} />
              </View>
              {h ? (
                <Pressable accessibilityRole="link" onPress={() => navigation?.openWorkspace({ workspaceId: h.workspaceId })}>
                  <Text style={{ color: c.accent, fontSize: 13 }} numberOfLines={1}>
                    {h.workspaceName}
                  </Text>
                </Pressable>
              ) : null}
              {d.state === "shutdown" && d.kind !== "physical" ? (
                <Button theme={theme} icon="Power" label="On" disabled={busy} onPress={() => void perform(() => power({ deviceId: d.id, action: "boot" }))} />
              ) : null}
              {d.state === "booted" && d.kind !== "physical" ? (
                <Button theme={theme} icon="PowerOff" label="Off" disabled={busy} onPress={() => void perform(() => power({ deviceId: d.id, action: "shutdown" }))} />
              ) : null}
              {h ? (
                <Button
                  theme={theme}
                  icon="Unlink"
                  label="Release"
                  disabled={busy}
                  onPress={() => void perform(() => assign({ workspaceId: h.workspaceId, workspaceName: h.workspaceName, directory: h.directory, deviceId: null, takeOver: false }))}
                />
              ) : null}
              {d.owned ? (
                <Button theme={theme} danger icon="Trash2" label="Delete" disabled={busy} onPress={() => void perform(() => power({ deviceId: d.id, action: "delete" }))} />
              ) : null}
            </View>
          );
        })}
      </Card>
      {rest.length ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button theme={theme} label={showAll ? "Show fewer" : `Show all ${data.devices.length} devices`} onPress={() => setShowAll(!showAll)} />
        </View>
      ) : null}
    </ScrollView>
  );
}
