import { z } from "zod";
import { BOT_STATUS_METADATA } from "../../shared/status";
import { defineTool } from "./mcp";

// A short line about what the chat is doing, shown on the bot page and in the user's sidebar.

export const setStatus = defineTool({
  name: "set_status",
  description:
    "Show a short status line (and optionally progress) for this chat in the user's sidebar and on your bot page, like \"Reviewing 3 of 8 PRs\". Use it during longer work; update it as you go and call it with empty text to clear it when you finish.",
  input: z.object({
    text: z.string().max(80).describe('What you are doing now, at most 80 characters. "" clears the status.'),
    progress: z.number().min(0).max(1).optional().describe("Share of the work done, from 0 to 1, when you can tell."),
  }),
  async run({ text, progress }, { host, agentId }) {
    const line = text.replace(/\s+/g, " ").trim();
    const status = line ? { text: line, progress: progress ?? null, updatedAt: new Date().toISOString() } : null;
    await host.requirePaseo().agents.ref(agentId).setMetadata({ [BOT_STATUS_METADATA]: status });
    return status ? "Status shown." : "Status cleared.";
  },
});
