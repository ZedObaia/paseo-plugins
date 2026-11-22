import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsCard, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { Bot, Library, Routine } from "../../shared/bot";
import { displayTitle } from "../../shared/chat";
import { suggestionDismissRpc, suggestionStartRpc, suggestionsListRpc } from "../../shared/fawzy-rpc";
import type { Proposal } from "../../shared/proposals";
import { describeSchedule } from "../../shared/routines";
import { routineRunNowRpc } from "../../shared/rpc";
import { BUCKET_LABELS, chatBucket } from "../../shared/sidebar";
import { botStatusOf } from "../../shared/status";
import { relativeTime } from "../../shared/time";
import { ChatStatusSlot } from "../BotSidebar";
import type { PaseoAgent } from "../paseo";
import { Button, CardNote, PressableRow, RowText, SectionLink } from "../panel/controls";
import { errorText, nativeTokens, useHover } from "../native";
import { ui } from "../typography";
import { useMenu } from "../ui/Menu";
import { tooltip } from "../ui/Tooltip";
import { useMemoryJournal } from "../panel/MemoryActivity";
import { recentActivity, splitChats, type ActivityItem } from "./model";
import { newRoutineEntries } from "./presets";

type Colors = PluginTheme["colors"];

interface HomeProps {
  colors: Colors;
  bot: Bot;
  chats: readonly PaseoAgent[] | undefined;
  /** Routines and suggestions live on the host that stores the bot. */
  local: boolean;
  /** In Paseo's own chat view. */
  openChat(chatId: string): void;
}

const RECENT_STEP = 10;

/** The bot page's Home tab: chats by state and suggested tasks. */
export function HomeSections({ colors, bot, chats, local, openChat }: HomeProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({ closed: false });
  const [recentShown, setRecentShown] = useState(RECENT_STEP);
  const { inProgress, recent, closed } = splitChats(chats ?? []);
  const section: SectionFn = (id, title, count, children, trailing) => (
    <Section key={id} colors={colors} title={title} count={count} open={open[id] ?? true} onToggle={() => setOpen({ ...open, [id]: !(open[id] ?? true) })} trailing={trailing}>
      {children}
    </Section>
  );
  const rows = (list: readonly PaseoAgent[], empty: string) => (
    <SettingsCard>
      {chats === undefined ? <CardNote colors={colors} loading text="Loading chats…" /> : list.length === 0 ? <CardNote colors={colors} text={empty} /> : null}
      {list.map((chat) => <ChatRow key={chat.id} colors={colors} chat={chat} onPress={() => openChat(chat.id)} />)}
    </SettingsCard>
  );
  return (
    <>
      {section("progress", "In progress", inProgress.length, rows(inProgress, "Nothing running"))}
      {section("recent", "Recent", recent.length, <>
        {rows(recent.slice(0, recentShown), "No chats yet")}
        {recent.length > recentShown ? <MoreLink colors={colors} label={`Show more (${recent.length - recentShown})`} onPress={() => setRecentShown(recentShown + RECENT_STEP * 2)} /> : null}
      </>)}
      {closed.length ? section("closed", "Closed", closed.length, rows(closed, "")) : null}
      {local ? <Suggestions colors={colors} bot={bot} openChat={openChat} section={section} /> : null}
    </>
  );
}

type SectionFn = (id: string, title: string, count: number | undefined, children: ReactNode, trailing?: ReactNode) => ReactNode;

interface InfoProps {
  colors: Colors;
  bot: Bot;
  chats: readonly PaseoAgent[] | undefined;
  library: Library;
  local: boolean;
  openChat(chatId: string): void;
  openScreen(input: PluginOpenScreenInput): void;
  addRoutine(routine: Routine): void;
  onConnectors(): void;
}

