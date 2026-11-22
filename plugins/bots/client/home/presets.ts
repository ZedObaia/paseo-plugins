import { newRoutineId, type Bot, type Routine, type RoutineSchedule } from "../../shared/bot";
import { describeSchedule } from "../../shared/routines";
import type { MenuEntry } from "../ui/Menu";

// Ready-made routines offered under "New routine" (settings) and "Add" (bot page).

interface RoutinePreset {
  name: string;
  icon: string;
  schedule: RoutineSchedule;
  prompt: string;
}

export const ROUTINE_PRESETS: readonly RoutinePreset[] = [
  {
    name: "Look around",
    icon: "Telescope",
    schedule: { kind: "interval", minutes: 240 },
    prompt:
      "Look around for useful work you could do for me. Check your connected apps and tools, your recent chats (search_chats) and your memory. Then call suggest_task for up to 5 useful, concrete tasks, each with a clear title, a prompt that works on its own, its source and why it matters now. Never repeat a suggestion I dismissed; suggest_task tells you when one was already made. Suggest nothing rather than filler, and don't do the tasks themselves in this run.",
  },
  {
    name: "Tidy memory",
    icon: "Brain",
    schedule: { kind: "daily", time: "02:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    prompt:
      "Tidy your memory. Read MEMORY.md and your topic files under memory/. Consolidate them: merge duplicate entries, move details into the right topic file, and remove entries that are stale, wrong or no longer useful. Keep MEMORY.md short (well under 200 lines) as an index of what matters most. Don't invent facts or delete anything you're unsure about. Finish with a short summary of what you changed.",
  },
];

export function presetRoutine(preset: RoutinePreset, now = new Date()): Routine {
  return { id: newRoutineId(), name: preset.name, prompt: preset.prompt, enabled: true, schedule: preset.schedule, resultsChatId: null, createdAt: now.toISOString() };
}

/** Menu entries: each preset (greyed out once the bot has it), then the custom routine form. */
export function newRoutineEntries(bot: Bot, add: (routine: Routine) => void, custom: () => void): MenuEntry[] {
  return [
    ...ROUTINE_PRESETS.map((preset) => {
      const added = bot.routines.some((routine) => routine.name === preset.name);
      return { label: preset.name, icon: preset.icon, trailing: added ? "Added" : describeSchedule(preset.schedule), disabled: added, onSelect: () => add(presetRoutine(preset)) };
    }),
    { kind: "separator" },
    { label: "Custom routine", icon: "Plus", onSelect: custom },
  ];
}
