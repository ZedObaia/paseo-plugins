import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTIONS, reportProgress, withProgress } from "../server/progress";

const request = {
  purpose: "interactive" as const,
  background: false,
  tools: [],
  appendSystemPrompt: ["Project rules."],
  env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "0", HOME: "/home/z" },
};

test("every interactive agent gets report_progress, the instruction and Claude's task tools", () => {
  const next = withProgress(request);
  assert.ok(next);
  assert.deepEqual(next.tools, [reportProgress]);
  assert.deepEqual(next.appendSystemPrompt, ["Project rules.", INSTRUCTIONS]);
  // The agent's own setting wins.
  assert.equal(next.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "0");
  assert.equal(
    withProgress({ ...request, env: {} as Record<string, string> })?.env.CLAUDE_CODE_ENABLE_TODO_TOOLS,
    "1",
  );
  assert.equal(withProgress({ ...request, purpose: "history" }), undefined);
  assert.equal(withProgress({ ...request, background: true }), undefined);
});

test("report_progress keeps the plan it is given, tidied, beside the line", async () => {
  const saved: unknown[] = [];
  const context = {
    agent: { id: "a1" },
    paseo: { agents: { ref: () => ({ setMetadata: async (patch: unknown) => void saved.push(patch) }) } },
  };
  const run = (input: unknown) =>
    (reportProgress as unknown as { execute(input: unknown, context: unknown): Promise<unknown> }).execute(
      input,
      context,
    );
  await run({
    text: " Running  the tests ",
    progress: 0.5,
    steps: [
      { text: "Read the code", status: "completed" },
      { text: " Run   the tests ", status: "in_progress" },
      { text: "  ", status: "pending" },
      { text: "Open a PR", status: "pending" },
    ],
  });
  await run({ text: "Thinking" });
  const [first, second] = saved.map(
    (patch) => (patch as Record<string, Record<string, unknown>>)["paseo-sidebar.progress"],
  );
  assert.deepEqual(first?.steps, [
    { text: "Read the code", status: "completed" },
    { text: "Run the tests", status: "in_progress" },
    { text: "Open a PR", status: "pending" },
  ]);
  assert.equal(first?.text, "Running the tests");
  assert.equal("steps" in (second ?? {}), false);
});
