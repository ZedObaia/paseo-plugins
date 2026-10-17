import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { Port } from "../shared/contracts";
import { errorMessage, hostOf, portName, portUrl, queryKey, usePortRpcs, useScan } from "./data";
import { ShareModal } from "./share";
import { IconButton } from "./ui";

/** One way a port is shared, with its address and what can be done with it. */
function ShareLine({
  theme,
  icon,
  label,
  color,
  text,
  children,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  color: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 26 }}>
      <Icon name={icon} size={13} color={color} />
      <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={2}>
        <Text style={{ color, fontWeight: "600" }}>{label}</Text> {text}
      </Text>
      {children}
    </View>
  );
}

function PortRow({
  theme,
  port,
  first,
  busy,
  inApp,
  open,
  copy,
  share,
  stop,
}: {
  theme: PluginTheme;
  port: Port;
  first: boolean;
  busy: boolean;
  /** The row opens the port in Paseo's browser, and a button beside it in the system's. */
  inApp: boolean;
  open(inApp: boolean): void;
  copy(text: string, what: string): void;
  share(): void;
  stop(level: "private" | "public"): void;
}) {
  const c = theme.colors;
  const pub = port.public;
  return (
    <View
      style={{
        gap: 4,
        paddingLeft: 12,
        paddingRight: 6,
        paddingVertical: 8,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
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
            {port.needsForward ? (
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={2}>
                Listens on loopback only; opening it forwards it
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
          onPress={() => copy(port.url, "Link")}
        />
        <IconButton
          theme={theme}
          icon="Share2"
          label={`Share port ${port.port}`}
          disabled={busy}
          onPress={share}
        />
      </View>
      {port.private ? (
        <ShareLine
          theme={theme}
          icon="Lock"
          label="Private"
          color={c.statusSuccess}
          text={port.private.https ? `at ${hostOf(port.url)}` : `forwarded to ${hostOf(port.url)}`}
        >
          <IconButton
            theme={theme}
            icon="Square"
            label={`Stop sharing port ${port.port} privately`}
            disabled={busy}
            onPress={() => stop("private")}
          />
        </ShareLine>
      ) : null}
      {pub ? (
        <ShareLine
          theme={theme}
          icon="Globe"
          label="Public"
          color={c.statusWarning}
          text={`${hostOf(pub.url)}${pub.password ? ` · password ${pub.password}` : " · no password"}`}
        >
          <IconButton
            theme={theme}
            icon="Copy"
            label={`Copy the public link to port ${port.port}`}
            onPress={() => copy(pub.url, "Public link")}
          />
          {pub.password ? (
            <IconButton
              theme={theme}
              icon="KeyRound"
              label={`Copy the password for port ${port.port}`}
              onPress={() => copy(pub.password!, "Password")}
            />
          ) : null}
          <IconButton
            theme={theme}
            icon="Square"
            label={`Stop sharing port ${port.port} publicly`}
            color={c.statusWarning}
            disabled={busy}
            onPress={() => stop("public")}
          />
        </ShareLine>
      ) : null}
    </View>
  );
}

/** The workspace's open ports; pressing one opens it. */
export function PortsPanel({ theme, layout, host, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const c = theme.colors;
  const scan = useScan(host.id);
  const { forward, unshare } = usePortRpcs();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const [sharing, setSharing] = useState<number | null>(null);
  const openBrowser = navigation?.openBrowser;
  const ports = scan.data?.workspaces[workspaceId] ?? [];
  const shared = ports.find((p) => p.port === sharing);
  // a forward or share changes the port's links
  const changed = () => void queryClient.invalidateQueries({ queryKey: queryKey(host.id) });

  async function perform(port: Port, work: () => Promise<void>) {
    setBusy(port.port);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      changed();
    }
  }
  const open = (port: Port, inApp: boolean) =>
    perform(port, async () => {
      const url = await portUrl(port, forward);
      if (inApp && openBrowser) openBrowser({ url, workspaceId });
      else await openExternalUrl(url);
    });
  const copy = (port: Port, text: string, what: string) =>
    perform(port, async () => {
      await copyText(text === port.url ? await portUrl(port, forward) : text);
      toast.show(`${what} copied`, { variant: "success" });
    });
  const stop = (port: Port, level: "private" | "public") =>
    perform(port, () => unshare({ port: port.port, level }).then(() => {}));

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
              copy={(text, what) => void copy(port, text, what)}
              share={() => setSharing(port.port)}
              stop={(level) => void stop(port, level)}
            />
          ))}
        </View>
      ) : null}
      {scan.data ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Links open at {scan.data.linkHost}. Change it in Settings, Plugins, Ports.
        </Text>
      ) : null}
      {shared && scan.data ? (
        <ShareModal
          theme={theme}
          compact={layout.compact}
          port={shared}
          sharing={scan.data.sharing}
          open
          onOpenChange={(next) => !next && setSharing(null)}
          changed={changed}
        />
      ) : null}
    </ScrollView>
  );
}
