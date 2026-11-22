// The default view's rows: section headers, project rows, workspace rows and the plain rows that
// end a group (sidebar-workspace-list.tsx, sidebar/sidebar-workspace-row-content.tsx and friends).

import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Animated, Easing, Platform, Pressable, Text, View } from "react-native";
import {
  getPaseoClient,
  useAgent,
  useAgents,
  usePaseo,
  useWorkspace,
  type PluginSidebarViewProps,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { z } from "zod";
import type { preferences } from "../shared/preferences";
import { useHoverCard } from "./hover-card";
import { Menu, MenuItem, type PressState } from "./menu";
import { ProgressLine, useAgentWork, type AgentWork } from "./progress";
import {
  STATUS_LABELS,
  archiveRisks,
  compactTimeAgo,
  formatDiffCount,
  identityColor,
  limitGroup,
  projectInitial,
  type Bucket,
} from "./model";
import { UiContext, useUi } from "./styles";

export type Prefs = z.output<typeof preferences.schema>;

export interface Sidebar {
  view: PluginSidebarViewProps;
  prefs: Prefs;
  update(change: (prefs: Prefs) => Prefs): void;
  /** The host filter, or undefined for every host. */
  scope: readonly string[] | undefined;
  /** A workspace's project view key. */
  projectOf(workspace: PluginWorkspaceSnapshot): string;
  /** The background, project and label filters. */
  visible(workspace: PluginWorkspaceSnapshot): boolean;
  /** Host labels by host id; empty while the sidebar spans one host. */
  hostBadges: ReadonlyMap<string, string>;
  /** Running devices' names by workspace id, from the Devices plugin. */
  devices: ReadonlyMap<string, readonly string[]>;
  toggleCollapsed(key: string): void;
}

export const SidebarContext = createContext<Sidebar | null>(null);

export function useSidebar(): Sidebar {
  const sidebar = useContext(SidebarContext);
  if (!sidebar) throw new Error("SidebarContext is missing");
  return sidebar;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A section label with its fold chevron, and its actions (bell, display menu) on the right. */
export function SectionHeader({
  title,
  collapsed = false,
  onToggle,
  children,
}: {
  title: string;
  collapsed?: boolean;
  onToggle?(): void;
  children?: ReactNode;
}) {
  const { s, c, iconXs } = useUi();
  const label = (
    <>
      {onToggle ? (
        <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={iconXs} color={c.foregroundMuted} />
      ) : null}
      <Text style={s.headerTitle}>{title}</Text>
    </>
  );
  return (
    <View style={s.header}>
      {onToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          onPress={onToggle}
          style={s.headerToggle}
        >
          {label}
        </Pressable>
      ) : (
        <View style={s.headerToggle}>{label}</View>
      )}
      {children ? <View style={s.headerActions}>{children}</View> : null}
    </View>
  );
}

/** "Show more", "Show less" and "New workspace": a workspace row's geometry with an icon and a label. */
export function PlainRow({
  icon,
  label,
  accessibilityLabel = label,
  indented = false,
  onPress,
}: {
  icon: string;
  label: string;
  accessibilityLabel?: string;
  indented?: boolean;
  onPress(): void;
}) {
  const { s, c, iconSm } = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={(state: PressState) => [
        s.plainRow,
        indented && s.indented,
        state.hovered && !state.pressed && s.hover,
        state.pressed && s.pressed,
      ]}
    >
      {(state: PressState) => (
        <>
          <View style={s.iconSlot}>
            <Icon
              name={icon}
              size={iconSm}
              color={state.hovered || state.pressed ? c.foreground : c.foregroundMuted}
            />
          </View>
          <Text numberOfLines={1} style={state.hovered || state.pressed ? s.plainTextHovered : s.plainText}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** A truncated group: the first `limit` rows plus every `keep` row, then Show more / Show less. */
export function GroupRows({
  refs,
  limit,
  keep,
  withProject = false,
  indented = false,
}: {
  refs: readonly WorkspaceRef[];
  limit: number;
  keep?(ref: WorkspaceRef): boolean;
  withProject?: boolean;
  indented?: boolean;
}) {
  const { view } = useSidebar();
  const [expanded, setExpanded] = useState(false);
  const open = view.active.workspace?.key;
  const group = limitGroup(refs, { limit, expanded, keep, isOpen: (ref) => ref.key === open });
  return (
    <>
      {[...(group.leading ? [group.leading] : []), ...group.visible].map((ref) => (
        <WorkspaceRow key={ref.key} reference={ref} withProject={withProject} indented={indented} />
      ))}
      {group.canToggle ? (
        <PlainRow
          icon={expanded ? "ChevronUp" : "ChevronDown"}
          label={expanded ? "Show less" : "Show more"}
          indented={indented}
          onPress={() => setExpanded((value) => !value)}
        />
      ) : null}
    </>
  );
}

export function ProjectIcon({
  name,
  viewKey,
  size,
  fontSize = 9,
}: {
  name: string;
  viewKey: string;
  size: number;
  fontSize?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.25),
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: identityColor(viewKey),
      }}
    >
      <Text style={{ color: "#ffffff", fontSize }}>{projectInitial(name)}</Text>
    </View>
  );
}

/** Running: a dot inside a turning ring (components/status-ring). */
export function StatusRing({ backdrop }: { backdrop?: string }) {
  const { s, p } = useUi();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== "web",
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const circle = { position: "absolute", width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 } as const;
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <View
      style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: backdrop,
      }}
    >
      <View style={[circle, { borderColor: p.dot.running, opacity: 0.3 }]} />
      <Animated.View
        style={[
          circle,
          {
            borderColor: "transparent",
            borderTopColor: p.dot.running,
            opacity: 0.9,
            transform: [{ rotate }],
          },
        ]}
      />
      <View style={[s.dot, { backgroundColor: p.dot.running }]} />
    </View>
  );
}

