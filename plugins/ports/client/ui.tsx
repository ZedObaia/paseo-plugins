import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";

/**
 * Paseo's control sizes: small on desktop, like its own 28 px buttons, and touch-sized on phones
 * and narrow windows, where its rows and icon buttons grow too.
 */
export const sizes = (compact: boolean) => ({
  control: compact ? 40 : 28,
  icon: compact ? 16 : 14,
  text: compact ? 14 : 13,
});

/** `#rrggbb` at an opacity, for the faint borders Paseo draws in status colors. */
export const faint = (color: string, alpha = "66") => (/^#[0-9a-f]{6}$/i.test(color) ? color + alpha : color);

/**
 * Paseo's button styles: `secondary` (a soft fill) by default, `ghost` (text only) for lesser
 * actions, and `primary` (the accent) for the one main action of a form.
 */
export function Button({
  theme,
  compact,
  label,
  icon,
  onPress,
  variant = "secondary",
  danger,
  disabled,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  icon?: string;
  onPress(): void;
  variant?: "primary" | "secondary" | "ghost";
  danger?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
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
      accessibilityLabel={accessibilityLabel ?? label}
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

export function Checkbox({
  theme,
  compact,
  checked,
  label,
  detail,
  onChange,
  disabled,
}: {
  theme: PluginTheme;
  compact: boolean;
  checked: boolean;
  label: string;
  detail?: string;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  return (
    <Choice
      theme={theme}
      compact={compact}
      role="checkbox"
      selected={checked}
      icon={checked ? "SquareCheck" : "Square"}
      label={label}
      detail={detail}
      disabled={disabled}
      onPress={() => onChange(!checked)}
    />
  );
}

/** One of a few options, one line each with a short note under it. */
export function Options<Value extends string>({
  theme,
  compact,
  value,
  options,
  onChange,
  disabled,
}: {
  theme: PluginTheme;
  compact: boolean;
  value: Value;
  options: readonly { value: Value; label: string; detail: string }[];
  onChange(value: Value): void;
  disabled?: boolean;
}) {
  return (
    <View accessibilityRole="radiogroup" style={{ gap: compact ? 0 : 6 }}>
      {options.map((option) => (
        <Choice
          key={option.value}
          theme={theme}
          compact={compact}
          role="radio"
          selected={option.value === value}
          icon={option.value === value ? "CircleDot" : "Circle"}
          label={option.label}
          detail={option.detail}
          disabled={disabled}
          onPress={() => onChange(option.value)}
        />
      ))}
    </View>
  );
}

function Choice({
  theme,
  compact,
  role,
  selected,
  icon,
  label,
  detail,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  compact: boolean;
  role: "checkbox" | "radio";
  selected: boolean;
  icon: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  onPress(): void;
}) {
  const c = theme.colors;
  const s = sizes(compact);
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={role === "checkbox" ? { checked: selected, disabled } : { selected, disabled }}
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        minHeight: compact ? s.control : undefined,
        paddingVertical: compact ? 6 : 0,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <View style={{ height: 18, justifyContent: "center" }}>
        <Icon name={icon} size={s.icon + 2} color={selected ? c.foreground : c.foregroundMuted} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: c.foreground, fontSize: s.text, lineHeight: 18 }}>{label}</Text>
        {detail ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{detail}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A small action within a line of text; its touch area is bigger than it looks. */
export function TextAction({
  theme,
  label,
  onPress,
  danger,
  disabled,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  danger?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
      style={({ pressed }) => ({ opacity: disabled ? 0.5 : pressed ? 0.6 : 1 })}
    >
      <Text style={{ color: danger ? c.statusDanger : c.foreground, fontSize: 12, lineHeight: 16 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A small label for who can open a port's link. */
export function Pill({ theme, label, warning }: { theme: PluginTheme; label: string; warning?: boolean }) {
  const c = theme.colors;
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: warning ? faint(c.statusWarning) : c.border,
      }}
    >
      <Text style={{ color: warning ? c.statusWarning : c.foregroundMuted, fontSize: 11, lineHeight: 15 }}>
        {label}
      </Text>
    </View>
  );
}
