import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentAttention,
  aggregateStatus,
  archiveRisks,
  chatTitle,
  checksUrl,
  allocateViewKeys,
  compactTimeAgo,
  compareStatusRows,
  compareWorkspaces,
  contrastRatio,
  countChecks,
  formatDiffCount,
  identityColor,
  limitGroup,
  paletteFor,
  projectInitial,
  placementId,
  prHint,
  shortenPath,
  statusFromMetadata,
  taskProgress,
  stepContrast,
} from "../client/model";

test("compact ages match Paseo's: minutes, hours, days, then a date", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  assert.equal(compactTimeAgo("2026-11-13T11:59:40Z", now), "now");
  assert.equal(compactTimeAgo("2026-11-13T11:55:00Z", now), "5m");
  assert.equal(compactTimeAgo("2026-11-13T09:00:00Z", now), "3h");
  assert.equal(compactTimeAgo("2026-11-11T12:00:00Z", now), "2d");
  assert.equal(compactTimeAgo("2026-10-28T12:00:00Z", now), "Oct 28");
  assert.equal(formatDiffCount(1234), "1.2k");
});

test("view keys: one repo on several hosts joins on its projectKey, as in the app", () => {
  const beti = "remote:github.com/zedobaia/beti";
  const keys = allocateViewKeys([
    { serverId: "mac", projectId: "p1", projectKey: beti },
    { serverId: "devbox", projectId: "p2", projectKey: beti },
    { serverId: "winpc", projectId: "p3", projectKey: beti },
    { serverId: "mac", projectId: "p4", projectKey: "host:mac:/repos/local-only" },
    { serverId: "mac", projectId: "p5", projectKey: null },
    // The same key twice on one host can't be joined: each keeps its own placement.
    { serverId: "devbox", projectId: "p6", projectKey: "remote:github.com/a/twice" },
    { serverId: "devbox", projectId: "p7", projectKey: "remote:github.com/a/twice" },
  ]);
  for (const [server, id] of [
    ["mac", "p1"],
    ["devbox", "p2"],
    ["winpc", "p3"],
  ]) {
    assert.equal(keys.get(placementId(server, id)), beti);
  }
  assert.equal(keys.get(placementId("mac", "p4")), "host:mac:/repos/local-only");
  assert.equal(keys.get(placementId("mac", "p5")), JSON.stringify(["mac", "p5"]));
  assert.equal(keys.get(placementId("devbox", "p6")), JSON.stringify(["devbox", "p6"]));
  assert.equal(keys.get(placementId("devbox", "p7")), JSON.stringify(["devbox", "p7"]));
  assert.equal(identityColor(beti), identityColor(beti));
  assert.equal(projectInitial("3afya/3afya-app"), "3");
  assert.equal(projectInitial("chapbook"), "C");
});

test("a collapsed project shows its most urgent status; running beats ready", () => {
  assert.equal(aggregateStatus(["done", "attention", "running"]), "running");
  assert.equal(aggregateStatus(["running", "failed"]), "failed");
  assert.equal(aggregateStatus([]), "done");
});

test("groups show their limit plus kept rows, and lead with an open row the limit hides", () => {
  const items = ["a", "b", "c", "d"];
  const isOpen = (item: string) => item === "d";
  assert.deepEqual(limitGroup(items, { limit: 2, expanded: false, isOpen }), {
    leading: "d",
    visible: ["a", "b"],
    canToggle: true,
  });
  assert.deepEqual(
    limitGroup([...items, "e"], { limit: 2, expanded: false, keep: (item) => item === "c", isOpen }),
    {
      leading: "d",
      visible: ["a", "b", "c"],
      canToggle: true,
    },
  );
  assert.deepEqual(limitGroup(items, { limit: 2, expanded: true, isOpen }).visible, items);
});

const ws = (
  key: string,
  over: Partial<Parameters<typeof compareStatusRows>[0]> & {
    createdAt?: string | null;
    lastPromptAt?: string | null;
  } = {},
) => ({
  ref: { key },
  createdAt: null,
  lastPromptAt: null,
  statusEnteredAt: null,
  projectDisplayName: "p",
  name: key,
  ...over,
});

test("workspaces sort newest first by creation or last prompt; status rows by latest change", () => {
  const old = ws("old", { createdAt: "2026-11-01T00:00:00Z", lastPromptAt: "2026-11-12T00:00:00Z" });
  const recent = ws("new", { createdAt: "2026-11-10T00:00:00Z" });
  assert.deepEqual(
    [old, recent].sort(compareWorkspaces("created")).map((item) => item.ref.key),
    ["new", "old"],
  );
  assert.deepEqual(
    [recent, old].sort(compareWorkspaces("lastPrompt")).map((item) => item.ref.key),
    ["old", "new"],
  );
  const changed = ws("b", { statusEnteredAt: "2026-11-12T00:00:00Z" });
  assert.deepEqual(
    [ws("a"), changed].sort(compareStatusRows).map((item) => item.ref.key),
    ["b", "a"],
  );
});

