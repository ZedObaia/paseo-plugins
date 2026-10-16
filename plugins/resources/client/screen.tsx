import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  dockerActionRpc,
  signalProcessRpc,
  snapshotRpc,
  type Container,
  type DockerProject,
  type ProcessInfo,
  type Snapshot,
} from "../shared/contracts";
import { bytes, duration, pct, ratio } from "./format";
import { Button, Card, IconButton, Meter, Section, Sparkline, StackedBar, useConfirm, type Confirmation } from "./ui";

type Docker = Extract<Snapshot["docker"], { available: true }>;
type Ask = (confirmation: Confirmation) => void;

export function useSnapshot(intervalMs: number) {
  const snapshot = useRpc(snapshotRpc);
  return useQuery({ queryKey: ["snapshot"], queryFn: () => snapshot({}), refetchInterval: intervalMs });
}

/** Runs a reversible action right away (no confirmation) and reports it in a toast. */
function useQuickAction() {
  const toast = useToast();
  const queryClient = useQueryClient();
  return async (work: () => Promise<{ message: string }>) => {
    try {
      toast.show((await work()).message, { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
    await queryClient.invalidateQueries();
  };
}

export function ResourcesScreen({ theme, layout }: PluginScreenProps) {
  const query = useSnapshot(5_000);
  const { ask, dialog } = useConfirm(theme);
  const c = theme.colors;
  const s = query.data;

  if (!s) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.surface0 }}>
        {query.error ? <Text style={{ color: c.statusDanger }}>{String(query.error)}</Text> : <ActivityIndicator color={c.foregroundMuted} />}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 28, maxWidth: 1100, width: "100%", alignSelf: "center" }}
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
        <DockerSection theme={theme} d={s.docker} ask={ask} />
      ) : (
        <Section theme={theme} title="Docker">
          <Text style={{ color: c.foregroundMuted }}>{s.docker.reason}</Text>
        </Section>
      )}
      {dialog}
    </ScrollView>
  );
}

function Metric({
  theme,
  label,
  value,
  detail,
  fill,
  history,
  neutral,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
  detail: string;
  fill: number;
  // the last 10 minutes as 0..1 values: drawn as a sparkline instead of the meter
  history?: number[];
  neutral?: boolean;
}) {
  const c = theme.colors;
  return (
    <Card theme={theme} flex>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "600" }}>{value}</Text>
      {history ? <Sparkline theme={theme} values={history} /> : <Meter theme={theme} value={fill} neutral={neutral} />}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {detail}
      </Text>
    </Card>
  );
}

function SystemCards({ theme, s }: { theme: PluginTheme; s: Snapshot }) {
  const load = s.load.map((l) => l.toFixed(1)).join(" · ");
  const memRatio = ratio(s.memory.usedBytes, s.memory.totalBytes);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      <Metric
        theme={theme}
        label={`CPU · ${s.host.cpuCount} cores`}
        value={s.cpuPct === null ? "—" : pct(s.cpuPct)}
        detail={`load ${load}`}
        fill={(s.cpuPct ?? 0) / 100}
        history={s.history.map((h) => h.cpu)}
      />
      <Metric
        theme={theme}
        label="Memory"
        value={pct(memRatio * 100)}
        detail={`${bytes(s.memory.usedBytes)} of ${bytes(s.memory.totalBytes)}`}
        fill={memRatio}
        history={s.history.map((h) => h.mem)}
      />
      {s.swap ? (
        <Metric
          theme={theme}
          label="Swap"
          value={bytes(s.swap.usedBytes)}
          detail={`of ${bytes(s.swap.totalBytes)}`}
          fill={ratio(s.swap.usedBytes, s.swap.totalBytes)}
          history={s.history.map((h) => h.swap)}
        />
      ) : null}
      {s.disks.map((disk) => (
        <Metric
          key={disk.mount}
          theme={theme}
          label={`Disk ${disk.mount}`}
          value={`${bytes(disk.totalBytes - disk.usedBytes)} free`}
          detail={`${bytes(disk.usedBytes)} of ${bytes(disk.totalBytes)} used`}
          fill={ratio(disk.usedBytes, disk.totalBytes)}
        />
      ))}
    </View>
  );
}

function Row({ theme, onPress, children }: { theme: PluginTheme; onPress?(): void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
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
    <View style={{ borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden", marginTop: -1 }}>
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
            <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" }}>
              <View style={{ height: 6, width: `${(a.memBytes / max) * 100}%`, backgroundColor: c.accent }} />
            </View>
            <Text style={{ color: c.foreground, width: 72, textAlign: "right" }}>{bytes(a.memBytes)}</Text>
          </Row>
        ))}
      </List>
      {s.host.platform === "darwin" ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Includes compressed memory, like Activity Monitor. Swap fills when these add up to more than RAM.</Text>
      ) : null}
    </Section>
  );
}

