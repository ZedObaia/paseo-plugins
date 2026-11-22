import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";

const git = (cwd: string, args: string[]) =>
  execCommand("git", args, { cwd, timeout: 10_000 }).then(
    (r) => r.stdout.trim(),
    () => null,
  );

/** Whether the repository shares this file (relative to the folder): then it's the team's. */
export const sharedInGit = async (cwd: string, file: string) =>
  (await git(cwd, ["ls-files", "--error-unmatch", file])) !== null;

/** Keeps a folder's file out of git, in the repository's own ignore list for this checkout. */
export async function keepOutOfGit(cwd: string, file: string, why: string): Promise<void> {
  const exclude = await git(cwd, ["rev-parse", "--git-path", "info/exclude"]);
  if (exclude === null) return;
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])) ?? "";
  const line = `/${prefix}${file}`;
  const list = path.resolve(cwd, exclude);
  const text = await readFile(list, "utf8").catch(() => "");
  if (text.split("\n").includes(line)) return;
  await mkdir(path.dirname(list), { recursive: true });
  await writeFile(list, `${text}${text && !text.endsWith("\n") ? "\n" : ""}# Toolbox: ${why}\n${line}\n`);
}
