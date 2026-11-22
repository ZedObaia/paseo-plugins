import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The replica's copy of the default view's display preferences, collapsed sections and filters,
 * kept per device like the app's own sidebar store.
 */
export const preferences = defineSettings({
  id: "display",
  scope: "device",
  version: 1,
  schema: z.object({
    grouping: z.enum(["project", "status"]).default("project"),
    sort: z.enum(["created", "lastPrompt"]).default("created"),
    titleSource: z.enum(["title", "branch"]).default("title"),
    rowItems: z
      .object({ branch: z.boolean(), project: z.boolean(), host: z.boolean(), labels: z.boolean() })
      .default({ branch: false, project: false, host: true, labels: true }),
    trailing: z.enum(["diff", "timestamp", "none"]).default("timestamp"),
    showBackground: z.boolean().default(false),
    hostFilters: z.array(z.string()).default([]),
    /** Project view keys. */
    projectFilters: z.array(z.string()).default([]),
    /** Label keys; "" is Unlabelled. */
    labelFilters: z.array(z.string()).default([]),
    /** Project view keys, "status:<bucket>", "bot:<id>", and "section:bots" / "section:workspaces". */
    collapsed: z.array(z.string()).default([]),
  }),
});
