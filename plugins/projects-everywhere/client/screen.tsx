import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostSummary, PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { AddProjectForm } from "./add";
import { useAdd, useHostProjects } from "./data";
import type { ProjectRow } from "./model";
import { Button, Card, JobLine } from "./ui";

type Adder = ReturnType<typeof useAdd>;

/** Every project on every online host, with a button wherever one is missing. */
export function ProjectsScreen({ theme, layout, params }: PluginScreenProps) {
  const { hosts, online, lists, errors, rows, loading } = useHostProjects();
  const adder = useAdd();
  const [adding, setAdding] = useState(params.add === "1");
  const c = theme.colors;
  // hosts whose projects are known: a missing project means something only for them
  const listed = online.filter((h) => lists.some((l) => l.serverId === h.serverId));
  const missingOn = (row: ProjectRow) => listed.filter((h) => !row.on.has(h.serverId));
  const partial = rows.filter((r) => missingOn(r).length > 0);
  const everywhere = rows.filter((r) => missingOn(r).length === 0);
  const offline = hosts.filter((h) => h.status !== "online");
  const heading = (title: string) => (
    <Text
      accessibilityRole="header"
      style={{ color: c.foreground, fontSize: 16, fontWeight: "600", marginTop: 8 }}
    >
      {title}
    </Text>
  );
  const list = (items: ProjectRow[]) => (
    <Card theme={theme}>
      {items.map((row, index) => (
        <ProjectLine key={row.id} theme={theme} row={row} hosts={listed} adder={adder} first={index === 0} />
      ))}
    </Card>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 24,
        gap: 12,
        maxWidth: 900,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Text style={{ color: c.foregroundMuted, flex: 1, minWidth: 200 }}>
          A project is added the way Add project does, and cloned first on a host that doesn't have its
          folder.
        </Text>
        <Button
          theme={theme}
          primary
          icon="FolderPlus"
          label="Add project to hosts"
          onPress={() => setAdding(true)}
        />
      </View>
      {offline.map((h) => (
        <Text key={h.serverId} style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {h.label} is {h.status}: its projects show when it's back.
        </Text>
      ))}
      {errors.map((e) => (
        <Text key={e.label} style={{ color: c.statusDanger, fontSize: 12 }}>
          Couldn't list {e.label}'s projects: {e.text}
        </Text>
      ))}
      {loading && rows.length === 0 ? <ActivityIndicator color={c.foregroundMuted} /> : null}
      {partial.length ? (
        <>
          {heading(`Not on every host (${partial.length})`)}
          {list(partial)}
        </>
      ) : null}
      {everywhere.length ? (
        <>
          {heading(`On every host (${everywhere.length})`)}
          {list(everywhere)}
        </>
      ) : null}
      <Modal title="Add a project to hosts" open={adding} onOpenChange={setAdding}>
        <Modal.Content>
          <AddProjectForm
            theme={theme}
            hosts={online}
            rows={rows}
            adder={adder}
            onClose={() => setAdding(false)}
          />
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}

function ProjectLine({
  theme,
  row,
  hosts,
  adder,
  first,
}: {
  theme: PluginTheme;
  row: ProjectRow;
  hosts: readonly PluginHostSummary[];
  adder: Adder;
  first: boolean;
}) {
  const c = theme.colors;
  const status = (serverId: string) => adder.job(row.id, serverId);
  // a host's add finished but the next list hasn't shown the project yet
  const has = (serverId: string) => row.on.has(serverId) || status(serverId)?.state === "done";
  const addable = hosts.filter((h) => !has(h.serverId) && status(h.serverId)?.state !== "working");
  const failed = hosts.flatMap((h) => {
    const job = status(h.serverId);
    return job?.state === "failed" ? [{ host: h, job }] : [];
  });
  const add = (serverId: string) => void adder.add(row.id, row, serverId);
  return (
    <View style={{ padding: 10, gap: 6, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 160 }}>
          <Text style={{ color: c.foreground }} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {row.path}
          </Text>
        </View>
        {/* every row lists the hosts in the same order, like table columns */}
        {hosts.map((h) =>
          has(h.serverId) ? (
            <View key={h.serverId} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Icon name="Check" size={14} color={c.statusSuccess} />
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{h.label}</Text>
            </View>
          ) : status(h.serverId)?.state === "working" ? (
            <JobLine key={h.serverId} theme={theme} label={h.label} job={status(h.serverId)!} />
          ) : (
            <Button
              key={h.serverId}
              theme={theme}
              icon="Plus"
              label={`Add to ${h.label}`}
              onPress={() => add(h.serverId)}
            />
          ),
        )}
        {addable.length > 1 ? (
          <Button theme={theme} label="Add to all" onPress={() => addable.forEach((h) => add(h.serverId))} />
        ) : null}
      </View>
      {failed.map(({ host, job }) => (
        <JobLine key={host.serverId} theme={theme} label={host.label} job={job} />
      ))}
    </View>
  );
}
