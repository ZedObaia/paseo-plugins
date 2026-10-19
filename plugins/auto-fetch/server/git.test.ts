import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { busyBranches, commonDir, fastForward, fetchAll, mainPath, reason } from "./git";

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

/** Runs real git, with a controlled concurrent operation at a command boundary. */
function proxyGit(t: TestContext, root: string, body: string) {
  const executable = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const file = join(bin, "git");
  writeFileSync(
    file,
    `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const executable = ${JSON.stringify(executable)};
const args = process.argv.slice(2);
${body}
`,
  );
  chmodSync(file, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => (process.env.PATH = previous));
}

/**
 * A remote with main, ahead and diverged; a clone of it with a worktree; and a second clone that
 * pushes to the remote, like a teammate.
 */
function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auto-fetch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  sh(root, "init", "-q", "--bare", "-b", "main", remote);
  const other = join(root, "other");
  sh(root, "clone", "-q", remote, other);
  commit(other, "first");
  sh(other, "push", "-q", "origin", "main");
  for (const branch of ["behind", "diverged", "busy"]) sh(other, "push", "-q", "origin", `main:${branch}`);

  const repo = join(root, "repo");
  sh(root, "clone", "-q", remote, repo);
  for (const branch of ["behind", "diverged", "busy"]) sh(repo, "branch", "-q", branch, `origin/${branch}`);
  sh(repo, "branch", "-q", "local-only");
  const worktree = join(root, "worktree");
  sh(repo, "worktree", "add", "-q", worktree, "busy");
  // a commit of its own on diverged
  sh(repo, "checkout", "-q", "diverged");
  commit(repo, "mine");
  sh(repo, "checkout", "-q", "main");

  // the teammate moves every branch on
  for (const branch of ["main", "behind", "diverged", "busy"]) {
    sh(other, "checkout", "-q", "-B", branch, `origin/${branch}`);
    commit(other, `theirs-${branch}`);
    sh(other, "push", "-q", "origin", branch);
  }
  return { root, remote, repo, worktree, gitDir: join(repo, ".git") };
}

test("a checkout and its worktrees name the same repository", async (t) => {
  const { repo, worktree, gitDir } = setup(t);
  assert.equal(await commonDir(repo), gitDir);
  assert.equal(await commonDir(worktree), gitDir);
  mkdirSync(join(repo, "sub"));
  assert.equal(await commonDir(join(repo, "sub")), gitDir);
  assert.equal(mainPath(gitDir), repo);
  await assert.rejects(commonDir(tmpdir()));
});

