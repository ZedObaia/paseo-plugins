// The bell: one press swaps Bots and Workspaces for everything that needs you, most urgent first;
// another press brings them back. Opening an item clears it, as Paseo marks it seen.

import { Pressable, Text, View } from "react-native";
import {
  useAgent,
  useAgents,
  useWorkspaces,
  type AgentRef,
  type Group,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { ChatRow, type Bot } from "./bots";
import type { PressState } from "./menu";
import { ATTENTION_ORDER, BOT_LABEL, agentAttention, compareStatusRows } from "./model";
import { GroupRows } from "./rows";
import { useUi } from "./styles";

export interface Attention {
  workspaces: readonly Group<WorkspaceRef>[];
  chats: readonly Group<AgentRef>[];
  count: number;
}

const needsYou = (key: string) => (ATTENTION_ORDER as readonly string[]).includes(key);

/** Workspaces by their indicator; bot chats, whose workspaces are hidden, by their own attention. */
export function useAttention(scope: readonly string[] | undefined): Attention {
  const workspaces = useWorkspaces({
    hosts: scope,
    where: (workspace) => !workspace.background && needsYou(workspace.indicator),
    orderBy: compareStatusRows,
    groupBy: (workspace) => workspace.indicator,
  });
  const chats = useAgents({
    where: (agent) => Boolean(agent.labels[BOT_LABEL]) && !agent.background && agent.requiresAttention,
    orderBy: ["lastActivityAt", "desc"],
    groupBy: (agent) => agentAttention(agent) ?? "attention",
  });
  const count = [...workspaces, ...chats].reduce((total, group) => total + group.items.length, 0);
  return { workspaces, chats, count };
}

export function Bell({ on, count, onPress }: { on: boolean; count: number; onPress(): void }) {
  const { s, c } = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={on ? "Show everything" : `Show what needs attention, ${count}`}
      onPress={onPress}
      style={(state: PressState) => [s.bell, (on || state.hovered) && (on ? s.selected : s.hover)]}
    >
      {(state: PressState) => (
        <>
          <Icon name="Bell" size={14} color={on || state.hovered ? c.foreground : c.foregroundMuted} />
          {count ? (
            <View style={s.bellBadge}>
              <Text style={s.bellBadgeText}>{count > 99 ? "99+" : count}</Text>
            </View>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

export function AttentionList({ attention, bots }: { attention: Attention; bots: readonly Bot[] }) {
  const { s } = useUi();
  if (!attention.count) return <Text style={s.emptyNote}>Nothing needs you right now.</Text>;
  return (
    <View>
      {ATTENTION_ORDER.map((reason) => {
        const chats = attention.chats.find((group) => group.key === reason)?.items ?? [];
        const workspaces = attention.workspaces.find((group) => group.key === reason)?.items ?? [];
        return (
          <View key={reason}>
            {chats.map((ref) => (
              <AttentionChat key={ref.key} reference={ref} bots={bots} />
            ))}
            {workspaces.length ? <GroupRows refs={workspaces} limit={50} withProject /> : null}
          </View>
        );
      })}
    </View>
  );
}

function AttentionChat({ reference, bots }: { reference: AgentRef; bots: readonly Bot[] }) {
  const botId = useAgent(reference, (agent) => agent.labels[BOT_LABEL] ?? "");
  const bot =
    bots.find((entry) => entry.id === botId) ??
    (botId ? { id: botId, name: null, avatar: null, bridge: null } : null);
  return <ChatRow reference={reference} bot={bot} withBot />;
}
