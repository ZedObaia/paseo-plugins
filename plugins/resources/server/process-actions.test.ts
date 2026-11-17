import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { createProcessActions } from "./process-actions";
import { inspectProcess, type ProcessIdentity, type ProcessObservation } from "./processes";

function row(pid: number, ppid: number, uid = 1000): ProcessObservation {
  return {
    pid,
    ppid,
    uid,
    identity: `linux:${pid}`,
    canSignal: true,
    name: "node",
    user: "test",
    cpuPct: 0,
    memBytes: 0,
    cwd: null,
    workspaceId: null,
  };
}
function fixture() {
  let rows = [row(8, 1), row(9, 8), row(10, 9), row(20, 9), row(21, 20), row(22, 21), row(30, 9)];
  let now = 0;
  const sent: number[] = [];
  let inspect = async (pid: number): Promise<ProcessIdentity | null> => {
    const current = rows.find((p) => p.pid === pid);
    if (!current || current.uid === null || current.identity === null) return null;
    return { pid: current.pid, ppid: current.ppid, uid: current.uid, identity: current.identity };
  };
  const actions = createProcessActions({
    list: async () => rows,
    inspect: (pid) => inspect(pid),
    signal: (pid) => {
      sent.push(pid);
    },
    selfPid: 10,
    uid: 1000,
    now: () => now,
    token: () => "token",
  });
  return {
    actions,
    sent,
    rows: () => rows,
    setRows: (next: ProcessObservation[]) => {
      rows = next;
    },
    time: (value: number) => {
      now = value;
    },
    inspect: (next: typeof inspect) => {
      inspect = next;
    },
  };
}

test("signals a confirmed tree leaves-first, preserving unrelated agents; tokens are single-use", async () => {
  const f = fixture();
  const preview = await f.actions.preview(20, "linux:20");
  assert.deepEqual(
    preview.processes.map((p) => p.pid),
    [20, 21, 22],
  );
  await f.actions.signalTree(preview.token, "SIGTERM");
  assert.deepEqual(f.sent, [22, 21, 20]);
  await assert.rejects(f.actions.signalTree(preview.token, "SIGKILL"), /expired/);
});

test("refuses the daemon and trees containing another user's processes", async () => {
  const f = fixture();
  await assert.rejects(f.actions.preview(9, "linux:9"), /protected/);
  f.setRows([...f.rows(), row(23, 20, 2000)]);
  await assert.rejects(f.actions.preview(20, "linux:20"), /owned by your user/);
  assert.deepEqual(f.sent, []);
});

test("expired previews and changed tree membership send no signals", async () => {
  const f = fixture();
  const preview = await f.actions.preview(20, "linux:20");
  f.time(60_001);
  await assert.rejects(f.actions.signalTree(preview.token, "SIGTERM"), /expired/);
  f.time(0);
  const next = await f.actions.preview(20, "linux:20");
  f.setRows([...f.rows(), row(23, 20)]);
  await assert.rejects(f.actions.signalTree(next.token, "SIGTERM"), /changed since/);
  assert.deepEqual(f.sent, []);
});

test("PID reuse before confirmation or immediately before signalling never kills the replacement", async () => {
  const f = fixture();
  const preview = await f.actions.preview(20, "linux:20");
  f.setRows(f.rows().map((p) => (p.pid === 21 ? { ...p, identity: "linux:replacement" } : p)));
  await assert.rejects(f.actions.signalTree(preview.token, "SIGKILL"), /changed since/);
  f.inspect(async (pid) => {
    const process = f.rows().find((p) => p.pid === pid);
    return process && process.uid !== null
      ? { pid: process.pid, ppid: process.ppid, uid: process.uid, identity: "linux:replacement" }
      : null;
  });
  await assert.rejects(f.actions.signal(20, "linux:20", "SIGTERM"), /PID was reused/);
  assert.deepEqual(f.sent, []);
});

test("reparenting after preview requires another confirmation", async () => {
  const f = fixture();
  const preview = await f.actions.preview(20, "linux:20");
  f.setRows(f.rows().map((p) => (p.pid === 22 ? { ...p, ppid: 20 } : p)));
  await assert.rejects(f.actions.signalTree(preview.token, "SIGKILL"), /changed since/);
  assert.deepEqual(f.sent, []);
});

test(
  "real process tree preview and stop terminate only the spawned fixture",
  { skip: !["linux", "darwin"].includes(process.platform), timeout: 15_000 },
  async (t) => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.send({childPid:child.pid}); setInterval(()=>{},1000);`,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const [message] = await once(parent, "message");
    assert.equal(typeof message.childPid, "number");
    const childPid: number = message.childPid;
    t.after(async () => {
      for (const pid of [childPid, parent.pid])
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* fixture already exited */
          }
        }
    });
    assert.ok(parent.pid);
    const identity = await inspectProcess(parent.pid);
    assert.ok(identity);
    const actions = createProcessActions();
    const preview = await actions.preview(parent.pid, identity.identity);
    assert.ok(preview.processes.some((p) => p.pid === childPid));
    await actions.signalTree(preview.token, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (((await inspectProcess(parent.pid)) || (await inspectProcess(childPid))) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await inspectProcess(parent.pid), null);
    assert.equal(await inspectProcess(childPid), null);
  },
);
