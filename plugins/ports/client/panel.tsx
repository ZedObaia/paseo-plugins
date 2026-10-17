import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { Port } from "../shared/contracts";
import { errorMessage, portName, portUrl, queryKey, usePortRpcs, useScan } from "./data";

function IconButton({
  theme,
  icon,
  label,
  onPress,
  disabled,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ padding: 6, borderRadius: 8, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, "");

function PortRow({
  theme,
  port,
  first,
  busy,
  inApp,
  open,
  copy,
  stop,
}: {
  theme: PluginTheme;
  port: Port;
  first: boolean;
  busy: boolean;
  /** The row opens the port in Paseo's browser, and a button beside it in the system's. */
  inApp: boolean;
  open(inApp: boolean): void;
  copy(): void;
  stop(): void;
}) {
  const c = theme.colors;
  const note = port.forwarded
    ? { text: `Forwarded to ${hostOf(port.url)}`, color: c.statusSuccess }
    : port.needsForward
      ? { text: "Listens on loopback only; opening it forwards it", color: c.foregroundMuted }
      : null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        paddingLeft: 12,
        paddingRight: 6,
        paddingVertical: 8,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
      }}
    >
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open port ${port.port}, ${portName(port)}`}
        disabled={busy}
        onPress={() => open(inApp)}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={port.source === "docker" ? "Container" : "Globe"} size={16} color={c.foregroundMuted} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ color: c.foreground, fontSize: 14 }} numberOfLines={1}>
            <Text style={{ fontWeight: "600" }}>{port.port}</Text>
            <Text style={{ color: c.foregroundMuted }}> {portName(port)}</Text>
          </Text>
          {port.detail ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
              {port.detail}
            </Text>
          ) : null}
          {note ? (
            <Text style={{ color: note.color, fontSize: 12 }} numberOfLines={2}>
              {note.text}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {busy ? (
        <ActivityIndicator size="small" color={c.foregroundMuted} style={{ marginHorizontal: 6 }} />
      ) : null}
      {inApp ? (
        <IconButton
          theme={theme}
          icon="ExternalLink"
          label={`Open port ${port.port} in your browser`}
          disabled={busy}
          onPress={() => open(false)}
        />
      ) : null}
      <IconButton
        theme={theme}
        icon="Copy"
        label={`Copy link to port ${port.port}`}
        disabled={busy}
        onPress={copy}
      />
      {port.forwarded ? (
        <IconButton
          theme={theme}
          icon="Unplug"
          label={`Stop forwarding port ${port.port}`}
          disabled={busy}
          onPress={stop}
        />
      ) : null}
    </View>
  );
}

/** The workspace's open ports; pressing one opens it. */
export function PortsPanel({ theme, layout, host, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const c = theme.colors;
  const scan = useScan(host.id);
  const { forward, unforward } = usePortRpcs();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const openBrowser = navigation?.openBrowser;
  const ports = scan.data?.workspaces[workspaceId] ?? [];

  async function perform(port: Port, work: () => Promise<void>) {
    setBusy(port.port);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      // a forward changes the port's link
      void queryClient.invalidateQueries({ queryKey: queryKey(host.id) });
    }
  }
  const open = (port: Port, inApp: boolean) =>
    perform(port, async () => {
      const url = await portUrl(port, forward);
      if (inApp && openBrowser) openBrowser({ url, workspaceId });
      else await openExternalUrl(url);
    });
  const copy = (port: Port) =>
    perform(port, async () => {
      await copyText(await portUrl(port, forward));
      toast.show("Link copied", { variant: "success" });
    });
  const stop = (port: Port) => perform(port, () => unforward({ port: port.port }).then(() => {}));

  const muted = { color: c.foregroundMuted, fontSize: 13 };
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 16, gap: 12 }}
    >
      {scan.isPending ? <Text style={muted}>Looking for ports…</Text> : null}
      {scan.error ? (
        <Text style={{ color: c.statusDanger, fontSize: 13 }}>{errorMessage(scan.error)}</Text>
      ) : null}
      {scan.data?.error ? (
        <Text style={{ color: c.statusWarning, fontSize: 13 }}>{scan.data.error}</Text>
      ) : null}
      {scan.data && !ports.length ? (
        <Text style={muted}>
          Nothing in this workspace is listening yet. Dev servers, Docker Compose services and anything else
          started here show up once they open a port.
        </Text>
      ) : null}
      {ports.length ? (
        <View
          style={{
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.surface1,
            overflow: "hidden",
          }}
        >
          {ports.map((port, i) => (
            <PortRow
              key={port.port}
              theme={theme}
              port={port}
              first={i === 0}
              busy={busy === port.port}
              inApp={!!openBrowser}
              open={(inApp) => void open(port, inApp)}
              copy={() => void copy(port)}
              stop={() => void stop(port)}
            />
          ))}
        </View>
      ) : null}
      {scan.data ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Links open at {scan.data.linkHost}. Change it in Settings, Plugins, Ports.
        </Text>
      ) : null}
    </ScrollView>
  );
}
