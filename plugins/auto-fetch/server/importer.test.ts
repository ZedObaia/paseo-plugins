import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Importer, type Workspaces } from "./importer";
import type { Project } from "./registry";
import { takenDirectories } from "./registry";
import { missingWorktrees, parseWorktrees } from "./worktrees";
import { wait } from "./wait";

process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

const scratch = (t: TestContext) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auto-fetch-import-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A repository with three linked worktrees, one of them since deleted. */
function repo(t: TestContext) {
  const root = scratch(t);
  const main = join(root, "main");
  sh(root, "init", "-q", "-b", "main", main);
  writeFileSync(join(main, "a"), "a");
  sh(main, "add", ".");
  sh(main, "commit", "-qm", "first");
  const trees = ["one", "two", "gone"].map((name) => join(root, name));
  for (const tree of trees) sh(main, "worktree", "add", "-q", "-b", `b-${tree.split("/").pop()}`, tree);
  rmSync(trees[2], { recursive: true, force: true });
  return { root, main, one: trees[0], two: trees[1] };
}

test("parses git's worktree list", () => {
  const porcelain = [
    "worktree /r",
    "bare",
    "",
    "worktree /r/a",
    "HEAD abc",
    "branch refs/heads/a",
    "",
    "worktree /r/b",
    "HEAD def",
    "detached",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\0");
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: "/r", branch: null, bare: true, prunable: false },
    { path: "/r/a", branch: "a", bare: false, prunable: false },
    { path: "/r/b", branch: null, bare: false, prunable: true },
  ]);
});

test("lists linked worktrees without a workspace, never the main checkout", async (t) => {
  const { main, one, two } = repo(t);
  assert.deepEqual(await missingWorktrees(main, []), [
    { path: one, branch: "b-one" },
    { path: two, branch: "b-two" },
  ]);
  assert.deepEqual(await missingWorktrees(main, [one, "/elsewhere"]), [{ path: two, branch: "b-two" }]);
  // a project made from a linked worktree: the others, and not itself
  assert.deepEqual(await missingWorktrees(one, []), [{ path: two, branch: "b-two" }]);
});

test("worktree paths are read literally, including quotes, Unicode and newlines", async (t) => {
  const { root, main, one, two } = repo(t);
  const path = join(root, 'a "quote"\nü');
  sh(main, "worktree", "add", "-q", "--detach", path);
  const alias = join(root, "alias");
  symlinkSync(one, alias);
  assert.deepEqual(await missingWorktrees(main, [alias, two]), [{ path, branch: null }]);
});

test("a worktree whose workspace was archived in its project stays out", async (t) => {
  const file = join(scratch(t), "workspaces.json");
  writeFileSync(
    file,
    JSON.stringify([
      { cwd: "/w/active", kind: "worktree", projectId: "a", archivedAt: null },
      { cwd: "/w/elsewhere", kind: "worktree", projectId: "b", archivedAt: null },
      { cwd: "/w/archived-here", kind: "worktree", projectId: "a", archivedAt: "2026-10-16T17:36:11.483Z" },
      { cwd: "/w/archived-there", kind: "worktree", projectId: "b", archivedAt: "2026-10-16T17:36:11.483Z" },
      { cwd: "/w/tree/subdir", worktreeRoot: "/w/tree", kind: "worktree", projectId: "a" },
    ]),
  );
  assert.deepEqual(await takenDirectories("a", file), [
    "/w/active",
    "/w/elsewhere",
    "/w/archived-here",
    "/w/tree/subdir",
    "/w/tree",
  ]);
});

function fakeWorkspaces() {
  const created: { path: string; projectId: string }[] = [];
  const workspaces: Workspaces = {
    create: async ({ source }) => {
      created.push({ path: source.path, projectId: source.projectId });
      return {};
    },
  };
  return { workspaces, created };
}

function importer(t: TestContext, projects: Project[]) {
  const file = join(scratch(t), "known", "projects.json");
  const workspaceDirs: string[] = [];
  const instance = new Importer({
    projects: async () => projects,
    takenDirs: async () => workspaceDirs,
    missingWorktrees: async (root, taken) =>
      [`${root}/w1`, `${root}/w2`].filter((p) => !taken.includes(p)).map((path) => ({ path, branch: null })),
    file,
  });
  return { instance, file, workspaceDirs };
}

