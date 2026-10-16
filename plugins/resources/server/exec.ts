import { execFile } from "node:child_process";

/**
 * Runs a binary without a shell and resolves with its stdout. Output is parsed, so the C locale
 * keeps numbers like "12.5" from turning into "12,5" under the user's own locale.
 */
export function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (error.killed)
          return reject(new Error(`${cmd} ${args[0] ?? ""} timed out after ${timeoutMs / 1000} s`));
        const detail = (stderr || error.message).trim().split("\n").slice(-2).join(" ");
        reject(new Error(detail || `${cmd} failed`));
      },
    );
  });
}

export function jsonLines<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

const UNITS: Record<string, number> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/** Docker's human sizes: "1.2GB", "23.4MiB", "0B". Unknown input is 0. */
export function parseSize(text: string | undefined): number {
  const match = /^([\d.]+)\s*([A-Za-z]+)?/.exec((text ?? "").trim());
  if (!match) return 0;
  return Math.round(Number(match[1]) * (UNITS[match[2] ?? "B"] ?? 1));
}
