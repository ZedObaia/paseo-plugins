import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  accountsRpc,
  addAccountRpc,
  chatsRpc,
  commentRpc,
  findRpc,
  detailRpc,
  issuesRpc,
  linearSettings,
  removeAccountRpc,
  scopesRpc,
  searchRpc,
  setChatRpc,
  startRpc,
  statesRpc,
  updateIssueRpc,
  type Account,
  type AgentTools,
  type ChatIssue,
  type Link,
} from "./shared/contracts";
import { accountKeys, removeAccount, saveAccount } from "./server/accounts";
import { chatIndex, setChat, startChat, storedChats, withIssues, type Lookup } from "./server/chats";
import { issueText, linear, oldestFirst, type IssueDetail, type Linear } from "./server/linear";
import {
  agentsFor,
  attachedIssue,
  FirstAgents,
  issueBranch,
  linearInstructions,
  MAX_TITLE,
  projectAt,
  startAgent,
} from "./server/start";

const MCP_URL = { read: "https://mcp.linear.app/mcp/readonly", write: "https://mcp.linear.app/mcp" };
/**
 * Paseo's providers without MCP support: it refuses to start one given MCP servers. Plugins can't
 * read a provider's capabilities, so they're named here.
 */
const NO_MCP = new Set(["pi", "mock", "mock-slow"]);
const MISSING = "Add a Linear account in Settings, Plugins, Linear.";
const GONE = "That Linear account was removed. Link the project again.";
const NO_ISSUE = "Linear has no such issue anymore.";
/** How long the images in an issue's details load without a key: the app never gets one. */
const IMAGE_LINKS_S = 3600;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function contribute(server: PluginServerContext) {
  let links: Record<string, Link> = {};
  let agentTools: AgentTools = "write";

  // one client per key, so each asks Linear who it is only once
  const clients = new Map<string, Linear>();
  const client = (apiKey: string) => {
    if (!clients.has(apiKey)) clients.set(apiKey, linear(apiKey));
    return clients.get(apiKey)!;
  };
  async function account(id: string): Promise<Linear> {
    const found = (await accountKeys()).find((key) => key.id === id);
    if (!found) throw new Error(GONE);
    return client(found.apiKey);
  }
  async function listAccounts(): Promise<{ accounts: Account[] }> {
    const keys = await accountKeys();
    const accounts = await Promise.all(
      keys.map(async ({ id, apiKey, saved }): Promise<Account> => {
        const fromEnvironment = !saved;
        try {
          const viewer = await client(apiKey).viewer();
          const { name, email } = viewer;
          return { id, workspace: viewer.organization.name, name, email, fromEnvironment, error: null };
        } catch (error) {
          const { workspace = "Linear", name = "", email = "" } = saved ?? {};
          return { id, workspace, name, email, fromEnvironment, error: message(error) };
        }
      }),
    );
    return { accounts };
  }

  /** The issues with these IDs, in whichever account can see them. */
  async function findIssues(ids: string[]): Promise<Lookup> {
    const found: Record<string, ChatIssue> = {};
    const keys = await accountKeys();
    const results = await Promise.allSettled(
      keys.map(async ({ id: accountId, apiKey }) => ({ accountId, issues: await client(apiKey).byIds(ids) })),
    );
    for (const result of results) {
      if (result.status === "rejected") continue;
      const { accountId, issues } = result.value;
      for (const { id, identifier, title, url } of issues)
        found[id] ??= { accountId, id, identifier, title, url };
    }
    return { found, complete: results.every((result) => result.status === "fulfilled") };
  }
  const chatIssues = chatIndex(findIssues);

  /** An issue's details, from whichever account can see it. */
  async function detailAnywhere(id: string): Promise<{ accountId: string; issue: IssueDetail } | null> {
    for (const { id: accountId, apiKey } of await accountKeys()) {
      const issue = await client(apiKey)
        .detail(id)
        .catch(() => null);
      if (issue) return { accountId, issue };
    }
    return null;
  }

  // Until settings are read, and while they don't read as valid, agents get no Linear keys: they
  // could be Off, read-only, or one account's.
  let settingsValid = false;
  const settings = server.registerSettings(linearSettings);
  const keep = (state: Awaited<ReturnType<typeof settings.read>>) => {
    settingsValid = state.status === "ready";
    if (state.status !== "ready") return console.error("Linear settings are invalid:", state.error);
    links = state.values.projects;
    agentTools = state.values.agentTools;
  };
  const settingsRead = settings
    .read()
    .then(keep, (error) => console.error("reading settings failed:", error));
  const unsubscribe = settings.subscribe(keep);

  server.handle(accountsRpc, listAccounts);
  server.handle(addAccountRpc, async ({ apiKey }) => {
    const key = apiKey.trim();
    // Linear checks the key: a wrong one fails here with Linear's reason
    const { id, name, email, organization } = await linear(key).viewer();
    await saveAccount({
      id,
      apiKey: key,
      workspace: organization.name,
      urlKey: organization.urlKey,
      name,
      email,
    });
    chatIssues.forget();
    return listAccounts();
  });
  server.handle(removeAccountRpc, async ({ id }) => {
    await removeAccount(id);
    chatIssues.forget();
    return listAccounts();
  });

  server.handle(scopesRpc, async ({ accountId }) => (await account(accountId)).scopes(accountId));
  server.handle(issuesRpc, async (query, { paseo }) => {
    // a link is one account's: anything else in it is ignored
    const { accountId } = query.scopes[0];
    const scopes = query.scopes.filter((scope) => scope.accountId === accountId);
    const { issues, more } = await (await account(accountId)).issues({ ...query, scopes });
    // the board still shows without them
    const agents = await storedChats()
      .then((stored) =>
        agentsFor(
          paseo,
          issues.map((issue) => issue.id),
          stored,
        ),
      )
      .catch((error) => (console.error("listing agents failed:", error), {}));
    return { issues, more, agents };
  });
  server.handle(statesRpc, async ({ accountId, teamId }) => ({
    states: await (await account(accountId)).states(teamId),
  }));
  server.handle(updateIssueRpc, async ({ accountId, id, ...change }) => ({
    issue: await (await account(accountId)).update(id, change),
  }));
  server.handle(detailRpc, async ({ accountId, id }) => {
    const issue = await (await account(accountId)).detail(id, IMAGE_LINKS_S);
    if (!issue) throw new Error(NO_ISSUE);
    return {
      description: issue.description,
      comments: oldestFirst(issue).map(({ body, createdAt, user }) => ({
        body,
        createdAt,
        user: user?.name ?? null,
      })),
    };
  });
  server.handle(commentRpc, async ({ accountId, id, body }) => {
    await (await account(accountId)).comment(id, body);
    return {};
  });
  server.handle(startRpc, async ({ accountId, workspaceId, issueId, where }, { paseo }) => {
    const issue = await (await account(accountId)).detail(issueId);
    if (!issue) throw new Error(NO_ISSUE);
    const started = await startAgent(paseo, {
      workspaceId,
      issue,
      where,
      linked: (projectId) => links[projectId] ?? null,
    });
    const { id, identifier, title, url } = issue;
    // its label says it too: the pill finds the issue from that if this fails
    await startChat(started.agentId, { accountId, id, identifier, title, url }).catch((error) =>
      console.error("remembering the chat's issue failed:", error),
    );
    return started;
  });
  server.handle(chatsRpc, async (_input, { paseo }) => ({ chats: await chatIssues.read(paseo) }));
  server.handle(setChatRpc, async ({ agentId, issue }) => ({
    chats: withIssues(await setChat(agentId, issue)),
  }));

  /**
   * Every account at once, as picker items; with more than one, each issue says which workspace
   * it's from. `complete` when every account answered.
   */
  async function searchAll(ask: (linear: Linear) => Promise<IssueDetail[]>) {
    const keys = await accountKeys();
    if (!keys.length) throw new Error(MISSING);
    const results = await Promise.allSettled(
      keys.map(async ({ id: accountId, apiKey }) => {
        const linear = client(apiKey);
        const [found, viewer] = await Promise.all([ask(linear), linear.viewer()]);
        return found.map((issue) => ({ issue, accountId, workspace: viewer.organization.name }));
      }),
    );
    const found = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const failed = results.find((result) => result.status === "rejected");
    if (!found.length && failed) throw failed.reason;
    const many = keys.length > 1;
    return {
      complete: !failed,
      items: found.map(({ issue, accountId, workspace }) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        subtitle:
          // the workspace first: the end is what gets cut off
          [many ? workspace : null, issue.state.name, issue.assignee?.name].filter(Boolean).join(" · ") ||
          undefined,
        url: issue.url,
        text: issueText(issue),
        resourceType: "issue",
        accountId,
      })),
    };
  }
  server.handle(searchRpc, async ({ query }) => ({
    items: (await searchAll((linear) => linear.search(query))).items,
  }));
  server.handle(findRpc, ({ identifier }) =>
    searchAll(async (linear) => {
      const issue = await linear.detail(identifier);
      return issue ? [issue] : [];
    }),
  );

  /**
   * Agents get Linear's own MCP server, signed in as the account their project is linked to:
   * `linear`. In a project that isn't linked they get every account, one server each, named
   * after its workspace when there are several (`linear-acme`). When in doubt, none: settings
   * not read yet, the linked account removed, or the agent's project not found.
   */
  const removeHook = server.before("agent.create", async ({ request }, { paseo }) => {
    const { config } = request;
    // Paseo's own background agents (commit messages, PR descriptions) don't need Linear
    if (config.internal || NO_MCP.has(config.provider)) return undefined;
    await settingsRead;
    if (!settingsValid || agentTools === "off") return undefined;
    if (Object.keys(config.mcpServers ?? {}).some((name) => name === "linear" || name.startsWith("linear-")))
      return undefined;
    const keys = await accountKeys().catch(() => []);
    if (!keys.length) return undefined;
    let projectId: string | null;
    try {
      projectId = await projectAt(paseo, config.cwd);
    } catch {
      return undefined;
    }
    // an agent outside every project could be in a linked one Paseo didn't list
    if (!projectId) return undefined;
    const link = links[projectId];
    const given = link ? keys.filter((key) => key.id === link[0].accountId) : keys;
    if (!given.length) return undefined;
    const named = await Promise.all(
      given.map(async ({ id, apiKey, saved }) => ({
        id,
        apiKey,
        urlKey:
          saved?.urlKey ??
          (
            await client(apiKey)
              .viewer()
              .catch(() => null)
          )?.organization.urlKey ??
          "env",
      })),
    );
    const servers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> = {};
    for (const { id, apiKey, urlKey } of named) {
      // two people's keys for the same workspace: the account tells them apart
      const shared = named.filter((other) => other.urlKey === urlKey).length > 1;
      const name =
        named.length === 1 ? "linear" : shared ? `linear-${urlKey}-${id.slice(0, 8)}` : `linear-${urlKey}`;
      servers[name] = {
        type: "http",
        url: MCP_URL[agentTools],
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    }
    const told = linearInstructions(Object.keys(servers), agentTools === "read");
    return {
      ...request,
      config: {
        ...config,
        mcpServers: { ...config.mcpServers, ...servers },
        systemPrompt: [config.systemPrompt, told].filter(Boolean).join("\n\n"),
      },
    };
  });

  /**
   * Paseo's New workspace with a Linear issue attached, in a new worktree: it goes on the issue's
   * branch unless you named or picked one, and its chat gets the issue once its agent exists. Paseo
   * starts that agent from the request as it came, so its labels can't carry the issue: the
   * worktree's folder does. A Local workspace's agent can't be told apart from others in its
   * folder, so it only gets the issue in its message.
   */
  const firstAgents = new FirstAgents();
  const removeWorkspaceHook = server.before("workspace.create", async ({ request }) => {
    const { source } = request;
    const attached =
      attachedIssue(request.agent?.attachments) ?? attachedIssue(request.firstAgentContext?.attachments);
    if (!attached || source.kind !== "worktree") return undefined;
    const found = await detailAnywhere(attached.id);
    if (!found) return undefined;
    const { accountId, issue } = found;
    const { id, identifier, title, url } = issue;
    firstAgents.expect(source.worktreeSlug, { accountId, id, identifier, title, url });
    if (
      (source.action ?? "branch-off") !== "branch-off" ||
      !source.cwd ||
      source.branchName ||
      source.checkoutSource ||
      source.githubPrNumber !== undefined
    )
      return undefined;
    return {
      ...request,
      source: { ...source, ...(await issueBranch(source.cwd, issue)) },
      title: request.title || `${identifier} ${title}`.slice(0, MAX_TITLE),
      // Paseo renames a new worktree's branch from what the first message says, once it's
      // created: with nothing to go on, it keeps the issue's (the agent still gets the message)
      ...(request.firstAgentContext ? { firstAgentContext: {} } : {}),
    };
  });
  const removeAgentCreated = server.on("agent.created", async ({ agent }) => {
    const chat = firstAgents.take(agent.cwd);
    if (chat)
      await startChat(agent.id, chat).catch((error) =>
        console.error("remembering the chat's issue failed:", error),
      );
  });

  return () => {
    removeHook();
    removeWorkspaceHook();
    removeAgentCreated();
    unsubscribe();
  };
}
