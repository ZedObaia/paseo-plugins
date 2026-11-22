import type { PluginTheme } from "@getpaseo/plugin";
import {
  openExternalUrl,
  useAgent,
  useRpc,
  useWorkspace,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { applyRpc, loginRpc, restoreRpc, trustRpc, type Change, type Provider } from "../shared/contracts";
import { AGENT_NAMES, buildItems, groupSkills, plural, setSource, type Item } from "../shared/items";
import { AddConnector } from "./add";
import { ConnectorDetail, SkillDetail } from "./detail";
import {
  errorText,
  useChats,
  useCommands,
  useInvalidate,
  useInvalidateFolder,
  useListing,
  type Chat,
} from "./data";
import { usePreferredChat } from "./focus";
import { SignIn, type SigningIn } from "./signin";
import {
  Bone,
  Button,
  GroupLabel,
  IconButton,
  Pulse,
  Row,
  Section,
  Segments,
  SetRow,
  SkeletonRows,
  faint,
  sizes,
} from "./ui";

const KINDS = [
  { kind: "connector", label: "Connectors", icon: "Plug" },
  { kind: "skill", label: "Skills", icon: "Sparkles" },
  { kind: "plugin", label: "Plugins", icon: "Puzzle" },
] as const;

type Pending = Change & { title: string; restarts: boolean; set?: string };
type Filter = "all" | Change["kind"];

const keyOf = (i: { kind: string; name: string }) => `${i.kind}\n${i.name}`;

function Note({ theme, text }: { theme: PluginTheme; text: string }) {
  return (
    <View style={{ flex: 1, padding: 16, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{text}</Text>
    </View>
  );
}

/**
 * The skills, connectors and plugins of a workspace's Claude, Codex and OpenCode chats, as a workspace tab or
 * in the Explorer. It shows the chat it was opened from (Command Center, /toolbox), else the most
 * recent; picking an agent at its top shows that agent's most recent chat, or none.
 */
export function ToolboxPanel(props: PluginWorkspacePanelProps) {
  const { theme, host, workspaceId } = props;
  const cwd = useWorkspace(workspaceId, (w) => w.directory);
  const chats = useChats(host.id, workspaceId);
  const preferred = usePreferredChat(workspaceId);
  const [picked, setPicked] = useState<string | null>(null);
  // the agent picked at the top, over the chat's own
  const [agent, setAgent] = useState<Provider | null>(null);
  // opening it from another chat shows that chat
  useEffect(() => {
    setPicked(null);
    setAgent(null);
  }, [preferred]);
  if (!cwd) return <Note theme={theme} text="Loading this workspace…" />;
  const list = chats.data ?? [];
  const shown =
    [picked, preferred].map((id) => list.find((c) => c.id === id)).find(Boolean) ?? list[0] ?? null;
  const provider = agent ?? shown?.provider ?? "claude";
  // the agent's own chat: the one shown, else its most recent
  const chat = shown?.provider === provider ? shown : (list.find((c) => c.provider === provider) ?? null);
  return (
    <Toolbox
      {...props}
      // a fresh panel per folder and agent: pending switches belong to one of each
      key={`${provider}\n${cwd}`}
      cwd={cwd}
      provider={provider}
      agentId={chat?.id ?? null}
      chats={list}
      chatsLoading={chats.isLoading}
      onPick={(id) => {
        setPicked(id);
        setAgent(null);
      }}
      onProvider={setAgent}
    />
  );
}

function Toolbox({
  theme,
  layout,
  host,
  cwd,
  provider,
  agentId,
  chats,
  chatsLoading,
  onPick,
  onProvider,
}: PluginWorkspacePanelProps & {
  cwd: string;
  provider: Provider;
  agentId: string | null;
  chats: Chat[];
  chatsLoading: boolean;
  onPick(id: string): void;
  onProvider(provider: Provider): void;
}) {
  const c = theme.colors;
  const compact = layout.compact;
  const toast = useToast();
  const status = useAgent(agentId ?? "", (a) => a.status);
  const agentName = AGENT_NAMES[provider];
  const listing = useListing(host.id, provider, cwd);
  // Claude's skills are the chat's own; Codex lists them for the folder
  const commands = useCommands(host.id, agentId, provider === "claude");
  const invalidate = useInvalidate(host.id, provider, cwd, agentId);
  const invalidateFolder = useInvalidateFolder(host.id, cwd);
  const apply = useRpc(applyRpc);
  const login = useRpc(loginRpc);
  const restore = useRpc(restoreRpc);
  const trust = useRpc(trustRpc);

  const [pending, setPending] = useState<Record<string, Pending>>({});
  // applied, until the agent's next listing shows it: checking connectors again takes seconds
  const [applied, setApplied] = useState<Record<string, Pending>>({});
  // the chat needs a restart for a sign-in or a removal: "Restart to use Linear"
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const [signing, setSigning] = useState<SigningIn | null>(null);
  const [open, setOpen] = useState<{ kind: Change["kind"]; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removed, setRemoved] = useState<{ title: string; undoId: string } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // sets of skills showing their skills, by source
  const [openSets, setOpenSets] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [applying, setApplying] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const lists = useMemo(
    () => (listing.data ? buildItems(provider, listing.data, commands.data) : null),
    [provider, listing.data, commands.data],
  );
  useEffect(() => {
    if (!lists) return;
    const now = new Map([...lists.connector, ...lists.skill, ...lists.plugin].map((i) => [keyOf(i), i.on]));
    setApplied((prev) => Object.fromEntries(Object.entries(prev).filter(([k, p]) => now.get(k) !== p.on)));
  }, [lists]);
  const changes = Object.values(pending);
  const restarts = Boolean(restartNote) || changes.some((p) => p.restarts);
  const chatBusy = status === "running" || status === "initializing";
  const isOn = (i: Item) => pending[keyOf(i)]?.on ?? applied[keyOf(i)]?.on ?? i.on;
  const q = query.trim().toLowerCase();
  const matches = (i: Item) => !q || i.title.toLowerCase().includes(q) || i.meta.toLowerCase().includes(q);
  const signins = lists?.connector.filter((i) => i.signin).length ?? 0;
  const broken = lists?.connector.filter((i) => i.tone === "danger").length ?? 0;
  // a section's items once they're known: the chats decide which agent is shown, and a Claude
  // chat's own skills can come after the rest
  const listed = (kind: Change["kind"]) =>
    chatsLoading || (kind === "skill" && commands.isLoading) ? undefined : lists?.[kind];

  function setOn(items: Item[], on: boolean) {
    setPending((prev) => {
      const next = { ...prev };
      for (const i of items) {
        if (on === (applied[keyOf(i)]?.on ?? i.on)) delete next[keyOf(i)];
        else
          next[keyOf(i)] = {
            kind: i.kind,
            name: i.name,
            on,
            title: i.title,
            restarts: i.restarts,
            set: i.set?.title,
          };
      }
      return next;
    });
  }
  const toggle = (i: Item) => setOn([i], !isOn(i));

  async function onApply() {
    setApplying(true);
    try {
      const { message } = await apply({
        provider,
        cwd,
        agentId,
        changes: changes.map(({ kind, name, on }) => ({ kind, name, on })),
        restart: Boolean(restartNote),
      });
      toast.show(message, { variant: "success" });
      setApplied((prev) => ({ ...prev, ...pending }));
      setPending({});
      setRestartNote(null);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setApplying(false);
      await invalidate();
    }
  }

  // again: signs it out first, as Claude Code's Re-authenticate does
  async function connect(i: Item, again = false) {
    try {
      const started = await login({ provider, cwd, name: i.name, again });
      setSigning({ name: i.name, title: i.title, ...started });
      // a browser that can't be opened from here still has the button under the row
      if (started.url) await openExternalUrl(started.url).catch(() => {});
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  /**
   * Restarts the chat, which reconnects its connectors and keeps its history: Paseo gives plugins no
   * way to reconnect one connector inside a running chat (Claude refuses `/mcp reconnect` there).
   * Without a chat, checks the connector again here.
   */
  async function reconnect() {
    if (!agentId) return recheck();
    setReconnecting(true);
    try {
      toast.show((await apply({ provider, cwd, agentId, changes: [], restart: true })).message, {
        variant: "success",
      });
      // the restart a sign-in or removal was waiting for
      setRestartNote(null);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setReconnecting(false);
      await invalidate();
    }
  }

  async function recheck() {
    setRechecking(true);
    try {
      await Promise.all([listing.recheck(), agentId ? commands.refetch() : null]);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setRechecking(false);
    }
  }

  async function undoRemove() {
    if (!removed) return;
    try {
      toast.show((await restore({ undoId: removed.undoId })).message, { variant: "success" });
      if (restartNote === `Restart to drop ${removed.title}`) setRestartNote(null);
      setRemoved(null);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      await invalidate();
    }
  }

  const signInFor = (i: Item) =>
    signing?.name === i.name ? (
      <SignIn
        theme={theme}
        compact={compact}
        hostId={host.id}
        signing={signing}
        onEnd={(done, message) => {
          setSigning(null);
          if (!done) return toast.error(`${i.title}: ${message}`);
          toast.show(`${i.title} is connected`, { variant: "success" });
          if (agentId) setRestartNote(`Restart to use ${i.title}`);
          void listing.recheck().catch(() => {});
        }}
      />
    ) : null;

  // a whole set flipped one way reads as the set
  const oneSet =
    changes.length > 1 &&
    changes.every((p) => p.set && p.set === changes[0].set && p.on === changes[0].on) &&
    lists?.skill.filter((i) => i.set?.title === changes[0].set).length === changes.length;
  const barTitle =
    changes.length === 1 && !restartNote
      ? `Turn ${changes[0].title} ${changes[0].on ? "on" : "off"}`
      : oneSet && !restartNote
        ? `Turn ${changes[0].set} ${changes[0].on ? "on" : "off"}`
        : !changes.length && restartNote
          ? restartNote
          : `${changes.length + (restartNote ? 1 : 0)} changes`;
  const barNote = !agentId
    ? `Saved for the ${agentName} chats you start here.`
    : chatBusy
      ? "Apply when the chat finishes its turn."
      : restarts
        ? "Restarts the chat. History stays."
        : "Reloads in place. No restart.";
  const folderName = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  // OpenCode loads its plugins as code, with nothing to switch
  const kinds = KINDS.filter((k) => k.kind !== "plugin" || listing.data?.scopes.plugins !== "none");

  function rows(kind: Change["kind"]) {
    const all = lists?.[kind] ?? [];
    // a set is shown when its name matches, with all its skills
    const setMatches = (i: Item) =>
      !!q && !!i.set && (i.set.title.toLowerCase().includes(q) || i.set.source.toLowerCase().includes(q));
    const shown = all.filter((i) => matches(i) || setMatches(i));
    if (!shown.length)
      return (
        <Text style={{ color: c.foregroundMuted, fontSize: 13, padding: 12 }}>
          {q
            ? "Nothing matches."
            : kind === "skill"
              ? agentId || listing.data?.skills
                ? "No skills of your own here."
                : "Open a Claude chat here to see its skills."
              : "None here."}
        </Text>
      );
    if (kind !== "skill") return shown.map((i, n) => row(kind, i, n === 0));
    // the project's own skills apart from those in every project, each with its own sets
    return [
      { title: "This project", project: true },
      { title: "Every project", project: false },
    ]
      .map((g) => ({ ...g, skills: shown.filter((i) => !!i.project === g.project) }))
      .filter((g) => g.skills.length)
      .map((g, n) => (
        <View key={g.title}>
          <GroupLabel theme={theme} title={g.title} first={n === 0} />
          {skillRows(
            g.skills,
            all.filter((i) => !!i.project === g.project),
          )}
        </View>
      ));
  }

  function skillRows(shown: Item[], all: Item[]) {
    return groupSkills(shown).map((entry, n) => {
      if (!("skills" in entry)) return row("skill", entry, n === 0);
      const members = all.filter((i) => i.set?.source === entry.source);
      const on = members.some(isOn);
      const open = !!q || openSets.has(entry.source);
      const onCount = members.filter(isOn).length;
      return (
        <View key={entry.source}>
          <SetRow
            theme={theme}
            compact={compact}
            first={n === 0}
            title={entry.title}
            meta={[
              onCount === members.length
                ? plural(members.length, "skill")
                : `${onCount} of ${members.length} on`,
              setSource(entry.source),
            ]
              .filter(Boolean)
              .join(" · ")}
            open={open}
            on={on}
            changed={members.some((i) => keyOf(i) in pending)}
            onToggle={() => setOn(members, !on)}
            onPress={() =>
              setOpenSets((prev) => {
                const next = new Set(prev);
                if (!next.delete(entry.source)) next.add(entry.source);
                return next;
              })
            }
          />
          {open ? entry.skills.map((i) => row("skill", i, false, true)) : null}
        </View>
      );
    });
  }

  function row(kind: Change["kind"], i: Item, first: boolean, inset?: boolean) {
    return (
      <Row
        key={keyOf(i)}
        theme={theme}
        compact={compact}
        first={first}
        inset={inset}
        icon={KINDS.find((k) => k.kind === kind)!.icon}
        title={i.title}
        meta={i.meta}
        tone={i.tone}
        on={isOn(i)}
        changed={keyOf(i) in pending}
        onToggle={() => toggle(i)}
        disabled={kind === "connector" && fixed.has(i.name)}
        onOpen={kind === "plugin" ? undefined : () => setOpen({ kind, name: i.name })}
        actions={
          i.signin && signing?.name !== i.name ? (
            <Button
              theme={theme}
              compact={compact}
              label="Connect"
              variant="warning"
              onPress={() => void connect(i)}
            />
          ) : null
        }
      >
        {signInFor(i)}
      </Row>
    );
  }

  // connectors the agent can't turn off for one folder
  const fixed = new Set(listing.data?.connectors.filter((x) => x.fixedBy).map((x) => x.name) ?? []);
  const openItem = open ? lists?.[open.kind].find((i) => i.name === open.name) : undefined;
  const openConnector =
    open?.kind === "connector" ? listing.data?.connectors.find((x) => x.name === open.name) : undefined;

  let body;
  if (adding && listing.data) {
    body = (
      <AddConnector
        theme={theme}
        compact={compact}
        provider={provider}
        agentName={agentName}
        cwd={cwd}
        folderName={folderName}
        addTo={listing.data.addTo}
        taken={listing.data.connectors.map((x) => x.name)}
        onAdded={(name, message, ok) => {
          if (ok) toast.show(message, { variant: "success" });
          else toast.error(message);
          setAdding(false);
          // a chat connects to its servers when it starts
          if (agentId) setRestartNote(`Restart to use ${name}`);
          void invalidateFolder();
        }}
        onBack={() => setAdding(false)}
      />
    );
  } else if (open && openItem && openConnector && listing.data) {
    body = (
      <ConnectorDetail
        theme={theme}
        compact={compact}
        hostId={host.id}
        provider={provider}
        agentName={agentName}
        cwd={cwd}
        connector={openConnector}
        toolsKnown={listing.data.scopes.tools === "listed"}
        item={openItem}
        on={isOn(openItem)}
        changed={keyOf(openItem) in pending}
        onToggle={() => toggle(openItem)}
        signIn={signInFor(openItem)}
        onConnect={() => void connect(openItem)}
        onSignInAgain={() => void connect(openItem, true)}
        onReconnect={() => void reconnect()}
        reconnect={
          !agentId
            ? {
                busy: rechecking,
                hint: "Reconnect checks it again here. Chats you start connect to it themselves.",
              }
            : {
                busy: reconnecting || chatBusy,
                hint: chatBusy
                  ? "Reconnect when the chat finishes its turn."
                  : "Reconnect restarts the chat, which keeps its history: a running chat can't reconnect one connector alone here.",
              }
        }
        onRuleSaved={(restart) => {
          if (restart && agentId) setRestartNote("Restart to use the new tool rules");
        }}
        onRemoved={(undoId) => {
          setOpen(null);
          setRemoved({ title: openItem.title, undoId });
          if (agentId) setRestartNote(`Restart to drop ${openItem.title}`);
          void invalidate();
        }}
        onBack={() => setOpen(null)}
      />
    );
  } else if (open && openItem && open.kind === "skill") {
    body = (
      <SkillDetail
        theme={theme}
        compact={compact}
        hostId={host.id}
        provider={provider}
        everywhere={listing.data?.scopes.skills === "everywhere"}
        cwd={cwd}
        item={openItem}
        description={
          (listing.data?.skills ?? commands.data)?.find((x) => x.name === openItem.name)?.description ?? ""
        }
        on={isOn(openItem)}
        changed={keyOf(openItem) in pending}
        onToggle={() => toggle(openItem)}
        onBack={() => setOpen(null)}
      />
    );
  } else {
    body = (
      <>
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 13 }} numberOfLines={1}>
              {listing.isLoading || rechecking ? "Checking connectors…" : `${agentName} in ${folderName}`}
              {signins ? (
                <Text style={{ color: c.statusWarning }}>{`  ·  ${signins} need sign-in`}</Text>
              ) : null}
              {broken ? <Text style={{ color: c.statusDanger }}>{`  ·  ${broken} broken`}</Text> : null}
            </Text>
            <IconButton
              theme={theme}
              compact={compact}
              icon="RefreshCw"
              label="Check again"
              disabled={rechecking || listing.isLoading}
              onPress={() => void recheck()}
            />
          </View>
          <ChatPicker
            theme={theme}
            compact={compact}
            chats={chats}
            loading={chatsLoading}
            agentId={agentId}
            provider={provider}
            onPick={onPick}
            onProvider={onProvider}
          />
          {listing.data?.notice ? (
            <View
              style={{
                gap: 8,
                padding: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: faint(c.statusWarning, "66"),
                backgroundColor: faint(c.statusWarning, "14"),
              }}
            >
              <Text style={{ color: c.foreground, fontSize: 13 }}>{listing.data.notice.text}</Text>
              {listing.data.notice.action === "trust" ? (
                <View style={{ flexDirection: "row" }}>
                  <Button
                    theme={theme}
                    compact={compact}
                    variant="warning"
                    label={`Trust ${folderName}`}
                    onPress={() =>
                      void trust({ provider, cwd })
                        .then(({ message }) => toast.show(message, { variant: "success" }))
                        .catch((error) => toast.error(errorText(error)))
                        .finally(() => void invalidate())
                    }
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 10,
              minHeight: sizes(compact).control + 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: c.border,
              backgroundColor: c.surface1,
            }}
          >
            <Icon name="Search" size={14} color={c.foregroundMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search skills, connectors and plugins"
              placeholderTextColor={c.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, color: c.foreground, fontSize: 13, paddingVertical: 6 }}
            />
          </View>
          <Segments<Filter>
            theme={theme}
            compact={compact}
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              // counts don't fit a phone's width; each section's title has its own
              ...kinds.map((k) => ({
                value: k.kind,
                label: k.label,
                count: compact ? undefined : listed(k.kind)?.length,
              })),
            ]}
          />
        </View>

        {removed ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingVertical: 6,
              paddingLeft: 12,
              paddingRight: 6,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: c.border,
              backgroundColor: c.surface1,
            }}
          >
            <Text style={{ flex: 1, color: c.foreground, fontSize: 13 }}>{`Removed ${removed.title}.`}</Text>
            <Button theme={theme} compact={compact} label="Undo" onPress={() => void undoRemove()} />
            <Button
              theme={theme}
              compact={compact}
              variant="ghost"
              label="Dismiss"
              onPress={() => setRemoved(null)}
            />
          </View>
        ) : null}

        {listing.error ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: c.statusDanger, fontSize: 13 }}>{errorText(listing.error)}</Text>
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                compact={compact}
                label="Try again"
                onPress={() => void listing.refetch()}
              />
            </View>
          </View>
        ) : null}

        {kinds
          .filter((k) => filter === "all" || filter === k.kind)
          .map((k) => (
            <Section
              key={k.kind}
              theme={theme}
              title={k.label}
              count={listed(k.kind)?.length}
              action={
                k.kind === "connector" && listing.data ? (
                  <Button
                    theme={theme}
                    compact={compact}
                    variant="ghost"
                    icon="Plus"
                    label="Add"
                    onPress={() => setAdding(true)}
                  />
                ) : null
              }
            >
              {!lists && listing.error ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 13, padding: 12 }}>
                  Couldn't read them.
                </Text>
              ) : !listed(k.kind) ? (
                <SkeletonRows
                  theme={theme}
                  compact={compact}
                  label={`Asking ${agentName} for its ${k.label.toLowerCase()}…`}
                />
              ) : k.kind === "skill" && commands.error ? (
                <Text style={{ color: c.statusDanger, fontSize: 13, padding: 12 }}>
                  {`Couldn't read this chat's skills: ${errorText(commands.error)}`}
                </Text>
              ) : (
                rows(k.kind)
              )}
            </Section>
          ))}

        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {listing.data?.scopes.skills === "everywhere"
            ? `Connector switches and tool rules apply to every ${agentName} chat in ${folderName}. ${agentName} turns skills and plugins on and off everywhere. Open a connector or skill for its details.`
            : `Switches apply to every ${agentName} chat in ${folderName}.${listing.data?.scopes.plugins === "none" ? "" : " A plugin's own skills turn on and off with the plugin."} Open a connector or skill for its details.`}
        </Text>
      </>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: compact ? 12 : 16, gap: 18, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
      >
        {body}
      </ScrollView>

      {changes.length || restartNote ? (
        <View
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: 12,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 10,
            paddingLeft: 14,
            paddingRight: 10,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.surface1,
            shadowColor: "#000",
            shadowOpacity: 0.35,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
            elevation: 8,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
              {barTitle}
            </Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={2}>
              {barNote}
            </Text>
          </View>
          <Button
            theme={theme}
            compact={compact}
            variant="ghost"
            label={changes.length ? "Undo" : "Later"}
            disabled={applying}
            onPress={() => (changes.length ? setPending({}) : setRestartNote(null))}
          />
          <Button
            theme={theme}
            compact={compact}
            variant="primary"
            label={applying ? "Applying…" : !agentId ? "Save" : restarts ? "Restart & apply" : "Apply"}
            disabled={applying || chatBusy}
            onPress={() => void onApply()}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Which agent's settings the panel shows, always in view, and which of the workspace's chats it
 * applies to. An agent without a chat here gets what's saved for the chats you start.
 */
function ChatPicker({
  theme,
  compact,
  chats,
  loading,
  agentId,
  provider,
  onPick,
  onProvider,
}: {
  theme: PluginTheme;
  compact: boolean;
  chats: Chat[];
  loading: boolean;
  agentId: string | null;
  provider: Provider;
  onPick(id: string): void;
  onProvider(provider: Provider): void;
}) {
  const c = theme.colors;
  // not the agent switch yet: it would show Claude, then jump to the chat's own agent
  if (loading)
    return (
      <Pulse label="Finding this workspace's chats…">
        <View style={{ gap: 8 }}>
          <Bone theme={theme} width="100%" height={compact ? 42 : 34} radius={8} />
          {/* the chips scroll; their shapes are cut off in a narrow Explorer */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, overflow: "hidden" }}>
            <Bone theme={theme} width={26} height={10} />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Bone theme={theme} width={130} height={compact ? 34 : 26} radius={13} />
              <Bone theme={theme} width={96} height={compact ? 34 : 26} radius={13} />
            </View>
          </View>
        </View>
      </Pulse>
    );
  return (
    <View style={{ gap: 8 }}>
      <Segments<Provider>
        theme={theme}
        compact={compact}
        value={provider}
        onChange={onProvider}
        options={Object.entries(AGENT_NAMES).map(([value, label]) => ({ value: value as Provider, label }))}
      />
      {chats.length ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Chat</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {chats.map((chat) => {
              const selected = chat.id === agentId;
              const color = selected ? c.foreground : c.foregroundMuted;
              return (
                <Pressable
                  key={chat.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${chat.title}, ${AGENT_NAMES[chat.provider]} chat`}
                  onPress={() => onPick(chat.id)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    maxWidth: 240,
                    minHeight: compact ? 34 : 26,
                    paddingHorizontal: 10,
                    borderRadius: 13,
                    borderWidth: 1,
                    borderColor: selected ? faint(c.accent, "99") : c.border,
                    backgroundColor: selected ? faint(c.accent, "33") : "transparent",
                  }}
                >
                  <Icon name="MessageSquare" size={12} color={color} />
                  <Text style={{ color, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                    {chat.title}
                  </Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{AGENT_NAMES[chat.provider]}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      {agentId ? null : (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {`No ${AGENT_NAMES[provider]} chat in this workspace yet. What you change here is saved for the ones you start.`}
        </Text>
      )}
    </View>
  );
}
