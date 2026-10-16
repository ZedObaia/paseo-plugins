import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  dockerActionRpc,
  signalProcessRpc,
  snapshotRpc,
  type Container,
  type DockerProject,
  type ProcessInfo,
  type PruneTarget,
  type Snapshot,
} from "../shared/contracts";
import { bytes, count, duration, memory, pct, ratio } from "./format";
import {
  Button,
  Card,
  IconButton,
  Meter,
  Section,
  Sparkline,
  StackedBar,
  StopButton,
  queryKey,
  useConfirm,
  useRunAction,
  type Confirmation,
} from "./ui";

type Docker = Extract<Snapshot["docker"], { available: true }>;
type Ask = (confirmation: Confirmation) => void;

export function ResourcesScreen({ theme, layout, host }: PluginScreenProps) {
  const snapshot = useRpc(snapshotRpc);
  const query = useQuery({
    queryKey: queryKey(host.id, "snapshot"),
    queryFn: () => snapshot({}),
    refetchInterval: 5_000,
  });
  const { ask, dialog } = useConfirm(theme, host.id);
  const c = theme.colors;
  const s = query.data;

  if (!s) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          backgroundColor: c.surface0,
        }}
      >
        {query.error ? (
          <Text style={{ color: c.statusDanger }}>{String(query.error)}</Text>
        ) : (
          <ActivityIndicator color={c.foregroundMuted} />
        )}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 24,
        gap: 28,
        maxWidth: 1100,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: c.foregroundMuted, flex: 1 }}>
          {s.host.hostname} · {s.host.platform} {s.host.arch} · up {duration(s.host.uptimeSec)} · updated{" "}
          {new Date(s.takenAt).toLocaleTimeString()}
          {query.isFetching ? " …" : ""}
        </Text>
        {query.error ? <Text style={{ color: c.statusDanger }}>Refresh failed</Text> : null}
      </View>
      <SystemCards theme={theme} s={s} />
      <MemoryByApp theme={theme} compact={layout.compact} s={s} />
      <Processes theme={theme} compact={layout.compact} s={s} ask={ask} />
      {s.docker.available ? (
        <DockerSection theme={theme} hostId={host.id} d={s.docker} ask={ask} />
      ) : (
        <Section theme={theme} title="Docker">
          <Text style={{ color: c.foregroundMuted }}>{s.docker.reason}</Text>
        </Section>
      )}
      {dialog}
    </ScrollView>
  );
}

/** A metric card with either the last 10 minutes as a chart (`history`) or a fill meter (`fill`). */
function Metric({
  theme,
  label,
  value,
  detail,
  chart,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
  detail: string;
  chart: { history: number[] } | { fill: number };
}) {
  const c = theme.colors;
  return (
    <Card theme={theme}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "600" }}>{value}</Text>
      {"history" in chart ? (
        <Sparkline theme={theme} values={chart.history} label={`${label}, last 10 minutes`} />
      ) : (
        <Meter theme={theme} value={chart.fill} />
      )}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {detail}
      </Text>
    </Card>
  );
}

function SystemCards({ theme, s }: { theme: PluginTheme; s: Snapshot }) {
  const load = s.load.map((l) => l.toFixed(1)).join(" · ");
  // steal is Linux-only and worth a mention only when a neighbour actually takes some
  const steal = s.stealPct !== null && s.stealPct >= 0.5 ? ` · steal ${pct(s.stealPct)}` : "";
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      <Metric
        theme={theme}
        label={`CPU · ${s.host.cpuCount} cores`}
        value={s.cpuPct === null ? "—" : pct(s.cpuPct)}
        detail={`load ${load}${steal}`}
        chart={{ history: s.history.map((h) => h.cpu) }}
      />
      <Metric
        theme={theme}
        label="Memory"
        value={pct(ratio(s.memory.usedBytes, s.memory.totalBytes) * 100)}
        detail={`${memory(s.memory.usedBytes)} of ${memory(s.memory.totalBytes)}`}
        chart={{ history: s.history.map((h) => h.mem) }}
      />
      {s.swap ? (
        <Metric
          theme={theme}
          label="Swap"
          value={memory(s.swap.usedBytes)}
          detail={`of ${memory(s.swap.totalBytes)}`}
          chart={{ history: s.history.map((h) => h.swap) }}
        />
      ) : null}
      {s.disks.map((disk) => (
        <Metric
          key={disk.mount}
          theme={theme}
          label={`Disk ${disk.mount}`}
          value={`${bytes(disk.freeBytes)} free`}
          detail={`${bytes(disk.usedBytes)} of ${bytes(disk.totalBytes)} used`}
          // as df's Capacity: blocks reserved for root count as unavailable, not free
          chart={{ fill: ratio(disk.usedBytes, disk.usedBytes + disk.freeBytes) }}
        />
      ))}
    </View>
  );
}

