import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBridge, type FawzyBridge } from "../client/bridge";
import { controlLabel, modeIcon, providerIcon } from "../client/home/composer-controls";
import { headerStatus, recentActivity, splitChats } from "../client/home/model";
import { newRoutineEntries, presetRoutine, ROUTINE_PRESETS } from "../client/home/presets";
import { BotSchema, type BotSettingsValues } from "../shared/bot";
import { sidebarBotsRpc } from "../shared/fawzy-rpc";
import { applyProposalDecision } from "../shared/proposal-decisions";
import { BOT_STATUS_METADATA } from "../shared/status";
import { startChat } from "../server/chats";
import { getProposal } from "../server/proposals";
import { dismissSuggestion, listSuggestions, startSuggestion, suggestTask } from "../server/suggestions";
import { setStatus } from "../server/tools/status";
import { suggestTask as suggestTaskTool } from "../server/tools/suggestions";
import { fakeHost, makeBot } from "./helpers";

vi.mock("../client/Avatar", () => ({ Avatar: "Avatar" }));
vi.mock("../server/chats", () => ({ startChat: vi.fn() }));

describe("bridge", () => {
  it("lists bots, opens their screens titled with the name, and unregisters", async () => {
    const avatar = makeBot().avatar;
    const rpc = vi.fn(async () => ({ bots: [{ id: "bot-a", name: "Scout", avatar }] }));
    const openScreen = vi.fn();
    const remove = registerBridge({ rpc, openScreen } as never);
    const registry = (globalThis as { __fawzyBridges?: Set<FawzyBridge> }).__fawzyBridges!;
    const bridge = [...registry].at(-1)!;
    expect(bridge.version).toBe(1);
    expect(await bridge.listBots()).toEqual([{ id: "bot-a", name: "Scout", avatar }]);
    expect(rpc).toHaveBeenCalledWith(sidebarBotsRpc, {});

    bridge.openBot("bot-a");
    bridge.openChat("bot-a", "chat-1");
    bridge.newChat("bot-a");
    bridge.newBot();
    expect(openScreen.mock.calls.map(([input]) => input)).toMatchObject([
      { screenId: "bot-home", params: { botId: "bot-a", title: "Scout" } },
      { screenId: "bot-chat", params: { botId: "bot-a", chatId: "chat-1", title: "Scout" } },
      { screenId: "bot-new-chat", params: { botId: "bot-a", title: "Scout" } },
      { screenId: "bot-new" },
    ]);

    // An unknown bot is looked up before its screen opens.
    bridge.openBot("bot-b");
    await vi.waitFor(() => expect(openScreen).toHaveBeenLastCalledWith({ screenId: "bot-home", params: { botId: "bot-b", title: "Bot" } }));
    expect(bridge.Avatar).toBe("Avatar");

    remove();
    expect(registry.has(bridge)).toBe(false);
  });
});

describe("set_status", () => {
  it("writes the status on the calling chat and clears it with empty text", async () => {
    const setMetadata = vi.fn(async () => {});
    const ref = vi.fn(() => ({ setMetadata }));
    const host = fakeHost([makeBot()]);
    host.attach({ agents: { ref } } as never);
    const caller = { bot: makeBot(), agentId: "chat-1", host, relay: null as never };
    expect(await setStatus.run({ text: "  Reviewing   PRs ", progress: 0.25 }, caller)).toBe("Status shown.");
    expect(ref).toHaveBeenCalledWith("chat-1");
    expect(setMetadata).toHaveBeenLastCalledWith({ [BOT_STATUS_METADATA]: { text: "Reviewing PRs", progress: 0.25, updatedAt: expect.any(String) } });
    await setStatus.run({ text: "Halfway" }, caller);
    expect(setMetadata).toHaveBeenLastCalledWith({ [BOT_STATUS_METADATA]: expect.objectContaining({ progress: null }) });
    expect(await setStatus.run({ text: "" }, caller)).toBe("Status cleared.");
    expect(setMetadata).toHaveBeenLastCalledWith({ [BOT_STATUS_METADATA]: null });
    expect(setStatus.input.safeParse({ text: "x".repeat(81) }).success).toBe(false);
    expect(setStatus.input.safeParse({ text: "x", progress: 1.5 }).success).toBe(false);
  });
});

