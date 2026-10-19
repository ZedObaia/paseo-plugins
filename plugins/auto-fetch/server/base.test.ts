import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { remoteBase } from "./base";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { prepareWorktree } from "./prepare";

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

test("a before hook uses the saved settings and preserves checkout requests", async (t) => {
  const { repo } = clone(t);
  const context = { signal: new AbortController().signal } as PluginHookContext;
  let fromRemote = true;
  const ready = Promise.resolve().then(() => (fromRemote = false));
  let fetches = 0;
  const fetcher = { fresh: async () => void fetches++ };
  const request = { source: { kind: "worktree" as const, cwd: repo, refName: "main" } };
  assert.equal(await prepareWorktree(request, context, ready, () => fromRemote, fetcher), undefined);
  assert.equal(fetches, 1);
  fromRemote = true;
  const remoteRequest = { source: { ...request.source, cwd: `~/${relative(homedir(), repo)}` } };
  assert.deepEqual(await prepareWorktree(remoteRequest, context, ready, () => fromRemote, fetcher), {
    source: { ...remoteRequest.source, refName: "refs/remotes/origin/main" },
  });
  const checkout = { source: { ...request.source, action: "checkout" as const } };
  assert.equal(await prepareWorktree(checkout, context, ready, () => fromRemote, fetcher), undefined);
  assert.equal(fetches, 2);
});

test("a before hook's budget covers settings and project lookup", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  let lookups = 0;
  const context = {
    signal: new AbortController().signal,
    paseo: { projects: { list: async () => (lookups++, new Promise(() => {})) } },
  } as unknown as PluginHookContext;
  const request = { source: { kind: "worktree" as const, projectId: "p" } };
  const fetcher = { fresh: async () => assert.fail("preparation expired") };
  assert.equal(await prepareWorktree(request, context, ready, () => true, fetcher, 10), undefined);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups, 0);
  assert.equal(
    await prepareWorktree(request, context, Promise.resolve(), () => true, fetcher, 10),
    undefined,
  );
  assert.equal(lookups, 1);
});

test("without the remote's HEAD, the default is master when there's no main", async (t) => {
  const { repo } = clone(t, "master");
  sh(repo, "remote", "set-head", "origin", "--delete");
  assert.equal(await remoteBase(repo, undefined), "refs/remotes/origin/master");
});
