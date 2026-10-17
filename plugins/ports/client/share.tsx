import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { Access, Port, Provider, Sharing } from "../shared/contracts";
import { errorMessage, hostOf, portName, usePortRpcs } from "./data";
import { Button, Choice } from "./ui";

const defaultAccess = (provider: Provider): Access => (provider === "funnel" ? "password" : "open");

function Section({ theme, title, children }: { theme: PluginTheme; title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
      {children}
    </View>
  );
}

/** Choosing who can open a port: devices on the tailnet, or anyone with the link. */
export function ShareModal({
  theme,
  compact,
  port,
  sharing,
  open,
  onOpenChange,
  changed,
}: {
  theme: PluginTheme;
  compact: boolean;
  port: Port;
  sharing: Sharing;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Refreshes the port list after a change. */
  changed(): void;
}) {
  const c = theme.colors;
  const rpcs = usePortRpcs();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const firstProvider: Provider =
    sharing.funnel.available || !sharing.cloudflare.available ? "funnel" : "cloudflare";
  const [provider, setProvider] = useState<Provider>(firstProvider);
  const [access, setAccess] = useState<Access>(defaultAccess(firstProvider));
  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  const text = { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 };
  const name = portName(port);

  async function perform(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
      changed();
    }
  }
  const copy = (value: string, what: string) =>
    void copyText(value).then(
      () => toast.show(`${what} copied`, { variant: "success" }),
      (error: unknown) => toast.error(errorMessage(error)),
    );

  const privateSection = () => {
    if (sharing.https.available) {
      const at = sharing.tailnetName ? `https://${sharing.tailnetName}` : "its tailnet name";
      return (
        <>
          <Text style={text}>
            Devices on your tailnet open it at {at}, with a real certificate, so phones get service workers,
            the camera and secure cookies. The plugin runs `tailscale serve` for it.
          </Text>
          {port.private?.https ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: c.statusSuccess, fontSize: 13 }}>Shared at {hostOf(port.url)}</Text>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Button theme={theme} icon="Copy" label="Copy link" onPress={() => copy(port.url, "Link")} />
                <Button
                  theme={theme}
                  icon="Square"
                  label="Stop sharing"
                  danger
                  disabled={busy}
                  onPress={() =>
                    void perform(() => rpcs.unshare({ port: port.port, level: "private" }).then(() => {}))
                  }
                />
              </View>
            </View>
          ) : (
            <Button
              theme={theme}
              icon="Lock"
              label="Share privately"
              primary
              disabled={busy}
              onPress={() => void perform(() => rpcs.sharePrivate({ port: port.port }).then(() => {}))}
            />
          )}
        </>
      );
    }
    return (
      <>
        <Text style={text}>
          HTTPS isn't available: {sharing.https.reason} Devices on your tailnet open it over HTTP at{" "}
          {hostOf(port.url)}
          {port.needsForward || port.private ? ", forwarded because it only listens on loopback." : "."}
        </Text>
        {port.needsForward ? (
          <Button
            theme={theme}
            icon="Cable"
            label="Forward it"
            disabled={busy}
            onPress={() => void perform(() => rpcs.sharePrivate({ port: port.port }).then(() => {}))}
          />
        ) : port.private ? (
          <Button
            theme={theme}
            icon="Unplug"
            label="Stop forwarding"
            danger
            disabled={busy}
            onPress={() =>
              void perform(() => rpcs.unshare({ port: port.port, level: "private" }).then(() => {}))
            }
          />
        ) : null}
      </>
    );
  };

  const shared = port.public;
  const publicSection = () => {
    if (shared)
      return (
        <View style={{ gap: 8 }}>
          <Text style={{ color: c.statusWarning, fontSize: 13, fontWeight: "600" }}>
            Public at {hostOf(shared.url)}
          </Text>
          <Text style={text}>
            {shared.access === "password"
              ? `Anyone with the link and the password ${shared.password} (any user name) can open it.`
              : "Anyone with the link can open it."}{" "}
            Through {shared.provider === "funnel" ? "Tailscale Funnel" : "a Cloudflare quick tunnel"}.
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button theme={theme} icon="Copy" label="Copy link" onPress={() => copy(shared.url, "Link")} />
            {shared.password ? (
              <Button
                theme={theme}
                icon="KeyRound"
                label="Copy password"
                onPress={() => copy(shared.password!, "Password")}
              />
            ) : null}
            <Button
              theme={theme}
              icon="Square"
              label="Stop sharing"
              danger
              disabled={busy}
              onPress={() =>
                void perform(() => rpcs.unshare({ port: port.port, level: "public" }).then(() => {}))
              }
            />
          </View>
        </View>
      );
    if (confirming)
      return (
        <View style={{ gap: 10 }}>
          <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>
            Anyone on the internet who has the link
            {access === "password" ? " and the password" : ""} will be able to open {name} on port {port.port}
            , and everything it serves. It stays public until you stop sharing it, the server stops, or the
            plugin stops.
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setConfirming(false)} />
            <Button
              theme={theme}
              icon="Globe"
              label={busy ? "Making it public…" : "Make it public"}
              primary
              disabled={busy}
              onPress={() =>
                void perform(async () => {
                  const { url } = await rpcs.sharePublic({ port: port.port, provider, access });
                  toast.show(`Port ${port.port} is public at ${hostOf(url)}`, { variant: "success" });
                  setConfirming(false);
                })
              }
            />
          </View>
        </View>
      );
    const options = sharing[provider];
    return (
      <>
        <Choice<Provider>
          theme={theme}
          compact={compact}
          label="Through"
          value={provider}
          onChange={(next) => {
            setProvider(next);
            setAccess(defaultAccess(next));
          }}
          options={[
            {
              value: "funnel",
              label: "Tailscale Funnel",
              detail: sharing.funnel.available
                ? "A stable address on this machine's tailnet name."
                : (sharing.funnel.reason ?? "Not available."),
              disabled: !sharing.funnel.available,
            },
            {
              value: "cloudflare",
              label: "Cloudflare quick tunnel",
              detail: sharing.cloudflare.available
                ? "A random trycloudflare.com address, new each time. No account needed."
                : (sharing.cloudflare.reason ?? "Not available."),
              disabled: !sharing.cloudflare.available,
            },
          ]}
        />
        <Choice<Access>
          theme={theme}
          compact={compact}
          label="Who can open it"
          value={access}
          onChange={setAccess}
          options={[
            {
              value: "password",
              label: "Anyone with the password",
              detail: "For people, such as clients: the browser asks for it once.",
            },
            {
              value: "open",
              label: "Anyone with the link",
              detail: "For webhooks and other services that can't log in.",
            },
          ]}
        />
        <Text style={text}>
          {provider === "funnel"
            ? "Funnel addresses don't change, and names under ts.net are published in certificate transparency logs, where scanners find them. Keep the password unless something that can't log in, like a webhook, needs the port."
            : "The address is random, so it's hard to guess, but anyone who has it can open the port unless it needs a password."}
        </Text>
        <Button
          theme={theme}
          icon="Globe"
          label="Make public…"
          primary
          disabled={busy || !options.available}
          onPress={() => setConfirming(true)}
        />
      </>
    );
  };

  return (
    <Modal title={`Share port ${port.port}`} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Section theme={theme} title="Private: only my devices">
          {privateSection()}
        </Section>
        <View style={{ height: 1, backgroundColor: c.border }} />
        <Section theme={theme} title="Public: anyone with the link">
          {publicSection()}
        </Section>
      </Modal.Content>
    </Modal>
  );
}
