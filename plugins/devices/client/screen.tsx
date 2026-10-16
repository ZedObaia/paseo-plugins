import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { Device } from "../shared/contracts";
import { splitDevices } from "../shared/select";
import { canTurnOff, canTurnOn, isOn, useAction, useDeviceRpcs, useDevices } from "./data";
import { Button, Card, DeviceRow } from "./ui";

/** Every device on this host, which workspace holds it, and power/cleanup actions. */
export function DevicesScreen({ theme, layout, host, navigation }: PluginScreenProps) {
  const devices = useDevices(host.id);
  const { power, assign } = useDeviceRpcs();
  const { busy, perform } = useAction(host.id);
  const [showAll, setShowAll] = useState(false);
  const [deleting, setDeleting] = useState<Device | null>(null);
  const c = theme.colors;
  const data = devices.data;
  if (!data) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.surface0 }}>
        {devices.error ? (
          <Text style={{ color: c.statusDanger }}>{String(devices.error)}</Text>
        ) : (
          <ActivityIndicator color={c.foregroundMuted} />
        )}
      </View>
    );
  }
  const holder = (d: Device) => data.assignments.find((a) => a.deviceId === d.id);
  // the long tail of idle simulators stays behind "Show all"; anything on or held is always shown
  const { main, rest } = splitDevices(data.devices, new Set(data.assignments.map((a) => a.deviceId)));
  const shown = showAll ? data.devices : main;
  const on = shown.filter(isOn);
  const off = shown.filter((d) => !isOn(d));
  async function remove(d: Device) {
    if (await perform(() => power({ deviceId: d.id, action: "delete" }))) setDeleting(null);
  }
  const rows = (list: Device[]) => (
    <Card theme={theme}>
      {list.map((d, index) => {
        const h = holder(d);
        return (
          <DeviceRow key={d.id} theme={theme} device={d} first={index === 0}>
            {h ? (
              <Button
                theme={theme}
                icon="ArrowUpRight"
                label={h.workspaceName}
                onPress={() => navigation?.openWorkspace({ workspaceId: h.workspaceId, serverId: host.id })}
              />
            ) : null}
            {canTurnOn(d) ? (
              <Button
                theme={theme}
                icon="Power"
                label="On"
                disabled={busy}
                onPress={() => void perform(() => power({ deviceId: d.id, action: "boot" }))}
              />
            ) : null}
            {canTurnOff(d) ? (
              <Button
                theme={theme}
                icon="PowerOff"
                label="Off"
                disabled={busy}
                onPress={() => void perform(() => power({ deviceId: d.id, action: "shutdown" }))}
              />
            ) : null}
            {h ? (
              <Button
                theme={theme}
                icon="Unlink"
                label="Release"
                disabled={busy}
                onPress={() => void perform(() => assign({ ...h, deviceId: null, takeOver: false }))}
              />
            ) : null}
            {d.owned ? (
              <Button
                theme={theme}
                danger
                icon="Trash2"
                label="Delete"
                disabled={busy}
                onPress={() => setDeleting(d)}
              />
            ) : null}
          </DeviceRow>
        );
      })}
    </Card>
  );
  const heading = (title: string) => (
    <Text
      accessibilityRole="header"
      style={{ color: c.foreground, fontSize: 16, fontWeight: "600", marginTop: 8 }}
    >
      {title}
    </Text>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 24,
        gap: 12,
        maxWidth: 900,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <Text style={{ color: c.foregroundMuted }}>
        A workspace's name opens it; its Device panel shows the device live.
      </Text>
      {[data.ios, data.android]
        .filter((p) => !p.available)
        .map((p) => (
          <Text key={p.reason} style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {p.reason}
          </Text>
        ))}
      {heading(`On (${on.length})`)}
      {on.length ? rows(on) : <Text style={{ color: c.foregroundMuted }}>Nothing is running.</Text>}
      {off.length ? (
        <>
          {heading("Off")}
          {rows(off)}
        </>
      ) : null}
      {rest.length ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button
            theme={theme}
            label={showAll ? "Show fewer" : `Show all ${data.devices.length} devices`}
            onPress={() => setShowAll(!showAll)}
          />
        </View>
      ) : null}
      <Modal
        title={`Delete ${deleting?.name ?? ""}?`}
        open={deleting !== null}
        onOpenChange={(open) => !open && !busy && setDeleting(null)}
      >
        <Modal.Content>
          <Text style={{ color: c.foreground, lineHeight: 20 }}>
            {deleting?.platform === "ios"
              ? "Deletes the simulator with its apps and data. This can't be undone."
              : "Stops this copy of the emulator. It ran read-only, so nothing it changed is kept."}
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setDeleting(null)} />
            <Button
              theme={theme}
              danger
              label="Delete"
              disabled={busy}
              onPress={() => deleting && void remove(deleting)}
            />
          </View>
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}
