import type { ProcessGroup, ProcessInfo, Snapshot } from "../shared/contracts";

export type GroupBy = "top" | "workspace" | "project";
export type SortBy = "cpu" | "memory";
export interface ProcessViewGroup {
  id: string;
  name: string;
  detail: string;
  cpuPct: number;
  memBytes: number;
  processes: ProcessInfo[];
}

export function processViewGroups(
  groups: ProcessGroup[],
  by: Exclude<GroupBy, "top">,
  sort: SortBy,
): ProcessViewGroup[] {
  const result = new Map<string, ProcessViewGroup>();
  for (const group of groups) {
    const workspaceKey = group.workspaceId ?? (group.projectId ? `project:${group.projectId}` : "unassigned");
    const projectKey = group.projectId ?? (group.workspaceId ? "unregistered-workspaces" : "unassigned");
    const id = by === "workspace" ? workspaceKey : projectKey;
    let view = result.get(id);
    if (!view) {
      view = {
        id,
        name: by === "workspace" ? group.workspaceName : group.projectName,
        detail: by === "workspace" && group.workspaceId && group.projectId ? group.projectName : "",
        cpuPct: 0,
        memBytes: 0,
        processes: [],
      };
      result.set(id, view);
    }
    view.cpuPct += group.cpuPct;
    view.memBytes += group.memBytes;
    view.processes.push(...group.processes);
  }
  const metric = (row: Pick<ProcessInfo, "cpuPct" | "memBytes">) =>
    sort === "cpu" ? row.cpuPct : row.memBytes;
  const views = [...result.values()];
  for (const view of views) view.processes.sort((a, b) => metric(b) - metric(a));
  return views.sort((a, b) => metric(b) - metric(a));
}

export function topProcesses(snapshot: Snapshot, sort: SortBy): ProcessInfo[] {
  return sort === "cpu" ? snapshot.topCpu : snapshot.topMemory;
}
