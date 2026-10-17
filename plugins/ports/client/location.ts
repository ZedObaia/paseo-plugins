import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { Dimensions, Platform } from "react-native";

// Paseo's md breakpoint, where its web and desktop apps start showing the Explorer as a pane
const EXPLORER_PANE_MIN_WIDTH = 720;

/**
 * Which Ports panel "Show ports" opens, and where. Paseo shows the Explorer as a side pane only in
 * its web and desktop apps at 720 px and wider; on phones and narrow windows it's an overlay that
 * plugin panels can't open into. There the panel opens as a workspace tab instead, under its own
 * ID: opening a tab that already exists finds it where it was, and a Ports tab once opened into
 * the Explorer would be found there, out of sight.
 */
export function portsPanel(): { id: "ports" | "ports-tab"; location: PluginPanelLocation } {
  const explorer = Platform.OS === "web" && Dimensions.get("window").width >= EXPLORER_PANE_MIN_WIDTH;
  return explorer ? { id: "ports", location: "explorer" } : { id: "ports-tab", location: "workspace" };
}
