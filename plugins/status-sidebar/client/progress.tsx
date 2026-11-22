// Progress under a running row: what a bot said with Fawzy's set_status tool, else the agent's
// newest task list (Claude's todos, Codex's plan), followed live from its timeline.

import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import {
  BOT_STATUS_KEY,
  PROGRESS_KEY,
  statusFromMetadata,
  taskProgress,
  type Progress,
  type TaskItem,
} from "./model";
import { useUi } from "./styles";

type TimelineItem = { type: string; items?: readonly TaskItem[] };

/** What the agent is doing: its progress line, and while it runs, its task list (possibly empty). */
export interface AgentWork {
  readonly progress: Progress | null;
  readonly items: readonly TaskItem[];
}

const NO_TASKS: readonly TaskItem[] = [];

export function useAgentProgress(agent: PluginAgentSnapshot | null | undefined): Progress | null {
  return useAgentWork(agent).progress;
}

export function useAgentWork(agent: PluginAgentSnapshot | null | undefined): AgentWork {
  const said = agent
    ? (statusFromMetadata(agent.metadata[PROGRESS_KEY]) ?? statusFromMetadata(agent.metadata[BOT_STATUS_KEY]))
    : null;
  const running = agent?.status === "running";
  const host = agent?.hostId;
  const id = agent?.id;
  const [tasks, setTasks] = useState<readonly TaskItem[]>(NO_TASKS);
  useEffect(() => {
    setTasks(NO_TASKS);
    if (!running || !host || !id) return;
    let live = true;
    const take = (item: TimelineItem) => {
      if (live && item.type === "todo") setTasks(item.items ?? NO_TASKS);
    };
    const timeline = getPaseoClient(host).agents.ref(id).timeline;
    // The running turn holds the list the agent keeps rewriting; the last one wins.
    timeline
      .refetch({ direction: "tail", limit: 1, wholeTurns: true })
      .then((page) => page.entries.forEach((entry) => take(entry.item as TimelineItem)))
      // ponytail: a host that can't answer leaves the row with its spinner alone.
      .catch(() => undefined);
    const stop = timeline.subscribe((event) => {
      if ("event" in event && event.event.type === "timeline") take(event.event.item as TimelineItem);
    });
    return () => {
      live = false;
      stop();
    };
  }, [running, host, id]);
  const items = running ? tasks : NO_TASKS;
  return useMemo(
    () => ({ progress: said ?? taskProgress(items), items }),
    [said?.text, said?.fraction, items],
  );
}

/** "2 of 4 · Replying on GitHub" over a thin bar. */
export function ProgressLine({ progress }: { progress: Progress }) {
  const { s } = useUi();
  return (
    <View style={s.progress}>
      <Text numberOfLines={1} style={s.progressText}>
        {progress.text}
      </Text>
      {progress.fraction !== null ? (
        <View style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${Math.round(progress.fraction * 100)}%` }]} />
        </View>
      ) : null}
    </View>
  );
}
