import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useAgent, useAgents } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { BOT_LABEL, EMPTY_LIBRARY } from "../../shared/bot";
import { Avatar, AvatarTheme } from "../Avatar";
import { useChatInvalidation } from "../data";
import { nativeTokens } from "../native";
import { Button, CardNote } from "../panel/controls";
import { ui, useTypeScale } from "../typography";
import { MenuProvider } from "../ui/Menu";
import { useTooltipTheme } from "../ui/Tooltip";
import { useBotSettings } from "../useBotSettings";
import { chatOpener, useBotChats, type BotPageActions } from "./BotHome";
import { saveBot } from "./editor";
import { BotInfo } from "./HomeSections";

/**
 * The "Bot" entry in Paseo's right sidebar beside a bot's chats: the bot at a glance, with its
 * home and a new chat a press away. The bot is the one whose chats live in this workspace.
 */
export function BotTab(props: PluginWorkspacePanelProps & Pick<BotPageActions, "openScreen">) {
  const { theme, layout, host, workspaceId, navigation, openScreen } = props;
  const colors = theme.colors;
  useTypeScale();
  useTooltipTheme(colors);
  useChatInvalidation();
  const chat = useAgents({ hosts: [host.id], where: (agent) => agent.workspaceId === workspaceId && Boolean(agent.labels[BOT_LABEL]) })[0];
  const botId = useAgent(chat ?? "", (agent) => agent.labels[BOT_LABEL] ?? null) ?? null;
  const { settings, commit } = useBotSettings();
  const bot = settings.status === "ready" && botId ? settings.values.bots.find((entry) => entry.id === botId) : undefined;
  const { botHost, chats } = useBotChats(bot, { id: host.id, label: host.label });

  if (!bot) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0, padding: 12 }}>
        <CardNote colors={colors} loading={settings.status === "loading"} text={settings.status === "loading" ? "Loading…" : "No bot works in this workspace."} />
      </View>
    );
  }

  const name = bot.name || "Untitled bot";
  const home = (params: Record<string, string> = {}) => openScreen({ screenId: "bot-home", params: { botId: bot.id, title: name, ...params } });
  return (
    <MenuProvider colors={colors} compact={layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <Avatar avatar={bot.avatar} size={36} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: ui(16), fontWeight: "500", color: colors.foreground }}>{name}</Text>
              {bot.title.trim() ? <Text numberOfLines={1} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{bot.title}</Text> : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
            <Button colors={colors} icon="House" label="Home" onPress={() => home()} />
            <Button colors={colors} icon="Plus" label="New chat" onPress={() => home({ compose: String(Date.now()) })} />
          </View>
          <BotInfo
            colors={colors}
            bot={bot}
            chats={chats.data}
            library={settings.status === "ready" ? (settings.values.library ?? EMPTY_LIBRARY) : EMPTY_LIBRARY}
            local={botHost.isLocal}
            openChat={chatOpener(navigation, openScreen, bot, host.id)}
            openScreen={openScreen}
            addRoutine={(routine) => void saveBot(commit, bot.id, (saved) => ({ routines: [...saved.routines, routine] }))}
            onConnectors={() => home({ tab: "connectors" })}
          />
        </ScrollView>
      </AvatarTheme>
    </MenuProvider>
  );
}
