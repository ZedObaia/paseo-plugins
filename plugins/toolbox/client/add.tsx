import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { addRpc, PROVIDERS, type NewServer, type Provider, type Where } from "../shared/contracts";
import { AGENT_NAMES, parsePairs, splitCommand } from "../shared/items";
import { errorText } from "./data";
import { Header } from "./detail";
import { Button, Segments, sizes, Toggle } from "./ui";

const WHERE_LABELS: Record<Where, string> = {
  folder: "This folder",
  everywhere: "Every project",
  shared: "Shared .mcp.json",
};

/** A labelled text field, with a line under it saying what goes there. */
function Field({
  theme,
  compact,
  label,
  hint,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  hint?: string;
  value: string;
  onChange(text: string): void;
  placeholder: string;
  multiline?: boolean;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        style={{
          minHeight: multiline ? 64 : sizes(compact).control + 4,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.surface1,
          color: c.foreground,
          fontSize: 13,
          fontFamily: "Menlo, ui-monospace, monospace",
          textAlignVertical: multiline ? "top" : "center",
        }}
      />
      {hint ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

/**
 * Adds an MCP server to the agent: on the web at a URL, or a command it starts on this host, for
 * this folder, every project, or (Claude) the repository's shared .mcp.json. The same one can go
 * to the other agents too, in their own settings.
 */
export function AddConnector({
  theme,
  compact,
  provider,
  agentName,
  cwd,
  folderName,
  addTo,
  taken,
  onAdded,
  onBack,
}: {
  theme: PluginTheme;
  compact: boolean;
  provider: Provider;
  // "Claude", "Codex"
  agentName: string;
  cwd: string;
  folderName: string;
  addTo: Where[];
  // names already used here
  taken: string[];
  // ok: every agent asked for has it
  onAdded(name: string, message: string, ok: boolean): void;
  onBack(): void;
}) {
  const c = theme.colors;
  const add = useRpc(addRpc);
  const [name, setName] = useState("");
  const [type, setType] = useState<NewServer["type"]>("http");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const [where, setWhere] = useState<Where>(addTo[0] ?? "everywhere");
  // other agents to add it to as well
  const [also, setAlso] = useState<Provider[]>([]);
  const others = PROVIDERS.filter((p) => p !== provider);
  // only Claude reads a shared .mcp.json
  const alsoTo = where === "shared" ? [] : also;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const whereHint = {
    folder:
      provider === "codex"
        ? `Only Codex chats in ${folderName}, in its .codex/config.toml, kept out of git.`
        : provider === "opencode"
          ? `Only OpenCode chats in ${folderName}, in its .opencode/opencode.json, kept out of git.`
          : `Only Claude chats in ${folderName}, in your Claude settings for this folder.`,
    everywhere: `Every ${agentName} chat, in every project.`,
    shared: "Written to .mcp.json here. Commit it to share it: Claude asks each person before using it.",
  }[where];

  async function submit() {
    setError(null);
    const id = name.trim();
    try {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Name it with letters, digits, - and _");
      if (taken.includes(id)) throw new Error(`There's already a connector called ${id}`);
      let server: NewServer;
      if (type === "http") {
        if (!/^https?:\/\/\S+$/.test(url.trim())) throw new Error("The address starts with https://");
        server = { type, url: url.trim(), headers: parsePairs(headers, ":") };
      } else {
        const [bin, ...args] = splitCommand(command);
        if (!bin) throw new Error("Type the command that starts it");
        server = { type, command: bin, args, env: parsePairs(env, "=") };
      }
      setAdding(true);
      const { message } = await add({ provider, cwd, name: id, where, server });
      const results = await Promise.allSettled(
        alsoTo.map((p) => add({ provider: p, cwd, name: id, where, server })),
      );
      const added = alsoTo.filter((_, i) => results[i].status === "fulfilled").map((p) => AGENT_NAMES[p]);
      const missed = results.flatMap((r, i) =>
        r.status === "rejected" ? [`${AGENT_NAMES[alsoTo[i]]}: ${errorText(r.reason)}`] : [],
      );
      onAdded(
        id,
        [
          message,
          added.length ? `Also added to ${added.join(" and ")}` : "",
          missed.length ? `Not added to ${missed.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join(". "),
        missed.length === 0,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAdding(false);
    }
  }

  return (
    <View style={{ gap: 18 }}>
      <Header
        theme={theme}
        compact={compact}
        back="Connectors"
        onBack={onBack}
        icon="Plus"
        title={`Add a connector to ${agentName}`}
        subtitle="An MCP server on the web, or a command on this computer"
      />
      <Field
        theme={theme}
        compact={compact}
        label="Name"
        value={name}
        onChange={setName}
        placeholder="linear"
        hint="How chats and tool rules know it."
      />
      <Segments<NewServer["type"]>
        theme={theme}
        compact={compact}
        value={type}
        onChange={setType}
        options={[
          { value: "http", label: "On the web" },
          { value: "stdio", label: "A command here" },
        ]}
      />
      {type === "http" ? (
        <>
          <Field
            theme={theme}
            compact={compact}
            label="Address"
            value={url}
            onChange={setUrl}
            placeholder="https://mcp.example.com/mcp"
          />
          <Field
            theme={theme}
            compact={compact}
            label="Headers"
            value={headers}
            onChange={setHeaders}
            placeholder="Authorization: Bearer …"
            multiline
            hint="Optional, one per line, saved as you type them. Most web connectors sign in instead: add it, then Connect."
          />
        </>
      ) : (
        <>
          <Field
            theme={theme}
            compact={compact}
            label="Command"
            value={command}
            onChange={setCommand}
            placeholder="npx -y @playwright/mcp@latest"
            hint="Started on this computer when a chat starts. Quote an argument that has spaces."
          />
          <Field
            theme={theme}
            compact={compact}
            label="Environment"
            value={env}
            onChange={setEnv}
            placeholder="API_KEY=…"
            multiline
            hint="Optional, one per line, saved as you type them."
          />
        </>
      )}
      <View style={{ gap: 6 }}>
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>For</Text>
        <Segments<Where>
          theme={theme}
          compact={compact}
          value={where}
          onChange={setWhere}
          options={addTo.map((value) => ({ value, label: WHERE_LABELS[value] }))}
        />
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{whereHint}</Text>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>Also add to</Text>
        {others.map((p) => (
          <View key={p} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              style={{ flex: 1, color: where === "shared" ? c.foregroundMuted : c.foreground, fontSize: 13 }}
            >
              {AGENT_NAMES[p]}
            </Text>
            <Toggle
              theme={theme}
              label={`Also add to ${AGENT_NAMES[p]}`}
              on={alsoTo.includes(p)}
              changed={false}
              disabled={where === "shared"}
              onToggle={() =>
                setAlso((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]))
              }
            />
          </View>
        ))}
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {where === "shared"
            ? "Only Claude reads a shared .mcp.json."
            : `The same connector, for ${where === "folder" ? "this folder" : "every project"}, in each agent's own settings.`}
        </Text>
      </View>
      {error ? <Text style={{ color: c.statusDanger, fontSize: 13 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          theme={theme}
          compact={compact}
          variant="primary"
          label={adding ? "Adding…" : name.trim() ? `Add ${name.trim()}` : "Add"}
          disabled={adding || !name.trim()}
          onPress={() => void submit()}
        />
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          label="Cancel"
          disabled={adding}
          onPress={onBack}
        />
      </View>
    </View>
  );
}
