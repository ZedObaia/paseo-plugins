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
      hitSlop={6}
      style={({ pressed }) => ({ padding: 6, borderRadius: 8, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
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
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
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
      <Text style={{ color, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export interface ChoiceOption<Value extends string> {
  value: Value;
  label: string;
  /** A line under the label: what it means, or why it's unavailable. */
  detail: string;
  disabled?: boolean;
}

/** Options side by side (stacked on a phone); the selected one is outlined. */
export function Choice<Value extends string>({
  theme,
  compact,
  label,
  options,
  value,
  onChange,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  options: readonly ChoiceOption<Value>[];
  value: Value;
  onChange(value: Value): void;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled: !!option.disabled }}
              accessibilityLabel={`${option.label}. ${option.detail}`}
              disabled={option.disabled}
              onPress={() => onChange(option.value)}
              style={({ pressed }) => ({
                flex: compact ? undefined : 1,
                gap: 2,
                padding: 10,
                borderRadius: 8,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? c.accent : c.border,
                backgroundColor: c.surface1,
                opacity: option.disabled ? 0.55 : pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{option.label}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{option.detail}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
