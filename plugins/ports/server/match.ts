import { reach } from "./address";
import type { Listener } from "./processes";

export interface WorkspaceDirs {
  id: string;
  /** The workspace directory, and where it resolves to if that differs. */
  dirs: string[];
}

const trim = (dir: string) => (dir.length > 1 ? dir.replace(/\/+$/, "") : dir);
const within = (dir: string, root: string) =>
  dir === root || dir.startsWith(root === "/" ? root : `${root}/`);

/** The deepest workspaces holding a directory: several when they share that directory. */
function holders(dir: string, workspaces: readonly WorkspaceDirs[]): string[] {
  let depth = -1;
  let owners: string[] = [];
  for (const ws of workspaces) {
    const root = ws.dirs
      .map(trim)
      .filter((r) => within(dir, r))
      .sort((a, b) => b.length - a.length)[0];
    if (root === undefined || root.length < depth) continue;
    if (root.length > depth) owners = [];
    depth = root.length;
    owners.push(ws.id);
  }
  return owners;
}

/**
 * Ports by workspace. A listener goes to the workspace it runs in, else the one whose terminal
 * started it, else the workspace holding the first of its other directories. The deepest workspace
 * wins, so a dev server in a worktree belongs to that worktree even when another workspace is its
 * parent directory.
 */
export function assign(
  listeners: readonly Listener[],
  workspaces: readonly WorkspaceDirs[],
): Map<string, Listener[]> {
  const byWorkspace = new Map<string, Map<number, Listener>>();
  for (const listener of listeners) {
    const started = workspaces.some((ws) => ws.id === listener.workspaceId) ? [listener.workspaceId!] : [];
    const candidates = [
      () => (listener.cwd ? holders(listener.cwd, workspaces) : []),
      () => started,
      ...listener.dirs.map((dir) => () => holders(dir, workspaces)),
    ];
    for (const candidate of candidates) {
      const owners = candidate();
      if (!owners.length) continue;
      for (const id of owners) {
        const ports = byWorkspace.get(id) ?? new Map<number, Listener>();
        const kept = ports.get(listener.port);
        if (!kept || reach(listener.address) > reach(kept.address)) ports.set(listener.port, listener);
        byWorkspace.set(id, ports);
      }
      break;
    }
  }
  return new Map(
    [...byWorkspace].map(([id, ports]) => [id, [...ports.values()].sort((a, b) => a.port - b.port)]),
  );
}
