import type { PluginClientContext, PluginOpenScreenInput } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import type { BotAvatar } from "../shared/bot";
import { sidebarBotsRpc } from "../shared/fawzy-rpc";
import { Avatar } from "./Avatar";
import { chatScreen } from "./screen-navigation";

// Our status sidebar plugin (another bundle in the same JS realm) lists the bots and opens
// their screens through this object, since one plugin can't open another's screens. One
// bridge per loaded client; the sidebar keeps its own copy of this interface.

export interface FawzyBridge {
  readonly version: 1;
  /** Non-archived bots, in settings order. */
  listBots(): Promise<readonly { id: string; name: string; avatar: BotAvatar }[]>;
  /** The bot's home (bot-home). */
  openBot(botId: string): void;
  openChat(botId: string, chatId: string): void;
  /** A new chat with the bot. */
  newChat(botId: string): void;
  /** The New bot page. */
  newBot(): void;
  /** Needs no Fawzy context, so it renders inside another plugin's tree. */
  Avatar: ComponentType<{ avatar: BotAvatar; size: number; dark?: boolean }>;
}

type Registry = { __fawzyBridges?: Set<FawzyBridge> };

export function registerBridge(client: Pick<PluginClientContext, "rpc" | "openScreen">): () => void {
  const names = new Map<string, string>();
  const listBots = async () => {
    const { bots } = await client.rpc(sidebarBotsRpc, {});
    for (const bot of bots) names.set(bot.id, bot.name);
    return bots;
  };
  // Screens are titled with the bot's name, known from the last list; otherwise read it first.
  const open = (botId: string, screen: (title: string) => PluginOpenScreenInput) => {
    const known = names.get(botId);
    if (known !== undefined) return client.openScreen(screen(known));
    void listBots().catch(() => []).then(() => client.openScreen(screen(names.get(botId) ?? "Bot")));
  };
  const bridge: FawzyBridge = {
    version: 1,
    listBots,
    openBot: (botId) => open(botId, (title) => ({ screenId: "bot-home", params: { botId, title } })),
    openChat: (botId, chatId) => open(botId, (title) => chatScreen({ botId, chatId }, title)),
    // Paseo-like new chat; it opens in Paseo's own view once you send.
    newChat: (botId) => open(botId, (title) => ({ screenId: "bot-new-chat", params: { botId, title } })),
    newBot: () => client.openScreen({ screenId: "bot-new", params: { n: String(Date.now()) } }),
    Avatar,
  };
  const registry = globalThis as Registry;
  const bridges = (registry.__fawzyBridges ??= new Set());
  bridges.add(bridge);
  return () => {
    bridges.delete(bridge);
  };
}
