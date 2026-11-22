import type { PluginServerContext } from "@getpaseo/plugin/server";
import { discoverRpc, launchRpc, stopRpc } from "./shared/contracts";
import { databaseType, discover, postgresUrl, sqliteFile } from "./server/discovery";
import { pluginDirectory, savedConnections, saveConnection } from "./server/state";
import { startStudio, type Studio } from "./server/studio";

export default function contribute(server: PluginServerContext) {
  const studios = new Map<string, Studio>();
  const starting = new Set<string>();
  let stopped = false;

  server.handle(discoverRpc, async ({ workspaceId }, { paseo }) => {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace || workspace.archivingAt !== null) throw new Error("This workspace is unavailable");
    const { connections, notices } = await discover(
      workspace.workspaceDirectory,
      await savedConnections(workspaceId),
    );
    const studio = studios.get(workspaceId);
    return {
      connections: connections.map(({ url: _url, ...connection }) => connection),
      notices,
      studio: studio?.alive ? { url: studio.url, port: studio.port, sessionId: studio.id } : undefined,
    };
  });

  server.handle(launchRpc, async (input, { paseo }) => {
    if (stopped) throw new Error("Databases is shutting down");
    if (starting.has(input.workspaceId)) throw new Error("A studio is already starting for this workspace");
    starting.add(input.workspaceId);
    try {
      const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
      if (!workspace || workspace.archivingAt !== null) throw new Error("This workspace is unavailable");
      if (input.file && input.url) throw new Error("Choose a connection URL or a SQLite file");
      let url = input.file ? await sqliteFile(input.file, workspace.workspaceDirectory) : input.url;
      if (!url) {
        const { connections } = await discover(
          workspace.workspaceDirectory,
          await savedConnections(input.workspaceId),
        );
        url = connections.find((connection) => connection.id === input.connectionId)?.url;
      }
      if (!url) throw new Error("This connection is no longer available. Refresh the database list.");
      if (databaseType(url) === "sqlite") {
        url = await sqliteFile(url, workspace.workspaceDirectory);
      } else {
        const parsed = postgresUrl(url);
        if (input.username !== undefined) parsed.username = input.username;
        if (input.password !== undefined) parsed.password = input.password;
        if (input.database !== undefined) parsed.pathname = `/${encodeURIComponent(input.database)}`;
        url = parsed.href;
      }
      const previous = studios.get(input.workspaceId);
      const provider = input.reuseOptions ? previous?.provider : input.provider;
      const browserOrigin = input.reuseOptions ? previous?.origin : input.browserOrigin;
      if (
        previous?.alive &&
        previous.connectionUrl === url &&
        previous.provider === provider &&
        (previous.origin ?? "") === (browserOrigin?.replace(/\/$/, "") ?? "")
      )
        return { url: previous.url, port: previous.port, sessionId: previous.id };
      // Start the replacement first, so a bad password never closes a working studio.
      const studio = await startStudio({
        directory: workspace.workspaceDirectory,
        pluginDir: pluginDirectory(),
        workspaceId: input.workspaceId,
        url,
        provider,
        browserOrigin,
        paseo,
      });
      if (stopped) {
        await studio.close();
        throw new Error("Databases stopped while the studio was starting");
      }
      try {
        await saveConnection(input.workspaceId, url);
      } catch (error) {
        await studio.close();
        throw error;
      }
      studios.set(input.workspaceId, studio);
      await previous?.close();
      return { url: studio.url, port: studio.port, sessionId: studio.id };
    } finally {
      starting.delete(input.workspaceId);
    }
  });

  server.handle(stopRpc, async ({ workspaceId }) => {
    const studio = studios.get(workspaceId);
    if (studio) {
      studios.delete(workspaceId);
      await studio.close();
    }
    return { message: "Studio stopped. Your databases are unchanged." };
  });
  server.on("workspace.archived", async ({ workspace }) => {
    const studio = studios.get(workspace.id);
    if (studio) {
      studios.delete(workspace.id);
      await studio.close();
    }
  });
  return async () => {
    stopped = true;
    await Promise.all([...studios.values()].map((studio) => studio.close()));
    studios.clear();
  };
}
