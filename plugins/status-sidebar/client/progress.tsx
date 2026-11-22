// Progress under a running row: the agent's newest task list (Claude's todos, Codex's plan),
// followed live from its timeline, else the plan it sent with report_progress; and the line it
// reported (report_progress, or a bot's set_status), else the list's current step.

import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { getPaseoClient } from "@getpaseo/plugin/client";
import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import {
  BOT_STATUS_KEY,
  PROGRESS_KEY,
  countedProgress,
  statusFromMetadata,
  stepsFromMetadata,
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
  const report = agent?.metadata[PROGRESS_KEY];
  const said = agent
    ? (statusFromMetadata(report) ?? statusFromMetadata(agent.metadata[BOT_STATUS_KEY]))
    : null;
  // Parsed afresh each render, so kept by value: the row hands this to its hover card on change.
  const stepsKey = JSON.stringify(stepsFromMetadata(report));
  const reported = useMemo(() => JSON.parse(stepsKey) as TaskItem[], [stepsKey]);
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
  const own = running ? tasks : NO_TASKS;
  const items = own.length ? own : running ? reported : NO_TASKS;
  return useMemo(
    () => ({
      progress: said ? (own.length ? said : countedProgress(said, items)) : taskProgress(items),
      items,
    }),
    [said?.text, said?.fraction, own, items],
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
