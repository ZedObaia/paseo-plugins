import type { ChatIssue } from "../shared/contracts";

/** Each chat's issue on one host, as the daemon last said: what the pills show. */
export function chatStore() {
  let chats: Record<string, ChatIssue> = {};
  // changes made here, which answer after any read still on its way
  let changes = 0;
  const listeners = new Set<() => void>();
  const set = (next: Record<string, ChatIssue>) => {
    chats = next;
    for (const listener of listeners) listener();
  };
  return {
    get: (agentId: string): ChatIssue | null => chats[agentId] ?? null,
    /** What the daemon answered a change made here with. */
    changed(next: Record<string, ChatIssue>) {
      changes += 1;
      set(next);
    },
    /** Reads every chat's issue, unless a change made here lands first: the read may predate it. */
    async refresh(read: () => Promise<Record<string, ChatIssue>>) {
      const before = changes;
      const next = await read();
      if (changes === before) set(next);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type ChatStore = ReturnType<typeof chatStore>;
