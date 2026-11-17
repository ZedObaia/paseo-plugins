import assert from "node:assert/strict";
import { test } from "node:test";
import { count } from "../client/format";
import { processViewGroups } from "../client/process-groups";
import {
  groupProcesses,
  parseCwds,
  parseLinuxIdentity,
  parseMacIdentities,
  protectedAncestors,
  workspaceFromEnvironment,
  type ProcessObservation,
  type WorkspaceLocation,
} from "./processes";

const workspaces: WorkspaceLocation[] = [
  { id: "a", name: "Feature A", projectId: "project", projectName: "Paseo", directory: "/code/paseo" },
  { id: "b", name: "Feature B", projectId: "project", projectName: "Paseo", directory: "/worktrees/b" },
  {
    id: "nested",
    name: "Nested",
    projectId: "other",
    projectName: "Nested project",
    directory: "/code/paseo/nested",
  },
];
function row(pid: number, overrides: Partial<ProcessObservation> = {}): ProcessObservation {
  return {
    pid,
    ppid: 1,
    name: "node",
    user: "test",
    uid: 1000,
    identity: `linux:${pid}`,
    canSignal: true,
    cpuPct: 10,
    memBytes: 100,
    cwd: null,
    workspaceId: null,
    ...overrides,
  };
}

test("workspace identity survives chdir and parent exit; children inherit their owner's workspace", () => {
  const groups = groupProcesses(
    [
      row(10, { workspaceId: "a", cwd: "/tmp" }),
      row(11, { ppid: 10, cwd: "/tmp" }),
      row(12, { ppid: 11, workspaceId: "b" }),
      row(13, { ppid: 1, workspaceId: "a", cwd: "/tmp" }),
    ],
    workspaces,
  );
  const a = groups.find((group) => group.workspaceId === "a")!;
  assert.equal(a.cpuPct, 30);
  assert.equal(a.memBytes, 300);
  assert.deepEqual(
    a.processes.map((p) => [p.pid, p.attribution]),
    [
      [10, "identity"],
      [11, "ancestor"],
      [13, "identity"],
    ],
  );
  assert.equal(groups.find((group) => group.workspaceId === "b")?.processes[0].pid, 12);
  assert.equal("cwd" in a.processes[0], false);
  assert.equal("uid" in a.processes[0], false);
});

test("directory matches use path boundaries and the deepest unique workspace", () => {
  const groups = groupProcesses(
    [
      row(10, { cwd: "/code/paseo/src" }),
      row(11, { cwd: "/code/paseo/nested/src" }),
      row(12, { cwd: "/code/paseo-other" }),
      row(13, { cwd: "/worktrees/b (deleted)" }),
    ],
    workspaces,
  );
  assert.deepEqual(
    groups.find((g) => g.workspaceId === "a")?.processes.map((p) => p.pid),
    [10],
  );
  assert.deepEqual(
    groups.find((g) => g.workspaceId === "nested")?.processes.map((p) => p.pid),
    [11],
  );
  assert.deepEqual(
    groups.find((g) => g.workspaceId === "b")?.processes.map((p) => p.pid),
    [13],
  );
  assert.deepEqual(
    groups.find((g) => g.workspaceId === null)?.processes.map((p) => p.pid),
    [12],
  );
});

test("shared directories stay ambiguous, while an explicit ID disambiguates them", () => {
  const shared = [...workspaces, { ...workspaces[0], id: "shared" }];
  const groups = groupProcesses(
    [row(10, { cwd: "/code/paseo" }), row(11, { cwd: "/code/paseo", workspaceId: "a" })],
    shared,
  );
  assert.equal(groups.find((g) => g.workspaceId === null)?.processes[0].pid, 10);
  assert.equal(groups.find((g) => g.workspaceId === "a")?.processes[0].pid, 11);
});

test("unknown workspace IDs are preserved rather than attributed to another directory", () => {
  const [group] = groupProcesses([row(10, { workspaceId: "archived", cwd: "/code/paseo" })], workspaces);
  assert.equal(group.workspaceId, "archived");
  assert.equal(group.projectId, null);
  assert.equal(group.workspaceName, "Unregistered workspace");
});

test("ancestry cycles cannot hang grouping; project totals count each process once", () => {
  const groups = groupProcesses(
    [row(10, { ppid: 11, workspaceId: "a" }), row(11, { ppid: 10 }), row(12, { workspaceId: "b" })],
    workspaces,
  );
  const [project] = processViewGroups(groups, "project", "memory");
  assert.equal(project.cpuPct, 30);
  assert.equal(project.memBytes, 300);
  assert.equal(project.processes.length, 3);
  assert.equal(processViewGroups(groups, "workspace", "cpu").length, 2);
});

test("extracts only workspace identity from a bounded environment buffer", () => {
  assert.equal(
    workspaceFromEnvironment(Buffer.from("SECRET=do-not-return\0PASEO_WORKSPACE_ID=a\0PATH=/bin\0")),
    "a",
  );
  assert.equal(workspaceFromEnvironment(Buffer.from("SECRET=do-not-return\0")), null);
});

test("Linux birth identity tolerates parentheses in command names and rejects zombies", () => {
  const fields = ["S", "1", ...Array(17).fill("0"), "12345", "0"];
  assert.deepEqual(parseLinuxIdentity(10, `10 (name with ) parentheses) ${fields.join(" ")}`, 1000), {
    pid: 10,
    ppid: 1,
    uid: 1000,
    identity: "linux:12345",
  });
  fields[0] = "Z";
  assert.equal(parseLinuxIdentity(10, `10 (zombie) ${fields.join(" ")}`, 1000), null);
  assert.equal(parseLinuxIdentity(11, "10 (other process) S 1", 1000), null);
});

test("macOS birth timestamps and cwd output retain spaces", () => {
  const identities = parseMacIdentities(" 10 1 1000 Tue Nov 17 12:34:56 2026\n");
  assert.equal(identities.get(10)?.identity, "darwin:Tue Nov 17 12:34:56 2026");
  assert.equal(parseCwds("p10\nn/Users/test/My Project\np11\nn/tmp\n").get(10), "/Users/test/My Project");
});

test("protects the plugin, daemon, supervisor and init without protecting sibling agents", () => {
  const protectedIds = protectedAncestors(
    [row(10, { ppid: 9 }), row(9, { ppid: 8 }), row(8), row(11, { ppid: 9 })],
    10,
  );
  assert.deepEqual(
    [...protectedIds].sort((a, b) => a - b),
    [1, 8, 9, 10],
  );
});

test("project-root processes retain their project without inventing a workspace", () => {
  const locations = [
    ...workspaces,
    {
      id: null,
      name: "Tools (project root)",
      projectId: "tools",
      projectName: "Tools",
      directory: "/code/tools",
    },
  ];
  const groups = groupProcesses([row(40, { cwd: "/code/tools/src" }), row(41)], locations);
  const project = groups.find((group) => group.projectId === "tools")!;
  assert.equal(project.workspaceId, null);
  assert.equal(project.processes[0].pid, 40);
  assert.equal(processViewGroups(groups, "workspace", "memory").length, 2);
  assert.equal(processViewGroups(groups, "project", "cpu").length, 2);
  assert.equal(count(2, "process"), "2 processes");
});
