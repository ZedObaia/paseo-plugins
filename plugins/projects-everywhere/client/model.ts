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

/** "~/workspace/x" for a path in a home folder: macOS /Users/<user>, Linux /home/<user> or /root. */
export const homeRelative = (path: string) =>
  path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, "~");

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
