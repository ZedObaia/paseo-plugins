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
  type Snapshot,
} from "../shared/contracts";
import { bytes, duration, pct, ratio } from "./format";
import { Button, Card, Meter, Section, useConfirm, type Confirmation } from "./ui";

type Docker = Extract<Snapshot["docker"], { available: true }>;
type Ask = (confirmation: Confirmation) => void;

export function useSnapshot(intervalMs: number) {
  const snapshot = useRpc(snapshotRpc);
  return useQuery({ queryKey: ["snapshot"], queryFn: () => snapshot({}), refetchInterval: intervalMs });
}

export function ResourcesScreen({ theme, layout }: PluginScreenProps) {
  const query = useSnapshot(5_000);
  const { ask, dialog } = useConfirm(theme);
  const c = theme.colors;
  const s = query.data;

  if (!s) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: c.surface0 }}>
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
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 24, maxWidth: 1100, width: "100%", alignSelf: "center" }}
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
      <Processes theme={theme} s={s} ask={ask} />
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

function Metric({ theme, label, value, detail, fill }: { theme: PluginTheme; label: string; value: string; detail: string; fill: number }) {
  const c = theme.colors;
  return (
    <Card theme={theme} flex>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "600" }}>{value}</Text>
      <Meter theme={theme} value={fill} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {detail}
      </Text>
    </Card>
  );
}

function SystemCards({ theme, s }: { theme: PluginTheme; s: Snapshot }) {
  const load = s.load.map((l) => l.toFixed(2)).join(" · ");
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      <Metric
        theme={theme}
        label="CPU"
        value={s.cpuPct === null ? "—" : pct(s.cpuPct)}
        detail={`load ${load} · ${s.host.cpuCount} cores`}
        fill={(s.cpuPct ?? 0) / 100}
      />
      <Metric
        theme={theme}
        label="Memory"
        value={pct(ratio(s.memory.usedBytes, s.memory.totalBytes) * 100)}
        detail={`${bytes(s.memory.usedBytes)} of ${bytes(s.memory.totalBytes)}`}
        fill={ratio(s.memory.usedBytes, s.memory.totalBytes)}
      />
      {s.swap ? (
        <Metric
          theme={theme}
          label="Swap"
          value={bytes(s.swap.usedBytes)}
          detail={`of ${bytes(s.swap.totalBytes)}`}
          fill={ratio(s.swap.usedBytes, s.swap.totalBytes)}
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
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
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

function Processes({ theme, s, ask }: { theme: PluginTheme; s: Snapshot; ask: Ask }) {
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
            <Text style={{ color: c.foregroundMuted, fontSize: 12, width: 64, textAlign: "right" }}>{p.pid}</Text>
            <Text style={{ color: c.foreground, width: 56, textAlign: "right" }}>{pct(p.cpuPct)}</Text>
            <Text style={{ color: c.foreground, width: 72, textAlign: "right" }}>{bytes(p.rssBytes)}</Text>
          </Row>
        ))}
      </List>
    </Section>
  );
}

function DockerSection({ theme, d, ask }: { theme: PluginTheme; d: Docker; ask: Ask }) {
  const action = useRpc(dockerActionRpc);
  const c = theme.colors;
  const stopped = d.containerList.filter((x) => x.state !== "running").length;
  const prune = (title: string, message: string, target: "containers" | "images" | "volumes" | "build-cache" | "networks") =>
    ask({ title, message, actions: [{ label: "Delete", danger: true, run: () => action({ kind: "prune", target }) }] });
  const byProject = new Map<string, Container[]>();
  for (const x of d.containerList) if (x.project) byProject.set(x.project, [...(byProject.get(x.project) ?? []), x]);
  const loose = d.containerList.filter((x) => !x.project);

  return (
    <Section theme={theme} title={`Docker ${d.version}`}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {(
          [
            ["Images", d.images],
            ["Containers", d.containers],
            ["Volumes", d.volumes],
            ["Build cache", d.buildCache],
          ] as const
        ).map(([label, u]) => (
          <Metric
            key={label}
            theme={theme}
            label={`${label} · ${u.count}`}
            value={bytes(u.sizeBytes)}
            detail={`${bytes(u.reclaimableBytes)} reclaimable`}
            fill={ratio(u.reclaimableBytes, u.sizeBytes)}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          theme={theme}
          label={`Stopped containers (${stopped})`}
          disabled={!stopped}
          onPress={() => prune("Delete stopped containers", `Deletes ${stopped} stopped containers. Their named volumes stay.`, "containers")}
        />
        <Button
          theme={theme}
          label={`Dangling images (${d.danglingImages.count} · ${bytes(d.danglingImages.sizeBytes)})`}
          disabled={!d.danglingImages.count}
          onPress={() => prune("Delete dangling images", "Deletes untagged images no container uses.", "images")}
        />
        <Button
          theme={theme}
          label={`Anonymous volumes (${d.danglingVolumes})`}
          disabled={!d.danglingVolumes}
          onPress={() => prune("Delete unused anonymous volumes", "Deletes unnamed volumes no container uses. Named volumes (databases) stay.", "volumes")}
        />
        <Button
          theme={theme}
          label={`Build cache (${bytes(d.buildCache.sizeBytes)})`}
          disabled={!d.buildCache.sizeBytes}
          onPress={() => prune("Clear build cache", "Deletes Docker's build cache. The next image builds start from scratch.", "build-cache")}
        />
        <Button
          theme={theme}
          label="Unused networks"
          onPress={() => prune("Delete unused networks", "Deletes networks no container is attached to.", "networks")}
        />
      </View>
      {d.projects.length ? (
        <List theme={theme}>
          {d.projects.map((p) => (
            <ProjectRow key={p.name} theme={theme} p={p} containers={byProject.get(p.name) ?? []} ask={ask} />
          ))}
        </List>
      ) : null}
      {loose.length ? (
        <List theme={theme}>
          {loose.map((x) => (
            <ContainerRow key={x.id} theme={theme} x={x} ask={ask} />
          ))}
        </List>
      ) : null}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        Press a project or container for actions. "stale" means its containers were started from a folder that no longer exists.
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
  const actions = () =>
    ask({
      title: p.name,
      message: `${containers.length} containers, ${p.volumes} volumes${p.workingDir ? ` · from ${p.workingDir}` : ""}. Remove deletes its containers, volumes (data) and networks.`,
      actions: [
        ...(running.length ? [{ label: "Stop", run: () => action({ kind: "project", action: "stop", project: p.name }) }] : []),
        { label: "Remove with data", danger: true, run: () => action({ kind: "project", action: "remove", project: p.name }) },
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
        <Button theme={theme} label="Actions" onPress={actions} />
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
  const open = () =>
    ask({
      title: x.name,
      message: `${x.image} · ${x.status}${x.ports ? `\n${x.ports}` : ""}`,
      actions: up
        ? [{ label: "Restart", run: run("restart") }, { label: "Stop", run: run("stop") }, { label: "Remove", danger: true, run: run("remove") }]
        : [{ label: "Start", run: run("start") }, { label: "Remove", danger: true, run: run("remove") }],
    });
  return (
    <Row theme={theme} onPress={open}>
      <View style={{ width: indent ? 22 : 0 }} />
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: up ? c.statusSuccess : c.foregroundMuted }} />
      <Text style={{ color: c.foreground, flex: 1 }} numberOfLines={1}>
        {x.service ?? x.name}
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {up ? `${x.cpuPct === null ? "" : pct(x.cpuPct)}${x.memBytes === null ? "" : ` · ${bytes(x.memBytes)}`}` : x.status}
      </Text>
    </Row>
  );
}
