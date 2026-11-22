import type { PluginServerContext } from "@getpaseo/plugin/server";
import { sidebarBotsRpc, suggestionDismissRpc, suggestionStartRpc, suggestionsListRpc } from "../shared/fawzy-rpc";
import type { BotsHost } from "./host";
import type { Relay } from "./relay";
import { dismissSuggestion, listSuggestions, startSuggestion } from "./suggestions";

/** Our RPCs: the bot list for other plugins, and suggested tasks. */
export function registerFawzy(server: PluginServerContext, host: BotsHost, relay: Relay): void {
  server.handle(sidebarBotsRpc, async () => ({
    bots: (await host.bots()).filter((bot) => !bot.archived).map(({ id, name, avatar }) => ({ id, name, avatar })),
  }));
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
