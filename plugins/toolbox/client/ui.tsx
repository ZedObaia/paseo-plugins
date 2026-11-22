import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  Switch,
  Text,
  View,
  type DimensionValue,
} from "react-native";

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
export const faint = (color: string, alpha = "1f") => (/^#[0-9a-f]{6}$/i.test(color) ? color + alpha : color);

/**
 * Paseo's button styles: `secondary` (a soft fill) by default, `ghost` (text only) for lesser
 * actions, `primary` (the accent) for the one main action, `warning` for a sign-in, and `danger`
 * for confirming a removal.
 */
export function Button({
  theme,
  compact,
  label,
  icon,
  onPress,
  variant = "secondary",
  disabled,
  accessibilityLabel = label,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  icon?: string;
  onPress(): void;
  variant?: "primary" | "secondary" | "ghost" | "warning" | "danger";
  disabled?: boolean;
  // when the label alone doesn't say what it acts on
  accessibilityLabel?: string;
}) {
  const c = theme.colors;
  const s = sizes(compact);
  const color =
    variant === "primary"
      ? c.accentForeground
      : variant === "ghost"
        ? c.foregroundMuted
        : variant === "warning"
          ? c.statusWarning
          : variant === "danger"
            ? c.statusDanger
            : c.foreground;
  const background =
    variant === "primary"
      ? c.accent
      : variant === "warning"
        ? faint(c.statusWarning)
        : variant === "danger"
          ? faint(c.statusDanger)
          : c.surface2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: s.control,
        paddingHorizontal: variant === "ghost" ? 8 : 10,
        borderRadius: 6,
        backgroundColor: variant === "ghost" ? (pressed ? c.surface2 : "transparent") : background,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={s.icon} color={color} /> : null}
      <Text
        style={{ color, fontSize: s.text, fontWeight: variant === "primary" ? "600" : "400" }}
        numberOfLines={1}
      >
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

export type Tone = "muted" | "warning" | "danger";

/** A switch, ringed while its change waits for Apply. */
export function Toggle({
  theme,
  label,
  on,
  changed,
  onToggle,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  on: boolean;
  changed: boolean;
  onToggle(): void;
  disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <View
      style={{
        borderRadius: 12,
        padding: 2,
        borderWidth: 1.5,
        borderColor: changed ? faint(c.statusSuccess, "99") : "transparent",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Switch
        accessibilityLabel={`${label} ${on ? "on" : "off"}`}
        value={on}
        disabled={disabled}
        onValueChange={onToggle}
        trackColor={{ false: c.border, true: c.accent }}
        thumbColor="#ffffff"
        {...({ activeThumbColor: "#ffffff" } as object)}
      />
    </View>
  );
}

/** The square icon in front of each skill, connector and plugin. */
export function Tile({
  theme,
  icon,
  size = 28,
  dim,
}: {
  theme: PluginTheme;
  icon: string;
  size?: number;
  dim?: boolean;
}) {
  const c = theme.colors;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.surface2,
        borderWidth: 1,
        borderColor: c.border,
        opacity: dim ? 0.5 : 1,
      }}
    >
      <Icon name={icon} size={Math.round(size / 2)} color={c.foregroundMuted} />
    </View>
  );
}

/**
 * One skill, connector or plugin: its icon, name and one line about it, actions, and its switch.
 * Pressing its name opens its details; `children` go under the row (a sign-in in progress).
 */
export function Row({
  theme,
  compact,
  icon,
  title,
  meta,
  tone = "muted",
  on,
  changed,
  onToggle,
  onOpen,
  actions,
  children,
  first,
  inset,
  disabled,
}: {
  theme: PluginTheme;
  compact: boolean;
  icon: string;
  title: string;
  meta: string;
  tone?: Tone;
  on: boolean;
  changed: boolean;
  onToggle(): void;
  // the switch can't change here; its details say why
  disabled?: boolean;
  onOpen?(): void;
  actions?: ReactNode;
  children?: ReactNode;
  first: boolean;
  // one of a set's skills, under the set's row
  inset?: boolean;
}) {
  const c = theme.colors;
  const metaColor =
    tone === "warning" ? c.statusWarning : tone === "danger" ? c.statusDanger : c.foregroundMuted;
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: c.border, marginLeft: inset ? 36 : 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}: details`}
          disabled={!onOpen}
          onPress={onOpen}
          style={({ pressed }) => ({
            flex: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: compact ? 12 : 10,
            paddingLeft: 12,
            backgroundColor: pressed ? c.surface2 : "transparent",
          })}
        >
          <Tile theme={theme} icon={icon} dim={!on} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{ color: c.foreground, fontSize: 14, fontWeight: "500", opacity: on ? 1 : 0.6 }}
              numberOfLines={1}
            >
              {title}
            </Text>
            {meta ? (
              <Text style={{ color: metaColor, fontSize: 12 }} numberOfLines={1}>
                {meta}
              </Text>
            ) : null}
          </View>
          {onOpen ? <Icon name="ChevronRight" size={14} color={c.foregroundMuted} /> : null}
        </Pressable>
        {actions}
        <Toggle
          theme={theme}
          label={title}
          on={on}
          changed={changed}
          onToggle={onToggle}
          disabled={disabled}
        />
      </View>
      {children}
    </View>
  );
}

/**
 * A set of skills installed together: its name, how many, where from, and a switch for all of
 * them. Pressing it shows or hides its skills.
 */
export function SetRow({
  theme,
  compact,
  title,
  meta,
  open,
  on,
  changed,
  onToggle,
  onPress,
  first,
}: {
  theme: PluginTheme;
  compact: boolean;
  title: string;
  meta: string;
  open: boolean;
  on: boolean;
  changed: boolean;
  onToggle(): void;
  onPress(): void;
  first: boolean;
}) {
  const c = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingRight: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}: ${open ? "hide" : "show"} its skills`}
        onPress={onPress}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: compact ? 12 : 10,
          paddingLeft: 12,
          backgroundColor: pressed ? c.surface2 : "transparent",
        })}
      >
        <Tile theme={theme} icon="Layers" dim={!on} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "500" }} numberOfLines={1}>
            {title}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
      </Pressable>
      <Toggle theme={theme} label={title} on={on} changed={changed} onToggle={onToggle} />
    </View>
  );
}

