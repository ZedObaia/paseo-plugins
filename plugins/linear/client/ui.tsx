import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { Scope } from "../shared/contracts";

export const SCOPE_ICON: Record<Scope["kind"], string> = {
  all: "Inbox",
  team: "Users",
  project: "FolderKanban",
  view: "Layers",
};

/**
 * Paseo's control sizes: small on desktop, like its own 28 px buttons, and touch-sized on phones
 * and narrow windows, where its rows and icon buttons grow too.
 */
export const sizes = (compact: boolean) => ({
  control: compact ? 40 : 28,
  icon: compact ? 16 : 14,
  text: compact ? 14 : 13,
});

/** `#rrggbb` at an opacity, for the faint fills Paseo draws in status colors. */
export const faint = (color: string, alpha = "33") => (/^#[0-9a-f]{6}$/i.test(color) ? color + alpha : color);

/**
 * Paseo's button styles: `secondary` (a soft fill) by default, `ghost` (text only) for lesser
 * actions, and `primary` (the accent) for the one main action. `selected` marks a toggle that's on.
 */
export function Button({
  theme,
  compact,
  label,
  icon,
  onPress,
  variant = "secondary",
  selected,
  disabled,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  icon?: string;
  onPress(): void;
  variant?: "primary" | "secondary" | "ghost";
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const c = theme.colors;
  const s = sizes(compact);
  const color =
    variant === "primary"
      ? c.accentForeground
      : variant === "ghost" && !selected
        ? c.foregroundMuted
        : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: s.control,
        maxWidth: "100%",
        paddingHorizontal: variant === "ghost" ? 8 : 10,
        borderRadius: 6,
        backgroundColor:
          variant === "primary"
            ? c.accent
            : variant === "secondary" || selected || pressed
              ? c.surface2
              : "transparent",
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={s.icon} color={color} /> : null}
      <Text style={{ color, fontSize: s.text, flexShrink: 1 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** An icon-only button, labelled for screen readers. */
export function IconButton({
  theme,
  compact,
  icon,
  label,
  onPress,
  disabled,
}: {
  theme: PluginTheme;
  compact: boolean;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  const s = sizes(compact);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: s.control,
        height: s.control,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Icon name={icon} size={s.icon} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

/** A small label, with a dot in Linear's color for it when it has one. */
export function Pill({ theme, label, color }: { theme: PluginTheme; label: string; color?: string }) {
  const c = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: c.border,
      }}
    >
      {color ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} /> : null}
      <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 15 }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Notice({ theme, text, danger }: { theme: PluginTheme; text: string; danger?: boolean }) {
  const c = theme.colors;
  return (
    <Text style={{ color: danger ? c.statusDanger : c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
      {text}
    </Text>
  );
}
