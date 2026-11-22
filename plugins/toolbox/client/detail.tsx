import type { PluginTheme } from "@getpaseo/plugin";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { packRpc, removeRpc, type Behavior, type Connector, type Provider } from "../shared/contracts";
import { scopeText, skillMarkdown, type Item } from "../shared/items";
import { copyToHost } from "./copy";
import { errorText, useSetRule, useSkill } from "./data";
import { Bone, Button, Choice, Pulse, Section, Tile, Toggle, faint, sizes } from "./ui";

const BEHAVIORS: { value: Behavior; label: string; tone?: "warning" | "danger" }[] = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask", tone: "warning" },
  { value: "deny", label: "Block", tone: "danger" },
];
const MONO = { fontFamily: "Menlo, ui-monospace, monospace" };

/** The title block every detail view starts with: back, its icon, name and where it's from. */
export function Header({
  theme,
  compact,
  back,
  onBack,
  icon,
  title,
  subtitle,
}: {
  theme: PluginTheme;
  compact: boolean;
  back: string;
  onBack(): void;
  icon: string;
  title: string;
  subtitle: string;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row" }}>
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          icon="ChevronLeft"
          label={back}
          onPress={onBack}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Tile theme={theme} icon={icon} size={40} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }} numberOfLines={1}>
            {title}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{subtitle}</Text>
        </View>
      </View>
    </View>
  );
}

/** "On in this folder" (or everywhere), with the switch that joins the panel's pending changes. */
function FolderSwitch({
  theme,
  title,
  label = "On in this folder",
  hint,
  on,
  changed,
  onToggle,
  disabled,
}: {
  theme: PluginTheme;
  title: string;
  label?: string;
  hint: string;
  on: boolean;
  changed: boolean;
  onToggle(): void;
  disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.foreground, fontSize: 14 }}>{label}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{hint}</Text>
      </View>
      <Toggle theme={theme} label={title} on={on} changed={changed} onToggle={onToggle} disabled={disabled} />
    </View>
  );
}

const Badge = ({ theme, label }: { theme: PluginTheme; label: string }) => (
  <Text
    style={{
      fontSize: 11,
      color: theme.colors.foregroundMuted,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 5,
      paddingHorizontal: 5,
      lineHeight: 17,
    }}
  >
    {label}
  </Text>
);

/**
 * A connector's details: where it's configured, on or off here, sign-in, each tool with Allow,
 * Ask or Block (saved for the folder), and removing it from the agent's configuration.
 */
