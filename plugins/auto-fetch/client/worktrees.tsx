import { useRpc, type PluginPopoverProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { importWorktreesRpc, pendingWorktreesRpc, type Pending } from "../shared/contracts";
import { errorMessage } from "./errors";

// The app shares one query cache between its plugins and hosts: keys start with the host.
const queryKey = (hostId: string) => [hostId, "auto-fetch", "pending-worktrees"];

function usePending(hostId: string) {
  const pending = useRpc(pendingWorktreesRpc);
  return useQuery({
    queryKey: queryKey(hostId),
    queryFn: () => pending({}),
    refetchInterval: (query) =>
      query.state.data?.scanning || query.state.data?.projects.some((p) => p.importing) ? 1_500 : 30_000,
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const names = (project: Pending) =>
  project.worktrees.map((w) => w.branch ?? w.path.split("/").pop() ?? w.path).join(", ");

/** Each project with worktrees that have no workspace, with a button to add them. */
function PendingWorktrees({ theme, host, layout, close }: PluginPopoverProps) {
  const c = theme.colors;
  const { data, error } = usePending(host.id);
  const queries = useQueryClient();
  const importWorktrees = useRpc(importWorktreesRpc);
  const add = useMutation({
    mutationFn: (projectId: string) => importWorktrees({ projectId }),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKey(host.id) }),
  });
  const projects = data?.projects ?? [];
  const failure = add.error ?? error;
  return (
    <ScrollView
      style={{ maxHeight: 420 }}
      contentContainerStyle={{ gap: 12, width: layout.compact ? undefined : 320 }}
    >
      {/* a phone's sheet shows the item's title already */}
      {layout.compact ? null : (
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
          Worktrees without a workspace
        </Text>
      )}
      {projects.map((project) => {
        const adding = project.importing || (add.isPending && add.variables === project.projectId);
        const disabled = add.isPending || project.importing;
        return (
          <View key={project.projectId} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: c.foreground, fontSize: 13 }} numberOfLines={1}>
                {project.name}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={2}>
                {names(project)}
              </Text>
              {project.error ? (
                <Text style={{ color: c.statusDanger, fontSize: 12 }}>{errorMessage(project.error)}</Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Add ${plural(project.worktrees.length, "worktree")} of ${project.name} as workspaces`}
              disabled={disabled}
              onPress={() => add.mutate(project.projectId)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: disabled ? c.surface2 : c.accent,
              }}
            >
              <Text style={{ color: disabled ? c.foregroundMuted : c.accentForeground, fontSize: 13 }}>
                {adding ? "Adding…" : `Add ${project.worktrees.length}`}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {!data || data.scanning ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Checking worktrees…</Text>
      ) : projects.length === 0 ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Every worktree has a workspace.</Text>
      ) : null}
      {failure ? <Text style={{ color: c.statusDanger, fontSize: 13 }}>{errorMessage(failure)}</Text> : null}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        Each gets a workspace named after its branch. A worktree whose workspace you archived stays out.
      </Text>
      <Pressable accessibilityRole="button" onPress={close}>
        <Text style={{ color: c.accent, fontSize: 13 }}>Done</Text>
      </Pressable>
    </ScrollView>
  );
}

/**
 * A footer row while some project has worktrees without a workspace, until Paseo lets plugins
 * add to a project's own menu.
 */
export function PendingWorktreesItem({ host, openPopover }: PluginSidebarItemProps) {
  const { data, error } = usePending(host.id);
  const count = data?.projects.reduce((n, p) => n + p.worktrees.length, 0) ?? 0;
  if (!count && !error && !data?.scanning) return null;
  return (
    <SidebarRow
      icon="FolderGit2"
      label={
        count
          ? `${plural(count, "worktree")} to add`
          : error
            ? "Couldn't check worktrees"
            : "Checking worktrees…"
      }
      onPress={() => openPopover(PendingWorktrees)}
    />
  );
}
