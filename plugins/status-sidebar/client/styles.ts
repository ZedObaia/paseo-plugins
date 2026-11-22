// Geometry and colors from Paseo's sidebar stylesheets (sidebar-workspace-list.tsx,
// sidebar-workspace-row-content.tsx, sidebar-status-list.tsx, sidebar-section-header.tsx,
// ui/menu/*) with the theme tokens resolved. Touch sizes follow styles/density.ts.

import { createContext, useContext } from "react";
import { StyleSheet } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { paletteFor, type Palette } from "./model";

export interface Ui {
  c: PluginTheme["colors"];
  p: Palette;
  /** Touch sizing: the compact layout or a native app, as in `resolveControlSizing`. */
  touch: boolean;
  /** densityIconBox: md for leading slots and project squares, sm for row glyphs. */
  iconMd: number;
  iconSm: number;
  iconXs: number;
  s: ReturnType<typeof createStyles>;
}

export const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("UiContext is missing");
  return ui;
}

export function createUi(c: PluginTheme["colors"], touch: boolean): Ui {
  const p = paletteFor(c);
  const iconMd = touch ? 20 : 16;
  return {
    c,
    p,
    touch,
    iconMd,
    iconSm: touch ? 18 : 14,
    iconXs: touch ? 14 : 12,
    s: createStyles(c, p, touch, iconMd),
  };
}

