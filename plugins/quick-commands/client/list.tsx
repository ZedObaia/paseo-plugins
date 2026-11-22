import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { commandSettings, commandsFor, runRpc, type QuickCommand } from "../shared/contracts";
import { Button, IconButton, MONOSPACE, sizes } from "./ui";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A workspace's commands, its project's first, each run with a press: the header button's popover
 * and the Quick commands panel.
 */
export function CommandList({
  theme,
  compact,
  workspaceId,
  edit,
  ran,
}: {
  theme: PluginTheme;
  compact: boolean;
  workspaceId: string;
  edit(): void;
  /** After a command started. */
  ran?: () => void;
}) {
  const c = theme.colors;
  const s = sizes(compact);
  const settings = useSettings(commandSettings);
  const projectId = useWorkspace(workspaceId, (workspace) => workspace.projectId);
  const run = useRpc(runRpc);
  const toast = useToast();
  const [starting, setStarting] = useState<string | null>(null);

  const start = async (command: QuickCommand, pressEnter: boolean) => {
    setStarting(command.id);
    try {
      await run({ workspaceId, commandId: command.id, pressEnter });
      // Paseo doesn't switch to a terminal a plugin opens: its tab is the last one
      toast.show(
        pressEnter
          ? `${command.label} is running in a new terminal`
          : `${command.label} is typed in a new terminal`,
        { variant: "success" },
      );
      ran?.();
    } catch (error) {
      toast.error(message(error));
    }
    setStarting(null);
  };

  if (settings.status === "loading") return <Text style={{ color: c.foregroundMuted }}>Loading…</Text>;
  if (settings.status !== "ready") return <Text style={{ color: c.statusDanger }}>{settings.error}</Text>;
  const commands = projectId ? commandsFor(settings.values.commands, projectId) : [];

  return (
    <View style={{ gap: 4 }}>
      {commands.length ? (
        commands.map((command) => (
          <View key={command.id} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Run ${command.label}`}
              accessibilityState={{ disabled: starting !== null }}
              disabled={starting !== null}
              onPress={() => void start(command, command.pressEnter)}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: s.control,
                justifyContent: "center",
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: pressed || starting === command.id ? c.surface2 : "transparent",
                opacity: starting !== null && starting !== command.id ? 0.5 : 1,
              })}
            >
              <Text style={{ color: c.foreground, fontSize: s.text }} numberOfLines={1}>
                {starting === command.id ? `Starting ${command.label}…` : command.label}
              </Text>
              <Text
                style={{ color: c.foregroundMuted, fontSize: s.text - 2, fontFamily: MONOSPACE }}
                numberOfLines={1}
              >
                {command.command.trim().split("\n")[0]}
              </Text>
            </Pressable>
            {command.pressEnter ? (
              <IconButton
                theme={theme}
                compact={compact}
                icon="TextCursorInput"
                label={`Type ${command.label} in without running it`}
                disabled={starting !== null}
                onPress={() => void start(command, false)}
              />
            ) : null}
          </View>
        ))
      ) : (
        <Text style={{ color: c.foregroundMuted, fontSize: s.text, padding: 8 }}>
          No quick commands for this workspace yet. Add your own, for every project or this one.
        </Text>
      )}
      <View style={{ flexDirection: "row", justifyContent: "flex-start", marginTop: 4 }}>
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          icon={commands.length ? "Pencil" : "Plus"}
          label={commands.length ? "Edit commands" : "Add a command"}
          onPress={edit}
        />
      </View>
    </View>
  );
}
