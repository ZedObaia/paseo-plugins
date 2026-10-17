import type { PluginClientContext } from "@getpaseo/plugin/client";
import { headerButtons } from "./client/header";
import { panelLocation } from "./client/location";
import { PortsPanel } from "./client/panel";
import { LinkSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "ports",
    title: "Ports",
    icon: "EthernetPort",
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: PortsPanel,
  });
  client.addCommandCenterItem({
    id: "show-ports",
    title: "Show open ports",
    icon: "EthernetPort",
    keywords: ["port", "localhost", "dev server", "browser"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("ports", { location: panelLocation() });
    },
  });
  client.addSettingsScreen({ id: "links", title: "Links", icon: "Link", Component: LinkSettings });
  return headerButtons(client);
}
