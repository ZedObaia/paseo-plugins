import { byWorkflow } from "../shared/board";
import { IDENTIFIER, type Issue, type Scope, type State } from "../shared/contracts";

const ENDPOINT = "https://api.linear.app/graphql";
/** One page; Linear allows 250, but labels inside each issue count toward its complexity limit. */
const PAGE = 200;

const STATE_FIELDS = "id name type color position";
const ISSUE_FIELDS = `
  id identifier title url priority priorityLabel updatedAt
  state { ${STATE_FIELDS} }
  team { id }
  assignee { id name }
  project { name }
  labels(first: 10) { nodes { name color } }
`;
/** What an agent or an attachment gets: the issue with its description and latest comments. */
const DETAIL_FIELDS = `
  id identifier title url description branchName priorityLabel
  state { name }
  team { key name }
  assignee { name }
  project { name }
  labels(first: 20) { nodes { name } }
  comments(first: 20, orderBy: createdAt) { nodes { body createdAt user { name } } }
`;

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  updatedAt: string;
  state: State;
  team: { id: string };
  assignee: { id: string; name: string } | null;
  project: { name: string } | null;
  labels: { nodes: { name: string; color: string }[] };
}

export interface IssueDetail {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  branchName: string;
  priorityLabel: string;
  state: { name: string };
  team: { key: string; name: string };
  assignee: { name: string } | null;
  project: { name: string } | null;
  labels: { nodes: { name: string }[] };
  comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] };
}

type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } };

export interface IssueQuery {
  scopes: Scope[];
  mine: boolean;
  done: boolean;
  search: string;
}

const OPEN = { state: { type: { nin: ["completed", "canceled"] } } };

/** The filter for the scope and the board's filters; a view brings its own, all issues none. */
export function issueFilter({ scopes, mine, done, search }: IssueQuery): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  const ids = (kind: Scope["kind"]) => scopes.filter((scope) => scope.kind === kind).map((scope) => scope.id);
  const teams = ids("team");
  const projects = ids("project");
  const covered = [
    ...(teams.length ? [{ team: { id: { in: teams } } }] : []),
    ...(projects.length ? [{ project: { id: { in: projects } } }] : []),
  ];
  // all issues cover the rest
  if (covered.length && !scopes.some((scope) => scope.kind === "all"))
    and.push(covered.length === 1 ? covered[0] : { or: covered });
  if (mine) and.push({ assignee: { isMe: { eq: true } } });
  if (!done) and.push(OPEN);
  const text = search.trim();
  if (text) {
    const or: Record<string, unknown>[] = [
      { title: { containsIgnoreCase: text } },
      { description: { containsIgnoreCase: text } },
    ];
    const id = IDENTIFIER.exec(text);
    // spelled out: inside an `or`, Linear doesn't join one object's fields with "and"
    if (id) or.push({ and: [{ team: { key: { eqIgnoreCase: id[1] } } }, { number: { eq: Number(id[2]) } }] });
    and.push({ or });
  }
  return { and };
}

export function toIssue(raw: RawIssue, viewerId: string): Issue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    priority: raw.priority,
    priorityLabel: raw.priorityLabel,
    state: raw.state,
    teamId: raw.team.id,
    assignee: raw.assignee?.name ?? null,
    mine: raw.assignee?.id === viewerId,
    project: raw.project?.name ?? null,
    labels: raw.labels.nodes,
    updatedAt: raw.updatedAt,
  };
}

/** The issue's latest comments that say something, oldest first; Linear lists the newest first. */
export const oldestFirst = (issue: IssueDetail) =>
  issue.comments.nodes
    .filter((comment) => comment.body.trim())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** The issue as text, the way an agent reads it. */
export function issueText(issue: IssueDetail): string {
  const labels = issue.labels.nodes.map((label) => label.name).join(", ");
  const lines = [
    `Linear issue ${issue.identifier}: ${issue.title}`,
    `URL: ${issue.url}`,
    `Team: ${issue.team.name} (${issue.team.key})`,
    `Status: ${issue.state.name}`,
    `Priority: ${issue.priorityLabel}`,
  ];
  if (issue.assignee) lines.push(`Assignee: ${issue.assignee.name}`);
  if (issue.project) lines.push(`Project: ${issue.project.name}`);
  if (labels) lines.push(`Labels: ${labels}`);
  lines.push("", issue.description?.trim() || "No description.");
  const comments = oldestFirst(issue);
  if (comments.length) {
    lines.push("", "Comments:");
    for (const comment of comments)
      lines.push(
        `- ${comment.user?.name ?? "Someone"} (${comment.createdAt.slice(0, 10)}): ${comment.body.trim()}`,
      );
  }
  return lines.join("\n");
}

