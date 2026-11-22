import { z } from "zod";
import { SUGGESTION_SOURCES } from "../../shared/proposals";
import { suggestTask as addSuggestion } from "../suggestions";
import { defineTool } from "./mcp";

// A task the bot could do next; the user starts it from the bot page as a new chat, or dismisses it.

export const suggestTask = defineTool({
  name: "suggest_task",
  description:
    "Suggest a concrete task you could do for the user. It waits on your bot page, where the user starts it as a new chat with your prompt, or dismisses it. Repeats of pending, recently started or dismissed suggestions are refused. Don't start the work yourself.",
  input: z.object({
    title: z.string().trim().min(1).max(100).describe('A short imperative title, like "Reply to the Acme invoice thread".'),
    prompt: z.string().trim().min(1).max(20_000).describe("The first message of the new chat: what to do, written so it works without this chat."),
    source: z.enum(SUGGESTION_SOURCES).describe("Where you found it."),
    why: z.string().trim().max(300).optional().describe("One line on why it's worth doing now."),
  }),
  async run({ title, prompt, source, why }, { bot, agentId }) {
    const result = await addSuggestion(bot.id, agentId, { title: title.replace(/\s+/g, " "), prompt, source, ...(why ? { why } : {}) });
    return "refused" in result ? result.refused : `Suggested "${result.proposal.data.title}". The user sees it on your bot page.`;
  },
});
