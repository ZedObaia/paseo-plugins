import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { Dimensions, Platform } from "react-native";

// Paseo's md breakpoint, where its web and desktop apps start showing the Explorer as a pane
const EXPLORER_PANE_MIN_WIDTH = 720;

/**
 * Which Toolbox panel to open, and where: in the Explorer, beside the chat, where the web and
 * desktop apps show it as a pane at 720 px and wider; elsewhere it's an overlay plugin panels can't
 * open into, so there it's a workspace tab. Each place has its own panel ID: opening a panel that
 * already exists finds it where it was, out of sight if that was the other place.
 */
export function toolboxPanel(): { id: "toolbox" | "toolbox-tab"; location: PluginPanelLocation } {
  const explorer = Platform.OS === "web" && Dimensions.get("window").width >= EXPLORER_PANE_MIN_WIDTH;
  return explorer ? { id: "toolbox", location: "explorer" } : { id: "toolbox-tab", location: "workspace" };
}
