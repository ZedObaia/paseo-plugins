import { useHosts } from "@getpaseo/plugin/client";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { addProject, listProjects, message } from "./hosts";
import {
  homeRelative,
  identity,
  projectRows,
  remoteKeyOf,
  type HostProject,
  type ProjectRow,
  type Target,
} from "./model";

const projectsKey = (serverId: string) => ["projects-everywhere", serverId];

/**
 * The projects of every online host. A host whose list failed is in `errors`, not in `lists`, so
 * none of its projects count as missing.
 */
export function useHostProjects() {
  const hosts = useHosts();
  const online = hosts.filter((h) => h.status === "online");
  const results = useQueries({
    queries: online.map((h) => ({
      queryKey: projectsKey(h.serverId),
      queryFn: () => listProjects(h.serverId),
      refetchInterval: 15_000,
    })),
  });
  const lists: { serverId: string; projects: HostProject[] }[] = [];
  const errors: { label: string; text: string }[] = [];
  online.forEach((h, i) => {
    const { data, error } = results[i];
    if (data) lists.push({ serverId: h.serverId, projects: data });
    else if (error) errors.push({ label: h.label, text: message(error) });
  });
  return {
    hosts,
    online,
    lists,
    errors,
    rows: projectRows(lists),
    loading: results.some((r) => r.isLoading),
  };
}

export type Job = { state: "working" | "done" | "failed"; text: string };

// Projects added from this plugin: the new-project prompt doesn't ask about them again.
export const handled = new Set<string>();
export const handledKeys = (target: Target) => [
  `path:${homeRelative(target.path)}`,
  ...(target.cloneUrl ? [remoteKeyOf(target.cloneUrl) ?? ""] : []),
];

/** Adds projects to hosts, tracking each project-and-host pair's progress. */
export function useAdd() {
  const queryClient = useQueryClient();
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const set = (key: string, job: Job) => setJobs((all) => ({ ...all, [key]: job }));
  async function add(rowId: string, target: Target, serverId: string) {
    const key = `${rowId}|${serverId}`;
    for (const k of handledKeys(target)) handled.add(k);
    set(key, { state: "working", text: "Adding…" });
    try {
      const result = await addProject(serverId, target, (text) => set(key, { state: "working", text }));
      set(key, { state: "done", text: result === "cloned" ? "Cloned and added" : "Added" });
    } catch (error) {
      set(key, { state: "failed", text: message(error) });
    } finally {
      await queryClient.invalidateQueries({ queryKey: projectsKey(serverId) });
    }
  }
  return { add, job: (rowId: string, serverId: string): Job | undefined => jobs[`${rowId}|${serverId}`] };
}

/**
 * A project that just appeared on one host (added with Paseo's own Add project, say) and is missing
 * on another: the sidebar asks whether to add it there too. Each host's first list is the baseline,
 * and each project is asked about once.
 */
export function useNewProject({ lists, rows }: Pick<ReturnType<typeof useHostProjects>, "lists" | "rows">) {
  const seen = useRef(new Map<string, Set<string>>());
  const [fresh, setFresh] = useState<{ row: ProjectRow; from: string } | null>(null);
  const signature = lists
    .map((l) => `${l.serverId}:${l.projects.map((p) => p.projectId).join(",")}`)
    .join("|");
  useEffect(() => {
    for (const { serverId, projects } of lists) {
      const before = seen.current.get(serverId);
      seen.current.set(serverId, new Set(projects.map(identity)));
      if (!before) continue;
      for (const p of projects) {
        const id = identity(p);
        if (before.has(id) || handled.has(id) || handled.has(`path:${homeRelative(p.root)}`)) continue;
        handled.add(id);
        const row = rows.find((r) => r.id === id);
        if (row && lists.some((l) => !row.on.has(l.serverId))) setFresh({ row, from: serverId });
      }
    }
    // lists is a new array on every render; its content is what the signature tracks
  }, [signature]);
  return { fresh, dismiss: () => setFresh(null) };
}
