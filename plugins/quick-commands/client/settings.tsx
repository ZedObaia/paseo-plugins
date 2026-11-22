import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import {
  commandSettings,
  listRpc,
  MAX_COMMANDS,
  nameTaken,
  newCommandId,
  scopeName,
  withCommand,
  type QuickCommand,
} from "../shared/contracts";
import { Button, MONOSPACE } from "./ui";

interface Project {
  projectId: string;
  projectDisplayName: string;
}

const blank = (): QuickCommand => ({
  id: newCommandId(),
  label: "",
  command: "",
  projectId: null,
  projectName: "",
  folder: "",
  pressEnter: true,
  replace: false,
  loadDotenv: false,
});

/** `./apps/web/` as `apps/web`: the folder is always inside the workspace's. */
const tidyFolder = (folder: string) =>
  folder
    .trim()
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");

/** What's wrong with a command before saving it, by field, if anything. */
function problems(command: QuickCommand, others: readonly QuickCommand[]) {
  return {
    label: !command.label.trim()
      ? "Give it a name"
      : nameTaken(others, command)
        ? "Another command has this name"
        : null,
    command: command.command.trim() ? null : "Type the command",
    folder: /^(\/|~|\.\.(\/|$))/.test(tidyFolder(command.folder))
      ? "A folder inside the workspace, like apps/web"
      : null,
  };
}