const project = (id: string): Project => ({ projectId: id, rootPath: `/p/${id}`, kind: "git" });

test("adds the worktrees of projects added after its first run, once", async (t) => {
  const projects = [project("old")];
  const { instance, file, workspaceDirs } = importer(t, projects);
  const { workspaces, created } = fakeWorkspaces();
  await instance.check(workspaces);
  assert.equal(created.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old"] });

  projects.push(project("new"));
  await instance.check(workspaces);
  assert.deepEqual(
    created.map((c) => [c.path, c.projectId]),
    [
      ["/p/new/w1", "new"],
      ["/p/new/w2", "new"],
    ],
  );
  workspaceDirs.push("/p/new/w1", "/p/new/w2");
  await instance.check(workspaces);
  await instance.check(workspaces);
  assert.equal(created.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old", "new"] });
});

test("a new project waits for the Paseo API, and only counts as seen when it's off", async (t) => {
  const projects = [project("old")];
  const { instance } = importer(t, projects);
  const { workspaces, created } = fakeWorkspaces();
  await instance.check(undefined);
  projects.push(project("new"));
  await instance.check(undefined);
  await instance.check(workspaces);
  assert.equal(created.length, 2);

  instance.enabled = false;
  projects.push(project("quiet"));
  await instance.check(undefined);
  instance.enabled = true;
  await instance.check(workspaces);
  assert.equal(created.length, 2);
});

test("checks at the same moment add a worktree once", async (t) => {
  const projects = [project("old")];
  const { instance, workspaceDirs } = importer(t, projects);
  const created: string[] = [];
  const workspaces: Workspaces = {
    create: async ({ source }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      created.push(source.path);
      workspaceDirs.push(source.path);
      return {};
    },
  };
  await instance.check(workspaces);
  projects.push(project("new"));
  await Promise.all([
    instance.check(workspaces),
    instance.check(workspaces),
    instance.importProject(workspaces, project("new")),
  ]);
  assert.deepEqual(created, ["/p/new/w1", "/p/new/w2"]);
});

test("a project whose worktrees can't be listed is retried", async (t) => {
  const file = join(scratch(t), "projects.json");
  const projects = [project("old")];
  let failing = true;
  const instance = new Importer({
    projects: async () => projects,
    takenDirs: async () => [],
    missingWorktrees: async () => {
      if (failing) throw new Error("git unavailable");
      return [];
    },
    file,
  });
  const { workspaces } = fakeWorkspaces();
  await instance.check(workspaces);
  projects.push(project("broken"));
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  await instance.check(workspaces);
  assert.equal(errors.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old"] });
  failing = false;
  await instance.check(workspaces);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old", "broken"] });
});

test("lists the projects with worktrees to add, and asks git again after adding", async (t) => {
  const projects = [project("b"), { ...project("a"), customName: "Alpha" }, project("none")];
  const { instance, workspaceDirs } = importer(t, projects);
  workspaceDirs.push("/p/none/w1", "/p/none/w2", "/p/b/w1");
  assert.deepEqual(await instance.pending(), [
    {
      projectId: "a",
      name: "Alpha",
      path: "/p/a",
      importing: false,
      error: null,
      worktrees: [
        { path: "/p/a/w1", branch: null },
        { path: "/p/a/w2", branch: null },
      ],
    },
    {
      projectId: "b",
      name: "b",
      path: "/p/b",
      worktrees: [{ path: "/p/b/w2", branch: null }],
      importing: false,
      error: null,
    },
  ]);
  const workspaces: Workspaces = {
    create: async ({ source }) => (workspaceDirs.push(source.path), {}),
  };
  assert.deepEqual(await instance.importProject(workspaces, projects[1]), ["/p/a/w1", "/p/a/w2"]);
  assert.deepEqual(
    (await instance.pending()).map((p) => p.projectId),
    ["b"],
  );
});

test("a partially imported project retries without duplicating its completed workspace", async (t) => {
  const projects = [project("old")];
  const { instance, file, workspaceDirs } = importer(t, projects);
  t.mock.method(console, "error", () => {});
  const created: string[] = [];
  let failing = true;
  const workspaces: Workspaces = {
    create: async ({ source }) => {
      if (failing && source.path.endsWith("w2")) throw new Error("creation failed");
      created.push(source.path);
      workspaceDirs.push(source.path);
    },
  };
  await instance.check(workspaces);
  projects.push(project("new"));
  await instance.check(workspaces);
  assert.deepEqual(created, ["/p/new/w1"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old"] });
  assert.equal((await instance.pending()).find((p) => p.projectId === "new")?.error, "creation failed");
  failing = false;
  await instance.check(workspaces);
  assert.deepEqual(created, ["/p/new/w1", "/p/new/w2"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old", "new"] });
});

test("a failed save is retried even after every project is known in memory", async (t) => {
  const projects = [project("old")];
  const { instance, file } = importer(t, projects);
  const { workspaces } = fakeWorkspaces();
  await instance.check(workspaces);
  rmSync(file);
  mkdirSync(file);
  projects.push(project("new"));
  await assert.rejects(instance.check(workspaces));
  rmSync(file, { recursive: true });
  await instance.check(workspaces);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old", "new"] });
});

test("invalid saved state doesn't turn existing projects into new ones", async (t) => {
  const { instance, file } = importer(t, [project("old")]);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{}");
  const { workspaces, created } = fakeWorkspaces();
  await assert.rejects(instance.check(workspaces), /valid project list/);
  assert.deepEqual(created, []);
});

test("long imports continue after the RPC wait and concurrent requests join them", async (t) => {
  const projects = [project("a")];
  const { instance, workspaceDirs } = importer(t, projects);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const workspaces: Workspaces = {
    create: async ({ source }) => {
      await held;
      workspaceDirs.push(source.path);
    },
  };
  const first = instance.importProject(workspaces, projects[0]);
  assert.equal(instance.importProject(workspaces, projects[0]), first);
  assert.equal(await wait(first, 5), undefined);
  assert.equal((await instance.pending())[0].importing, true);
  release();
  assert.deepEqual(await first, ["/p/a/w1", "/p/a/w2"]);
  assert.equal(instance.isImporting("a"), false);
  assert.deepEqual(await instance.pending(), []);
});

test("another client adding a later worktree during import doesn't create a duplicate", async (t) => {
  const projects = [project("a")];
  const { instance, workspaceDirs } = importer(t, projects);
  const created: string[] = [];
  const workspaces: Workspaces = {
    create: async ({ source }) => {
      created.push(source.path);
      workspaceDirs.push("/p/a/w1", "/p/a/w2");
    },
  };
  assert.deepEqual(await instance.importProject(workspaces, projects[0]), ["/p/a/w1"]);
  assert.deepEqual(created, ["/p/a/w1"]);
});

test("stopping an import skips the rest of its worktrees and queued projects", async (t) => {
  const projects = [project("a"), project("b")];
  const { instance } = importer(t, projects);
  const created: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const workspaces: Workspaces = {
    create: async ({ source }) => {
      created.push(source.path);
      await held;
    },
  };
  const first = instance.importProject(workspaces, projects[0]);
  const second = instance.importProject(workspaces, projects[1]);
  await wait(first, 5);
  instance.stop();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(created, ["/p/a/w1"]);
});

test("a pending scan is shared across clients and invalidated changes get a new scan", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let scans = 0;
  const instance = new Importer({
    file: join(scratch(t), "known.json"),
    projects: async () => [project("a")],
    takenDirs: async () => [],
    missingWorktrees: async () => {
      scans++;
      await held;
      return [{ path: "/p/a/w1", branch: "main" }];
    },
  });
  const first = instance.pending();
  await wait(first, 5);
  instance.invalidate();
  const second = instance.pending();
  assert.equal(scans, 1);
  assert.equal(instance.scanning, true);
  release();
  assert.deepEqual(await first, await second);
  await instance.pending();
  assert.equal(scans, 2);
  await instance.pending();
  assert.equal(scans, 2);
});

test("an automatic import interrupted by reload remains new for the next plugin instance", async (t) => {
  const projects = [project("old")];
  const { instance, file } = importer(t, projects);
  await instance.check(undefined);
  projects.push(project("new"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const workspaces: Workspaces = { create: async () => held };
  const checking = instance.check(workspaces);
  await wait(checking, 10);
  instance.stop();
  release();
  await checking;
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old"] });
});
