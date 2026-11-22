import { openExternalUrl, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { launchRpc, type StudioSession } from "../shared/contracts";
import { Button } from "./ui";

type Props = PluginScreenProps & { onManage(workspaceId: string): void };

export function StudioScreen(props: Props) {
  return (
    <OpenStudio
      key={`${props.host.id}:${props.params.workspaceId}:${props.params.connectionId}:${props.params.openRequest}`}
      {...props}
    />
  );
}

function OpenStudio({ params, theme, host, navigation, onManage }: Props) {
  const { workspaceId, connectionId } = params;
  const launch = useRpc(launchRpc);
  const pending = useRef<Promise<StudioSession> | null>(null);
  const opened = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<StudioSession | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    // Reuse the request across Strict Mode's effect replay.
    pending.current ??= launch({ workspaceId, connectionId, reuseOptions: true });
    void pending.current
      .then(async (result) => {
        if (!active || opened.current) return;
        setSession(result);
        opened.current = true;
        if (navigation?.openBrowser)
          navigation.openBrowser({ url: result.url, workspaceId, serverId: host.id });
        else await openExternalUrl(result.url);
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      active = false;
    };
  }, [launch, workspaceId, connectionId, navigation, host.id, attempt]);

  const c = theme.colors;
  return (
    <View style={{ flex: 1, padding: 24, gap: 16, backgroundColor: c.surface0 }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 19, fontWeight: "600" }}>
        {error ? "Could not open database" : session ? "Studio is open" : "Opening database…"}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: c.statusDanger, lineHeight: 21 }}>
          {error}
        </Text>
      ) : !session ? (
        <ActivityIndicator color={c.foregroundMuted} />
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {error ? (
          <Button
            theme={theme}
            label="Retry"
            onPress={() => {
              pending.current = null;
              opened.current = false;
              setError("");
              setSession(null);
              setAttempt((value) => value + 1);
            }}
          />
        ) : null}
        <Button
          theme={theme}
          label="Manage connections"
          icon="Settings2"
          onPress={() => onManage(workspaceId)}
        />
      </View>
    </View>
  );
}
