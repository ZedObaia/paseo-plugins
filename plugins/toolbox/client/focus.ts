import { useSyncExternalStore } from "react";

// The chat Toolbox was last opened from, per workspace: Command Center and /toolbox open the
// workspace's panel, and it shows that chat.
const preferred = new Map<string, string>();
const listeners = new Set<() => void>();

export function preferChat(workspaceId: string, agentId: string) {
  preferred.set(workspaceId, agentId);
  for (const listener of listeners) listener();
}

export function usePreferredChat(workspaceId: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => preferred.get(workspaceId) ?? null,
  );
}
