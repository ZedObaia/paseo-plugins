import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

export function Button({
  theme,
  label,
  icon,
  onPress,
  primary,
  danger,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  onPress(): void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const c = theme.colors;
  const color = primary ? c.accentForeground : danger ? c.statusDanger : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : c.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={{ color, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** An icon-only toolbar button, labelled for screen readers. */
export function IconButton({ theme, icon, label, onPress, disabled }: { theme: PluginTheme; icon: string; label: string; onPress(): void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ padding: 6, borderRadius: 8, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Icon name={icon} size={18} color={theme.colors.foreground} />
    </Pressable>
  );
}

export function Pill({ theme, label, tone }: { theme: PluginTheme; label: string; tone?: "success" | "warning" | "danger" | "muted" }) {
  const c = theme.colors;
  const color = tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "danger" ? c.statusDanger : c.foregroundMuted;
  return <Text style={{ color, fontSize: 12 }}>{label}</Text>;
}

export function Card({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  const c = theme.colors;
  return (
    <View style={{ borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>{children}</View>
  );
}
