import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Moved } from "../shared/contracts";
import { deadline } from "./deadline";

export type FastForward = Omit<Moved, "at">;

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
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
export function git(cwd: string, args: string[], { timeoutMs = 30_000, signal, env }: RunOptions = {}) {
  return new Promise<string>((done, fail) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout: timeoutMs,
        signal,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          ...env,
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS_REQUIRE: "never",
          GCM_INTERACTIVE: "never",
        },
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
export async function commonDir(dir: string, options: RunOptions = {}): Promise<string> {
  const out = (await git(dir, ["rev-parse", "--git-common-dir"], options)).trim();
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
  const timeoutMs = options.timeoutMs ?? 120_000;
  const { signal, dispose } = deadline(timeoutMs, options.signal);
  const args = ["fetch", "--all", "--prune", "--quiet"];
  try {
    try {
      await git(mainPath(gitDir), args, { timeoutMs, signal });
    } catch (error) {
      if (!(error instanceof Error) || !LOCKED.test(error.message) || signal.aborted) throw error;
      await delay(3_000, undefined, { signal });
      await git(mainPath(gitDir), args, { timeoutMs, signal });
    }
  } finally {
    dispose();
  }
}

/**
 * Branches a worktree has checked out, or is rebasing: moving one of those would leave its
 * files out of step with it.
 */
export async function busyBranches(gitDir: string, options: RunOptions = {}): Promise<Set<string>> {
  const busy = new Set<string>();
  const list = await git(gitDir, ["worktree", "list", "--porcelain", "-z"], options);
  for (const line of list.split("\0")) if (line.startsWith("branch ")) busy.add(line.slice(7));
  const linked = await readdir(join(gitDir, "worktrees")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const dir of [gitDir, ...linked.map((name) => join(gitDir, "worktrees", name))])
    for (const state of ["rebase-merge", "rebase-apply"]) {
      const head = await readFile(join(dir, state, "head-name"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        },
      );
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
export async function fastForward(gitDir: string, options: RunOptions = {}): Promise<FastForward[]> {
  const format = "%(refname)%09%(objectname)%09%(upstream)%09%(upstream:track)%09%(symref)";
  const [refs, busy] = await Promise.all([
    git(gitDir, ["for-each-ref", `--format=${format}`, "refs/heads"], options),
    busyBranches(gitDir, options),
  ]);
  const moved: FastForward[] = [];
  for (const line of refs.split("\n")) {
    const [ref, from, upstream, track, symref] = line.split("\t");
    const behind = /^\[behind (\d+)\]$/.exec(track ?? "");
    if (!behind || symref || !upstream?.startsWith("refs/remotes/") || busy.has(ref)) continue;
    const to = await git(gitDir, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`], options)
      .then((out) => out.trim())
      .catch(() => "");
    if (!to || to === from) continue;
    // the track counts say so already; this is the check that matters
    const ancestor = await git(gitDir, ["merge-base", "--is-ancestor", from, to], options).then(
      () => true,
      () => false,
    );
    if (!ancestor) continue;
    // A local fetch lets git reject checked-out branches and concurrent non-fast-forward changes.
    const message = `auto-fetch: fast-forward to ${short(upstream)}`;
    const updated = await git(
      gitDir,
      [
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        gitDir,
        `${to}:${ref}`,
      ],
      { ...options, env: { ...options.env, GIT_REFLOG_ACTION: message } },
    ).then(
      () => true,
      () => false,
    );
    if (updated) moved.push({ branch: short(ref), upstream: short(upstream), commits: Number(behind[1]) });
  }
  return moved;
}
