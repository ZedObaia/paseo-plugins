import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginClientContext, PluginHeaderButtonContribution } from "@getpaseo/plugin/client";
import { headerButtons } from "../client/header";

const Content = () => null;
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
type Workspace = { id: string; archivingAt: string | null };
type Handlers = {
  snapshot(input: { entries: Workspace[] }): void;
  update(message: {
    type: "workspace_update";
    payload: { kind: "upsert"; workspace: Workspace } | { kind: "delete"; id: string };
  }): void;
};

test("every active workspace gets a stable dropdown before database discovery", async () => {
  let handlers!: Handlers;
  const shown = new Map<string, PluginHeaderButtonContribution>();
  let updates = 0;
  let releases = 0;
  const client = {
    paseo: {
      workspaces: {
        list: async (options: unknown) => {
          assert.deepEqual(options, { subscribe: {}, page: { limit: 200 } });
          return {
            subscription: {
              subscribe: (next: Handlers) => {
                handlers = next;
              },
              release: async () => {
                releases++;
              },
            },
          };
        },
      },
    },
    addHeaderButton: (entry: PluginHeaderButtonContribution) => {
      shown.set(entry.workspaceId, entry);
      return {
        update: () => {
          updates++;
        },
        remove: () => shown.delete(entry.workspaceId),
      };
    },
  } as unknown as PluginClientContext;
  const close = headerButtons(client, Content);
  try {
    await settled();
    handlers.snapshot({
      entries: [
        { id: "feature", archivingAt: null },
        { id: "no-database", archivingAt: null },
        { id: "archived", archivingAt: "2026-10-22" },
      ],
    });
    assert.deepEqual([...shown.keys()], ["feature", "no-database"]);
    for (const entry of shown.values()) {
      assert.equal(entry.button.label, "Databases");
      assert.ok(entry.button.behavior.kind === "popover");
      assert.equal(entry.button.behavior.Content, Content);
    }
    handlers.update({
      type: "workspace_update",
      payload: { kind: "upsert", workspace: { id: "feature", archivingAt: null } },
    });
    assert.equal(updates, 0);
    handlers.update({
      type: "workspace_update",
      payload: { kind: "upsert", workspace: { id: "new", archivingAt: null } },
    });
    assert.ok(shown.has("new"));
    handlers.update({
      type: "workspace_update",
      payload: { kind: "upsert", workspace: { id: "feature", archivingAt: "2026-10-22" } },
    });
    assert.ok(!shown.has("feature"));
    handlers.update({ type: "workspace_update", payload: { kind: "delete", id: "new" } });
    assert.ok(!shown.has("new"));
    handlers.snapshot({ entries: [] });
    assert.equal(shown.size, 0);
  } finally {
    close();
  }
  assert.equal(releases, 1);
});

test("a subscription finishing after cleanup is released without adding a button", async () => {
  let finish!: (value: unknown) => void;
  let registrations = 0;
  let releases = 0;
  const client = {
    paseo: {
      workspaces: {
        list: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    },
    addHeaderButton: () => {
      registrations++;
    },
  } as unknown as PluginClientContext;
  const close = headerButtons(client, Content);
  close();
  finish({
    subscription: {
      release: async () => {
        releases++;
      },
      subscribe: () => assert.fail("Subscription must not attach after cleanup"),
    },
  });
  await settled();
  assert.equal(registrations, 0);
  assert.equal(releases, 1);
});
