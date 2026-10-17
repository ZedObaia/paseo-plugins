import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The first executable called `name` in PATH, then in `extra` (full paths), then Homebrew's and
 * /usr/local's bin directories, which a daemon started by the desktop app may not have in its
 * PATH. Falls back to the bare name, so running it fails with ENOENT when it's nowhere.
 */
export function findExecutable(name: string, extra: string[] = []): string {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    ...dirs.map((dir) => join(dir, name)),
    ...extra,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  return candidates.find(isExecutable) ?? name;
}

export const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
