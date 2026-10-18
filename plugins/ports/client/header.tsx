import type {
  PluginButton,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { scanRpc, type Port } from "../shared/contracts";
import { portsPanel } from "./location";
import { PortList } from "./ports";

const POLL_MS = 5_000;

/** The dropdown: the same port list as the panel, and a way to the panel. */
function dropdown(client: PluginClientContext): ComponentType<PluginButtonContentProps> {
  return function HeaderPorts({ theme, host, layout, workspaceId, close }) {
    return (
      <View style={{ gap: 12, width: layout.compact ? undefined : 400 }}>
        <PortList
          theme={theme}
          compact={layout.compact}
          hostId={host.id}
          hostLabel={host.label}
          workspaceId={workspaceId}
          webOnly
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            close();
            const { id, location } = portsPanel();
            client.openPanel(id, { workspaceId, location });
          }}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 13 }}>Open the Ports panel</Text>
        </Pressable>
      </View>
    );
  };
}

function label(ports: Port[]): string {
  const count = ports.length === 1 ? `:${ports[0].port}` : `${ports.length} ports`;
  return ports.some((p) => p.public) ? `${count} · public` : count;
}

/**
 * A header button on each workspace with open ports, opening the port list. Polls the host, and
 * only touches a button when its label changes: an update closes the dropdown if it's open.
 */
export function headerButtons(client: PluginClientContext): () => void {
  const Content = dropdown(client);
  const button = (ports: Port[]): PluginButton => ({
    title: "Open ports",
    icon: "EthernetPort",
    label: label(ports),
    behavior: { kind: "popover", Content },
  });
  const buttons = new Map<string, { registration: PluginButtonRegistration; key: string }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(all: Record<string, Port[]>) {
    // only workspaces with web servers get a button, counting only those
    const workspaces: Record<string, Port[]> = {};
    for (const [workspaceId, ports] of Object.entries(all)) {
      const web = ports.filter((port) => port.links);
      if (web.length) workspaces[workspaceId] = web;
    }
    for (const [workspaceId, ports] of Object.entries(workspaces)) {
      const key = label(ports);
      const shown = buttons.get(workspaceId);
      if (shown?.key === key) continue;
      if (shown) {
        shown.registration.update({ label: key });
        shown.key = key;
      } else {
        const registration = client.addHeaderButton({ id: "ports", workspaceId, button: button(ports) });
        buttons.set(workspaceId, { registration, key });
      }
    }
    for (const [workspaceId, { registration }] of buttons) {
      if (workspaces[workspaceId]) continue;
      registration.remove();
      buttons.delete(workspaceId);
    }
  }

  async function poll() {
    try {
      show((await client.rpc(scanRpc, {})).workspaces);
    } catch {
      // host offline or the plugin reloading: keep what's shown until the next answer
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  }
  void poll();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const { registration } of buttons.values()) registration.remove();
    buttons.clear();
  };
}
