import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { git, type RunOptions } from "./git";

export const resolved = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

interface Worktree {
  path: string;
  /** Its branch's short name; null when detached. */
  branch: string | null;
  bare: boolean;
  /** git knows it but its directory is gone. */
  prunable: boolean;
}

export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split("\0\0")
    .map((block) => block.split("\0").filter(Boolean))
    .filter((lines) => lines[0]?.startsWith("worktree "))
    .map((lines) => ({
      path: lines[0].slice("worktree ".length),
      branch:
        lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ??
        null,
      bare: lines.includes("bare"),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    }));
}

export type Missing = { path: string; branch: string | null };

/**
 * The repository's linked worktrees whose directories aren't `taken`: not its main checkout, nor
 * the project's own directory, nor one whose directory is gone.
 */
export async function missingWorktrees(
  root: string,
  taken: string[],
  options: RunOptions = {},
): Promise<Missing[]> {
  const [main, ...linked] = parseWorktrees(
    await git(root, ["worktree", "list", "--porcelain", "-z"], options),
  );
  const seen = new Set([root, ...taken].map(resolved));
  if (main) seen.add(resolved(main.path));
  const missing: Missing[] = [];
  for (const worktree of linked) {
    if (worktree.bare || worktree.prunable || !existsSync(worktree.path)) continue;
    const path = resolved(worktree.path);
    if (seen.has(path)) continue;
    seen.add(path);
    missing.push({ path, branch: worktree.branch });
  }
  return missing;
}
