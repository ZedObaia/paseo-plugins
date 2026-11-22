import type { PluginClientContext } from "@getpaseo/plugin/client";
import { headerButtons } from "./client/header";
import { databaseDropdown } from "./client/dropdown";
import { WorkspaceDatabases } from "./client/panel";
import { StudioScreen } from "./client/studio";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "studio",
    title: "Database Studio",
    Component: (props) => (
      <StudioScreen
        {...props}
        onManage={(workspaceId) => client.openPanel("databases", { workspaceId, location: "workspace" })}
      />
    ),
  });
  client.addWorkspacePanel({
    id: "databases",
    title: "Databases",
    icon: "Database",
    context: "workspace",
    locations: ["workspace"],
    Component: WorkspaceDatabases,
  });
  client.addCommandCenterItem({
    id: "open",
    title: "Explore workspace databases",
    icon: "Database",
    keywords: ["postgres", "sqlite", "sql", "db-studio"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("databases", { location: "workspace" });
    },
  });
  return headerButtons(client, databaseDropdown(client));
}
