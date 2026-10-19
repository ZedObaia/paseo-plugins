import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Importer, type Workspaces } from "./importer";
import type { Project } from "./registry";
import { parseWorktrees, worktreesToAdd } from "./worktrees";

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
  ].join("\n");
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: "/r", bare: true, prunable: false },
    { path: "/r/a", bare: false, prunable: false },
    { path: "/r/b", bare: false, prunable: true },
  ]);
});

test("lists linked worktrees without a workspace, never the main checkout", async (t) => {
  const { main, one, two } = repo(t);
  assert.deepEqual(await worktreesToAdd(main, []), [one, two]);
  assert.deepEqual(await worktreesToAdd(main, [one, "/elsewhere"]), [two]);
  // a project made from a linked worktree: the others, and not itself
  assert.deepEqual(await worktreesToAdd(one, []), [two]);
});

function fakeWorkspaces() {
  const created: { path: string; projectId: string; idempotencyKey: string }[] = [];
  const workspaces: Workspaces = {
    create: async ({ source, idempotencyKey }) => {
      created.push({ path: source.path, projectId: source.projectId, idempotencyKey });
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
    workspaceDirs: async () => workspaceDirs,
    worktreesToAdd: async (root, taken) => [`${root}/w1`, `${root}/w2`].filter((p) => !taken.includes(p)),
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
    created.map((c) => [c.path, c.projectId, c.idempotencyKey]),
    [
      ["/p/new/w1", "new", "auto-fetch:new:/p/new/w1"],
      ["/p/new/w2", "new", "auto-fetch:new:/p/new/w2"],
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

test("a project whose worktrees can't be listed is still marked seen", async (t) => {
  const file = join(scratch(t), "projects.json");
  const projects = [project("old")];
  const instance = new Importer({
    projects: async () => projects,
    workspaceDirs: async () => [],
    worktreesToAdd: async () => {
      throw new Error("not a git repository");
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
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { known: ["old", "broken"] });
});
