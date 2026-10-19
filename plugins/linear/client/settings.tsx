import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import { linearSettings, type Account, type AgentTools } from "../shared/contracts";
import { useAccountChanges, useAccounts } from "./data";
import { KEYS_URL } from "./panel";

function describe(account: Account): string {
  if (account.error) return `Linear doesn't accept its key: ${account.error}`;
  const who = [account.name, account.email].filter(Boolean).join(" · ");
  return account.fromEnvironment ? `${who}. From LINEAR_API_KEY in the daemon's environment.` : who;
}

export function AccountSettings({ theme, host }: PluginSurfaceProps) {
  const accounts = useAccounts(host.id);
  const changes = useAccountChanges(host.id);
  const settings = useSettings(linearSettings);
  const input = useRef<SettingsInputHandle>(null);
  const [draft, setDraft] = useState("");
  // Linear shows a key once: removing one takes a second press
  const [removing, setRemoving] = useState<string | null>(null);
  const muted = { color: theme.colors.foregroundMuted };

  const add = async () => {
    if (!(await changes.add(draft))) return;
    input.current?.replaceText("");
    setDraft("");
  };

  return (
    <>
      <SettingsSection
        title="Accounts"
        info={
          <ExternalLink href={KEYS_URL}>
            <Text style={{ color: theme.colors.accent }}>Make a personal API key in Linear</Text>
          </ExternalLink>
        }
      >
        <SettingsCard>
          {accounts.data?.map((account) => (
            <SettingsAction
              key={account.id}
              label={account.workspace}
              hint={
                removing === account.id
                  ? "Remove it? Adding it back takes its key again, and projects linked to it need linking again."
                  : describe(account)
              }
              actionLabel={removing === account.id ? "Remove it" : "Remove"}
              // only the daemon's environment can take that one away
              disabled={account.fromEnvironment || changes.busy}
              onPress={() => {
                if (removing !== account.id) return setRemoving(account.id);
                setRemoving(null);
                void changes.remove(account.id);
              }}
            />
          ))}
          <SettingsInput
            ref={input}
            label={accounts.data?.length ? "Add another account" : "Add an account"}
            hint="Paste a personal API key; Linear checks it first. Each key is one Linear workspace, and it stays on this host."
            error={changes.error}
            placeholder="lin_api_…"
            secureTextEntry
            onChangeText={setDraft}
            disabled={changes.busy}
          />
          <SettingsAction
            label="Add the account"
            actionLabel={changes.busy ? "Checking…" : "Add"}
            disabled={!draft.trim() || changes.busy}
            onPress={() => void add()}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Agents">
        <SettingsCard>
          {settings.status === "ready" ? (
            <SettingsSelect<AgentTools>
              label="Linear tools for agents"
              hint="New agents get Linear's own MCP tools to find, create and edit issues, comments and projects, signed in as the account their project is linked to, or as every account when it isn't linked."
              value={settings.values.agentTools}
              options={[
                { value: "write", label: "Read and write" },
                { value: "read", label: "Read only" },
                { value: "off", label: "Off" },
              ]}
              disabled={settings.saving}
              error={settings.saveError}
              onValueChange={(agentTools) =>
                void settings.save({ ...settings.values, agentTools }, settings.revision)
              }
            />
          ) : (
            <Text style={muted}>{settings.status === "loading" ? "Loading…" : settings.error}</Text>
          )}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
