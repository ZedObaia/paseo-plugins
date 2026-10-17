import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { Access, Port, Provider, Sharing, SharingOption } from "../shared/contracts";
import { errorMessage, hostOf, portName, portUrl, queryKey, usePortRpcs, useScan } from "./data";
import { Button, Checkbox, IconButton } from "./ui";

interface Actions {
  /** Opens the port's own link, or `url` (its public one). */
  open(port: Port, inApp: boolean, url?: string): void;
  /** Copies the port's own link, or `text`. */
  copy(port: Port, what: string, text?: string): void;
  /** `download`: the user agreed to download cloudflared first. */
  publish(port: Port, provider: Provider, access: Access, download: boolean): void;
  stop(port: Port, level?: "private" | "public"): void;
}

/** Works now, or once the plugin downloads what it needs. */
const usable = (option: SharingOption) => option.available || !!option.download;
const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/**
 * Making a port public: who will be able to open it, whether it asks for a password, and its
 * address. The address is a random Cloudflare one, which has no limit on how many there are, or
 * where the tailnet allows Funnel, this machine's stable Tailscale name instead.
 */
function PublishForm({
  theme,
  port,
  sharing,
  busy,
  progress,
  cancel,
  publish,
}: {
  theme: PluginTheme;
  port: Port;
  sharing: Sharing;
  busy: boolean;
  /** What's happening while it's being made public. */
  progress: string | null;
  cancel(): void;
  publish(provider: Provider, access: Access, download: boolean): void;
}) {
  const c = theme.colors;
  const [provider, setProvider] = useState<Provider>(
    usable(sharing.cloudflare) || !sharing.funnel.available ? "cloudflare" : "funnel",
  );
  const [password, setPassword] = useState(true);
  const option = sharing[provider];
  const other: Provider = provider === "cloudflare" ? "funnel" : "cloudflare";
  const download = !option.available ? option.download : null;
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
        {portName(port)}, until you stop it or the server stops.
      </Text>
      <Checkbox
        theme={theme}
        checked={password}
        onChange={setPassword}
        disabled={busy}
        label="Ask for a password"
        detail="Untick it for webhooks and other services that can't log in."
      />
      {usable(option) ? (
        <Text style={muted}>
          <Text style={{ color: c.foreground }}>Address: </Text>
          {provider === "cloudflare"
            ? "a random trycloudflare.com address, new each time. It can't stream Server-Sent Events."
            : `${sharing.tailnetName ?? "this machine's tailnet name"}, the same each time. Names under ts.net are listed publicly, so scanners find them.`}
          {usable(sharing[other]) ? (
            <Text
              accessibilityRole="link"
              accessibilityState={{ disabled: busy }}
              style={{ color: c.accent }}
              onPress={busy ? undefined : () => setProvider(other)}
            >
              {provider === "cloudflare"
                ? " Use a stable Tailscale address instead"
                : " Use a random Cloudflare address instead"}
            </Text>
          ) : null}
        </Text>
      ) : (
        <Text style={{ ...muted, color: c.statusDanger }}>
          There's no way to make it public on this host. Cloudflare: {sharing.cloudflare.reason} Tailscale
          Funnel: {sharing.funnel.reason}
        </Text>
      )}
      {download ? (
        <Text style={muted}>
          Cloudflare links need cloudflared, Cloudflare's tunnel program. The plugin downloads version{" "}
          {download.version} ({megabytes(download.sizeBytes)}) from Cloudflare's releases on GitHub, checks it
          against Cloudflare's checksums and keeps it in Paseo's folder.
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button theme={theme} label="Cancel" disabled={busy} onPress={cancel} />
        <Button
          theme={theme}
          icon="Globe"
          label={progress ?? (download ? "Download cloudflared and make public" : "Make public")}
          primary
          disabled={busy || !usable(option)}
          onPress={() => publish(provider, password ? "password" : "open", !!download)}
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Icon name="Globe" size={14} color={c.statusWarning} />
        <Text style={{ color: c.statusWarning, fontSize: 13, fontWeight: "600" }}>
          {pub.error ? "Public access stopped" : "Public"}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {pub.provider === "funnel" ? "through Tailscale Funnel" : "through a Cloudflare tunnel"}
        </Text>
      </View>
      {pub.error ? <Text style={{ color: c.statusDanger, fontSize: 13 }}>{pub.error}</Text> : null}
      <Text style={{ color: c.foreground, fontSize: 13 }} selectable>
        {hostOf(pub.url)}
      </Text>
      {!pub.error ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }} selectable>
          {pub.password
            ? `Password ${pub.password}, with any user name`
            : "No password: anyone with the link can open it"}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {!pub.error ? (
          <>
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
              disabled={busy}
              onPress={() => actions.copy(port, "Public link", pub.url)}
            />
            {pub.password ? (
              <Button
                theme={theme}
                icon="KeyRound"
                label="Copy password"
                disabled={busy}
                onPress={() => actions.copy(port, "Password", pub.password!)}
              />
            ) : null}
          </>
        ) : null}
        <Button
          theme={theme}
          icon="Square"
          label={pub.error ? "Retry cleanup" : "Stop public link"}
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
  progress,
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
  progress: string | null;
  actions: Actions;
}) {
  const c = theme.colors;
  const local = /^https?:\/\/(?:localhost|127\.[\d.]+|\[::1\])(?::|\/|$)/.test(port.url);
  const tailnet =
    port.private?.https ||
    (port.needsLink && sharing.https.available) ||
    /(?:\.ts\.net|\/\/100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\/\/\[fd7a:)/.test(port.url);
  const scope = tailnet ? "Tailnet" : local ? "Local" : "Network";
  const forwards = port.private && !port.private.https;
  const willForward = port.needsLink && !sharing.https.available;
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
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{scope}</Text>
          {port.private ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1} selectable>
              {hostOf(port.url)}
            </Text>
          ) : null}
        </View>
        {busy ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
      </View>
      {willForward || forwards ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
          {willForward ? "Opening or copying this link forwards the server to " : "Forwarding to "}
          {hostOf(port.url)}. Anyone who can reach that address can use it without a password.
        </Text>
      ) : null}
      {port.private?.error ? (
        <Text style={{ color: c.statusDanger, fontSize: 13 }}>{port.private.error}</Text>
      ) : null}
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
        {port.private ? (
          <Button
            theme={theme}
            icon="Square"
            label={
              port.private.error
                ? "Retry cleanup"
                : port.private.https
                  ? "Stop tailnet link"
                  : "Stop forwarding"
            }
            disabled={busy}
            onPress={() => actions.stop(port, "private")}
          />
        ) : null}
      </View>
      {publishing && !port.public ? (
        <PublishForm
          theme={theme}
          port={port}
          sharing={sharing}
          busy={busy}
          progress={progress}
          cancel={() => setPublishing(false)}
          publish={(provider, access, download) => actions.publish(port, provider, access, download)}
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
  const pending = useRef(new Set<string>());
  const [publishing, setPublishing] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const ports = scan.data?.workspaces[workspaceId] ?? [];

  const perform = async (port: Port, work: (update: (text: string) => void) => Promise<void>) => {
    if (pending.current.has(port.id)) return;
    pending.current.add(port.id);
    const update = (text: string) => setProgress((all) => ({ ...all, [port.id]: text }));
    update("Working…");
    try {
      await work(update);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      pending.current.delete(port.id);
      setProgress((all) => {
        const next = { ...all };
        delete next[port.id];
        return next;
      });
      // setting up a link or a public address changes the port
      void queryClient.invalidateQueries({ queryKey: queryKey(hostId) });
    }
  };
  const actions: Actions = {
    open: (port, inApp, url) =>
      void perform(port, async () => {
        const target = url ?? (await portUrl(port, workspaceId, rpcs.link));
        if (inApp && openInApp) openInApp(target);
        else await openExternalUrl(target);
      }),
    copy: (port, what, text) =>
      void perform(port, async () => {
        await copyText(text ?? (await portUrl(port, workspaceId, rpcs.link)));
        toast.show(`${what} copied`, { variant: "success" });
      }),
    publish: (port, provider, access, download) =>
      void perform(port, async (update) => {
        if (download) {
          update("Downloading cloudflared…");
          // each call waits up to 40 s for the download to finish
          let done = false;
          for (let attempt = 0; attempt < 15 && !done; attempt++)
            done = (await rpcs.installCloudflared({})).done;
          if (!done) throw new Error("Downloading cloudflared is taking too long; try again later");
        }
        update("Making it public…");
        const { url } = await rpcs.sharePublic({ workspaceId, id: port.id, provider, access });
        setPublishing((current) => (current === port.id ? null : current));
        toast.show(`Port ${port.port} is public at ${hostOf(url)}`, { variant: "success" });
      }),
    stop: (port, level = "public") =>
      void perform(port, async () => {
        await rpcs.unshare({ workspaceId, id: port.id, level });
      }),
  };

  const muted = { color: c.foregroundMuted, fontSize: 13 };
  if (scan.isPending) return <Text style={muted}>Looking for ports…</Text>;
  if (scan.error && !scan.data)
    return <Text style={{ color: c.statusDanger, fontSize: 13 }}>{errorMessage(scan.error)}</Text>;
  return (
    <View style={{ gap: 10 }}>
      {scan.error ? (
        <Text style={{ color: c.statusWarning, fontSize: 13 }}>
          Refresh failed. Showing the last known ports.
        </Text>
      ) : null}
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
              key={port.id}
              theme={theme}
              port={port}
              sharing={scan.data!.sharing}
              first={i === 0}
              busy={!!progress[port.id]}
              inApp={!!openInApp}
              publishing={publishing === port.id}
              setPublishing={(on) => setPublishing(on ? port.id : null)}
              progress={progress[port.id] ?? null}
              actions={actions}
            />
          ))}
        </View>
      )}
    </View>
  );
}
