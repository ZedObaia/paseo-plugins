import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginIcon, PluginScreenProps } from "@getpaseo/plugin/client";
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
import { tooltip, useTooltipTheme } from "../ui/Tooltip";
import { useBotSettings } from "../useBotSettings";
import { chatOpener, type BotPageActions } from "./BotHome";
import { controlLabel, modeIcon, providerIcon } from "./composer-controls";

type Colors = PluginTheme["colors"];
interface Choice {
  model: string | null;
  thinking: string | null;
  mode: string | null;
}

/**
 * A new chat with a bot (screen "bot-new-chat", param botId), laid out like Paseo's: the bot in the
 * middle and the composer, with attachments and this chat's model, thinking and mode, below. The first
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
  const picked: Choice = choice ?? { model: bot.model, thinking: bot.thinkingOptionId, mode: bot.modeId };
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
        bot: { ...bot, model: picked.model, thinkingOptionId: picked.thinking, modeId: picked.mode },
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
        toolbar={<ChatControls colors={colors} host={host} bot={bot} compact={layout.compact} choice={picked} onChoice={setChoice} />}
      />
    </View>
  );
}

/**
 * Paseo's composer controls for this chat: model (the provider's mark), thinking and mode, each the
 * bot's setting until you pick. Borderless round triggers with a muted glyph and label; on phones
 * thinking and mode show their glyph only and no control has a caret (agent-controls/control.tsx).
 */
function ChatControls({ colors, host, bot, compact, choice, onChoice }: { colors: Colors; host: BotHost; bot: Bot; compact: boolean; choice: Choice; onChoice(choice: Choice): void }) {
  const menu = useMenu();
  const providers = useProviders(host);
  const provider = providers.data?.find((entry) => entry.provider === bot.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  if (!provider || !models.length) return null;
  const modelId = choice.model ?? defaultModelId(models);
  const model = models.find((entry) => entry.id === modelId);
  const thinking = model?.thinkingOptions ?? [];
  const thinkingId = choice.thinking ?? model?.defaultThinkingOptionId ?? null;
  const thinkingOption = thinking.find((option) => option.id === thinkingId);
  const modes = provider.modes ?? [];
  const modeId = choice.mode ?? provider.defaultModeId ?? null;
  const mode = modes.find((entry) => entry.id === modeId);
  return (
    <>
      <Control
        colors={colors}
        compact={compact}
        icon={providerIcon(bot.provider, provider.iconSvg)}
        label={model?.label ?? modelId ?? "Model"}
        accessibilityLabel={`Model: ${model?.label ?? modelId ?? "default"}`}
        onPress={(anchor) =>
          menu.open({
            anchor,
            align: "start",
            width: 240,
            title: "Model",
            entries: models.map((entry) => ({
              label: entry.label,
              selected: entry.id === modelId,
              onSelect: () => onChoice({ ...choice, model: entry.id, thinking: entry.thinkingOptions?.some((option) => option.id === choice.thinking) ? choice.thinking : null }),
            })),
          })
        }
      />
      {thinking.length ? (
        <Control
          colors={colors}
          compact={compact}
          icon="Brain"
          label={thinkingOption ? controlLabel(thinkingOption, true) : "Default"}
          iconOnly={compact}
          accessibilityLabel={`Thinking: ${thinkingOption ? controlLabel(thinkingOption, true) : "default"}`}
          onPress={(anchor) =>
            menu.open({
              anchor,
              align: "start",
              width: 200,
              title: "Thinking",
              entries: thinking.map((option) => ({ label: controlLabel(option, true), selected: option.id === thinkingId, onSelect: () => onChoice({ ...choice, model: modelId, thinking: option.id }) })),
            })
          }
        />
      ) : null}
      {modes.length ? (
        <Control
          colors={colors}
          compact={compact}
          icon={modeIcon(mode?.icon)}
          label={mode ? controlLabel(mode) : "Mode"}
          iconOnly={compact}
          accessibilityLabel={`Mode: ${mode ? controlLabel(mode) : "default"}`}
          onPress={(anchor) =>
            menu.open({
              anchor,
              align: "start",
              width: 240,
              title: "Mode",
              entries: modes.map((entry) => ({ label: controlLabel(entry), icon: modeIcon(entry.icon), selected: entry.id === modeId, onSelect: () => onChoice({ ...choice, mode: entry.id }) })),
            })
          }
        />
      ) : null}
    </>
  );
}

/** One toolbar trigger: 28 tall, 8 a side (28 round when icon only), 4 between glyph, label and caret. */
function Control({ colors, compact, icon, label, iconOnly = false, accessibilityLabel, onPress }: { colors: Colors; compact: boolean; icon: PluginIcon; label: string; iconOnly?: boolean; accessibilityLabel: string; onPress(anchor: { x: number; y: number; width: number; height: number }): void }) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  const glyph = compact ? 20 : 16;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      {...tooltip(accessibilityLabel)}
      onPress={() => void measureAnchor(ref).then((anchor) => anchor && onPress(anchor))}
      {...hoverProps}
      style={({ pressed }) => ({
        height: 28,
        minWidth: 28,
        flexShrink: iconOnly ? 0 : 1,
        marginLeft: 4,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        paddingHorizontal: iconOnly ? 0 : 8,
        borderRadius: 999,
        backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
      })}
    >
      <Icon icon={icon} size={glyph} color={colors.foregroundMuted} />
      {iconOnly ? null : (
        <Text numberOfLines={1} style={{ minWidth: 0, flexShrink: 1, fontSize: ui(14), color: colors.foregroundMuted }}>
          {label}
        </Text>
      )}
      {compact ? null : (
        <View style={{ transform: [{ translateY: 1 }] }}>
          <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
        </View>
      )}
    </Pressable>
  );
}
