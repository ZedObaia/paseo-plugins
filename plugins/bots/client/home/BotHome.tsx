import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginOpenScreenInput, PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { EMPTY_LIBRARY, type Bot } from "../../shared/bot";
import { Avatar, AvatarTheme } from "../Avatar";
import { listBotChats } from "../chat-directory";
import { useBotHost, useChatInvalidation, type LocalHost } from "../data";
import { LibraryNavigation } from "../navigation";
import { nativeTokens, useHover } from "../native";
import { AppsPicker } from "../panel/AppsPicker";
import { Button, CardNote } from "../panel/controls";
import { LibraryPicker } from "../panel/LibraryPicker";
import { chatScreen } from "../screen-navigation";
import { ui, useTypeScale } from "../typography";
import { MenuProvider } from "../ui/Menu";
import { useTooltipTheme } from "../ui/Tooltip";
import { useBotSettings } from "../useBotSettings";
import { saveBot } from "./editor";
import { BotInfo, HomeSections, ProgressBar } from "./HomeSections";
import { botLibraryScreen } from "./LibraryPage";
import { headerStatus } from "./model";

type Colors = PluginTheme["colors"];
type Navigation = PluginScreenProps["navigation"];

export interface BotPageActions {
  openScreen(input: PluginOpenScreenInput): void;
  /** Puts the bot's panel in that workspace's right sidebar. */
  openPanel(workspaceId: string): void;
}

type Props = PluginScreenProps & BotPageActions;

/** Beside the page from this width; below it on narrower screens. */
const TWO_COLUMNS = 1000;
const RAIL = 320;

/** The bot's chats, archived included, refreshed as Paseo's agents change. */
export function useBotChats(bot: Bot | undefined, localHost: LocalHost) {
  const botHost = useBotHost(bot?.hostId ?? null, localHost);
  const chats = useQuery({
    // Under ["paseo-bots", "chats"] so agent updates refresh it (useChatInvalidation).
    queryKey: ["paseo-bots", "chats", botHost.key, bot?.id ?? "", "with-archived"],
    enabled: !!botHost.api && !!bot,
    refetchInterval: botHost.isLocal ? false : 15_000,
    queryFn: ({ signal }) => listBotChats(botHost.api!, bot!.id, signal, true),
  });
  return { botHost, chats };
}

/** Opens a bot's chat in Paseo's own chat view, in the bot's workspace; Fawzy's chat screen on older hosts. */
export function chatOpener(navigation: Navigation, openScreen: (input: PluginOpenScreenInput) => void, bot: Bot, localHostId: string) {
  return (chatId: string) =>
    navigation ? navigation.openAgent({ agentId: chatId, serverId: bot.hostId ?? localHostId }) : openScreen(chatScreen({ botId: bot.id, chatId }, bot.name));
}

/**
 * One bot's home (screen "bot-home", params botId, title and optionally tab): who it is, New chat,
 * its chats by state and suggested tasks, with what it has been doing beside them. Chats open in
 * Paseo's own view.
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

function HomeContent({ theme, host, params, navigation, openScreen }: Props) {
  const colors = theme.colors;
  useTypeScale();
  useChatInvalidation();
  const { settings, commit } = useBotSettings();
  const [tab, setTab] = useState<"home" | "connectors">(params.tab === "connectors" ? "connectors" : "home");
  const [width, setWidth] = useState(0);
  const localHost: LocalHost = { id: host.id, label: host.label };
  const botId = params.botId ?? "";
  const bot = settings.status === "ready" ? settings.values.bots.find((entry) => entry.id === botId) : undefined;
  const { botHost, chats } = useBotChats(bot, localHost);

  if (settings.status !== "ready" || !bot) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
        <View style={{ padding: 16, paddingTop: 24, width: "100%", maxWidth: 680, alignSelf: "center" }}>
          <CardNote colors={colors} loading={settings.status === "loading"} text={settings.status === "loading" ? "Loading…" : settings.status === "ready" ? "This bot no longer exists." : "Could not load bot settings."} />
        </View>
      </View>
    );
  }

  const library = settings.values.library ?? EMPTY_LIBRARY;
  const name = bot.name || "Untitled bot";
  const status = headerStatus(chats.data ?? []);
  const wide = width >= TWO_COLUMNS;
  const openChat = chatOpener(navigation, openScreen, bot, host.id);
  const info = (
    <BotInfo
      colors={colors}
      bot={bot}
      chats={chats.data}
      library={library}
      local={botHost.isLocal}
      openChat={openChat}
      openScreen={openScreen}
      addRoutine={(routine) => void saveBot(commit, bot.id, (saved) => ({ routines: [...saved.routines, routine] }))}
      onConnectors={() => setTab("connectors")}
    />
  );

  return (
    <LibraryNavigation.Provider value={(target = null) => openScreen(botLibraryScreen(target, library, bot))}>
      <View style={{ flex: 1, backgroundColor: colors.surface0 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingTop: 24, paddingBottom: 32, width: "100%", maxWidth: wide ? 680 + 40 + RAIL : 680, alignSelf: "center", flexDirection: wide ? "row" : "column", alignItems: "flex-start", gap: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ flex: wide ? 1 : undefined, width: wide ? undefined : "100%", minWidth: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 20 }}>
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
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button colors={colors} variant="default" icon="Plus" label="New chat" onPress={() => openScreen({ screenId: "bot-new-chat", params: { botId: bot.id, title: name } })} />
                <Button colors={colors} icon="Settings" label="Settings" onPress={() => openScreen({ screenId: "bot-settings", params: { botId: bot.id, title: `${name} settings` } })} />
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 4, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 20 }}>
              <Tab colors={colors} label="Home" active={tab === "home"} onPress={() => setTab("home")} />
              <Tab colors={colors} label="Connectors" active={tab === "connectors"} onPress={() => setTab("connectors")} />
            </View>
            {tab === "home" ? (
              <HomeSections colors={colors} bot={bot} chats={chats.data} local={botHost.isLocal} openChat={openChat} />
            ) : (
              <>
                <LibraryPicker colors={colors} bot={bot} library={library} onPatch={(change) => void saveBot(commit, bot.id, () => change)} kind="mcp" title="MCP servers" info="Servers from Skills & Tools this bot gets in every new chat. Add servers in Skills & Tools." />
                <AppsPicker colors={colors} bot={bot} localHost={localHost} onPatch={(change) => void saveBot(commit, bot.id, () => change)} />
              </>
            )}
          </View>
          <View style={{ width: wide ? RAIL : "100%" }}>{info}</View>
        </ScrollView>
      </View>
    </LibraryNavigation.Provider>
  );
}

function Tab({ colors, label, active, onPress }: { colors: Colors; label: string; active: boolean; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      {...hoverProps}
      style={{ paddingVertical: 8, paddingHorizontal: 10, marginBottom: -1, borderBottomWidth: 2, borderBottomColor: active ? colors.accent : "transparent" }}
    >
      <Text style={{ fontSize: ui(14), color: active || hovered ? colors.foreground : colors.foregroundMuted }}>{label}</Text>
    </Pressable>
  );
}
