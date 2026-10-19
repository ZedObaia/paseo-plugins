import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView as Row, Text, View } from "react-native";
import { columns, labelsOf, type Column } from "../shared/board";
import { startRpc, updateIssueRpc, type Issue, type IssueAgent, type Link } from "../shared/contracts";
import { errorMessage, keys, useIssues, useStates, type Filters } from "./data";
import { Button, faint, IconButton, Notice, Pill, SCOPE_ICON, sizes } from "./ui";

// below this the board is a list grouped by status
const BOARD_MIN_WIDTH = 640;
const COLUMN_WIDTH = 280;
const SEARCH_DELAY_MS = 300;

interface CardContext {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  accountId: string;
  workspaceId: string;
  git: boolean;
  openAgent?: (agentId: string) => void;
}

function AgentRow({ theme, agent, open }: { theme: PluginTheme; agent: IssueAgent; open?: () => void }) {
  const c = theme.colors;
  const color =
    agent.status === "running" || agent.status === "initializing"
      ? c.accent
      : agent.status === "error"
        ? c.statusDanger
        : c.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open the agent ${agent.title ?? ""}, ${agent.status}`}
      disabled={!open}
      onPress={open}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name="Bot" size={12} color={color} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }} numberOfLines={1}>
        {agent.title ?? "Agent"} · {agent.status}
      </Text>
    </Pressable>
  );
}

/** A team's statuses to move the issue to, and assigning it to you. */
function StatusMenu({
  context,
  issue,
  busy,
  update,
}: {
  context: CardContext;
  issue: Issue;
  busy: boolean;
  update(change: { stateId?: string; assignToMe?: boolean }): void;
}) {
  const { theme, compact, hostId, accountId } = context;
  const c = theme.colors;
  const states = useStates(hostId, accountId, issue.teamId);
  if (states.isLoading) return <ActivityIndicator color={c.foregroundMuted} />;
  if (states.error) return <Notice theme={theme} danger text={errorMessage(states.error)} />;
  return (
    <View accessibilityRole="radiogroup">
      {states.data?.map((state) => {
        const current = state.id === issue.state.id;
        return (
          <Pressable
            key={state.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: current, disabled: busy }}
            disabled={busy || current}
            onPress={() => update({ stateId: state.id })}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              minHeight: sizes(compact).control,
              paddingHorizontal: 6,
              borderRadius: 6,
              backgroundColor: pressed || hovered ? c.surface2 : "transparent",
              opacity: busy ? 0.5 : 1,
            })}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: state.color }} />
            <Text style={{ color: c.foreground, fontSize: sizes(compact).text, flex: 1 }}>{state.name}</Text>
            {current ? <Icon name="Check" size={sizes(compact).icon} color={c.foreground} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Card({ context, issue, agents }: { context: CardContext; issue: Issue; agents: IssueAgent[] }) {
  const { theme, compact, hostId, workspaceId, git, openAgent } = context;
  const c = theme.colors;
  const s = sizes(compact);
  const toast = useToast();
  const queryClient = useQueryClient();
  const start = useRpc(startRpc);
  const updateIssue = useRpc(updateIssueRpc);
  const [open, setOpen] = useState<null | "actions" | "status">(null);
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: keys.issues(hostId) });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const startAgent = (where: "worktree" | "here") =>
    act(async () => {
      const { agentId } = await start({
        accountId: context.accountId,
        workspaceId,
        issueId: issue.id,
        where,
      });
      setOpen(null);
      if (openAgent) openAgent(agentId);
      else toast.show(`Started an agent on ${issue.identifier}`, { variant: "success" });
    });
  const update = (change: { stateId?: string; assignToMe?: boolean }) =>
    act(async () => {
      await updateIssue({ accountId: context.accountId, id: issue.id, ...change });
      setOpen(null);
    });

  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: open ? c.foregroundMuted : c.border,
        backgroundColor: c.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !!open }}
        accessibilityLabel={`${issue.identifier} ${issue.title}`}
        onPress={() => setOpen(open ? null : "actions")}
        style={{ gap: 6 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{issue.identifier}</Text>
          {issue.priority > 0 ? (
            <Text
              style={{
                color:
                  issue.priority === 1
                    ? c.statusDanger
                    : issue.priority === 2
                      ? c.statusWarning
                      : c.foregroundMuted,
                fontSize: 12,
              }}
            >
              {issue.priorityLabel}
            </Text>
          ) : null}
          <View style={{ flex: 1 }} />
          {issue.assignee ? (
            <Text
              style={{ color: issue.mine ? c.foreground : c.foregroundMuted, fontSize: 12 }}
              numberOfLines={1}
            >
              {issue.mine ? "You" : issue.assignee}
            </Text>
          ) : null}
        </View>
        <Text
          style={{ color: c.foreground, fontSize: s.text, lineHeight: 18 }}
          numberOfLines={open ? undefined : 3}
        >
          {issue.title}
        </Text>
        {issue.labels.length || issue.project ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {issue.project ? <Pill theme={theme} label={issue.project} /> : null}
            {issue.labels.map((label) => (
              <Pill key={label.name} theme={theme} label={label.name} color={label.color} />
            ))}
          </View>
        ) : null}
      </Pressable>
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          theme={theme}
          agent={agent}
          open={openAgent ? () => openAgent(agent.id) : undefined}
        />
      ))}
      {open === "actions" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {git ? (
            <Button
              theme={theme}
              compact={compact}
              variant="primary"
              icon="GitBranch"
              label="New worktree"
              accessibilityLabel={`Start an agent on ${issue.identifier} in a new worktree`}
              disabled={busy}
              onPress={() => startAgent("worktree")}
            />
          ) : null}
          <Button
            theme={theme}
            compact={compact}
            variant={git ? "secondary" : "primary"}
            icon="Bot"
            label={git ? "This workspace" : "Start agent"}
            accessibilityLabel={`Start an agent on ${issue.identifier} in this workspace`}
            disabled={busy}
            onPress={() => startAgent("here")}
          />
          <Button
            theme={theme}
            compact={compact}
            icon="CircleDot"
            label="Status"
            disabled={busy}
            onPress={() => setOpen("status")}
          />
          {!issue.mine ? (
            <Button
              theme={theme}
              compact={compact}
              icon="UserPlus"
              label="Assign to me"
              disabled={busy}
              onPress={() => update({ assignToMe: true })}
            />
          ) : null}
          <IconButton
            theme={theme}
            compact={compact}
            icon="ExternalLink"
            label={`Open ${issue.identifier} in Linear`}
            onPress={() => void openExternalUrl(issue.url).catch((error) => toast.error(errorMessage(error)))}
          />
          {busy ? <ActivityIndicator color={c.foregroundMuted} /> : null}
        </View>
      ) : null}
      {open === "status" ? <StatusMenu context={context} issue={issue} busy={busy} update={update} /> : null}
    </View>
  );
}

function ColumnHeader({ theme, column }: { theme: PluginTheme; column: Column }) {
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: column.state.color }} />
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{column.state.name}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{column.issues.length}</Text>
    </View>
  );
}

export function Board({
  theme,
  compact,
  hostId,
  workspaceId,
  scopes,
  accountLabel,
  accountError,
  git,
  changeScope,
  openAgent,
}: Omit<CardContext, "openAgent" | "accountId"> & {
  scopes: Link;
  /** The account's workspace, when there are several to tell apart. */
  accountLabel: string | null;
  /** Why Linear no longer accepts the account's key. */
  accountError: string | null;
  changeScope(): void;
  openAgent?: (agentId: string) => void;
}) {
  const c = theme.colors;
  const s = sizes(compact);
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>({ mine: false, done: false, search: "" });
  const [draft, setDraft] = useState("");
  const [label, setLabel] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => ({ ...f, search: draft.trim() })), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  const query = useIssues(hostId, scopes, filters);
  const all = query.data?.issues ?? [];
  const labels = labelsOf(all);
  const shown = label ? all.filter((issue) => issue.labels.some((l) => l.name === label)) : all;
  const board = columns(shown);
  const context: CardContext = {
    theme,
    compact,
    hostId,
    accountId: scopes[0].accountId,
    workspaceId,
    git,
    openAgent,
  };
  const agentsOf = (issue: Issue) => query.data?.agents[issue.id] ?? [];
  const wide = width >= BOARD_MIN_WIDTH;
  const toggle = (key: "mine" | "done") => setFilters((f) => ({ ...f, [key]: !f[key] }));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: compact ? 12 : 16, gap: 12 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon
          name={scopes.length === 1 ? SCOPE_ICON[scopes[0].kind] : "Boxes"}
          size={s.icon}
          color={c.foregroundMuted}
        />
        <Text
          style={{ color: c.foreground, fontSize: s.text + 1, fontWeight: "600", flexShrink: 1 }}
          numberOfLines={1}
        >
          {scopes.map((scope) => scope.name).join(", ")}
        </Text>
        {accountLabel ? (
          <Text style={{ color: c.foregroundMuted, fontSize: s.text }} numberOfLines={1}>
            {accountLabel}
          </Text>
        ) : null}
        <Button theme={theme} compact={compact} variant="ghost" label="Change" onPress={changeScope} />
        <View style={{ flex: 1 }} />
        {query.isFetching ? <ActivityIndicator color={c.foregroundMuted} /> : null}
        <IconButton
          theme={theme}
          compact={compact}
          icon="RefreshCw"
          label="Refresh"
          onPress={() => void queryClient.invalidateQueries({ queryKey: keys.issues(hostId) })}
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          icon="User"
          label="Mine"
          selected={filters.mine}
          onPress={() => toggle("mine")}
        />
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          icon="CircleCheck"
          label="Done"
          accessibilityLabel="Show completed and canceled issues"
          selected={filters.done}
          onPress={() => toggle("done")}
        />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Search"
          placeholderTextColor={c.foregroundMuted}
          accessibilityLabel="Search issues"
          style={{
            flexGrow: 1,
            minWidth: 160,
            color: c.foreground,
            fontSize: s.text,
            minHeight: s.control,
            paddingHorizontal: 10,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.surface1,
          }}
        />
      </View>
      {labels.length ? (
        <Row horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {labels.map((l) => (
            <Pressable
              key={l.name}
              accessibilityRole="button"
              accessibilityState={{ selected: label === l.name }}
              onPress={() => setLabel(label === l.name ? null : l.name)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 8,
                minHeight: compact ? 32 : 24,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: label === l.name ? l.color : c.border,
                backgroundColor: label === l.name ? faint(l.color) : "transparent",
              }}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: l.color }} />
              <Text style={{ color: c.foreground, fontSize: 12 }}>{l.name}</Text>
            </Pressable>
          ))}
        </Row>
      ) : null}
      {accountError ? (
        <Notice
          theme={theme}
          danger
          text={`Linear doesn't accept this account's key: ${accountError}. Add it again in Settings.`}
        />
      ) : query.error ? (
        <Notice theme={theme} danger text={errorMessage(query.error)} />
      ) : null}
      {query.isLoading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
      {query.data && !board.length ? <Notice theme={theme} text="No issues match." /> : null}
      {wide ? (
        <Row horizontal contentContainerStyle={{ gap: 12, alignItems: "flex-start" }}>
          {board.map((column) => (
            <View key={column.state.name} style={{ width: COLUMN_WIDTH, gap: 8 }}>
              <ColumnHeader theme={theme} column={column} />
              {column.issues.map((issue) => (
                <Card key={issue.id} context={context} issue={issue} agents={agentsOf(issue)} />
              ))}
            </View>
          ))}
        </Row>
      ) : (
        board.map((column) => (
          <View key={column.state.name} style={{ gap: 8 }}>
            <ColumnHeader theme={theme} column={column} />
            {column.issues.map((issue) => (
              <Card key={issue.id} context={context} issue={issue} agents={agentsOf(issue)} />
            ))}
          </View>
        ))
      )}
      {query.data?.more ? (
        <Notice
          theme={theme}
          text="Showing the 200 most recently updated issues. Filter to find older ones."
        />
      ) : null}
    </ScrollView>
  );
}
