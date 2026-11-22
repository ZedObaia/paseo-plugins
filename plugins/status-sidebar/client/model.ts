// Pure rules copied from Paseo's default sidebar (packages/app/src at v0.17.1), kept apart
// from React so they can be tested.

import type { PluginTheme, WorkspaceIndicator } from "@getpaseo/plugin";

export type Bucket = WorkspaceIndicator;

/** STATUS_BUCKET_ORDER (utils/sidebar-agent-state.ts): the order status groups are listed in. */
export const STATUS_ORDER: readonly Bucket[] = ["needs_input", "failed", "attention", "running", "done"];

/** sidebar.statusBucket.* in i18n/resources/en.ts. */
export const STATUS_LABELS: Record<Bucket, string> = {
  needs_input: "Needs input",
  failed: "Failed",
  attention: "Ready to review",
  running: "Working",
  done: "Done",
};

/** A collapsed project shows its most urgent workspace; running outranks attention here. */
const AGGREGATE_PRIORITY: readonly Bucket[] = ["needs_input", "failed", "running", "attention", "done"];

export function aggregateStatus(buckets: Iterable<Bucket>): Bucket {
  let best = AGGREGATE_PRIORITY.length - 1;
  for (const bucket of buckets) best = Math.min(best, AGGREGATE_PRIORITY.indexOf(bucket));
  return AGGREGATE_PRIORITY[best];
}

/** styles/identity-colors.ts: project squares. */
const IDENTITY = [
  "#7a6aa8",
  "#3d7ea6",
  "#388068",
  "#a4673a",
  "#b05c80",
  "#6a70b8",
  "#368080",
  "#b06260",
  "#8f7838",
  "#5179b0",
];

export function identityColor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return IDENTITY[hash % IDENTITY.length];
}

export interface ProjectPlacement {
  serverId: string;
  projectId: string;
  /** The daemon's projectKey (`remote:<host>/<path>` for a repo with a remote); null when unknown. */
  projectKey: string | null;
}

export const placementId = (serverId: string, projectId: string) => `${serverId}\u0000${projectId}`;

/**
 * Paseo's project view keys (app/src/projects/workspace-structure.ts): a projectKey that is unique
 * on its host joins the same repo across hosts; anything else keeps its own placement key. The key
 * also seeds the square's color, so colors match the app's.
 */
export function allocateViewKeys(placements: readonly ProjectPlacement[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const { serverId, projectKey } of placements) {
    if (projectKey)
      counts.set(placementId(serverId, projectKey), (counts.get(placementId(serverId, projectKey)) ?? 0) + 1);
  }
  const taken = new Set(placements.flatMap(({ projectKey }) => (projectKey ? [projectKey] : [])));
  const keys = new Map<string, string>();
  for (const { serverId, projectId, projectKey } of placements) {
    let key: string;
    if (projectKey && counts.get(placementId(serverId, projectKey)) === 1) key = projectKey;
    else {
      key = JSON.stringify([serverId, projectId]);
      for (let suffix = 0; taken.has(key); suffix += 1) {
        key = JSON.stringify(["placement", serverId, projectId, suffix]);
      }
      taken.add(key);
    }
    keys.set(placementId(serverId, projectId), key);
  }
  return keys;
}

/** The letter on a project's square: first character of the last path segment. */
export function projectInitial(name: string): string {
  const last = name.trim().split("/").filter(Boolean).pop() ?? name.trim();
  return (last[0] ?? "").toUpperCase();
}

export function compareProjectNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** utils/time.ts describeCompactTimeAgo: "now", "5m", "3h", "2d", then "Oct 28". */
export function compactTimeAgo(iso: string, now: number): string {
  const date = new Date(iso);
  const elapsed = now - date.getTime();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return `${date.toLocaleDateString("en-US", { month: "short" })} ${date.getDate()}`;
}

const diffFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** git/file-header-presentation.ts formatDiffCount: 1234 -> "1.2k". */
export function formatDiffCount(value: number): string {
  return diffFormatter.format(value).toLowerCase();
}

