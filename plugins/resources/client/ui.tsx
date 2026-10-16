import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

type Colors = PluginTheme["colors"];

/** Fill color for a usage ratio: calm until 75%, warning to 90%, then danger. */
export const level = (c: Colors, value: number) =>
  value >= 0.9 ? c.statusDanger : value >= 0.75 ? c.statusWarning : c.accent;

/** neutral: a share of something (e.g. reclaimable), not a load that can run out. */
export function Meter({ theme, value, neutral }: { theme: PluginTheme; value: number; neutral?: boolean }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View
        style={{ height: 6, width: `${Math.round(value * 100)}%`, backgroundColor: neutral ? theme.colors.accent : level(theme.colors, value) }}
      />
    </View>
  );
}

export function Section({ theme, title, trailing, children }: { theme: PluginTheme; title: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>{title}</Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

export function Card({ theme, children, flex }: { theme: PluginTheme; children: ReactNode; flex?: boolean }) {
  return (
    <View
      style={{
        flexGrow: flex ? 1 : 0,
        flexBasis: flex ? 160 : undefined,
        padding: 12,
        gap: 6,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

export function Button({
  theme,
  label,
  onPress,
  danger,
  primary,
  disabled,
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : c.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: primary ? c.accentForeground : danger ? c.statusDanger : c.foreground, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export interface Action {
  label: string;
  danger?: boolean;
  run(): Promise<{ message: string }>;
}

export interface Confirmation {
  title: string;
  message: string;
  actions: Action[];
}

/** A dialog offering one or more actions; the result or error shows as a toast. */
export function useConfirm(theme: PluginTheme): { ask(c: Confirmation): void; dialog: ReactNode } {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const c = theme.colors;

  async function perform(action: Action) {
    setBusy(true);
    try {
      const { message } = await action.run();
      toast.show(message, { variant: "success" });
      setPending(null);
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Modal title={pending?.title ?? ""} open={pending !== null} onOpenChange={(open) => !open && !busy && setPending(null)}>
      <Modal.Content>
        <Text style={{ color: c.foreground, lineHeight: 20 }}>{pending?.message}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
          {busy ? <ActivityIndicator color={c.foregroundMuted} /> : null}
          <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setPending(null)} />
          {pending?.actions.map((action) => (
            <Button key={action.label} theme={theme} label={action.label} danger={action.danger} disabled={busy} onPress={() => void perform(action)} />
          ))}
        </View>
      </Modal.Content>
    </Modal>
  );
  return { ask: setPending, dialog };
}
