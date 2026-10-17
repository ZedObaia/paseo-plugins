import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";

/** An icon-only button, labelled for screen readers. */
export function IconButton({
  theme,
  icon,
  label,
  onPress,
  disabled,
  color,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
  color?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({
        minWidth: 48,
        minHeight: 48,
        alignItems: "center",
        justifyContent: "center",
        padding: 6,
        borderRadius: 8,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      <Icon name={icon} size={16} color={color ?? theme.colors.foregroundMuted} />
    </Pressable>
  );
}

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
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 48,
        maxWidth: "100%",
        alignSelf: "flex-start",
        gap: 6,
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : c.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={{ color, fontSize: 13, flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

export function Checkbox({
  theme,
  checked,
  label,
  detail,
  onChange,
  disabled,
}: {
  theme: PluginTheme;
  checked: boolean;
  label: string;
  detail?: string;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        minHeight: 48,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon
        name={checked ? "SquareCheck" : "Square"}
        size={18}
        color={checked ? c.accent : c.foregroundMuted}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.foreground, fontSize: 13 }}>{label}</Text>
        {detail ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}
