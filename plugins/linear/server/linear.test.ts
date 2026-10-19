import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { columns, labelsOf, toggle } from "../shared/board";
import { linearSettings, type Issue, type Scope, type State } from "../shared/contracts";
import contribute from "../index.server";
import { accountKeys, removeAccount, saveAccount, savedAccounts, type SavedAccount } from "./accounts";
import { issueFilter, issueText, linear, toIssue, type IssueDetail } from "./linear";
import { branchFor, pickConfig } from "./start";
import { parseMarkdown } from "../client/markdown";

const state = (name: string, type: string, position = 0): State => ({
  id: name,
  name,
  type,
  color: "#888888",
  position,
});
const issue = (id: string, s: State, priority = 0, updatedAt = "2026-01-01"): Issue => ({
  id,
  identifier: id,
  title: id,
  url: `https://linear.app/x/issue/${id}`,
  priority,
  priorityLabel: "",
  state: s,
  teamId: "t",
  assignee: null,
  mine: false,
  project: null,
  labels: [],
  updatedAt,
});
const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  id: "i1",
  identifier: "ENG-7",
  title: "Fix login",
  url: "https://linear.app/x/issue/ENG-7",
  description: "It breaks.",
  branchName: "zeyad/eng-7-fix-login",
  priorityLabel: "High",
  state: { name: "Todo" },
  team: { key: "ENG", name: "Engineering" },
  assignee: null,
  project: null,
  labels: { nodes: [] },
  comments: { nodes: [] },
  ...over,
});

