import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginOpenScreenInput, PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { EMPTY_LIBRARY, pushHistory, type Bot } from "../../shared/bot";
import { Avatar, AvatarTheme } from "../Avatar";
import { listBotChats } from "../chat-directory";
import { useBotHost, useChatInvalidation, type LocalHost } from "../data";
import { LibraryNavigation } from "../navigation";
import { nativeTokens, useHover } from "../native";
import { AppsPicker } from "../panel/AppsPicker";
import { Button, CardNote } from "../panel/controls";
import { LibraryPicker } from "../panel/LibraryPicker";
import { chatScreen, libraryScreen } from "../screen-navigation";
import { ui, useTypeScale } from "../typography";
import { MenuProvider } from "../ui/Menu";
import { useTooltipTheme } from "../ui/Tooltip";
import { useBotSettings } from "../useBotSettings";
import { HomeSections, ProgressBar } from "./HomeSections";
import { headerStatus } from "./model";

type Colors = PluginTheme["colors"];
type Props = PluginScreenProps & { openScreen(input: PluginOpenScreenInput): void };

const PAGE = { padding: 16, paddingTop: 24, paddingBottom: 32, width: "100%", maxWidth: 680, alignSelf: "center" } as const;

/**
 * One bot's page (screen "bot-home", params botId and title): who it is and what it's
 * doing, its chats by state, routines, suggested tasks and connectors. Opened from the
 * status sidebar plugin through the bridge; the Bots screen's own list is unchanged.
 */
export function BotHome(props: Props) {
  const { colors } = props.theme;
  useTooltipTheme(colors);
  return (
    <MenuProvider colors={colors} compact={props.layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <HomeContent {...props} />
      </AvatarTheme>
    </MenuProvider>
  );
}

function HomeContent({ theme, layout, host, params, openScreen }: Props) {
  const colors = theme.colors;
  useTypeScale();
  useChatInvalidation();
  const { settings, commit } = useBotSettings();
  const [tab, setTab] = useState<"home" | "connectors">("home");
  const localHost: LocalHost = { id: host.id, label: host.label };
  const botId = params.botId ?? "";
  const bot = settings.status === "ready" ? settings.values.bots.find((entry) => entry.id === botId) : undefined;
  const botHost = useBotHost(bot?.hostId ?? null, localHost);
  const chats = useQuery({
    // Under ["paseo-bots", "chats"] so agent updates refresh it (useChatInvalidation).
    queryKey: ["paseo-bots", "chats", botHost.key, botId, "with-archived"],
    enabled: !!botHost.api && !!bot,
    refetchInterval: botHost.isLocal ? false : 15_000,
    queryFn: ({ signal }) => listBotChats(botHost.api!, botId, signal, true),
  });

  if (settings.status !== "ready" || !bot) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
        <View style={PAGE}><CardNote colors={colors} loading={settings.status === "loading"} text={settings.status === "loading" ? "Loading…" : settings.status === "ready" ? "This bot no longer exists." : "Could not load bot settings."} /></View>
      </View>
    );
  }

  const library = settings.values.library ?? EMPTY_LIBRARY;
  const patch = (change: (saved: Bot) => Partial<Bot>) =>
    void commit((current) => {
      const saved = current.bots.find((entry) => entry.id === bot.id);
      if (!saved) return current;
      return { ...current, bots: current.bots.map((entry) => (entry.id === bot.id ? { ...entry, ...change(saved), updatedAt: new Date().toISOString() } : entry)), history: pushHistory(current.history, saved) };
    });
  const status = headerStatus(chats.data ?? []);
  const name = bot.name || "Untitled bot";

  return (
    <LibraryNavigation.Provider value={(target = null) => openScreen(libraryScreen(target, target && "id" in target ? library.mcpServers.find((server) => server.id === target.id)?.name : undefined))}>
      <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={PAGE} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: layout.compact ? "column" : "row", alignItems: layout.compact ? "stretch" : "center", gap: 16, marginBottom: 20 }}>
          <View style={{ flex: layout.compact ? undefined : 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 16 }}>
            <Avatar avatar={bot.avatar} size={48} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text numberOfLines={1} style={{ fontSize: ui(22), fontWeight: "500", color: colors.foreground }}>{name}</Text>
              {bot.title.trim() ? <Text numberOfLines={1} style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{bot.title}</Text> : null}
              {status ? (
                <View style={{ gap: 4, marginTop: 2 }}>
                  <Text numberOfLines={1} style={{ fontSize: ui(13), color: nativeTokens(colors).statusDotRunning }}>{status.text}</Text>
                  {status.progress !== null ? <ProgressBar colors={colors} progress={status.progress} /> : null}
                </View>
              ) : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button colors={colors} variant="default" icon="Plus" label="New chat" onPress={() => openScreen(chatScreen({ botId: bot.id, chatId: null }, name))} />
            <Button colors={colors} icon="Settings" label="Settings" onPress={() => openScreen({ screenId: "bot-settings", params: { botId: bot.id, section: "", title: `${name} settings` } })} />
          </View>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 20 }}>
          <Tab colors={colors} label="Home" active={tab === "home"} onPress={() => setTab("home")} />
          <Tab colors={colors} label="Connectors" active={tab === "connectors"} onPress={() => setTab("connectors")} />
          <Tab colors={colors} label="Chats" link onPress={() => openScreen({ screenId: "bots", params: { botId: bot.id } })} />
          <Tab colors={colors} label="Automations" link onPress={() => openScreen({ screenId: "bot-routines", params: { botId: bot.id } })} />
          <Tab colors={colors} label="Memory" link onPress={() => openScreen({ screenId: "bot-section", params: { botId: bot.id, section: "memory", title: "Memory" } })} />
        </View>
        {tab === "home" ? (
          <HomeSections colors={colors} bot={bot} chats={chats.data} local={botHost.isLocal} openScreen={openScreen} addRoutine={(routine) => patch((saved) => ({ routines: [...saved.routines, routine] }))} />
        ) : (
          <>
            <LibraryPicker colors={colors} bot={bot} library={library} onPatch={(change) => patch(() => change)} kind="mcp" title="MCP servers" info="Servers from Skills & Tools this bot gets in every new chat. Add servers in Skills & Tools." />
            <AppsPicker colors={colors} bot={bot} localHost={localHost} onPatch={(change) => patch(() => change)} />
          </>
        )}
      </ScrollView>
    </LibraryNavigation.Provider>
  );
}

/** A page tab; `link` ones open another screen. */
function Tab({ colors, label, active, link, onPress }: { colors: Colors; label: string; active?: boolean; link?: boolean; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  const tint = active || hovered ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole={link ? "link" : "tab"}
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={label}
      onPress={onPress}
      {...hoverProps}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 8, paddingHorizontal: 10, marginBottom: -1, borderBottomWidth: 2, borderBottomColor: active ? colors.accent : "transparent" }}
    >
      <Text style={{ fontSize: ui(14), color: tint }}>{label}</Text>
      {link ? <Icon name="ArrowUpRight" size={12} color={tint} /> : null}
    </Pressable>
  );
}