function Processes({ theme, compact, s, ask }: { theme: PluginTheme; compact: boolean; s: Snapshot; ask: Ask }) {
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
          <Button theme={theme} label="CPU" primary={by === "cpu"} onPress={() => setBy("cpu")} />
          <Button theme={theme} label="Memory" primary={by === "memory"} onPress={() => setBy("memory")} />
        </View>
      }
    >
      <List theme={theme}>
        {list.map((p) => (
          <Row key={p.pid} theme={theme} onPress={() => open(p)}>
            <Text style={{ color: c.foreground, flex: 1 }} numberOfLines={1}>
              {p.name}
            </Text>
            {compact ? null : <Text style={{ color: c.foregroundMuted, fontSize: 12, width: 64, textAlign: "right" }}>{p.pid}</Text>}
            <Text style={{ color: c.foreground, width: 56, textAlign: "right" }}>{pct(p.cpuPct)}</Text>
            <Text style={{ color: c.foreground, width: 72, textAlign: "right" }}>{bytes(p.memBytes)}</Text>
          </Row>
        ))}
      </List>
    </Section>
  );
}

function SubTitle({ theme, children, trailing }: { theme: PluginTheme; children: string; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "600" }}>{children}</Text>
      {trailing}
    </View>
  );
}

function DockerSection({ theme, d, ask }: { theme: PluginTheme; d: Docker; ask: Ask }) {
  const action = useRpc(dockerActionRpc);
  const quick = useQuickAction();
  const c = theme.colors;
  const running = d.containerList.filter((x) => x.state === "running");
  const stopped = d.containerList.length - running.length;
  const prune = (title: string, message: string, target: "containers" | "images" | "volumes" | "build-cache" | "networks") =>
    ask({ title, message, actions: [{ label: "Delete", danger: true, run: () => action({ kind: "prune", target }) }] });
  const cleanups = [
    stopped && { label: `Delete ${stopped} stopped containers`, run: () => prune("Delete stopped containers", `Deletes ${stopped} stopped containers. Their named volumes (databases) stay.`, "containers") },
    d.danglingImages && { label: `Delete ${d.danglingImages} untagged images`, run: () => prune("Delete untagged images", "Deletes dangling images: old builds no tag or container uses.", "images") },
    d.danglingVolumes && { label: `Delete ${d.danglingVolumes} unused anonymous volumes`, run: () => prune("Delete unused anonymous volumes", "Deletes unnamed volumes no container uses. Named volumes (databases) stay.", "volumes") },
    d.buildCache.sizeBytes && { label: `Clear build cache · ${bytes(d.buildCache.sizeBytes)}`, run: () => prune("Clear build cache", "Deletes Docker's build cache. The next image builds start from scratch.", "build-cache") },
    { label: "Delete unused networks", run: () => prune("Delete unused networks", "Deletes networks no container is attached to.", "networks") },
  ].filter((x): x is { label: string; run(): void } => Boolean(x));

  const byProject = new Map<string, Container[]>();
  for (const x of d.containerList) if (x.project) byProject.set(x.project, [...(byProject.get(x.project) ?? []), x]);
  const loose = d.containerList.filter((x) => !x.project && x.state !== "running");
  const stopAll = () =>
    ask({
      title: `Stop ${running.length} running containers`,
      message: "Stops every running container on this host. Nothing is deleted; start them again from their project.",
      actions: [
        {
          label: "Stop all",
          danger: true,
          run: async () => {
            for (const x of running) await action({ kind: "container", action: "stop", id: x.name });
            return { message: `Stopped ${running.length} containers` };
          },
        },
      ],
    });

  return (
    <Section theme={theme} title={`Docker ${d.version}`}>
      <StackedBar
        theme={theme}
        parts={[
          { label: "Images", value: d.images.sizeBytes, color: c.accent, detail: bytes(d.images.sizeBytes) },
          { label: "Volumes", value: d.volumes.sizeBytes, color: c.statusWarning, detail: bytes(d.volumes.sizeBytes) },
          { label: "Build cache", value: d.buildCache.sizeBytes, color: c.foregroundMuted, detail: bytes(d.buildCache.sizeBytes) },
          { label: "Containers", value: d.containers.sizeBytes, color: c.statusDanger, detail: bytes(d.containers.sizeBytes) },
        ]}
      />
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {bytes(d.images.reclaimableBytes + d.volumes.reclaimableBytes + d.buildCache.reclaimableBytes + d.containers.reclaimableBytes)} could be freed
      </Text>

      <SubTitle theme={theme}>Free up space</SubTitle>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {cleanups.map((x) => (
          <Button key={x.label} theme={theme} icon="Trash2" danger label={x.label} onPress={x.run} />
        ))}
      </View>

      <SubTitle theme={theme} trailing={running.length > 1 ? <Button theme={theme} icon="CircleStop" label="Stop all" onPress={stopAll} /> : undefined}>
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
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {x.cpuPct === null ? "" : pct(x.cpuPct)}
                {x.memBytes === null ? "" : ` · ${bytes(x.memBytes)}`}
              </Text>
              <IconButton theme={theme} icon="CircleStop" label={`Stop ${x.name}`} onPress={() => void quick(() => action({ kind: "container", action: "stop", id: x.name }))} />
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
              <ProjectRow key={p.name} theme={theme} p={p} containers={byProject.get(p.name) ?? []} ask={ask} />
            ))}
          </List>
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
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        "stale" means a project's containers were started from a folder that no longer exists, such as a deleted worktree.
      </Text>
    </Section>
  );
}

