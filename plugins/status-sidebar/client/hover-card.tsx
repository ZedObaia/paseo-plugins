// Paseo's workspace hover card (components/workspace-hover-card.tsx on ui/hover-card.tsx): beside a
// row on wide layouts it names the workspace and lists its PR, diff, host, branch and path, then
// its CI checks. Branch and path copy on press; the PR and its checks open in the browser.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import * as ReactNative from "react-native";
import { Pressable, Text, View, useWindowDimensions, type ViewStyle } from "react-native";
import { getPaseoClient, openExternalUrl, useHosts, type WorkspaceRef } from "@getpaseo/plugin/client";
import { Icon, copyText } from "@getpaseo/plugin/client/ui";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { PressState } from "./menu";
import {
  CHECK_KINDS,
  checksUrl,
  countChecks,
  formatDiffCount,
  prHint,
  shortenPath,
  type CheckKind,
} from "./model";
import { UiContext, useUi } from "./styles";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the card reads from the host's workspace descriptor (githubRuntime.pullRequest). */
interface PullRequest {
  url: string;
  state: string;
  isMerged?: boolean | null;
  checks?: readonly { status: string; traits?: readonly string[] | null }[] | null;
}

/** Last known PR per workspace, so a card reopens with it while the host is asked again. */
const pullRequests = new Map<string, PullRequest | null>();

/** Paseo keeps one card open at a time: opening one closes the last. */
let closeOpen: (() => void) | null = null;

// The sidebar's containers are transformed and clip their overflow, so nothing a sidebar view
// renders can sit beside the sidebar, and a Modal would trap focus on every hover. The card gets a
// React root of its own on the page instead, through react-native-web's `render`; native layouts
// never show it.
// ponytail: leans on react-native-web's `render` export; a Paseo popover API for views would replace it.
interface Root {
  render(node: ReactNode): void;
}
const renderRoot = (ReactNative as unknown as { render?: (node: ReactNode, container: unknown) => Root })
  .render;
// The client tsconfig has no DOM library; this is the one place the page is touched.
const page = (
  globalThis as {
    document?: { createElement(tag: "div"): unknown; body: { appendChild(node: unknown): void } };
  }
).document;
let root: Root | null = null;

function cardRoot(): Root | null {
  if (root || !renderRoot || !page) return root;
  const container = page.createElement("div");
  page.body.appendChild(container);
  root = renderRoot(null, container);
  return root;
}

/** Closes whatever card is open, as scrolling the list does. */
export function closeHoverCard() {
  closeOpen?.();
}

const CLOSE_GRACE_MS = 100;

/**
 * ui/hover-card.tsx: opens as the pointer enters the row and closes 100ms after it leaves the row
 * or the card, unless it reaches the other first.
 */
export function useHoverCard({
  anchor,
  enabled,
  reference,
  workspace,
}: {
  anchor: RefObject<View | null>;
  enabled: boolean;
  reference: WorkspaceRef;
  workspace: PluginWorkspaceSnapshot | null;
}) {
  const ui = useUi();
  const [rect, setRect] = useState<Rect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = useRef(() => setRect(null)).current;
  const cancel = useRef(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }).current;
  const leave = useRef(() => {
    cancel();
    timer.current = setTimeout(close, CLOSE_GRACE_MS);
  }).current;
  const open = enabled && workspace ? rect : null;
  useEffect(() => {
    if (!open || !workspace) return;
    cardRoot()?.render(
      <UiContext.Provider value={ui}>
        <HoverCard
          key={reference.key}
          rect={open}
          reference={reference}
          workspace={workspace}
          onEnter={cancel}
          onLeave={leave}
        />
      </UiContext.Provider>,
    );
  }, [open, workspace, reference, ui]);
  const shown = open !== null;
  useEffect(() => {
    if (!shown) return;
    return () => root?.render(null);
  }, [shown]);
  useEffect(
    () => () => {
      cancel();
      if (closeOpen === close) closeOpen = null;
    },
    [],
  );
  return {
    enter() {
      cancel();
      if (!enabled) return;
      if (closeOpen !== close) closeOpen?.();
      closeOpen = close;
      anchor.current?.measureInWindow((x, y, width, height) => setRect({ x, y, width, height }));
    },
    leave,
  };
}

// react-native-web passes `fixed` through to CSS.
const FIXED = { position: "fixed", zIndex: 1000 } as unknown as ViewStyle;
const CARD_WIDTH = 260;

