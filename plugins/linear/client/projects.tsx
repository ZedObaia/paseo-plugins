import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import { linearSettings, type Account, type Link } from "../shared/contracts";
import { errorMessage, keys, useAccounts } from "./data";
import { ScopePicker } from "./panel";

const KIND = { all: "", team: "Team", project: "Project", view: "View" };

/** "All issues in Acme", or "Team: Engineering (ENG), Project: Web", after the workspace when there are several. */
function describe(link: Link | undefined, accounts: Account[]): string {
  if (!link) return "Not linked";
  const names = link
    .map((scope) => (scope.kind === "all" ? scope.name : `${KIND[scope.kind]}: ${scope.name}`))
    .join(", ");
  const account = accounts.find((a) => a.id === link[0].accountId);
  if (!account) return `${names}, in an account that was removed`;
  return accounts.length > 1 && link[0].kind !== "all" ? `${account.workspace} · ${names}` : names;
}

/** Every Paseo project on this host and what its Linear panel shows, to link many at once. */
export function projectSettings(client: PluginClientContext) {
  return function ProjectSettings({ theme, host, layout }: PluginSurfaceProps) {
    const muted = { color: theme.colors.foregroundMuted };
    const projects = useQuery({
      queryKey: [...keys.all(host.id), "paseo-projects"],
      queryFn: async () => (await client.paseo.projects.list()).projects,
    });
    const accounts = useAccounts(host.id);
    const settings = useSettings(linearSettings);
    const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

    if (projects.isLoading || accounts.isLoading || settings.status === "loading")
      return <Text style={muted}>Loading…</Text>;
    const failure = projects.error ?? accounts.error;
    if (failure) return <Text style={{ color: theme.colors.statusDanger }}>{errorMessage(failure)}</Text>;
    if (settings.status !== "ready") return <Text style={muted}>{settings.error}</Text>;
    const all = accounts.data ?? [];
    if (!all.length) return <Text style={muted}>Add a Linear account in Accounts first.</Text>;

    const save = async (projectId: string, link: Link | null) => {
      const { [projectId]: _, ...projects } = settings.values.projects;
      const next = link ? { ...projects, [projectId]: link } : projects;
      if (await settings.save({ ...settings.values, projects: next }, settings.revision)) setEditing(null);
    };
    const current = editing ? settings.values.projects[editing.id] : undefined;

    return (
      <SettingsSection title="Projects">
        <Text style={{ ...muted, fontSize: 13, marginBottom: 8 }}>
          What each Paseo project's Linear panel shows, and whose Linear tools its agents get. A link covers
          all of the project's workspaces and worktrees.
        </Text>
        <SettingsCard>
          {[...(projects.data ?? [])]
            .sort((a, b) => a.projectDisplayName.localeCompare(b.projectDisplayName))
            .map((project) => {
              const link = settings.values.projects[project.projectId];
              return (
                <SettingsAction
                  key={project.projectId}
                  label={project.projectDisplayName}
                  hint={describe(link, all)}
                  actionLabel={link ? "Change" : "Link"}
                  disabled={settings.saving}
                  onPress={() => setEditing({ id: project.projectId, name: project.projectDisplayName })}
                />
              );
            })}
        </SettingsCard>
        {settings.saveError ? (
          <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>
        ) : null}
        <Modal title="Linear" open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
          <Modal.Content>
            {editing ? (
              <ScopePicker
                theme={theme}
                compact={layout.compact}
                hostId={host.id}
                projectName={editing.name}
                accounts={all}
                current={current}
                save={(link) => void save(editing.id, link)}
                saving={settings.saving}
                saveError={settings.saveError}
                cancel={() => setEditing(null)}
                unlink={current ? () => void save(editing.id, null) : undefined}
                addAccount={() => {
                  setEditing(null);
                  client.openSettings("accounts");
                }}
              />
            ) : null}
          </Modal.Content>
        </Modal>
      </SettingsSection>
    );
  };
}
