import {
  openExternalUrl,
  type PluginButton,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { forwardRpc, scanRpc, type Port } from "../shared/contracts";
import { portName, portUrl } from "./data";
import { portsPanel } from "./location";

const POLL_MS = 5_000;

function button(client: PluginClientContext, workspaceId: string, ports: Port[]): PluginButton {
  return {
    title: "Open ports",
    icon: "EthernetPort",
    label: ports.length === 1 ? `:${ports[0].port}` : `${ports.length} ports`,
    behavior: {
      kind: "menu",
      items: [
        ...ports.map((port) => ({
          kind: "item" as const,
          id: `port-${port.port}`,
          title: `${port.port} · ${portName(port)}${port.public ? " · public" : ""}`,
          icon: port.source === "docker" ? "Container" : "Globe",
          behavior: {
            kind: "action" as const,
            async onPress() {
              await openExternalUrl(await portUrl(port, (input) => client.rpc(forwardRpc, input)));
            },
          },
        })),
        { kind: "separator", id: "panel-divider" },
        {
          kind: "item",
          id: "show-panel",
          title: "Show ports",
          icon: "PanelRight",
          behavior: {
            kind: "action",
            onPress() {
              const { id, location } = portsPanel();
              client.openPanel(id, { workspaceId, location });
            },
          },
        },
      ],
    },
  };
}

/**
 * A header button on each workspace with open ports, listing them. Polls the host, and only
 * touches a button when its ports change: an update closes the menu if it's open.
 */
export function headerButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, { registration: PluginButtonRegistration; key: string }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(workspaces: Record<string, Port[]>) {
    for (const [workspaceId, ports] of Object.entries(workspaces)) {
      const key = JSON.stringify(
        ports.map((p) => [p.port, portName(p), p.source, p.url, p.needsForward, p.public?.url]),
      );
      const shown = buttons.get(workspaceId);
      if (shown?.key === key) continue;
      const next = button(client, workspaceId, ports);
      if (shown) {
        shown.registration.update(next);
        shown.key = key;
      } else {
        const registration = client.addHeaderButton({ id: "ports", workspaceId, button: next });
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
