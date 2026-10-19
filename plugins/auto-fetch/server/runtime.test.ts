import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginServerContext, PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import { fetchSettings } from "../shared/contracts";
import contribute from "../index.server";
import { Fetcher } from "./fetcher";
import { Importer } from "./importer";

function server(
  t: TestContext,
  valid = true,
  settings?: PluginSettings<typeof fetchSettings.schema>,
): PluginServerContext {
  const home = mkdtempSync(join(tmpdir(), "auto-fetch-runtime-"));
  mkdirSync(join(home, "projects"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return {
    registerSettings: () =>
      settings ?? {
        read: async () =>
          valid
            ? {
                status: "ready",
                revision: "1",
                values: { intervalMinutes: 5, fastForward: true, fromRemote: true, importWorktrees: true },
              }
            : { status: "invalid", revision: "1", error: "invalid settings" },
        subscribe: () => () => {},
      },
    handle: () => {},
    registerProvider: () => {},
    registerUsageSource: () => {},
    before: () => () => {},
    on: () => () => {},
  } as PluginServerContext;
}

test("an import waiting for workspace creation doesn't block the fetch timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  t.mock.method(Importer.prototype, "check", () => held);
  const tick = t.mock.method(Fetcher.prototype, "tick", async () => {});
  const cleanup = contribute(server(t));
  t.after(cleanup);
  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tick.mock.callCount(), 1);
  release();
});

test("a late initial settings read doesn't replace a newer subscription update", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  type State = PluginSettingsState<typeof fetchSettings.schema>;
  let release!: (state: State) => void;
  const read = new Promise<State>((resolve) => (release = resolve));
  let notify!: (state: State) => void | Promise<void>;
  const settings: PluginSettings<typeof fetchSettings.schema> = {
    read: () => read,
    subscribe: (listener) => ((notify = listener), () => {}),
  };
  const tick = t.mock.method(Fetcher.prototype, "tick", async function (this: Fetcher) {
    assert.equal(this.fastForward, false);
  });
  const check = t.mock.method(Importer.prototype, "check", async () => {});
  const cleanup = contribute(server(t, true, settings));
  t.after(cleanup);
  const initial: State = {
    status: "ready",
    revision: "old",
    values: { intervalMinutes: 5, fastForward: true, fromRemote: true, importWorktrees: true },
  };
  await notify({ ...initial, revision: "new", values: { ...initial.values, fastForward: false } });
  release(initial);
  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(check.mock.callCount(), 1);
  assert.equal(tick.mock.callCount(), 1);
});

test("invalid saved settings don't start fetching or record projects as seen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const check = t.mock.method(Importer.prototype, "check", async () => {});
  const tick = t.mock.method(Fetcher.prototype, "tick", async () => {});
  const cleanup = contribute(server(t, false));
  t.after(cleanup);
  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(check.mock.callCount(), 0);
  assert.equal(tick.mock.callCount(), 0);
});
