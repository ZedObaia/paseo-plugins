import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOT_LABEL } from "../shared/bot";
import { findBot, HUB_RELAY_LABEL, hubRelayPath, hubTools, isHubRelay } from "../server/hub-bridge";
import type { Relay } from "../server/relay";
import { fakeHost, makeBot } from "./helpers";

describe("the Hub bridge", () => {
  it("treats only non-bot agents in the Hub folder as relays", () => {
    expect(isHubRelay(hubRelayPath(), {})).toBe(true);
    expect(isHubRelay(`${hubRelayPath()}/`, {})).toBe(true);
    expect(isHubRelay(hubRelayPath(), { [BOT_LABEL]: "b1" })).toBe(false);
    expect(isHubRelay(join(hubRelayPath(), ".."), {})).toBe(false);
  });

  it("finds a live bot on this host by name or id", () => {
    const fawzy = makeBot({ id: "b1", name: "fawzy" });
    expect(findBot([fawzy], "Fawzy").id).toBe("b1");
    expect(findBot([fawzy], "b1").id).toBe("b1");
    expect(() => findBot([makeBot({ id: "b2", name: "old", archived: true })], "old")).toThrow();
    expect(() => findBot([makeBot({ id: "b3", name: "far", hostId: "other" })], "far")).toThrow("another host");
  });

  it("never lets a relay read a chat another relay started", async () => {
    const chats: Record<string, Record<string, string>> = {
      mine: { [BOT_LABEL]: "b1", [HUB_RELAY_LABEL]: "relay-1" },
      theirs: { [BOT_LABEL]: "b1", [HUB_RELAY_LABEL]: "relay-2" },
      plain: { [BOT_LABEL]: "b1" },
    };
    const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { id, labels: chats[id], status: "idle" } }) }) } };
    const [, checkChat] = hubTools(fakeHost([makeBot({ id: "b1", name: "fawzy" })]), {} as Relay);
    const context = { agent: { id: "relay-1" }, paseo, signal: new AbortController().signal } as never;
    await expect(checkChat!.execute({ chat_id: "theirs" }, context)).rejects.toThrow("only use chats this Hub run started");
    await expect(checkChat!.execute({ chat_id: "plain" }, context)).rejects.toThrow("only use chats this Hub run started");
  });
});