function Row({
  theme,
  onPress,
  accessibilityLabel,
  expanded,
  children,
}: {
  theme: PluginTheme;
  onPress?(): void;
  accessibilityLabel?: string;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: pressed && onPress ? theme.colors.surface2 : "transparent",
      })}
    >
      {children}
    </Pressable>
  );
}

function List({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  const c = theme.colors;
  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
        overflow: "hidden",
        marginTop: -1,
      }}
    >
      {children}
    </View>
  );
}

/** Where the memory goes, per app: "tsserver ×24" says more than 24 rows of "node". */
function MemoryByApp({ theme, compact, s }: { theme: PluginTheme; compact: boolean; s: Snapshot }) {
  const c = theme.colors;
  const max = Math.max(1, ...s.apps.map((a) => a.memBytes));
  return (
    <Section theme={theme} title="Memory by app">
      <List theme={theme}>
        {s.apps.map((a) => (
          <Row key={a.name} theme={theme}>
            <Text style={{ color: c.foreground, width: compact ? 130 : 190 }} numberOfLines={1}>
              {a.name}
              {a.count > 1 ? <Text style={{ color: c.foregroundMuted }}> ×{a.count}</Text> : null}
            </Text>
            <View
              style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" }}
            >
              <View style={{ height: 6, width: `${(a.memBytes / max) * 100}%`, backgroundColor: c.accent }} />
            </View>
            <Text style={{ color: c.foreground, width: 72, textAlign: "right" }}>{memory(a.memBytes)}</Text>
          </Row>
        ))}
      </List>
      {s.host.platform === "darwin" ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          Includes compressed memory, like Activity Monitor. Swap fills up when these add up to more than RAM.
        </Text>
      ) : null}
    </Section>
  );
}

function Processes({
  theme,
  compact,
  s,
  ask,
}: {
  theme: PluginTheme;
  compact: boolean;
  s: Snapshot;
  ask: Ask;
}) {
  const [by, setBy] = useState<"cpu" | "memory">("cpu");
  const signal = useRpc(signalProcessRpc);
  const c = theme.colors;
  const list = by === "cpu" ? s.topCpu : s.topMemory;
  const open = (p: ProcessInfo) =>
    ask({
      title: `${p.name} (${p.pid})`,
      message: `Owned by ${p.user}. Terminate asks it to exit; Force quit kills it immediately and can lose unsaved work.`,
      actions: [
        { label: "Terminate", danger: true, run: () => signal({ pid: p.pid, signal: "SIGTERM" }) },
        { label: "Force quit", danger: true, run: () => signal({ pid: p.pid, signal: "SIGKILL" }) },
      ],
    });
  return (
    <Section
      theme={theme}
      title="Top processes"
      trailing={
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Button theme={theme} label="CPU" selected={by === "cpu"} onPress={() => setBy("cpu")} />
          <Button theme={theme} label="Memory" selected={by === "memory"} onPress={() => setBy("memory")} />
        </View>
      }
    >
      <List theme={theme}>
        {list.map((p) => (
          <Row key={p.pid} theme={theme} onPress={() => open(p)}>
            <Text style={{ color: c.foreground, flex: 1 }} numberOfLines={1}>
              {p.name}
            </Text>
            {compact ? null : (
              <Text style={{ color: c.foregroundMuted, fontSize: 12, width: 64, textAlign: "right" }}>
                {p.pid}
              </Text>
            )}
            <Text style={{ color: c.foreground, width: 56, textAlign: "right" }}>{pct(p.cpuPct)}</Text>
            <Text style={{ color: c.foreground, width: 72, textAlign: "right" }}>{memory(p.memBytes)}</Text>
          </Row>
        ))}
      </List>
    </Section>
  );
}

function SubTitle({
  theme,
  children,
  trailing,
}: {
  theme: PluginTheme;
  children: string;
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "600" }}
      >
        {children}
      </Text>
      {trailing}
    </View>
  );
}

/** "1.2% · 350 MB" for a running container; stats can be missing when `docker stats` timed out. */
const containerUsage = (x: Container) =>
  [x.cpuPct === null ? null : pct(x.cpuPct), x.memBytes === null ? null : memory(x.memBytes)]
    .filter(Boolean)
    .join(" · ");

