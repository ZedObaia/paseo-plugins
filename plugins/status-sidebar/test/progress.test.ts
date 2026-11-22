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
  assert.equal(withProgress({ ...request, env: {} as Record<string, string> })?.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
  assert.equal(withProgress({ ...request, purpose: "history" }), undefined);
  assert.equal(withProgress({ ...request, background: true }), undefined);
});
