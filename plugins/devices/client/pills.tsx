import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { listRpc } from "../shared/contracts";
import { useDevices } from "./data";
import { deviceLabels } from "./header";
import { LiveScreen } from "./live";
import { Button } from "./ui";

const POLL_MS = 8_000;

/**
 * On phones, a pill above the composer of every agent whose workspace has a device: tap it to
 * watch and use the device without leaving the chat. Desktops show the device beside the agent.
 */
export function composerPills(client: PluginClientContext): () => void {
  if (Platform.OS === "web") return () => {};
  const lifetime = new AbortController();
  // agent -> its workspace; workspace -> what its pill says
  const agents = new Map<string, string>();
  let labels = new Map<string, string>();
  const pills = new Map<string, { registration: PluginButtonRegistration; label: string }>();

  function sync() {
    for (const [agentId, pill] of pills) {
      const label = labels.get(agents.get(agentId) ?? "");
      if (label === pill.label) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, workspaceId] of agents) {
      const label = labels.get(workspaceId);
      if (!label || pills.has(agentId)) continue;
      const registration = client.addComposerPill({
        id: "device",
        workspaceId,
        agentId,
        button: {
          title: `Show ${label}`,
          label,
          icon: "Smartphone",
          behavior: { kind: "popover", Content: Peek },
        },
      });
      pills.set(agentId, { registration, label });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    try {
      labels = deviceLabels(await client.rpc(listRpc, {}));
      sync();
    } catch {
      // host offline or the plugin reloading: keep the pills until the next answer
    }
    if (!lifetime.signal.aborted) timer = setTimeout(poll, POLL_MS);
  }
  void poll();

  const track = (agent: { id: string; workspaceId?: string | null; archivedAt?: string | null }) => {
    if (agent.workspaceId && !agent.archivedAt) agents.set(agent.id, agent.workspaceId);
    else agents.delete(agent.id);
  };
  void client.paseo.agents
    .list({ subscribe: {}, page: { limit: 200 }, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          agents.clear();
          for (const { agent } of entries) track(agent);
          sync();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "upsert") track(message.payload.agent);
          else agents.delete(message.payload.agentId);
          sync();
        },
      });
      lifetime.signal.addEventListener("abort", () => void subscription.release());
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("Devices: watching agents failed:", error);
    });

  return () => {
    lifetime.abort();
    if (timer !== undefined) clearTimeout(timer);
    for (const { registration } of pills.values()) registration.remove();
    pills.clear();
  };
}

/** The workspace's device, live, in the pill's popover; a switcher when it has several. */
function Peek({ theme, host, workspaceId }: PluginButtonContentProps) {
  const devices = useDevices(host.id);
  const [selected, setSelected] = useState<string | null>(null);
  const c = theme.colors;
  const data = devices.data;
  if (!data) return <ActivityIndicator color={c.foregroundMuted} />;
  const mine = data.assignments
    .filter((a) => a.workspaceId === workspaceId)
    .flatMap((a) => data.devices.filter((d) => d.id === a.deviceId));
  const device = mine.find((d) => d.id === selected) ?? mine[0];
  if (!device) return <Text style={{ color: c.foregroundMuted }}>This workspace has no device.</Text>;
  return (
    <View style={{ gap: 8, minWidth: 280, height: 440 }}>
      {mine.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {mine.map((d) => (
            <Button
              key={d.id}
              theme={theme}
              label={d.name}
              primary={d.id === device.id}
              onPress={() => setSelected(d.id)}
            />
          ))}
        </View>
      ) : null}
      {device.state === "booted" ? (
        <LiveScreen key={device.id} theme={theme} deviceId={device.id} />
      ) : (
        <Text style={{ color: c.foregroundMuted }}>
          {device.name} is off. Turn it on from its Device panel.
        </Text>
      )}
    </View>
  );
}
