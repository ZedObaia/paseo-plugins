import type { PluginTheme } from "@getpaseo/plugin";
import {
  openExternalUrl,
  useSettings,
  useWorkspace,
  type PluginClientContext,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { linearSettings, type Account, type Link, type Scope } from "../shared/contracts";
import { keyOf, toggle } from "../shared/board";
import { Board } from "./board";
import { errorMessage, useAccountChanges, useAccounts, useScopes } from "./data";
import { LinearLogo } from "./logo";
import { Button, Notice, SCOPE_ICON, sizes } from "./ui";

export const KEYS_URL = "https://linear.app/settings/account/security";

function Heading({ theme, compact, text }: { theme: PluginTheme; compact: boolean; text: string }) {
  const s = sizes(compact);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <LinearLogo size={s.icon + 2} color={theme.colors.foreground} platform={Platform.OS} />
      <Text style={{ color: theme.colors.foreground, fontSize: s.text + 1, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

function Field(props: {
  theme: PluginTheme;
  compact: boolean;
  value: string;
  onChangeText(text: string): void;
  placeholder: string;
  secure?: boolean;
  onSubmit?: () => void;
}) {
  const { theme, compact } = props;
  const s = sizes(compact);
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      onSubmitEditing={props.onSubmit}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      secureTextEntry={props.secure}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        flexGrow: 1,
        minWidth: 200,
        color: theme.colors.foreground,
        fontSize: s.text,
        minHeight: s.control,
        paddingHorizontal: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    />
  );
}

/** The first thing the panel asks for: a personal API key, pasted right here. */
function Connect({ theme, compact, hostId }: { theme: PluginTheme; compact: boolean; hostId: string }) {
  const changes = useAccountChanges(hostId);
  const [key, setKey] = useState("");
  const connect = () => void (key.trim() && !changes.busy && changes.add(key));
  return (
    <View style={{ gap: 12, maxWidth: 560 }}>
      <View style={{ gap: 4 }}>
        <Heading theme={theme} compact={compact} text="Connect Linear" />
        <Notice
          theme={theme}
          text="Paste a personal API key from Linear. It stays on this host. You can add more Linear accounts later."
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Field
          theme={theme}
          compact={compact}
          value={key}
          onChangeText={setKey}
          onSubmit={connect}
          placeholder="lin_api_…"
          secure
        />
        <Button
          theme={theme}
          compact={compact}
          variant="primary"
          label={changes.busy ? "Checking…" : "Connect"}
          disabled={!key.trim() || changes.busy}
          onPress={connect}
        />
      </View>
      {changes.error ? <Notice theme={theme} danger text={changes.error} /> : null}
      <View style={{ flexDirection: "row" }}>
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          icon="ExternalLink"
          label="Make a key in Linear"
          onPress={() => void openExternalUrl(KEYS_URL)}
        />
      </View>
    </View>
  );
}

/** Choosing the account, and all its issues or any of its teams, projects and saved views, this Paseo project shows. */
export function ScopePicker({
  theme,
  compact,
  hostId,
  projectName,
  accounts,
  current,
  save,
  cancel,
  unlink,
  addAccount,
  saving = false,
  saveError = null,
}: {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  projectName: string;
  accounts: Account[];
  current: Link | undefined;
  save(link: Link): void;
  cancel?: () => void;
  unlink?: () => void;
  addAccount(): void;
  /** The link is being saved: Save and Unlink wait. */
  saving?: boolean;
  /** Why the last save didn't go through. */
  saveError?: string | null;
}) {
  const c = theme.colors;
  const s = sizes(compact);
  const linkedAccount = accounts.find((account) => account.id === current?.[0].accountId);
  const [accountId, setAccountId] = useState((linkedAccount ?? accounts[0]).id);
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const [chosen, setChosen] = useState<Scope[]>(linkedAccount ? (current ?? []) : []);
  const scopes = useScopes(hostId, account.id);
  const [filter, setFilter] = useState("");
  const matches = (scope: Scope) => scope.name.toLowerCase().includes(filter.trim().toLowerCase());
  const groups: [string, Scope[]][] = scopes.data
    ? [
        ["", [scopes.data.all].filter(matches)],
        ["Teams", scopes.data.teams.filter(matches)],
        ["Projects", scopes.data.projects.filter(matches)],
        ["Saved views", scopes.data.views.filter(matches)],
      ]
    : [];
  const summary =
    chosen.length === 0
      ? "Nothing picked yet"
      : chosen.length === 1
        ? chosen[0].name
        : `${chosen.length} picked: ${chosen.map((scope) => scope.name).join(", ")}`;
  return (
    <View style={{ gap: 12, maxWidth: 560 }}>
      <View style={{ gap: 4 }}>
        <Heading theme={theme} compact={compact} text={`Link ${projectName} to Linear`} />
        <Notice
          theme={theme}
          text={
            current && !linkedAccount
              ? "The Linear account this project was linked to was removed. Pick what it shows now."
              : "Pick all of an account's issues, or as many of its teams, projects and saved views as you like. Agents in this project also get this account's Linear tools."
          }
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {accounts.length > 1 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: s.text }}>Account</Text>
        ) : null}
        {accounts.length > 1
          ? accounts.map((a) => (
              <Button
                key={a.id}
                theme={theme}
                compact={compact}
                variant="ghost"
                label={a.workspace}
                accessibilityLabel={`${a.workspace}, ${a.email}`}
                selected={a.id === account.id}
                onPress={() => {
                  // a link is one account's: picking another starts over
                  if (a.id !== account.id) setChosen([]);
                  setAccountId(a.id);
                }}
              />
            ))
          : null}
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          icon="Plus"
          label={accounts.length > 1 ? "Add an account" : "Add another Linear account"}
          onPress={addAccount}
        />
      </View>
      <Field theme={theme} compact={compact} value={filter} onChangeText={setFilter} placeholder="Filter" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1, minWidth: 160 }} numberOfLines={2}>
          {summary}
        </Text>
        {unlink ? (
          <Button
            theme={theme}
            compact={compact}
            variant="ghost"
            icon="Unlink"
            label="Unlink"
            disabled={saving}
            onPress={unlink}
          />
        ) : null}
        {cancel ? (
          <Button theme={theme} compact={compact} variant="ghost" label="Cancel" onPress={cancel} />
        ) : null}
        <Button
          theme={theme}
          compact={compact}
          variant="primary"
          label={saving ? "Saving…" : "Save"}
          disabled={!chosen.length || saving}
          onPress={() => save(chosen)}
        />
      </View>
      {saveError ? <Notice theme={theme} danger text={saveError} /> : null}
      {scopes.isLoading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
      {scopes.error ? <Notice theme={theme} danger text={errorMessage(scopes.error)} /> : null}
      {groups.map(([title, list]) =>
        list.length ? (
          <View key={title} style={{ gap: 2 }}>
            {title ? (
              <Text style={{ color: c.foregroundMuted, fontSize: 12, marginBottom: 2 }}>{title}</Text>
            ) : null}
            {list.map((scope) => {
              const ticked = chosen.some((s) => keyOf(s) === keyOf(scope));
              return (
                <Pressable
                  key={keyOf(scope)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: ticked }}
                  accessibilityLabel={scope.name}
                  onPress={() => setChosen((list) => toggle(list, scope))}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    minHeight: s.control,
                    paddingHorizontal: 8,
                    borderRadius: 6,
                    backgroundColor: ticked || pressed ? c.surface2 : "transparent",
                  })}
                >
                  <Icon
                    name={ticked ? "SquareCheck" : "Square"}
                    size={s.icon + 2}
                    color={ticked ? c.foreground : c.foregroundMuted}
                  />
                  <Icon name={SCOPE_ICON[scope.kind]} size={s.icon} color={c.foregroundMuted} />
                  <Text style={{ color: c.foreground, fontSize: s.text, flex: 1 }} numberOfLines={1}>
                    {scope.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null,
      )}
    </View>
  );
}

/** The workspace's project's Linear issues: connecting Linear and linking the project first. */
export function linearPanel(client: PluginClientContext) {
  return function LinearPanel({ theme, layout, host, workspaceId, navigation }: PluginWorkspacePanelProps) {
    const c = theme.colors;
    const compact = layout.compact;
    const project = useWorkspace(workspaceId, (w) => ({
      id: w.projectId,
      name: w.projectDisplayName,
      git: w.projectKind === "git",
    }));
    const accounts = useAccounts(host.id);
    const settings = useSettings(linearSettings);
    const [picking, setPicking] = useState(false);

    const page = (children: ReactNode) => (
      <ScrollView
        style={{ flex: 1, backgroundColor: c.surface0 }}
        contentContainerStyle={{ padding: compact ? 12 : 16, gap: 12 }}
      >
        {children}
      </ScrollView>
    );

    if (accounts.isLoading || settings.status === "loading" || !project)
      return page(<ActivityIndicator color={c.foregroundMuted} />);
    if (accounts.error) return page(<Notice theme={theme} danger text={errorMessage(accounts.error)} />);
    if (!accounts.data?.length) return page(<Connect theme={theme} compact={compact} hostId={host.id} />);
    if (settings.status !== "ready") return page(<Notice theme={theme} danger text={settings.error} />);

    const linked = settings.values.projects[project.id];
    const account = accounts.data.find((a) => a.id === linked?.[0].accountId);
    if (!linked || !account || picking)
      return page(
        <ScopePicker
          theme={theme}
          compact={compact}
          hostId={host.id}
          projectName={project.name}
          accounts={accounts.data}
          current={linked}
          cancel={linked && account ? () => setPicking(false) : undefined}
          unlink={
            linked
              ? async () => {
                  const { [project.id]: _, ...projects } = settings.values.projects;
                  if (await settings.save({ ...settings.values, projects }, settings.revision))
                    setPicking(false);
                }
              : undefined
          }
          addAccount={() => client.openSettings("accounts")}
          saving={settings.saving}
          saveError={settings.saveError}
          save={async (link) => {
            const projects = { ...settings.values.projects, [project.id]: link };
            if (await settings.save({ ...settings.values, projects }, settings.revision)) setPicking(false);
          }}
        />,
      );

    return (
      <Board
        theme={theme}
        compact={compact}
        hostId={host.id}
        workspaceId={workspaceId}
        scopes={linked}
        // with one account there's nothing to tell apart, and "All issues in Acme" says it already
        accountLabel={accounts.data.length > 1 && linked[0].kind !== "all" ? account.workspace : null}
        accountError={account.error}
        git={project.git}
        changeScope={() => setPicking(true)}
        openAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
      />
    );
  };
}