function createStyles(c: PluginTheme["colors"], p: Palette, touch: boolean, iconMd: number) {
  const rowHeight = touch ? 44 : 36;
  const centered = { alignItems: "center", justifyContent: "center" } as const;
  const label = { fontSize: 14, fontWeight: "400", minWidth: 0, flexShrink: 1 } as const;
  const meta = { fontSize: 12, lineHeight: 16 } as const;
  return StyleSheet.create({
    fill: { flex: 1 },
    listContent: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 16 },
    blockExpanded: { paddingBottom: 12 },
    hover: { backgroundColor: p.hover },
    selected: { backgroundColor: p.selected },
    pressed: { backgroundColor: c.surface2 },

    header: {
      minHeight: rowHeight,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      paddingLeft: 8,
      paddingRight: 4,
    },
    headerToggle: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, marginLeft: -2 },
    headerTitle: { color: c.foregroundMuted, fontSize: 12, fontWeight: "normal" },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
    displayTrigger: { width: 28, height: 28, borderRadius: 6, ...centered },

    projectRow: {
      position: "relative",
      minHeight: rowHeight,
      paddingVertical: 8,
      paddingHorizontal: 8,
      borderRadius: 8,
      marginBottom: 4,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    rowLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 },
    mutedLabel: { ...label, color: c.foregroundMuted },
    projectActions: { flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0, marginRight: -6 },
    iconAction: { width: 24, height: 24, borderRadius: 6, ...centered },

    leadingSlot: { width: iconMd, height: 20, flexShrink: 0, ...centered },
    iconBox: { position: "relative", width: iconMd, height: iconMd },
    projectIcon: {
      width: iconMd,
      height: iconMd,
      borderRadius: Math.round(iconMd * 0.25),
      ...centered,
    },
    projectIconText: { color: "#ffffff", fontSize: 9 },
    badge: {
      position: "absolute",
      right: -4,
      bottom: -4,
      width: 12,
      height: 12,
      borderRadius: 999,
      overflow: "hidden",
      ...centered,
    },
    ringAnchor: { position: "absolute", right: -5, bottom: -5 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    idleDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: p.extraMuted, opacity: 0.3 },
    dotOverlay: {
      position: "absolute",
      right: 0,
      bottom: 0,
      width: 8,
      height: 8,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: c.surface0,
      backgroundColor: p.dot.failed,
    },

    workspaceRow: {
      minHeight: rowHeight,
      marginBottom: 2,
      paddingVertical: 8,
      paddingLeft: 8,
      paddingRight: 12,
      borderRadius: 8,
      justifyContent: "center",
      gap: 4,
    },
    indented: { paddingLeft: 16 },
    workspaceMain: { flexDirection: "row", alignItems: "flex-start", gap: 8, width: "100%" },
    column: { flex: 1, minWidth: 0 },
    titleRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
    title: {
      color: c.foreground,
      fontSize: 14,
      fontWeight: "400",
      lineHeight: 20,
      opacity: 0.76,
      flex: 1,
      minWidth: 0,
    },
    titleHovered: { opacity: 1 },
    titleWithPill: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
    titleShrink: { flex: 0, flexShrink: 1 },
    mainPill: {
      height: 16,
      paddingHorizontal: 5,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: p.borderAccent,
      justifyContent: "center",
      flexShrink: 0,
    },
    mainPillText: { color: c.foregroundMuted, fontSize: 10, lineHeight: 12 },
    titleEditor: {
      height: 20,
      flex: 1,
      minWidth: 0,
      margin: 0,
      padding: 0,
      borderWidth: 0,
      color: c.foreground,
      fontSize: 14,
      borderRadius: 2,
      outlineStyle: "solid",
      outlineWidth: 1,
      outlineOffset: 2,
      outlineColor: c.accent,
    },
    rowRight: { flexDirection: "row", alignItems: "flex-start", gap: 8, flexShrink: 0 },
    pinMark: { height: 20, justifyContent: "center" },
    trailingSlot: { position: "relative", minHeight: 20, flexShrink: 0, alignItems: "flex-end" },
    trailingReserved: { minWidth: 18 },
    timestamp: { height: 20, lineHeight: 20, color: p.extraMuted, fontSize: 12, flexShrink: 0 },
    diff: { flexDirection: "row", alignItems: "center", height: 20, gap: 4, flexShrink: 0 },
    additions: { fontSize: 12, color: c.statusSuccess },
    deletions: { fontSize: 12, color: c.statusDanger },
    overlay: { position: "absolute", top: 0, right: 0, flexDirection: "row", alignItems: "flex-start" },
    archiveButton: { width: 18, height: 18, marginRight: 8, borderRadius: 4, ...centered },
    kebab: {
      width: touch ? 32 : 18,
      height: touch ? 32 : 18,
      marginTop: touch ? -6 : 0,
      marginRight: touch ? -14 : -7,
      borderRadius: 4,
      ...centered,
    },
    kebabHovered: { backgroundColor: c.surface2 },

    meta: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    metaItem: { flexDirection: "row", alignItems: "center", gap: 3, minWidth: 0, flexShrink: 1 },
    metaText: { ...meta, color: c.foregroundMuted, flexShrink: 1 },
    separator: { ...meta, color: p.extraMuted, flexShrink: 0 },
    hostBadge: { flexDirection: "row", alignItems: "center", gap: 3, minWidth: 12, flexShrink: 100 },
    labels: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0, flexShrink: 1 },
    labelsLeading: { marginLeft: -6 },
    chip: {
      flexShrink: 1,
      minWidth: 0,
      paddingHorizontal: 6,
      borderRadius: 999,
      backgroundColor: `${c.foregroundMuted}1a`,
    },

    groupRow: {
      minHeight: rowHeight,
      paddingVertical: 8,
      paddingHorizontal: 8,
      borderRadius: 8,
      marginBottom: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    plainRow: {
      minHeight: rowHeight,
      marginBottom: 2,
      paddingVertical: 8,
      paddingLeft: 8,
      paddingRight: 12,
      borderRadius: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    iconSlot: { width: iconMd, height: iconMd, flexShrink: 0, ...centered },
    plainText: { ...label, color: c.foregroundMuted },
    plainTextHovered: { ...label, color: c.foreground },

    progress: { gap: 5, marginTop: 4, minWidth: 0 },
    progressText: { ...meta, color: c.foregroundMuted },
    progressTrack: { height: 3, borderRadius: 2, backgroundColor: c.surface2, overflow: "hidden" },
    progressFill: { height: 3, borderRadius: 2, backgroundColor: p.dot.running },
    chatIndent: { paddingLeft: 30 },
    botRow: {
      minHeight: rowHeight,
      marginBottom: 2,
      paddingVertical: 8,
      paddingLeft: 8,
      paddingRight: 12,
      borderRadius: 8,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
    },
    botChevron: { width: 20, height: 20, borderRadius: 4, alignItems: "center", justifyContent: "center" },
    botLeading: { position: "relative", width: 20, height: 20, flexShrink: 0 },
    botName: { color: c.foreground, fontSize: 14, lineHeight: 20, opacity: 0.86, flex: 1, minWidth: 0 },
    bell: {
      height: 28,
      paddingHorizontal: 8,
      borderRadius: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    bellBadge: {
      minWidth: 16,
      height: 16,
      paddingHorizontal: 4,
      borderRadius: 8,
      backgroundColor: c.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    bellBadgeText: { color: c.accentForeground, fontSize: 11, fontWeight: "600", lineHeight: 16 },
    emptyNote: { ...meta, color: p.extraMuted, paddingHorizontal: 8, paddingVertical: 12 },

    // workspace-hover-card.tsx
    hoverCard: {
      backgroundColor: c.surface1,
      borderWidth: 1,
      borderColor: p.borderAccent,
      borderRadius: 8,
      paddingTop: 8,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
    },
    hoverCardTitle: { color: c.foreground, fontSize: 14, paddingHorizontal: 12, paddingBottom: 8 },
    hoverCardRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingBottom: 8,
    },
    hoverCardText: { flex: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 12 },
    hoverCardLabel: { color: c.foregroundMuted, fontSize: 12 },
    hoverCardSeparator: { height: 1, backgroundColor: c.border },
    hoverCardChecks: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      minHeight: 28,
    },
    hoverCardCounts: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flex: 1,
      justifyContent: "flex-end",
    },
    hoverCardCount: { flexDirection: "row", alignItems: "center", gap: 3 },
    hoverCardTasks: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, gap: 6 },
    hoverCardTasksHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
    hoverCardTask: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
    hoverCardTaskIcon: { height: 16, justifyContent: "center" },
    hoverCardTaskText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 16 },
    hoverCardMore: { color: c.foregroundMuted, fontSize: 11, paddingLeft: 18 },

    card: { marginTop: 12, padding: 16, borderWidth: 1, borderColor: c.border, borderRadius: 8, gap: 4 },
    cardTitle: { color: c.foreground, fontSize: 12 },
    cardText: { color: c.foregroundMuted, fontSize: 12 },
    cardActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
    button: {
      minHeight: touch ? 32 : 28,
      paddingHorizontal: 12,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: p.surface3,
      backgroundColor: p.surface3,
      ...centered,
    },
    buttonDanger: { borderColor: c.statusDanger, backgroundColor: c.statusDanger },
    buttonText: { color: c.foreground, fontSize: 12 },

    menuSurface: {
      position: "absolute",
      backgroundColor: c.surface1,
      borderWidth: 1,
      borderColor: p.borderAccent,
      borderRadius: 8,
      overflow: "hidden",
      shadowColor: p.dark ? "rgba(0, 0, 0, 0.20)" : "rgba(0, 0, 0, 0.04)",
      shadowOpacity: 1,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: p.dark ? 8 : 16,
      elevation: 8,
    },
    menuPage: { paddingVertical: 4 },
    menuScroll: { flexGrow: 0, flexShrink: 1 },
    menuSearch: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginHorizontal: 4,
      marginTop: 4,
      paddingHorizontal: 8,
      height: touch ? 40 : 30,
      borderRadius: 6,
      backgroundColor: c.surface2,
    },
    menuSearchInput: {
      flex: 1,
      minWidth: 0,
      height: touch ? 40 : 30,
      padding: 0,
      borderWidth: 0,
      color: c.foreground,
      fontSize: 13,
      outlineWidth: 0,
    },
    menuEmpty: { ...meta, color: c.foregroundMuted, paddingHorizontal: 12, paddingVertical: 8 },
    menuItem: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: touch ? 44 : 28,
      gap: 8,
      marginHorizontal: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderWidth: 1,
      borderColor: "transparent",
      borderRadius: 6,
    },
    menuItemText: { fontSize: 14, lineHeight: 18, color: c.foreground },
    menuLeading: { width: 16, ...centered },
    menuTrailing: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 },
    menuValue: { fontSize: 14, color: c.foregroundMuted, flexShrink: 1 },
    menuIndicator: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent },
    menuSeparator: { height: 1, marginVertical: 4, backgroundColor: p.borderAccent },
    hostDot: { width: 8, height: 8, borderRadius: 4 },
    backdrop: { ...StyleSheet.absoluteFillObject },
    sheetBody: { padding: 0, gap: 0, paddingBottom: 8 },
  });
}
