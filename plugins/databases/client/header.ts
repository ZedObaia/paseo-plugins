import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";

export function headerButtons(
  client: PluginClientContext,
  Content: ComponentType<PluginButtonContentProps>,
): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  let release: (() => Promise<void>) | undefined;

  function hide(workspaceId: string) {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  }
  function show(workspaceId: string) {
    if (stopped || buttons.has(workspaceId)) return;
    buttons.set(
      workspaceId,
      client.addHeaderButton({
        id: "databases",
        workspaceId,
        button: {
          title: "Workspace databases",
          icon: "Database",
          label: "Databases",
          behavior: { kind: "popover", Content },
        },
      }),
    );
  }

  void client.paseo.workspaces
    .list({ subscribe: {}, page: { limit: 200 } })
    .then(({ subscription }) => {
      release = () => subscription.release();
      if (stopped) return void release();
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const active = entries.filter((workspace) => workspace.archivingAt === null);
          const current = new Set(active.map((workspace) => workspace.id));
          for (const workspaceId of buttons.keys()) if (!current.has(workspaceId)) hide(workspaceId);
          for (const workspace of active) show(workspace.id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            if (update.workspace.archivingAt === null) show(update.workspace.id);
            else hide(update.workspace.id);
          } else hide(update.id);
        },
      });
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Databases: watching workspaces failed:", error);
    });

  return () => {
    stopped = true;
    void release?.();
    for (const workspaceId of buttons.keys()) hide(workspaceId);
  };
}
