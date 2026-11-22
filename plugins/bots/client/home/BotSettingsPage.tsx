import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { EMPTY_LIBRARY } from "../../shared/bot";
import { chatStartRpc } from "../../shared/fawzy-rpc";
import { AvatarTheme } from "../Avatar";
import { SETUP_PROMPT } from "../BotsSurface";
import { LibraryNavigation } from "../navigation";
import { errorText, nativeTokens } from "../native";
import { BotPanel, botSectionTitle, type SectionId } from "../panel/BotPanel";
import { CardNote } from "../panel/controls";
import { libraryScreen } from "../screen-navigation";
import { useTypeScale } from "../typography";
import { MenuProvider } from "../ui/Menu";
import { useTooltipTheme } from "../ui/Tooltip";
import { chatOpener, type BotPageActions } from "./BotHome";
import { useBotEditor } from "./editor";

/**
 * One bot's settings on their own page (screens "bot-settings" and "bot-section", param botId and
 * optionally section): the Bots screen's settings panel without the bot list. Closing it goes
 * back to the bot's home.
 */
export function BotSettingsPage(props: PluginScreenProps & BotPageActions) {
  const { theme, layout, host, params, navigation, openScreen, openPanel } = props;
  const colors = theme.colors;
  useTypeScale();
  useTooltipTheme(colors);
  const toast = useToast();
  const start = useRpc(chatStartRpc);
  const editor = useBotEditor(params.botId ?? "");
  const [section, setSection] = useState<SectionId | null>(botSectionTitle(params.section) ? (params.section as SectionId) : null);
  const [version, setVersion] = useState(0);
  const { settings, bot } = editor;

  if (settings.status !== "ready" || !bot) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0, padding: 16, paddingTop: 24 }}>
        <CardNote colors={colors} loading={settings.status === "loading"} text={settings.status === "loading" ? "Loading…" : settings.status === "ready" ? "This bot no longer exists." : "Could not load bot settings."} />
      </View>
    );
  }

  const library = settings.values.library ?? EMPTY_LIBRARY;
  const openChat = chatOpener(navigation, openScreen, bot, host.id);
  return (
    <MenuProvider colors={colors} compact={layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <LibraryNavigation.Provider value={(target = null) => openScreen(libraryScreen(target, target && "id" in target ? library.mcpServers.find((server) => server.id === target.id)?.name : undefined))}>
          <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
            <View style={{ flex: 1, width: "100%", maxWidth: 720, alignSelf: "center" }}>
              <BotPanel
                key={`${bot.id}:${version}`}
                colors={colors}
                compact={layout.compact}
                bottomInset={0}
                bot={bot}
                localHost={{ id: host.id, label: host.label }}
                history={settings.values.history}
                library={library}
                groups={settings.values.groups ?? []}
                section={section}
                onSection={setSection}
                onClose={() => {
                  void editor.flush();
                  openScreen({ screenId: "bot-home", params: { botId: bot.id, title: bot.name } });
                }}
                onPatch={editor.patch}
                flush={editor.flush}
                onRestore={(snapshot) => {
                  editor.patch(snapshot);
                  setVersion((value) => value + 1);
                  toast.show("Restored. Undo it from History if needed.", { variant: "success" });
                }}
                onSetup={() =>
                  void start({ botId: bot.id, prompt: SETUP_PROMPT }).then(
                    ({ chatId, workspaceId }) => {
                      openChat(chatId);
                      if (workspaceId) openPanel(workspaceId);
                    },
                    (error: unknown) => toast.error(errorText(error)),
                  )
                }
                onOpenChat={openChat}
              />
            </View>
          </View>
        </LibraryNavigation.Provider>
      </AvatarTheme>
    </MenuProvider>
  );
}
