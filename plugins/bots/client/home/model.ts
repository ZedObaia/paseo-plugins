import { journalSource, journalSummary } from "../../shared/activity";
import { displayTitle, ROUTINE_LABEL } from "../../shared/chat";
import type { JournalRow } from "../../shared/rpc";
import { BUCKET_LABELS, chatBucket, type ChatBucketInput } from "../../shared/sidebar";
import { botStatusOf } from "../../shared/status";

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

export interface ActivityChat extends HomeChat {
  title?: string | null;
  labels?: Readonly<Record<string, string>> | null;
}

export interface ActivityItem {
  id: string;
  at: string;
  icon: string;
  text: string;
  hint: string;
  /** The chat it happened in, to open. */
  chatId: string | null;
}

/** What happened lately: its chats (a routine's runs named after it) and its memory changes, newest first. */
export function recentActivity(
  bot: { name: string; routines: readonly { id: string; name: string }[] },
  chats: readonly ActivityChat[],
  journal: readonly JournalRow[],
  limit = 8,
): ActivityItem[] {
  const fromChats = chats.map((chat): ActivityItem => {
    const routine = bot.routines.find((entry) => entry.id === chat.labels?.[ROUTINE_LABEL]);
    return {
      id: `chat:${chat.id}`,
      at: chat.updatedAt,
      icon: routine ? "CalendarClock" : "MessageSquare",
      text: routine ? `Ran ${routine.name || "a routine"}` : displayTitle(chat.title),
      hint: chat.archivedAt ? "Closed" : BUCKET_LABELS[chatBucket(chat)],
      chatId: chat.id,
    };
  });
  const fromMemory = journal.map((row): ActivityItem => ({
    id: `memory:${row.id}`,
    at: row.at,
    icon: "Brain",
    text: journalSummary(row, bot.name),
    hint: journalSource(row),
    chatId: row.chat?.id ?? null,
  }));
  return [...fromChats, ...fromMemory].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, limit);
}
