import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BotSchema } from "./bot";
import { ProposalSchema } from "./proposals";

// Our additions to the plugin's RPCs (shared/rpc.ts stays as upstream has it).

const BotId = z.string().regex(/^[a-z0-9-]+$/);
const ProposalId = z.string().regex(/^p-[a-z0-9]+$/);

/** The non-archived bots in settings order, for the bridge other plugins read (client/bridge.ts). */
export const sidebarBotsRpc = defineRpc({
  name: "bots.sidebar-bots",
  input: z.object({}),
  output: z.object({ bots: z.array(z.object({ id: z.string(), name: z.string(), avatar: BotSchema.shape.avatar })) }),
});

/** Starts a chat with a bot from its page; Paseo titles it from the message. */
export const chatStartRpc = defineRpc({
  name: "bots.chats.start",
  input: z.object({ botId: BotId, prompt: z.string().trim().min(1) }),
  output: z.object({ chatId: z.string(), workspaceId: z.string().nullable() }),
});

/** A bot's pending suggested tasks (suggest_task), newest first. */
export const suggestionsListRpc = defineRpc({
  name: "bots.suggestions.list",
  input: z.object({ botId: BotId }),
  output: z.object({ suggestions: z.array(ProposalSchema) }),
});

/** Starts a suggestion as a new chat of its bot; returns the chat. */
export const suggestionStartRpc = defineRpc({
  name: "bots.suggestions.start",
  input: z.object({ id: ProposalId }),
  output: z.object({ chatId: z.string() }),
});

export const suggestionDismissRpc = defineRpc({
  name: "bots.suggestions.dismiss",
  input: z.object({ id: ProposalId }),
  output: z.object({ ok: z.boolean() }),
});
