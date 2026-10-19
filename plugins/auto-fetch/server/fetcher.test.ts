import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Fetcher, type Git } from "./fetcher";
import type { FastForward } from "./git";
import { workspaceDirectories } from "./registry";

const MIN = 60_000;

/** Repositories are the first path segment: /a/x and /a/y are both in /a. */
function fakeGit() {
  const fetched: string[] = [];
  const failing = new Set<string>();
  const moves = new Map<string, FastForward[]>();
  let hold: Promise<void> | undefined;
  const git: Git = {
    commonDir: async (dir) => {
      if (dir.startsWith("/none")) throw new Error("not a git repository");
      return `/${dir.split("/")[1]}`;
    },
    mainPath: (gitDir) => `${gitDir}/checkout`,
    fetchAll: async (gitDir) => {
      fetched.push(gitDir);
      await hold;
      if (failing.has(gitDir)) throw new Error(`fatal: could not read from ${gitDir}`);
    },
    fastForward: async (gitDir) => moves.get(gitDir) ?? [],
  };
  return {
    git,
    fetched,
    failing,
    moves,
    holdUntil: (p: Promise<void>) => (hold = p),
  };
}

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("fetches each repository once for all its workspaces, then on schedule", async () => {
  const { git, fetched } = fakeGit();
  const time = clock();
  const fetcher = new Fetcher(git, async () => ["/a/x", "/a/x", "/a/y", "/b/z", "/none/dir"], time.now);
  await fetcher.tick();
  assert.deepEqual(fetched, ["/a", "/b"]);
  const status = fetcher.status();
  assert.deepEqual(
    status.repos.map((r) => [r.id, r.workspaces, r.lastFetchedAt, r.nextFetchAt]),
    [
      ["/a", 3, time.now(), time.now() + 5 * MIN],
      ["/b", 1, time.now(), time.now() + 5 * MIN],
    ],
  );
  time.advance(4 * MIN);
  await fetcher.tick();
  assert.equal(fetched.length, 2);
  time.advance(MIN);
  await fetcher.tick();
  assert.deepEqual(fetched, ["/a", "/b", "/a", "/b"]);
});

test("a failing repository is fetched less often, up to an hour apart, and recovers", async () => {
  const { git, fetched, failing } = fakeGit();
  const time = clock();
  const fetcher = new Fetcher(git, async () => ["/a/x"], time.now);
  failing.add("/a");
  const gaps: number[] = [];
  let last = time.now();
  for (let i = 0; i < 24 * 60; i++) {
    const before = fetched.length;
    await fetcher.tick();
    if (fetched.length > before && i > 0) {
      gaps.push((time.now() - last) / MIN);
      last = time.now();
    }
    time.advance(MIN);
  }
  assert.deepEqual(gaps.slice(0, 6), [10, 20, 40, 60, 60, 60]);
  assert.match(fetcher.status().repos[0].error ?? "", /could not read/);
  failing.clear();
  await fetcher.fetchNow({ repo: "/a" }, 1_000);
  assert.equal(fetcher.status().repos[0].error, null);
  assert.equal(fetcher.status().repos[0].nextFetchAt, time.now() + 5 * MIN);
});

test("keeps the branches it moved for a day, newest first", async () => {
  const { git, moves } = fakeGit();
  const time = clock();
  const fetcher = new Fetcher(git, async () => ["/a/x"], time.now);
  moves.set("/a", [{ branch: "main", upstream: "origin/main", commits: 2 }]);
  await fetcher.tick();
  time.advance(10 * MIN);
  moves.set("/a", [{ branch: "dev", upstream: "origin/dev", commits: 1 }]);
  await fetcher.fetchNow({ repo: "/a" }, 1_000);
  assert.deepEqual(
    fetcher.status().repos[0].moved.map((m) => m.branch),
    ["dev", "main"],
  );
  moves.delete("/a");
  time.advance(24 * 60 * MIN);
  assert.deepEqual(fetcher.status().repos[0].moved, []);
  await fetcher.fetchNow({ repo: "/a" }, 1_000);
  assert.deepEqual(fetcher.status().repos[0].moved, []);
});

test("manual fetches and worktree preparation share the timer's queue", async () => {
  const { git, fetched, holdUntil } = fakeGit();
  const fetcher = new Fetcher(git, async () => ["/a/x", "/b/y"]);
  let release!: () => void;
  holdUntil(new Promise((resolve) => (release = resolve)));
  const tick = fetcher.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await fetcher.fetchNow({ directory: "/b/y" }, 5);
  await fetcher.fresh("/b/y", MIN, 5);
  assert.deepEqual(fetched, ["/a"]);
  assert.equal(fetcher.status().repos.find((r) => r.id === "/b")?.fetching, true);
  release();
  await tick;
  assert.deepEqual(fetched, ["/a", "/b"]);
});

test("a failed fetch releases the queue for other repositories", async () => {
  const { git, fetched, failing } = fakeGit();
  failing.add("/a");
  const fetcher = new Fetcher(git, async () => ["/a/x", "/b/y"]);
  await fetcher.tick();
  assert.deepEqual(fetched, ["/a", "/b"]);
  assert.equal(fetcher.status().repos[1].error, null);
});

