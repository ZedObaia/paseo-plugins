import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { screenshotAttachments } from "./shared/contracts";
import { registerBridge } from "./client/bridge";
import { isOn, useDevices } from "./client/data";
import { headerButtons } from "./client/header";
import { devicePanel } from "./client/location";
import { DevicePanel } from "./client/panel";
import { composerPills } from "./client/pills";
import { DevicesScreen } from "./client/screen";
import { AgentSettings } from "./client/settings";
import { deviceTimeline } from "./client/timeline";

function DevicesItem({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const on = useDevices(host.id).data?.devices.filter(isOn).length ?? 0;
  return (
    <SidebarRow
      icon="Smartphone"
      active={currentScreen?.screenId === "devices"}
      onPress={() => openScreen({ screenId: "devices" })}
      trailing={
        on ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{on} on</Text> : undefined
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  // the same panel twice, so each "+" menu lists it once: see client/location.ts
  client.addWorkspacePanel({
    id: "device-explorer",
    title: "Device",
    icon: "Smartphone",
    context: "workspace",
    locations: ["explorer"],
    Component: DevicePanel,
  });
  client.addWorkspacePanel({
    id: "device",
    title: "Device",
    icon: "Smartphone",
    context: "workspace",
    locations: ["workspace"],
    Component: DevicePanel,
  });
  client.addCommandCenterItem({
    id: "open-device",
    title: "Open device",
    icon: "Smartphone",
    context: "workspace",
    onSelect({ openPanel }) {
      const { id, location } = devicePanel();
      openPanel(id, { location });
    },
  });
  client.addScreen({ id: "devices", title: "Devices", Component: DevicesScreen });
  client.addSettingsScreen({ id: "agents", title: "Agent tools", icon: "Bot", Component: AgentSettings });
  client.addSidebarHeaderItem({ id: "devices", title: "Devices", Component: DevicesItem });
  // the "+" menu's Device screen: a running device's screen as a file agents on the host can open
  const removeAttachments = client.addAttachmentSource(screenshotAttachments);
  const removeTimeline = deviceTimeline(client);
  const removePills = composerPills(client);
  const removeHeaders = headerButtons(client);
  const removeBridge = registerBridge(client);
  return () => {
    removeBridge();
    void removeAttachments();
    removeTimeline();
    removePills();
    removeHeaders();
  };
}
