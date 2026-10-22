import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  chatIssueOf,
  IDENTIFIER,
  issueAttachment,
  issueMessage,
  findRpc,
  setChatRpc,
  startRpc,
  type SearchItem,
} from "../shared/contracts";
import type { ChatStore } from "./chats";

type Rpc = PluginClientContext["rpc"];

/** `ENG-123 and a message`: the identifier, then whatever you'd like to say with it. */
export function parseArgs(args: string): { identifier: string; note: string } {
  const text = args.trim();
  const [first = ""] = text.split(/\s/, 1);
  // the app shows what a command throws under the message box
  if (!IDENTIFIER.test(first)) throw new Error("Type an issue's identifier after the command, like ENG-123.");
  return { identifier: first.toUpperCase(), note: text.slice(first.length).trim() };
}

/**
 * The issue with this identifier among search results: one, or an error that says where to pick
 * it when two of your accounts each have an issue by that identifier.
 */
export function matchIssue(items: SearchItem[], identifier: string, pickInstead: string): SearchItem {
  const matches = new Map(
    items.filter((item) => item.identifier.toUpperCase() === identifier).map((item) => [item.id, item]),
  );
  if (!matches.size) throw new Error(`None of your Linear accounts has ${identifier}.`);
  if (matches.size > 1)
    throw new Error(`More than one of your Linear accounts has a ${identifier}: ${pickInstead}.`);
  return [...matches.values()][0];
}

async function find(rpc: Rpc, identifier: string, pickInstead: string): Promise<SearchItem> {
  const { items, complete } = await rpc(findRpc, { identifier });
  // an account that didn't answer may have one too
  if (!complete)
    throw new Error(
      `Not every Linear account answered, so another may have a ${identifier}: ${pickInstead}.`,
    );
  return matchIssue(items, identifier, pickInstead);
}

/**
 * `/linear ENG-123` sends an issue to the chat it's typed in, like its pill, and `/linear-new
 * ENG-123` starts an agent on one in the workspace, from a new chat's box where there's no pill.
 * Plugins can't suggest a command's arguments, so the identifier is typed.
 */
export function linearCommands(client: PluginClientContext, store: ChatStore): PluginCleanup[] {
  return [
    client.addSlashCommand({
      name: "linear",
      description: "Send a Linear issue to this chat and make it the chat's issue",
      argumentHint: "ENG-123 [message]",
      context: "agent",
      onSubmit: async ({ rpc, paseo, agent, args }) => {
        const { identifier, note } = parseArgs(args);
        const issue = await find(
          rpc,
          identifier,
          "pick it from the pill, which says which account each is from",
        );
        const busy = agent.status === "running" || agent.status === "initializing";
        const again = store.get(agent.id)?.id === issue.id;
        await paseo.agents.ref(agent.id).send(issueMessage(issue.identifier, { again, note }), {
          attachments: [issueAttachment(issue)],
          ...(busy ? { activeTurnBehavior: "steer" as const } : {}),
        });
        if (again) return;
        try {
          store.changed((await rpc(setChatRpc, { agentId: agent.id, issue: chatIssueOf(issue) })).chats);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Sent ${issue.identifier}, but couldn't make it this chat's issue: ${reason}`);
        }
      },
    }),
    client.addSlashCommand({
      name: "linear-new",
      description: "Start an agent on a Linear issue in this workspace",
      argumentHint: "ENG-123",
      context: "workspace",
      onSubmit: async ({ rpc, workspace, args }) => {
        const issue = await find(
          rpc,
          parseArgs(args).identifier,
          "start it from the Linear board, which shows one account's issues",
        );
        await rpc(startRpc, {
          accountId: issue.accountId,
          workspaceId: workspace.id,
          issueId: issue.id,
          where: "here",
        });
      },
    }),
  ];
}