test("stopping skips queued fetches and fast-forwards after a running fetch", async () => {
  const { git, fetched, holdUntil } = fakeGit();
  let forwards = 0;
  git.fastForward = async () => (forwards++, []);
  const fetcher = new Fetcher(git, async () => ["/a/x", "/b/y"]);
  let release!: () => void;
  holdUntil(new Promise((resolve) => (release = resolve)));
  const tick = fetcher.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await fetcher.fetchNow({ directory: "/b/y" }, 5);
  fetcher.stop();
  release();
  await tick;
  await fetcher.fetchNow({ directory: "/c/z" }, 5);
  assert.deepEqual(fetched, ["/a"]);
  assert.equal(forwards, 0);
});

test("directory lookup is included in the wait budget", async () => {
  const { git, fetched } = fakeGit();
  let release!: (dir: string) => void;
  const lookup = new Promise<string>((resolve) => (release = resolve));
  git.commonDir = async () => lookup;
  const fetcher = new Fetcher(git, async () => []);
  await fetcher.fresh("/a/x", MIN, 5);
  await fetcher.fetchNow({ directory: "/a/x" }, 5);
  assert.deepEqual(fetched, []);
  release("/a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetched, ["/a"]);
});

test("a directory reused by another repository is resolved again", async () => {
  const { git, fetched } = fakeGit();
  let id = "/a";
  git.commonDir = async () => id;
  const fetcher = new Fetcher(git, async () => ["/checkout"]);
  await fetcher.tick();
  id = "/b";
  await fetcher.tick();
  assert.deepEqual(fetched, ["/a", "/b"]);
  assert.deepEqual(
    fetcher.status().repos.map((r) => r.id),
    ["/b"],
  );
});

test("fetching now joins a running fetch, and says so when it outlasts the wait", async () => {
  const { git, fetched, holdUntil, failing } = fakeGit();
  const fetcher = new Fetcher(git, async () => ["/a/x"]);
  let release!: () => void;
  holdUntil(new Promise((resolve) => (release = resolve)));
  const tick = fetcher.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await fetcher.fetchNow({ directory: "/a/x" }, 10);
  assert.equal(fetcher.status().repos[0].fetching, true);
  assert.deepEqual(fetched, ["/a"]);
  failing.add("/a");
  release();
  await tick;
  await assert.rejects(fetcher.fetchNow({ repo: "/a" }, 1_000), /could not read/);
  await assert.rejects(fetcher.fetchNow({ repo: "/gone" }, 1_000), /no workspaces/);
});

test("fetching every repository now fetches those that aren't due", async () => {
  const { git, fetched } = fakeGit();
  const fetcher = new Fetcher(git, async () => ["/a/x", "/b/y"]);
  await fetcher.tick();
  await fetcher.fetchNow({}, 1_000);
  assert.equal(
    fetcher.status().repos.every((r) => r.fetching),
    true,
  );
  await fetcher.tick();
  assert.deepEqual(fetched, ["/a", "/b", "/a", "/b"]);
  assert.equal(
    fetcher.status().repos.some((r) => r.fetching),
    false,
  );
});

test("fetching all joins a repository already being fetched", async () => {
  const { git, fetched, holdUntil } = fakeGit();
  const fetcher = new Fetcher(git, async () => ["/a/x"]);
  let release!: () => void;
  holdUntil(new Promise((resolve) => (release = resolve)));
  const tick = fetcher.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await fetcher.fetchNow({}, 5);
  release();
  await tick;
  assert.deepEqual(fetched, ["/a"]);
});

test("a fresh repository isn't fetched again before a new worktree", async () => {
  const { git, fetched } = fakeGit();
  const time = clock();
  const fetcher = new Fetcher(git, async () => ["/a/x"], time.now);
  await fetcher.fresh("/a/x", MIN, 1_000);
  await fetcher.fresh("/a/y", MIN, 1_000);
  assert.deepEqual(fetched, ["/a"]);
  time.advance(2 * MIN);
  await fetcher.fresh("/a/x", MIN, 1_000);
  await fetcher.fresh("/none/x", MIN, 1_000);
  assert.deepEqual(fetched, ["/a", "/a"]);
});

test("a repository whose workspaces are all archived drops off the list", async () => {
  const { git } = fakeGit();
  let dirs = ["/a/x", "/b/y"];
  const fetcher = new Fetcher(git, async () => dirs);
  await fetcher.tick();
  dirs = ["/b/y"];
  await fetcher.tick();
  assert.deepEqual(
    fetcher.status().repos.map((r) => r.id),
    ["/b"],
  );
});

test("reads active git workspaces from Paseo's registry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "auto-fetch-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "workspaces.json");
  writeFileSync(
    file,
    JSON.stringify([
      { cwd: "/w/tree", kind: "worktree", archivedAt: null, branch: "x" },
      { cwd: "/w/main", kind: "local_checkout", archivedAt: null },
      { cwd: "/w/old", kind: "worktree", archivedAt: "2026-10-16T17:36:11.483Z" },
      { cwd: "/w/notes", kind: "directory", archivedAt: null },
      { kind: "worktree" },
    ]),
  );
  assert.deepEqual(await workspaceDirectories(file), ["/w/tree", "/w/main"]);
  writeFileSync(file, "{}");
  await assert.rejects(workspaceDirectories(file), /isn't a list/);
  assert.deepEqual(await workspaceDirectories(join(dir, "missing.json")), []);
});
