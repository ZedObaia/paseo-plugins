// A replica of Paseo's "Default view" sidebar (components/sidebar-workspace-list.tsx and
// sidebar/sidebar-status-list.tsx at v0.17.1) built on the plugin API.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  getPaseoClient,
  useHosts,
  useProjects,
  useSettings,
  useWorkspaces,
  type Group,
  type PluginHostSummary,
  type PluginSidebarViewProps,
  type ProjectRef,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import { preferences } from "../shared/preferences";
import { AttentionList, Bell, useAttention } from "./attention";
import { BotsSection, NewBotButton, useBots } from "./bots";
import { closeHoverCard } from "./hover-card";
import {
  Menu,
  MenuItem,
  MenuSearch,
  MenuSeparator,
  MenuSubTrigger,
  type MenuPage,
  type PressState,
} from "./menu";
import {
  STATUS_LABELS,
  STATUS_ORDER,
  aggregateStatus,
  allocateViewKeys,
  compareProjectNames,
  compareStatusRows,
  compareWorkspaces,
  labelKey,
  placementId,
  type Bucket,
  type ProjectPlacement,
} from "./model";
import {
  GroupRows,
  PlainRow,
  ProjectIcon,
  ProjectRow,
  SectionHeader,
  SidebarContext,
  useSidebar,
  type Prefs,
  type Sidebar,
} from "./rows";
import { UiContext, createUi, useUi } from "./styles";

const DEFAULTS = preferences.schema.parse({});

/** Device preferences with defaults while they load; writes wait until they have loaded. */
function usePrefs(): [Prefs, Sidebar["update"]] {
  const settings = useSettings(preferences);
  const update = useCallback(
    (change: (prefs: Prefs) => Prefs) => {
      if (settings.status === "ready") void settings.save(change(settings.values), settings.revision);
    },
    [settings],
  );
  return [settings.status === "ready" ? settings.values : DEFAULTS, update];
}

/**
 * Project view keys as the app allocates them. Snapshots lack the daemon's projectKey (what joins
 * one repo across hosts), so ask each online host's project list for it and follow its updates.
 */
function useViewKeys(
  hosts: readonly PluginHostSummary[],
): (project: { hostId: string; ref: ProjectRef }) => string {
  const online = hosts
    .filter((host) => host.status === "online")
    .map((host) => host.serverId)
    .join("\n");
  const [placements, setPlacements] = useState<readonly ProjectPlacement[]>([]);
  useEffect(() => {
    const ids = online ? online.split("\n") : [];
    let live = true;
    const load = async () => {
      const lists = await Promise.all(
        ids.map((serverId) =>
          getPaseoClient(serverId)
            .projects.list()
            .then((result) =>
              result.projects.map((project) => ({
                serverId,
                projectId: project.projectId,
                projectKey: project.projectKey ?? null,
              })),
            )
            // A host that can't answer keeps placement keys, as the app does without a projectKey.
            .catch(() => []),
        ),
      );
      if (live) setPlacements(lists.flat());
    };
    void load();
    const stops = ids.map((serverId) => getPaseoClient(serverId).projects.subscribe(() => void load()));
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [online]);
  const keys = useMemo(() => allocateViewKeys(placements), [placements]);
  return useCallback(
    (project) =>
      keys.get(placementId(project.hostId, project.ref.id)) ??
      JSON.stringify([project.hostId, project.ref.id]),
    [keys],
  );
}

function toggle(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key];
}

export function DefaultSidebar(view: PluginSidebarViewProps) {
  const touch = view.layout.compact || view.layout.platform !== "web";
  const ui = useMemo(() => createUi(view.theme.colors, touch), [view.theme.colors, touch]);
  return (
    <UiContext.Provider value={ui}>
      <SidebarList view={view} />
    </UiContext.Provider>
  );
}

