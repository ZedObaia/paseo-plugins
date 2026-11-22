import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listRpc,
  permissionRpc,
  PROVIDERS,
  skillRpc,
  type Behavior,
  type Provider,
} from "../shared/contracts";

// The app shares one query cache between its plugins and hosts: keys start with the plugin and host.
const listKey = (hostId: string, provider: Provider, cwd: string) => [
  "toolbox",
  hostId,
  "list",
  provider,
  cwd,
];
const commandsKey = (hostId: string, agentId: string | null) => ["toolbox", hostId, "commands", agentId];

/** What the agent has in the folder: connectors and their health, plugins, skills, what to know. */
export function useListing(hostId: string, provider: Provider, cwd: string) {
  const list = useRpc(listRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: listKey(hostId, provider, cwd),
    queryFn: () => list({ provider, cwd, refresh: false }),
    staleTime: 30_000,
  });
  // checks every connector again, rather than taking the host's last minute-old look
  const recheck = async () =>
    queryClient.setQueryData(listKey(hostId, provider, cwd), await list({ provider, cwd, refresh: true }));
  return { ...query, recheck };
}

/** The chat's own commands and skills, as it lists them (Claude's skills come from here). */
export function useCommands(hostId: string, agentId: string | null, enabled: boolean) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: commandsKey(hostId, agentId),
    queryFn: async () => {
      const result = await paseo.agents.ref(agentId!).commands();
      if (result.error) throw new Error(result.error);
      return result.commands;
    },
    enabled: enabled && agentId !== null,
    staleTime: 30_000,
  });
}

export type Chat = { id: string; title: string; provider: Provider };

/** The workspace's chats with agents Toolbox knows, the most recently active first. */
export function useChats(hostId: string, workspaceId: string) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["toolbox", hostId, "chats", workspaceId],
    queryFn: async (): Promise<Chat[]> => {
      const { entries } = await paseo.agents.list({
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 200 },
      });
      return entries
        .map((e) => e.agent)
        .filter((a) => a.workspaceId === workspaceId && (PROVIDERS as readonly string[]).includes(a.provider))
        .map((a) => ({
          id: a.id,
          title: a.title?.trim() || "Untitled chat",
          provider: a.provider as Provider,
        }));
    },
    staleTime: 15_000,
  });
}

export function useSkill(hostId: string, provider: Provider, cwd: string, name: string) {
  const skill = useRpc(skillRpc);
  return useQuery({
    queryKey: ["toolbox", hostId, "skill", provider, cwd, name],
    queryFn: () => skill({ provider, cwd, name }),
    staleTime: 60_000,
  });
}

/** Sets Allow, Ask or Block for the folder, then reads the folder's rules again. */
export function useSetRule(hostId: string, provider: Provider, cwd: string) {
  const setRule = useRpc(permissionRpc);
  const queryClient = useQueryClient();
  return async (server: string, tool: string | null, behavior: Behavior) => {
    const { restart } = await setRule({ provider, cwd, server, tool, behavior });
    await queryClient.invalidateQueries({ queryKey: listKey(hostId, provider, cwd) });
    return restart;
  };
}

/** After a change: read the folder and the chat again. */
export function useInvalidate(hostId: string, provider: Provider, cwd: string, agentId: string | null) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: listKey(hostId, provider, cwd) }),
      queryClient.invalidateQueries({ queryKey: commandsKey(hostId, agentId) }),
    ]);
}

/** After adding a connector to several agents: read the folder again for each of them. */
export function useInvalidateFolder(hostId: string, cwd: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(PROVIDERS.map((p) => queryClient.invalidateQueries({ queryKey: listKey(hostId, p, cwd) })));
}

/** An RPC error without the transport's wrapping. */
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/ requestType=.*$/, "").replace(/^Request failed: /, "")
    : String(error);
