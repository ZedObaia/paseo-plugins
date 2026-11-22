import { botStatusOf } from "../../shared/status";
import { chatBucket, type ChatBucketInput } from "../../shared/sidebar";

// What the bot page shows from a bot's chats (archived included).

export interface HomeChat extends ChatBucketInput {
  id: string;
  updatedAt: string;
  archivedAt?: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
}

const newest = (a: HomeChat, b: HomeChat) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);

/** In progress: running or needing the user; Recent: the other open chats; Closed: archived. Newest first. */
export function splitChats<T extends HomeChat>(chats: readonly T[]): { inProgress: T[]; recent: T[]; closed: T[] } {
  const sorted = [...chats].sort(newest);
  const open = sorted.filter((chat) => !chat.archivedAt);
  return {
    inProgress: open.filter((chat) => chatBucket(chat) !== "done"),
    recent: open.filter((chat) => chatBucket(chat) === "done"),
    closed: sorted.filter((chat) => chat.archivedAt),
  };
}

/** The header's line: the newest set_status of an open chat, else "Working…" while one runs. */
export function headerStatus(chats: readonly HomeChat[]): { text: string; progress: number | null } | null {
  const open = chats.filter((chat) => !chat.archivedAt);
  const said = open.flatMap((chat) => botStatusOf(chat.metadata) ?? []).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
  if (said) return { text: said.text, progress: said.progress };
  return open.some((chat) => chat.status === "running" || chat.status === "initializing") ? { text: "Working…", progress: null } : null;
}