/** A fetch that answers each GraphQL request with the next body, and records the requests. */
function fakeFetch(...answers: { status?: number; body: unknown }[]) {
  const requests: {
    query: string;
    variables: Record<string, unknown>;
    auth: string;
    headers: Record<string, string>;
  }[] = [];
  const request = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    requests.push({ query, variables, auth: headers.Authorization, headers });
    const answer = answers.shift() ?? { body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { request, requests };
}

test("the filter scopes, narrows to you, hides done issues and searches text or an identifier", () => {
  const filter = issueFilter({
    scopes: [{ accountId: "a", kind: "team", id: "T1", name: "" }],
    mine: true,
    done: false,
    search: " eng-12 ",
  });
  assert.deepEqual(filter, {
    and: [
      { team: { id: { in: ["T1"] } } },
      { assignee: { isMe: { eq: true } } },
      { state: { type: { nin: ["completed", "canceled"] } } },
      {
        or: [
          { title: { containsIgnoreCase: "eng-12" } },
          { description: { containsIgnoreCase: "eng-12" } },
          { and: [{ team: { key: { eqIgnoreCase: "eng" } } }, { number: { eq: 12 } }] },
        ],
      },
    ],
  });
  // a view brings its own filter; nothing else asked for adds nothing
  assert.deepEqual(
    issueFilter({
      scopes: [{ accountId: "a", kind: "view", id: "V", name: "" }],
      mine: false,
      done: true,
      search: "",
    }),
    {
      and: [],
    },
  );
});

test("an issue knows whether it's yours", () => {
  const raw = {
    ...issue("ENG-1", state("Todo", "unstarted")),
    team: { id: "T" },
    assignee: { id: "me", name: "Zeyad" },
    project: { name: "Web" },
    labels: { nodes: [{ name: "bug", color: "#ff0000" }] },
  };
  const mapped = toIssue(raw, "me");
  assert.equal(mapped.mine, true);
  assert.equal(mapped.assignee, "Zeyad");
  assert.equal(mapped.teamId, "T");
  assert.equal(mapped.project, "Web");
  assert.equal(toIssue(raw, "someone-else").mine, false);
});

test("an agent reads the issue with its comments oldest first", () => {
  const text = issueText(
    detail({
      comments: {
        nodes: [
          { body: "second", createdAt: "2026-02-02T00:00:00Z", user: { name: "B" } },
          { body: "  ", createdAt: "2026-02-03T00:00:00Z", user: null },
          { body: "first", createdAt: "2026-02-01T00:00:00Z", user: null },
        ],
      },
    }),
  );
  assert.match(text, /^Linear issue ENG-7: Fix login\n/);
  assert.match(text, /Team: Engineering \(ENG\)/);
  assert.match(text, /It breaks\./);
  assert.ok(text.endsWith("Comments:\n- Someone (2026-02-01): first\n- B (2026-02-02): second"));
});

test("Linear's errors reach the user, a rejected key too", async () => {
  const { request, requests } = fakeFetch(
    { status: 400, body: { errors: [{ message: "Argument Validation Error" }] } },
    { status: 401, body: {} },
  );
  const client = linear("lin_api_x", request);
  await assert.rejects(client.states("T"), /Argument Validation Error/);
  await assert.rejects(client.viewer(), /didn't accept the API key/);
  assert.equal(requests[0].auth, "lin_api_x");
});

test("searching an identifier opens that issue; an unknown one finds nothing", async () => {
  const { request, requests } = fakeFetch(
    { body: { data: { issue: detail() } } },
    { status: 400, body: { errors: [{ message: "Entity not found: Issue" }] } },
  );
  const client = linear("k", request);
  assert.deepEqual(
    (await client.search("eng-7")).map((i) => i.identifier),
    ["ENG-7"],
  );
  assert.equal(requests[0].variables.id, "ENG-7");
  assert.deepEqual(await client.search("ABC-1"), []);
});

test("an issue's details ask for image links that work without a key; an agent's don't", async () => {
  const { request, requests } = fakeFetch(
    { body: { data: { issue: detail() } } },
    { body: { data: { issue: detail() } } },
  );
  const client = linear("k", request);
  await client.detail("i1", 3600);
  await client.detail("i1");
  assert.equal(requests[0].headers["public-file-urls-expire-in"], "3600");
  assert.equal(requests[1].headers["public-file-urls-expire-in"], undefined);
});

test("markdown from Linear becomes blocks and styled text, with only safe links", () => {
  const blocks = parseMarkdown(
    [
      "## Steps",
      "Open **the _login_ page** at https://x.dev/login, then `npm test`.",
      "",
      "- one",
      "  - [x] nested done",
      "    more of it",
      "1. [click](javascript:alert(1)) and [docs](https://x.dev)",
      "",
      "> quoted",
      "```",
      "a  b",
      "```",
      "![shot.png](https://uploads.linear.app/a.png)",
      "---",
      "snake_case_name \\*not em\\*",
    ].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "paragraph", "item", "item", "item", "quote", "code", "image", "rule", "paragraph"],
  );
  assert.deepEqual(blocks[1], {
    kind: "paragraph",
    spans: [
      { text: "Open " },
      { text: "the ", bold: true },
      { text: "login", bold: true, italic: true },
      { text: " page", bold: true },
      { text: " at " },
      { text: "https://x.dev/login", url: "https://x.dev/login" },
      { text: ", then " },
      { text: "npm test", code: true },
      { text: "." },
    ],
  });
  assert.deepEqual(blocks[3], {
    kind: "item",
    depth: 1,
    marker: "•",
    checked: true,
    spans: [{ text: "nested done\nmore of it" }],
  });
  // the script link stays text
  assert.deepEqual(blocks[4].kind === "item" && blocks[4].spans, [
    { text: "click" },
    { text: " and " },
    { text: "docs", url: "https://x.dev" },
  ]);
  assert.deepEqual(blocks[6], { kind: "code", text: "a  b" });
  assert.deepEqual(blocks[7], { kind: "image", alt: "shot.png", url: "https://uploads.linear.app/a.png" });
  assert.deepEqual(
    blocks[9].kind === "paragraph" && blocks[9].spans.map((span) => span.text).join(""),
    "snake_case_name *not em*",
  );
});

test("a comment goes to its issue, and one Linear didn't save says so", async () => {
  const { request, requests } = fakeFetch(
    { body: { data: { commentCreate: { success: true } } } },
    { body: { data: { commentCreate: { success: false } } } },
  );
  const client = linear("k", request);
  await client.comment("i1", "Looks good");
  assert.deepEqual(requests[0].variables, { input: { issueId: "i1", body: "Looks good" } });
  await assert.rejects(client.comment("i1", "again"), /didn't save it/);
});

test("a view's issues come from the view, with the viewer asked once", async () => {
  const viewer = { body: { data: { viewer: { id: "me", name: "Z", email: "z@x" } } } };
  const raw = {
    ...issue("ENG-1", state("Todo", "unstarted")),
    team: { id: "T" },
    assignee: null,
    project: null,
    labels: { nodes: [] },
  };
  const page = { nodes: [raw], pageInfo: { hasNextPage: true } };
  const { request, requests } = fakeFetch(
    viewer,
    { body: { data: { customView: { issues: page } } } },
    {
      body: { data: { issues: page } },
    },
  );
  const client = linear("k", request);
  const result = await client.issues({
    scopes: [{ accountId: "a", kind: "view", id: "V", name: "" }],
    mine: false,
    done: false,
    search: "",
  });
  assert.equal(result.more, true);
  assert.equal(result.issues[0].identifier, "ENG-1");
  assert.match(requests[1].query, /customView\(id: \$id\)/);
  await client.issues({
    scopes: [{ accountId: "a", kind: "team", id: "T", name: "" }],
    mine: false,
    done: false,
    search: "",
  });
  assert.equal(requests.filter((r) => r.query.includes("viewer")).length, 1);
});

test("Linear's branch names become branches Paseo accepts", () => {
  assert.equal(
    branchFor({ branchName: "zeyad/eng-7-fix-login", identifier: "ENG-7" }),
    "zeyad/eng-7-fix-login",
  );
  assert.equal(
    branchFor({ branchName: "Z.Obaia/ENG-7__Fix  Login!", identifier: "ENG-7" }),
    "z-obaia/eng-7-fix-login",
  );
  assert.equal(branchFor({ branchName: "-a--b-/-c-", identifier: "ENG-7" }), "a-b/c");
  assert.equal(branchFor({ branchName: "", identifier: "ENG-7" }), "eng-7");
  assert.ok(branchFor({ branchName: "x".repeat(150), identifier: "ENG-7" }).length <= 100);
});

test("agents start with the model of your latest chat in the project, else anywhere", () => {
  const agent = (provider: string, model: string | null, workspaceId: string, labels = {}) => ({
    provider,
    model,
    currentModeId: "plan",
    thinkingOptionId: null,
    workspaceId,
    labels,
  });
  const recent = [
    agent("codex", "gpt-5", "elsewhere"),
    agent("claude", "opus", "w1", { "paseo.parent-agent-id": "a" }),
    agent("claude", null, "w1"),
    agent("claude", "sonnet", "w2"),
  ];
  assert.deepEqual(pickConfig(recent, new Set(["w1", "w2"])), { provider: "claude/sonnet", modeId: "plan" });
  assert.deepEqual(pickConfig(recent, new Set(["none"])), { provider: "codex/gpt-5", modeId: "plan" });
  assert.throws(() => pickConfig([], new Set()), /Start a chat in Paseo first/);
});

test("the board has a column per status name in workflow order, urgent issues first", () => {
  const todoA = state("Todo", "unstarted", 1);
  const todoB = { ...state("Todo", "unstarted", 3), id: "other-team-todo" };
  const doing = state("In Progress", "started", 2);
  const backlog = state("Backlog", "backlog", 0);
  const board = columns([
    issue("a", doing),
    issue("b", todoA, 0, "2026-03-01"),
    issue("c", todoB, 3),
    issue("d", todoA, 1),
    issue("e", backlog),
    issue("f", todoA, 0, "2026-04-01"),
  ]);
  assert.deepEqual(
    board.map((column) => [column.state.name, column.issues.map((i) => i.id)]),
    [
      ["Backlog", ["e"]],
      ["Todo", ["d", "c", "f", "b"]],
      ["In Progress", ["a"]],
    ],
  );
});

test("label chips list the most used labels", () => {
  const bug = { name: "bug", color: "#f00" };
  const ui = { name: "ui", color: "#0f0" };
  const issues = [issue("a", state("Todo", "unstarted")), issue("b", state("Todo", "unstarted"))];
  issues[0].labels = [ui, bug];
  issues[1].labels = [bug];
  assert.deepEqual(labelsOf(issues), [bug, ui]);
});

test("all of an account's issues need no scope filter", () => {
  assert.deepEqual(
    issueFilter({
      scopes: [{ accountId: "a", kind: "all", id: "a", name: "" }],
      mine: true,
      done: true,
      search: "",
    }),
    { and: [{ assignee: { isMe: { eq: true } } }] },
  );
});

const account = (id: string, urlKey: string): SavedAccount => ({
  id,
  apiKey: `lin_api_${urlKey}`,
  workspace: urlKey,
  urlKey,
  name: "Sam",
  email: "sam@example.com",
});

test("accounts: adding one again replaces its key, LINEAR_API_KEY comes last unless it's saved", async () => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "linear-accounts-"));
  process.env.LINEAR_API_KEY = "lin_api_env";
  await saveAccount(account("u1", "acme"));
  await saveAccount(account("u2", "side"));
  await saveAccount({ ...account("u1", "acme"), apiKey: "lin_api_new" });
  assert.deepEqual(
    (await accountKeys()).map((key) => [key.id, key.apiKey]),
    [
      ["u2", "lin_api_side"],
      ["u1", "lin_api_new"],
      ["environment", "lin_api_env"],
    ],
  );
  process.env.LINEAR_API_KEY = "lin_api_side";
  await removeAccount("u1");
  assert.deepEqual(
    (await accountKeys()).map((key) => key.id),
    ["u2"],
  );
  delete process.env.LINEAR_API_KEY;
});

