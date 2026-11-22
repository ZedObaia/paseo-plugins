import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DefaultSidebar } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  return client.addSidebarView({
    id: "projects-by-status",
    title: "Default view (plugin)",
    description: "A replica of Paseo's default sidebar, built on the plugin API.",
    Component: DefaultSidebar,
  });
}
