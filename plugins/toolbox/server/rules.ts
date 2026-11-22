import type { Behavior, Rule } from "../shared/contracts";

/** A permission rule about MCP tools, from one of Claude's settings files. */
export type Permission = {
  // "mcp__github", "mcp__github__*" or "mcp__github__create_issue"
  rule: string;
  behavior: Behavior;
  source: "user" | "project" | "local";
};

/** How Claude names a server in tool names and permission rules: mcp__<this>__<tool>. */
export const ruleName = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * What Claude does when a chat calls one of the server's tools (`tool` null: all of them), and
 * which settings file says so. A deny anywhere wins, then ask, then allow; with no rule, it asks.
 */
export function effectiveRule(
  permissions: Permission[],
  server: string,
  tool: string | null,
): { behavior: Behavior; source: Permission["source"] | null } {
  const base = ruleName(server);
  const rules = new Set(tool ? [base, `${base}__*`, `${base}__${tool}`] : [base, `${base}__*`]);
  const matching = permissions.filter((p) => rules.has(p.rule));
  for (const behavior of ["deny", "ask", "allow"] as const) {
    const hit = matching.find((p) => p.behavior === behavior);
    if (hit) return { behavior, source: hit.source };
  }
  return { behavior: "ask", source: null };
}

/**
 * The folder's own rule to write for a choice: Ask needs a rule only when something else would
 * allow the tool; otherwise the folder's rule is dropped and Claude asks by default.
 */
export function ruleFor(
  permissions: Permission[],
  server: string,
  tool: string | null,
  choice: Behavior,
): { rule: string; behavior: Behavior | "default" } {
  const rule = tool ? `${ruleName(server)}__${tool}` : ruleName(server);
  if (choice !== "ask") return { rule, behavior: choice };
  const others = permissions.filter((p) => !(p.source === "local" && p.rule === rule));
  return { rule, behavior: effectiveRule(others, server, tool).behavior === "allow" ? "ask" : "default" };
}

const LOCKED_BY = { user: "your user settings", project: "the project's shared settings" };

/** The panel's view of a rule: Claude's choice, and what keeps it if this folder can't change it. */
export function ruleView(permissions: Permission[], server: string, tool: string | null): Rule {
  const { behavior, source } = effectiveRule(permissions, server, tool);
  // a deny the folder doesn't own wins over anything the folder says
  return {
    behavior,
    lockedBy: behavior === "deny" && source && source !== "local" ? LOCKED_BY[source] : null,
  };
}
