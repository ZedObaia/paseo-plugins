import {
  openExternalUrl,
  useRpc,
  useWorkspace,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { ScrollView, Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { discoverRpc, launchRpc, stopRpc, type Connection } from "../shared/contracts";
import { Button, Field } from "./ui";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function WorkspaceDatabases(props: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(props.workspaceId, (w) => ({ name: w.name, directory: w.directory }));
  return (
    <DatabasePanel
      key={`${props.host.id}:${props.workspaceId}`}
      {...props}
      workspaceId={props.workspaceId}
      workspace={workspace}
    />
  );
}

function DatabasePanel({
  workspaceId,
  workspace,
  ...props
}: PluginWorkspacePanelProps & {
  workspaceId: string;
  workspace: { name: string; directory: string } | null;
}) {
  const { theme, layout, host, navigation } = props;
  const c = theme.colors;
  const discover = useRpc(discoverRpc);
  const launch = useRpc(launchRpc);
  const stop = useRpc(stopRpc);
  const cache = useQueryClient();
  const queryKey = ["databases", host.id, workspaceId];
  const query = useQuery({ queryKey, queryFn: () => discover({ workspaceId }), refetchInterval: 20000 });
  const session = query.data?.studio;
  const [manual, setManual] = useState(false);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState("");
  const [kind, setKind] = useState<"pg" | "sqlite">("pg");
  const [provider, setProvider] = useState("");
  const [origin, setOrigin] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function openStudio(connection?: Connection, credentials = false) {
    setBusy(connection?.id ?? "manual");
    setError("");
    try {
      const result = await launch({
        workspaceId,
        connectionId: connection?.id,
        url: !connection && kind === "pg" ? url.trim() : undefined,
        file: !connection && kind === "sqlite" ? file.trim() : undefined,
        provider: provider.trim() || undefined,
        browserOrigin: origin.trim() || undefined,
        ...(credentials
          ? {
              username: username || undefined,
              password: password || undefined,
              database: database || undefined,
            }
          : {}),
      });
      setPassword("");
      setUrl("");
      setFile("");
      setEditing(null);
      setManual(false);
      await cache.invalidateQueries({ queryKey });
      if (navigation?.openBrowser)
        navigation.openBrowser({ url: result.url, workspaceId, serverId: host.id });
      else await openExternalUrl(result.url);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  function edit(connection: Connection) {
    setEditing(connection);
    setUsername("");
    setPassword("");
    setDatabase("");
  }
  const groups = [
    { scope: "workspace", title: "This worktree", help: workspace?.directory },
    ...(manual
      ? [
          {
            scope: "host",
            title: "Available on this host",
            help: "Connect a database to add it to this worktree.",
          },
        ]
      : []),
  ];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 12 : 16,
        gap: 20,
        maxWidth: 1000,
        width: "100%",
        alignSelf: "center",
        paddingBottom: 40,
      }}
    >
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <Text
            accessibilityRole="header"
            style={{ flex: 1, color: c.foreground, fontSize: 19, fontWeight: "600" }}
          >
            Databases
          </Text>
          <Button
            theme={theme}
            label="Refresh"
            icon="RefreshCw"
            disabled={query.isFetching}
            onPress={() => void query.refetch()}
          />
          <Button
            theme={theme}
            label={manual ? "Cancel adding" : "Add connection"}
            icon={manual ? "X" : "Plus"}
            onPress={() => setManual(!manual)}
          />
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 14, lineHeight: 21 }}>
          PostgreSQL connections and SQLite files for this worktree. Use the AI Assistant in Studio to draft
          queries.
        </Text>
      </View>
      {error || query.error ? (
        <Text accessibilityRole="alert" style={{ color: c.statusDanger, lineHeight: 21 }}>
          {error || message(query.error)}
        </Text>
      ) : null}
      {!query.data && query.isPending ? <ActivityIndicator color={c.foregroundMuted} /> : null}
      {groups.map((group) => {
        const rows = query.data?.connections.filter((connection) => connection.scope === group.scope) ?? [];
        return (
          <View key={group.scope} style={{ gap: 8 }}>
            <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>
              {group.title}
            </Text>
            <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {group.help}
            </Text>
            {rows.map((connection) => (
              <View
                key={connection.id}
                style={{ paddingVertical: 15, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}
              >
                <View
                  style={{
                    flexDirection: layout.compact ? "column" : "row",
                    gap: 12,
                    alignItems: layout.compact ? "stretch" : "center",
                  }}
                >
                  <View style={{ flex: 1, gap: 5 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Icon name="Database" size={17} color={c.foregroundMuted} />
                      <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "500", flexShrink: 1 }}>
                        {connection.name}
                      </Text>
                    </View>
                    <Text selectable style={{ color: c.foreground, fontSize: 13 }}>
                      {connection.endpoint}
                    </Text>
                    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{connection.detail}</Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    {connection.type === "pg" ? (
                      <Button
                        theme={theme}
                        label="Credentials"
                        icon="KeyRound"
                        disabled={!!busy}
                        onPress={() => edit(connection)}
                      />
                    ) : null}
                    <Button
                      theme={theme}
                      label={
                        busy === connection.id
                          ? "Opening…"
                          : connection.scope === "host"
                            ? "Connect"
                            : "Open studio"
                      }
                      icon="ArrowUpRight"
                      primary
                      disabled={!!busy}
                      onPress={() => void openStudio(connection)}
                    />
                  </View>
                </View>
                {editing?.id === connection.id ? (
                  <View style={{ gap: 12, paddingTop: 10 }}>
                    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                      Leave a field blank to keep its discovered value.
                    </Text>
                    <Field theme={theme} label="Username" value={username} onChange={setUsername} />
                    <Field theme={theme} label="Password" value={password} onChange={setPassword} secret />
                    <Field theme={theme} label="Database" value={database} onChange={setDatabase} />
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <Button
                        theme={theme}
                        label="Connect"
                        primary
                        disabled={!!busy}
                        onPress={() => void openStudio(connection, true)}
                      />
                      <Button
                        theme={theme}
                        label="Cancel"
                        onPress={() => {
                          setEditing(null);
                          setPassword("");
                        }}
                      />
                    </View>
                  </View>
                ) : null}
              </View>
            ))}
            {!rows.length && query.data ? (
              <Text style={{ color: c.foregroundMuted, paddingVertical: 12 }}>
                {group.scope === "workspace"
                  ? "No databases added to this worktree. Start its PostgreSQL container, add a connection or open a SQLite file."
                  : "No other PostgreSQL databases detected on this host. Enter a connection URL below."}
              </Text>
            ) : null}
          </View>
        );
      })}
      {manual ? (
        <View style={{ gap: 14, padding: 16, backgroundColor: c.surface1, borderRadius: 10 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button theme={theme} label="PostgreSQL" primary={kind === "pg"} onPress={() => setKind("pg")} />
            <Button
              theme={theme}
              label="SQLite file"
              primary={kind === "sqlite"}
              onPress={() => setKind("sqlite")}
            />
          </View>
          {kind === "pg" ? (
            <Field
              theme={theme}
              label="PostgreSQL connection URL"
              value={url}
              onChange={setUrl}
              placeholder="postgresql://user:password@localhost:5432/database"
              secret
            />
          ) : (
            <Field
              theme={theme}
              label="SQLite file path on this host"
              value={file}
              onChange={setFile}
              placeholder="./data/app.sqlite"
            />
          )}
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {kind === "sqlite"
              ? "Open an existing file on the Paseo host. Relative paths start in this worktree. Studio can edit the original file."
              : "Saved only on this host, in an owner-only file, for this workspace."}
          </Text>
          <View style={{ alignItems: "flex-start" }}>
            <Button
              theme={theme}
              label={busy === "manual" ? "Connecting…" : "Connect and open"}
              primary
              disabled={!!busy || !(kind === "sqlite" ? file : url).trim()}
              onPress={() => void openStudio()}
            />
          </View>
        </View>
      ) : null}
      {query.data?.notices.map((notice) => (
        <Text key={notice} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 20 }}>
          {notice}
        </Text>
      ))}
      <View style={{ gap: 14 }}>
        <View style={{ alignItems: "flex-start" }}>
          <Button
            theme={theme}
            label={advanced ? "Hide options" : "Agent and remote host options"}
            icon="Settings2"
            onPress={() => setAdvanced(!advanced)}
          />
        </View>
        {advanced ? (
          <>
            <Field
              theme={theme}
              label="Paseo provider/model"
              value={provider}
              onChange={setProvider}
              placeholder="Use an available provider’s default model"
            />
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
              Optional provider/model ID from Paseo’s model picker. The SQL assistant uses your existing Paseo
              provider login.
            </Text>
            <Field
              theme={theme}
              label="Browser address for a forwarded remote studio"
              value={origin}
              onChange={setOrigin}
              placeholder="http://localhost:4000"
            />
            <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 19 }}>
              The browser runs on your desktop. For a remote daemon, forward the studio port over SSH and
              enter its local address here. The server stays bound to the daemon’s loopback interface.
            </Text>
          </>
        ) : null}
      </View>
      {session ? (
        <View style={{ gap: 12, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 18 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
            Studio listening on host port {session.port}. Stopping it leaves your databases in place.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              theme={theme}
              label="Reopen studio"
              icon="ArrowUpRight"
              onPress={() => {
                if (navigation?.openBrowser)
                  navigation.openBrowser({ url: session.url, workspaceId, serverId: host.id });
                else void openExternalUrl(session.url);
              }}
            />
            <Button
              theme={theme}
              label="Stop studio"
              icon="Square"
              disabled={!!busy}
              onPress={() => {
                setBusy("stop");
                void stop({ workspaceId })
                  .then(() => cache.invalidateQueries({ queryKey }))
                  .catch((e) => setError(message(e)))
                  .finally(() => setBusy(""));
              }}
            />
          </View>
        </View>
      ) : null}
      {!navigation?.openBrowser ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          This Paseo client opens the studio in an external browser. A reachable or forwarded studio address
          is required.
        </Text>
      ) : null}
    </ScrollView>
  );
}
