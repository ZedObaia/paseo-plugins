import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import contribute from "../index.server";
import { chatsRpc, ISSUE_LABEL, searchRpc, setChatRpc, startRpc, type ChatIssue } from "../shared/contracts";
import { saveAccount } from "./accounts";
import { chatStore } from "../client/chats";
import { chatIndex, setChat, storedChats } from "./chats";
import { linear } from "./linear";
import { agentsFor } from "./start";

const home = (name: string) => (process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), `linear-${name}-`)));
const chat = (id: string, accountId = "u1"): ChatIssue => ({
  accountId,
  id,
  identifier: id.toUpperCase(),
  title: `Issue ${id}`,
  url: `https://linear.app/x/issue/${id}`,
});
const agent = (id: string, labels: Record<string, string> = {}) => ({
  id,
  title: id,
  status: "idle",
  labels,
});
const paseoWith = (...agents: ReturnType<typeof agent>[]) =>
  ({ agents: { list: async () => ({ entries: agents.map((a) => ({ agent: a })) }) } }) as never;

test("a chat's issue is the one it was given, else the one it was started from, looked up once", async () => {
  home("chats");
  const asked: string[][] = [];
  const chats = chatIndex(async (ids) => {
    asked.push(ids);
    const found = Object.fromEntries(ids.filter((id) => id !== "gone").map((id) => [id, chat(id)]));
    return { found, complete: true };
  }).read;
  await setChat("given", chat("i2"));
  await setChat("detached", null);
  const paseo = paseoWith(
    agent("given", { [ISSUE_LABEL]: "i1" }),
    agent("detached", { [ISSUE_LABEL]: "i1" }),
    agent("started", { [ISSUE_LABEL]: "i1" }),
    agent("deleted", { [ISSUE_LABEL]: "gone" }),
    agent("plain"),
  );
  assert.deepEqual(await chats(paseo), { given: chat("i2"), started: chat("i1") });
  assert.deepEqual(asked, [["i1", "gone"]]);
  // remembered, and an issue no account can see isn't asked about again
  assert.deepEqual(await chats(paseo), { given: chat("i2"), started: chat("i1") });
  assert.equal(asked.length, 1);
  assert.deepEqual(await storedChats(), { given: chat("i2"), detached: null, started: chat("i1") });
});

test("a chat given an issue while the one it was started from is looked up keeps it", async () => {
  home("chats-race");
  let called!: () => void;
  const asked = new Promise<void>((resolve) => (called = resolve));
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const chats = chatIndex(async () => {
    called();
    await answered;
    return { found: { i1: chat("i1") }, complete: true };
  }).read;
  const listing = chats(paseoWith(agent("a", { [ISSUE_LABEL]: "i1" })));
  await asked;
  await setChat("a", chat("i9"));
  answer();
  assert.deepEqual(await listing, { a: chat("i9") });
});

test("an issue is asked about again after an account didn't answer, or once the accounts change", async () => {
  home("chats-retry");
  let answers: { found: Record<string, ChatIssue>; complete: boolean }[] = [];
  let asked = 0;
  const index = chatIndex(async () => (asked++, answers.shift()!));
  const paseo = paseoWith(agent("a", { [ISSUE_LABEL]: "i1" }));
  answers = [
    { found: {}, complete: false },
    { found: {}, complete: true },
    { found: { i1: chat("i1") }, complete: true },
  ];
  assert.deepEqual(await index.read(paseo), {});
  // offline, rate limited: asked again
  assert.deepEqual(await index.read(paseo), {});
  assert.equal(asked, 2);
  // every account said no: not asked again
  assert.deepEqual(await index.read(paseo), {});
  assert.equal(asked, 2);
  // until an account is added or removed
  index.forget();
  assert.deepEqual(await index.read(paseo), { a: chat("i1") });
  assert.equal(asked, 3);
});

test("a lookup that answers after the accounts changed doesn't mark its misses unknown", async () => {
  home("chats-forget");
  type Answer = (lookup: { found: Record<string, ChatIssue>; complete: boolean }) => void;
  const lookups: Answer[] = [];
  let called!: () => void;
  const index = chatIndex(
    () =>
      new Promise((resolve) => {
        lookups.push(resolve);
        called();
      }),
  );
  const asked = () => new Promise<void>((resolve) => (called = resolve));
  const paseo = paseoWith(agent("a", { [ISSUE_LABEL]: "i1" }));
  let lookup = asked();
  const reading = index.read(paseo);
  await lookup;
  // an account is added while the lookup is out
  index.forget();
  lookups[0]({ found: {}, complete: true });
  assert.deepEqual(await reading, {});
  lookup = asked();
  const again = index.read(paseo);
  await lookup;
  lookups[1]({ found: { i1: chat("i1") }, complete: true });
  assert.deepEqual(await again, { a: chat("i1") });
});

test("a read of every chat's issue that started before a change made here doesn't undo it", async () => {
  const store = chatStore();
  let answer!: (chats: Record<string, ChatIssue>) => void;
  const reading = store.refresh(() => new Promise((resolve) => (answer = resolve)));
  store.changed({});
  answer({ a: chat("i1") });
  await reading;
  assert.equal(store.get("a"), null);
  await store.refresh(async () => ({ a: chat("i2") }));
  assert.deepEqual(store.get("a"), chat("i2"));
});