/** Needs input: lucide's CircleAlert filled amber, its strokes knocked out in surface0. */
export function NeedsInputIcon() {
  const { c, p } = useUi();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="${p.dot.needs_input}" stroke="${c.surface0}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;
  return <Icon icon={{ svg }} size={12} color={c.surface0} />;
}

/** The project square with its status in a knocked-out corner badge (project-leading-visual.tsx). */
function ProjectIndicator({
  name,
  viewKey,
  status,
  backdrop,
}: {
  name: string;
  viewKey: string;
  status: Bucket | null;
  backdrop: string;
}) {
  const { s, p, iconMd } = useUi();
  return (
    <View style={s.leadingSlot}>
      <View style={s.iconBox}>
        <ProjectIcon name={name} viewKey={viewKey} size={iconMd} />
        {status === "running" ? (
          <View role="status" accessibilityLabel={STATUS_LABELS.running} style={s.ringAnchor}>
            <StatusRing backdrop={backdrop} />
          </View>
        ) : status && status !== "done" ? (
          <View
            role="status"
            accessibilityLabel={STATUS_LABELS[status]}
            style={[s.badge, { backgroundColor: backdrop }]}
          >
            {status === "needs_input" ? (
              <NeedsInputIcon />
            ) : (
              <View style={[s.dot, { backgroundColor: p.dot[status] }]} />
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A workspace row's own status slot under its project (sidebar-workspace-row-content.tsx). */
function WorkspaceIndicator({
  bucket,
  kind,
  busy,
}: {
  bucket: Bucket;
  kind: PluginWorkspaceSnapshot["kind"];
  busy: boolean;
}) {
  const { s, c, p, iconSm } = useUi();
  let mark: ReactElement;
  if (busy || bucket === "running") mark = <StatusRing />;
  else if (bucket === "needs_input") mark = <NeedsInputIcon />;
  else if (bucket === "attention") mark = <View style={[s.dot, { backgroundColor: p.dot.attention }]} />;
  else if (bucket === "done") mark = <View style={s.idleDot} />;
  else {
    const icon = kind === "local_checkout" ? "Monitor" : kind === "worktree" ? "FolderGit2" : "Folder";
    mark = (
      <>
        <Icon name={icon} size={iconSm} color={c.foregroundMuted} />
        <View style={s.dotOverlay} />
      </>
    );
  }
  return <View style={s.leadingSlot}>{mark}</View>;
}

/** Ticks once a minute on its own, so the clock never re-renders the row. */
function Timestamp({ iso }: { iso: string }) {
  const { s } = useUi();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text numberOfLines={1} style={s.timestamp}>
      {compactTimeAgo(iso, now)}
    </Text>
  );
}

/** linear-gradient stand-in for TrailingActionScrim: the row fill fades in over 26pt, then holds. */
function Scrim({ width, color }: { width: number; color: string }) {
  const steps = 8;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: 0, bottom: 0, right: 0, width, flexDirection: "row" }}
    >
      {Array.from({ length: steps }, (_, step) => (
        <View
          key={step}
          style={{ width: 26 / steps, backgroundColor: color, opacity: (step + 1) / (steps + 1) }}
        />
      ))}
      <View style={{ flex: 1, backgroundColor: color }} />
    </View>
  );
}

/** The line under a title: branch, project, host and labels, separated by dots (workspace-meta-row). */
function MetaRow({
  branch,
  project,
  host,
  labels,
}: {
  branch: string | null;
  project: string | null;
  host: string | undefined;
  labels: readonly string[];
}) {
  const { s, c } = useUi();
  const { prefs } = useSidebar();
  const identity = (icon: string, text: string, style = s.metaItem) => (
    <View style={style}>
      <Icon name={icon} size={12} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={s.metaText}>
        {text}
      </Text>
    </View>
  );
  const items: [string, ReactElement][] = [];
  if (branch && prefs.rowItems.branch) items.push(["branch", identity("GitBranch", branch)]);
  if (project && prefs.rowItems.project) items.push(["project", identity("Folder", project)]);
  // ponytail: Paseo hides the local host's badge and colors each host; plugins know neither.
  if (host) items.push(["host", identity("Server", host, s.hostBadge)]);
  if (labels.length && prefs.rowItems.labels)
    items.push([
      "labels",
      <View style={[s.labels, items.length === 0 && s.labelsLeading]}>
        {labels.map((label) => (
          <View key={label} style={s.chip}>
            <Text numberOfLines={1} style={s.metaText}>
              {label}
            </Text>
          </View>
        ))}
      </View>,
    ]);
  if (items.length === 0) return null;
  return (
    <View style={s.meta}>
      {items.map(([key, item], index) => (
        <Fragment key={key}>
          {index > 0 ? <Text style={s.separator}>·</Text> : null}
          {item}
        </Fragment>
      ))}
    </View>
  );
}

/** Enter and blur commit, Escape cancels; one outcome per edit. */
function TitleEditor({
  initial,
  placeholder,
  onDone,
}: {
  initial: string;
  placeholder: string;
  onDone(text: string | null): void;
}) {
  const { s, c } = useUi();
  const draft = useRef(initial);
  const settled = useRef(false);
  const finish = (text: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(text);
  };
  return (
    <TextInput
      autoFocus
      selectTextOnFocus
      defaultValue={initial}
      placeholder={placeholder}
      placeholderTextColor={c.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      onChangeText={(text) => (draft.current = text)}
      onSubmitEditing={() => finish(draft.current)}
      onBlur={() => finish(draft.current)}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Escape") finish(null);
      }}
      style={s.titleEditor}
    />
  );
}

function Button({ label, danger = false, onPress }: { label: string; danger?: boolean; onPress(): void }) {
  const { s } = useUi();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[s.button, danger && s.buttonDanger]}>
      <Text style={[s.buttonText, danger && { color: "#ffffff" }]}>{label}</Text>
    </Pressable>
  );
}

