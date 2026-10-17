import assert from "node:assert/strict";
import { test } from "node:test";
import { ListenerAccess } from "./identity";
import { Detections, type Detection } from "./kind";
import { stillLinkable } from "./policy";
import type { Listener } from "./processes";

const listener = (extra: Partial<Listener> = {}): Listener => ({
  port: 3000,
  address: "127.0.0.1",
  name: "node",
  detail: "node server.js",
  identity: "node server.js",
  pid: 10,
  source: "process",
  cwd: "/work",
  workspaceId: null,
  dirs: [],
  ...extra,
});

test("the watchdog asks the server running now, not the one the link was made for", async () => {
  const original = listener();
  let current = [original];
  const answers: Record<number, Detection> = {
    10: { protocol: "http", page: false },
    // the same command restarted, and now speaks something else
    11: { protocol: "other", page: false },
  };
  const detections = new Detections(async (l) => answers[l.pid!]);
  await detections.update([original]);
  const check = stillLinkable(new ListenerAccess(async () => current, 0), detections, () => new Set());
  assert.equal(await check(original), true);
  current = [listener({ pid: 11 })];
  // the link still holds the original listener, pid 10
  assert.equal(await check(original), false);
  // gone: the watchdog's own check ends its links
  current = [];
  assert.equal(await check(original), true);
});
