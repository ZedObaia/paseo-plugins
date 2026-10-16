import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { Job } from "./data";

export function Button({
  theme,
  label,
  icon,
  onPress,
  primary,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
}) {
  const c = theme.colors;
  const color = primary ? c.accentForeground : c.foreground;
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

export function Check({
  theme,
  label,
  checked,
  onToggle,
}: {
  theme: PluginTheme;
  label: string;
  checked: boolean;
  onToggle(): void;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onToggle}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
    >
      <Icon
        name={checked ? "SquareCheck" : "Square"}
        size={18}
        color={checked ? c.accent : c.foregroundMuted}
      />
      <Text style={{ color: c.foreground }}>{label}</Text>
    </Pressable>
  );
}

/** A host's progress on one project: "Cloning…", "Added", or why it failed. */
export function JobLine({ theme, label, job }: { theme: PluginTheme; label: string; job: Job }) {
  const c = theme.colors;
  const color =
    job.state === "failed" ? c.statusDanger : job.state === "done" ? c.statusSuccess : c.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {job.state === "working" ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
      <Text style={{ color, fontSize: 12, flexShrink: 1 }}>
        {label}: {job.text}
      </Text>
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
