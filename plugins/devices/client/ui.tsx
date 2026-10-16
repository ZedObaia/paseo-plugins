import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { Device } from "../shared/contracts";
import { stateLabel } from "./data";

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
export function IconButton({
  theme,
  icon,
  label,
  onPress,
  disabled,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
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

/** "iOS 26.5 · on", colored by state; `note` adds who holds it, `warn` colors that as a warning. */
export function StatusLine({
  theme,
  device,
  note,
  warn,
}: {
  theme: PluginTheme;
  device: Device;
  note?: string;
  warn?: boolean;
}) {
  const c = theme.colors;
  const color = device.error
    ? c.statusDanger
    : warn
      ? c.statusWarning
      : device.state === "booted"
        ? c.statusSuccess
        : c.foregroundMuted;
  return (
    <Text style={{ color, fontSize: 12 }} numberOfLines={2}>
      {[device.detail, stateLabel(device), note].filter(Boolean).join(" · ")}
    </Text>
  );
}

/** A device's name and status, with its actions on the right (below, on a narrow phone). */
export function DeviceRow({
  theme,
  device,
  first,
  note,
  warn,
  children,
}: {
  theme: PluginTheme;
  device: Device;
  first: boolean;
  note?: string;
  warn?: boolean;
  children?: ReactNode;
}) {
  const c = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
      }}
    >
      <View style={{ flex: 1, minWidth: 150 }}>
        <Text style={{ color: c.foreground }} numberOfLines={1}>
          {device.name}
        </Text>
        <StatusLine theme={theme} device={device} note={note} warn={warn} />
      </View>
      {children}
    </View>
  );
}

export function Card({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  const c = theme.colors;
  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}
