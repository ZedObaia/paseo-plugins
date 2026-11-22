import type { PluginOpenScreenInput, PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { View } from "react-native";
import type { Bot, Library } from "../../shared/bot";
import { AvatarTheme } from "../Avatar";
import { homeIndicatorInset } from "../keyboard";
import { LibraryView } from "../library/LibraryView";
import type { LibraryTarget } from "../navigation";
import { nativeTokens } from "../native";
import { CardNote } from "../panel/controls";
import { libraryScreen, libraryTarget } from "../screen-navigation";
import { useTypeScale } from "../typography";
import { MenuProvider } from "../ui/Menu";
import { useTooltipTheme } from "../ui/Tooltip";
import { useBotSettings } from "../useBotSettings";
import type { BotPageActions } from "./BotHome";

type From = { fromBot: string; fromBotName: string } | null;

const withFrom = (input: PluginOpenScreenInput, from: From): PluginOpenScreenInput => (from ? { ...input, params: { ...input.params, ...from } } : input);
const titleOf = (target: LibraryTarget | null, library: Library | undefined) => (target?.kind === "mcp" ? library?.mcpServers.find((entry) => entry.id === target.id)?.name : undefined);

/** Skills & Tools opened from a bot's home or settings, so Back returns to that bot. */
export function botLibraryScreen(target: LibraryTarget | null, library: Library, bot: Bot): PluginOpenScreenInput {
  return withFrom(libraryScreen(target, titleOf(target, library)), { fromBot: bot.id, fromBotName: bot.name });
}

/**
 * Skills & Tools on its own page (screens "bot-library" and "bot-library-item"). Back returns to
 * the bot it was opened from (params fromBot, fromBotName), else to the Bots screen.
 */
export function LibraryPage({ theme, layout, params, openScreen }: PluginScreenProps & Pick<BotPageActions, "openScreen">) {
  const colors = theme.colors;
  useTypeScale();
  useTooltipTheme(colors);
  const { settings, commit } = useBotSettings();
  const [target, setTarget] = useState(() => libraryTarget(params));
  const from: From = params.fromBot ? { fromBot: params.fromBot, fromBotName: params.fromBotName ?? "" } : null;
  // Phones route each page as a Paseo screen with Paseo's own Back, as the Bots screen does.
  const routed = layout.compact;

  if (settings.status !== "ready") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0, padding: 16 }}>
        <CardNote colors={colors} loading={settings.status === "loading"} text={settings.status === "loading" ? "Loading…" : "Could not load bot settings."} />
      </View>
    );
  }

  const values = settings.values;
  return (
    <MenuProvider colors={colors} compact={layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
          <LibraryView
            colors={colors}
            layout={layout}
            hostNavigation={routed}
            bottomInset={homeIndicatorInset()}
            values={values}
            commit={commit}
            target={target}
            onTarget={(next) => (routed ? openScreen(withFrom(libraryScreen(next, titleOf(next, values.library)), from)) : setTarget(next))}
            onBack={() => openScreen(from ? { screenId: "bot-home", params: { botId: from.fromBot, title: from.fromBotName || "Bot" } } : { screenId: "bots" })}
            backLabel={from ? `Back to ${from.fromBotName || "the bot"}` : undefined}
          />
        </View>
      </AvatarTheme>
    </MenuProvider>
  );
}
