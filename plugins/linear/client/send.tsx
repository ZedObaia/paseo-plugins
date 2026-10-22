import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, type TextInput as NativeTextInput } from "react-native";
import { chatIssueOf, issueAttachment, issueMessage, setChatRpc, type SearchItem } from "../shared/contracts";
import type { ChatStore } from "./chats";
import { errorMessage, useIssueNow } from "./data";
import { fieldStyle, FOCUS_DELAY_MS, InputBar, IssueRow, IssueSearch } from "./search";

const WIDTH = 380;
// fixed, so the app places the popover right on its first measure, before results arrive
const HEIGHT = 360;
// the app pads plugin popovers by 12; the list runs edge to edge like its own pickers
const HOST_PADDING = 12;

/**
 * The pill's popover: the chat's issue, to send again as it is now or to change, else Linear's
 * search to give the chat one, sending it with a message if you like.
 */
export function sendIssue(store: ChatStore) {
  return function SendIssue({ theme, host, layout, close, ...props }: PluginButtonContentProps) {
    const c = theme.colors;
    const agentId = props.context === "agent" ? props.agentId : "";
    const paseo = usePaseo();
    const toast = useToast();
    const setChat = useRpc(setChatRpc);
    const status = useAgent(agentId, (agent) => agent.status);
    const current = useSyncExternalStore(store.subscribe, () => store.get(agentId));
    const [changing, setChanging] = useState(false);
    const [draft, setDraft] = useState("");
    const [picked, setPicked] = useState<SearchItem | null>(null);
    const [note, setNote] = useState("");
    const [pending, setPending] = useState(false);
    const input = useRef<NativeTextInput>(null);
    const searching = !current || changing;
    // the chat's issue as Linear has it now: an identifier finds just that issue
    const latest = useIssueNow(host.id, current?.identifier ?? "", !!current && !searching);
    // only what Linear just answered: back from Change, the earlier answer stays until it refreshes
    const fresh =
      latest.isFetching || latest.isError
        ? null
        : (latest.data?.find((issue) => issue.id === current?.id) ?? null);
    const shown: SearchItem | null =
      picked ?? (current && !searching ? (fresh ?? { ...current, text: "", resourceType: "issue" }) : null);
    const isCurrent = !!shown && shown.id === current?.id;
    const busy = status === "running" || status === "initializing";
    const view = shown ? `issue ${shown.id}` : "search";

    useEffect(() => {
      if (!shown) return;
      const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS);
      return () => clearTimeout(timer);
    }, [view]);

    /** Makes the issue the chat's, or detaches it with null, and closes. */
    async function give(issue: SearchItem | null, sent: boolean) {
      setPending(true);
      try {
        const { chats } = await setChat({ agentId, issue: issue && chatIssueOf(issue) });
        store.changed(chats);
        close();
      } catch (error) {
        if (sent) {
          toast.error(
            `Sent ${issue?.identifier}, but couldn't make it this chat's issue: ${errorMessage(error)}`,
          );
          close();
        } else {
          toast.error(`Couldn't change this chat's issue: ${errorMessage(error)}`);
          setPending(false);
        }
      }
    }

    async function send() {
      if (!shown?.text || pending) return;
      setPending(true);
      try {
        const message = issueMessage(shown.identifier, { again: isCurrent, note });
        await paseo.agents.ref(agentId).send(message, {
          attachments: [issueAttachment(shown)],
          ...(busy ? { activeTurnBehavior: "steer" as const } : {}),
        });
      } catch (error) {
        toast.error(`Couldn't send ${shown.identifier}: ${errorMessage(error)}`);
        setPending(false);
        return;
      }
      if (isCurrent) close();
      else await give(shown, true);
    }

    const action = (
      label: string,
      onPress: () => void,
      options: { primary?: boolean; disabled?: boolean; accessibilityLabel?: string } = {},
    ) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={options.accessibilityLabel ?? label}
        accessibilityState={{ disabled: options.disabled }}
        disabled={options.disabled}
        onPress={onPress}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: options.primary ? c.foreground : "transparent",
          opacity: options.disabled ? 0.55 : 1,
        }}
      >
        <Text style={{ color: options.primary ? c.surface0 : c.foreground, fontSize: 14 }}>{label}</Text>
      </Pressable>
    );
    const root = {
      // compact layouts show popovers as a full-width sheet
      width: layout.compact ? ("100%" as const) : WIDTH,
      height: HEIGHT,
      margin: -HOST_PADDING,
      borderRadius: 8,
      overflow: "hidden" as const,
      backgroundColor: c.surface0,
    };
    const note12 = { paddingHorizontal: 12, paddingVertical: 8, color: c.foregroundMuted, fontSize: 13 };

    if (shown) {
      const text =
        shown.text ||
        (latest.error
          ? errorMessage(latest.error)
          : latest.isFetching
            ? "Loading the issue from Linear…"
            : "None of your Linear accounts can see this issue anymore.");
      return (
        <View style={root}>
          <InputBar theme={theme} icon="MessageSquare">
            <TextInput
              ref={input}
              value={note}
              onChangeText={setNote}
              onSubmitEditing={send}
              placeholder="Add a message (optional)"
              placeholderTextColor={c.foregroundMuted}
              accessibilityLabel="Message to send with the issue"
              style={fieldStyle(theme)}
            />
          </InputBar>
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surface1 }}>
            <IssueRow theme={theme} issue={shown} highlighted />
          </View>
          {busy ? (
            <Text style={note12}>The agent is working: this adds the issue to its current turn.</Text>
          ) : null}
          <ScrollView style={{ flex: 1, minHeight: 0 }}>
            <Text style={{ ...note12, fontSize: 12, lineHeight: 18 }} selectable>
              {text}
            </Text>
          </ScrollView>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              padding: 8,
              borderTopWidth: 1,
              borderTopColor: c.border,
            }}
          >
            {picked ? (
              action("Back", () => setPicked(null))
            ) : (
              <>
                {action("Detach", () => void give(null, false), {
                  disabled: pending,
                  accessibilityLabel: `Detach ${shown.identifier} from this chat`,
                })}
                {action("Change", () => setChanging(true), {
                  accessibilityLabel: "Give this chat another issue",
                })}
              </>
            )}
            <View style={{ flex: 1 }} />
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open ${shown.identifier} in Linear`}
              onPress={() =>
                void openExternalUrl(shown.url).catch((error) => toast.error(errorMessage(error)))
              }
              style={{ padding: 6 }}
            >
              <Icon name="ExternalLink" size={16} color={c.foregroundMuted} />
            </Pressable>
            {isCurrent
              ? null
              : action("Attach only", () => void give(shown, false), {
                  disabled: pending,
                  accessibilityLabel: `Make ${shown.identifier} this chat's issue without sending it`,
                })}
            {action(busy ? "Send and steer" : isCurrent ? "Send again" : "Send", send, {
              primary: true,
              disabled: pending || !shown.text,
              accessibilityLabel: `Send ${shown.identifier} to the agent`,
            })}
          </View>
        </View>
      );
    }

    return (
      <View style={root}>
        <IssueSearch
          theme={theme}
          hostId={host.id}
          draft={draft}
          setDraft={setDraft}
          pick={setPicked}
          back={
            current ? { label: "Back to this chat's issue", onPress: () => setChanging(false) } : undefined
          }
        />
      </View>
    );
  };
}
