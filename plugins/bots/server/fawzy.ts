import type { PluginServerContext } from "@getpaseo/plugin/server";
import { chatStartRpc, sidebarBotsRpc, suggestionDismissRpc, suggestionStartRpc, suggestionsListRpc } from "../shared/fawzy-rpc";
import { startChat } from "./chats";
import type { BotsHost } from "./host";
import type { Relay } from "./relay";
import { dismissSuggestion, listSuggestions, startSuggestion } from "./suggestions";

/** Our RPCs: the bot list for other plugins, new chats from a bot's page, and suggested tasks. */
export function registerFawzy(server: PluginServerContext, host: BotsHost, relay: Relay): void {
  server.handle(sidebarBotsRpc, async () => ({
    bots: (await host.bots()).filter((bot) => !bot.archived).map(({ id, name, avatar }) => ({ id, name, avatar })),
  }));
  server.handle(chatStartRpc, async ({ botId, prompt }, context) => {
    host.attach(context.paseo);
    const bot = await host.bot(botId);
    if (!bot || bot.archived) throw new Error("This bot no longer exists.");
    const chatId = await startChat(host, relay, bot, { prompt, title: "", labels: {} });
    // The page opens the chat's workspace with the bot's panel beside it.
    const chat = context.paseo.agents.ref(chatId);
    await chat.refresh().catch(() => null);
    return { chatId, workspaceId: chat.workspaceId };
  });
  server.handle(suggestionsListRpc, async ({ botId }) => ({ suggestions: await listSuggestions(botId) }));
  server.handle(suggestionStartRpc, ({ id }, context) => {
    host.attach(context.paseo);
    return startSuggestion(id, host, relay);
  });
  server.handle(suggestionDismissRpc, async ({ id }) => {
    await dismissSuggestion(id);
    return { ok: true };
  });
}
