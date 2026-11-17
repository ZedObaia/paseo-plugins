import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  previewProcessTreeRpc,
  signalProcessRpc,
  signalProcessTreeRpc,
  type ProcessInfo,
  type Snapshot,
} from "../shared/contracts";
import { count, memory, pct } from "./format";
import {
  processViewGroups,
  topProcesses,
  type GroupBy,
  type ProcessViewGroup,
  type SortBy,
} from "./process-groups";
import { Button, Section, type Confirmation } from "./ui";

type Ask = (confirmation: Confirmation) => void;

function ProcessRows({
  theme,
  rows,
  open,
}: {
  theme: PluginTheme;
  rows: ProcessInfo[];
  open(row: ProcessInfo): void;
}) {
  return (
    <>
      {rows.map((row) => (
        <Pressable
          key={row.pid}
          accessibilityRole="button"
          accessibilityLabel={`${row.name}, PID ${row.pid}, ${memory(row.memBytes)}`}
          onPress={() => open(row)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            padding: 10,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            backgroundColor: pressed ? theme.colors.surface2 : "transparent",
          })}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: theme.colors.foreground }} numberOfLines={1}>
              {row.name}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>PID {row.pid}</Text>
          </View>
          <Text style={{ color: theme.colors.foreground, width: 60, textAlign: "right" }}>
            {pct(row.cpuPct)}
          </Text>
          <Text style={{ color: theme.colors.foreground, width: 76, textAlign: "right" }}>
            {memory(row.memBytes)}
          </Text>
        </Pressable>
      ))}
    </>
  );
}

function Group({
  theme,
  group,
  open,
}: {
  theme: PluginTheme;
  group: ProcessViewGroup;
  open(row: ProcessInfo): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(30);
  const c = theme.colors;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 10,
        overflow: "hidden",
        backgroundColor: c.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${group.name}, ${count(group.processes.length, "process")}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          padding: 12,
          gap: 6,
          backgroundColor: pressed ? c.surface2 : "transparent",
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: c.foreground, flex: 1, fontWeight: "600" }} numberOfLines={1}>
            {expanded ? "▾" : "▸"} {group.name}
          </Text>
          <Text style={{ color: c.foreground }}>
            {pct(group.cpuPct)} · {memory(group.memBytes)}
          </Text>
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {[group.detail, count(group.processes.length, "process")].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      {expanded ? (
        <>
          <ProcessRows theme={theme} rows={group.processes.slice(0, limit)} open={open} />
          {group.processes.length > limit ? (
            <View style={{ padding: 10 }}>
              <Button
                theme={theme}
                label={`Show ${Math.min(30, group.processes.length - limit)} more`}
                onPress={() => setLimit(limit + 30)}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export function Processes({ theme, s, ask }: { theme: PluginTheme; s: Snapshot; ask: Ask }) {
  const [by, setBy] = useState<GroupBy>("workspace");
  const [sort, setSort] = useState<SortBy>("memory");
  const signal = useRpc(signalProcessRpc);
  const preview = useRpc(previewProcessTreeRpc);
  const signalTree = useRpc(signalProcessTreeRpc);
  const c = theme.colors;
  const open = (row: ProcessInfo) => {
    const identity = row.identity;
    if (!row.canSignal || !identity) {
      ask({
        title: `${row.name} (${row.pid})`,
        message: "This process is protected or unavailable.",
        actions: [],
      });
      return;
    }
    ask({
      title: `${row.name} (${row.pid})`,
      message: `Owned by ${row.user}. Force quit may lose unsaved work.`,
      actions: [
        {
          label: "Terminate",
          danger: true,
          run: () => signal({ pid: row.pid, identity, signal: "SIGTERM" }),
        },
        {
          label: "Force quit",
          danger: true,
          run: () => signal({ pid: row.pid, identity, signal: "SIGKILL" }),
        },
        {
          label: "Preview tree",
          prepare: async () => {
            const tree = await preview({ pid: row.pid, identity });
            return {
              title: `Stop ${count(tree.processes.length, "process")}?`,
              message: `Unsaved work may be lost.\n\n${tree.processes.map((p) => `${p.pid} · ${p.name}`).join("\n")}`,
              actions: [
                {
                  label: "Terminate tree",
                  danger: true,
                  run: () => signalTree({ token: tree.token, signal: "SIGTERM" }),
                },
                {
                  label: "Force quit tree",
                  danger: true,
                  run: () => signalTree({ token: tree.token, signal: "SIGKILL" }),
                },
              ],
            };
          },
        },
      ],
    });
  };
  const groups = by === "top" ? [] : processViewGroups(s.processGroups, by, sort);
  return (
    <Section theme={theme} title="Processes">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(["workspace", "project", "top"] as const).map((value) => (
          <Button
            key={value}
            theme={theme}
            label={{ workspace: "Workspace", project: "Project", top: "Top" }[value]}
            selected={by === value}
            onPress={() => setBy(value)}
          />
        ))}
        <Button theme={theme} label="CPU" selected={sort === "cpu"} onPress={() => setSort("cpu")} />
        <Button theme={theme} label="Memory" selected={sort === "memory"} onPress={() => setSort("memory")} />
      </View>
      {s.groupingError ? (
        <Text style={{ color: c.statusDanger }}>Grouping incomplete: {s.groupingError}</Text>
      ) : null}
      {by === "top" ? (
        <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 10, overflow: "hidden" }}>
          <ProcessRows theme={theme} rows={topProcesses(s, sort)} open={open} />
        </View>
      ) : (
        groups.map((group) => <Group key={`${by}:${group.id}`} theme={theme} group={group} open={open} />)
      )}
      {by !== "top" && groups.length === 0 ? (
        <Text style={{ color: c.foregroundMuted }}>No processes could be grouped.</Text>
      ) : null}
    </Section>
  );
}