/** Trimmed, case-folded; "" stands for Unlabelled in the label filter. */
export function labelKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * components/sidebar/sidebar-group-visibility.ts: a group shows its first `limit` rows plus every
 * row `keep` asks for. The open workspace leads when the limit would hide it.
 */
export function limitGroup<T>(
  items: readonly T[],
  options: { limit: number; expanded: boolean; keep?: (item: T) => boolean; isOpen: (item: T) => boolean },
): { leading: T | null; visible: readonly T[]; canToggle: boolean } {
  const baseline: T[] = [];
  let leading: T | null = null;
  let canToggle = false;
  items.forEach((item, index) => {
    if (index < options.limit || options.keep?.(item)) baseline.push(item);
    else if (leading === null && options.isOpen(item)) leading = item;
    else canToggle = true;
  });
  if (options.expanded || !canToggle) return { leading: null, visible: items, canToggle };
  return { leading, visible: baseline, canToggle };
}

export type Sort = "created" | "lastPrompt";

interface SortFacts {
  readonly ref: { readonly key: string };
  readonly createdAt: string | null;
  readonly lastPromptAt: string | null;
}

/** projects/workspace-structure.ts: newest first by the chosen time, then by key. */
const trimSlash = (path: string) => path.replace(/\/+$/, "");

/** A git project's main checkout: the project's own folder, not a linked worktree. Orca labels it "main". */
export function isMainCheckout(workspace: {
  readonly kind: string;
  readonly directory: string;
  readonly projectRootPath: string;
  readonly projectKind: string;
}): boolean {
  return (
    workspace.projectKind === "git" &&
    (workspace.kind === "local_checkout" || workspace.kind === "checkout") &&
    trimSlash(workspace.directory) === trimSlash(workspace.projectRootPath)
  );
}

/** The folders of a host's git projects that have no main checkout among its (active, shown) workspaces. */
export function missingMainCheckouts(
  projects: readonly { readonly projectRootPath: string; readonly projectKind: string }[],
  workspaces: readonly {
    readonly workspaceKind: string;
    readonly workspaceDirectory?: string;
    readonly projectRootPath: string;
    readonly projectKind: string;
  }[],
): string[] {
  const have = new Set(
    workspaces
      .filter((workspace) =>
        isMainCheckout({
          kind: workspace.workspaceKind,
          directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
          projectRootPath: workspace.projectRootPath,
          projectKind: workspace.projectKind,
        }),
      )
      .map((workspace) => trimSlash(workspace.projectRootPath)),
  );
  return projects
    .filter((project) => project.projectKind === "git" && !have.has(trimSlash(project.projectRootPath)))
    .map((project) => project.projectRootPath);
}

/** A project's rows: its main checkout first, then the chosen order. */
export function compareProjectRows(sort: Sort) {
  const rest = compareWorkspaces(sort);
  return (
    a: SortFacts & Parameters<typeof isMainCheckout>[0],
    b: SortFacts & Parameters<typeof isMainCheckout>[0],
  ) => Number(isMainCheckout(b)) - Number(isMainCheckout(a)) || rest(a, b);
}

export function compareWorkspaces(sort: Sort) {
  const time = (item: SortFacts) =>
    Date.parse((sort === "lastPrompt" ? (item.lastPromptAt ?? item.createdAt) : item.createdAt) ?? "") || 0;
  return (a: SortFacts, b: SortFacts) => time(b) - time(a) || a.ref.key.localeCompare(b.ref.key);
}

interface StatusFacts {
  readonly ref: { readonly key: string };
  readonly statusEnteredAt: string | null;
  readonly projectDisplayName: string;
  readonly name: string;
}

