import { git, type RunOptions } from "./git";

const quietly = (dir: string, args: string[], options: RunOptions) =>
  git(dir, args, options).then(
    (out) => out.trim(),
    () => "",
  );

/** The branch Paseo branches from when nobody picks one: the remote's default, else main or master. */
async function defaultBranch(dir: string, options: RunOptions): Promise<string | null> {
  const head = await quietly(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], options);
  if (head.startsWith("refs/remotes/origin/")) return head.slice("refs/remotes/origin/".length);
  for (const name of ["main", "master"])
    if (await quietly(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], options)) return name;
  return null;
}

/**
 * The remote branch a new worktree should start from instead of the local branch `name` (the
 * default branch when it's empty): the branch it tracks, unless the local one has commits of its
 * own. Null keeps the request as it is: no such local branch, no upstream, or local work.
 */
export async function remoteBase(
  dir: string,
  name: string | undefined,
  options: RunOptions = {},
): Promise<string | null> {
  const branch = name?.trim().replace(/^refs\/heads\//, "") || (await defaultBranch(dir, options));
  if (!branch || branch.startsWith("refs/")) return null;
  const local = `refs/heads/${branch}`;
  const upstream = await quietly(dir, ["for-each-ref", "--format=%(upstream)", local], options);
  if (!upstream.startsWith("refs/remotes/")) return null;
  // commits the remote branch doesn't have, as far as the last fetch knows
  const own = await quietly(dir, ["rev-list", "--count", `${upstream}..${local}`], options);
  return own === "0" ? upstream : null;
}
