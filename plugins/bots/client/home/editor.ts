import { useEffect, useRef, useState } from "react";
import { pushHistory, type Bot } from "../../shared/bot";
import { mergeBotEdit, type BotEdit } from "../../shared/bot-edits";
import { useBotSettings } from "../useBotSettings";

type Commit = ReturnType<typeof useBotSettings>["commit"];

const SAVE_DELAY_MS = 600;

/** Saves a change to one bot now, keeping the version before it in History. */
export function saveBot(commit: Commit, botId: string, change: (saved: Bot) => Partial<Bot>): Promise<boolean> {
  return commit((values) => {
    const saved = values.bots.find((entry) => entry.id === botId);
    if (!saved) return values;
    return {
      ...values,
      bots: values.bots.map((entry) => (entry.id === botId ? { ...entry, ...change(saved), updatedAt: new Date().toISOString() } : entry)),
      history: pushHistory(values.history, saved),
    };
  });
}

/**
 * One bot with its unsaved edits on top, for its settings page. Typing saves a moment after it
 * stops and when the page closes; the Bots screen's patchBot and flush, for a single bot.
 */
export function useBotEditor(botId: string) {
  const { settings, latest, commit } = useBotSettings();
  const [edit, setEdit] = useState<BotEdit | null>(null);
  const editRef = useRef(edit);
  editRef.current = edit;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const pending = editRef.current;
    if (!pending) return;
    const ok = await commit((values) => {
      const saved = values.bots.find((entry) => entry.id === botId);
      if (!saved) return values;
      return {
        ...values,
        bots: values.bots.map((entry) => (entry.id === botId ? { ...mergeBotEdit(entry, pending), updatedAt: new Date().toISOString() } : entry)),
        history: pushHistory(values.history, saved),
      };
    });
    if (ok && editRef.current === pending) {
      editRef.current = null;
      setEdit(null);
    }
  };

  const patch = (change: Partial<Bot>) => {
    const saved = latest.current.status === "ready" ? latest.current.values.bots.find((entry) => entry.id === botId) : undefined;
    const base = editRef.current?.base ?? saved;
    if (!base) return;
    const next = { base, patch: { ...editRef.current?.patch, ...change, updatedAt: new Date().toISOString() } };
    editRef.current = next;
    setEdit(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  /** Drops unsaved edits, as after restoring an earlier version. */
  const discard = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    editRef.current = null;
    setEdit(null);
  };

  // Save pending edits when the page closes.
  useEffect(() => () => void flush(), []);

  const saved = settings.status === "ready" ? settings.values.bots.find((entry) => entry.id === botId) : undefined;
  return { settings, commit, bot: saved && edit ? mergeBotEdit(saved, edit) : saved, patch, flush, discard };
}
