// The Bots section: each Fawzy bot with its chats underneath. Chats are Paseo agents labelled with
// their bot's id; the bots themselves (names, avatars) and their screens come from the Fawzy
// plugin through the bridge it puts on globalThis, since one plugin can't open another's screens.

import { useEffect, useState, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { useAgent, useAgents, useWorkspace, type AgentRef, type Group } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PressState } from "./menu";
import { BOT_LABEL, agentAttention, chatTitle, compactTimeAgo, type AttentionReason } from "./model";
import { ProgressLine, useAgentProgress } from "./progress";
import { NeedsInputIcon, PlainRow, ProjectIcon, StatusRing, useSidebar } from "./rows";
import { useUi } from "./styles";

/** What Fawzy's client/bridge.ts registers; kept in step with it by hand. */
interface FawzyBridge {
  readonly version: 1;
  listBots(): Promise<readonly { id: string; name: string; avatar: unknown }[]>;
  openBot(botId: string): void;
  openChat(botId: string, chatId: string): void;
  newChat(botId: string): void;
  /** Newer Fawzy only. */
  newBot?(): void;
  Avatar: ComponentType<{ avatar: unknown; size: number; dark?: boolean }>;
}

export interface Bot {
  id: string;
  name: string | null;
  avatar: unknown;
  bridge: FawzyBridge | null;
}

function bridges(): FawzyBridge[] {
  const set = (globalThis as { __fawzyBridges?: Set<FawzyBridge> }).__fawzyBridges;
  return set ? [...set].filter((bridge) => bridge.version === 1) : [];
}

