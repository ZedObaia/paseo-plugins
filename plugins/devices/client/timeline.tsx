import { useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { z } from "zod";
import { thumbnailRpc } from "../shared/contracts";
import { agentDeviceArgs, describe, screenshotPath } from "../shared/timeline";

const KIND = "device-action";

const schema = z.object({
  // "cli": an agent-device command; "picker": device-picker's list_devices or use_device
  tool: z.enum(["cli", "picker"]),
  args: z.array(z.string()),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  output: z.string(),
  cwd: z.string().nullable(),
});
type Action = z.infer<typeof schema>;

const text = (value: unknown) =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);

/**
 * An agent's device actions as rows of their own in its chat: "Tapped @e12", "Took a screenshot"
 * with the picture, "Switched to iPhone 17". Shell commands that run agent-device and the picker's
 * tool calls are recognised; everything else is left as it was.
 */
export function deviceTimeline(client: PluginClientContext): () => void {
  const removeTransformer = client.addTimelineTransformer({
    id: "device-actions",
    query: { itemType: "tool_call" },
    transform({ item }) {
      let action: Action | null = null;
      if (item.detail.type === "shell") {
        const args = agentDeviceArgs(item.detail.command);
        if (args)
          action = {
            tool: "cli",
            args,
            status: item.status,
            // the end is what says how it went
            output: (item.detail.output ?? "").slice(-4_000),
            cwd: item.detail.cwd ?? null,
          };
      } else {
        const tool = /(list_devices|use_device)$/.exec(item.name)?.[1];
        if (tool) {
          const input = item.detail.type === "unknown" ? item.detail.input : undefined;
          const deviceId = (input as { deviceId?: unknown } | undefined)?.deviceId;
          action = {
            tool: "picker",
            args: [tool, ...(typeof deviceId === "string" ? [deviceId] : [])],
            status: item.status,
            output: item.detail.type === "unknown" ? text(item.detail.output).slice(-4_000) : "",
            cwd: null,
          };
        }
      }
      return action
        ? { items: [{ type: "plugin", id: item.callId, kind: KIND, version: 1, data: action }] }
        : undefined;
    },
  });
  const removeRenderer = client.addTimelineRenderer({ kind: KIND, version: 1, schema, Component: ActionRow });
  return () => {
    removeTransformer();
    removeRenderer();
  };
}

const summary = (action: Action) =>
  action.tool === "cli"
    ? describe(action.args)
    : action.args[0] === "use_device"
      ? `Switched to ${action.args[1] ?? "a device"}`
      : "Listed the devices it may use";

function ActionRow({ theme, host, item }: PluginTimelineItemProps<Action>) {
  const action = item.data;
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const shot =
    action.tool === "cli" && action.status === "completed"
      ? screenshotPath(action.args, action.output, action.cwd)
      : null;
  return (
    <View style={{ gap: 6, paddingVertical: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${summary(action)}. ${open ? "Hide" : "Show"} details`}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Icon name="Smartphone" size={14} color={c.foregroundMuted} />
        <Text style={{ color: c.foreground, flexShrink: 1 }} numberOfLines={1}>
          {summary(action)}
        </Text>
        {action.status === "running" ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
        {action.status === "failed" ? (
          <Text style={{ color: c.statusDanger, fontSize: 12 }}>failed</Text>
        ) : null}
      </Pressable>
      {shot ? <Thumbnail hostId={host.id} path={shot} /> : null}
      {open ? (
        <View style={{ gap: 4, padding: 8, borderRadius: 8, backgroundColor: c.surface2 }}>
          <Text style={{ color: c.foreground, fontFamily: "monospace", fontSize: 12 }} selectable>
            {action.tool === "cli" ? `agent-device ${action.args.join(" ")}` : action.args.join(" ")}
          </Text>
          {action.output ? (
            <Text style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 12 }} selectable>
              {action.output}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Thumbnail({ hostId, path }: { hostId: string; path: string }) {
  const read = useRpc(thumbnailRpc);
  // under the host's key: the app shares one query cache between hosts
  const thumb = useQuery({
    queryKey: ["devices", hostId, "thumbnail", path],
    queryFn: () => read({ path }),
    staleTime: Infinity,
    retry: false,
  });
  if (!thumb.data) return null;
  const scale = Math.min(1, 220 / thumb.data.height);
  return (
    <Image
      source={{ uri: `data:image/jpeg;base64,${thumb.data.jpeg}` }}
      style={{
        width: thumb.data.width * scale,
        height: thumb.data.height * scale,
        borderRadius: 10,
      }}
      accessibilityLabel="The screenshot the agent took"
    />
  );
}
