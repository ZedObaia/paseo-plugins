import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_COMMANDS = 40;
export const MAX_LABEL = 80;
export const MAX_COMMAND = 4000;

export const quickCommand = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1, "Give it a name").max(MAX_LABEL),
  command: z
    .string()
    .max(MAX_COMMAND)
    .refine((text) => text.trim().length > 0, "Type the command"),
  /** The project whose workspaces it's for; null for every project's. */
  projectId: z.string().nullable().default(null),
  /** That project's name, for when Paseo no longer has it. */
  projectName: z.string().default(""),
  /** Where it runs, relative to the workspace's folder: empty for the folder itself. */
  folder: z.string().default(""),
  /** Off: typed in, for you to finish or run. */
  pressEnter: z.boolean().default(true),
  /** Closes the terminal of its last run in that workspace first, like restarting a dev server. */
  replace: z.boolean().default(false),
  /** Exports the workspace's .env, and the folder's when it runs in another one. */
  loadDotenv: z.boolean().default(false),
});
export type QuickCommand = z.infer<typeof quickCommand>;

export const commandSettings = defineSettings({
  id: "commands",
  scope: "host",
  version: 1,
  schema: z.object({ commands: z.array(quickCommand).max(MAX_COMMANDS).default([]) }),
});

/** A workspace's commands: its project's first, then everyone's, each in the order you put them. */
export function commandsFor(commands: readonly QuickCommand[], projectId: string): QuickCommand[] {
  return [
    ...commands.filter((command) => command.projectId === projectId),
    ...commands.filter((command) => command.projectId === null),
  ];
}

/** A new command's ID: lowercase letters and digits, which Paseo takes in contribution IDs. */
export const newCommandId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Whether another command already has this name: /run and replacing a last run go by names. */
export const nameTaken = (commands: readonly QuickCommand[], command: Pick<QuickCommand, "id" | "label">) =>
  commands.some(
    (other) =>
      other.id !== command.id && other.label.trim().toLowerCase() === command.label.trim().toLowerCase(),
  );

/** The list with this command saved: in its place when it's there, else at the end. */
export function withCommand(commands: readonly QuickCommand[], command: QuickCommand): QuickCommand[] {
  if (nameTaken(commands, command)) throw new Error(`Another command is named ${command.label}`);
  return commands.some((other) => other.id === command.id)
    ? commands.map((other) => (other.id === command.id ? command : other))
    : [...commands, command];
}

/** Where a command applies, for lists and Command Center titles. */
export const scopeName = (command: Pick<QuickCommand, "projectId" | "projectName">) =>
  command.projectId ? command.projectName || "a project Paseo no longer has" : "Every project";

/**
 * The command `/run <name>` means among a workspace's: its name in any case, else the one whose
 * name starts with what's typed. Errors say which names there are.
 */
export function pickCommand(commands: readonly QuickCommand[], typed: string): QuickCommand {
  if (!commands.length)
    throw new Error(
      "This workspace has no quick commands yet: add some in Settings, Plugins, Quick commands.",
    );
  const names = commands.map((command) => command.label).join(", ");
  const wanted = typed.trim().toLowerCase();
  if (!wanted) throw new Error(`Name one after /run: ${names}.`);
  const exact = commands.find((command) => command.label.toLowerCase() === wanted);
  if (exact) return exact;
  const starting = commands.filter((command) => command.label.toLowerCase().startsWith(wanted));
  if (starting.length === 1) return starting[0];
  if (starting.length > 1)
    throw new Error(`"${typed.trim()}" could be ${starting.map((command) => command.label).join(" or ")}.`);
  throw new Error(`No quick command here is named "${typed.trim()}": ${names}.`);
}

export const runRpc = defineRpc({
  name: "quick-commands.run",
  input: z.object({
    workspaceId: z.string().min(1),
    commandId: z.string().min(1),
    /** Overrides the command's own setting, for "Type it in". */
    pressEnter: z.boolean().optional(),
  }),
  output: z.object({ terminalId: z.string() }),
});

/**
 * Every saved command as the daemon has them now, with the revision to save over: the Command
 * Center needs them outside components, and saving needs the file's latest copy.
 */
export const listRpc = defineRpc({
  name: "quick-commands.list",
  input: z.object({}),
  output: z.object({ commands: z.array(quickCommand), revision: z.string() }),
});
