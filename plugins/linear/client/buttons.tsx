import type {
  PluginButton,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { chatsRpc, type ChatIssue } from "../shared/contracts";
import type { ChatStore } from "./chats";
import { LinearLogo } from "./logo";
import { sendIssue } from "./send";

const Logo = ({ size, color, layout }: PluginButtonIconProps) => (
  <LinearLogo size={size} color={color} platform={layout.platform} />
);

// another app can give a chat its issue: the pills catch up this often
const POLL_MS = 60_000;
// a new chat shows up just before the daemon remembers its issue, if it has one
const SETTLE_MS = 1_000;

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}

/** What a pill says: the chat's issue, or that it can have one. */
const presentation = (issue: ChatIssue | null): Pick<PluginButton, "title" | "label"> =>
  issue
    ? // pills are narrow; the logo says Linear
      { title: `Linear issue ${issue.identifier}: ${issue.title}`, label: issue.identifier }
    : { title: "Work on a Linear issue", label: "Work on an issue" };
const keyOf = (issue: ChatIssue | null) => (issue ? `${issue.identifier} ${issue.title}` : "");

/**
 * A Linear pill above every agent's composer, following the agents as they come and go: "Work on
 * an issue", or the chat's issue once it has one.
 */
export function sendPills(client: PluginClientContext, store: ChatStore): () => void {
  const pills = new Map<
    string,
    { workspaceId: string; registration: PluginButtonRegistration; shows: string }
  >();
  const lifetime = new AbortController();
  const SendIssue = sendIssue(store);

  let settling: ReturnType<typeof setTimeout> | null = null;
  const refresh = () =>
    void store
      .refresh(async () => (await client.rpc(chatsRpc, {})).chats)
      .catch((error: unknown) => {
        if (!lifetime.signal.aborted) console.error("Linear: reading chats' issues failed:", error);
      });
  const refreshSoon = () => {
    if (settling) clearTimeout(settling);
    settling = setTimeout(refresh, SETTLE_MS);
  };
  // each chat asked about once, when it first shows up
  const seen = new Set<string>();
  const poll = setInterval(refresh, POLL_MS);
  const unsubscribe = store.subscribe(() => {
    for (const [agentId, pill] of pills) {
      const issue = store.get(agentId);
      // touching a pill closes its popover: only when what it says changes
      if (keyOf(issue) === pill.shows) continue;
      pill.shows = keyOf(issue);
      pill.registration.update(presentation(issue));
    }
  });

  const hide = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };
  const show = (agent: AgentLike) => {
    if (lifetime.signal.aborted) return;
    if (!agent.workspaceId || agent.archivedAt) return hide(agent.id);
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      refreshSoon();
    }
    // agents update all the time while they work, and touching a pill closes its popover
    if (pills.get(agent.id)?.workspaceId === agent.workspaceId) return;
    hide(agent.id);
    const issue = store.get(agent.id);
    const registration = client.addComposerPill({
      id: "send-issue",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        ...presentation(issue),
        icon: Logo,
        behavior: { kind: "popover", Content: SendIssue },
      },
    });
    pills.set(agent.id, { workspaceId: agent.workspaceId, registration, shows: keyOf(issue) });
  };

  refresh();
  void client.paseo.agents
    .list({ subscribe: {}, page: { limit: 200 }, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const current = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of [...pills.keys()]) if (!current.has(agentId)) hide(agentId);
          for (const { agent } of entries) show(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") show(update.agent);
          else hide(update.agentId);
        },
      });
      lifetime.signal.addEventListener("abort", () => void subscription.release());
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("Linear: watching agents failed:", error);
    });

  return () => {
    lifetime.abort();
    if (settling) clearTimeout(settling);
    clearInterval(poll);
    unsubscribe();
    for (const agentId of [...pills.keys()]) hide(agentId);
  };
}

/**
 * A Linear button in every workspace's header, opening the board as a tab: the one way in on narrow
 * windows and phones, where Paseo's tab bar has no "+".
 */
export function headerButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  let stopped = false;
  let release: (() => Promise<void>) | undefined;

  const hide = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };
  const show = (workspaceId: string) => {
    if (stopped || buttons.has(workspaceId)) return;
    const registration = client.addHeaderButton({
      id: "linear",
      workspaceId,
      button: {
        title: "Linear issues",
        icon: Logo,
        behavior: {
          kind: "action",
          onPress: () => client.openPanel("linear-tab", { workspaceId, location: "workspace" }),
        },
      },
    });
    buttons.set(workspaceId, registration);
  };

  void client.paseo.workspaces
    .list({ subscribe: {}, page: { limit: 200 } })
    .then(({ subscription }) => {
      release = () => subscription.release();
      if (stopped) return void release();
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const current = new Set(entries.map((workspace) => workspace.id));
          for (const workspaceId of [...buttons.keys()]) if (!current.has(workspaceId)) hide(workspaceId);
          for (const workspace of entries) show(workspace.id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") show(update.workspace.id);
          else hide(update.id);
        },
      });
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Linear: watching workspaces failed:", error);
    });

  return () => {
    stopped = true;
    void release?.();
    for (const workspaceId of [...buttons.keys()]) hide(workspaceId);
  };
}
