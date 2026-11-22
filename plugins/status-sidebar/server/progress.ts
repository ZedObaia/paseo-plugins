// Every agent this host opens, on any provider, is told to show its progress in the sidebar: with
// its own task list where it has one (Paseo turns Claude's tasks, Codex's plan and other agents'
// todos into the same timeline item), else with the report_progress tool added here.

import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import { PROGRESS_KEY } from "../shared/progress";

export const INSTRUCTIONS = [
  "Progress in the Paseo sidebar: the user follows your work from their sidebar, so for any task with three or more steps, always report your progress; don't skip it.",
  "In Claude Code use TaskCreate and TaskUpdate (load them with ToolSearch first if they are deferred): create one task per step before you start, set each to in_progress as you begin it and to completed when it is done.",
  "In Codex keep the plan tool updated the same way.",
  'Any other agent, or one without a task tool, calls report_progress (mcp__paseo__report_progress in Claude Code) at each step with a short present-tense label such as "Running the test suite" and the share done.',
  "Skip it only for quick one-step answers.",
].join(" ");

export const reportProgress = defineAgentTool({
  name: "report_progress",
  title: "Report progress",
  description:
    "Show what you are doing, and how far along you are, on this chat's row in the user's Paseo sidebar. Call it at each step of a longer task; it clears itself when your turn ends.",
  input: z.object({
    text: z
      .string()
      .max(80)
      .describe(
        'What you are doing now, at most 80 characters, e.g. "Running the test suite". "" clears it.',
      ),
    progress: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Share of the work done, from 0 to 1, when you can tell."),
  }),
  async execute({ text, progress }, { agent, paseo }) {
    const line = text.replace(/\s+/g, " ").trim();
    const value = line
      ? { text: line, progress: progress ?? null, updatedAt: new Date().toISOString() }
      : null;
    await paseo.agents.ref(agent.id).setMetadata({ [PROGRESS_KEY]: value });
    return { text: line ? "Shown in the sidebar." : "Cleared." };
  },
});

interface OpenRequest {
  purpose: "interactive" | "history";
  readonly background: boolean;
  tools: AgentToolDefinition[];
  appendSystemPrompt?: string[];
  env: Record<string, string>;
}

/** The open request with the tool, the instruction, and Claude Code's task tools switched on. */
export function withProgress<Request extends OpenRequest>(request: Request): Request | undefined {
  // History reads run no turn; background helpers never show in the sidebar.
  if (request.purpose !== "interactive" || request.background) return undefined;
  return {
    ...request,
    tools: [...request.tools, reportProgress],
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), INSTRUCTIONS],
    // Claude Code leaves its task tools off for SDK sessions on most models; other agents ignore it.
    env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", ...request.env },
  };
}
