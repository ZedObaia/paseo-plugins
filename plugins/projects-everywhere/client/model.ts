/** A project as one host lists it. */
export interface HostProject {
  serverId: string;
  projectId: string;
  // "remote:github.com/owner/repo" for a git project with a remote
  key?: string;
  name: string;
  // absolute, on that host
  root: string;
}

/** What to add: a folder (absolute or under ~), and where to clone it from when it's missing. */
export interface Target {
  path: string;
  cloneUrl: string | null;
}

/** One project across hosts, and the hosts that have it. */
export interface ProjectRow extends Target {
  id: string;
  name: string;
  on: Map<string, HostProject>;
}

export const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path);

/**
 * "~/workspace/x" for a path in a home folder: macOS /Users/<user>, Linux /home/<user> or /root,
 * Windows C:\Users\<user>. Windows paths come back with forward slashes.
 */
export function homeRelative(path: string): string {
  const p = isWindowsPath(path) ? path.replace(/\\/g, "/") : path;
  return p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/, "~");
}

/**
 * The same project on every host: the same remote, or for a folder without one, the same place in
 * the home folder.
 */
export const identity = (p: Pick<HostProject, "key" | "root">) =>
  p.key?.startsWith("remote:") ? p.key : `path:${homeRelative(p.root)}`;

/** "remote:github.com/owner/repo" -> "https://github.com/owner/repo.git". */
export function cloneUrlOf(key: string | undefined): string | null {
  const match = /^remote:([a-z0-9.-]+\.[a-z]{2,})\/([\w.-]+(?:\/[\w.-]+)+)$/i.exec(key ?? "");
  return match ? `https://${match[1]}/${match[2].replace(/\.git$/, "")}.git` : null;
}

/**
 * The key Paseo gives a project cloned from this URL: "git@github.com:Owner/Repo.git" ->
 * "remote:github.com/owner/repo".
 */
export function remoteKeyOf(url: string): string | null {
  const match = /^(?:https:\/\/|ssh:\/\/(?:[^@/]+@)?|git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(url);
  return match ? `remote:${match[1]}/${match[2]}`.toLowerCase() : null;
}

export function projectRows(
  lists: readonly { serverId: string; projects: readonly HostProject[] }[],
): ProjectRow[] {
  const rows = new Map<string, ProjectRow>();
  for (const { serverId, projects } of lists) {
    for (const p of projects) {
      const id = identity(p);
      let row = rows.get(id);
      if (!row) {
        row = { id, name: p.name, path: homeRelative(p.root), cloneUrl: cloneUrlOf(p.key), on: new Map() };
        rows.set(id, row);
      }
      row.on.set(serverId, p);
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Remotes git can clone without running anything else: https and ssh. Its ext:: transport, for
// one, runs a command.
export const CLONEABLE = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/;
const FOLDER = /^(~|\/)[^\n]*$/;

/**
 * The add form's input: "owner/repo" (GitHub), a clone URL, or a folder that starts with ~ or /.
 * A repository is cloned into `parent`, in a folder named after it.
 */
export function parseTarget(input: string, parent: string): Target | null {
  const text = input.trim();
  const shorthand = /^([\w-]+)\/([\w.-]+?)(\.git)?$/.exec(text);
  const repo = shorthand
    ? `https://github.com/${shorthand[1]}/${shorthand[2]}.git`
    : CLONEABLE.test(text)
      ? text
      : null;
  if (repo) {
    const name = /([\w.-]+?)(\.git)?\/?$/.exec(repo)?.[1];
    return name && FOLDER.test(parent)
      ? { path: `${parent.replace(/\/+$/, "")}/${name}`, cloneUrl: repo }
      : null;
  }
  return FOLDER.test(text) ? { path: text.replace(/(.)\/+$/, "$1"), cloneUrl: null } : null;
}

export const CLONE_EXIT = /__PROJECTS_EVERYWHERE_EXIT_(\d+)__/;

// Runs as `sh -c SCRIPT sh <url> <folder>`, so neither value is parsed by a shell. Prompts are off,
// so a missing credential fails rather than waiting for input; only https and ssh transports are
// allowed. The terminal stays open once git exits until the plugin has read the result: Paseo
// drops a terminal's output when its command ends.
const SH_SCRIPT = [
  'dest=$2; case $dest in "~/"*) dest=$HOME/${dest#"~/"};; esac',
  'mkdir -p "$(dirname "$dest")" &&',
  '  GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https:ssh GIT_SSH_COMMAND="ssh -o BatchMode=yes" git clone -- "$1" "$dest"',
  'printf "\\n__PROJECTS_EVERYWHERE_EXIT_%s__\\n" "$?"',
  "exec sleep 600",
].join("\n");

// PowerShell has no way to pass arguments to an -EncodedCommand script, so the values go in as
// single-quoted literals, where only quote characters (including the curly ones) need doubling.
const psLiteral = (value: string) => `'${value.replace(/['‘-‛]/g, "$&$&")}'`;

// The same steps for Windows, which has no sh. git creates the missing parent folders itself;
// GCM_INTERACTIVE stops Git Credential Manager from opening a sign-in window.
const psScript = (url: string, path: string) =>
  [
    `$dest = ${psLiteral(path)}`,
    "if ($dest.StartsWith('~/')) { $dest = Join-Path $HOME $dest.Substring(2) }",
    "$env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'",
    "$env:GIT_ALLOW_PROTOCOL = 'https:ssh'; $env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'",
    `try { git clone -- ${psLiteral(url)} $dest; $code = $LASTEXITCODE } catch { "$_"; $code = 127 }`,
    '"`n__PROJECTS_EVERYWHERE_EXIT_${code}__"',
    "Start-Sleep 600",
  ].join("\n");

declare function btoa(data: string): string;

/** PowerShell's -EncodedCommand form of a script: base64 of its UTF-16LE text. */
function encodeCommand(script: string): string {
  let bytes = "";
  for (let i = 0; i < script.length; i++) {
    const unit = script.charCodeAt(i);
    bytes += String.fromCharCode(unit & 0xff, unit >> 8);
  }
  return btoa(bytes);
}

/** The terminal command that clones `url` into `path` and then prints git's exit code. */
export function cloneCommand(windows: boolean, url: string, path: string) {
  return windows
    ? {
        command: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(psScript(url, path))],
      }
    : { command: "sh", args: ["-c", SH_SCRIPT, "sh", url, path] };
}
