import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

type Colors = PluginTheme["colors"];

/** Fill color for a usage ratio: calm until 75%, warning to 90%, then danger. */
const level = (c: Colors, value: number) =>
  value >= 0.9 ? c.statusDanger : value >= 0.75 ? c.statusWarning : c.accent;

export function Meter({ theme, value }: { theme: PluginTheme; value: number }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View
        style={{
          height: 6,
          width: `${Math.round(value * 100)}%`,
          backgroundColor: level(theme.colors, value),
        }}
      />
    </View>
  );
}

const BAR = 2; // px per sparkline bar, plus 1 px between bars

/**
 * Values in 0..1, oldest first, as bars colored like the meters (plugins can't draw SVG). The
 * chart measures itself and averages neighbouring samples when they don't fit, so it reads the
 * same on a phone as on a wide window.
 */
export function Sparkline({
  theme,
  values,
  label,
  height = 28,
}: {
  theme: PluginTheme;
  values: number[];
  label: string;
  height?: number;
}) {
  const [width, setWidth] = useState(0);
  const slots = Math.max(1, Math.floor(width / (BAR + 1)));
  const group = Math.max(1, Math.ceil(values.length / slots));
  const bars: number[] = [];
  for (let i = 0; i < values.length; i += group) {
    const chunk = values.slice(i, i + group);
    bars.push(chunk.reduce((sum, v) => sum + v, 0) / chunk.length);
  }
  return (
    <View
      accessible
      accessibilityLabel={label}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        height,
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        overflow: "hidden",
      }}
    >
      {width
        ? bars.map((v, i) => (
            <View
              key={i}
              style={{
                width: BAR,
                marginLeft: 1,
                height: Math.max(1, Math.round(Math.min(1, v) * height)),
                backgroundColor: level(theme.colors, v),
              }}
            />
          ))
        : null}
    </View>
  );
}

export function Section({
  theme,
  title,
  trailing,
  children,
}: {
  theme: PluginTheme;
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}
        >
          {title}
        </Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

/** A card that shares a row with others and wraps below 160 px. */
export function Card({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  const c = theme.colors;
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 160,
        padding: 12,
        gap: 6,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
      }}
    >
      {children}
    </View>
  );
}

export function Button({
  theme,
  label,
  icon,
  onPress,
  danger,
  primary,
  selected,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  onPress(): void;
  danger?: boolean;
  primary?: boolean;
  // a toggle that is on; drawn like primary
  selected?: boolean;
  disabled?: boolean;
}) {
  const c = theme.colors;
  const filled = primary || selected;
  const color = filled ? c.accentForeground : danger ? c.statusDanger : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
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
        borderColor: filled ? c.accent : c.border,
        backgroundColor: filled ? c.accent : c.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={{ color, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** An icon-only button, e.g. a row's ⋯ menu. */
export function IconButton({
  theme,
  icon,
  label,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        padding: 6,
        borderRadius: 8,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

/**
 * Stops with one button, but on a second tap within 3 s ("Stop?"), so scrolling a list on a phone
 * can't stop a container by accident.
 */
export function StopButton({ theme, label, onStop }: { theme: PluginTheme; label: string; onStop(): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3_000);
    return () => clearTimeout(timer);
  }, [armed]);
  const c = theme.colors;
  const color = armed ? c.statusDanger : c.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={armed ? `Confirm: stop ${label}` : `Stop ${label}`}
      hitSlop={6}
      onPress={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onStop();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        padding: 6,
        borderRadius: 8,
        backgroundColor: pressed ? c.surface2 : "transparent",
      })}
    >
      <Icon name="CircleStop" size={16} color={color} />
      {armed ? <Text style={{ color, fontSize: 12 }}>Stop?</Text> : null}
    </Pressable>
  );
}

/** One horizontal bar split into labelled parts, with a legend below. */
export function StackedBar({
  theme,
  parts,
}: {
  theme: PluginTheme;
  parts: { label: string; value: number; color: string; detail: string }[];
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0) || 1;
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          height: 10,
          borderRadius: 5,
          overflow: "hidden",
          flexDirection: "row",
          backgroundColor: theme.colors.surface2,
        }}
      >
        {parts.map((p) => (
          <View key={p.label} style={{ width: `${(p.value / total) * 100}%`, backgroundColor: p.color }} />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 4 }}>
        {parts.map((p) => (
          <View key={p.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: p.color }} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {p.label} <Text style={{ color: theme.colors.foreground }}>{p.detail}</Text>
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Cache keys start with the host: the app shares one query cache between its plugins and hosts, so
 * an unscoped key would show one host's numbers on another.
 */
export const queryKey = (hostId: string, ...rest: string[]) => ["resources", hostId, ...rest];

/** Runs an action, reports its result or error in a toast and refreshes that host's data. Resolves to success. */
export function useRunAction(hostId: string) {
  const toast = useToast();
  const queryClient = useQueryClient();
  return async (work: () => Promise<{ message: string }>): Promise<boolean> => {
    try {
      toast.show((await work()).message, { variant: "success" });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      await queryClient.invalidateQueries({ queryKey: queryKey(hostId) });
    }
  };
}

type Action = { label: string; danger?: boolean } & (
  | { run(): Promise<{ message: string }> }
  | { next: Confirmation }
);

export interface Confirmation {
  title: string;
  message: string;
  actions: Action[];
}

/** A dialog offering one or more actions. An action with `next` opens a second confirmation. */
export function useConfirm(
  theme: PluginTheme,
  hostId: string,
): { ask(c: Confirmation): void; dialog: ReactNode } {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const runAction = useRunAction(hostId);
  const c = theme.colors;

  async function perform(action: Action) {
    if ("next" in action) return setPending(action.next);
    setBusy(true);
    const ok = await runAction(action.run);
    setBusy(false);
    if (ok) setPending(null);
  }

  const dialog = (
    <Modal
      title={pending?.title ?? ""}
      open={pending !== null}
      onOpenChange={(open) => !open && !busy && setPending(null)}
    >
      <Modal.Content>
        <Text style={{ color: c.foreground, lineHeight: 20 }}>{pending?.message}</Text>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 8,
          }}
        >
          {busy ? <ActivityIndicator color={c.foregroundMuted} /> : null}
          <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setPending(null)} />
          {pending?.actions.map((action) => (
            <Button
              key={action.label}
              theme={theme}
              label={action.label}
              danger={action.danger}
              disabled={busy}
              onPress={() => void perform(action)}
            />
          ))}
        </View>
      </Modal.Content>
    </Modal>
  );
  return { ask: setPending, dialog };
}