/** The bot at a glance, beside its page and in Paseo's right sidebar: about, what happened lately, routines, connectors. */
export function BotInfo({ colors, bot, chats, library, local, openChat, openScreen, addRoutine, onConnectors }: InfoProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const journal = useMemoryJournal(bot.id);
  const section: SectionFn = (id, title, count, children, trailing) => (
    <Section key={id} colors={colors} title={title} count={count} open={open[id] ?? true} onToggle={() => setOpen({ ...open, [id]: !(open[id] ?? true) })} trailing={trailing}>
      {children}
    </Section>
  );
  const about = bot.description.trim() || bot.title.trim();
  const facts = [bot.provider, bot.model, bot.cwd].filter(Boolean).join(" · ");
  const activity = recentActivity(bot, chats ?? [], journal.data?.entries ?? []);
  const servers = library.mcpServers.filter((server) => bot.mcpServerIds.includes(server.id));
  const connectors = servers.length + bot.apps.length;
  return (
    <>
      {section("about", "About", undefined, (
        <SettingsCard>
          <View style={{ padding: 16, gap: 6 }}>
            {about ? <Text style={{ fontSize: ui(14), color: colors.foreground }}>{about}</Text> : null}
            <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{facts}</Text>
          </View>
        </SettingsCard>
      ))}
      {section("activity", "Recent activity", undefined, (
        <SettingsCard>
          {chats === undefined ? <CardNote colors={colors} loading text="Loading…" /> : activity.length === 0 ? <CardNote colors={colors} text="Nothing yet" /> : null}
          {activity.map((item) => <ActivityRow key={item.id} colors={colors} item={item} openChat={openChat} />)}
        </SettingsCard>
      ))}
      {local ? <Automations colors={colors} bot={bot} openScreen={openScreen} addRoutine={addRoutine} section={section} /> : null}
      {section("connectors", "Connectors", connectors, (
        <SettingsCard>
          {connectors === 0 ? <CardNote colors={colors} text="None yet" /> : null}
          {servers.map((server) => <InfoRow key={server.id} colors={colors} icon="Server" label={server.name} />)}
          {bot.apps.map((slug) => <InfoRow key={slug} colors={colors} icon="Plug" label={slug.charAt(0).toUpperCase() + slug.slice(1)} />)}
        </SettingsCard>
      ), <SectionLink colors={colors} icon="ArrowUpRight" label="Manage" onPress={onConnectors} />)}
    </>
  );
}

function ActivityRow({ colors, item, openChat }: { colors: Colors; item: ActivityItem; openChat(chatId: string): void }) {
  const hint = `${item.hint} · ${relativeTime(item.at)}`;
  const chatId = item.chatId;
  if (!chatId) return <InfoRow colors={colors} icon={item.icon} label={item.text} hint={hint} />;
  return (
    <PressableRow colors={colors} accessibilityLabel={item.text} onPress={() => openChat(chatId)}>
      {() => (
        <>
          <Icon name={item.icon} size={16} color={colors.foregroundMuted} />
          <RowText colors={colors} label={item.text} hint={hint} />
        </>
      )}
    </PressableRow>
  );
}

function InfoRow({ colors, icon, label, hint }: { colors: Colors; icon: string; label: string; hint?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 16, paddingHorizontal: 16 }}>
      <Icon name={icon} size={16} color={colors.foregroundMuted} />
      <RowText colors={colors} label={label} hint={hint} />
    </View>
  );
}

function Automations({ colors, bot, openScreen, addRoutine, section }: Pick<InfoProps, "colors" | "bot" | "openScreen" | "addRoutine"> & { section: SectionFn }) {
  const runNow = useRpc(routineRunNowRpc);
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState<string | null>(null);
  const routinesScreen = () => openScreen({ screenId: "bot-routines", params: { botId: bot.id, botName: bot.name } });
  // The same run path as the routine's own Run now (RoutinesSection).
  const run = async (routine: Routine) => {
    setStarting(routine.id);
    try {
      const { run: started } = await runNow({ botId: bot.id, routineId: routine.id });
      if (started.status === "running") toast.show(`Started "${routine.name}". It appears as a chat under ${bot.name}.`, { variant: "success" });
      else if (started.status === "skipped-busy") toast.show(`"${routine.name}" is still working on its last run.`);
      else toast.error(started.error ?? "Couldn't start the run.");
      void queryClient.invalidateQueries({ queryKey: ["paseo-bots"] });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setStarting(null);
    }
  };
  const add = (
    <SectionLink
      colors={colors}
      label="Add"
      onPress={(anchor) => (anchor ? menu.open({ anchor, align: "end", width: 260, title: "New routine", entries: newRoutineEntries(bot, addRoutine, routinesScreen) }) : routinesScreen())}
    />
  );
  return section("automations", "Automations", bot.routines.length, (
    <SettingsCard>
      {bot.routines.length === 0 ? <CardNote colors={colors} text="No routines yet" /> : null}
      {bot.routines.map((routine) => (
        <PressableRow key={routine.id} colors={colors} accessibilityLabel={`Open routine ${routine.name}`} onPress={routinesScreen}>
          {() => (
            <>
              <Icon name="CalendarClock" size={16} color={colors.foregroundMuted} />
              <RowText colors={colors} label={routine.name || "Untitled routine"} hint={[describeSchedule(routine.schedule), routine.enabled ? null : "Paused"].filter(Boolean).join(" · ")} />
              <Button colors={colors} size="xs" icon="Play" label="Run now" loading={starting === routine.id} disabled={!routine.prompt.trim()} onPress={() => void run(routine)} />
            </>
          )}
        </PressableRow>
      ))}
    </SettingsCard>
  ), add);
}

const SOURCE_ICONS: Record<string, string> = { github: "GitPullRequest", email: "Mail", calendar: "Calendar", chat: "MessageSquare", server: "Server", web: "Globe", other: "Lightbulb" };

