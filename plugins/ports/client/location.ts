import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import { Dimensions, Platform } from "react-native";

// Paseo's md breakpoint, where its web and desktop apps start showing the Explorer as a pane
const EXPLORER_PANE_MIN_WIDTH = 720;

/**
 * Where "Show ports" opens the panel: in the Explorer where Paseo shows it as a side pane, and as
 * a workspace tab elsewhere. On phones and narrow windows the Explorer is an overlay that plugin
 * panels can't open into, so opening one there shows nothing.
 */
export const panelLocation = (): PluginPanelLocation =>
  Platform.OS === "web" && Dimensions.get("window").width >= EXPLORER_PANE_MIN_WIDTH
    ? "explorer"
    : "workspace";
