import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginOpenScreenInput, PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type TextInput as NativeTextInput } from "react-native";
import { EMPTY_LIBRARY, type Bot } from "../../shared/bot";
import { chatStartRpc } from "../../shared/fawzy-rpc";
import { Avatar, AvatarTheme } from "../Avatar";
import { listBotChats } from "../chat-directory";
import { isImeComposing, type ComposerKeyEvent } from "../chat/composer/logic";
import { useBotHost, useChatInvalidation, type LocalHost } from "../data";
import { LibraryNavigation } from "../navigation";
import { errorText, nativeTokens, useHover } from "../native";
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
 * One bot's home (screen "bot-home", params botId and title, compose to focus the message box):
 * who it is, a message box that starts a chat, its chats by state and suggested tasks, with what
 * it has been doing beside them. Chats open in Paseo's own view.
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

function HomeContent({ theme, layout, host, params, navigation, openScreen, openPanel }: Props) {
  const colors = theme.colors;
  useTypeScale();
  useChatInvalidation();
  const toast = useToast();
  const start = useRpc(chatStartRpc);
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
  const send = async (prompt: string) => {
    const { chatId, workspaceId } = await start({ botId: bot.id, prompt });
    openChat(chatId);
    if (workspaceId) openPanel(workspaceId);
  };
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
              <Button colors={colors} icon="Settings" label="Settings" onPress={() => openScreen({ screenId: "bot-settings", params: { botId: bot.id, title: `${name} settings` } })} />
            </View>
            <MessageBox
              colors={colors}
              name={name}
              focusKey={params.compose}
              submitOnEnter={layout.platform === "web" && !layout.compact}
              onSend={async (prompt) => {
                try {
                  await send(prompt);
                  return true;
                } catch (error) {
                  toast.error(errorText(error));
                  return false;
                }
              }}
            />
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

/** Starts a new chat; Enter sends on desktop. `focusKey` changes when New chat brings you here. */
function MessageBox({ colors, name, focusKey, submitOnEnter, onSend }: { colors: Colors; name: string; focusKey: string | undefined; submitOnEnter: boolean; onSend(prompt: string): Promise<boolean> }) {
  const tokens = nativeTokens(colors);
  const input = useRef<NativeTextInput>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (focusKey) input.current?.focus();
  }, [focusKey]);
  const send = async () => {
    const prompt = text.trim();
    if (!prompt || sending) return;
    setSending(true);
    if (await onSend(prompt)) setText("");
    setSending(false);
  };
  return (
    <View style={{ borderWidth: 1, borderColor: tokens.borderAccent, borderRadius: 16, backgroundColor: colors.surface1, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 6, marginBottom: 24 }}>
      <TextInput
        ref={input}
        multiline
        value={text}
        onChangeText={setText}
        editable={!sending}
        placeholder={`Message ${name}`}
        placeholderTextColor={colors.foregroundMuted}
        accessibilityLabel={`Message ${name}`}
        onKeyPress={(event) => {
          const key = event.nativeEvent as unknown as ComposerKeyEvent;
          if (!submitOnEnter || key.key !== "Enter" || key.shiftKey || isImeComposing(key)) return;
          event.preventDefault?.();
          void send();
        }}
        style={{ minHeight: 46, maxHeight: 200, fontSize: ui(15), color: colors.foreground, ...({ outlineStyle: "none" } as object) }}
      />
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button colors={colors} variant="default" icon="ArrowUp" label="Send" loading={sending} disabled={!text.trim()} onPress={() => void send()} />
      </View>
    </View>
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
