import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { remoteBase } from "./base";

process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

function commit(cwd: string, message: string) {
  writeFileSync(join(cwd, `${message}.txt`), message);
  sh(cwd, "add", ".");
  sh(cwd, "commit", "-qm", message);
}

/** A clone on main, with a feature branch that tracks the remote and one that doesn't. */
function clone(t: TestContext, defaultBranch = "main") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auto-fetch-base-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  sh(root, "init", "-q", "--bare", "-b", defaultBranch, remote);
  const seed = join(root, "seed");
  sh(root, "clone", "-q", remote, seed);
  commit(seed, "first");
  sh(seed, "push", "-q", "origin", `HEAD:${defaultBranch}`, "HEAD:feature");
  const repo = join(root, "repo");
  sh(root, "clone", "-q", remote, repo);
  sh(repo, "branch", "-q", "feature", "origin/feature");
  sh(repo, "branch", "-q", "local-only");
  return { repo, seed };
}

test("a worktree from the default branch starts from its remote branch", async (t) => {
  const { repo, seed } = clone(t);
  assert.equal(await remoteBase(repo, undefined), "refs/remotes/origin/main");
  assert.equal(await remoteBase(repo, ""), "refs/remotes/origin/main");
  // behind it, even checked out: the remote branch is newer
  commit(seed, "theirs");
  sh(seed, "push", "-q", "origin", "HEAD:main");
  sh(repo, "fetch", "-q");
  assert.equal(await remoteBase(repo, "main"), "refs/remotes/origin/main");
  assert.equal(await remoteBase(repo, "refs/heads/main"), "refs/remotes/origin/main");
});

test("a local branch with commits of its own is kept", async (t) => {
  const { repo } = clone(t);
  commit(repo, "mine");
  assert.equal(await remoteBase(repo, "main"), null);
  assert.equal(await remoteBase(repo, undefined), null);
});

test("other branches start from what they track, and untracked ones stay", async (t) => {
  const { repo } = clone(t);
  assert.equal(await remoteBase(repo, "feature"), "refs/remotes/origin/feature");
  assert.equal(await remoteBase(repo, "local-only"), null);
  assert.equal(await remoteBase(repo, "missing"), null);
  assert.equal(await remoteBase(repo, "refs/tags/v1"), null);
});

test("without the remote's HEAD, the default is master when there's no main", async (t) => {
  const { repo } = clone(t, "master");
  sh(repo, "remote", "set-head", "origin", "--delete");
  assert.equal(await remoteBase(repo, undefined), "refs/remotes/origin/master");
});
