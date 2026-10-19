import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Moved } from "../shared/contracts";

export type FastForward = Omit<Moved, "at">;

interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** git's fatal and error lines, without the advice it prints after them. */
export function reason(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = lines.filter((line) => /^(fatal|error):/.test(line));
  return (errors.length ? errors.map((line) => line.replace(/^(fatal|error):\s*/, "")) : lines.slice(-2))
    .slice(0, 3)
    .map((line) => line.replace(/\.$/, ""))
    .join(". ");
}

/**
 * Runs git without a shell and resolves with its stdout. It never asks for credentials: a remote
 * that needs them fails instead, as Paseo's own fetch does. The C locale keeps output parseable.
 */
export function git(cwd: string, args: string[], { timeoutMs = 30_000, signal }: RunOptions = {}) {
  return new Promise<string>((done, fail) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout: timeoutMs,
        signal,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
      (error, stdout, stderr) => {
        if (!error) return done(stdout);
        if (error.killed && !signal?.aborted)
          return fail(new Error(`git ${args[0]} timed out after ${timeoutMs / 1000} s`));
        fail(
          Object.assign(new Error(reason(stderr || error.message) || `git ${args[0]} failed`), {
            code: error.code,
          }),
        );
      },
    );
  });
}

/** The git directory a checkout and all its worktrees share, which names the repository. */
export async function commonDir(dir: string): Promise<string> {
  const out = (await git(dir, ["rev-parse", "--git-common-dir"])).trim();
  const path = resolve(dir, out);
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** The main checkout, or the git directory itself when the repository is bare or the checkout is gone. */
export const mainPath = (gitDir: string) =>
  basename(gitDir) === ".git" && existsSync(dirname(gitDir)) ? dirname(gitDir) : gitDir;

const LOCKED = /cannot lock ref|unable to create '.*\.lock'|another git process/i;

/**
 * Fetches every remote and prunes branches they deleted. Paseo fetches origin every few minutes
 * while an app watches the repository, so the two can meet; a fetch that loses a ref lock to the
 * other tries once more.
 */
export async function fetchAll(gitDir: string, options: RunOptions = {}): Promise<void> {
  const args = ["fetch", "--all", "--prune", "--quiet"];
  try {
    await git(mainPath(gitDir), args, { timeoutMs: 120_000, ...options });
  } catch (error) {
    if (!(error instanceof Error) || !LOCKED.test(error.message) || options.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await git(mainPath(gitDir), args, { timeoutMs: 120_000, ...options });
  }
}

/**
 * Branches a worktree has checked out, or is rebasing: moving one of those would leave its
 * files out of step with it.
 */
export async function busyBranches(gitDir: string): Promise<Set<string>> {
  const busy = new Set<string>();
  const list = await git(gitDir, ["worktree", "list", "--porcelain"]);
  for (const line of list.split("\n")) if (line.startsWith("branch ")) busy.add(line.slice(7).trim());
  const linked = await readdir(join(gitDir, "worktrees")).catch(() => [] as string[]);
  for (const dir of [gitDir, ...linked.map((name) => join(gitDir, "worktrees", name))])
    for (const state of ["rebase-merge", "rebase-apply"]) {
      const head = await readFile(join(dir, state, "head-name"), "utf8").catch(() => "");
      if (head.trim().startsWith("refs/heads/")) busy.add(head.trim());
    }
  return busy;
}

const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

/**
 * Moves each local branch that is behind the remote branch it tracks and has nothing of its own
 * to where that remote branch is, like `git pull` would, without touching any checkout. Branches
 * a worktree has checked out, branches with commits of their own, and branches whose upstream is
 * gone stay where they are.
 */
export async function fastForward(gitDir: string): Promise<FastForward[]> {
  const format = "%(refname)%09%(objectname)%09%(upstream)%09%(upstream:track)";
  const [refs, busy] = await Promise.all([
    git(gitDir, ["for-each-ref", `--format=${format}`, "refs/heads"]),
    busyBranches(gitDir),
  ]);
  const moved: FastForward[] = [];
  for (const line of refs.split("\n")) {
    const [ref, from, upstream, track] = line.split("\t");
    const behind = /^\[behind (\d+)\]$/.exec(track ?? "");
    if (!behind || !upstream?.startsWith("refs/remotes/") || busy.has(ref)) continue;
    const to = (await git(gitDir, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`])).trim();
    // the track counts say so already; this is the check that matters
    const ancestor = await git(gitDir, ["merge-base", "--is-ancestor", from, to]).then(
      () => true,
      () => false,
    );
    if (!ancestor) continue;
    // fails, and leaves it, if the branch moved since it was read
    const message = `auto-fetch: fast-forward to ${short(upstream)}`;
    const updated = await git(gitDir, ["update-ref", "-m", message, ref, to, from]).then(
      () => true,
      () => false,
    );
    if (updated) moved.push({ branch: short(ref), upstream: short(upstream), commits: Number(behind[1]) });
  }
  return moved;
}