export class LinearError extends Error {}

function httpError(status: number): string {
  if (status === 401 || status === 403) return "Linear didn't accept the API key";
  if (status === 429) return "Linear's rate limit was reached. Try again in a minute";
  return `Linear answered HTTP ${status}`;
}

/** Who a key signs in as, and the Linear workspace it belongs to. */
export interface Viewer {
  id: string;
  name: string;
  email: string;
  organization: { name: string; urlKey: string };
}

export function linear(apiKey: string, request: typeof fetch = fetch) {
  let viewer: Promise<Viewer> | undefined;

  async function graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await request(ENDPOINT, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
    });
    // GraphQL errors come with 400 too: read them first
    const body = (await response.json().catch(() => null)) as {
      data?: T;
      errors?: { message: string }[];
    } | null;
    if (body?.errors?.length) {
      const text = body.errors.map((error) => error.message).join("; ");
      throw new LinearError(/authenticat/i.test(text) ? httpError(401) : text);
    }
    if (!response.ok || !body?.data) throw new LinearError(httpError(response.status));
    return body.data;
  }

  const me = () =>
    (viewer ??= graphql<{ viewer: Omit<Viewer, "organization">; organization: Viewer["organization"] }>(
      "query { viewer { id name email } organization { name urlKey } }",
    ).then(
      (data) => ({ ...data.viewer, organization: data.organization }),
      (error) => {
        viewer = undefined;
        throw error;
      },
    ));

  /** With `signFor`, links to files Linear stores work without a key for that many seconds. */
  async function detail(id: string, signFor?: number): Promise<IssueDetail | null> {
    const data = await graphql<{ issue: IssueDetail | null }>(
      `query($id: String!) { issue(id: $id) { ${DETAIL_FIELDS} } }`,
      { id },
      signFor ? { "public-file-urls-expire-in": String(signFor) } : {},
    ).catch((error) => {
      // an identifier nobody has, like ABC-1 in a search
      if (error instanceof LinearError && /not found|entity/i.test(error.message)) return { issue: null };
      throw error;
    });
    return data.issue;
  }

  return {
    viewer: me,
    detail,

    /** What a project can be linked to in this account: all of it, or one team, project or view. */
    async scopes(
      accountId: string,
    ): Promise<{ all: Scope; teams: Scope[]; projects: Scope[]; views: Scope[] }> {
      const data = await graphql<{
        teams: { nodes: { id: string; key: string; name: string }[] };
        projects: { nodes: { id: string; name: string }[] };
        customViews: { nodes: { id: string; name: string }[] };
      }>(`
        query {
          teams(first: 100) {
            nodes {
              id
              key
              name
            }
          }
          projects(
            first: 100
            orderBy: updatedAt
            filter: { status: { type: { nin: ["completed", "canceled"] } } }
          ) {
            nodes {
              id
              name
            }
          }
          customViews(first: 100) {
            nodes {
              id
              name
            }
          }
        }
      `);
      const { organization } = await me();
      const byName = (a: Scope, b: Scope) => a.name.localeCompare(b.name);
      return {
        all: { accountId, kind: "all", id: accountId, name: `All issues in ${organization.name}` },
        teams: data.teams.nodes
          .map(
            (team): Scope => ({ accountId, kind: "team", id: team.id, name: `${team.name} (${team.key})` }),
          )
          .sort(byName),
        projects: data.projects.nodes.map((project): Scope => ({ accountId, kind: "project", ...project })),
        views: data.customViews.nodes
          .map((view): Scope => ({ accountId, kind: "view", ...view }))
          .sort(byName),
      };
    },

    /** Teams and projects in one query, each saved view on its own, merged by most recently updated. */
    async issues(query: IssueQuery): Promise<{ issues: Issue[]; more: boolean }> {
      const all = query.scopes.some((scope) => scope.kind === "all");
      const views = all ? [] : query.scopes.filter((scope) => scope.kind === "view");
      const direct = all || query.scopes.some((scope) => scope.kind === "team" || scope.kind === "project");
      // a view brings its own filter: only the board's go with it
      const viewFilter = issueFilter({ ...query, scopes: [] });
      const [{ id: viewerId }, ...pages] = await Promise.all([
        me(),
        ...(direct
          ? [
              graphql<{ issues: Connection<RawIssue> }>(
                `query($filter: IssueFilter, $first: Int) {
                  issues(first: $first, filter: $filter, orderBy: updatedAt) {
                    nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage }
                  }
                }`,
                { filter: issueFilter(query), first: PAGE },
              ).then((data) => data.issues),
            ]
          : []),
        ...views.map((view) =>
          graphql<{ customView: { issues: Connection<RawIssue> } }>(
            `query($id: String!, $filter: IssueFilter, $first: Int) {
              customView(id: $id) { issues(first: $first, filter: $filter, orderBy: updatedAt) {
                nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage }
              } }
            }`,
            { id: view.id, filter: viewFilter, first: PAGE },
          ).then((data) => data.customView.issues),
        ),
      ]);
      const unique = new Map<string, RawIssue>();
      for (const raw of pages.flatMap((page) => page.nodes)) unique.set(raw.id, raw);
      const merged = [...unique.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      // ponytail: one page of the most recently updated per query; page through if boards outgrow it
      return {
        issues: merged.slice(0, PAGE).map((raw) => toIssue(raw, viewerId)),
        more: merged.length > PAGE || pages.some((page) => page.pageInfo.hasNextPage),
      };
    },

    async states(teamId: string): Promise<State[]> {
      const data = await graphql<{ team: { states: { nodes: State[] } } }>(
        `query($id: String!) { team(id: $id) { states(first: 100) { nodes { ${STATE_FIELDS} } } } }`,
        { id: teamId },
      );
      return data.team.states.nodes.sort(byWorkflow);
    },

    async update(id: string, change: { stateId?: string; assignToMe?: boolean }): Promise<Issue> {
      const { id: viewerId } = await me();
      const input = {
        ...(change.stateId ? { stateId: change.stateId } : {}),
        ...(change.assignToMe ? { assigneeId: viewerId } : {}),
      };
      const data = await graphql<{ issueUpdate: { success: boolean; issue: RawIssue | null } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
        }`,
        { id, input },
      );
      if (!data.issueUpdate.success || !data.issueUpdate.issue)
        throw new LinearError("Linear didn't save it");
      return toIssue(data.issueUpdate.issue, viewerId);
    },

    async comment(issueId: string, body: string): Promise<void> {
      const data = await graphql<{ commentCreate: { success: boolean } }>(
        `
          mutation ($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              success
            }
          }
        `,
        { input: { issueId, body } },
      );
      if (!data.commentCreate.success) throw new LinearError("Linear didn't save it");
    },

    /** The issues with these IDs that this account can see. */
    async byIds(ids: string[]): Promise<Pick<IssueDetail, "id" | "identifier" | "title" | "url">[]> {
      const found = [];
      for (let start = 0; start < ids.length; start += PAGE) {
        const data = await graphql<{
          issues: { nodes: Pick<IssueDetail, "id" | "identifier" | "title" | "url">[] };
        }>(
          `
            query ($ids: [ID!], $first: Int) {
              issues(first: $first, filter: { id: { in: $ids } }) {
                nodes {
                  id
                  identifier
                  title
                  url
                }
              }
            }
          `,
          { ids: ids.slice(start, start + PAGE), first: PAGE },
        );
        found.push(...data.issues.nodes);
      }
      return found;
    },

    /** An identifier opens that issue; other text is Linear's full-text search. */
    async search(query: string): Promise<IssueDetail[]> {
      const text = query.trim();
      if (IDENTIFIER.test(text)) {
        const issue = await detail(text.toUpperCase());
        return issue ? [issue] : [];
      }
      if (!text) {
        // your open issues, then everyone's, the latest updated first
        const data = await graphql<{ mine: { nodes: IssueDetail[] }; open: { nodes: IssueDetail[] } }>(
          `query($open: IssueFilter, $mine: IssueFilter) {
            mine: issues(first: 20, orderBy: updatedAt, filter: $mine) { nodes { ${DETAIL_FIELDS} } }
            open: issues(first: 20, orderBy: updatedAt, filter: $open) { nodes { ${DETAIL_FIELDS} } }
          }`,
          { open: OPEN, mine: { and: [OPEN, { assignee: { isMe: { eq: true } } }] } },
        );
        const mine = new Set(data.mine.nodes.map((issue) => issue.id));
        return [...data.mine.nodes, ...data.open.nodes.filter((issue) => !mine.has(issue.id))].slice(0, 20);
      }
      const data = await graphql<{ searchIssues: { nodes: IssueDetail[] } }>(
        `query($term: String!) { searchIssues(term: $term, first: 20) { nodes { ${DETAIL_FIELDS} } } }`,
        { term: text },
      );
      return data.searchIssues.nodes;
    },
  };
}

export type Linear = ReturnType<typeof linear>;