export function ConnectorDetail({
  theme,
  compact,
  hostId,
  provider,
  agentName,
  cwd,
  connector,
  toolsKnown,
  item,
  on,
  changed,
  onToggle,
  signIn,
  onConnect,
  onSignInAgain,
  onReconnect,
  reconnect,
  onRuleSaved,
  onRemoved,
  onBack,
}: {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  provider: Provider;
  // "Claude", "Codex"
  agentName: string;
  cwd: string;
  connector: Connector;
  // the agent lists a connector's tools here (OpenCode only lists them to a chat)
  toolsKnown: boolean;
  item: Item;
  on: boolean;
  changed: boolean;
  onToggle(): void;
  signIn: ReactNode;
  onConnect(): void;
  // signs it out, then in, as Claude Code's Re-authenticate does
  onSignInAgain(): void;
  onReconnect(): void;
  // what Reconnect does here, and whether it's under way or has to wait
  reconnect: { busy: boolean; hint: string };
  // the chat follows the new rule after a restart
  onRuleSaved(restart: boolean): void;
  onRemoved(undoId: string): void;
  onBack(): void;
}) {
  const c = theme.colors;
  const toast = useToast();
  const setRule = useSetRule(hostId, provider, cwd);
  const remove = useRpc(removeRpc);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { removable } = connector;
  const tools = connector.tools.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()));
  const stateColor =
    item.tone === "danger" ? c.statusDanger : item.tone === "warning" ? c.statusWarning : c.statusSuccess;
  // web connectors and claude.ai's sign in in the browser; one this host starts has nothing to sign in to
  const signsIn = /^https?:\/\//.test(connector.target) || connector.scope === "claudeai";

  async function choose(tool: string | null, choice: Behavior) {
    try {
      onRuleSaved(await setRule(connector.name, tool, choice));
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  async function onRemove() {
    setRemoving(true);
    try {
      onRemoved((await remove({ provider, cwd, name: connector.name })).undoId);
    } catch (error) {
      toast.error(errorText(error));
      setRemoving(false);
    }
  }

  const emptyTools = !toolsKnown
    ? `${agentName} lists a connector's tools only inside a chat. The rule above is for all of them.`
    : connector.state === "signin"
      ? "Sign in to see its tools."
      : connector.state === "off"
        ? "Turn it on to see its tools."
        : connector.state === "failed"
          ? "It didn't start, so its tools aren't known."
          : connector.state === "pending"
            ? "Still connecting."
            : "It has no tools.";

  return (
    <View style={{ gap: 18 }}>
      <Header
        theme={theme}
        compact={compact}
        back="Connectors"
        onBack={onBack}
        icon="Plug"
        title={item.title}
        subtitle={scopeText(connector, provider)}
      />
      <View style={{ gap: 4 }}>
        <Text style={{ color: stateColor, fontSize: 13 }} selectable>
          {connector.state !== "connected"
            ? connector.detail
            : toolsKnown
              ? `Connected · ${connector.tools.length} tools`
              : "Connected"}
        </Text>
        {connector.target ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12, ...MONO }} selectable numberOfLines={3}>
            {connector.target}
          </Text>
        ) : null}
      </View>
      {signIn ??
        (connector.state === "signin" ? (
          <View style={{ flexDirection: "row" }}>
            <Button theme={theme} compact={compact} variant="warning" label="Connect" onPress={onConnect} />
          </View>
        ) : connector.state !== "off" ? (
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button
                theme={theme}
                compact={compact}
                icon="RefreshCw"
                label="Reconnect"
                disabled={reconnect.busy}
                onPress={onReconnect}
              />
              {signsIn ? (
                <Button
                  theme={theme}
                  compact={compact}
                  icon="KeyRound"
                  label="Sign in again"
                  onPress={onSignInAgain}
                />
              ) : null}
            </View>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {signsIn
                ? `${reconnect.hint} Sign in again signs it out first, then opens its sign-in page.`
                : reconnect.hint}
            </Text>
          </View>
        ) : null)}
      <FolderSwitch
        theme={theme}
        title={item.title}
        hint={
          connector.fixedBy
            ? `${agentName} can't turn it off for one folder: it comes with ${connector.fixedBy}.`
            : "Off: chats here don't load it."
        }
        on={on}
        changed={changed}
        onToggle={onToggle}
        disabled={connector.fixedBy !== null}
      />

      <Section theme={theme} title="Tools" count={toolsKnown ? connector.tools.length : undefined}>
        <View style={{ padding: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, color: c.foreground, fontSize: 13, fontWeight: "500" }}>All tools</Text>
            <Choice
              theme={theme}
              value={connector.rule.behavior}
              options={BEHAVIORS}
              disabled={connector.rule.lockedBy !== null}
              onChange={(v) => void choose(null, v)}
            />
          </View>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {connector.rule.lockedBy
              ? `Set by ${connector.rule.lockedBy}.`
              : `Allow runs a tool without asking; Block stops the agent using it. Saved for this folder; the chat follows it ${provider === "claude" ? "from its next tool call" : "after a restart"}.`}
          </Text>
        </View>
        {connector.tools.length > 12 ? (
          <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${connector.tools.length} tools`}
              placeholderTextColor={c.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                minHeight: sizes(compact).control,
                paddingHorizontal: 8,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: c.border,
                color: c.foreground,
                fontSize: 13,
              }}
            />
          </View>
        ) : null}
        {connector.tools.length === 0 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13, padding: 12 }}>{emptyTools}</Text>
        ) : (
          tools.map((t) => {
            const locked = t.rule.lockedBy;
            // said once above when it's the whole connector's
            const badge = locked !== connector.rule.lockedBy ? locked : null;
            return (
              <View
                key={t.name}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                }}
              >
                <View style={{ flex: 1, minWidth: 140, gap: 3 }}>
                  <Text style={{ color: c.foreground, fontSize: 13, ...MONO }} selectable numberOfLines={1}>
                    {t.name}
                  </Text>
                  {t.readOnly || badge ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                      {t.readOnly ? <Badge theme={theme} label="Read-only" /> : null}
                      {badge ? <Badge theme={theme} label={`Set by ${badge}`} /> : null}
                    </View>
                  ) : null}
                </View>
                <Choice
                  theme={theme}
                  value={t.rule.behavior}
                  options={BEHAVIORS}
                  disabled={locked !== null}
                  onChange={(v) => void choose(t.name, v)}
                />
              </View>
            );
          })
        )}
      </Section>

      <View
        style={{
          gap: 10,
          padding: 12,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: confirming ? faint(c.statusDanger, "66") : c.border,
        }}
      >
        <Text style={{ color: c.foreground, fontSize: 14 }}>{`Remove from ${agentName}`}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {!removable
            ? connector.scope === "plugin"
              ? "It comes with a plugin. Turn the plugin off, or uninstall it, to remove it."
              : connector.scope === "claudeai"
                ? "It comes from your claude.ai account. Remove it in claude.ai's settings, under Connectors."
                : `${agentName} can't remove this one from here.`
            : confirming
              ? connector.scope === "user"
                ? `${item.title} goes from every project, not only this one, with its settings.`
                : connector.scope === "project"
                  ? `${item.title} goes from .mcp.json. Everyone using the repository loses it once you commit.`
                  : `${item.title} goes from this folder's ${agentName} settings.`
              : "Deletes its settings instead of turning it off. You can undo it for a while."}
        </Text>
        {removable ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            {confirming ? (
              <>
                <Button
                  theme={theme}
                  compact={compact}
                  variant="danger"
                  label={removing ? "Removing…" : `Remove ${item.title}`}
                  disabled={removing}
                  onPress={() => void onRemove()}
                />
                <Button
                  theme={theme}
                  compact={compact}
                  variant="ghost"
                  label="Cancel"
                  disabled={removing}
                  onPress={() => setConfirming(false)}
                />
              </>
            ) : (
              <Button theme={theme} compact={compact} label="Remove…" onPress={() => setConfirming(true)} />
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

type Copy = { state: "copying" | "copied" | "exists" | "failed"; text: string };

/**
 * Copies one of your skills to the same place in your home folder on your other hosts, one host at
 * a time or all at once. One that's there already is replaced only when asked.
 */
function CopyToHosts({
  theme,
  compact,
  hostId,
  provider,
  cwd,
  name,
  title,
}: {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  provider: Provider;
  cwd: string;
  name: string;
  title: string;
}) {
  const c = theme.colors;
  const hosts = useHosts().filter((h) => h.serverId !== hostId);
  const pack = useRpc(packRpc);
  const [copies, setCopies] = useState<Record<string, Copy>>({});
  if (!hosts.length) return null;
  const ready = hosts.filter((h) => h.status === "online" && copies[h.serverId]?.state !== "copying");

  async function copy(serverIds: string[], replace: boolean) {
    const set = (id: string, copy: Copy) => setCopies((prev) => ({ ...prev, [id]: copy }));
    for (const id of serverIds) set(id, { state: "copying", text: "Copying…" });
    let packed: Awaited<ReturnType<typeof pack>>;
    try {
      packed = await pack({ provider, cwd, name });
    } catch (error) {
      for (const id of serverIds) set(id, { state: "failed", text: errorText(error) });
      return;
    }
    await Promise.all(
      serverIds.map(async (id) => {
        try {
          set(
            id,
            (await copyToHost(id, title, packed, replace)) === "copied"
              ? { state: "copied", text: replace ? "Replaced" : "Copied" }
              : { state: "exists", text: "Already there" },
          );
        } catch (error) {
          set(id, { state: "failed", text: errorText(error) });
        }
      }),
    );
  }

  return (
    <Section
      theme={theme}
      title="Copy to other hosts"
      action={
        ready.length > 1 ? (
          <Button
            theme={theme}
            compact={compact}
            variant="ghost"
            icon="Copy"
            label="Copy to all"
            onPress={() =>
              void copy(
                ready.map((h) => h.serverId),
                false,
              )
            }
          />
        ) : null
      }
    >
      {hosts.map((h, n) => {
        const done = copies[h.serverId];
        const online = h.status === "online";
        const tone =
          done?.state === "failed"
            ? c.statusDanger
            : done?.state === "exists"
              ? c.statusWarning
              : c.foregroundMuted;
        return (
          <View
            key={h.serverId}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingVertical: compact ? 10 : 8,
              paddingHorizontal: 12,
              borderTopWidth: n ? 1 : 0,
              borderTopColor: c.border,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: c.foreground, fontSize: 14 }} numberOfLines={1}>
                {h.label}
              </Text>
              {done || !online ? (
                <Text style={{ color: tone, fontSize: 12 }} numberOfLines={2}>
                  {done?.text ?? "Offline"}
                </Text>
              ) : null}
            </View>
            {online && done?.state !== "copied" ? (
              <Button
                theme={theme}
                compact={compact}
                variant={done?.state === "exists" ? "warning" : "secondary"}
                label={done?.state === "exists" ? "Replace" : "Copy"}
                accessibilityLabel={`${done?.state === "exists" ? "Replace" : "Copy"} on ${h.label}`}
                disabled={done?.state === "copying"}
                onPress={() => void copy([h.serverId], done?.state === "exists")}
              />
            ) : null}
          </View>
        );
      })}
      <Text
        style={{
          color: c.foregroundMuted,
          fontSize: 12,
          padding: 12,
          borderTopWidth: 1,
          borderTopColor: c.border,
        }}
      >
        {
          "It goes in the same folder there as here, under the home folder, through a terminal in one of that host's projects. Chats there that start afterwards have it."
        }
      </Text>
    </Section>
  );
}

/** A skill's details: what it says it's for, where its file is, and the file itself. */
export function SkillDetail({
  theme,
  compact,
  hostId,
  provider,
  everywhere,
  cwd,
  item,
  description,
  on,
  changed,
  onToggle,
  onBack,
}: {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  provider: Provider;
  // the agent turns skills on and off for every folder at once (Codex)
  everywhere: boolean;
  cwd: string;
  item: Item;
  description: string;
  on: boolean;
  changed: boolean;
  onToggle(): void;
  onBack(): void;
}) {
  const c = theme.colors;
  const skill = useSkill(hostId, provider, cwd, item.name);
  const [all, setAll] = useState(false);
  const lines = skill.data?.content.split("\n") ?? [];
  const shown = all ? lines : lines.slice(0, 80);
  return (
    <View style={{ gap: 18 }}>
      <Header
        theme={theme}
        compact={compact}
        back="Skills"
        onBack={onBack}
        icon="Sparkles"
        title={item.title}
        subtitle={skill.data?.source ?? " "}
      />
      {description ? (
        <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }} selectable>
          {description}
        </Text>
      ) : null}
      <FolderSwitch
        theme={theme}
        title={item.title}
        label={everywhere ? "On everywhere" : "On in this folder"}
        hint={
          everywhere
            ? "Codex turns skills on and off for every folder, not one at a time."
            : `Off: chats here can't use it, and /${item.name} isn't offered.`
        }
        on={on}
        changed={changed}
        onToggle={onToggle}
      />
      {skill.data?.place === "user" ? (
        <CopyToHosts
          theme={theme}
          compact={compact}
          hostId={hostId}
          provider={provider}
          cwd={cwd}
          name={item.name}
          title={item.title}
        />
      ) : null}
      {skill.error ? (
        <Text style={{ color: c.statusDanger, fontSize: 13 }}>{errorText(skill.error)}</Text>
      ) : !skill.data ? (
        // the shape of its path and SKILL.md
        <Pulse label="Reading it…">
          <View style={{ gap: 8 }}>
            <Bone theme={theme} width="45%" height={10} />
            <View
              style={{
                gap: 9,
                padding: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.surface1,
              }}
            >
              {/* a heading, a paragraph, a blank line, another heading and paragraph */}
              {(["35%", "90%", "82%", "60%", "0%", "28%", "86%", "74%"] as const).map((width, n) => (
                <Bone key={n} theme={theme} width={width} height={9} />
              ))}
            </View>
          </View>
        </Pulse>
      ) : skill.data.content ? (
        <View style={{ gap: 8 }}>
          {skill.data.path ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 12, ...MONO }} selectable>
              {skill.data.path}
            </Text>
          ) : null}
          <View
            style={{
              padding: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: c.border,
              backgroundColor: c.surface1,
            }}
          >
            <Markdown>{skillMarkdown(shown.join("\n"))}</Markdown>
          </View>
          {lines.length > shown.length ? (
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                compact={compact}
                label={`Show all ${lines.length} lines`}
                onPress={() => setAll(true)}
              />
            </View>
          ) : null}
          {skill.data.files.length ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }} selectable>
              {`Also in its folder: ${skill.data.files.join(", ")}`}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
          {`${skill.data.source}: it has no file of its own to show.`}
        </Text>
      )}
    </View>
  );
}
