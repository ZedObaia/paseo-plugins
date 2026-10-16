import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { useDevices } from "./client/data";
import { DevicePanel } from "./client/panel";
import { DevicesScreen } from "./client/screen";

function DevicesItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const on = useDevices().data?.devices.filter((d) => d.state !== "shutdown").length ?? 0;
  return (
    <SidebarRow
      icon="Smartphone"
      active={currentScreen?.screenId === "devices"}
      onPress={() => openScreen({ screenId: "devices" })}
      trailing={on ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{on} on</Text> : undefined}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "device",
    title: "Device",
    icon: "Smartphone",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: DevicePanel,
  });
  client.addCommandCenterItem({
    id: "open-device",
    title: "Open device",
    icon: "Smartphone",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("device");
    },
  });
  client.addScreen({ id: "devices", title: "Devices", Component: DevicesScreen });
  client.addSidebarHeaderItem({ id: "devices", title: "Devices", Component: DevicesItem });
  return () => {};
}
