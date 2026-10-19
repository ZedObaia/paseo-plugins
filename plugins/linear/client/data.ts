import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  accountsRpc,
  addAccountRpc,
  issuesRpc,
  removeAccountRpc,
  scopesRpc,
  searchRpc,
  statesRpc,
  type Account,
  type Link,
} from "../shared/contracts";

// The app shares one query cache between its plugins and hosts: keys start with the host.
export const keys = {
  all: (hostId: string) => [hostId, "linear"],
  accounts: (hostId: string) => [hostId, "linear", "accounts"],
  issues: (hostId: string) => [hostId, "linear", "issues"],
};

const POLL_MS = 60_000;

export function useAccounts(hostId: string) {
  const accounts = useRpc(accountsRpc);
  return useQuery({
    queryKey: keys.accounts(hostId),
    queryFn: async () => (await accounts({})).accounts,
  });
}

/** Adding and removing accounts; both refresh everything, since what you can see changes. */
export function useAccountChanges(hostId: string) {
  const queryClient = useQueryClient();
  const add = useRpc(addAccountRpc);
  const remove = useRpc(removeAccountRpc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (change: () => Promise<{ accounts: Account[] }>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(keys.accounts(hostId), (await change()).accounts);
      await queryClient.invalidateQueries({ queryKey: keys.all(hostId) });
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    add: (apiKey: string) => run(() => add({ apiKey })),
    remove: (id: string) => run(() => remove({ id })),
  };
}

export function useScopes(hostId: string, accountId: string) {
  const scopes = useRpc(scopesRpc);
  return useQuery({
    queryKey: [...keys.all(hostId), "scopes", accountId],
    queryFn: () => scopes({ accountId }),
  });
}

export interface Filters {
  mine: boolean;
  done: boolean;
  search: string;
}

export function useIssues(hostId: string, scopes: Link, filters: Filters) {
  const issues = useRpc(issuesRpc);
  return useQuery({
    queryKey: [
      ...keys.issues(hostId),
      scopes.map((scope) => `${scope.accountId}/${scope.kind}:${scope.id}`),
      filters,
    ],
    queryFn: () => issues({ scopes, ...filters }),
    refetchInterval: POLL_MS,
    placeholderData: (previous) => previous,
  });
}

/** Linear's search; answers seen before show at once and refresh behind. */
export function useSearch(hostId: string, query: string) {
  const search = useRpc(searchRpc);
  return useQuery({
    queryKey: [...keys.all(hostId), "search", query.trim().toLowerCase()],
    queryFn: async () => (await search({ query })).items,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
}

export function useStates(hostId: string, accountId: string, teamId: string) {
  const states = useRpc(statesRpc);
  return useQuery({
    queryKey: [...keys.all(hostId), "states", accountId, teamId],
    queryFn: async () => (await states({ accountId, teamId })).states,
    staleTime: 5 * 60_000,
  });
}

export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/ requestType=.*$/, "").replace(/^Request failed: /, "")
    : String(error);
