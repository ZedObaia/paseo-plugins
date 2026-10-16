import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { inputRpc, type Assignment, type Device } from "../shared/contracts";
import { splitDevices } from "../shared/select";
import { canDuplicate, canTurnOff, canTurnOn, onFirst, useAction, useDeviceRpcs, useDevices } from "./data";
import { LiveScreen } from "./live";
import { Button, Card, DeviceRow, IconButton, StatusLine } from "./ui";

type Workspace = { workspaceId: string; workspaceName: string; directory: string };

export function DevicePanel({ theme, layout, host, workspaceId }: PluginWorkspacePanelProps) {
  const ws = useWorkspace(workspaceId, (w) => ({ name: w.title ?? w.name, directory: w.directory }));
  const devices = useDevices(host.id);
  const [picking, setPicking] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const c = theme.colors;
  if (!ws || !devices.data) {
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
  const workspace: Workspace = { workspaceId, workspaceName: ws.name, directory: ws.directory };
  const mine = devices.data.assignments.find((a) => a.workspaceId === workspaceId);
  const device = devices.data.devices.find((d) => d.id === mine?.deviceId);
  const picker = (
    <DevicePicker
      theme={theme}
      hostId={host.id}
      workspace={workspace}
      devices={devices.data.devices}
      assignments={devices.data.assignments}
      unavailable={[devices.data.ios, devices.data.android].filter((p) => !p.available).map((p) => p.reason)}
      onDone={() => setPicking(false)}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0, padding: layout.compact ? 8 : 12, gap: 8 }}>
      {device ? (
        <>
          <Toolbar
            theme={theme}
            hostId={host.id}
            device={device}
            workspace={workspace}
            landscape={landscape}
            onChange={() => setPicking(true)}
          />
          {device.state === "booted" ? (
            // keyed: a new device starts with an empty picture, not taps on the old one's
            <LiveScreen key={device.id} theme={theme} deviceId={device.id} onShape={setLandscape} />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 16 }}>
              {canTurnOn(device) ? <BootButton theme={theme} hostId={host.id} device={device} /> : null}
              {device.state === "booting" ? <ActivityIndicator color={c.foregroundMuted} /> : null}
            </View>
          )}
          <Modal title="Device for this workspace" open={picking} onOpenChange={setPicking}>
            <Modal.Content>{picker}</Modal.Content>
          </Modal>
        </>
      ) : (
        <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
          <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>
            Pick a device for {ws.name}
          </Text>
          <Text style={{ color: c.foregroundMuted }}>
            It stays with this workspace: other workspaces can't take it without asking, and agents you start
            here get tools to drive it.
          </Text>
          {picker}
        </ScrollView>
      )}
    </View>
  );
}

function BootButton({ theme, hostId, device }: { theme: PluginTheme; hostId: string; device: Device }) {
  const { power } = useDeviceRpcs();
  const { busy, perform } = useAction(hostId);
  return (
    <Button
      theme={theme}
      primary
      icon="Power"
      label="Turn on"
      disabled={busy}
      onPress={() => void perform(() => power({ deviceId: device.id, action: "boot" }))}
    />
  );
}