/** Allow, Ask or Block for a tool: small enough to sit beside each tool's name. */
export function Choice<T extends string>({
  theme,
  value,
  options,
  onChange,
  disabled,
}: {
  theme: PluginTheme;
  value: T;
  options: { value: T; label: string; tone?: Tone }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        flexDirection: "row",
        padding: 2,
        gap: 2,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((o) => {
        const selected = o.value === value;
        const color =
          selected && o.tone === "danger"
            ? c.statusDanger
            : selected && o.tone === "warning"
              ? c.statusWarning
              : selected
                ? c.foreground
                : c.foregroundMuted;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={{
              paddingHorizontal: 8,
              minHeight: 24,
              justifyContent: "center",
              borderRadius: 5,
              backgroundColor: selected ? c.surface2 : "transparent",
            }}
          >
            <Text style={{ color, fontSize: 12, fontWeight: selected ? "600" : "400" }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Content still loading: its shapes pulse, unless the system asks for less motion, and screen
 * readers hear `label`.
 */
export function Pulse({ label, children }: { label: string; children: ReactNode }) {
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    let pulse: Animated.CompositeAnimation | undefined;
    let stopped = false;
    const to = (toValue: number) =>
      Animated.timing(opacity, { toValue, duration: 700, useNativeDriver: Platform.OS !== "web" });
    // asked before each pulse, so turning reduce motion on stops it within one. Not a
    // reduceMotionChanged listener: react-native-web files those by their source text, so every
    // Pulse's would be one and the same
    const next = () =>
      void AccessibilityInfo.isReduceMotionEnabled()
        .catch(() => false)
        .then((reduce) => {
          if (stopped || reduce) return;
          pulse = Animated.sequence([to(0.45), to(1)]);
          pulse.start(({ finished }) => {
            if (finished) next();
          });
        });
    next();
    return () => {
      stopped = true;
      pulse?.stop();
    };
  }, [opacity]);
  return (
    <Animated.View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={{ opacity }}>
      {children}
    </Animated.View>
  );
}

/** One placeholder shape inside a `Pulse`. */
export function Bone({
  theme,
  width,
  height,
  radius = 4,
}: {
  theme: PluginTheme;
  width: DimensionValue;
  height: number;
  radius?: number;
}) {
  return <View style={{ width, height, borderRadius: radius, backgroundColor: theme.colors.surface2 }} />;
}

// uneven lines read as text, not a grid
const ROW_WIDTHS = [
  ["55%", "75%"],
  ["40%", "62%"],
  ["48%", "68%"],
] as const;

/** Rows shaped like `Row`, for a section the agent hasn't listed yet. */
export function SkeletonRows({
  theme,
  compact,
  label,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
}) {
  return (
    <Pulse label={label}>
      {ROW_WIDTHS.map(([title, meta], n) => (
        <View
          key={n}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingRight: 12,
            borderTopWidth: n ? 1 : 0,
            borderTopColor: theme.colors.border,
          }}
        >
          {/* padded like Row's icon and text, which set its height; the switch sits beside them */}
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingVertical: compact ? 12 : 10,
              paddingLeft: 12,
            }}
          >
            <Bone theme={theme} width={28} height={28} radius={7} />
            {/* as tall as Row's title and meta lines */}
            <View style={{ flex: 1, gap: 9 }}>
              <Bone theme={theme} width={title} height={12} />
              <Bone theme={theme} width={meta} height={10} />
            </View>
          </View>
          <Bone theme={theme} width={44} height={24} radius={12} />
        </View>
      ))}
    </Pulse>
  );
}

/** A label over some of a Section's rows, inside its card. */
export function GroupLabel({ theme, title, first }: { theme: PluginTheme; title: string; first: boolean }) {
  const c = theme.colors;
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: c.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 2,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
      }}
    >
      {title.toUpperCase()}
    </Text>
  );
}

/** A titled group of rows in one card, with an action beside the title. */
export function Section({
  theme,
  title,
  count,
  action,
  children,
}: {
  theme: PluginTheme;
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 24, marginHorizontal: 2 }}>
        <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
          {title.toUpperCase()}
          {count !== undefined ? <Text style={{ fontWeight: "400" }}>{`  ${count}`}</Text> : null}
        </Text>
        {action}
      </View>
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
    </View>
  );
}

/** A row of mutually exclusive choices, like Paseo's segmented controls. */
export function Segments<T extends string>({
  theme,
  compact,
  value,
  options,
  onChange,
}: {
  theme: PluginTheme;
  compact: boolean;
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange(value: T): void;
}) {
  const c = theme.colors;
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        padding: 3,
        gap: 2,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
      }}
    >
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: o.value === value }}
          onPress={() => onChange(o.value)}
          style={{
            flex: 1,
            minHeight: compact ? 34 : 26,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            backgroundColor: o.value === value ? c.surface2 : "transparent",
          }}
        >
          <Text
            style={{
              color: o.value === value ? c.foreground : c.foregroundMuted,
              fontSize: 13,
              fontWeight: "500",
            }}
            numberOfLines={1}
          >
            {o.label}
            {o.count !== undefined ? (
              <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` ${o.count}`}</Text>
            ) : null}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