function DockerSection({
  theme,
  hostId,
  d,
  ask,
}: {
  theme: PluginTheme;
  hostId: string;
  d: Docker;
  ask: Ask;
}) {
  const action = useRpc(dockerActionRpc);
  const runAction = useRunAction(hostId);
  const c = theme.colors;
  const running = d.containerList.filter((x) => x.state === "running");
  const stopped = d.containerList.length - running.length;
  const prune = (title: string, message: string, target: PruneTarget) =>
    ask({
      title,
      message,
      actions: [{ label: "Delete", danger: true, run: () => action({ kind: "prune", target }) }],
    });
  const cleanups = [
    stopped > 0 && {
      label: `Delete ${count(stopped, "stopped container")}`,
      open: () =>
        prune(
          "Delete stopped containers",
          `Deletes ${count(stopped, "stopped container")}. Volumes and the data in them stay.`,
          "containers",
        ),
    },
    d.danglingImages > 0 && {
      label: `Delete ${count(d.danglingImages, "untagged image")}`,
      open: () =>
        prune(
          "Delete untagged images",
          "Deletes dangling images: old builds that no tag or container uses.",
          "images",
        ),
    },
    d.anonymousVolumes > 0 && {
      label: `Delete ${count(d.anonymousVolumes, "unused anonymous volume")}`,
      open: () =>
        prune(
          "Delete unused anonymous volumes",
          `Deletes ${count(d.anonymousVolumes, "unnamed volume")} that no container uses, with their data. Named volumes stay.`,
          "volumes",
        ),
    },
    d.buildCache.sizeBytes > 0 && {
      label: `Clear build cache · ${bytes(d.buildCache.sizeBytes)}`,
      open: () =>
        prune(
          "Clear build cache",
          "Deletes Docker's build cache. The next image builds start from scratch.",
          "build-cache",
        ),
    },
    {
      label: "Delete unused networks",
      open: () =>
        prune("Delete unused networks", "Deletes networks no container is attached to.", "networks"),
    },
  ].filter((x): x is { label: string; open(): void } => Boolean(x));
  const unused =
    d.images.reclaimableBytes +
    d.volumes.reclaimableBytes +
    d.buildCache.reclaimableBytes +
    d.containers.reclaimableBytes;

  const byProject = new Map<string, Container[]>();
  for (const x of d.containerList)
    if (x.project) byProject.set(x.project, [...(byProject.get(x.project) ?? []), x]);
  const loose = d.containerList.filter((x) => !x.project && x.state !== "running");
  const stopAll = () =>
    ask({
      title: `Stop ${count(running.length, "running container")}`,
      message:
        "Stops every running container on this host. Nothing is deleted; start them again from their project.",
      actions: [
        {
          label: "Stop all",
          danger: true,
          run: () => action({ kind: "containers", action: "stop", names: running.map((x) => x.name) }),
        },
      ],
    });

  return (
    <Section theme={theme} title={`Docker ${d.version}`}>
      <StackedBar
        theme={theme}
        parts={[
          { label: "Images", value: d.images.sizeBytes, color: c.accent, detail: bytes(d.images.sizeBytes) },
          {
            label: "Volumes",
            value: d.volumes.sizeBytes,
            color: c.statusWarning,
            detail: bytes(d.volumes.sizeBytes),
          },
          {
            label: "Build cache",
            value: d.buildCache.sizeBytes,
            color: c.foregroundMuted,
            detail: bytes(d.buildCache.sizeBytes),
          },
          {
            label: "Containers",
            value: d.containers.sizeBytes,
            color: c.statusDanger,
            detail: bytes(d.containers.sizeBytes),
          },
        ]}
      />
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {bytes(unused)} of this is not used by any container.
      </Text>

      <SubTitle theme={theme}>Free up space</SubTitle>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {cleanups.map((x) => (
          <Button key={x.label} theme={theme} icon="Trash2" danger label={x.label} onPress={x.open} />
        ))}
      </View>

      <SubTitle
        theme={theme}
        trailing={
          running.length > 1 ? (
            <Button theme={theme} icon="CircleStop" label="Stop all" onPress={stopAll} />
          ) : undefined
        }
      >
        {`Running containers (${running.length})`}
      </SubTitle>
      {running.length ? (
        <List theme={theme}>
          {running.map((x) => (
            <Row key={x.id} theme={theme}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.statusSuccess }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.foreground }} numberOfLines={1}>
                  {x.service ?? x.name}
                  {x.project ? <Text style={{ color: c.foregroundMuted }}> · {x.project}</Text> : null}
                </Text>
                {x.ports ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                    {x.ports}
                  </Text>
                ) : null}
              </View>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{containerUsage(x)}</Text>
              <StopButton
                theme={theme}
                label={x.name}
                onStop={() =>
                  void runAction(() => action({ kind: "containers", action: "stop", names: [x.name] }))
                }
              />
            </Row>
          ))}
        </List>
      ) : (
        <Text style={{ color: c.foregroundMuted }}>Nothing running.</Text>
      )}

      {d.projects.length ? (
        <>
          <SubTitle theme={theme}>Compose projects</SubTitle>
          <List theme={theme}>
            {d.projects.map((p) => (
              <ProjectRow
                key={p.name}
                theme={theme}
                p={p}
                containers={byProject.get(p.name) ?? []}
                ask={ask}
              />
            ))}
          </List>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            A project is stale when its containers were started from a folder that no longer exists, such as a
            deleted worktree.
          </Text>
        </>
      ) : null}
      {loose.length ? (
        <>
          <SubTitle theme={theme}>Other stopped containers</SubTitle>
          <List theme={theme}>
            {loose.map((x) => (
              <ContainerRow key={x.id} theme={theme} x={x} ask={ask} />
            ))}
          </List>
        </>
      ) : null}
    </Section>
  );
}