function Suggestions({ colors, bot, openChat, section }: Pick<HomeProps, "colors" | "bot"> & { openChat(chatId: string): void; section: SectionFn }) {
  const list = useRpc(suggestionsListRpc);
  const start = useRpc(suggestionStartRpc);
  const dismiss = useRpc(suggestionDismissRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["paseo-bots", "suggestions", bot.id];
  const suggestions = useQuery({ queryKey: key, queryFn: () => list({ botId: bot.id }), refetchInterval: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
  const items = (suggestions.data?.suggestions ?? []).flatMap((proposal) => (proposal.kind === "task" ? [proposal] : []));
  return section("suggestions", "Suggestions", items.length, (
    <SettingsCard>
      {suggestions.isPending ? <CardNote colors={colors} loading text="Loading…" /> : null}
      {suggestions.isError ? <CardNote colors={colors} text={errorText(suggestions.error)} /> : null}
      {suggestions.isSuccess && items.length === 0 ? <CardNote colors={colors} text="No suggestions. Add the Look around routine to get some." /> : null}
      {items.map((item) => (
        <SuggestionRow
          key={item.id}
          colors={colors}
          item={item}
          busy={busy === item.id}
          onStart={() => void act(item.id, async () => openChat((await start({ id: item.id })).chatId))}
          onDismiss={() => void act(item.id, async () => void (await dismiss({ id: item.id })))}
        />
      ))}
    </SettingsCard>
  ));
}

function SuggestionRow({ colors, item, busy, onStart, onDismiss }: { colors: Colors; item: Extract<Proposal, { kind: "task" }>; busy: boolean; onStart(): void; onDismiss(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 16, paddingHorizontal: 16 }}>
      <Icon name={SOURCE_ICONS[item.data.source] ?? "Lightbulb"} size={16} color={colors.foregroundMuted} />
      <RowText colors={colors} label={item.data.title} hint={item.data.why ?? relativeTime(item.createdAt)} hintLines={2} />
      <Button colors={colors} size="xs" variant="default" label="Start" loading={busy} onPress={onStart} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Dismiss ${item.data.title}`} {...tooltip("Dismiss")} disabled={busy} hitSlop={8} onPress={onDismiss} {...hoverProps} style={{ padding: 4, borderRadius: 4, backgroundColor: hovered ? colors.surface2 : "transparent" }}>
        <Icon name="X" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

function ChatRow({ colors, chat, onPress }: { colors: Colors; chat: PaseoAgent; onPress(): void }) {
  const bucket = chatBucket(chat);
  const status = chat.archivedAt ? null : botStatusOf(chat.metadata);
  const title = displayTitle(chat.title);
  return (
    <PressableRow colors={colors} accessibilityLabel={title} onPress={onPress}>
      {() => (
        <>
          <ChatStatusSlot colors={colors} tokens={nativeTokens(colors)} bucket={bucket} />
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <RowText colors={colors} label={title} hint={status?.text ?? (bucket === "done" ? null : BUCKET_LABELS[bucket])} />
            {status?.progress != null ? <ProgressBar colors={colors} progress={status.progress} /> : null}
          </View>
          <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{relativeTime(chat.updatedAt)}</Text>
        </>
      )}
    </PressableRow>
  );
}

export function ProgressBar({ colors, progress }: { colors: Colors; progress: number }) {
  const tokens = nativeTokens(colors);
  return (
    <View accessibilityLabel={`${Math.round(progress * 100)}% done`} style={{ height: 3, maxWidth: 240, borderRadius: 2, overflow: "hidden", backgroundColor: tokens.surface3 }}>
      <View style={{ width: `${Math.round(progress * 100)}%`, height: "100%", backgroundColor: tokens.statusDotRunning }} />
    </View>
  );
}

/** A collapsible group: chevron, title and count, with an optional action on the right. */
function Section({ colors, title, count, open, onToggle, trailing, children }: { colors: Colors; title: string; count?: number; open: boolean; onToggle(): void; trailing?: ReactNode; children: ReactNode }) {
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ marginBottom: open ? 24 : 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: open ? 8 : 0, paddingHorizontal: 4 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={onToggle} {...hoverProps} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
          <Text style={{ fontSize: ui(14), fontWeight: "500", color: colors.foreground }}>{title}</Text>
          {count === undefined ? null : <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{count}</Text>}
        </Pressable>
        {trailing}
      </View>
      {open ? children : null}
    </View>
  );
}

function MoreLink({ colors, label, onPress }: { colors: Colors; label: string; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} {...hoverProps} style={{ alignSelf: "center", paddingVertical: 8, paddingHorizontal: 12 }}>
      <Text style={{ fontSize: ui(13), color: hovered ? colors.foreground : colors.foregroundMuted }}>{label}</Text>
    </Pressable>
  );
}