function HoverCard({
  rect,
  reference,
  workspace,
  onEnter,
  onLeave,
}: {
  rect: Rect;
  reference: WorkspaceRef;
  workspace: PluginWorkspaceSnapshot;
  onEnter(): void;
  onLeave(): void;
}) {
  const { s, c, p } = useUi();
  const window = useWindowDimensions();
  const hosts = useHosts();
  const [height, setHeight] = useState(0);
  const [pr, setPr] = useState(pullRequests.get(reference.key) ?? null);
  useEffect(() => {
    let live = true;
    getPaseoClient(reference.hostId)
      .workspaces.ref(reference.id)
      .refresh()
      .then((fresh) => {
        const next = fresh?.githubRuntime?.pullRequest ?? null;
        pullRequests.set(reference.key, next);
        if (live) setPr(next);
      })
      // ponytail: a host that can't answer leaves the card without its PR, as when it has none.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [reference]);

  const hint = pr ? prHint(pr) : null;
  const checks = pr?.checks?.length ? countChecks(pr.checks) : null;
  const host = hosts.find((entry) => entry.serverId === reference.hostId);
  const branch =
    workspace.branch?.trim() && workspace.branch.trim() !== "HEAD" ? workspace.branch.trim() : null;
  const stateColor =
    hint?.state === "open" ? c.statusSuccess : hint?.state === "merged" ? p.merged : c.statusDanger;
  const position = {
    left: rect.x + rect.width + 4,
    top: Math.max(8, Math.min(rect.y, window.height - height - 8)),
  };

  return (
    <View
      role="menu"
      accessibilityLabel="Workspace details"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      style={[FIXED, s.hoverCard, position, { width: CARD_WIDTH, opacity: height ? 1 : 0 }]}
    >
      <Text style={s.hoverCardTitle}>{workspace.name}</Text>
      {hint && pr ? (
        <LinkRow
          icon={
            hint.state === "merged"
              ? "GitMerge"
              : hint.state === "open"
                ? "GitPullRequest"
                : "GitPullRequestClosed"
          }
          color={stateColor}
          label={`#${hint.number}`}
          url={pr.url}
          accessibilityLabel={`Pull request #${hint.number}`}
        />
      ) : null}
      {workspace.diffStat ? (
        <View style={s.hoverCardRow}>
          <Icon name="FileDiff" size={12} color={c.foregroundMuted} />
          <Text style={s.additions}>+{formatDiffCount(workspace.diffStat.additions)}</Text>
          <Text style={s.deletions}>-{formatDiffCount(workspace.diffStat.deletions)}</Text>
        </View>
      ) : null}
      <View style={s.hoverCardRow}>
        <Icon name="Server" size={12} color={c.foregroundMuted} />
        <Text numberOfLines={1} style={s.hoverCardText}>
          {host?.label.trim() || reference.hostId}
        </Text>
      </View>
      {branch ? <CopyRow icon="GitBranch" label={branch} value={branch} what="branch name" /> : null}
      <CopyRow
        icon="Folder"
        label={shortenPath(workspace.directory)}
        value={workspace.directory}
        what="path"
      />
      {checks && pr ? (
        <>
          <View style={s.hoverCardSeparator} />
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Checks"
            onPress={() => void openExternalUrl(checksUrl(pr.url))}
            style={(state: PressState) => [
              s.hoverCardChecks,
              state.hovered && { backgroundColor: c.surface2 },
            ]}
          >
            {(state: PressState) => (
              <>
                <Icon
                  name={state.hovered ? "ExternalLink" : "Github"}
                  size={12}
                  color={state.hovered ? c.foreground : c.foregroundMuted}
                />
                <Text style={[s.hoverCardLabel, state.hovered && { color: c.foreground }]}>Checks</Text>
                <View style={s.hoverCardCounts}>
                  {CHECK_KINDS.map((kind) =>
                    checks[kind] ? <CheckCount key={kind} kind={kind} count={checks[kind]} /> : null,
                  )}
                </View>
              </>
            )}
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

/** git/check-presentation.view.tsx: each kind's icon and tone. */
const CHECK_LOOK: Record<
  CheckKind,
  { icon: string; tone: "statusSuccess" | "statusDanger" | "statusWarning" | null }
> = {
  success: { icon: "CircleCheck", tone: "statusSuccess" },
  failure: { icon: "CircleX", tone: "statusDanger" },
  warning: { icon: "CircleX", tone: "statusWarning" },
  actionRequired: { icon: "CircleAlert", tone: "statusWarning" },
  manual: { icon: "CirclePause", tone: null },
  pending: { icon: "CircleDot", tone: "statusWarning" },
};

function CheckCount({ kind, count }: { kind: CheckKind; count: number }) {
  const { s, c } = useUi();
  const { icon, tone } = CHECK_LOOK[kind];
  const color = tone ? c[tone] : c.foregroundMuted;
  return (
    <View style={s.hoverCardCount}>
      <Icon name={icon} size={12} color={color} />
      <Text style={[s.hoverCardLabel, { color }]}>{count}</Text>
    </View>
  );
}

/** The PR row: its state glyph, or the external-link glyph under the pointer. */
function LinkRow({
  icon,
  color,
  label,
  url,
  accessibilityLabel,
}: {
  icon: string;
  color: string;
  label: string;
  url: string;
  accessibilityLabel: string;
}) {
  const { s, c } = useUi();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      hitSlop={4}
      onPress={() => void openExternalUrl(url)}
      style={s.hoverCardRow}
    >
      {(state: PressState) => (
        <>
          <Icon
            name={state.hovered ? "ExternalLink" : icon}
            size={12}
            color={state.hovered ? c.foreground : color}
          />
          <Text numberOfLines={1} style={[s.hoverCardText, state.hovered && { color: c.foreground }]}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** CopyableInfoRow: the copy glyph under the pointer, a check for two seconds once copied. */
function CopyRow({ icon, label, value, what }: { icon: string; label: string; value: string; what: string }) {
  const { s, c } = useUi();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy ${what}`}
      hitSlop={4}
      onPress={() => void copyText(value).then(() => setCopied(true))}
      style={s.hoverCardRow}
    >
      {(state: PressState) => {
        const lit = copied || state.hovered;
        return (
          <>
            <Icon
              name={copied ? "Check" : state.hovered ? "Copy" : icon}
              size={12}
              color={lit ? c.foreground : c.foregroundMuted}
            />
            <Text numberOfLines={1} style={[s.hoverCardText, lit && { color: c.foreground }]}>
              {label}
            </Text>
          </>
        );
      }}
    </Pressable>
  );
}
