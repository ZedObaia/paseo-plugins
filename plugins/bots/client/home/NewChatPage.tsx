import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { defaultModelId, EMPTY_LIBRARY, type Bot } from "../../shared/bot";
import { startBotChat } from "../../shared/chat";
import { ensureBotHomeRpc, mountRpc, systemPromptRpc } from "../../shared/rpc";
import { newUuid } from "../../shared/uuid";
import { Avatar, AvatarTheme } from "../Avatar";
import type { OutgoingMessage } from "../ChatPane";
import { Composer } from "../chat/Composer";
import { beginDraftCreation } from "../chat/composer/draft-creation";
import { useDraftStore } from "../chat/composer/drafts";
import { composerDraftKey } from "../chat/composer/logic";
import { useBotHost, useProviders, type BotHost } from "../data";
import { useKeyboardHeight } from "../keyboard";
import { nativeTokens, useHover } from "../native";
import { CardNote } from "../panel/controls";
import { ui, useTypeScale } from "../typography";
import { measureAnchor, MenuProvider, useMenu } from "../ui/Menu";
import { useTooltipTheme } from "../ui/Tooltip";
import { useBotSettings } from "../useBotSettings";
import { chatOpener, type BotPageActions } from "./BotHome";

type Colors = PluginTheme["colors"];
interface Choice {
  model: string | null;
  thinking: string | null;
}

/**
 * A new chat with a bot (screen "bot-new-chat", param botId), laid out like Paseo's: the bot in the
 * middle and the composer, with attachments and this chat's model and thinking, below. The first
 * message starts the chat the way the Bots screen's draft does, then it opens in Paseo's own view
 * with the bot's panel in the right sidebar.
 */
export function NewChatPage(props: PluginScreenProps & BotPageActions) {
  const { colors } = props.theme;
  useTooltipTheme(colors);
  return (
    <MenuProvider colors={colors} compact={props.layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <NewChat {...props} />
      </AvatarTheme>
    </MenuProvider>
  );
}

function NewChat({ theme, layout, host: localHost, params, navigation, openScreen, openPanel }: PluginScreenProps & BotPageActions) {
  const colors = theme.colors;
  useTypeScale();
  const keyboardHeight = useKeyboardHeight();
  const { settings } = useBotSettings();
  const bot = settings.status === "ready" ? settings.values.bots.find((entry) => entry.id === params.botId) : undefined;
  const host = useBotHost(bot?.hostId ?? null, { id: localHost.id, label: localHost.label });
  const [choice, setChoice] = useState<Choice | null>(null);
  const ensureHome = useRpc(ensureBotHomeRpc);
  const compose = useRpc(systemPromptRpc);
  const mountServers = useRpc(mountRpc);
  const queryClient = useQueryClient();
  const drafts = useDraftStore();

  if (settings.status !== "ready" || !bot) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0, padding: 16 }}>
        <CardNote colors={colors} loading={settings.status === "loading"} text={settings.status === "loading" ? "Loading…" : settings.status === "ready" ? "This bot no longer exists." : "Could not load bot settings."} />
      </View>
    );
  }

  const library = settings.values.library ?? EMPTY_LIBRARY;
  const picked: Choice = choice ?? { model: bot.model, thinking: bot.thinkingOptionId };
  // The Bots screen's draft start (BotsSurface SelectedChat.start), with this chat's model.
  const start = async (message: OutgoingMessage) => {
    const api = host.api;
    if (!api) throw new Error(`${host.label} is offline.`);
    const release = beginDraftCreation(drafts, composerDraftKey(host.key, bot.id, null));
    try {
      // The bot's folder holds its memory and skills even when it works elsewhere.
      const home = await ensureHome({ botId: bot.id });
      const placement = bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root };
      const { systemPrompt } = await compose({ bot, local: host.isLocal, message: message.text });
      const agentId = newUuid();
      const plugin = host.isLocal ? await mountServers({ botId: bot.id, agentId }) : {};
      const id = await startBotChat(api, {
        bot: { ...bot, model: picked.model, thinkingOptionId: picked.thinking },
        library,
        ...(host.isLocal ? { agentId } : {}),
        plugin,
        placement,
        prompt: message.text,
        systemPrompt,
        images: message.images,
        attachments: message.attachments,
        clientMessageId: message.messageId,
      });
      await queryClient.invalidateQueries({ queryKey: ["paseo-bots", "chats", host.key, bot.id] });
      const chat = api.agents.ref(id);
      await chat.refresh().catch(() => null);
      setChoice(null);
      chatOpener(navigation, openScreen, bot, localHost.id)(id);
      if (chat.workspaceId) openPanel(chat.workspaceId);
    } finally {
      release();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
        <Avatar avatar={bot.avatar} size={56} />
        <Text style={{ color: colors.foreground, fontSize: ui(18), fontWeight: "500" }}>{bot.name}</Text>
        {bot.description ? <Text style={{ color: colors.foregroundMuted, fontSize: ui(14), textAlign: "center", maxWidth: 420 }}>{bot.description}</Text> : null}
      </View>
      <Composer
        colors={colors}
        bot={bot}
        host={host}
        agentId={null}
        agent={null}
        running={false}
        layout={layout}
        keyboardOpen={keyboardHeight > 0}
        onStart={start}
        toolbar={<ModelPills colors={colors} host={host} bot={bot} choice={picked} onChoice={setChoice} />}
      />
    </View>
  );
}

