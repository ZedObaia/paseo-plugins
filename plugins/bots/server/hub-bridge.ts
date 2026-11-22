import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineAgentTool, type AgentToolContext, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import { foldText } from "../shared/activity";
import { BOT_LABEL, type Bot } from "../shared/bot";
import { pluginDataPath } from "./bot-home";
import { startChat } from "./chats";
import type { BotsHost } from "./host";
import type { Relay } from "./relay";
import { describeChat, readChat } from "./tools/bots";

// Paseo Hub (GitHub, Slack and webhook triggers) reaches bots through a relay:
// a trigger runs its agent in hubRelayPath(), and an agent opened there gets
// ask_bot and check_chat, which talk to a bot's own chat (its instructions,
// memory and tools). The relay then posts the answer with Hub's reply tool.

/** The folder a Hub trigger's run.target.cwd names. Agents opened here are relays. */
export function hubRelayPath(): string {
  return join(pluginDataPath(), "shared", "Hub");
}

export async function ensureHubRelay(): Promise<void> {
  await mkdir(hubRelayPath(), { recursive: true });
}

/** A relay is an agent opened in the Hub folder that is not itself a bot chat. */
export function isHubRelay(cwd: string, labels: Readonly<Record<string, string>>): boolean {
  return resolve(cwd) === resolve(hubRelayPath()) && !labels[BOT_LABEL];
}

/** On a bot chat a relay started, the relay's agent id: only that relay may read or continue it. */
export const HUB_RELAY_LABEL = "paseo-bots.hub-relay";

/** MCP clients give up on a tool call after about a minute, so answers are awaited a little less (as ask_bot does). */
const WAIT_MS = 50_000;

export function hubPrompt(source: string, message: string): string {
  return `[Message from your user via ${source}, relayed by Paseo Hub. Your reply is posted back there as written, so write it for that place.]\n\n${message.trim()}`;
}

export function findBot(bots: Bot[], wanted: string): Bot {
  const live = bots.filter((bot) => !bot.archived);
  const key = wanted.trim().toLowerCase();
  const exact = live.find((bot) => bot.id === wanted.trim());
  const named = live.filter((bot) => bot.name.trim().toLowerCase() === key);
  if (!exact && named.length > 1) throw new Error(`More than one bot is called "${wanted}". Use one of their ids: ${named.map((bot) => bot.id).join(", ")}.`);
  const bot = exact ?? named[0];
  if (!bot) throw new Error(live.length ? `There's no bot called "${wanted}". Bots: ${live.map((entry) => entry.name).join(", ")}.` : "There are no bots on this host.");
  if (bot.hostId) throw new Error(`${bot.name} runs on another host, so Hub can't reach it here.`);
  return bot;
}

async function ownChat(context: AgentToolContext, chatId: string, botId?: string) {
  const agent = (await context.paseo.agents.ref(chatId).refresh().catch(() => null))?.agent;
  if (!agent || agent.labels?.[HUB_RELAY_LABEL] !== context.agent.id || (botId && agent.labels?.[BOT_LABEL] !== botId)) {
    throw new Error("You can only use chats this Hub run started.");
  }
  return agent;
}

async function answer(context: AgentToolContext, chatId: string, who: string): Promise<string> {
  await context.paseo.agents.ref(chatId).waitForFinish(WAIT_MS).catch(() => null);
  return describeChat(await readChat(context.paseo, chatId), who, chatId);
}

export function hubTools(host: BotsHost, relay: Relay): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "ask_bot",
      description:
        "Hand the user's message to one of their bots. The bot works in its own chat with its own instructions, memory and tools, and its answer comes back here. Pass chat_id from an earlier answer in this run to continue that conversation.",
      input: z.object({
        bot: z.string().min(1).max(100).describe("The bot's name or id."),
        message: z.string().min(1).max(20_000).describe("The user's message, with the context the bot needs."),
        source: z.string().min(1).max(200).describe('Where it came from, e.g. "Slack, #ops thread" or "GitHub comment on owner/repo#12".'),
        chat_id: z.string().trim().min(1).max(100).optional().describe("Continue the chat an earlier ask_bot in this run started."),
      }),
      async execute({ bot: wanted, message, source, chat_id: chatId }, context) {
        host.attach(context.paseo);
        const bot = findBot(await host.bots(), wanted);
        const prompt = hubPrompt(source, message);
        let id = chatId;
        if (id) {
          const agent = await ownChat(context, id, bot.id);
          if (agent.status === "running" || agent.status === "initializing") return { text: `${bot.name} is still working in chat ${id}. Use check_chat with that id.` };
          await context.paseo.agents.ref(id).send(prompt, { messageId: `bots-hub-${randomUUID()}`, activeTurnBehavior: "steer" });
        } else {
          id = await startChat(host, relay, bot, { prompt, title: `${source}: ${foldText(message, 60)}`, labels: { [HUB_RELAY_LABEL]: context.agent.id } });
        }
        return { text: await answer(context, id, bot.name) };
      },
    }),
    defineAgentTool({
      name: "check_chat",
      description: "Check a bot chat ask_bot started in this run: waits up to about 50 seconds, then gives its answer or says it's still working.",
      input: z.object({ chat_id: z.string().trim().min(1).max(100) }),
      async execute({ chat_id: chatId }, context) {
        host.attach(context.paseo);
        const agent = await ownChat(context, chatId);
        const name = (await host.bot(agent.labels?.[BOT_LABEL] ?? ""))?.name ?? "The bot";
        return { text: await answer(context, chatId, name) };
      },
    }),
  ];
}