/** Fawzy's bots, then any bot that has chats but no Fawzy loaded for it. */
export function useBots(): { bots: Bot[]; chats: readonly Group<AgentRef>[] } {
  const [listed, setListed] = useState<Bot[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all(
        bridges().map((bridge) =>
          bridge.listBots().then(
            (bots) => bots.map((bot) => ({ ...bot, bridge })),
            () => [],
          ),
        ),
      ).then((lists) => live && setListed(lists.flat()));
    void load();
    // ponytail: polls; Fawzy loads after us and bots change rarely. A bridge event would replace it.
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const chats = useAgents({
    where: (agent) => Boolean(agent.labels[BOT_LABEL]) && !agent.background,
    orderBy: ["lastActivityAt", "desc"],
    groupBy: (agent) => agent.labels[BOT_LABEL] ?? "",
  });
  const known = new Set(listed.map((bot) => bot.id));
  const orphans = chats
    .filter((group) => !known.has(group.key))
    .map((group) => ({ id: group.key, name: null, avatar: null, bridge: null }));
  return { bots: [...listed, ...orphans], chats };
}

export function BotsSection({ bots, chats }: { bots: readonly Bot[]; chats: readonly Group<AgentRef>[] }) {
  return (
    <View>
      {bots.map((bot) => (
        <BotBlock key={bot.id} bot={bot} refs={chats.find((group) => group.key === bot.id)?.items ?? []} />
      ))}
    </View>
  );
}

const ATTENTION_TONES = (p: ReturnType<typeof useUi>["p"]): Record<AttentionReason, string> => ({
  needs_input: p.dot.needs_input,
  failed: p.dot.failed,
  attention: p.dot.attention,
});

export function BotAvatar({ bot, size, fallbackName }: { bot: Bot; size: number; fallbackName: string }) {
  const { p } = useUi();
  if (bot.bridge && bot.avatar) {
    const Avatar = bot.bridge.Avatar;
    return <Avatar avatar={bot.avatar} size={size} dark={p.dark} />;
  }
  return <ProjectIcon name={fallbackName} viewKey={bot.id} size={size} fontSize={Math.round(size * 0.5)} />;
}

function BotBlock({ bot, refs }: { bot: Bot; refs: readonly AgentRef[] }) {
  const { s, c, p, touch } = useUi();
  const { view, prefs, toggleCollapsed } = useSidebar();
  const [hovered, setHovered] = useState(false);
  const [more, setMore] = useState(false);
  // Fawzy opens its screens itself; close the phone's sidebar drawer as Paseo's own links do, or the
  // screen opens behind it. New chat opens the bot's home ready to type.
  const openBot = () => {
    bot.bridge?.openBot(bot.id);
    view.dismiss();
  };
  const newChat = () => {
    bot.bridge?.newChat(bot.id);
    view.dismiss();
  };
  const latest = useAgent(refs[0] ?? "");
  const home = useWorkspace(latest?.workspace ?? "");
  const name = bot.name ?? home?.name ?? "Bot";
  const collapsed = prefs.collapsed.includes(`bot:${bot.id}`);
  const toggle = () => toggleCollapsed(`bot:${bot.id}`);
  // The bot's own line: its busiest chat's progress.
  const busy = useAgents({
    where: (agent) => agent.labels[BOT_LABEL] === bot.id && agent.status === "running",
    orderBy: ["lastActivityAt", "desc"],
  });
  const progress = useAgentProgress(useAgent(busy[0] ?? ""));
  const waiting = useAgents({
    where: (agent) => agent.labels[BOT_LABEL] === bot.id && agent.requiresAttention,
    groupBy: (agent) => agentAttention(agent) ?? "attention",
  });
  const tones = ATTENTION_TONES(p);
  const badge = (["needs_input", "failed", "attention"] as const).find((reason) =>
    waiting.some((group) => group.key === reason),
  );
  const limit = 3;
  const visible = more ? refs : refs.slice(0, limit);
  const actions = hovered || touch;
  return (
    <View style={s.blockExpanded}>
      <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
        {/* Like a project row: it folds the bot's chats, and its avatar turns into the chevron on hover. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={`${name}, ${refs.length} ${refs.length === 1 ? "chat" : "chats"}`}
          onPress={toggle}
          style={({ pressed }) => [s.botRow, hovered && s.hover, pressed && s.pressed]}
        >
          <View style={s.botLeading}>
            {hovered && !touch ? (
              <View style={s.botChevron}>
                <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={14} color={c.foregroundMuted} />
              </View>
            ) : (
              <>
                <BotAvatar bot={bot} size={20} fallbackName={name} />
                {badge ? (
                  <View style={[s.badge, { backgroundColor: p.sidebar }]}>
                    <View style={[s.dot, { backgroundColor: tones[badge] }]} />
                  </View>
                ) : null}
              </>
            )}
          </View>
          <View style={s.column}>
            <View style={s.titleRow}>
              <Text numberOfLines={1} style={[s.botName, hovered && s.titleHovered]}>
                {name}
              </Text>
              {actions && bot.bridge ? (
                <View style={s.projectActions}>
                  <IconButton icon="House" label={`Open ${name}'s home`} onPress={openBot} />
                  <IconButton icon="Plus" label={`New chat with ${name}`} onPress={newChat} />
                </View>
              ) : latest ? (
                <Text style={s.timestamp}>{compactTimeAgo(latest.lastActivityAt, Date.now())}</Text>
              ) : null}
            </View>
            {progress ? <ProgressLine progress={progress} /> : null}
          </View>
        </Pressable>
      </View>
      {collapsed ? null : (
        <>
          {visible.map((ref) => (
            <ChatRow key={ref.key} reference={ref} bot={bot} />
          ))}
          {refs.length > limit ? (
            <PlainRow
              icon={more ? "ChevronUp" : "ChevronDown"}
              label={more ? "Show less" : `Show ${refs.length - limit} more`}
              indented
              onPress={() => setMore((value) => !value)}
            />
          ) : null}
          {!refs.length && bot.bridge ? (
            <PlainRow icon="Plus" label="New chat" indented onPress={newChat} />
          ) : null}
        </>
      )}
    </View>
  );
}

/** Fawzy's New bot page, from the Bots header. */
export function NewBotButton({ bots }: { bots: readonly Bot[] }) {
  const { s, c } = useUi();
  const { view } = useSidebar();
  const bridge = bots.find((bot) => bot.bridge?.newBot)?.bridge;
  if (!bridge?.newBot) return null;
  const newBot = bridge.newBot;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New bot"
      onPress={() => {
        newBot();
        view.dismiss();
      }}
      style={(state: PressState) => [s.bell, state.hovered && s.hover]}
    >
      {(state: PressState) => (
        <Icon name="Plus" size={14} color={state.hovered ? c.foreground : c.foregroundMuted} />
      )}
    </Pressable>
  );
}

function IconButton({ icon, label, onPress }: { icon: string; label: string; onPress(): void }) {
  const { s, c } = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={(state: PressState) => [s.iconAction, (state.hovered || state.pressed) && s.hover]}
    >
      {(state: PressState) => (
        <Icon
          name={icon}
          size={15}
          color={state.hovered || state.pressed ? c.foreground : c.foregroundMuted}
        />
      )}
    </Pressable>
  );
}

/** One chat: its state, title and age; the bot's progress under it while it runs. */
export function ChatRow({
  reference,
  bot,
  withBot = false,
}: {
  reference: AgentRef;
  bot: Bot | null;
  /** The bell's list leads with the bot and says why it is there. */
  withBot?: boolean;
}) {
  const { s, c, p, iconSm } = useUi();
  const { view } = useSidebar();
  const agent = useAgent(reference);
  const progress = useAgentProgress(agent);
  const home = useWorkspace(agent?.workspace ?? "");
  const [hovered, setHovered] = useState(false);
  if (!agent) return null;
  const reason = agentAttention(agent);
  const tones = ATTENTION_TONES(p);
  const botName = bot?.name ?? home?.name ?? "Bot";
  let mark;
  if (agent.status === "running") mark = <StatusRing />;
  else if (reason === "needs_input") mark = <NeedsInputIcon />;
  else if (reason) mark = <View style={[s.dot, { backgroundColor: tones[reason] }]} />;
  else mark = <Icon name="MessageSquare" size={iconSm} color={c.foregroundMuted} />;
  // In Paseo's own chat view, inside the bot's workspace, like any other agent.
  const open = () => view.navigation.openAgent(reference);
  const selected = view.active.agent?.key === reference.key;
  const reasonLabel =
    reason === "needs_input" ? "Needs input" : reason === "failed" ? "Failed" : "Ready to review";
  return (
    <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={[botName, chatTitle(agent.title), reason ? reasonLabel : null]
          .filter(Boolean)
          .join(", ")}
        onPress={open}
        style={({ pressed }) => [
          s.workspaceRow,
          !withBot && s.chatIndent,
          hovered && s.hover,
          selected && s.selected,
          pressed && s.pressed,
        ]}
      >
        <View style={s.workspaceMain}>
          <View style={s.leadingSlot}>
            {withBot && bot ? (
              <View style={s.iconBox}>
                <BotAvatar bot={bot} size={16} fallbackName={botName} />
                {reason ? (
                  <View style={[s.badge, { backgroundColor: p.sidebar }]}>
                    {reason === "needs_input" ? (
                      <NeedsInputIcon />
                    ) : (
                      <View style={[s.dot, { backgroundColor: tones[reason] }]} />
                    )}
                  </View>
                ) : null}
              </View>
            ) : (
              mark
            )}
          </View>
          <View style={s.column}>
            <View style={s.titleRow}>
              <Text numberOfLines={1} style={[s.title, hovered && s.titleHovered]}>
                {chatTitle(agent.title)}
              </Text>
              <Text style={s.timestamp}>{compactTimeAgo(agent.lastActivityAt, Date.now())}</Text>
            </View>
            {withBot ? (
              <Text numberOfLines={1} style={s.metaText}>
                {botName}
                {reason ? <Text style={{ color: tones[reason] }}>{` · ${reasonLabel}`}</Text> : null}
              </Text>
            ) : null}
            {progress ? <ProgressLine progress={progress} /> : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}
