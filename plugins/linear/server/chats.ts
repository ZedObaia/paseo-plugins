import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ISSUE_LABEL, type ChatIssue } from "../shared/contracts";
import { jsonFile } from "./files";

type PaseoApi = PluginHandlerContext["paseo"];

/** Each chat's issue by agent ID; null for one you detached, even if it was started from an issue. */
export type StoredChats = Record<string, ChatIssue | null>;

const file = jsonFile<StoredChats>("chats.json", () => ({}));

export const storedChats = file.read;

export const setChat = (agentId: string, issue: ChatIssue | null) =>
  file.change((chats) => ({ ...chats, [agentId]: issue }));

/** An agent just started from an issue, unless its chat was given another or detached meanwhile. */
export const startChat = (agentId: string, issue: ChatIssue) =>
  file.change((chats) => (agentId in chats ? chats : { ...chats, [agentId]: issue }));

/** The ones with an issue. */
export const withIssues = (chats: StoredChats): Record<string, ChatIssue> =>
  Object.fromEntries(Object.entries(chats).filter((entry): entry is [string, ChatIssue] => !!entry[1]));

/** The issue an agent works on: the one it was given, else the one it was started from. */
export const issueIdOf = (agent: { id: string; labels: Record<string, string> }, chats: StoredChats) =>
  agent.id in chats ? (chats[agent.id]?.id ?? null) : (agent.labels[ISSUE_LABEL] ?? null);

/** Issues found by ID; `complete` when every account answered, so the rest are confirmed missing. */
export interface Lookup {
  found: Record<string, ChatIssue>;
  complete: boolean;
}

/**
 * Every chat's issue. Agents started from an issue before chats were remembered, or just now,
 * carry only its ID: the first time one turns up, `find` looks its issue up and it's remembered.
 */
export function chatIndex(find: (issueIds: string[]) => Promise<Lookup>) {
  // issues no account can see, not asked about again until the accounts change
  const unknown = new Set<string>();
  // which accounts a lookup asked: one that answers after they changed may have missed the new one
  let accounts = 0;

  async function read(paseo: PaseoApi): Promise<Record<string, ChatIssue>> {
    const stored = await storedChats();
    // ponytail: the 200 latest updated agents, like the board's
    const { entries } = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200 },
    });
    const missing = new Map<string, string>();
    for (const { agent } of entries) {
      const issueId = agent.labels[ISSUE_LABEL];
      if (issueId && !(agent.id in stored) && !unknown.has(issueId)) missing.set(agent.id, issueId);
    }
    if (!missing.size) return withIssues(stored);
    const asked = accounts;
    const { found, complete } = await find([...new Set(missing.values())]);
    // an account that didn't answer, or wasn't asked, may have them: asked again next time
    if (complete && asked === accounts)
      for (const issueId of missing.values()) if (!found[issueId]) unknown.add(issueId);
    if (!Object.keys(found).length) return withIssues(stored);
    const changed = await file.change((chats) => {
      const next = { ...chats };
      // a chat given an issue meanwhile keeps it
      for (const [agentId, issueId] of missing)
        if (found[issueId] && !(agentId in next)) next[agentId] = found[issueId];
      return next;
    });
    return withIssues(changed);
  }

  /** An account was added or removed: issues nobody could see are worth asking about again. */
  const forget = () => {
    accounts += 1;
    unknown.clear();
  };

  return { read, forget };
}
