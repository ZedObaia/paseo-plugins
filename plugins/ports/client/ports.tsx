import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { Access, Port, Provider, Sharing, SharingOption } from "../shared/contracts";
import { errorMessage, hostOf, portName, portUrl, queryKey, usePortRpcs, useScan } from "./data";
import { Button, Checkbox, faint, IconButton, Options, Pill, sizes, TextAction } from "./ui";

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

/** Who a port's own link reaches. */
function scopeOf(port: Port, sharing: Sharing): "Local" | "Tailnet" | "Network" {
  const tailnet =
    port.private?.https ||
    (port.needsLink && sharing.https.available) ||
    /(?:\.ts\.net|\/\/100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\/\/\[fd7a:)/.test(port.url);
  if (tailnet) return "Tailnet";
  return /^https?:\/\/(?:localhost|127\.[\d.]+|\[::1\])(?::|\/|$)/.test(port.url) ? "Local" : "Network";
}

/**
 * Making a port public: who will be able to open it, whether it asks for a password, and its
 * address: a random Cloudflare one, which has no limit on how many there are, or where the
 * tailnet allows Funnel, this machine's stable Tailscale name.
 */
function PublishForm({
  theme,
  compact,
  port,
  sharing,
  busy,
  progress,
  cancel,
  publish,
}: {
  theme: PluginTheme;
  compact: boolean;
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
  const download = !option.available ? option.download : null;
  const note = { color: c.foregroundMuted, fontSize: 12, lineHeight: 16 };
  const random = "New each time, through Cloudflare. Can't stream Server-Sent Events.";
  const stable = `${sharing.tailnetName ?? "This machine's tailnet name"}, through Tailscale. Listed publicly, so keep the password.`;
  return (
    <View
      style={{
        gap: 12,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface0,
      }}
    >
      <Text style={{ color: c.foreground, fontSize: sizes(compact).text, lineHeight: 19 }}>
        Anyone with the link{password ? " and the password" : ""} will be able to open {portName(port)} until
        you stop it.
      </Text>
      <Checkbox
        theme={theme}
        compact={compact}
        checked={password}
        onChange={setPassword}
        disabled={busy}
        label="Require a password"
        detail="Untick for webhooks and other services that can't log in."
      />
      {usable(sharing.cloudflare) && usable(sharing.funnel) ? (
        <Options<Provider>
          theme={theme}
          compact={compact}
          value={provider}
          onChange={setProvider}
          disabled={busy}
          options={[
            { value: "cloudflare", label: "Random address", detail: random },
            { value: "funnel", label: "Stable address", detail: stable },
          ]}
        />
      ) : usable(option) ? (
        <Text style={note}>
          {provider === "cloudflare" ? `Random address: ${random}` : `Stable address: ${stable}`}
        </Text>
      ) : (
        <Text style={{ ...note, color: c.statusDanger }}>
          There's no way to make it public on this host. Cloudflare: {sharing.cloudflare.reason} Tailscale
          Funnel: {sharing.funnel.reason}
        </Text>
      )}
      {download ? (
        <Text style={note}>
          Downloads Cloudflare's cloudflared {download.version} ({megabytes(download.sizeBytes)}) from its
          GitHub releases first.
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          label="Cancel"
          disabled={busy}
          onPress={cancel}
        />
        <Button
          theme={theme}
          compact={compact}
          variant="primary"
          label={progress ?? (download ? "Download and make public" : "Make public")}
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
  compact,
  port,
  busy,
  inApp,
  actions,
}: {
  theme: PluginTheme;
  compact: boolean;
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
        gap: 4,
        paddingTop: 10,
        paddingHorizontal: 10,
        paddingBottom: pub.error ? 10 : 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: faint(c.statusWarning),
        backgroundColor: c.surface0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Globe" size={sizes(compact).icon} color={c.statusWarning} />
        <Text style={{ color: c.statusWarning, fontSize: 12, fontWeight: "600" }}>
          {pub.error ? "Public access stopped" : "Public"}
        </Text>
        <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12 }}>
          {pub.provider === "funnel" ? "· stable address" : "· random address"}
        </Text>
        <TextAction
          theme={theme}
          danger
          label={pub.error ? "Retry cleanup" : "Stop"}
          accessibilityLabel={pub.error ? "Retry cleanup" : `Stop the public link to port ${port.port}`}
          disabled={busy}
          onPress={() => actions.stop(port)}
        />
      </View>
      {pub.error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{pub.error}</Text> : null}
      <Text style={{ color: c.foreground, fontSize: sizes(compact).text }} numberOfLines={2} selectable>
        {hostOf(pub.url)}
      </Text>
      {!pub.error ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }} selectable>
          {pub.password ? `Password ${pub.password} · any user name` : "No password"}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", marginLeft: -8 }}>
        {!pub.error ? (
          <>
            <Button
              theme={theme}
              compact={compact}
              variant="ghost"
              icon="ExternalLink"
              label="Open"
              disabled={busy}
              onPress={() => actions.open(port, inApp, pub.url)}
            />
            <Button
              theme={theme}
              compact={compact}
              variant="ghost"
              icon="Copy"
              label="Copy link"
              disabled={busy}
              onPress={() => actions.copy(port, "Public link", pub.url)}
            />
            {pub.password ? (
              <Button
                theme={theme}
                compact={compact}
                variant="ghost"
                icon="KeyRound"
                label="Copy password"
                disabled={busy}
                onPress={() => actions.copy(port, "Password", pub.password!)}
              />
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

function PortItem({
  theme,
  compact,
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
  compact: boolean;
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
  const s = sizes(compact);
  const scope = scopeOf(port, sharing);
  const forwards = port.private && !port.private.https;
  const willForward = port.needsLink && !sharing.https.available;
  // the lines under the first one line up with its text, after the icon
  const indent = s.icon + 8;
  const small = { color: c.foregroundMuted, fontSize: 12, lineHeight: 16 };
  return (
    <View style={{ gap: 6, padding: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon
          name={port.source === "docker" ? "Container" : "Globe"}
          size={s.icon}
          color={c.foregroundMuted}
        />
        <Text style={{ flex: 1, color: c.foreground, fontSize: 14 }} numberOfLines={1}>
          <Text style={{ fontWeight: "600" }}>{port.port}</Text>
          <Text style={{ color: c.foregroundMuted }}> {portName(port)}</Text>
        </Text>
        {busy ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
        {port.public ? <Pill theme={theme} label="Public" warning /> : null}
        <Pill theme={theme} label={scope} warning={scope === "Network"} />
      </View>
      <View style={{ paddingLeft: indent, gap: 2 }}>
        {port.detail ? (
          <Text style={small} numberOfLines={1}>
            {port.detail}
          </Text>
        ) : null}
        {port.private ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ ...small, flexShrink: 1 }} numberOfLines={1} selectable>
              {hostOf(port.url)}
            </Text>
            <TextAction
              theme={theme}
              label={port.private.error ? "Retry cleanup" : "Stop"}
              accessibilityLabel={
                port.private.error
                  ? "Retry cleanup"
                  : port.private.https
                    ? `Stop the tailnet link to port ${port.port}`
                    : `Stop forwarding port ${port.port}`
              }
              disabled={busy}
              onPress={() => actions.stop(port, "private")}
            />
          </View>
        ) : null}
        {willForward || forwards ? (
          <Text style={small}>
            {willForward ? "Opening it forwards it to " : "Forwarded to "}
            {hostOf(port.url)}, which anyone who can reach that address can use.
          </Text>
        ) : null}
        {port.private?.error ? (
          <Text style={{ ...small, color: c.statusDanger }}>{port.private.error}</Text>
        ) : null}
      </View>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingLeft: indent }}
      >
        <Button
          theme={theme}
          compact={compact}
          icon={inApp ? "AppWindow" : "ExternalLink"}
          label="Open"
          disabled={busy}
          onPress={() => actions.open(port, inApp)}
        />
        {inApp ? (
          <IconButton
            theme={theme}
            compact={compact}
            icon="ExternalLink"
            label={`Open port ${port.port} in your browser`}
            disabled={busy}
            onPress={() => actions.open(port, false)}
          />
        ) : null}
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          icon="Copy"
          label="Copy link"
          disabled={busy}
          onPress={() => actions.copy(port, "Link")}
        />
        {!port.public && !publishing ? (
          <Button
            theme={theme}
            compact={compact}
            variant="ghost"
            icon="Globe"
            label="Make public…"
            disabled={busy}
            onPress={() => setPublishing(true)}
          />
        ) : null}
      </View>
      {publishing && !port.public ? (
        <View style={{ paddingLeft: compact ? 0 : indent }}>
          <PublishForm
            theme={theme}
            compact={compact}
            port={port}
            sharing={sharing}
            busy={busy}
            progress={progress}
            cancel={() => setPublishing(false)}
            publish={(provider, access, download) => actions.publish(port, provider, access, download)}
          />
        </View>
      ) : null}
      {port.public ? (
        <View style={{ paddingLeft: compact ? 0 : indent }}>
          <PublicLink
            theme={theme}
            compact={compact}
            port={port}
            busy={busy}
            inApp={inApp}
            actions={actions}
          />
        </View>
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
  compact,
  hostId,
  workspaceId,
  openInApp,
}: {
  theme: PluginTheme;
  /** Phones and narrow windows: touch-sized controls. */
  compact: boolean;
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
            borderRadius: 8,
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
              compact={compact}
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
