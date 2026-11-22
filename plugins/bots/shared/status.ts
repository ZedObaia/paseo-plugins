import { z } from "zod";

// What a bot says it's doing, written with its set_status tool onto its own chat's
// agent metadata. The bot page and the status sidebar plugin show it.

/** Agent metadata key; null (or absent) means no status. */
export const BOT_STATUS_METADATA = "fawzy.status";

const BotStatusSchema = z.object({
  text: z.string().min(1),
  /** Share done, 0–1; null when the bot can't tell. */
  progress: z.number().min(0).max(1).nullable(),
  updatedAt: z.string(),
});
export type BotStatus = z.infer<typeof BotStatusSchema>;

/** A chat's status from its agent metadata, or null. */
export function botStatusOf(metadata: Readonly<Record<string, unknown>> | null | undefined): BotStatus | null {
  const parsed = BotStatusSchema.safeParse(metadata?.[BOT_STATUS_METADATA]);
  return parsed.success ? parsed.data : null;
}