function ProjectRow({ theme, p, containers, ask }: { theme: PluginTheme; p: DockerProject; containers: Container[]; ask: Ask }) {
  const [open, setOpen] = useState(p.stale);
  const action = useRpc(dockerActionRpc);
  const c = theme.colors;
  const running = containers.filter((x) => x.state === "running");
  const mem = running.reduce((sum, x) => sum + (x.memBytes ?? 0), 0);
  const menu = () =>
    ask({
      title: p.name,
      message: `${containers.length} containers, ${p.volumes} volumes${p.workingDir ? ` · from ${p.workingDir}` : ""}. "Delete with data" removes its containers, volumes and networks.`,
      actions: [
        ...(running.length ? [{ label: "Stop", run: () => action({ kind: "project", action: "stop", project: p.name }) }] : []),
        { label: "Delete with data", danger: true, run: () => action({ kind: "project", action: "remove", project: p.name }) },
      ],
    });
  return (
    <View>
      <Row theme={theme} onPress={() => setOpen(!open)}>
        <Text style={{ color: c.foregroundMuted, width: 12 }}>{open ? "▾" : "▸"}</Text>
        <Text style={{ color: c.foreground, flex: 1 }} numberOfLines={1}>
          {p.name}
          {p.stale ? <Text style={{ color: c.statusDanger }}> stale</Text> : null}
        </Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {containers.length ? `${running.length}/${containers.length} up` : "volumes only"}
          {mem ? ` · ${bytes(mem)}` : ""}
        </Text>
        <IconButton theme={theme} icon="Ellipsis" label={`${p.name} actions`} onPress={menu} />
      </Row>
      {open ? containers.map((x) => <ContainerRow key={x.id} theme={theme} x={x} ask={ask} indent />) : null}
    </View>
  );
}

function ContainerRow({ theme, x, ask, indent }: { theme: PluginTheme; x: Container; ask: Ask; indent?: boolean }) {
  const action = useRpc(dockerActionRpc);
  const c = theme.colors;
  const up = x.state === "running";
  const run = (a: "start" | "stop" | "restart" | "remove") => () => action({ kind: "container", action: a, id: x.name });
  const menu = () =>
    ask({
      title: x.name,
      message: `${x.image} · ${x.status}${x.ports ? `\n${x.ports}` : ""}`,
      actions: up
        ? [{ label: "Restart", run: run("restart") }, { label: "Stop", run: run("stop") }, { label: "Delete", danger: true, run: run("remove") }]
        : [{ label: "Start", run: run("start") }, { label: "Delete", danger: true, run: run("remove") }],
    });
  return (
    <Row theme={theme} onPress={menu}>
      <View style={{ width: indent ? 22 : 0 }} />
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: up ? c.statusSuccess : c.foregroundMuted }} />
      <Text style={{ color: c.foreground, flex: 1 }} numberOfLines={1}>
        {x.service ?? x.name}
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {up ? `${x.cpuPct === null ? "" : pct(x.cpuPct)}${x.memBytes === null ? "" : ` · ${bytes(x.memBytes)}`}` : x.status}
      </Text>
      <IconButton theme={theme} icon="Ellipsis" label={`${x.name} actions`} onPress={menu} />
    </Row>
  );
}
