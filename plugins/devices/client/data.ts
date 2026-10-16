import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { assignRpc, createRpc, listRpc, powerRpc, type Device } from "../shared/contracts";

// The app shares one query cache between its plugins and hosts: keys start with the host.
const queryKey = (hostId: string) => ["devices", hostId];

/** The host's devices and who holds them; polls faster while something boots. */
export function useDevices(hostId: string) {
  const list = useRpc(listRpc);
  return useQuery({
    queryKey: queryKey(hostId),
    queryFn: () => list({}),
    refetchInterval: (query) =>
      query.state.data?.devices.some((d) => d.state === "booting") ? 2_000 : 8_000,
  });
}

/** Runs an action, shows its result or error as a toast, then refreshes the host's list. */
export function useAction(hostId: string) {
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
      toast.error(
        error instanceof Error
          ? error.message.replace(/ requestType=.*$/, "").replace(/^Request failed: /, "")
          : String(error),
      );
      return false;
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: queryKey(hostId) });
    }
  }
  return { busy, perform };
}

export function useDeviceRpcs() {
  return { assign: useRpc(assignRpc), create: useRpc(createRpc), power: useRpc(powerRpc) };
}

/** On or starting: what's using the host's memory, and what a workspace can look at right away. */
export const isOn = (d: Device) => d.state !== "shutdown";
// a stable sort, so the order within each half stays as listed
export const onFirst = (devices: Device[]) => [...devices].sort((a, b) => Number(isOn(b)) - Number(isOn(a)));

export const canDuplicate = (d: Device) => d.kind === "simulator" || d.kind === "avd";
export const canTurnOn = (d: Device) =>
  d.state === "shutdown" && (d.kind === "simulator" || d.kind === "avd");
// a USB phone can't be powered off from here; an emulator copy is deleted instead (it couldn't come back)
export const canTurnOff = (d: Device) =>
  d.state === "booted" && d.kind !== "physical" && !(d.kind === "emulator" && d.owned);

export const stateLabel = (d: Device) =>
  d.error ? `failed: ${d.error}` : d.state === "booted" ? "on" : d.state === "booting" ? "starting…" : "off";
