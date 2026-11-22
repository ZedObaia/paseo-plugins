import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, TextInput, View } from "react-native";

export function Button({
  theme,
  label,
  icon,
  primary,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  primary?: boolean;
  disabled?: boolean;
  onPress(): void;
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
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : c.surface1,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      {icon ? <Icon name={icon} color={color} size={15} /> : null}
      <Text style={{ color, fontSize: 13, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  theme,
  label,
  value,
  onChange,
  placeholder,
  secret,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  secret?: boolean;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.foregroundMuted}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: c.foreground,
          backgroundColor: c.surface1,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 8,
          padding: 11,
          fontSize: 13,
        }}
      />
    </View>
  );
}
