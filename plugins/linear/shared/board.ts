import type { Issue, Scope, State } from "./contracts";

// Linear's order on a board
const STATE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

export const byWorkflow = (a: State, b: State) =>
  STATE_ORDER.indexOf(a.type) - STATE_ORDER.indexOf(b.type) || a.position - b.position;

// urgent (1) first, no priority (0) last
const rank = (priority: number) => (priority === 0 ? 5 : priority);

export interface Column {
  state: State;
  issues: Issue[];
}

/**
 * One column per status name, so a project or view across teams merges their "In Progress"
 * columns; in workflow order, issues by priority, then the latest updated.
 */
export function columns(issues: Issue[]): Column[] {
  const byName = new Map<string, Column>();
  for (const issue of issues) {
    const column = byName.get(issue.state.name);
    if (column) column.issues.push(issue);
    else byName.set(issue.state.name, { state: issue.state, issues: [issue] });
  }
  const sorted = [...byName.values()].sort((a, b) => byWorkflow(a.state, b.state));
  for (const column of sorted)
    column.issues.sort(
      (a, b) => rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt),
    );
  return sorted;
}

/** The labels on these issues, the most used first. */
export function labelsOf(issues: Issue[], limit = 12): { name: string; color: string }[] {
  const counts = new Map<string, { name: string; color: string; count: number }>();
  for (const label of issues.flatMap((issue) => issue.labels)) {
    const seen = counts.get(label.name);
    if (seen) seen.count++;
    else counts.set(label.name, { ...label, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, color }) => ({ name, color }));
}

export const keyOf = (scope: Scope) => `${scope.kind}:${scope.id}`;

/** Ticks one, or unticks it; all issues cover the rest, so they go alone. */
export function toggle(chosen: Scope[], scope: Scope): Scope[] {
  if (chosen.some((s) => keyOf(s) === keyOf(scope))) return chosen.filter((s) => keyOf(s) !== keyOf(scope));
  return scope.kind === "all" ? [scope] : [...chosen.filter((s) => s.kind !== "all"), scope];
}