function WorkspaceRow({
  reference,
  withProject = false,
  indented = false,
}: {
  reference: WorkspaceRef;
  /** Pinned and status rows lead with their project's square; project rows with their status. */
  withProject?: boolean;
  /** Status rows sit on their group header's label rail. */
  indented?: boolean;
}) {
  const { s, c, p, touch, iconSm } = useUi();
  const { view, prefs, projectOf, hostBadges, devices } = useSidebar();
  const paseo = usePaseo();
  const toast = useToast();
  const workspace = useWorkspace(reference);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  /** What archiving would lose, while the confirmation is open. */
  const [risks, setRisks] = useState<string[] | null>(null);
  const [archiving, setArchiving] = useState(false);
  const kebab = useRef<View>(null);
  const row = useRef<View>(null);
  /** The working agent's progress and tasks, from RunningProgress, for the hover card. */
  const [work, setWork] = useState<AgentWork | null>(null);
  const card = useHoverCard({
    anchor: row,
    enabled: !touch && !menuOpen && !renaming && !risks,
    reference,
    workspace: workspace ?? null,
    work: workspace?.indicator === "running" ? work : null,
  });
  if (!workspace) return null;

  const handle = paseo.workspaces.ref(reference);
  const branch =
    workspace.branch?.trim() && workspace.branch.trim() !== "HEAD" ? workspace.branch.trim() : null;
  const title = prefs.titleSource === "branch" ? (branch ?? workspace.name) : workspace.name;
  const selected = view.active.workspace?.key === reference.key;
  const busy = archiving || workspace.archivingAt !== null;
  const pinned = workspace.pinnedAt !== null;
  const device = devices.get(reference.id);
  const editing = renaming && !touch;
  const rowHovered = hovered && !editing;
  const project = withProject ? workspace.projectDisplayName : null;
  const host = prefs.rowItems.host ? hostBadges.get(workspace.hostId) : undefined;
  const { diffStat, statusEnteredAt } = workspace;
  const trailing =
    prefs.trailing === "diff" && diffStat ? (
      <View style={s.diff}>
        <Text style={s.additions}>+{formatDiffCount(diffStat.additions)}</Text>
        <Text style={s.deletions}>-{formatDiffCount(diffStat.deletions)}</Text>
      </View>
    ) : prefs.trailing === "timestamp" && statusEnteredAt ? (
      <Timestamp iso={statusEnteredAt} />
    ) : null;
  // Touch keeps the kebab in the slot for good and drops the trailing content for it.
  const showKebab = rowHovered || touch || menuOpen;
  const showContent = trailing !== null && !touch;

  const copy = (text: string, done: string) =>
    copyText(text).then(
      () => toast.show(done),
      (error: unknown) => toast.error(message(error)),
    );
  const archiveNow = async () => {
    setRisks(null);
    setArchiving(true);
    try {
      const result = await handle.archive();
      if (result.error) toast.error(result.error);
    } catch (error) {
      toast.error(message(error));
    } finally {
      setArchiving(false);
    }
  };
  // use-workspace-archive.ts: archiving removes a worktree with its uncommitted work, so ask the
  // host what that would lose and confirm only then. Git state it can't report asks too.
  const archive = async () => {
    if (busy) return;
    if (workspace.kind !== "worktree") return archiveNow();
    try {
      const fresh = await getPaseoClient(reference.hostId).workspaces.ref(reference.id).refresh();
      const git = fresh?.gitRuntime;
      const found = git ? archiveRisks(git, diffStat) : ["Its git state couldn't be read"];
      if (found.length) setRisks(found);
      else await archiveNow();
    } catch (error) {
      toast.error(message(error));
    }
  };
  const rename = (text: string | null) => {
    setRenaming(false);
    const next = text?.trim();
    if (!next || next === (workspace.title ?? workspace.name)) return;
    handle.setTitle(next).catch((error: unknown) => toast.error(message(error)));
  };

  return (
    <View
      ref={row}
      style={{ position: "relative" }}
      onPointerEnter={() => {
        setHovered(true);
        card.enter();
      }}
      onPointerLeave={() => {
        setHovered(false);
        card.leave();
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={[
          project,
          title,
          host,
          workspace.indicator === "done" ? null : workspace.indicatorLabel,
        ]
          .filter(Boolean)
          .join(", ")}
        disabled={busy}
        onPress={editing ? undefined : () => view.navigation.openWorkspace(reference)}
        style={({ pressed }) => [
          s.workspaceRow,
          indented && s.indented,
          rowHovered && s.hover,
          selected && s.selected,
          pressed && s.pressed,
        ]}
      >
        {({ pressed }) => {
          const backdrop = pressed ? c.surface2 : selected ? p.selected : rowHovered ? p.hover : p.sidebar;
          return (
            <View style={s.workspaceMain}>
              {withProject ? (
                <ProjectIndicator
                  name={workspace.projectDisplayName}
                  viewKey={projectOf(workspace)}
                  status={busy ? "running" : workspace.indicator}
                  backdrop={backdrop}
                />
              ) : (
                <WorkspaceIndicator bucket={workspace.indicator} kind={workspace.kind} busy={busy} />
              )}
              <View style={s.column}>
                <View style={s.titleRow}>
                  {editing ? (
                    <TitleEditor
                      initial={workspace.title ?? workspace.name}
                      placeholder={workspace.name}
                      onDone={rename}
                    />
                  ) : (
                    <Text numberOfLines={1} style={[s.title, rowHovered && s.titleHovered]}>
                      {title}
                    </Text>
                  )}
                  <View style={s.rowRight}>
                    {device ? (
                      <View style={s.pinMark} accessibilityLabel={`Running ${device.join(", ")}`}>
                        <Icon name="Smartphone" size={12} color={c.foregroundMuted} />
                      </View>
                    ) : null}
                    {/* Pinned rows sit with the projects, under no "Pinned" heading, so they carry the mark. */}
                    {pinned ? (
                      <View style={s.pinMark} accessibilityLabel="Pinned">
                        <Icon name="Pin" size={12} color={p.extraMuted} />
                      </View>
                    ) : null}
                    <View style={[s.trailingSlot, (showContent || touch) && s.trailingReserved]}>
                      {showContent ? trailing : null}
                      {showKebab ? (
                        <>
                          {rowHovered && !touch ? <Scrim width={48 + 26} color={backdrop} /> : null}
                          <View style={s.overlay}>
                            {rowHovered && !touch ? (
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Archive workspace"
                                hitSlop={4}
                                onPress={archive}
                                style={(state: PressState) => [
                                  s.archiveButton,
                                  state.hovered && s.kebabHovered,
                                ]}
                              >
                                {(state: PressState) => (
                                  <Icon
                                    name="Archive"
                                    size={iconSm}
                                    color={state.hovered ? c.foreground : c.foregroundMuted}
                                  />
                                )}
                              </Pressable>
                            ) : null}
                            <Pressable
                              ref={kebab}
                              accessibilityRole="button"
                              accessibilityLabel="Workspace actions"
                              hitSlop={8}
                              onPress={() => setMenuOpen(true)}
                              style={(state: PressState) => [s.kebab, state.hovered && s.kebabHovered]}
                            >
                              {(state: PressState) => (
                                <Icon
                                  name="MoreVertical"
                                  size={iconSm}
                                  color={state.hovered ? c.foreground : c.foregroundMuted}
                                />
                              )}
                            </Pressable>
                          </View>
                        </>
                      ) : null}
                    </View>
                  </View>
                </View>
                <MetaRow branch={branch} project={project} host={host} labels={workspace.labels} />
                {workspace.indicator === "running" ? (
                  <RunningProgress reference={reference} onWork={setWork} />
                ) : null}
              </View>
            </View>
          );
        }}
      </Pressable>
      {menuOpen ? (
        <Menu anchor={kebab} open onClose={() => setMenuOpen(false)} width={260} title="Workspace actions">
          <MenuItem icon="Copy" label="Copy path" onSelect={() => copy(workspace.directory, "Path copied")} />
          {workspace.projectKind === "git" && branch ? (
            <MenuItem
              icon="Copy"
              label="Copy branch name"
              onSelect={() => copy(branch, "Branch name copied")}
            />
          ) : null}
          <MenuItem icon="Pencil" label="Rename workspace" onSelect={() => setRenaming(true)} />
          <MenuItem
            icon={pinned ? "PinOff" : "Pin"}
            label={pinned ? "Unpin" : "Pin to top"}
            onSelect={() => handle.setPinned(!pinned).catch((error: unknown) => toast.error(message(error)))}
          />
          <MenuItem
            icon="Archive"
            label={busy ? "Archiving..." : "Archive"}
            disabled={busy}
            onSelect={archive}
          />
        </Menu>
      ) : null}
      {renaming && touch ? <RenameModal initial={workspace.title ?? workspace.name} onDone={rename} /> : null}
      {risks ? (
        <Dialog title={`Archive "${title}"?`} onClose={() => setRisks(null)}>
          {risks.map((risk) => (
            <Text key={risk} style={s.cardText}>
              {risk}
            </Text>
          ))}
          <View style={s.cardActions}>
            <Button label="Cancel" onPress={() => setRisks(null)} />
            <Button label="Archive" danger onPress={() => void archiveNow()} />
          </View>
        </Dialog>
      ) : null}
    </View>
  );
}

/** A running workspace's newest agent: its bot status or task list, under the row. */
function RunningProgress({
  reference,
  onWork,
}: {
  reference: WorkspaceRef;
  onWork(work: AgentWork | null): void;
}) {
  const running = useAgents({
    where: (agent) => agent.workspace.key === reference.key && agent.status === "running",
    orderBy: ["lastActivityAt", "desc"],
  });
  const work = useAgentWork(useAgent(running[0] ?? ""));
  useEffect(() => onWork(work), [work]);
  useEffect(() => () => onWork(null), []);
  return work.progress ? <ProgressLine progress={work.progress} /> : null;
}

/** Touch layouts rename in a modal (workspace-rename/internal/modal.tsx). */
function RenameModal({ initial, onDone }: { initial: string; onDone(text: string | null): void }) {
  const { s, c } = useUi();
  const [text, setText] = useState(initial);
  return (
    <Dialog title="Rename workspace" onClose={() => onDone(null)}>
      <TextInput
        autoFocus
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => onDone(text)}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: c.foreground,
          fontSize: 14,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 8,
          padding: 12,
        }}
      />
      <View style={s.cardActions}>
        <Button label="Rename" onPress={() => onDone(text)} />
      </View>
    </Dialog>
  );
}

