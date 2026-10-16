import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostSummary } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { useAdd } from "./data";
import { parseTarget, type ProjectRow, type Target } from "./model";
import { Button, Check, JobLine } from "./ui";

type Adder = ReturnType<typeof useAdd>;

/** Host checkboxes (all ticked), an Add button, then each host's progress. */
function AddToHosts({
  theme,
  rowId,
  target,
  hosts,
  adder,
  onClose,
  cancelLabel = "Cancel",
}: {
  theme: PluginTheme;
  rowId: string;
  target: Target | null;
  hosts: readonly PluginHostSummary[];
  adder: Adder;
  onClose(): void;
  cancelLabel?: string;
}) {
  const [chosen, setChosen] = useState(() => new Set(hosts.map((h) => h.serverId)));
  // the project being added, kept when the form's input changes afterwards
  const [running, setRunning] = useState<string | null>(null);
  const started = running !== null;
  const jobs = hosts.map((h) => ({ host: h, job: running ? adder.job(running, h.serverId) : undefined }));
  const busy = jobs.some((j) => j.job?.state === "working");
  const toggle = (serverId: string) =>
    setChosen((all) => {
      const next = new Set(all);
      if (!next.delete(serverId)) next.add(serverId);
      return next;
    });
  function start() {
    if (!target) return;
    setRunning(rowId);
    for (const serverId of chosen) void adder.add(rowId, target, serverId);
  }
  return (
    <View style={{ gap: 10 }}>
      {started
        ? jobs.map(({ host, job }) =>
            job ? <JobLine key={host.serverId} theme={theme} label={host.label} job={job} /> : null,
          )
        : hosts.map((h) => (
            <Check
              key={h.serverId}
              theme={theme}
              label={h.label}
              checked={chosen.has(h.serverId)}
              onToggle={() => toggle(h.serverId)}
            />
          ))}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Button
          theme={theme}
          label={started && !busy ? "Done" : cancelLabel}
          disabled={busy}
          onPress={onClose}
        />
        {started ? null : (
          <Button
            theme={theme}
            primary
            icon="FolderPlus"
            label={`Add to ${chosen.size} ${chosen.size === 1 ? "host" : "hosts"}`}
            disabled={!target || chosen.size === 0}
            onPress={start}
          />
        )}
      </View>
    </View>
  );
}

/** "owner/repo", a clone URL or a folder, then the hosts to add it to. */
export function AddProjectForm({
  theme,
  hosts,
  rows,
  adder,
  onClose,
}: {
  theme: PluginTheme;
  hosts: readonly PluginHostSummary[];
  rows: ProjectRow[];
  adder: Adder;
  onClose(): void;
}) {
  const [input, setInput] = useState("");
  const [parent, setParent] = useState("~/workspace");
  const c = theme.colors;
  const parsed = parseTarget(input, parent);
  // a folder another host has as a git project can be cloned from that remote where it's missing
  const target =
    parsed && !parsed.cloneUrl
      ? { ...parsed, cloneUrl: rows.find((r) => r.path === parsed.path)?.cloneUrl ?? null }
      : parsed;
  const field = {
    color: c.foreground,
    backgroundColor: c.surface2,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  };
  return (
    <View style={{ gap: 12 }}>
      <TextInput
        value={input}
        onChangeText={setInput}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="owner/repo, a clone URL, or ~/workspace/folder"
        placeholderTextColor={c.foregroundMuted}
        style={field}
      />
      {parsed?.cloneUrl ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Clone into</Text>
          <TextInput
            value={parent}
            onChangeText={setParent}
            autoCapitalize="none"
            autoCorrect={false}
            style={field}
          />
        </View>
      ) : null}
      <Text
        style={{ color: input && !target ? c.statusDanger : c.foregroundMuted, fontSize: 12, lineHeight: 18 }}
      >
        {!input
          ? "~ is each host's home folder."
          : !target
            ? "Enter owner/repo, an https or ssh clone URL, or a folder starting with ~ or /."
            : target.cloneUrl
              ? `Adds ${target.path}, cloning ${target.cloneUrl} where it's missing.`
              : `Adds ${target.path} on each host that has it. No host has it as a git project, so it can't be cloned where it's missing.`}
      </Text>
      <AddToHosts
        theme={theme}
        rowId={target ? `form:${target.path}` : "form"}
        target={target}
        hosts={hosts}
        adder={adder}
        onClose={onClose}
      />
    </View>
  );
}

/** Asks whether a project just added on one host should go to the hosts that don't have it. */
export function NewProjectPrompt({
  theme,
  row,
  from,
  missing,
  adder,
  onClose,
}: {
  theme: PluginTheme;
  row: ProjectRow;
  from: string;
  missing: readonly PluginHostSummary[];
  adder: Adder;
  onClose(): void;
}) {
  return (
    <Modal title={`Add ${row.name} to other hosts?`} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground, lineHeight: 20 }}>
          {row.name} was just added on {from}.{" "}
          {row.cloneUrl
            ? "Hosts without the folder get a clone of it."
            : `It goes in ${row.path} on each host.`}
        </Text>
        <AddToHosts
          theme={theme}
          rowId={row.id}
          target={row}
          hosts={missing}
          adder={adder}
          onClose={onClose}
          cancelLabel="Not now"
        />
      </Modal.Content>
    </Modal>
  );
}