test("an issue's card lists the agents working on it: given it, or started from it and not detached", async () => {
  const paseo = paseoWith(
    agent("started", { [ISSUE_LABEL]: "i1" }),
    agent("moved", { [ISSUE_LABEL]: "i1" }),
    agent("detached", { [ISSUE_LABEL]: "i1" }),
    agent("given"),
  );
  const found = await agentsFor(paseo, ["i1", "i2"], {
    moved: chat("i2"),
    detached: null,
    given: chat("i1"),
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(found).map(([issueId, agents]) => [issueId, agents.map((a) => a.id)])),
    { i1: ["started", "given"], i2: ["moved"] },
  );
});

test("issues are looked up by ID a page at a time", async () => {
  const asked: string[][] = [];
  const request = (async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body)) as { variables: { ids: string[] } };
    asked.push(variables.ids);
    const nodes = variables.ids.map((id) => ({ id, identifier: id, title: id, url: "https://linear.app" }));
    return new Response(JSON.stringify({ data: { issues: { nodes } } }));
  }) as typeof fetch;
  const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
  assert.equal((await linear("k", request).byIds(ids)).length, 250);
  assert.deepEqual(
    asked.map((page) => page.length),
    [200, 50],
  );
});

test("search results say their account; a chat given one, or started from one, keeps it until detached", async () => {
  home("chats-rpc");
  await saveAccount({
    id: "u1",
    apiKey: "lin_api_1",
    workspace: "Acme",
    urlKey: "acme",
    name: "Sam",
    email: "sam@example.com",
  });
  const url = "https://linear.app/acme/issue/ENG-7";
  const issue = {
    id: "i1",
    identifier: "ENG-7",
    title: "Fix login",
    url,
    description: null,
    branchName: "eng-7",
    priorityLabel: "High",
    state: { name: "Todo" },
    team: { key: "ENG", name: "Engineering" },
    assignee: null,
    project: null,
    labels: { nodes: [] },
    comments: { nodes: [] },
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(String(init.body)) as { query: string };
    const data = query.includes("viewer")
      ? {
          viewer: { id: "u1", name: "Sam", email: "sam@example.com" },
          organization: { name: "Acme", urlKey: "acme" },
        }
      : query.includes("id: { in: $ids }")
        ? { issues: { nodes: [{ id: "i1", identifier: "ENG-7", title: "Fix login", url }] } }
        : { issue };
    return new Response(JSON.stringify({ data }));
  }) as typeof fetch;
  try {
    const handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {};
    contribute({
      registerSettings: () => ({
        read: async () => ({ status: "ready", revision: "1", values: { projects: {}, agentTools: "off" } }),
        subscribe: () => () => {},
      }),
      handle: (contract: { name: string }, handler: never) => (handlers[contract.name] = handler),
      before: () => () => {},
      on: () => () => {},
    } as never);
    const eng7 = { accountId: "u1", id: "i1", identifier: "ENG-7", title: "Fix login", url };

    const { items } = (await handlers[searchRpc.name]({ query: "ENG-7" }, {})) as {
      items: { accountId: string }[];
    };
    assert.equal(items[0].accountId, "u1");
    await handlers[setChatRpc.name]({ agentId: "given", issue: eng7 }, {});

    // started from the board: remembered as it starts
    const workspace = { id: "w1", projectId: "p", projectKind: "directory", projectRootPath: "/r" };
    let created = "board";
    const paseo = {
      workspaces: {
        ref: () => ({
          refresh: async () => workspace,
          agents: {
            create: async () => {
              // another app sees the new chat before this answers, and detaches it
              if (created === "detached")
                await handlers[setChatRpc.name]({ agentId: created, issue: null }, {});
              return { id: created };
            },
          },
        }),
        list: async () => ({ entries: [workspace] }),
      },
      agents: {
        list: async () => ({
          entries: [
            {
              agent: { id: "given", provider: "claude", model: "opus", workspaceId: "w1", labels: {} },
            },
            { agent: { id: "board", labels: { [ISSUE_LABEL]: "i1" } } },
            // started before chats were remembered
            { agent: { id: "older", labels: { [ISSUE_LABEL]: "i1" } } },
          ],
        }),
      },
    };
    await handlers[startRpc.name](
      { accountId: "u1", workspaceId: "w1", issueId: "i1", where: "here" },
      { paseo },
    );
    assert.deepEqual((await storedChats()).board, eng7);
    created = "detached";
    await handlers[startRpc.name](
      { accountId: "u1", workspaceId: "w1", issueId: "i1", where: "here" },
      { paseo },
    );
    assert.equal((await storedChats()).detached, null);
    assert.deepEqual((await handlers[chatsRpc.name]({}, { paseo })) as unknown, {
      chats: { given: eng7, board: eng7, older: eng7 },
    });

    assert.deepEqual(await handlers[setChatRpc.name]({ agentId: "board", issue: null }, {}), {
      chats: { given: eng7, older: eng7 },
    });
  } finally {
    globalThis.fetch = original;
  }
});
