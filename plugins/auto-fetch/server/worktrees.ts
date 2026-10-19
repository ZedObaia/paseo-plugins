import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "./git";

export const resolved = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

interface Worktree {
  path: string;
  bare: boolean;
  /** git knows it but its directory is gone. */
  prunable: boolean;
}

export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split("\n\n")
    .map((block) => block.split("\n").filter(Boolean))
    .filter((lines) => lines[0]?.startsWith("worktree "))
    .map((lines) => ({
      path: lines[0].slice("worktree ".length),
      bare: lines.includes("bare"),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    }));
}

/**
 * The repository's linked worktrees that no workspace has yet: not its main checkout, nor the
 * project's own directory, nor one whose directory is gone.
 */
export async function worktreesToAdd(root: string, workspaceDirs: string[]): Promise<string[]> {
  const [main, ...linked] = parseWorktrees(await git(root, ["worktree", "list", "--porcelain"]));
  const taken = new Set([root, ...workspaceDirs].map(resolved));
  if (main) taken.add(resolved(main.path));
  const paths: string[] = [];
  for (const worktree of linked) {
    if (worktree.bare || worktree.prunable || !existsSync(worktree.path)) continue;
    const path = resolved(worktree.path);
    if (taken.has(path)) continue;
    taken.add(path);
    paths.push(path);
  }
  return paths;
}
