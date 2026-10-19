import type { PluginClientContext } from "@getpaseo/plugin/client";
import { issueAttachments } from "./shared/contracts";
import { linearPanel } from "./client/panel";
import { headerButtons, sendPills } from "./client/buttons";
import { projectSettings } from "./client/projects";
import { AccountSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  const Panel = linearPanel(client);
  // the same panel twice, so each "+" menu lists it once: a list in the Explorer, a board in a tab
  const removers = [
    client.addWorkspacePanel({
      id: "linear",
      title: "Linear",
      icon: "SquareKanban",
      context: "workspace",
      locations: ["explorer"],
      Component: Panel,
    }),
    client.addWorkspacePanel({
      id: "linear-tab",
      title: "Linear",
      icon: "SquareKanban",
      context: "workspace",
      locations: ["workspace"],
      Component: Panel,
    }),
    client.addCommandCenterItem({
      id: "show-issues",
      title: "Show Linear issues",
      icon: "SquareKanban",
      keywords: ["linear", "issues", "tickets", "board"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel("linear-tab", { location: "workspace" }),
    }),
    client.addSettingsScreen({
      id: "accounts",
      title: "Accounts",
      icon: "KeyRound",
      Component: AccountSettings,
    }),
    client.addSettingsScreen({
      id: "projects",
      title: "Projects",
      icon: "FolderKanban",
      Component: projectSettings(client),
    }),
  ];
  const removePills = sendPills(client);
  const removeHeaderButtons = headerButtons(client);
  const removeAttachments = client.addAttachmentSource(issueAttachments);
  return async () => {
    removePills();
    removeHeaderButtons();
    for (const remove of removers) remove();
    await removeAttachments();
  };
}
