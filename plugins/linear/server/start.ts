import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  ISSUE_LABEL,
  issueAttachment,
  issueMessage,
  type ChatIssue,
  type IssueAgent,
  type Link,
  type Scope,
} from "../shared/contracts";
import { issueIdOf, type StoredChats } from "./chats";
import { issueText, type IssueDetail } from "./linear";

// From the plugin SDK: an installed plugin has no node_modules, so only Paseo's own modules resolve
type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgentConfig = Parameters<PaseoApi["agents"]["create"]>[0]["config"];

const PARENT_LABEL = "paseo.parent-agent-id";
export const MAX_TITLE = 200;

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
export function firstMessage(issue: IssueDetail, linked: Link | null) {
  const prompt = [
    issueMessage(issue.identifier, { again: false, note: "" }),
    linked ? `This project is linked to Linear: ${linked.map(describeScope).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt, attachments: [issueAttachment({ ...issue, text: issueText(issue) })] };
}

/**
 * What agents that get Linear's tools are told: an issue reaches them as an attachment, and the
 * tools fill in what it leaves out.
 */
export function linearInstructions(servers: string[], readOnly: boolean): string {
  const named =
    servers.length === 1
      ? `the \`${servers[0]}\` MCP server`
      : `the ${servers.map((name) => `\`${name}\``).join(", ")} MCP servers, one per Linear workspace`;
  return [
    `Linear: you have Linear's tools, as ${named}${readOnly ? ", read-only" : ""}.`,
    'A Linear issue reaches you as an attachment that starts with "Linear issue <identifier>: <title>", with its description and latest comments.',
    "Unless the message says otherwise, that issue is your task: before you start, use Linear's tools for anything the attachment leaves out, like sub-issues, related issues and older comments.",
    readOnly ? "" : "Change the issue in Linear, like its status or comments, only when you're asked to.",
  ]
    .filter(Boolean)
    .join(" ");
}

const git = promisify(execFile);
const branchExists = (root: string, branch: string) =>
  git("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );

/** The Paseo project an agent in this directory works in: its workspace's, the deepest one holding it. */
export async function projectAt(paseo: PaseoApi, cwd: string): Promise<string | null> {
  const entries: Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    entries.push(...page.entries);
    cursor = page.pageInfo?.nextCursor ?? undefined;
  } while (cursor);
  const holding = entries
    .map((workspace) => ({
      projectId: workspace.projectId,
      dir: workspace.workspaceDirectory ?? workspace.projectRootPath,
    }))
    .filter(({ dir }) => cwd === dir || cwd.startsWith(`${dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length);
  return holding[0]?.projectId ?? null;
}

/** Agents working on these issues, newest first, by issue ID. */
export async function agentsFor(
  paseo: PaseoApi,
  issueIds: string[],
  chats: StoredChats,
): Promise<Record<string, IssueAgent[]>> {
  const wanted = new Set(issueIds);
  const { entries } = await paseo.agents.list({
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit: 200 },
  });
  const found: Record<string, IssueAgent[]> = {};
  for (const { agent } of entries) {
    const issueId = issueIdOf(agent, chats);
    if (!issueId || !wanted.has(issueId)) continue;
    (found[issueId] ??= []).push({ id: agent.id, title: agent.title, status: agent.status });
  }
  return found;
}

/**
 * The worktree for an issue: on its Linear branch, a new one off the base or the existing one an
 * earlier worktree left behind.
 */
export async function issueBranch(
  root: string,
  issue: Pick<IssueDetail, "branchName" | "identifier">,
): Promise<{ action: "checkout"; refName: string } | { action: "branch-off"; branchName: string }> {
  const branch = branchFor(issue);
  return (await branchExists(root, branch))
    ? { action: "checkout", refName: branch }
    : { action: "branch-off", branchName: branch };
}

/** The first Linear issue among a message's attachments, as the "+" menu and the pill attach it. */
export function attachedIssue(
  attachments: unknown,
): { id: string; identifier: string; title: string } | null {
  if (!Array.isArray(attachments)) return null;
  for (const attachment of attachments) {
    const resource = (attachment as { externalResource?: Record<string, unknown> } | null)?.externalResource;
    if (resource?.provider !== "linear" || resource.resourceType !== "issue") continue;
    const { id, identifier, title } = resource;
    if (typeof id === "string" && typeof identifier === "string")
      return { id, identifier, title: typeof title === "string" ? title : "" };
  }
  return null;
}

// the first agent follows its worktree within seconds; anything older was never made
const FIRST_AGENT_WAIT_MS = 2 * 60_000;

/**
 * Issues for the first agents of new worktrees, until they show up. A worktree's folder is named
 * after its slug, which no other worktree shares, so its agent runs in or under that folder.
 */
export class FirstAgents {
  private waiting = new Map<string, { chat: ChatIssue; until: number }>();

  expect(slug: string | undefined, chat: ChatIssue, now = Date.now()) {
    if (slug) this.waiting.set(slug, { chat, until: now + FIRST_AGENT_WAIT_MS });
  }

  /** The issue for an agent that just started here, once. */
  take(cwd: string, now = Date.now()): ChatIssue | null {
    for (const [slug, { until }] of this.waiting) if (until <= now) this.waiting.delete(slug);
    // a Windows path too
    const slug = cwd.split(/[\\/]/).find((part) => this.waiting.has(part));
    if (!slug) return null;
    const { chat } = this.waiting.get(slug)!;
    this.waiting.delete(slug);
    return chat;
  }
}

/**
 * Starts an agent with the issue as its first message, with the model of your latest chat. In a
 * new worktree it works on the issue's branch.
 */
export async function startAgent(
  paseo: PaseoApi,
  input: {
    workspaceId: string;
    issue: IssueDetail;
    where: "worktree" | "here";
    linked: (projectId: string) => Link | null;
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
    ...firstMessage(issue, input.linked(workspace.projectId)),
    labels: { [ISSUE_LABEL]: issue.id },
  };

  if (input.where === "here" || workspace.projectKind !== "git") {
    const agent = await paseo.workspaces.ref(workspace).agents.create(options);
    return { agentId: agent.id, workspaceId: workspace.id };
  }
  const created = await paseo.workspaces.create({
    source: {
      kind: "worktree",
      projectId: workspace.projectId,
      cwd: workspace.projectRootPath,
      ...(await issueBranch(workspace.projectRootPath, issue)),
    },
  });
  const agent = await created.agents.create(options);
  return { agentId: agent.id, workspaceId: created.id };
}
