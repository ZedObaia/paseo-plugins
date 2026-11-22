import { basename, join } from "node:path";

export type ShellKind = "bash" | "posix" | "fish";

const POSIX = new Set(["sh", "ash", "dash", "ksh", "mksh", "zsh"]);

/** Whether the variables can be handed to this shell, and how. */
export function shellKind(shell: string): ShellKind | null {
  const name = basename(shell);
  if (name === "bash") return "bash";
  if (POSIX.has(name)) return "posix";
  return name === "fish" ? "fish" : null;
}

export const posixQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const fishQuote = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** The file the shell reads as it starts: one line per variable. */
export function envScript(syntax: "posix" | "fish", env: Record<string, string>): string {
  const lines = Object.entries(env).map(([name, value]) =>
    syntax === "fish" ? `set -gx ${name} ${fishQuote(value)}` : `export ${name}=${posixQuote(value)}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * What gets typed: each line, as if pasted, then Enter. Typed in without Enter, a newline would
 * still run what's before it, so the lines become one, without blank lines and comments.
 */
export function typed(command: string, pressEnter: boolean): string {
  const lines = command.trim().split(/\r?\n/);
  if (pressEnter) return `${lines.join("\r")}\r`;
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("; ");
}

/**
 * Bash's startup file for a run: the variables, then what an interactive bash reads (`--rcfile`
 * replaces it), then the command, shown and put in history as if typed. Running it before the
 * first prompt keeps the terminal's name on its tab while it runs: a Debian or Ubuntu prompt sets
 * the title to `user@host: dir`. Ctrl+C stops it and leaves you at a prompt.
 */
export function bashStartup(command: string, envFile: string, tempDir: string): string {
  const text = command.trim();
  return [
    `. ${posixQuote(envFile)}`,
    `rm -rf ${posixQuote(tempDir)}`,
    "[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc",
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    `history -s -- ${posixQuote(text)}`,
    `printf '\\033[2m$ %s\\033[0m\\n' ${posixQuote(text)}`,
    text,
    "",
  ].join("\n");
}

export interface Launch {
  /** Written before the terminal starts, in the run's temporary folder. */
  files: { path: string; text: string }[];
  command: string;
  args: string[];
  /** Typed at the first prompt; null when the command runs as the shell starts. */
  type: string | null;
}

/**
 * The launcher's file name. Paseo labels a terminal's tab after what it started until the shell
 * sets a title, and for `bash <script>` that's the script's name, so the tab says the label.
 */
export function launcherName(label: string): string {
  const name = label.replaceAll("/", "∕");
  return name === "." || name === ".." ? `${name}_` : name;
}

/**
 * How the terminal starts: a launcher named after the command hands your shell the variables
 * through a file it reads and deletes, then becomes the interactive shell Paseo's own terminals
 * run. Paseo hands terminals no variables, and wrapping the shell in `env` would drop Paseo's zsh
 * integration and show the values in `ps`. Bash runs the command as it starts; other shells get it
 * typed at their first prompt, and zsh's tab then shows the command while it runs.
 */
export function launch(
  shell: string,
  kind: ShellKind,
  env: Record<string, string>,
  label: string,
  command: string,
  pressEnter: boolean,
  tempDir: string,
): Launch {
  const envFile = join(tempDir, "env");
  const type = typed(command, pressEnter);
  // fish isn't named after a script: its own prompt titles the tab at once
  if (kind === "fish")
    return {
      files: [{ path: envFile, text: envScript("fish", env) }],
      command: shell,
      args: ["-C", `source ${fishQuote(envFile)}; rm -rf ${fishQuote(tempDir)}`],
      type,
    };
  // in a folder of its own, so no label can be the name of another file
  const launcher = join(tempDir, "tab", launcherName(label));
  const files = [{ path: envFile, text: envScript("posix", env) }];
  if (kind === "bash" && pressEnter) {
    const rc = join(tempDir, "rc");
    files.push(
      { path: rc, text: bashStartup(command, envFile, tempDir) },
      { path: launcher, text: `exec ${posixQuote(shell)} --rcfile ${posixQuote(rc)} -i\n` },
    );
    return { files, command: shell, args: [launcher], type: null };
  }
  files.push({
    path: launcher,
    text: `. ${posixQuote(envFile)}; rm -rf ${posixQuote(tempDir)}; exec ${posixQuote(shell)} -i\n`,
  });
  return { files, command: shell, args: [launcher], type };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the shell's prompt, as you would before typing: until it has drawn something and
 * stopped changing. Typing earlier mostly works too, since the terminal keeps the input, but a
 * slow rc file can read or drop it. Gives up waiting after `timeoutMs` and returns false.
 */
export async function waitForPrompt(
  screen: () => Promise<string>,
  { timeoutMs = 5_000, stepMs = 100, steadyFor = 3 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let steady = 0;
  while (Date.now() < deadline) {
    await sleep(stepMs);
    const now = (await screen()).trimEnd();
    steady = now && now === last ? steady + 1 : 0;
    if (steady >= steadyFor) return true;
    last = now;
  }
  return false;
}
