import { defineAttachmentSource, defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** What a Paseo project shows: all issues of one Linear account, or one team, project or saved view. */
const scope = z.object({
  accountId: z.string().min(1),
  kind: z.enum(["all", "team", "project", "view"]),
  id: z.string().min(1),
  name: z.string(),
});
export type Scope = z.infer<typeof scope>;

/** What a Paseo project is linked to: all of one account's issues, or any of its teams, projects and views. */
const link = z.array(scope).min(1);
export type Link = z.infer<typeof link>;

const state = z.object({
  id: z.string(),
  name: z.string(),
  /** triage, backlog, unstarted, started, completed or canceled. */
  type: z.string(),
  color: z.string(),
  position: z.number(),
});
export type State = z.infer<typeof state>;

const issue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  /** 0 none, 1 urgent … 4 low. */
  priority: z.number(),
  priorityLabel: z.string(),
  state,
  teamId: z.string(),
  assignee: z.string().nullable(),
  mine: z.boolean(),
  project: z.string().nullable(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof issue>;

/** An agent started from an issue, found by the label it was started with. */
const agent = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
});
export type IssueAgent = z.infer<typeof agent>;

const account = z.object({
  id: z.string(),
  /** The Linear workspace, like "Acme". */
  workspace: z.string(),
  name: z.string(),
  email: z.string(),
  /** LINEAR_API_KEY from the daemon's environment, which can't be removed here. */
  fromEnvironment: z.boolean(),
  /** Why Linear doesn't accept its key anymore. */
  error: z.string().nullable(),
});
export type Account = z.infer<typeof account>;
const accounts = z.object({ accounts: z.array(account) });

export const accountsRpc = defineRpc({ name: "linear.accounts", input: z.object({}), output: accounts });

/** Checks a personal API key with Linear and adds its account; the same account again replaces its key. */
export const addAccountRpc = defineRpc({
  name: "linear.accounts.add",
  input: z.object({ apiKey: z.string().min(1) }),
  output: accounts,
});

export const removeAccountRpc = defineRpc({
  name: "linear.accounts.remove",
  input: z.object({ id: z.string().min(1) }),
  output: accounts,
});

/** Everything a project can be linked to. */
export const scopesRpc = defineRpc({
  name: "linear.scopes",
  input: z.object({ accountId: z.string().min(1) }),
  output: z.object({ all: scope, teams: z.array(scope), projects: z.array(scope), views: z.array(scope) }),
});

export const issuesRpc = defineRpc({
  name: "linear.issues",
  input: z.object({
    scopes: link,
    /** Only issues assigned to you. */
    mine: z.boolean(),
    /** Include completed and canceled issues. */
    done: z.boolean(),
    /** Full-text search; empty lists the scope. */
    search: z.string(),
  }),
  output: z.object({
    issues: z.array(issue),
    /** There are more than the ones listed. */
    more: z.boolean(),
    /** Agents started from each issue, by issue ID. */
    agents: z.record(z.string(), z.array(agent)),
  }),
});

/** A team's workflow states, in Linear's order. */
export const statesRpc = defineRpc({
  name: "linear.states",
  input: z.object({ accountId: z.string().min(1), teamId: z.string().min(1) }),
  output: z.object({ states: z.array(state) }),
});

export const updateIssueRpc = defineRpc({
  name: "linear.issue.update",
  input: z.object({
    accountId: z.string().min(1),
    id: z.string().min(1),
    stateId: z.string().optional(),
    assignToMe: z.boolean().optional(),
  }),
  output: z.object({ issue }),
});

/**
 * Starts an agent on an issue, with the issue as its first message: in a new worktree on the
 * issue's branch, or in the workspace the request came from.
 */
export const startRpc = defineRpc({
  name: "linear.start",
  input: z.object({
    accountId: z.string().min(1),
    workspaceId: z.string().min(1),
    issueId: z.string().min(1),
    where: z.enum(["worktree", "here"]),
  }),
  output: z.object({ agentId: z.string(), workspaceId: z.string() }),
});

export const searchRpc = defineRpc({
  name: "linear.search",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

export type SearchItem = z.infer<typeof searchRpc.output>["items"][number];

export const issueAttachments = defineAttachmentSource({
  id: "issues",
  title: "Linear issue",
  icon: "SquareKanban",
  pickerTitle: "Attach a Linear issue",
  searchPlaceholder: "ENG-123 or words from the issue",
  search: searchRpc,
});

/** An issue as a message attachment, the way the "+" menu's Linear issue picker attaches it. */
export const issueAttachment = (issue: Omit<SearchItem, "subtitle" | "resourceType">) => ({
  type: "text" as const,
  mimeType: "text/plain" as const,
  title: `${issue.identifier} ${issue.title}`,
  text: issue.text,
  externalResource: {
    provider: "linear",
    providerLabel: issueAttachments.title,
    resourceType: "issue",
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  },
});

const agentTools = z.enum(["off", "read", "write"]);
export type AgentTools = z.infer<typeof agentTools>;

export const linearSettings = defineSettings({
  id: "linear",
  scope: "host",
  version: 2,
  // version 1 linked each project to one team, project or view
  migrate: (values) => {
    const { projects = {}, ...rest } = values as { projects?: Record<string, unknown> };
    const lists = Object.entries(projects).map(([id, linked]) => [
      id,
      Array.isArray(linked) ? linked : [linked],
    ]);
    return { ...rest, projects: Object.fromEntries(lists) };
  },
  schema: z.object({
    /** What each Paseo project shows, by Paseo project ID. */
    projects: z.record(z.string(), link).default({}),
    /**
     * Linear's MCP tools for agents started from now on: none, read-only, or read and write. They
     * sign in as the account the agent's project is linked to, or as every account if it isn't.
     */
    agentTools: agentTools.default("write"),
  }),
});
