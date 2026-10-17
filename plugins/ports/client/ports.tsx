import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { Access, Port, Provider, Sharing } from "../shared/contracts";
import { errorMessage, hostOf, portName, portUrl, queryKey, usePortRpcs, useScan } from "./data";
import { Button, Checkbox, IconButton } from "./ui";

interface Actions {
  /** Opens the port's own link, or `url` (its public one). */
  open(port: Port, inApp: boolean, url?: string): void;
  /** Copies the port's own link, or `text`. */
  copy(port: Port, what: string, text?: string): void;
  publish(port: Port, provider: Provider, access: Access): void;
  stop(port: Port): void;
}

/** Making a port public: who can open it, with or without a password, and through what. */
function PublishForm({
  theme,
  port,
  sharing,
  busy,
  cancel,
  publish,
}: {
  theme: PluginTheme;
  port: Port;
  sharing: Sharing;
  busy: boolean;
  cancel(): void;
  publish(provider: Provider, access: Access): void;
}) {
  const c = theme.colors;
  const [provider, setProvider] = useState<Provider>(
    sharing.funnel.available || !sharing.cloudflare.available ? "funnel" : "cloudflare",
  );
  const [password, setPassword] = useState(true);
  const both = sharing.funnel.available && sharing.cloudflare.available;
  const option = sharing[provider];
  const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 };
  return (
    <View
      style={{
        gap: 10,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface2,
      }}
    >
      <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>
        Anyone on the internet who has the link{password ? " and the password" : ""} will be able to open{" "}
        {portName(port)} on port {port.port}, until you stop it or the server stops.
      </Text>
      <Checkbox
        theme={theme}
        checked={password}
        onChange={setPassword}
        label="Ask for a password"
        detail="Turn it off for webhooks and other services that can't log in."
      />
      {option.available ? (
        <Text style={muted}>
          {provider === "funnel"
            ? "Through Tailscale Funnel, at an address that stays the same. Funnel addresses are listed publicly, so scanners find them."
            : "Through a Cloudflare tunnel, at a random address that's new each time."}
          {both ? (
            <Text
              accessibilityRole="link"
              style={{ color: c.accent }}
              onPress={() => setProvider(provider === "funnel" ? "cloudflare" : "funnel")}
            >
              {provider === "funnel"
                ? " Use a random Cloudflare address instead."
                : " Use Tailscale Funnel instead."}
            </Text>
          ) : null}
        </Text>
      ) : (
        <Text style={{ ...muted, color: c.statusDanger }}>
          Neither way to make it public works on this host. Tailscale Funnel: {sharing.funnel.reason}{" "}
          Cloudflare: {sharing.cloudflare.reason}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button theme={theme} label="Cancel" disabled={busy} onPress={cancel} />
        <Button
          theme={theme}
          icon="Globe"
          label={busy ? "Making it public…" : "Make public"}
          primary
          disabled={busy || !option.available}
          onPress={() => publish(provider, password ? "password" : "open")}
        />
      </View>
    </View>
  );
}

/** A public port's address and password, with what can be done with them. */
function PublicLink({
  theme,
  port,
  busy,
  inApp,
  actions,
}: {
  theme: PluginTheme;
  port: Port;
  busy: boolean;
  inApp: boolean;
  actions: Actions;
}) {
  const c = theme.colors;
  const pub = port.public!;
  return (
    <View
      style={{
        gap: 6,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.statusWarning,
        backgroundColor: c.surface2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Globe" size={14} color={c.statusWarning} />
        <Text style={{ color: c.statusWarning, fontSize: 13, fontWeight: "600" }}>Public</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {pub.provider === "funnel" ? "through Tailscale Funnel" : "through a Cloudflare tunnel"}
        </Text>
      </View>
      <Text style={{ color: c.foreground, fontSize: 13 }} selectable>
        {hostOf(pub.url)}
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} selectable>
        {pub.password
          ? `Password ${pub.password}, with any user name`
          : "No password: anyone with the link can open it"}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button
          theme={theme}
          icon="ExternalLink"
          label="Open"
          disabled={busy}
          onPress={() => actions.open(port, inApp, pub.url)}
        />
        <Button
          theme={theme}
          icon="Copy"
          label="Copy link"
          onPress={() => actions.copy(port, "Public link", pub.url)}
        />
        {pub.password ? (
          <Button
            theme={theme}
            icon="KeyRound"
            label="Copy password"
            onPress={() => actions.copy(port, "Password", pub.password!)}
          />
        ) : null}
        <Button
          theme={theme}
          icon="Square"
          label="Stop"
          danger
          disabled={busy}
          onPress={() => actions.stop(port)}
        />
      </View>
    </View>
  );
}

function PortItem({
  theme,
  port,
  sharing,
  first,
  busy,
  inApp,
  publishing,
  setPublishing,
  actions,
}: {
  theme: PluginTheme;
  port: Port;
  sharing: Sharing;
  first: boolean;
  busy: boolean;
  /** Open uses Paseo's browser, with a button beside it for the system's. */
  inApp: boolean;
  publishing: boolean;
  setPublishing(publishing: boolean): void;
  actions: Actions;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 8, padding: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
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
          {port.private ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1} selectable>
              {hostOf(port.url)}
            </Text>
          ) : null}
        </View>
        {busy ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
      </View>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button
          theme={theme}
          icon={inApp ? "AppWindow" : "ExternalLink"}
          label="Open"
          primary
          disabled={busy}
          onPress={() => actions.open(port, inApp)}
        />
        {inApp ? (
          <IconButton
            theme={theme}
            icon="ExternalLink"
            label={`Open port ${port.port} in your browser`}
            disabled={busy}
            onPress={() => actions.open(port, false)}
          />
        ) : null}
        <Button
          theme={theme}
          icon="Copy"
          label="Copy link"
          disabled={busy}
          onPress={() => actions.copy(port, "Link")}
        />
        {!port.public && !publishing ? (
          <Button
            theme={theme}
            icon="Globe"
            label="Make public…"
            disabled={busy}
            onPress={() => setPublishing(true)}
          />
        ) : null}
      </View>
      {publishing && !port.public ? (
        <PublishForm
          theme={theme}
          port={port}
          sharing={sharing}
          busy={busy}
          cancel={() => setPublishing(false)}
          publish={(provider, access) => actions.publish(port, provider, access)}
        />
      ) : null}
      {port.public ? (
        <PublicLink theme={theme} port={port} busy={busy} inApp={inApp} actions={actions} />
      ) : null}
    </View>
  );
}

/**
 * A workspace's open ports, each with Open, Copy link and Make public. The Ports panel and the
 * header button's dropdown both show this.
 */
export function PortList({
  theme,
  hostId,
  workspaceId,
  openInApp,
}: {
  theme: PluginTheme;
  hostId: string;
  workspaceId: string;
  /** Paseo's own browser, where the app has one. */
  openInApp?: (url: string) => void;
}) {
  const c = theme.colors;
  const scan = useScan(hostId);
  const rpcs = usePortRpcs();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const [publishing, setPublishing] = useState<number | null>(null);
  const ports = scan.data?.workspaces[workspaceId] ?? [];

  const perform = async (port: Port, work: () => Promise<void>) => {
    setBusy(port.port);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      // setting up a link or a public address changes the port
      void queryClient.invalidateQueries({ queryKey: queryKey(hostId) });
    }
  };
  const actions: Actions = {
    open: (port, inApp, url) =>
      void perform(port, async () => {
        const target = url ?? (await portUrl(port, rpcs.link));
        if (inApp && openInApp) openInApp(target);
        else await openExternalUrl(target);
      }),
    copy: (port, what, text) =>
      void perform(port, async () => {
        await copyText(text ?? (await portUrl(port, rpcs.link)));
        toast.show(`${what} copied`, { variant: "success" });
      }),
    publish: (port, provider, access) =>
      void perform(port, async () => {
        const { url } = await rpcs.sharePublic({ port: port.port, provider, access });
        setPublishing(null);
        toast.show(`Port ${port.port} is public at ${hostOf(url)}`, { variant: "success" });
      }),
    stop: (port) =>
      void perform(port, async () => {
        await rpcs.unshare({ port: port.port });
      }),
  };

  const muted = { color: c.foregroundMuted, fontSize: 13 };
  if (scan.isPending) return <Text style={muted}>Looking for ports…</Text>;
  if (scan.error)
    return <Text style={{ color: c.statusDanger, fontSize: 13 }}>{errorMessage(scan.error)}</Text>;
  return (
    <View style={{ gap: 10 }}>
      {scan.data?.error ? (
        <Text style={{ color: c.statusWarning, fontSize: 13 }}>{scan.data.error}</Text>
      ) : null}
      {!ports.length ? (
        <Text style={muted}>
          Nothing in this workspace is listening yet. Dev servers, Docker Compose services and anything else
          started here show up once they open a port.
        </Text>
      ) : (
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
            <PortItem
              key={port.port}
              theme={theme}
              port={port}
              sharing={scan.data!.sharing}
              first={i === 0}
              busy={busy === port.port}
              inApp={!!openInApp}
              publishing={publishing === port.port}
              setPublishing={(on) => setPublishing(on ? port.port : null)}
              actions={actions}
            />
          ))}
        </View>
      )}
    </View>
  );
}