function ProjectRow({
  theme,
  p,
  containers,
  ask,
}: {
  theme: PluginTheme;
  p: DockerProject;
  containers: Container[];
  ask: Ask;
}) {
  const [open, setOpen] = useState(p.stale);
  const action = useRpc(dockerActionRpc);
  const c = theme.colors;
  const running = containers.filter((x) => x.state === "running");
  const mem = running.reduce((sum, x) => sum + (x.memBytes ?? 0), 0);
  const summary = containers.length ? `${running.length}/${containers.length} up` : "volumes only";
  const contents = `${count(containers.length, "container")} and ${count(p.volumes, "volume")}`;
  const remove: Confirmation = {
    title: `Delete ${p.name} and its data?`,
    message: `Deletes its ${contents}, with the data in those volumes, and its networks. This can't be undone.`,
    actions: [
      {
        label: "Delete with data",
        danger: true,
        run: () => action({ kind: "project", action: "remove", project: p.name }),
      },
    ],
  };
  const menu = () =>
    ask({
      title: p.name,
      message: `${contents}${p.workingDir ? `, started from ${p.workingDir}` : ""}.`,
      actions: [
        ...(running.length
          ? [{ label: "Stop", run: () => action({ kind: "project", action: "stop", project: p.name }) }]
          : []),
        { label: "Delete with data…", danger: true, next: remove },
      ],
    });
  return (
    <View>
      <Row
        theme={theme}
        onPress={() => setOpen(!open)}
        expanded={open}
        accessibilityLabel={`${p.name}${p.stale ? ", stale" : ""}, ${summary}`}
      >
        <Text
          style={{ color: c.foregroundMuted, width: 12 }}
          importantForAccessibility="no"
          accessibilityElementsHidden
        >
          {open ? "▾" : "▸"}
        </Text>
        <Text style={{ color: c.foreground, flex: 1 }} numberOfLines={1}>
          {p.name}
          {p.stale ? <Text style={{ color: c.statusDanger }}> stale</Text> : null}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {summary}
          {mem ? ` · ${memory(mem)}` : ""}
        </Text>
        <IconButton theme={theme} icon="Ellipsis" label={`${p.name} actions`} onPress={menu} />
      </Row>
      {open ? containers.map((x) => <ContainerRow key={x.id} theme={theme} x={x} ask={ask} indent />) : null}
    </View>
  );
}

function ContainerRow({
  theme,
  x,
  ask,
  indent,
}: {
  theme: PluginTheme;
  x: Container;
  ask: Ask;
  indent?: boolean;
}) {
  const action = useRpc(dockerActionRpc);
  const c = theme.colors;
  const up = x.state === "running";
  const run = (a: "start" | "stop" | "restart" | "remove") => () =>
    action({ kind: "containers", action: a, names: [x.name] });
  const menu = () =>
    ask({
      title: x.name,
      message: `${x.image} · ${x.status}${x.ports ? `\n${x.ports}` : ""}`,
      actions: up
        ? [
            { label: "Restart", run: run("restart") },
            { label: "Stop", run: run("stop") },
            { label: "Delete", danger: true, run: run("remove") },
          ]
        : [
            { label: "Start", run: run("start") },
            { label: "Delete", danger: true, run: run("remove") },
          ],
    });
  return (
    <Row theme={theme} onPress={menu}>
      {indent ? <View style={{ width: 22 }} /> : null}
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: up ? c.statusSuccess : c.foregroundMuted,
        }}
      />
      <Text style={{ color: c.foreground, flex: 1 }} numberOfLines={1}>
        {x.service ?? x.name}
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {up ? containerUsage(x) : x.status}
      </Text>
      <IconButton theme={theme} icon="Ellipsis" label={`${x.name} actions`} onPress={menu} />
    </Row>
  );
}