test("palette restores the tokens plugins miss, with hover a clear step and selected a bigger one", () => {
  const base = {
    surface1: "#1E2120",
    surface2: "#272A29",
    border: "#252B2A",
    foreground: "#fafafa",
    foregroundMuted: "#A1A5A4",
    accent: "#20744A",
    accentForeground: "#ffffff",
    statusSuccess: "#6cb17b",
    statusWarning: "#c09664",
    statusDanger: "#d8847b",
  };
  // Paseo 0.17's own derivation (derive-colors.ts) on Paseo dark: hover 1.11, selected 1.245.
  assert.equal(stepContrast("#141716", "#fafafa", 1.11), "#1f2120");
  assert.equal(stepContrast("#141716", "#fafafa", 1.245), "#282a29");
  const dark = paletteFor({ ...base, surface0: "#181B1A" });
  assert.equal(dark.sidebar, "#141716");
  assert.equal(dark.hover, "#282a29");
  assert.ok(contrastRatio(dark.sidebar, dark.selected) > contrastRatio(dark.sidebar, dark.hover));
  const claude = paletteFor({ ...base, surface0: "#1f1f1e" });
  assert.ok(contrastRatio(claude.sidebar, claude.hover) > 1.2);
  const light = paletteFor({
    ...base,
    surface0: "#ffffff",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    foreground: "#1a1a1e",
  });
  assert.equal(light.dark, false);
  assert.ok(contrastRatio(light.sidebar, light.hover) > 1.3);
  assert.equal(light.dot.running, "#268ae0");
  assert.equal(paletteFor({ ...base, surface0: "#101010" }).sidebar, "#101010");
  assert.equal(stepContrast("#000", "#fff", 21), "#ffffff");
});

test("archiving a worktree warns only about work it would lose, as Paseo 0.17 does", () => {
  assert.deepEqual(archiveRisks({ isDirty: false, aheadOfOrigin: 0 }, { additions: 3, deletions: 0 }), []);
  assert.deepEqual(archiveRisks({ isDirty: true, aheadOfOrigin: 2 }, { additions: 1, deletions: 4 }), [
    "Uncommitted changes (1 added line, 4 deleted lines)",
    "2 unpushed commits",
  ]);
  assert.deepEqual(archiveRisks({ isDirty: null }, { additions: 0, deletions: 2 }), [
    "Uncommitted changes (2 deleted lines)",
  ]);
  assert.deepEqual(archiveRisks({ isDirty: true }, null), ["Uncommitted changes"]);
});

test("hover card facts: PR number and state, checks link and counts, short paths", () => {
  assert.deepEqual(prHint({ url: "https://github.com/a/b/pull/131", state: "OPEN" }), {
    number: 131,
    state: "open",
  });
  assert.deepEqual(prHint({ url: "https://github.com/a/b/pull/7", state: "closed", isMerged: true }), {
    number: 7,
    state: "merged",
  });
  assert.equal(prHint({ url: "https://github.com/a/b", state: "open" }), null);
  assert.equal(checksUrl("https://github.com/a/b/pull/12"), "https://github.com/a/b/pull/12/checks");
  assert.equal(
    checksUrl("https://gitlab.com/a/b/-/merge_requests/12"),
    "https://gitlab.com/a/b/-/merge_requests/12/pipelines",
  );
  assert.deepEqual(
    countChecks([
      { status: "success" },
      { status: "failure" },
      { status: "failure", traits: ["action_required"] },
      { status: "skipped" },
      { status: "pending" },
      { status: "in_progress" },
    ]),
    { success: 1, failure: 1, warning: 0, actionRequired: 1, manual: 0, pending: 2 },
  );
  assert.equal(shortenPath("/Users/zeyad/workspace/x"), "~/workspace/x");
  assert.equal(shortenPath("/srv/x"), "/srv/x");
});

test("progress: the newest task list, or what the bot said about itself", () => {
  assert.deepEqual(
    taskProgress([
      { text: "Read the issue", completed: true, status: "completed" },
      { text: "Reply on GitHub", completed: false, status: "in_progress", activeForm: "Replying on GitHub" },
      { text: "Close it", completed: false, status: "pending" },
      { text: "Log it", completed: false },
    ]),
    { text: "1 of 4 · Replying on GitHub", fraction: 0.25 },
  );
  assert.deepEqual(taskProgress([{ text: "Plan", completed: false }]), {
    text: "0 of 1 · Plan",
    fraction: 0,
  });
  assert.deepEqual(taskProgress([{ text: "Plan", completed: true }]), { text: "1 of 1 · Done", fraction: 1 });
  assert.equal(taskProgress([]), null);
  assert.deepEqual(statusFromMetadata({ text: " Triaging inbox ", progress: 0.4 }), {
    text: "Triaging inbox",
    fraction: 0.4,
  });
  assert.deepEqual(statusFromMetadata({ text: "Watching PRs", progress: 7 }), {
    text: "Watching PRs",
    fraction: null,
  });
  assert.equal(statusFromMetadata({ text: "" }), null);
  assert.equal(statusFromMetadata(null), null);
});

test("attention: permission needs input, errors failed, finished turns are ready to review", () => {
  assert.equal(agentAttention({ requiresAttention: true, attentionReason: "permission" }), "needs_input");
  assert.equal(agentAttention({ requiresAttention: true, attentionReason: "error" }), "failed");
  assert.equal(agentAttention({ requiresAttention: true, attentionReason: "finished" }), "attention");
  assert.equal(agentAttention({ requiresAttention: false, attentionReason: "finished" }), null);
  assert.equal(chatTitle("[fawzy] Morning digest"), "Morning digest");
  assert.equal(chatTitle(null), "New chat");
});
