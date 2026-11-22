import type { Proposal } from "../shared/proposals";
import { startChat } from "./chats";
import type { BotsHost } from "./host";
import { createProposal, load, update } from "./proposals";
import type { Relay } from "./relay";

// Tasks a bot suggests with suggest_task. They share the proposal store but skip its
// card and settings-receipt flow: the user starts (a new chat) or dismisses them on
// the bot page, and the decision is recorded here directly.

type TaskProposal = Extract<Proposal, { kind: "task" }>;
export type TaskSuggestion = TaskProposal["data"];

/** A started or dismissed title isn't suggested again for this long. */
const REMEMBER_MS = 30 * 86_400_000;
/** Keeps one bot's suggestions from filling the shared 200-entry proposal store. */
const MAX_PENDING = 20;

const titleKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();
const isTask = (proposal: Proposal): proposal is TaskProposal => proposal.kind === "task";

let queue: Promise<unknown> = Promise.resolve();

/** A new pending suggestion, or why there isn't one. Serialized so two calls can't add the same title. */
export function suggestTask(botId: string, agentId: string, data: TaskSuggestion, now = Date.now()): Promise<{ proposal: TaskProposal } | { refused: string }> {
  const run = async () => {
    const mine = (await load()).filter(isTask).filter((proposal) => proposal.botId === botId);
    const same = mine.find((proposal) => titleKey(proposal.data.title) === titleKey(data.title) && (proposal.status === "pending" || now - Date.parse(proposal.resolvedAt ?? proposal.createdAt) < REMEMBER_MS));
    if (same?.status === "pending") return { refused: `"${same.data.title}" is already suggested and waiting for the user.` };
    if (same) return { refused: `The user ${same.status === "dismissed" ? "dismissed" : "already started"} "${same.data.title}" recently. Don't suggest it again.` };
    if (mine.filter((proposal) => proposal.status === "pending").length >= MAX_PENDING) return { refused: `You already have ${MAX_PENDING} open suggestions. Wait for the user to start or dismiss some.` };
    return { proposal: (await createProposal({ botId, agentId, kind: "task", data })) as TaskProposal };
  };
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

/** A bot's pending suggestions, newest first. */
export async function listSuggestions(botId: string): Promise<TaskProposal[]> {
  return (await load()).filter(isTask).filter((proposal) => proposal.botId === botId && proposal.status === "pending").sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function decide(id: string, status: Proposal["status"]): Promise<TaskProposal> {
  return update((proposals) => {
    const current = proposals.find((proposal) => proposal.id === id);
    if (!current || !isTask(current)) throw new Error("This suggestion is no longer available.");
    if (current.status === "dismissed" && status === "dismissed") return { proposals, result: current };
    if (status !== "pending" && current.status !== "pending") throw new Error(current.status === "accepted" ? "This suggestion was already started." : "This suggestion was dismissed.");
    const decided: TaskProposal = { ...current, status, resolvedAt: status === "pending" ? null : new Date().toISOString() };
    return { proposals: proposals.map((proposal) => (proposal.id === id ? decided : proposal)), result: decided };
  });
}

export async function dismissSuggestion(id: string): Promise<void> {
  await decide(id, "dismissed");
}

/** Claims the suggestion first, so a second click can't start a second chat; a failed start puts it back. */
export async function startSuggestion(id: string, host: BotsHost, relay: Relay): Promise<{ chatId: string }> {
  const claimed = await decide(id, "accepted");
  try {
    const bot = await host.bot(claimed.botId);
    if (!bot || bot.archived) throw new Error("The bot that suggested this no longer exists.");
    return { chatId: await startChat(host, relay, bot, { prompt: claimed.data.prompt, title: claimed.data.title, labels: {} }) };
  } catch (error) {
    await decide(id, "pending").catch(() => {});
    throw error;
  }
}
