import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { assignRpc, createRpc, listRpc, powerRpc, type Device } from "../shared/contracts";

/** The host's devices and who holds them; polls faster while something boots. */
export function useDevices() {
  const list = useRpc(listRpc);
  return useQuery({
    queryKey: ["devices"],
    queryFn: () => list({}),
    refetchInterval: (query) => (query.state.data?.devices.some((d) => d.state === "booting") ? 2_000 : 8_000),
  });
}

/** Runs an action, shows its result or error as a toast, then refreshes the list. */
export function useAction() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function perform(work: () => Promise<{ message: string }>, quiet = false): Promise<boolean> {
    setBusy(true);
    try {
      const { message } = await work();
      if (!quiet) toast.show(message, { variant: "success" });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message.replace(/ requestType=.*$/, "").replace(/^Request failed: /, "") : String(error));
      return false;
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
    }
  }
  return { busy, perform };
}

export function useDeviceRpcs() {
  return { assign: useRpc(assignRpc), create: useRpc(createRpc), power: useRpc(powerRpc) };
}

export const canDuplicate = (d: Device) => d.kind === "simulator" || d.kind === "avd";

export const stateLabel = (d: Device) =>
  d.error ? `failed: ${d.error}` : d.state === "booted" ? "on" : d.state === "booting" ? "starting…" : "off";