/** Paseo's model and thinking pills, for this chat; the bot's own setting until you pick. */
function ModelPills({ colors, host, bot, choice, onChoice }: { colors: Colors; host: BotHost; bot: Bot; choice: Choice; onChoice(choice: Choice): void }) {
  const menu = useMenu();
  const providers = useProviders(host);
  const models = (providers.data?.find((entry) => entry.provider === bot.provider)?.models ?? []).filter((model) => model.isSelectable !== false);
  if (!models.length) return null;
  const modelId = choice.model ?? defaultModelId(models);
  const model = models.find((entry) => entry.id === modelId);
  const thinking = model?.thinkingOptions ?? [];
  const thinkingId = choice.thinking ?? model?.defaultThinkingOptionId ?? null;
  const thinkingLabel = thinking.find((option) => option.id === thinkingId)?.label ?? "Default";
  return (
    <>
      <Pill
        colors={colors}
        icon="Sparkles"
        label={model?.label ?? modelId ?? "Model"}
        onPress={(anchor) =>
          menu.open({
            anchor,
            align: "start",
            width: 240,
            title: "Model",
            entries: models.map((entry) => ({
              label: entry.label,
              selected: entry.id === modelId,
              onSelect: () => onChoice({ model: entry.id, thinking: entry.thinkingOptions?.some((option) => option.id === choice.thinking) ? choice.thinking : null }),
            })),
          })
        }
      />
      {thinking.length ? (
        <Pill
          colors={colors}
          icon="Brain"
          label={thinkingLabel}
          onPress={(anchor) =>
            menu.open({
              anchor,
              align: "start",
              width: 200,
              title: "Thinking",
              entries: thinking.map((option) => ({ label: option.label, selected: option.id === thinkingId, onSelect: () => onChoice({ ...choice, model: modelId, thinking: option.id }) })),
            })
          }
        />
      ) : null}
    </>
  );
}

function Pill({ colors, icon, label, onPress }: { colors: Colors; icon: string; label: string; onPress(anchor: { x: number; y: number; width: number; height: number }): void }) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  const tint = hovered ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => void measureAnchor(ref).then((anchor) => anchor && onPress(anchor))}
      {...hoverProps}
      style={{ height: 28, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, borderRadius: 8, backgroundColor: hovered ? colors.surface2 : "transparent" }}
    >
      <Icon name={icon} size={14} color={tint} />
      <Text numberOfLines={1} style={{ fontSize: ui(13), color: tint }}>{label}</Text>
      <Icon name="ChevronDown" size={12} color={tint} />
    </Pressable>
  );
}
