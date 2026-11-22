import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { View } from "react-native";
import { applyDefaults, DEFAULT_BOT_DEFAULTS, type Bot } from "../../shared/bot";
import { addImportedBots } from "../../shared/library";
import { importTeamRpc } from "../../shared/rpc";
import { botFromPreset, newBot } from "../../shared/templates";
import { AvatarTheme } from "../Avatar";
import { NewBotDialog } from "../BotDialogs";
import { useBotHost, useProviders } from "../data";
import { confirmDialog, nativeTokens } from "../native";
import type { SectionId } from "../panel/BotPanel";
import { Button, CardNote } from "../panel/controls";
import { useTypeScale } from "../typography";
import { MenuProvider } from "../ui/Menu";
import { useTooltipTheme } from "../ui/Tooltip";
import { useBotSettings } from "../useBotSettings";
import type { BotPageActions } from "./BotHome";

/**
 * The Bots screen's New bot dialog on its own page (screen "bot-new", param n new for each visit).
 * The new bot's settings open next; closing the dialog goes to the first bot's home. Paseo keeps a
 * page mounted after leaving it, so the dialog closes first or it would cover the next page.
 */
export function NewBotPage({ theme, layout, host, openScreen }: PluginScreenProps & Pick<BotPageActions, "openScreen">) {
  const colors = theme.colors;
  useTypeScale();
  useTooltipTheme(colors);
  const localHost = { id: host.id, label: host.label };
  const { settings, commit } = useBotSettings();
  const providers = useProviders(useBotHost(null, localHost));
  const importTeam = useRpc(importTeamRpc);
  const [open, setOpen] = useState(true);

  if (settings.status !== "ready") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0, padding: 16 }}>
        <CardNote colors={colors} loading={settings.status === "loading"} text={settings.status === "loading" ? "Loading…" : "Could not load bot settings."} />
      </View>
    );
  }

  const values = settings.values;
  // The Bots screen's defaultProvider: Claude when ready, else the first ready provider.
  const ready = (providers.data ?? []).filter((entry) => entry.status === "ready");
  const provider = (ready.find((entry) => entry.provider === "claude") ?? ready[0])?.provider ?? "";
  const go = (input: Parameters<typeof openScreen>[0]) => {
    setOpen(false);
    openScreen(input);
  };
  const openSettings = (bot: Bot, section: SectionId) => go({ screenId: "bot-settings", params: { botId: bot.id, section, title: `${bot.name || "Bot"} settings` } });
  const leave = () => {
    const first = values.bots.find((bot) => !bot.archived);
    go(first ? { screenId: "bot-home", params: { botId: first.id, title: first.name } } : { screenId: "bots" });
  };

  if (!open) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0, alignItems: "center", justifyContent: "center" }}>
        <Button colors={colors} variant="default" icon="Plus" label="New bot" onPress={() => setOpen(true)} />
      </View>
    );
  }

  return (
    <MenuProvider colors={colors} compact={layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
          <NewBotDialog
            colors={colors}
            presets={values.presets ?? []}
            defaults={values.defaults ?? DEFAULT_BOT_DEFAULTS}
            localHost={localHost}
            onClose={leave}
            onDefaultsChange={(patch) => void commit((current) => ({ ...current, defaults: { ...(current.defaults ?? DEFAULT_BOT_DEFAULTS), ...patch } }))}
            onDeletePreset={async (preset) => {
              if (await confirmDialog({ title: "Delete preset", message: `Delete the "${preset.name}" preset? Bots made from it stay.`, confirmLabel: "Delete", destructive: true })) {
                await commit((current) => ({ ...current, presets: (current.presets ?? []).filter((entry) => entry.id !== preset.id) }));
              }
            }}
            onCreate={(start, defaults) => {
              const bot = applyDefaults(start?.preset ? botFromPreset(provider, start.preset) : newBot(provider, start?.template), defaults, provider);
              void commit((current) => ({ ...current, bots: [...current.bots, bot] })).then((saved) => saved && openSettings(bot, start ? "overview" : "identity"));
            }}
            onImport={async (json) => {
              const { bots, teams } = await importTeam({ json });
              const saved = await commit((current) => addImportedBots(current, bots, teams));
              const first = bots[0]?.bot;
              if (saved && first) openSettings(first, "overview");
            }}
          />
        </View>
      </AvatarTheme>
    </MenuProvider>
  );
}
