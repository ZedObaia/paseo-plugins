import { execFile } from "node:child_process";

/** Runs a binary without a shell; rejects with the tail of stderr. */
export function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const detail = (stderr || error.message).trim().split("\n").slice(-2).join(" ");
      reject(new Error(detail || `${cmd} failed`));
    });
  });
}

/** Same, but keeps stdout as bytes (screenshots). */
export function runBuffer(cmd: string, args: string[], timeoutMs = 15_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.toString().trim() || error.message));
        else resolve(stdout);
      },
    );
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until check() is truthy or the deadline passes. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