test("agents get the linked account's Linear tools, every account's when not linked, none when off", async () => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "linear-hook-"));
  await saveAccount(account("u-acme", "acme"));
  await saveAccount(account("u-side", "side"));
  let hook: ((input: { request: unknown }, context: unknown) => Promise<unknown>) | undefined;
  let listener: ((state: unknown) => void) | undefined;
  const link = { accountId: "u-side", kind: "team", id: "T", name: "Side" };
  const ready = (agentTools: string) => ({
    status: "ready",
    revision: "1",
    values: { projects: { prj_linked: [link] }, agentTools },
  });
  contribute({
    registerSettings: () => ({
      read: async () => ready("write"),
      subscribe: (next: (state: unknown) => void) => ((listener = next), () => {}),
    }),
    handle: () => {},
    before: (_name: string, handler: typeof hook) => ((hook = handler), () => {}),
  } as never);
  await new Promise((resolve) => setImmediate(resolve));
  const paseo = {
    workspaces: {
      list: async () => ({
        entries: [
          { projectId: "prj_linked", projectRootPath: "/repo" },
          { projectId: "prj_other", projectRootPath: "/repo/nested", workspaceDirectory: "/wt/feature" },
        ],
      }),
    },
  };
  const create = (cwd: string, extra = {}) =>
    hook!(
      {
        request: { config: { provider: "claude", cwd, mcpServers: { other: { type: "stdio" } }, ...extra } },
      },
      { paseo },
    ) as Promise<
      | { config: { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> } }
      | undefined
    >;
  const servers = async (cwd: string) =>
    Object.fromEntries(
      Object.entries((await create(cwd))!.config.mcpServers).map(([name, server]) => [
        name,
        server.headers?.Authorization ?? "",
      ]),
    );

  assert.deepEqual(await servers("/repo/src"), { other: "", linear: "Bearer lin_api_side" });
  assert.deepEqual(await servers("/wt/feature"), {
    other: "",
    "linear-acme": "Bearer lin_api_acme",
    "linear-side": "Bearer lin_api_side",
  });
  assert.equal((await create("/repo"))!.config.mcpServers.linear.url, "https://mcp.linear.app/mcp");
  assert.equal(await create("/repo", { internal: true }), undefined);
  assert.equal(await create("/repo", { mcpServers: { linear: {} } }), undefined);
  listener!(ready("read"));
  assert.equal((await create("/repo"))!.config.mcpServers.linear.url, "https://mcp.linear.app/mcp/readonly");
  listener!(ready("off"));
  assert.equal(await create("/repo"), undefined);
});