/** hooks/sidebar-status-view-model.ts: latest status change first, then project, name, key. */
export function compareStatusRows(a: StatusFacts, b: StatusFacts): number {
  const at = a.statusEnteredAt ? Date.parse(a.statusEnteredAt) : null;
  const bt = b.statusEnteredAt ? Date.parse(b.statusEnteredAt) : null;
  if (at !== null && bt !== null && at !== bt) return bt - at;
  if (at !== null && bt === null) return -1;
  if (at === null && bt !== null) return 1;
  return (
    a.projectDisplayName.localeCompare(b.projectDisplayName) ||
    a.name.localeCompare(b.name) ||
    a.ref.key.localeCompare(b.ref.key)
  );
}

/** Theme tokens the app reads that plugins don't receive. */
export interface Palette {
  sidebar: string;
  hover: string;
  selected: string;
  surface3: string;
  extraMuted: string;
  borderAccent: string;
  dark: boolean;
  dot: Record<Exclude<Bucket, "done">, string>;
  /** statusMerged: a merged pull request. */
  merged: string;
}

// styles/theme.ts per built-in theme, keyed by surface0:
// [surfaceSidebar, surface3, foregroundExtraMuted, borderAccent].
const BUILT_IN: Record<string, readonly string[]> = {
  "#ffffff": ["#f4f4f5", "#e4e4e7", "#a1a1aa", "#ececf1"],
  "#181b1a": ["#141716", "#434645", "#717574", "#2f3534"],
  "#18181b": ["#131316", "#3f3f46", "#71717a", "#303036"],
  "#161820": ["#121420", "#3c3e4c", "#6b6e82", "#2e3040"],
  "#1f1f1e": ["#1a1918", "#4a4745", "#78746f", "#36332f"],
  "#282c34": ["#21252d", "#4a4f5e", "#a0a4b2", "#3f4454"],
  "#000000": ["#000000", "#202020", "#71717a", "#242424"],
};

const LIGHT_DOTS = { attention: "#299f51", failed: "#f12e2f", needs_input: "#b37824", running: "#268ae0" };
const DARK_DOTS = { attention: "#35c264", failed: "#f7796d", needs_input: "#db932e", running: "#5caaf6" };

