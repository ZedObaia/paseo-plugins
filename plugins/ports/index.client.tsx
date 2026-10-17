import type { PluginClientContext } from "@getpaseo/plugin/client";
import { headerButtons } from "./client/header";
import { portsPanel } from "./client/location";
import { PortsPanel } from "./client/panel";
import { LinkSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  // the same panel twice, so each "+" menu lists it once: see client/location.ts
  client.addWorkspacePanel({
    id: "ports",
    title: "Ports",
    icon: "EthernetPort",
    context: "workspace",
    locations: ["explorer"],
    Component: PortsPanel,
  });
  client.addWorkspacePanel({
    id: "ports-tab",
    title: "Ports",
    icon: "EthernetPort",
    context: "workspace",
    locations: ["workspace"],
    Component: PortsPanel,
  });
  client.addCommandCenterItem({
    id: "show-ports",
    title: "Show open ports",
    icon: "EthernetPort",
    keywords: ["port", "localhost", "dev server", "browser"],
    context: "workspace",
    onSelect({ openPanel }) {
      const { id, location } = portsPanel();
      openPanel(id, { location });
    },
  });
  client.addSettingsScreen({ id: "links", title: "Links", icon: "Link", Component: LinkSettings });
  return headerButtons(client);
}