describe("suggestions", () => {
  let home: string;
  const previousHome = process.env.PASEO_HOME;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-fawzy-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    vi.mocked(startChat).mockReset();
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const task = (title: string) => ({ title, prompt: `Do ${title}`, source: "github" as const });

  it("refuses repeats of pending, started and recently dismissed titles", async () => {
    const caller = { bot: makeBot({ id: "bot-a" }), agentId: "chat-1", host: fakeHost([]), relay: null as never };
    expect(await suggestTaskTool.run({ title: "Review PR 12", prompt: "Review it", source: "github" }, caller)).toContain("Suggested");
    expect(await suggestTaskTool.run({ title: " review  pr 12", prompt: "x", source: "github" }, caller)).toContain("already suggested");
    // Two at once still add one.
    const [first, second] = await Promise.all([suggestTask("bot-a", "c", task("Triage inbox")), suggestTask("bot-a", "c", task("Triage inbox"))]);
    expect(["proposal" in first, "proposal" in second]).toEqual([true, false]);

    const dismissed = (await listSuggestions("bot-a")).find((entry) => entry.data.title === "Triage inbox")!;
    await dismissSuggestion(dismissed.id);
    expect(await suggestTask("bot-a", "c", task("triage INBOX"))).toEqual({ refused: expect.stringContaining("dismissed") });
    // After 30 days it may come back; other bots are unaffected.
    expect("proposal" in (await suggestTask("bot-a", "c", task("Triage inbox"), Date.now() + 31 * 86_400_000))).toBe(true);
    expect("proposal" in (await suggestTask("bot-b", "c", task("Review PR 12")))).toBe(true);
  });

  it("lists pending ones newest first, starts one chat per suggestion and puts it back when starting fails", async () => {
    const bot = makeBot({ id: "bot-a" });
    const host = fakeHost([bot]);
    for (const title of ["One", "Two", "Three"]) {
      await suggestTask("bot-a", "c", task(title));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const [three, two, one] = await listSuggestions("bot-a");
    expect([three, two, one].map((entry) => entry!.data.title)).toEqual(["Three", "Two", "One"]);

    vi.mocked(startChat).mockResolvedValue("new-chat");
    expect(await startSuggestion(three!.id, host, null as never)).toEqual({ chatId: "new-chat" });
    expect(startChat).toHaveBeenCalledWith(host, null, bot, { prompt: "Do Three", title: "Three", labels: {} });
    expect((await getProposal(three!.id))?.status).toBe("accepted");
    await expect(startSuggestion(three!.id, host, null as never)).rejects.toThrow("already started");
    expect(startChat).toHaveBeenCalledTimes(1);

    vi.mocked(startChat).mockRejectedValueOnce(new Error("Paseo is offline"));
    await expect(startSuggestion(two!.id, host, null as never)).rejects.toThrow("offline");
    expect((await getProposal(two!.id))?.status).toBe("pending");

    await dismissSuggestion(one!.id);
    await expect(startSuggestion(one!.id, host, null as never)).rejects.toThrow("dismissed");
    expect((await listSuggestions("bot-a")).map((entry) => entry.data.title)).toEqual(["Two"]);
  });

  it("never applies through the settings-change path", async () => {
    const proposal = { id: "p-1", botId: "bot-a", agentId: "c", status: "pending", createdAt: "", resolvedAt: null, kind: "task", data: task("x") } as const;
    const values: BotSettingsValues = { bots: [makeBot({ id: "bot-a" })], history: [] };
    expect(() => applyProposalDecision(values, { proposal, expiredReceiptIds: [], epoch: 0 }, "accepted")).toThrow("bot's page");
  });
});

describe("bot page", () => {
  const chat = (id: string, updatedAt: string, patch: Record<string, unknown> = {}) => ({ id, updatedAt, status: "idle", archivedAt: null, ...patch });

  it("sorts chats into in progress, recent and closed, newest first", () => {
    const chats = [
      chat("old", "2026-11-01"),
      chat("running", "2026-11-02", { status: "running" }),
      chat("asking", "2026-11-03", { pendingPermissions: [{}] }),
      chat("new", "2026-11-04"),
      chat("archived", "2026-11-05", { archivedAt: "2026-11-05" }),
    ];
    const { inProgress, recent, closed } = splitChats(chats);
    expect(inProgress.map((entry) => entry.id)).toEqual(["asking", "running"]);
    expect(recent.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(closed.map((entry) => entry.id)).toEqual(["archived"]);
  });

  it("shows the newest status a bot set, else Working… while a chat runs", () => {
    const status = (text: string, updatedAt: string, progress: number | null = null) => ({ [BOT_STATUS_METADATA]: { text, progress, updatedAt } });
    expect(headerStatus([chat("a", "1"), chat("b", "2")])).toBeNull();
    expect(headerStatus([chat("a", "1", { status: "running" })])).toEqual({ text: "Working…", progress: null });
    expect(headerStatus([
      chat("a", "1", { status: "running", metadata: status("Older", "2026-11-01T00:00:00Z") }),
      chat("b", "1", { metadata: status("Newer", "2026-11-02T00:00:00Z", 0.5) }),
      chat("c", "1", { archivedAt: "x", metadata: status("Archived", "2026-11-03T00:00:00Z") }),
      chat("d", "1", { metadata: { [BOT_STATUS_METADATA]: { text: 5 } } }),
    ])).toEqual({ text: "Newer", progress: 0.5 });
  });

  it("labels the new chat's controls as Paseo's composer does", () => {
    expect(controlLabel({ id: "xhigh", label: "xhigh" }, true)).toBe("Extra high");
    expect(controlLabel({ id: "medium", label: "Medium" }, true)).toBe("Medium");
    expect(controlLabel({ id: "bypassPermissions" })).toBe("Bypass permissions");
    expect(controlLabel({ id: "auto", label: "Auto mode" })).toBe("Auto mode");
    expect(modeIcon("ShieldCheck")).toBe("ShieldCheck");
    expect(modeIcon("Rocket")).toBe("Bot");
    expect(modeIcon(undefined)).toBe("Bot");
    expect(providerIcon("claude")).toMatchObject({ svg: expect.stringContaining("<svg") });
    expect(providerIcon("acme", "<svg/>")).toEqual({ svg: "<svg/>" });
    expect(providerIcon("acme")).toBe("Bot");
  });

  it("lists recent activity from chats and memory changes, newest first", () => {
    const bot = { name: "Scout", routines: [{ id: "r-1", name: "Look around" }] };
    const journal = (id: string, at: string, chatId: string | null) => ({
      id, at, file: "MEMORY.md", actor: "bot" as const, via: "chat" as const, chat: chatId ? { id: chatId, title: "Inbox" } : null,
      kind: "edited" as const, diff: "", added: 2, removed: 0, canUndo: true,
    });
    const items = recentActivity(bot, [
      chat("plain", "2026-11-01T00:00:00Z", { title: "[Hub] Reply to PR" }),
      chat("routine", "2026-11-03T00:00:00Z", { labels: { "paseo-bots.routine": "r-1" }, status: "running" }),
      chat("closed", "2026-11-04T00:00:00Z", { archivedAt: "2026-11-04" }),
    ], [journal("j-1", "2026-11-02T00:00:00Z", "plain"), journal("j-2", "2026-11-05T00:00:00Z", null)], 4);
    expect(items.map(({ id, text, hint, chatId }) => ({ id, text, hint, chatId }))).toEqual([
      { id: "memory:j-2", text: "Scout added 2 lines to MEMORY.md", hint: "in the bot's settings", chatId: null },
      { id: "chat:closed", text: "New chat", hint: "Closed", chatId: "closed" },
      { id: "chat:routine", text: "Ran Look around", hint: "Working", chatId: "routine" },
      { id: "memory:j-1", text: "Scout added 2 lines to MEMORY.md", hint: 'from chat "Inbox"', chatId: "plain" },
    ]);
  });

  it("offers valid preset routines once per bot, then the custom form", () => {
    for (const preset of ROUTINE_PRESETS) BotSchema.shape.routines.parse([presetRoutine(preset)]);
    const add = vi.fn(), custom = vi.fn();
    const look = presetRoutine(ROUTINE_PRESETS[0]!);
    const entries = newRoutineEntries(makeBot({ routines: [look] }), add, custom);
    expect(entries.map((entry) => ("label" in entry ? [entry.label, !!entry.disabled] : "-"))).toEqual([["Look around", true], ["Tidy memory", false], "-", ["Custom routine", false]]);
    const tidy = entries[1]!;
    if ("onSelect" in tidy) void tidy.onSelect();
    expect(add.mock.calls[0]![0]).toMatchObject({ name: "Tidy memory", enabled: true, schedule: { kind: "daily", time: "02:00" } });
  });
});