const team = (id: string): Scope => ({ accountId: "a", kind: "team", id, name: id });
const project = (id: string): Scope => ({ accountId: "a", kind: "project", id, name: id });
const view = (id: string): Scope => ({ accountId: "a", kind: "view", id, name: id });
const everything: Scope = { accountId: "a", kind: "all", id: "a", name: "All issues in Acme" };

test("several teams and projects are one filter; all issues need none", () => {
  const only = { mine: false, done: true, search: "" };
  assert.deepEqual(issueFilter({ ...only, scopes: [team("T1"), team("T2"), project("P1")] }), {
    and: [{ or: [{ team: { id: { in: ["T1", "T2"] } } }, { project: { id: { in: ["P1"] } } }] }],
  });
  assert.deepEqual(issueFilter({ ...only, scopes: [everything, team("T1")] }), { and: [] });
});

test("a board of a team and a view merges both, each issue once, the latest updated first", async () => {
  const viewer = {
    body: {
      data: { viewer: { id: "me", name: "Z", email: "z@x" }, organization: { name: "Acme", urlKey: "acme" } },
    },
  };
  const raw = (id: string, updatedAt: string) => ({
    ...issue(id, state("Todo", "unstarted"), 0, updatedAt),
    team: { id: "T" },
    assignee: null,
    project: null,
    labels: { nodes: [] },
  });
  const page = (...nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  // answered in the order they're asked: the viewer, the teams' and projects' query, then the view
  const { request, requests } = fakeFetch(
    viewer,
    { body: { data: { issues: page(raw("a", "2026-01-02"), raw("b", "2026-01-04")) } } },
    { body: { data: { customView: { issues: page(raw("b", "2026-01-04"), raw("c", "2026-01-03")) } } } },
  );
  const result = await linear("k", request).issues({
    scopes: [team("T"), view("V")],
    mine: true,
    done: false,
    search: "",
  });
  assert.deepEqual(
    result.issues.map((i) => i.id),
    ["b", "c", "a"],
  );
  // the view keeps its own scope: only the board's filters go with it
  assert.deepEqual(requests[2].variables.filter, {
    and: [{ assignee: { isMe: { eq: true } } }, { state: { type: { nin: ["completed", "canceled"] } } }],
  });
  assert.equal(requests[2].variables.id, "V");
});

test("ticking: all issues go alone, and picking something else unticks them", () => {
  assert.deepEqual(toggle([team("T1")], team("T2")), [team("T1"), team("T2")]);
  assert.deepEqual(toggle([team("T1"), team("T2")], team("T1")), [team("T2")]);
  assert.deepEqual(toggle([team("T1"), view("V")], everything), [everything]);
  assert.deepEqual(toggle([everything], project("P")), [project("P")]);
});

test("version 1 links of one scope each become lists", async () => {
  const migrated = await linearSettings.migrate!(
    { projects: { p1: team("T1"), p2: [view("V")] }, agentTools: "read" },
    1,
  );
  assert.deepEqual(migrated, { projects: { p1: [team("T1")], p2: [view("V")] }, agentTools: "read" });
});

/** The agent.create hook of a fresh plugin, with settings read by `read` and projects found by `list`. */
function agentHook(read: () => Promise<unknown>, list: (options?: never) => Promise<unknown>) {
  let hook: ((input: { request: unknown }, context: unknown) => Promise<unknown>) | undefined;
  contribute({
    registerSettings: () => ({ read, subscribe: () => () => {} }),
    handle: () => {},
    before: (_name: string, handler: typeof hook) => ((hook = handler), () => {}),
  } as never);
  const paseo = { workspaces: { list } };
  return async (cwd: string) => {
    const out = (await hook!({ request: { config: { provider: "claude", cwd } } }, { paseo })) as
      | { config: { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> } }
      | undefined;
    return (
      out &&
      Object.fromEntries(Object.entries(out.config.mcpServers).map(([n, s]) => [n, s.headers.Authorization]))
    );
  };
}
const settingsOf = (projects: Record<string, unknown>, agentTools = "write") => ({
  status: "ready",
  revision: "1",
  values: { projects, agentTools },
});
const inRepo = async () => ({ entries: [{ projectId: "prj", projectRootPath: "/repo" }] });

test("no Linear keys before settings are read, nor while they're invalid", async () => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "linear-early-"));
  await saveAccount(account("u-acme", "acme"));
  let settle!: (state: unknown) => void;
  const create = agentHook(() => new Promise((resolve) => (settle = resolve)), inRepo);
  const early = create("/repo");
  settle(settingsOf({}, "off"));
  assert.equal(await early, undefined);
  const invalid = agentHook(async () => ({ status: "invalid", revision: "1", error: "bad" }), inRepo);
  assert.equal(await invalid("/repo"), undefined);
});

