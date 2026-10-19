import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  accountsRpc,
  addAccountRpc,
  commentRpc,
  detailRpc,
  issuesRpc,
  linearSettings,
  removeAccountRpc,
  scopesRpc,
  searchRpc,
  startRpc,
  statesRpc,
  updateIssueRpc,
  type Account,
  type AgentTools,
  type Link,
} from "./shared/contracts";
import { accountKeys, removeAccount, saveAccount } from "./server/accounts";
import { issueText, linear, oldestFirst, type Linear } from "./server/linear";
import { agentsFor, projectAt, startAgent } from "./server/start";

const MCP_URL = { read: "https://mcp.linear.app/mcp/readonly", write: "https://mcp.linear.app/mcp" };
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
    return listAccounts();
  });
  server.handle(removeAccountRpc, async ({ id }) => {
    await removeAccount(id);
    return listAccounts();
  });

  server.handle(scopesRpc, async ({ accountId }) => (await account(accountId)).scopes(accountId));
  server.handle(issuesRpc, async (query, { paseo }) => {
    // a link is one account's: anything else in it is ignored
    const { accountId } = query.scopes[0];
    const scopes = query.scopes.filter((scope) => scope.accountId === accountId);
    const { issues, more } = await (await account(accountId)).issues({ ...query, scopes });
    // the board still shows without them
    const agents = await agentsFor(
      paseo,
      issues.map((issue) => issue.id),
    ).catch((error) => (console.error("listing agents failed:", error), {}));
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
    return startAgent(paseo, {
      workspaceId,
      issue,
      where,
      linked: (projectId) => links[projectId] ?? null,
      tools: agentTools !== "off",
    });
  });

  // every account at once; with more than one, each issue says which workspace it's from
  server.handle(searchRpc, async ({ query }) => {
    const keys = await accountKeys();
    if (!keys.length) throw new Error(MISSING);
    const results = await Promise.allSettled(
      keys.map(async ({ apiKey }) => {
        const linear = client(apiKey);
        const [found, viewer] = await Promise.all([linear.search(query), linear.viewer()]);
        return found.map((issue) => ({ issue, workspace: viewer.organization.name }));
      }),
    );
    const found = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const failed = results.find((result) => result.status === "rejected");
    if (!found.length && failed) throw failed.reason;
    const many = keys.length > 1;
    return {
      items: found.map(({ issue, workspace }) => ({
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
      })),
    };
  });

  /**
   * Agents get Linear's own MCP server, signed in as the account their project is linked to:
   * `linear`. In a project that isn't linked they get every account, one server each, named
   * after its workspace when there are several (`linear-acme`). When in doubt, none: settings
   * not read yet, the linked account removed, or the agent's project not found.
   */
  const removeHook = server.before("agent.create", async ({ request }, { paseo }) => {
    const { config } = request;
    // Paseo's own background agents (commit messages, PR descriptions) don't need Linear
    if (config.internal) return undefined;
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
    return { ...request, config: { ...config, mcpServers: { ...config.mcpServers, ...servers } } };
  });

  return () => {
    removeHook();
    unsubscribe();
  };
}
