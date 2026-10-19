import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { fetchNowRpc, fetchSettings, INTERVALS, statusRpc, type Repo } from "../shared/contracts";
import { errorMessage } from "./errors";

// The app shares one query cache between its plugins and hosts: keys start with the host.
const queryKey = (hostId: string) => [hostId, "auto-fetch", "status"];

const DEFAULTS = { intervalMinutes: 5, fastForward: true, fromRemote: true, importWorktrees: true };

const intervalLabel = (minutes: number) =>
  minutes === 60 ? "1 hour" : minutes === 1 ? "1 minute" : `${minutes} minutes`;

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function inTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1
    ? "in a moment"
    : minutes < 90
      ? `in ${minutes} min`
      : `in ${Math.round(minutes / 60)} h`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describe(repo: Repo, now: number): string {
  const parts = [plural(repo.workspaces, "workspace")];
  if (repo.fetching) parts.push("Fetching…");
  else if (repo.lastFetchedAt !== null) parts.push(`Fetched ${ago(now - repo.lastFetchedAt)}`);
  else parts.push("Not fetched yet");
  if (repo.error && !repo.fetching && repo.nextFetchAt !== null)
    parts.push(`Trying again ${inTime(repo.nextFetchAt - now)}`);
  const lines = [repo.path, parts.join(" · ")];
  for (const move of repo.moved.slice(0, 3))
    lines.push(
      `Moved ${move.branch} forward ${plural(move.commits, "commit")} to ${move.upstream}, ${ago(now - move.at)}`,
    );
  return lines.join("\n");
}

function Repositories({ theme, host }: PluginSurfaceProps) {
  const status = useRpc(statusRpc);
  const fetchNow = useRpc(fetchNowRpc);
  const queries = useQueryClient();
  const { data, error } = useQuery({
    queryKey: queryKey(host.id),
    queryFn: () => status({}),
    refetchInterval: (query) => (query.state.data?.repos.some((r) => r.fetching) ? 1_500 : 10_000),
  });
  const mutation = useMutation({
    mutationFn: (repo?: string) => fetchNow(repo ? { repo } : {}),
    // a failed fetch is on the repository's status, so this always shows the outcome
    onSettled: () => queries.invalidateQueries({ queryKey: queryKey(host.id) }),
  });
  const c = theme.colors;
  const failure = error ? errorMessage(error) : mutation.error ? errorMessage(mutation.error) : data?.error;
  const busy = mutation.isPending && mutation.variables === undefined;
  return (
    <SettingsSection
      title="Repositories"
      trailing={
        data?.repos.length ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fetch every repository now"
            disabled={busy}
            onPress={() => mutation.mutate(undefined)}
          >
            <Text style={{ color: busy ? c.foregroundMuted : c.accent, fontSize: 13 }}>Fetch all</Text>
          </Pressable>
        ) : undefined
      }
    >
      <SettingsCard>
        {data?.repos.map((repo) => (
          <SettingsAction
            key={repo.id}
            label={repo.name}
            hint={describe(repo, data.now)}
            error={repo.fetching ? null : repo.error}
            actionLabel={repo.fetching ? "Fetching…" : "Fetch now"}
            disabled={repo.fetching}
            onPress={() => mutation.mutate(repo.id)}
          />
        ))}
        {data && data.repos.length === 0 ? (
          <SettingsRow
            label="No repositories yet"
            hint="A repository shows up here once this host has a worktree or checkout of it in Paseo."
          />
        ) : null}
        {!data && !failure ? <SettingsRow label="Loading…" /> : null}
      </SettingsCard>
      {failure ? (
        <View style={{ paddingHorizontal: 4 }}>
          <Text style={{ color: c.statusDanger, fontSize: 13 }}>{failure}</Text>
        </View>
      ) : null}
    </SettingsSection>
  );
}

export function FetchSettings(props: PluginSurfaceProps) {
  const settings = useSettings(fetchSettings);
  const { theme } = props;
  if (settings.status === "loading") return null;
  if (settings.status === "error")
    return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  const values = settings.status === "ready" ? settings.values : DEFAULTS;
  const save = (next: Partial<typeof values>) => settings.save({ ...values, ...next }, settings.revision);
  return (
    <View style={{ gap: 24 }}>
      <SettingsSection title="Fetching">
        <SettingsCard>
          <SettingsSelect
            label="Fetch every"
            hint={
              "Every repository with a worktree or checkout in Paseo, from all its remotes, " +
              "whether or not an app is open."
            }
            value={String(values.intervalMinutes)}
            options={INTERVALS.map((minutes) => ({ label: intervalLabel(minutes), value: String(minutes) }))}
            disabled={settings.saving}
            error={settings.status === "invalid" ? settings.error : settings.saveError}
            onValueChange={(value) => save({ intervalMinutes: Number(value) })}
          />
          <SettingsSwitch
            label="Fast-forward local branches"
            hint={
              "After each fetch, moves a local branch such as main up to the branch it tracks when it " +
              "has no commits of its own and no worktree has it checked out. Worktrees branched from " +
              "it then start from the latest commit."
            }
            value={values.fastForward}
            disabled={settings.saving}
            onValueChange={(fastForward) => save({ fastForward })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="New worktrees">
        <SettingsCard>
          <SettingsSwitch
            label="Start from the remote branch"
            hint={
              "A new worktree that would branch from a local branch, like the main that agents and " +
              "the CLI use, branches from the remote branch it tracks instead, which Paseo fetches " +
              "first. A local branch with commits of its own is used as it is."
            }
            value={values.fromRemote}
            disabled={settings.saving}
            onValueChange={(fromRemote) => save({ fromRemote })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="New projects">
        <SettingsCard>
          <SettingsSwitch
            label="Add their worktrees as workspaces"
            hint={
              "When you add a project, each of its git worktrees that has no workspace yet gets " +
              "one; its main checkout doesn't. For a project you already have, use " +
              '"Add this project\'s worktrees as workspaces" in the Command Center.'
            }
            value={values.importWorktrees}
            disabled={settings.saving}
            onValueChange={(importWorktrees) => save({ importWorktrees })}
          />
        </SettingsCard>
      </SettingsSection>
      <Repositories {...props} />
    </View>
  );
}
