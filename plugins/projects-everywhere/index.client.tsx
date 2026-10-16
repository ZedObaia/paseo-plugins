import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { NewProjectPrompt } from "./client/add";
import { useAdd, useHostProjects, useNewProject } from "./client/data";
import { ProjectsScreen } from "./client/screen";

// The sidebar row is always mounted, so it also watches for new projects to offer to other hosts.
function ProjectsItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const projects = useHostProjects();
  const adder = useAdd();
  const { fresh, dismiss } = useNewProject(projects);
  const missing = fresh
    ? projects.online.filter(
        (h) => !fresh.row.on.has(h.serverId) && projects.lists.some((l) => l.serverId === h.serverId),
      )
    : [];
  return (
    <>
      <SidebarRow
        icon="FolderSync"
        active={currentScreen?.screenId === "main"}
        onPress={() => openScreen({ screenId: "main" })}
      />
      {fresh && missing.length ? (
        <NewProjectPrompt
          theme={theme}
          row={fresh.row}
          from={projects.hosts.find((h) => h.serverId === fresh.from)?.label ?? "another host"}
          missing={missing}
          adder={adder}
          onClose={dismiss}
        />
      ) : null}
    </>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Projects everywhere", Component: ProjectsScreen });
  client.addSidebarHeaderItem({ id: "main", title: "Projects everywhere", Component: ProjectsItem });
  client.addCommandCenterItem({
    id: "add",
    title: "Add project to hosts",
    icon: "FolderPlus",
    keywords: ["clone", "devbox", "host", "project"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main", params: { add: "1" } });
    },
  });
  return () => {};
}