/** The kit's Modal shows touch layouts in an isolated sheet, so its content is handed the Ui context again. */
function Dialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ui = useUi();
  return (
    <Modal title={title} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <UiContext.Provider value={ui}>{children}</UiContext.Provider>
      </Modal.Content>
    </Modal>
  );
}

export function ProjectRow({
  name,
  viewKey,
  collapsed,
  status,
  onToggle,
  onNew,
}: {
  name: string;
  viewKey: string;
  collapsed: boolean;
  /** The most urgent workspace status, shown while collapsed. */
  status: Bucket | null;
  onToggle(): void;
  onNew(): void;
}) {
  const { s, c, p, touch } = useUi();
  const [hovered, setHovered] = useState(false);
  const actions = hovered || touch;
  return (
    <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        onPress={onToggle}
        style={({ pressed }) => [s.projectRow, hovered && s.hover, pressed && s.pressed]}
      >
        {({ pressed }) => (
          <>
            <View style={s.rowLeft}>
              {hovered ? (
                <View style={s.leadingSlot}>
                  <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={14} color="#9ca3af" />
                </View>
              ) : (
                <ProjectIndicator
                  name={name}
                  viewKey={viewKey}
                  status={status}
                  backdrop={pressed ? c.surface2 : p.sidebar}
                />
              )}
              <Text numberOfLines={1} style={s.mutedLabel}>
                {name}
              </Text>
            </View>
            <View style={s.projectActions}>
              <View
                style={[s.iconAction, !actions && { opacity: 0 }]}
                pointerEvents={actions ? "auto" : "none"}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Create a new workspace for ${name}`}
                  onPress={onNew}
                  style={(state: PressState) => [s.iconAction, (state.hovered || state.pressed) && s.hover]}
                >
                  {(state: PressState) => (
                    <Icon
                      name="Plus"
                      size={15}
                      color={state.hovered || state.pressed ? c.foreground : c.foregroundMuted}
                    />
                  )}
                </Pressable>
              </View>
            </View>
          </>
        )}
      </Pressable>
    </View>
  );
}
