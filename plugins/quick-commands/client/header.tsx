import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { View } from "react-native";
import { CommandList } from "./list";

function popover(client: PluginClientContext): ComponentType<PluginButtonContentProps> {
  return function QuickCommands({ theme, layout, workspaceId, close }) {
    return (
      <View style={{ width: layout.compact ? undefined : 360 }}>
        <CommandList
          theme={theme}
          compact={layout.compact}
          workspaceId={workspaceId}
          ran={close}
          edit={() => {
            close();
            client.openSettings("commands");
          }}
        />
      </View>
    );
  };
}

/**
 * A Quick commands button in every workspace's header, following the workspaces as they come and
 * go. Paseo 0.12 leaves plugins' header buttons out on phones: there, the panel is the way in.
 */
export function headerButtons(client: PluginClientContext): () => void {
  const Content = popover(client);
  const buttons = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  let release: (() => Promise<void>) | undefined;

  const hide = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };
  const show = (workspaceId: string) => {
    if (stopped || buttons.has(workspaceId)) return;
    const registration = client.addHeaderButton({
      id: "quick-commands",
      workspaceId,
      button: { title: "Quick commands", icon: "SquareTerminal", behavior: { kind: "popover", Content } },
    });
    buttons.set(workspaceId, registration);
  };

  void client.paseo.workspaces
    .list({ subscribe: {}, page: { limit: 200 } })
    .then(({ subscription }) => {
      release = () => subscription.release();
      if (stopped) return void release();
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const current = new Set(entries.map((workspace) => workspace.id));
          for (const workspaceId of [...buttons.keys()]) if (!current.has(workspaceId)) hide(workspaceId);
          for (const workspace of entries) show(workspace.id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") show(update.workspace.id);
          else hide(update.id);
        },
      });
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Quick commands: watching workspaces failed:", error);
    });

  return () => {
    stopped = true;
    void release?.();
    for (const workspaceId of [...buttons.keys()]) hide(workspaceId);
  };
}
