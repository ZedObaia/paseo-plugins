import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { plainText } from "./parse";

/** An agent's CLI: on PATH, else where its installer puts it (`dirs`, under the home folder). */
export function findBin(name: string, dirs: string[]): string {
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    ...dirs.map((d) => path.join(os.homedir(), d)),
  ];
  for (const dir of candidates) {
    const file = path.join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  // execCommand still finds a Windows .cmd on PATH
  return name;
}

/** What a failed CLI said, rather than Node's "Command failed: …" with the whole command line. */
export function cliError(error: unknown): string {
  const e = error as { stdout?: string; stderr?: string; message?: string };
  const said = plainText(`${e.stderr ?? ""}\n${e.stdout ?? ""}`)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // `--json` commands report failure as one JSON line with a message
  for (const line of said) {
    try {
      const parsed = JSON.parse(line) as { message?: string; error?: string };
      if (parsed.message ?? parsed.error) return String(parsed.message ?? parsed.error);
    } catch {
      // not JSON
    }
  }
  return said.at(-1) ?? e.message ?? String(error);
}

/** Runs a CLI in the folder and returns what it printed; `missing` explains a CLI that isn't there. */
export async function run(bin: string, args: string[], cwd: string, missing: string, timeout = 60_000) {
  try {
    return (await execCommand(bin, args, { cwd, timeout, maxBuffer: 16 << 20 })).stdout;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new Error(missing);
    throw new Error(cliError(error));
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export const lastLine = (text: string) =>
  plainText(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);

/**
 * One look per key, shared for a minute unless someone asks to look again: an agent connects to
 * every server (starting local ones) to report them, which takes seconds. A failed look isn't kept.
 */
export function cache<T>() {
  const looks = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key: string, refresh: boolean, look: () => Promise<T>): Promise<T> {
      const cached = looks.get(key);
      if (cached && !refresh && Date.now() - cached.at < 60_000) return cached.value;
      const value = look();
      looks.set(key, { at: Date.now(), value });
      value.catch(() => looks.get(key)?.value === value && looks.delete(key));
      return value;
    },
    forget: (key: string) => void looks.delete(key),
  };
}
