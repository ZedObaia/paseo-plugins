import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoAgentConfig, PaseoApi } from "@getpaseo/client";
import { issueAttachment, type IssueAgent, type Link, type Scope } from "../shared/contracts";
import { issueText, type IssueDetail } from "./linear";

/** The label an agent started from an issue carries: the issue's ID. */
export const ISSUE_LABEL = "linear.issue";
const PARENT_LABEL = "paseo.parent-agent-id";
const MAX_TITLE = 200;

interface RecentAgent {
  provider: string;
  model: string | null;
  currentModeId: string | null;
  thinkingOptionId?: string | null;
  workspaceId?: string;
  labels: Record<string, string>;
}

/**
 * The model to start with: your latest chat's in this project, else your latest anywhere. Paseo
 * has no default model of its own that plugins can read. Sub-agents don't count.
 */
export function pickConfig(recent: RecentAgent[], projectWorkspaces: ReadonlySet<string>): PaseoAgentConfig {
  const usable = recent.filter((agent) => agent.model && !agent.labels[PARENT_LABEL]);
  const agent =
    usable.find((agent) => agent.workspaceId && projectWorkspaces.has(agent.workspaceId)) ?? usable[0];
  if (!agent)
    throw new Error("Start a chat in Paseo first: agents from Linear use the model of your latest one.");
  return {
    provider: `${agent.provider}/${agent.model}`,
    ...(agent.currentModeId ? { modeId: agent.currentModeId } : {}),
    ...(agent.thinkingOptionId ? { thinkingOptionId: agent.thinkingOptionId } : {}),
  };
}

/** Linear's branch name for the issue as a branch Paseo accepts: lowercase letters, digits, - and /. */
export function branchFor(issue: Pick<IssueDetail, "branchName" | "identifier">): string {
  const slug = (issue.branchName || issue.identifier)
    .toLowerCase()
    .split("/")
    .map((part) =>
      part
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean)
    .join("/")
    .slice(0, 100)
    .replace(/[-/]+$/, "");
  return slug || issue.identifier.toLowerCase();
}

const describeScope = (scope: Scope) => (scope.kind === "all" ? scope.name : `${scope.kind} "${scope.name}"`);

/** The first message: what to do, with the issue attached the way the "+" menu attaches it. */
export function firstMessage(issue: IssueDetail, linked: Link | null, tools: boolean) {
  const prompt = [
    `Work on Linear issue ${issue.identifier}, attached.`,
    linked ? `This project is linked to Linear: ${linked.map(describeScope).join(", ")}.` : "",
    tools ? "Linear's tools are available to you as the `linear` MCP server." : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt, attachments: [issueAttachment({ ...issue, text: issueText(issue) })] };
}

const git = promisify(execFile);
const branchExists = (root: string, branch: string) =>
  git("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );

/** The Paseo project an agent in this directory works in: its workspace's, the deepest one holding it. */
export async function projectAt(paseo: PaseoApi, cwd: string): Promise<string | null> {
  const { entries } = await paseo.workspaces.list({ page: { limit: 200 } });
  const holding = entries
    .map((workspace) => ({
      projectId: workspace.projectId,
      dir: workspace.workspaceDirectory ?? workspace.projectRootPath,
    }))
    .filter(({ dir }) => cwd === dir || cwd.startsWith(`${dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length);
  return holding[0]?.projectId ?? null;
}

/** Agents started from these issues, newest first, by issue ID. */
export async function agentsFor(paseo: PaseoApi, issueIds: string[]): Promise<Record<string, IssueAgent[]>> {
  const wanted = new Set(issueIds);
  const { entries } = await paseo.agents.list({
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit: 200 },
  });
  const found: Record<string, IssueAgent[]> = {};
  for (const { agent } of entries) {
    const issueId = agent.labels[ISSUE_LABEL];
    if (!issueId || !wanted.has(issueId)) continue;
    (found[issueId] ??= []).push({ id: agent.id, title: agent.title, status: agent.status });
  }
  return found;
}

/**
 * Starts an agent with the issue as its first message, with the model of your latest chat. In a
 * new worktree it works on the issue's branch: a new one off the default branch, or the existing
 * branch from an earlier worktree.
 */
export async function startAgent(
  paseo: PaseoApi,
  input: {
    workspaceId: string;
    issue: IssueDetail;
    where: "worktree" | "here";
    linked: (projectId: string) => Link | null;
    tools: boolean;
  },
): Promise<{ agentId: string; workspaceId: string }> {
  const { issue } = input;
  const [workspace, { entries: workspaces }, { entries: recent }] = await Promise.all([
    paseo.workspaces.ref(input.workspaceId).refresh(),
    paseo.workspaces.list({ page: { limit: 200 } }),
    paseo.agents.list({ sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 50 } }),
  ]);
  if (!workspace) throw new Error("That workspace isn't open anymore.");
  // ponytail: the first 200 workspaces, enough to prefer this project's latest model
  const inProject = new Set(workspaces.filter((w) => w.projectId === workspace.projectId).map((w) => w.id));
  const options = {
    config: pickConfig(
      recent.map((entry) => entry.agent),
      inProject,
    ),
    title: `${issue.identifier} ${issue.title}`.slice(0, MAX_TITLE),
    ...firstMessage(issue, input.linked(workspace.projectId), input.tools),
    labels: { [ISSUE_LABEL]: issue.id },
  };

  if (input.where === "here" || workspace.projectKind !== "git") {
    const agent = await paseo.workspaces.ref(workspace).agents.create(options);
    return { agentId: agent.id, workspaceId: workspace.id };
  }
  const branch = branchFor(issue);
  const existing = await branchExists(workspace.projectRootPath, branch);
  const created = await paseo.workspaces.create({
    source: {
      kind: "worktree",
      projectId: workspace.projectId,
      cwd: workspace.projectRootPath,
      ...(existing ? { action: "checkout", refName: branch } : { action: "branch-off", branchName: branch }),
    },
  });
  const agent = await created.agents.create(options);
  return { agentId: agent.id, workspaceId: created.id };
}
