import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { Dimensions, Platform } from "react-native";

// Paseo's md breakpoint, where its web and desktop apps start showing the Explorer as a pane
const EXPLORER_PANE_MIN_WIDTH = 720;

/**
 * Which Device panel "Open device" opens, and where: in the Explorer, beside the agent, where a
 * phone's tall screen fits. Paseo shows the Explorer as a side pane only in its web and desktop
 * apps at 720 px and wider; on phones and narrow windows it's an overlay that plugin panels can't
 * open into, so there it's a workspace tab. Each place has its own panel ID: opening a panel that
 * already exists finds it where it was, and one opened into the Explorer would be found there, out
 * of sight. The tab keeps the ID "device" it always had, so tabs people already have still open.
 */
export function devicePanel(): { id: "device" | "device-explorer"; location: PluginPanelLocation } {
  const explorer = Platform.OS === "web" && Dimensions.get("window").width >= EXPLORER_PANE_MIN_WIDTH;
  return explorer ? { id: "device-explorer", location: "explorer" } : { id: "device", location: "workspace" };
}