function SidebarList({ view }: { view: PluginSidebarViewProps }) {
  const { s } = useUi();
  const [prefs, update] = usePrefs();
  const hosts = useHosts();
  const hostFilters = prefs.hostFilters.filter((id) => hosts.some((host) => host.serverId === id));
  const scope = hostFilters.length ? hostFilters : undefined;
  const viewKey = useViewKeys(hosts);
  const projects = useProjects({
    hosts: scope,
    orderBy: (a, b) =>
      compareProjectNames(a.displayName, b.displayName) || viewKey(a).localeCompare(viewKey(b)),
    groupBy: (project) => ({ key: viewKey(project), title: project.displayName }),
  });
  const keyByProject = useMemo(
    () => new Map(projects.flatMap((group) => group.items.map((ref) => [ref.key, group.key] as const))),
    [projects],
  );
  const projectOf = (workspace: PluginWorkspaceSnapshot) => keyByProject.get(workspace.project.key) ?? "";
  const labels = useWorkspaces({
    hosts: scope,
    groupBy: (workspace) => workspace.labels.map((name) => ({ key: labelKey(name), title: name.trim() })),
  });
  // A filter naming something that is gone filters nothing, as in resolveActiveProjectFilters.
  const projectFilters = prefs.projectFilters.filter((key) => projects.some((group) => group.key === key));
  const labelFilters = prefs.labelFilters.filter(
    (key) => key === "" || labels.some((group) => group.key === key),
  );
  const visible = (workspace: PluginWorkspaceSnapshot) =>
    (prefs.showBackground || !workspace.background) &&
    (!projectFilters.length || projectFilters.includes(projectOf(workspace))) &&
    (!labelFilters.length ||
      labelFilters.some((key) =>
        key === ""
          ? !workspace.labels.some((name) => labelKey(name))
          : workspace.labels.some((name) => labelKey(name) === key),
      ));
  const withAny = useWorkspaces({ hosts: scope, groupBy: projectOf });
  const withVisible = useWorkspaces({ hosts: scope, where: visible, groupBy: projectOf });
  const pinned = useWorkspaces({
    hosts: scope,
    where: (workspace) => workspace.pinnedAt !== null && visible(workspace),
    orderBy: ["pinnedAt", "desc"],
  });
  // A project stays while it has a visible workspace, or has none at all and no label filter.
  const shown = projects.filter(
    (group) =>
      (!projectFilters.length || projectFilters.includes(group.key)) &&
      (withVisible.some((entry) => entry.key === group.key) ||
        (!labelFilters.length && !withAny.some((entry) => entry.key === group.key))),
  );
  const shownHosts = new Set(shown.flatMap((group) => group.items.map((ref) => ref.hostId)));
  const hostBadges = new Map(
    shownHosts.size > 1 ? hosts.map((host) => [host.serverId, host.label.trim() || host.serverId]) : [],
  );
  const filterEmpty = projects.length > 0 && shown.length === 0;
  const status = prefs.grouping === "status";
  const sidebar: Sidebar = {
    view,
    prefs,
    update,
    scope,
    projectOf,
    visible,
    hostBadges,
    toggleCollapsed: (key) =>
      update((current) => ({ ...current, collapsed: toggle(current.collapsed, key) })),
  };

  const { bots, chats } = useBots();
  const attention = useAttention(scope);
  const [bellOn, setBellOn] = useState(false);
  const bell = <Bell on={bellOn} count={attention.count} onPress={() => setBellOn((on) => !on)} />;
  const botsCollapsed = prefs.collapsed.includes("section:bots");
  const workspacesCollapsed = prefs.collapsed.includes("section:workspaces");
  const workspacesHeader =
    pinned.length || status || shown.length || hostFilters.length || projectFilters.length || filterEmpty;

  return (
    <SidebarContext.Provider value={sidebar}>
      <ScrollView
        style={s.fill}
        contentContainerStyle={s.listContent}
        showsVerticalScrollIndicator={false}
        onScroll={closeHoverCard}
        scrollEventThrottle={100}
      >
        {bellOn ? (
          <>
            <SectionHeader title="Needs attention">{bell}</SectionHeader>
            <AttentionList attention={attention} bots={bots} />
          </>
        ) : (
          <>
            {bots.length ? (
              <>
                <SectionHeader
                  title="Bots"
                  collapsed={botsCollapsed}
                  onToggle={() => sidebar.toggleCollapsed("section:bots")}
                >
                  <NewBotButton bots={bots} />
                  <GroupingToggle />
                  {bell}
                </SectionHeader>
                {botsCollapsed ? null : <BotsSection bots={bots} chats={chats} />}
              </>
            ) : null}
            {workspacesHeader ? (
              <SectionHeader
                title="Workspaces"
                collapsed={workspacesCollapsed}
                onToggle={() => sidebar.toggleCollapsed("section:workspaces")}
              >
                {bots.length ? null : (
                  <>
                    <GroupingToggle />
                    {bell}
                  </>
                )}
                <DisplayMenu
                  hosts={hosts}
                  projects={projects}
                  labels={labels}
                  hostFilters={hostFilters}
                  projectFilters={projectFilters}
                  labelFilters={labelFilters}
                />
              </SectionHeader>
            ) : null}
            {workspacesCollapsed ? null : (
              <>
                {/* Pinned workspaces lead the section, where Paseo gives them a "Pinned" section of their own. */}
                {pinned.length ? (
                  <View style={s.blockExpanded}>
                    <GroupRows refs={pinned} limit={20} withProject />
                  </View>
                ) : null}
                {filterEmpty ? (
                  <FilterEmpty />
                ) : status ? (
                  <StatusGroups />
                ) : shown.length ? (
                  shown.map((group) => <ProjectBlock key={group.key} group={group} />)
                ) : (
                  <EmptyCard title="No projects yet" description="Add a project to get started" />
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </SidebarContext.Provider>
  );
}

function ProjectBlock({ group }: { group: Group<ProjectRef> }) {
  const { s } = useUi();
  const { view, prefs, scope, projectOf, visible, toggleCollapsed } = useSidebar();
  const name = group.title ?? group.key;
  const where = (workspace: PluginWorkspaceSnapshot) =>
    projectOf(workspace) === group.key && workspace.pinnedAt === null && visible(workspace);
  const refs = useWorkspaces({ hosts: scope, where, orderBy: compareWorkspaces(prefs.sort) });
  const byStatus = useWorkspaces({ hosts: scope, where, groupBy: (workspace) => workspace.indicator });
  const active = new Set(
    byStatus.filter((entry) => entry.key !== "done").flatMap((entry) => entry.items.map((ref) => ref.key)),
  );
  const collapsed = prefs.collapsed.includes(group.key);
  const target = group.items.find((ref) => ref.hostId === view.active.workspace?.hostId) ?? group.items[0];
  const create = () => view.navigation.openProject(target);
  const children = collapsed ? null : refs.length ? (
    <GroupRows refs={refs} limit={7} keep={(ref) => active.has(ref.key)} />
  ) : (
    <PlainRow
      icon="Plus"
      label="New workspace"
      accessibilityLabel={`Create a new workspace for ${name}`}
      indented
      onPress={create}
    />
  );
  return (
    <View accessibilityLabel={name} style={children ? s.blockExpanded : undefined}>
      <ProjectRow
        name={name}
        viewKey={group.key}
        collapsed={collapsed}
        status={collapsed ? aggregateStatus(byStatus.map((entry) => entry.key as Bucket)) : null}
        onToggle={() => toggleCollapsed(group.key)}
        onNew={create}
      />
      {children}
    </View>
  );
}

const STATUS_ICONS: Record<Bucket, string> = {
  needs_input: "CircleAlert",
  failed: "CircleX",
  attention: "CircleCheck",
  running: "CircleDot",
  done: "CircleCheck",
};

function StatusGroups() {
  const { scope, visible } = useSidebar();
  const groups = useWorkspaces({
    hosts: scope,
    where: (workspace) => workspace.pinnedAt === null && visible(workspace),
    orderBy: compareStatusRows,
    groupBy: (workspace) => workspace.indicator,
  });
  return STATUS_ORDER.map((bucket) => {
    const group = groups.find((entry) => entry.key === bucket);
    return group ? <StatusGroup key={bucket} bucket={bucket} refs={group.items} /> : null;
  });
}

function StatusGroup({ bucket, refs }: { bucket: Bucket; refs: readonly WorkspaceRef[] }) {
  const { s, c, p, iconSm } = useUi();
  const { prefs, toggleCollapsed } = useSidebar();
  const [hovered, setHovered] = useState(false);
  const key = `status:${bucket}`;
  const collapsed = prefs.collapsed.includes(key);
  const icon = hovered ? (collapsed ? "ChevronRight" : "ChevronDown") : STATUS_ICONS[bucket];
  const color = hovered || bucket === "done" ? c.foregroundMuted : p.dot[bucket];
  return (
    <View style={collapsed ? undefined : s.blockExpanded}>
      <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${STATUS_LABELS[bucket]} group`}
          accessibilityState={{ expanded: !collapsed }}
          onPress={() => toggleCollapsed(key)}
          style={({ pressed }) => [s.groupRow, hovered && s.hover, pressed && s.pressed]}
        >
          <View style={s.iconSlot}>
            <Icon name={icon} size={iconSm} color={color} />
          </View>
          <Text numberOfLines={1} style={s.mutedLabel}>
            {STATUS_LABELS[bucket]}
          </Text>
        </Pressable>
      </View>
      {collapsed ? null : (
        <GroupRows refs={refs} limit={7} keep={() => bucket !== "done"} withProject indented />
      )}
    </View>
  );
}

function EmptyCard({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: () => void;
}) {
  const { s } = useUi();
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      <Text style={s.cardText}>{description}</Text>
      {action ? (
        <View style={s.cardActions}>
          <Pressable accessibilityRole="button" onPress={action} style={s.button}>
            <Text style={s.buttonText}>Clear filters</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function FilterEmpty() {
  const { update } = useSidebar();
  return (
    <EmptyCard
      title="No workspaces match"
      description="Change or clear the sidebar filters to see workspaces."
      action={() => update((prefs) => ({ ...prefs, labelFilters: [], projectFilters: [] }))}
    />
  );
}

const ROW_ITEMS = [
  ["branch", "Branch", "GitBranch"],
  ["project", "Project", "Folder"],
  ["host", "Host", "Server"],
  ["labels", "Labels", "Tag"],
] as const;

/** The sliders button and its pages (sidebar/display-preferences/menu.tsx). */
/** Beside the bell: one press flips the workspaces between project and status grouping. */
function GroupingToggle() {
  const { s, c } = useUi();
  const { prefs, update } = useSidebar();
  const status = prefs.grouping === "status";
  const next = status ? "project" : "status";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Group workspaces by ${next}`}
      onPress={() => update((current) => ({ ...current, grouping: next }))}
      style={(state: PressState) => [s.bell, state.hovered && s.hover]}
    >
      {(state: PressState) => (
        <Icon
          name={status ? "CircleDashed" : "Folder"}
          size={14}
          color={state.hovered ? c.foreground : c.foregroundMuted}
        />
      )}
    </Pressable>
  );
}

function DisplayMenu({
  hosts,
  projects,
  labels,
  hostFilters,
  projectFilters,
  labelFilters,
}: {
  hosts: readonly PluginHostSummary[];
  projects: readonly Group<ProjectRef>[];
  labels: readonly Group<WorkspaceRef>[];
  hostFilters: readonly string[];
  projectFilters: readonly string[];
  labelFilters: readonly string[];
}) {
  const { s, c } = useUi();
  const { prefs, update } = useSidebar();
  const [open, setOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const query = projectQuery.trim().toLowerCase();
  const matchingProjects = query
    ? projects.filter((group) => (group.title ?? group.key).toLowerCase().includes(query))
    : projects;
  const anchor = useRef<View>(null);
  const set = (patch: Partial<Prefs>) => update((current) => ({ ...current, ...patch }));
  const choose = <Key extends "grouping" | "sort" | "titleSource">(
    key: Key,
    value: Prefs[Key],
    label: string,
    icon?: string,
  ) => (
    <MenuItem
      key={value}
      icon={icon}
      label={label}
      selected={prefs[key] === value}
      onSelect={() => set({ [key]: value })}
    />
  );
  const trailing = (value: "diff" | "timestamp", label: string, icon: string) => (
    <MenuItem
      icon={icon}
      label={label}
      selected={prefs.trailing === value}
      closeOnSelect={false}
      onSelect={() =>
        update((current) => ({ ...current, trailing: current.trailing === value ? "none" : value }))
      }
    />
  );
  const hostColor = (status: PluginHostSummary["status"]) =>
    status === "online" ? c.statusSuccess : status === "connecting" ? c.statusWarning : c.statusDanger;

  const pages: Record<string, MenuPage> = {
    grouping: {
      title: "Grouping",
      content: [
        choose("grouping", "project", "Project", "Folder"),
        choose("grouping", "status", "Status", "CircleDashed"),
      ],
    },
    sort: {
      title: "Sort",
      content: [choose("sort", "created", "Created"), choose("sort", "lastPrompt", "Last prompt")],
    },
    titleSource: {
      title: "Title",
      content: [
        choose("titleSource", "title", "Title", "Type"),
        choose("titleSource", "branch", "Branch name", "GitBranch"),
      ],
    },
    show: {
      title: "Show",
      content: (
        <>
          {ROW_ITEMS.map(([item, label, icon]) => (
            <MenuItem
              key={item}
              icon={icon}
              label={label}
              selected={prefs.rowItems[item]}
              closeOnSelect={false}
              onSelect={() =>
                update((current) => ({
                  ...current,
                  rowItems: { ...current.rowItems, [item]: !current.rowItems[item] },
                }))
              }
            />
          ))}
          <MenuSeparator />
          {trailing("diff", "Diff stats", "Diff")}
          {trailing("timestamp", "Last activity", "Clock")}
        </>
      ),
    },
    hostFilter: {
      title: "Host",
      content: (
        <>
          <MenuItem
            label="All hosts"
            selected={!hostFilters.length}
            closeOnSelect={false}
            onSelect={() => set({ hostFilters: [] })}
          />
          {hosts.map((host) => (
            <MenuItem
              key={host.serverId}
              label={host.label.trim() || host.serverId}
              leading={<View style={[s.hostDot, { backgroundColor: hostColor(host.status) }]} />}
              selected={hostFilters.includes(host.serverId)}
              closeOnSelect={false}
              onSelect={() =>
                update((current) => ({ ...current, hostFilters: toggle(current.hostFilters, host.serverId) }))
              }
            />
          ))}
        </>
      ),
    },
    projectFilter: {
      title: "Project",
      header: (
        <>
          <MenuSearch value={projectQuery} onChange={setProjectQuery} placeholder="Search projects" />
          <View style={s.menuPage}>
            <MenuItem
              label="All projects"
              selected={!projectFilters.length}
              closeOnSelect={false}
              onSelect={() => set({ projectFilters: [] })}
            />
          </View>
          <MenuSeparator />
        </>
      ),
      // A long list keeps one height while it filters, and scrolls.
      listHeight: projects.length > 9 ? 300 : undefined,
      content: matchingProjects.length ? (
        <>
          {matchingProjects.map((group) => (
            <MenuItem
              key={group.key}
              label={group.title ?? group.key}
              leading={
                <ProjectIcon name={group.title ?? group.key} viewKey={group.key} size={14} fontSize={8} />
              }
              selected={projectFilters.includes(group.key)}
              closeOnSelect={false}
              onSelect={() =>
                update((current) => ({ ...current, projectFilters: toggle(projectFilters, group.key) }))
              }
            />
          ))}
        </>
      ) : (
        <Text style={s.menuEmpty}>No projects match</Text>
      ),
    },
    labelFilter: {
      title: "Labels",
      content: (
        <>
          {[
            ...labels.map((group) => [group.key, group.title ?? group.key] as const),
            ["", "Unlabelled"] as const,
          ].map(([key, label]) => (
            <MenuItem
              key={key}
              label={label}
              leading={key ? <View /> : <Icon name="Circle" size={11} color={c.foregroundMuted} />}
              selected={labelFilters.includes(key)}
              closeOnSelect={false}
              onSelect={() => update((current) => ({ ...current, labelFilters: toggle(labelFilters, key) }))}
            />
          ))}
          {labelFilters.length ? (
            <>
              <MenuSeparator />
              <MenuItem
                label="Clear filter"
                closeOnSelect={false}
                onSelect={() => set({ labelFilters: [] })}
              />
            </>
          ) : null}
        </>
      ),
    },
  };

  return (
    <>
      <View ref={anchor} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Display preferences"
          onPress={() => setOpen(true)}
          style={(state: PressState) => [s.displayTrigger, state.hovered && s.hover]}
        >
          <Icon name="Settings2" size={14} color={c.foregroundMuted} />
        </Pressable>
      </View>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false);
          setProjectQuery("");
        }}
        width={232}
        title="Display"
        pages={pages}
      >
        <MenuSubTrigger
          id="grouping"
          label="Grouping"
          value={prefs.grouping === "project" ? "Project" : "Status"}
        />
        {prefs.grouping === "project" ? (
          <MenuSubTrigger
            id="sort"
            label="Sort"
            value={prefs.sort === "created" ? "Created" : "Last prompt"}
          />
        ) : null}
        <MenuSubTrigger
          id="titleSource"
          label="Title"
          value={prefs.titleSource === "title" ? "Title" : "Branch name"}
        />
        <MenuSubTrigger id="show" label="Show" />
        {hosts.length > 1 ? (
          <>
            <MenuSeparator />
            <MenuSubTrigger id="hostFilter" label="Host" indicator={hostFilters.length > 0} />
          </>
        ) : null}
        {projects.length > 1 ? (
          <>
            {hosts.length > 1 ? null : <MenuSeparator />}
            <MenuSubTrigger id="projectFilter" label="Project" indicator={projectFilters.length > 0} />
          </>
        ) : null}
        {labels.length || labelFilters.length ? (
          <>
            <MenuSeparator />
            <MenuSubTrigger id="labelFilter" label="Labels" indicator={labelFilters.length > 0} />
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem
          label="Show background"
          selected={prefs.showBackground}
          closeOnSelect={false}
          onSelect={() => set({ showBackground: !prefs.showBackground })}
        />
      </Menu>
    </>
  );
}
