import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listRpc } from "../shared/contracts";
import { devicePanel } from "./location";

const POLL_MS = 8_000;

/**
 * A Device button in each workspace's header, named after the device the workspace holds. It's the
 * way to the panel on a phone, where no menu lists plugin panels, and opens it beside the agent on
 * a desktop. A host that can run neither simulators nor emulators gets none. Polls the host, and
 * only touches a button when its label changes.
 */
export function headerButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, { registration: PluginButtonRegistration; label: string }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const add = (workspaceId: string, label: string) =>
    client.addHeaderButton({
      id: "device",
      workspaceId,
      button: {
        title: "Open device",
        icon: "Smartphone",
        // icon-only until the workspace holds a device
        ...(label ? { label } : {}),
        behavior: {
          kind: "action",
          onPress() {
            const { id, location } = devicePanel();
            client.openPanel(id, { workspaceId, location });
          },
        },
      },
    });

  function show(labels: Map<string, string>) {
    for (const [workspaceId, label] of labels) {
      const shown = buttons.get(workspaceId);
      if (shown?.label === label) continue;
      // added again rather than patched, so a released device's name goes away too
      shown?.registration.remove();
      buttons.set(workspaceId, { registration: add(workspaceId, label), label });
    }
    for (const [workspaceId, { registration }] of buttons) {
      if (labels.has(workspaceId)) continue;
      registration.remove();
      buttons.delete(workspaceId);
    }
  }

  async function poll() {
    try {
      const [devices, workspaces] = await Promise.all([
        client.rpc(listRpc, {}),
        client.paseo.workspaces.list({ page: { limit: 200 } }),
      ]);
      const labels = new Map<string, string>();
      if (devices.ios.available || devices.android.available) {
        for (const workspace of workspaces.entries) labels.set(workspace.id, "");
        for (const a of devices.assignments) {
          const device = devices.devices.find((d) => d.id === a.deviceId);
          if (device) labels.set(a.workspaceId, device.name);
        }
      }
      show(labels);
    } catch {
      // host offline or the plugin reloading: keep what's shown until the next answer
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  }
  void poll();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const { registration } of buttons.values()) registration.remove();
    buttons.clear();
  };
}