function Editor({
  theme,
  compact,
  original,
  others,
  projects,
  saving,
  saveError,
  save,
  remove,
  cancel,
}: {
  theme: PluginTheme;
  compact: boolean;
  original: QuickCommand;
  others: readonly QuickCommand[];
  projects: Project[];
  saving: boolean;
  saveError: string | null;
  save(command: QuickCommand): void;
  remove: (() => void) | null;
  cancel(): void;
}) {
  const c = theme.colors;
  const [command, setCommand] = useState(original);
  const [tried, setTried] = useState(false);
  const [removing, setRemoving] = useState(false);
  const change = (patch: Partial<QuickCommand>) => setCommand((current) => ({ ...current, ...patch }));
  const wrong = problems(command, others);
  const shown = (error: string | null) => (tried ? error : null);

  const options = [
    { label: "Every project", value: "" },
    ...projects.map((project) => ({ label: project.projectDisplayName, value: project.projectId })),
  ];
  // a project Paseo no longer has stays picked until you pick another
  if (command.projectId && !projects.some((project) => project.projectId === command.projectId))
    options.push({ label: scopeName(command), value: command.projectId });

  const submit = () => {
    setTried(true);
    if (wrong.label || wrong.command || wrong.folder) return;
    save({ ...command, label: command.label.trim(), folder: tidyFolder(command.folder) });
  };

  return (
    <SettingsSection title={original.label ? `Edit ${original.label}` : "New command"}>
      <SettingsCard>
        <SettingsInput
          label="Name"
          hint="On its button and its terminal's tab, and what to type after /run."
          initialValue={original.label}
          placeholder="Dev server"
          error={shown(wrong.label)}
          onChangeText={(label) => change({ label })}
        />
        <SettingsRow
          label="Command"
          hint="Runs in your shell, line by line. It has the variables paseo.json's scripts get, like $PASEO_BRANCH_NAME and $PASEO_WORKTREE_PORT, and $PASEO_SERVICE_WEB_PORT for a running service named web."
          error={shown(wrong.command)}
        >
          <TextInput
            multiline
            value={command.command}
            onChangeText={(text) => change({ command: text })}
            placeholder="npm run dev -- --port $PASEO_WORKTREE_PORT"
            placeholderTextColor={c.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel="Command"
            style={{
              minHeight: 88,
              minWidth: compact ? undefined : 320,
              padding: 8,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 6,
              color: c.foreground,
              backgroundColor: c.surface0,
              fontFamily: MONOSPACE,
              fontSize: 13,
              textAlignVertical: "top",
            }}
          />
        </SettingsRow>
        <SettingsSelect
          label="For"
          hint="Which workspaces show it: every project's, or one project's, where it comes first."
          value={command.projectId ?? ""}
          options={options}
          onValueChange={(projectId) =>
            change({
              projectId: projectId || null,
              projectName:
                projects.find((project) => project.projectId === projectId)?.projectDisplayName ?? "",
            })
          }
        />
        <SettingsInput
          label="Folder"
          hint="Where it runs inside the workspace, like apps/web. Empty for the workspace's own folder."
          initialValue={original.folder}
          placeholder="The workspace's folder"
          error={shown(wrong.folder)}
          onChangeText={(folder) => change({ folder })}
        />
        <SettingsSwitch
          label="Run it"
          hint="Off: it's typed in, for you to finish and run."
          value={command.pressEnter}
          onValueChange={(pressEnter) => change({ pressEnter })}
        />
        <SettingsSwitch
          label="Replace its last run"
          hint="Closes the terminal its last run left in that workspace first, like restarting a dev server."
          value={command.replace}
          onValueChange={(replace) => change({ replace })}
        />
        <SettingsSwitch
          label="Load .env"
          hint="Exports the variables in the workspace's .env first, and in its folder's when it runs in another. A new worktree without one uses the project checkout's."
          value={command.loadDotenv}
          onValueChange={(loadDotenv) => change({ loadDotenv })}
        />
      </SettingsCard>
      {saveError ? <Text style={{ color: c.statusDanger, marginTop: 8 }}>{saveError}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <Button
          theme={theme}
          compact={compact}
          variant="primary"
          label={saving ? "Saving…" : "Save"}
          disabled={saving}
          onPress={submit}
        />
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          label="Cancel"
          disabled={saving}
          onPress={cancel}
        />
        {remove ? (
          <Button
            theme={theme}
            compact={compact}
            variant="ghost"
            danger
            label={removing ? "Delete it" : "Delete"}
            disabled={saving}
            onPress={() => (removing ? remove() : setRemoving(true))}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

/** Settings, Plugins, Quick commands: the list, and a command's editor in its place. */
export function CommandSettings({ theme, host, layout, onSaved }: PluginSurfaceProps & { onSaved(): void }) {
  const c = theme.colors;
  const paseo = usePaseo();
  const settings = useSettings(commandSettings);
  const projects = useQuery({
    queryKey: ["quick-commands", host.id, "projects"],
    queryFn: async () => (await paseo.projects.list()).projects as Project[],
  });
  const list = useRpc(listRpc);
  const [editing, setEditing] = useState<QuickCommand | null>(null);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const edit = (command: QuickCommand | null) => {
    setWriteError(null);
    setEditing(command);
  };

  if (settings.status === "loading") return <Text style={{ color: c.foregroundMuted }}>Loading…</Text>;
  if (settings.status !== "ready") return <Text style={{ color: c.statusDanger }}>{settings.error}</Text>;
  const commands = settings.values.commands;

  /**
   * Saves one change into the list as the daemon has it now, not as this screen last saw it. A
   * script or another app may have changed it meanwhile, and the file's own copy is the one Paseo
   * lets a save replace: an older one is refused, and would undo the other change.
   */
  const write = async (change: (current: readonly QuickCommand[]) => QuickCommand[]) => {
    setWriting(true);
    setWriteError(null);
    try {
      const current = await list({});
      if (await settings.save({ commands: change(current.commands) }, current.revision)) {
        edit(null);
        onSaved();
      }
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
    }
    setWriting(false);
  };

  if (editing) {
    const saved = commands.some((command) => command.id === editing.id);
    return (
      <Editor
        key={editing.id}
        theme={theme}
        compact={layout.compact}
        original={editing}
        others={commands}
        projects={[...(projects.data ?? [])].sort((a, b) =>
          a.projectDisplayName.localeCompare(b.projectDisplayName),
        )}
        saving={writing || settings.saving}
        saveError={writeError ?? settings.saveError}
        save={(command) => void write((current) => withCommand(current, command))}
        remove={
          saved ? () => void write((current) => current.filter((other) => other.id !== editing.id)) : null
        }
        cancel={() => edit(null)}
      />
    );
  }

  const full = commands.length >= MAX_COMMANDS;
  return (
    <SettingsSection title="Commands">
      <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18, marginBottom: 8 }}>
        Your own commands for workspaces' terminals. Run one from the Quick commands button in a workspace's
        header, Run in the Command Center, or /run in the message box: it opens a new terminal in the
        workspace, with its branch, paths and ports in variables.
      </Text>
      <SettingsCard>
        {commands.map((command) => (
          <SettingsAction
            key={command.id}
            label={command.label}
            hint={`${scopeName(command)} · ${command.command.trim().split("\n")[0]}`}
            actionLabel="Edit"
            onPress={() => edit(command)}
          />
        ))}
        <SettingsAction
          label={commands.length ? "Add another command" : "Add a command"}
          hint={full ? `That's the most there can be: ${MAX_COMMANDS}.` : undefined}
          actionLabel="Add"
          disabled={full}
          onPress={() => edit(blank())}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