test("fetching updates remote branches and prunes deleted ones", async (t) => {
  const { remote, repo, gitDir } = setup(t);
  sh(remote, "branch", "-q", "-D", "behind");
  const before = sh(repo, "rev-parse", "origin/main");
  await fetchAll(gitDir);
  assert.notEqual(sh(repo, "rev-parse", "origin/main"), before);
  assert.equal(sh(repo, "rev-parse", "origin/main"), sh(remote, "rev-parse", "main"));
  assert.throws(() => sh(repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/behind"));
});

test("fast-forwards only branches that are behind and checked out nowhere", async (t) => {
  const { remote, repo, worktree, gitDir } = setup(t);
  await fetchAll(gitDir);
  const diverged = sh(repo, "rev-parse", "diverged");
  const main = sh(repo, "rev-parse", "main");
  const busy = sh(repo, "rev-parse", "busy");
  const fetchHead = readFileSync(join(gitDir, "FETCH_HEAD"), "utf8");
  sh(repo, "symbolic-ref", "refs/heads/alias", "refs/heads/busy");
  sh(repo, "config", "branch.alias.remote", "origin");
  sh(repo, "config", "branch.alias.merge", "refs/heads/busy");

  const moved = await fastForward(gitDir);
  assert.deepEqual(moved, [{ branch: "behind", upstream: "origin/behind", commits: 1 }]);
  assert.equal(sh(repo, "rev-parse", "behind"), sh(remote, "rev-parse", "behind"));
  // checked out in the main checkout, and in a worktree
  assert.equal(sh(repo, "rev-parse", "main"), main);
  assert.equal(sh(repo, "rev-parse", "busy"), busy);
  assert.equal(sh(repo, "symbolic-ref", "refs/heads/alias"), "refs/heads/busy");
  assert.equal(readFileSync(join(gitDir, "FETCH_HEAD"), "utf8"), fetchHead);
  assert.equal(sh(worktree, "status", "--porcelain"), "");
  // has a commit of its own
  assert.equal(sh(repo, "rev-parse", "diverged"), diverged);
  assert.match(sh(repo, "reflog", "-1", "behind"), /auto-fetch: fast-forward to origin\/behind/);
  assert.deepEqual(await fastForward(gitDir), []);
});

test("a branch a worktree is rebasing counts as checked out", async (t) => {
  const { repo, gitDir } = setup(t);
  await fetchAll(gitDir);
  const [name] = sh(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .slice(1)
    .map((l) => l.split("/").pop());
  const state = join(gitDir, "worktrees", name!, "rebase-merge");
  mkdirSync(state);
  writeFileSync(join(state, "head-name"), "refs/heads/behind\n");
  assert.ok((await busyBranches(gitDir)).has("refs/heads/behind"));
  const before = sh(repo, "rev-parse", "behind");
  assert.deepEqual(await fastForward(gitDir), []);
  assert.equal(sh(repo, "rev-parse", "behind"), before);
});

test("a branch checked out after discovery is left alone", async (t) => {
  const { root, repo, gitDir } = setup(t);
  await fetchAll(gitDir);
  const before = sh(repo, "rev-parse", "behind");
  proxyGit(
    t,
    root,
    `if (args[2] === "fetch" && args.includes("--no-write-fetch-head"))
  spawnSync(executable, ["-C", ${JSON.stringify(repo)}, "checkout", "-q", "behind"]);
const result = spawnSync(executable, args, { stdio: "inherit" });
process.exit(result.status ?? 1);`,
  );
  assert.deepEqual(await fastForward(gitDir), []);
  assert.equal(sh(repo, "rev-parse", "behind"), before);
  assert.equal(sh(repo, "status", "--porcelain"), "");
});

test("a concurrent branch change with its own commits is never overwritten", async (t) => {
  const { root, repo, gitDir } = setup(t);
  await fetchAll(gitDir);
  const changed = sh(repo, "rev-parse", "diverged");
  proxyGit(
    t,
    root,
    `if (args[2] === "fetch" && args.includes("--no-write-fetch-head"))
  spawnSync(executable, ["-C", ${JSON.stringify(repo)}, "update-ref", "refs/heads/behind", ${JSON.stringify(changed)}]);
const result = spawnSync(executable, args, { stdio: "inherit" });
process.exit(result.status ?? 1);`,
  );
  assert.deepEqual(await fastForward(gitDir), []);
  assert.equal(sh(repo, "rev-parse", "behind"), changed);
});

test("unreadable rebase metadata prevents fast-forwarding", async (t) => {
  const { repo, gitDir } = setup(t);
  await fetchAll(gitDir);
  const before = sh(repo, "rev-parse", "behind");
  mkdirSync(join(gitDir, "rebase-merge", "head-name"), { recursive: true });
  await assert.rejects(fastForward(gitDir), /EISDIR/);
  assert.equal(sh(repo, "rev-parse", "behind"), before);
});

test("stopping during the ref-lock retry cancels its delay", async (t) => {
  const { root, gitDir } = setup(t);
  proxyGit(t, root, 'process.stderr.write("fatal: cannot lock ref\\n"); process.exit(1);');
  const stopped = new AbortController();
  const running = fetchAll(gitDir, { signal: stopped.signal });
  const timer = setTimeout(() => stopped.abort(), 100);
  t.after(() => clearTimeout(timer));
  await assert.rejects(running, /abort/i);
});

test("the ref-lock retry shares the fetch's timeout budget", async (t) => {
  const { root, gitDir } = setup(t);
  proxyGit(t, root, 'process.stderr.write("fatal: cannot lock ref\\n"); process.exit(1);');
  await assert.rejects(fetchAll(gitDir, { timeoutMs: 100 }), /abort/i);
});

test("a remote that can't be reached fails with git's reason", async (t) => {
  const { repo, gitDir } = setup(t);
  sh(repo, "remote", "set-url", "origin", join(tmpdir(), "auto-fetch-missing.git"));
  await assert.rejects(
    fetchAll(gitDir),
    /does not appear to be a git repository|unable to fetch|Could not read/i,
  );
});

test("a remote needing credentials never launches the configured askpass program", async (t) => {
  const { root, repo, gitDir } = setup(t);
  const marker = join(root, "prompted");
  const askpass = join(root, "askpass");
  writeFileSync(
    askpass,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "prompted");`,
  );
  chmodSync(askpass, 0o755);
  sh(repo, "config", "core.askPass", askpass);
  const previous = process.env.GIT_ASKPASS;
  process.env.GIT_ASKPASS = askpass;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_ASKPASS;
    else process.env.GIT_ASKPASS = previous;
  });
  const server = createServer((_, response) => {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
    response.end();
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  sh(repo, "remote", "set-url", "origin", `http://127.0.0.1:${address.port}/repo.git`);
  await assert.rejects(fetchAll(gitDir), /could not read|terminal prompts disabled/i);
  assert.equal(existsSync(marker), false);
});

test("git's reason leaves out its advice", () => {
  const stderr = [
    "fatal: '/tmp/x.git' does not appear to be a git repository",
    "fatal: Could not read from remote repository.",
    "",
    "Please make sure you have the correct access rights",
    "and the repository exists.",
    "error: could not fetch origin",
  ].join("\n");
  assert.equal(
    reason(stderr),
    "'/tmp/x.git' does not appear to be a git repository. Could not read from remote repository. could not fetch origin",
  );
  assert.equal(reason("something odd\nhappened\n"), "something odd. happened");
});