function Toolbar({
  theme,
  hostId,
  device,
  workspace,
  landscape,
  onChange,
}: {
  theme: PluginTheme;
  hostId: string;
  device: Device;
  workspace: Workspace;
  // from the last picture, so it is right after a remount too
  landscape: boolean;
  onChange(): void;
}) {
  const { power, assign } = useDeviceRpcs();
  const input = useRpc(inputRpc);
  const { busy, perform } = useAction(hostId);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const c = theme.colors;
  const on = device.state === "booted";
  const key = (button: "home" | "back" | "appSwitch") =>
    void perform(
      () => input({ deviceId: device.id, input: { kind: "button", button } }).then(() => ({ message: "" })),
      true,
    );
  const rotate = () =>
    void perform(
      () =>
        input({
          deviceId: device.id,
          input: { kind: "rotate", orientation: landscape ? "portrait" : "landscape" },
        }).then(() => ({ message: "" })),
      true,
    );
  async function sendText() {
    const value = text;
    if (!value) return;
    const ok = await perform(
      () =>
        input({ deviceId: device.id, input: { kind: "text", text: value } }).then(() => ({ message: "" })),
      true,
    );
    if (ok) {
      setText("");
      setTyping(false);
    }
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      <View style={{ flex: 1, minWidth: 120 }}>
        <Text style={{ color: c.foreground, fontWeight: "600" }} numberOfLines={1}>
          {device.name}
        </Text>
        <StatusLine theme={theme} device={device} />
      </View>
      {on ? (
        <>
          <IconButton theme={theme} icon="House" label="Home" onPress={() => key("home")} />
          {device.platform === "android" ? (
            <IconButton theme={theme} icon="ArrowLeft" label="Back" onPress={() => key("back")} />
          ) : null}
          {device.platform === "android" ? (
            <IconButton theme={theme} icon="Layers" label="Recent apps" onPress={() => key("appSwitch")} />
          ) : null}
          <IconButton theme={theme} icon="RotateCw" label="Rotate" onPress={rotate} />
          <IconButton theme={theme} icon="Keyboard" label="Type text" onPress={() => setTyping(true)} />
          {canTurnOff(device) ? (
            <IconButton
              theme={theme}
              icon="PowerOff"
              label="Turn off"
              disabled={busy}
              onPress={() => void perform(() => power({ deviceId: device.id, action: "shutdown" }))}
            />
          ) : null}
        </>
      ) : null}
      <IconButton theme={theme} icon="ArrowLeftRight" label="Change device" onPress={onChange} />
      <IconButton
        theme={theme}
        icon="Unlink"
        label="Release device"
        disabled={busy}
        onPress={() => void perform(() => assign({ ...workspace, deviceId: null, takeOver: false }))}
      />
      <Modal title="Type on the device" open={typing} onOpenChange={setTyping}>
        <Modal.Content>
          <Text style={{ color: c.foregroundMuted }}>Goes to whatever field has focus on the device.</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => void sendText()}
            placeholder="Text to type"
            placeholderTextColor={c.foregroundMuted}
            style={{
              color: c.foreground,
              backgroundColor: c.surface2,
              borderColor: c.border,
              borderWidth: 1,
              borderRadius: 8,
              padding: 10,
            }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button theme={theme} label="Cancel" onPress={() => setTyping(false)} />
            <Button
              theme={theme}
              primary
              label="Type"
              disabled={!text || busy}
              onPress={() => void sendText()}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function DevicePicker({
  theme,
  hostId,
  workspace,
  devices,
  assignments,
  unavailable,
  onDone,
}: {
  theme: PluginTheme;
  hostId: string;
  workspace: Workspace;
  devices: Device[];
  assignments: Assignment[];
  unavailable: string[];
  onDone(): void;
}) {
  const { assign, create, power } = useDeviceRpcs();
  const { busy, perform } = useAction(hostId);
  const [confirm, setConfirm] = useState<{ device: Device; holder: Assignment } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const c = theme.colors;
  const holderOf = (d: Device) =>
    assignments.find((a) => a.deviceId === d.id && a.workspaceId !== workspace.workspaceId);

  async function use(device: Device, takeOver: boolean) {
    const ok = await perform(() => assign({ ...workspace, deviceId: device.id, takeOver }));
    if (!ok) return;
    if (canTurnOn(device)) await perform(() => power({ deviceId: device.id, action: "boot" }), true);
    setConfirm(null);
    onDone();
  }
  async function duplicate(device: Device) {
    if (await perform(() => create({ ...workspace, from: device.id }))) onDone();
  }

  const { main, rest } = splitDevices(devices, new Set(assignments.map((a) => a.deviceId)));
  const shown = showAll ? devices : main;
  const groups: [string, Device[]][] = [
    ["iOS", onFirst(shown.filter((d) => d.platform === "ios"))],
    ["Android", onFirst(shown.filter((d) => d.platform === "android"))],
  ];

  return (
    <View style={{ gap: 12 }}>
      {unavailable.map((reason) => (
        <Text key={reason} style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {reason}
        </Text>
      ))}
      {groups.map(([title, list]) =>
        list.length ? (
          <View key={title} style={{ gap: 6 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{title}</Text>
            <Card theme={theme}>
              {list.map((d, index) => {
                const holder = holderOf(d);
                return (
                  <DeviceRow
                    key={d.id}
                    theme={theme}
                    device={d}
                    first={index === 0}
                    note={holder && `in use by ${holder.workspaceName}`}
                    warn={Boolean(holder)}
                  >
                    {canDuplicate(d) ? (
                      <Button
                        theme={theme}
                        icon="Copy"
                        label="New copy"
                        disabled={busy}
                        onPress={() => void duplicate(d)}
                      />
                    ) : null}
                    <Button
                      theme={theme}
                      primary={!holder}
                      label={holder ? "Take over" : "Use"}
                      disabled={busy}
                      onPress={() => (holder ? setConfirm({ device: d, holder }) : void use(d, false))}
                    />
                  </DeviceRow>
                );
              })}
            </Card>
          </View>
        ) : null,
      )}
      {rest.length ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button
            theme={theme}
            label={showAll ? "Show fewer" : `Show all ${devices.length} devices`}
            onPress={() => setShowAll(!showAll)}
          />
        </View>
      ) : null}
      <Modal
        title="Take over this device?"
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <Modal.Content>
          <Text style={{ color: c.foreground, lineHeight: 20 }}>
            {confirm?.device.name} belongs to {confirm?.holder.workspaceName}. Taking it moves it here; agents
            there lose it. "New copy" gives this workspace its own device instead.
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <Button theme={theme} label="Cancel" onPress={() => setConfirm(null)} />
            {confirm && canDuplicate(confirm.device) ? (
              <Button theme={theme} label="New copy" onPress={() => void duplicate(confirm.device)} />
            ) : null}
            <Button
              theme={theme}
              danger
              label="Take over"
              disabled={busy}
              onPress={() => confirm && void use(confirm.device, true)}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
