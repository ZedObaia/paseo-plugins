import { execFile } from "node:child_process";

/**
 * Runs a binary without a shell and resolves with its stdout. Output is parsed, so the C locale
 * keeps it free of the user's own formatting. lsof and ps exit 1 when one of several pids has
 * nothing to report: with `partial`, that still resolves with what they printed.
 */
export function run(cmd: string, args: string[], timeoutMs = 10_000, partial = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout, stderr) => {
        if (!error || (partial && error.code === 1)) return resolve(stdout);
        if (error.killed)
          return reject(new Error(`${cmd} ${args[0] ?? ""} timed out after ${timeoutMs / 1000} s`));
        const detail = (stderr || error.message).trim().split("\n").slice(-2).join(" ");
        reject(new Error(detail || `${cmd} failed`));
      },
    );
  });
}
