import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Platform, Pressable, Text } from "react-native";

export const MONOSPACE = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, Menlo, monospace",
});

/**
 * Paseo's control sizes: small on desktop, like its own 28 px buttons, and touch-sized on phones
 * and narrow windows, where its rows and icon buttons grow too.
 */
export const sizes = (compact: boolean) => ({
  control: compact ? 40 : 28,
  icon: compact ? 16 : 14,
  text: compact ? 14 : 13,
});

/**
 * Paseo's button styles: `secondary` (a soft fill) by default, `ghost` (text only) for lesser
 * actions, and `primary` (the accent) for the one main action.
 */
export function Button({
  theme,
  compact,
  label,
  icon,
  onPress,
  variant = "secondary",
  disabled,
  danger,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  icon?: string;
  onPress(): void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  danger?: boolean;
}) {
  const c = theme.colors;
  const s = sizes(compact);
  const color = danger
    ? c.statusDanger
    : variant === "primary"
      ? c.accentForeground
      : variant === "ghost"
        ? c.foregroundMuted
        : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
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
          variant === "primary" ? c.accent : variant === "secondary" || pressed ? c.surface2 : "transparent",
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