test("an agent whose project is linked to a removed account, can't be looked up or isn't found gets no keys", async () => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "linear-closed-"));
  await saveAccount(account("u-acme", "acme"));
  await saveAccount(account("u-side", "side"));
  const link = [{ accountId: "u-gone", kind: "team", id: "T", name: "T" }];
  const create = agentHook(async () => settingsOf({ prj: link }), inRepo);
  assert.equal(await create("/repo"), undefined);
  const lost = agentHook(
    async () => settingsOf({}),
    async () => {
      throw new Error("daemon busy");
    },
  );
  assert.equal(await lost("/repo"), undefined);
  const outside = agentHook(async () => settingsOf({}), inRepo);
  assert.equal(await outside("/elsewhere"), undefined);
});

test("two people's keys for one workspace get servers of their own", async () => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "linear-names-"));
  await saveAccount(account("u-aaaaaaaa-1", "acme"));
  await saveAccount({ ...account("u-bbbbbbbb-2", "acme"), apiKey: "lin_api_other" });
  const create = agentHook(async () => settingsOf({}), inRepo);
  assert.deepEqual(await create("/repo"), {
    "linear-acme-u-aaaaaa": "Bearer lin_api_acme",
    "linear-acme-u-bbbbbb": "Bearer lin_api_other",
  });
});