/** #rgb, #rgba, #rrggbb or #rrggbbaa as 0-1 channels; alpha is dropped, as Paseo does. */
const rgb = (hex: string) => {
  const full = hex.length <= 5 ? `#${[...hex.slice(1, 4)].map((c) => c + c).join("")}` : hex;
  return [1, 3, 5].map((at) => parseInt(full.slice(at, at + 2), 16) / 255);
};
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** utils/color.ts stepContrast: moves `hex` toward `toward` until it sits at `ratio` contrast. */
export function stepContrast(hex: string, toward: string, ratio: number): string {
  const [from, goal] = [luminance(hex), luminance(toward)];
  if (from === goal) return hex;
  const target = goal > from ? ratio * (from + 0.05) - 0.05 : (from + 0.05) / ratio - 0.05;
  const amount = Math.min(1, Math.max(0, (target - from) / (goal - from)));
  const end = rgb(toward);
  return `#${rgb(hex)
    .map((c, i) => {
      const value = toSrgb(toLinear(c) + (toLinear(end[i]) - toLinear(c)) * amount);
      return Math.round(Math.min(1, Math.max(0, value)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/**
 * Contrast steps from the sidebar toward the foreground (styles/derive-colors.ts). Paseo's own
 * hover is 1.11 dark / 1.15 light, faint enough to miss on warm dark themes, so the replica's
 * hover takes Paseo's selected step and selected steps further.
 */
const STATE_STEPS = { dark: { hover: 1.245, selected: 1.45 }, light: { hover: 1.35, selected: 1.6 } };

/**
 * Rebuilds the missing tokens: exact for Paseo's own themes, nearest supplied token otherwise.
 * Hover and selected are contrast steps from the sidebar, as in Paseo 0.17.
 */
export function paletteFor(colors: PluginTheme["colors"]): Palette {
  const dark = luminance(colors.surface0) < luminance(colors.foreground);
  const known = BUILT_IN[colors.surface0.toLowerCase()];
  const [sidebar, surface3, extraMuted, borderAccent] = known ?? [
    colors.surface0,
    dark ? colors.surface2 : colors.border,
    colors.foregroundMuted,
    colors.border,
  ];
  const steps = STATE_STEPS[dark ? "dark" : "light"];
  return {
    sidebar,
    hover: stepContrast(sidebar, colors.foreground, steps.hover),
    selected: stepContrast(sidebar, colors.foreground, steps.selected),
    surface3,
    extraMuted,
    borderAccent,
    dark,
    dot: dark ? DARK_DOTS : LIGHT_DOTS,
    merged: dark ? "#a890d5" : "#7347af",
  };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * git/worktree-archive-warning.ts: what archiving a worktree would lose, from the host's git state.
 * Unknown state (`git` null) is a risk of its own, so the caller asks rather than guess clean.
 */
export function archiveRisks(
  git: { isDirty?: boolean | null; aheadOfOrigin?: number | null },
  diff: { additions: number; deletions: number } | null,
): string[] {
  const reasons: string[] = [];
  const changed = diff ? diff.additions > 0 || diff.deletions > 0 : false;
  if (git.isDirty === true || (git.isDirty == null && changed)) {
    const lines = [
      diff?.additions ? count(diff.additions, "added line") : null,
      diff?.deletions ? count(diff.deletions, "deleted line") : null,
    ]
      .filter(Boolean)
      .join(", ");
    reasons.push(lines ? `Uncommitted changes (${lines})` : "Uncommitted changes");
  }
  if ((git.aheadOfOrigin ?? 0) > 0) reasons.push(count(git.aheadOfOrigin ?? 0, "unpushed commit"));
  return reasons;
}

/** utils/shorten-path.ts: the home directory as "~". */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/** git/pr-hint.ts selectPrHintFromStatus: the number from the PR's URL and a three-way state. */
export function prHint(pr: {
  url: string;
  state: string;
  isMerged?: boolean | null;
}): { number: number; state: "open" | "merged" | "closed" } | null {
  const number = Number(/\/(\d+)\/?(?:[?#].*)?$/.exec(pr.url)?.[1]);
  if (!Number.isFinite(number)) return null;
  const state = pr.state.toLowerCase();
  return {
    number,
    state: pr.isMerged || state === "merged" ? "merged" : state === "open" ? "open" : "closed",
  };
}

/** git/forge-url.ts buildForgeChecksUrl: GitHub's checks tab, GitLab's pipelines, else the PR. */
export function checksUrl(url: string): string {
  if (/\/pull\/\d+\/?$/.test(url)) return `${url.replace(/\/$/, "")}/checks`;
  if (/\/merge_requests\/\d+\/?$/.test(url)) return `${url.replace(/\/$/, "")}/pipelines`;
  return url;
}

export const CHECK_KINDS = ["success", "failure", "warning", "actionRequired", "manual", "pending"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** git/check-presentation.ts classifyCheck: traits first, then status; skipped and cancelled don't count. */
export function countChecks(
  checks: readonly { status: string; traits?: readonly string[] | null }[],
): Record<CheckKind, number> {
  const counts = { success: 0, failure: 0, warning: 0, actionRequired: 0, manual: 0, pending: 0 };
  for (const { status, traits = [] } of checks) {
    const kind: CheckKind | null = traits?.includes("action_required")
      ? "actionRequired"
      : traits?.includes("warning")
        ? "warning"
        : traits?.includes("manual")
          ? "manual"
          : status === "success" || status === "failure"
            ? status
            : status === "skipped" || status === "cancelled"
              ? null
              : "pending";
    if (kind) counts[kind] += 1;
  }
  return counts;
}

/** The label Fawzy puts on every bot chat: the bot's id. */
export const BOT_LABEL = "paseo-bots.bot";
/** Agent metadata a bot writes with its set_status tool. */
export const BOT_STATUS_KEY = "fawzy.status";
export { PROGRESS_KEY } from "../shared/progress";

export interface TaskItem {
  readonly text: string;
  readonly completed: boolean;
  readonly status?: "pending" | "in_progress" | "completed";
  readonly activeForm?: string;
}

/** A line under a running row, with its share done when known. */
export interface Progress {
  readonly text: string;
  readonly fraction: number | null;
}

export const taskDone = (item: TaskItem) => item.completed || item.status === "completed";

/** An agent's newest task list (Claude's todos, Codex's plan) as "2 of 4 · <current step>". */
export function taskProgress(items: readonly TaskItem[]): Progress | null {
  if (!items.length) return null;
  const done = items.filter(taskDone).length;
  const current =
    items.find((item) => item.status === "in_progress") ?? items.find((item) => !taskDone(item));
  const step = current ? (current.status === "in_progress" && current.activeForm) || current.text : "Done";
  return { text: `${done} of ${items.length} · ${step.trim()}`, fraction: done / items.length };
}

/**
 * At most `max` tasks for the hover card, from a little before the current one (the one in
 * progress, else the first not done, else the last), with how many are left out on each side.
 */
export function taskWindow(
  items: readonly TaskItem[],
  max = 12,
): { shown: readonly TaskItem[]; before: number; after: number } {
  if (items.length <= max) return { shown: items, before: 0, after: 0 };
  const running = items.findIndex((item) => item.status === "in_progress" && !taskDone(item));
  const next = items.findIndex((item) => !taskDone(item));
  const current = running !== -1 ? running : next !== -1 ? next : items.length - 1;
  const start = Math.max(0, Math.min(current - 3, items.length - max));
  return { shown: items.slice(start, start + max), before: start, after: items.length - start - max };
}

/** What a bot said about itself with set_status: `{ text, progress }`, progress 0–1. */
export function statusFromMetadata(value: unknown): Progress | null {
  if (!value || typeof value !== "object") return null;
  const { text, progress } = value as { text?: unknown; progress?: unknown };
  if (typeof text !== "string" || !text.trim()) return null;
  const fraction = typeof progress === "number" && progress >= 0 && progress <= 1 ? progress : null;
  return { text: text.trim(), fraction };
}

/** The plan an agent sent with report_progress, as task items. */
export function stepsFromMetadata(value: unknown): TaskItem[] {
  const steps = value && typeof value === "object" ? (value as { steps?: unknown }).steps : undefined;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step): TaskItem[] => {
    if (!step || typeof step !== "object") return [];
    const { text, status } = step as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || !text.trim()) return [];
    const known = status === "completed" || status === "in_progress" ? status : "pending";
    return [{ text: text.trim(), completed: known === "completed", status: known }];
  });
}

/** A reported line with how many of its steps are done: "2 of 5 · Running the test suite". */
export function countedProgress(said: Progress, steps: readonly TaskItem[]): Progress {
  if (!steps.length) return said;
  const done = steps.filter(taskDone).length;
  return {
    text: `${done} of ${steps.length} · ${said.text}`,
    fraction: said.fraction ?? done / steps.length,
  };
}

export type AttentionReason = "needs_input" | "failed" | "attention";

/** Most urgent first, as the bell lists them. */
export const ATTENTION_ORDER: readonly AttentionReason[] = ["needs_input", "failed", "attention"];

/** A chat's attention in the workspace indicator's terms: a permission request needs input. */
export function agentAttention(agent: {
  readonly requiresAttention: boolean;
  readonly attentionReason: "finished" | "error" | "permission" | null;
}): AttentionReason | null {
  if (!agent.requiresAttention) return null;
  if (agent.attentionReason === "permission") return "needs_input";
  return agent.attentionReason === "error" ? "failed" : "attention";
}

/** Older bot chats were titled "[Bot name] …"; under their bot they drop the prefix. */
export function chatTitle(title: string | null): string {
  return (title ?? "").replace(/^\[[^\]]*\]\s*/, "").trim() || "New chat";
}