test("accounts changed at once keep every change", async () => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "linear-race-"));
  await Promise.all([
    saveAccount(account("u1", "one")),
    saveAccount(account("u2", "two")),
    saveAccount(account("u3", "three")),
  ]);
  await Promise.all([removeAccount("u2"), saveAccount(account("u4", "four"))]);
  assert.deepEqual((await savedAccounts()).map((a) => a.id).sort(), ["u1", "u3", "u4"]);
});

test("an agent's project is found on any page of workspaces", async () => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "linear-pages-"));
  await saveAccount(account("u-acme", "acme"));
  await saveAccount(account("u-side", "side"));
  const link = [{ accountId: "u-side", kind: "team", id: "T", name: "T" }];
  const pages: Record<string, unknown> = {
    first: { entries: [{ projectId: "other", projectRootPath: "/other" }], pageInfo: { nextCursor: "2" } },
    "2": { entries: [{ projectId: "prj", projectRootPath: "/repo" }], pageInfo: { nextCursor: null } },
  };
  const create = agentHook(
    async () => settingsOf({ prj: link }),
    async (options?: { page?: { cursor?: string } }) => pages[options?.page?.cursor ?? "first"],
  );
  assert.deepEqual(await create("/repo/src"), { linear: "Bearer lin_api_side" });
});
