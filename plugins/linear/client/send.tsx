import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, type TextInput as NativeTextInput } from "react-native";
import { issueAttachment, issueAttachments, type SearchItem } from "../shared/contracts";
import { errorMessage, useSearch } from "./data";

const WIDTH = 380;
// fixed, so the app places the popover right on its first measure, before results arrive
const HEIGHT = 360;
// the app pads plugin popovers by 12; the list runs edge to edge like its own pickers
const HOST_PADDING = 12;
const SEARCH_DELAY_MS = 250;
// the app dismisses the keyboard as a popover opens, which would blur an input focused sooner
const FOCUS_DELAY_MS = 200;

/** Searching Linear and sending one issue to this agent, with a message if you like. */
export function SendIssue({ theme, host, layout, close, ...props }: PluginButtonContentProps) {
  const c = theme.colors;
  const agentId = props.context === "agent" ? props.agentId : "";
  const paseo = usePaseo();
  const toast = useToast();
  const status = useAgent(agentId, (agent) => agent.status);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<SearchItem | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<NativeTextInput>(null);
  const search = useSearch(host.id, query);
  const issues = search.data ?? [];
  const busy = status === "running" || status === "initializing";

  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [picked]);

  async function send() {
    if (!picked || sending) return;
    setSending(true);
    try {
      await paseo.agents.ref(agentId).send(note.trim() || `${picked.identifier}: ${picked.title}`, {
        attachments: [issueAttachment(picked)],
        ...(busy ? { activeTurnBehavior: "steer" as const } : {}),
      });
      close();
    } catch (error) {
      toast.error(`Couldn't send ${picked.identifier}: ${errorMessage(error)}`);
      setSending(false);
    }
  }

  const field = {
    flex: 1,
    paddingVertical: 12,
    color: c.foreground,
    fontSize: 14,
    outlineWidth: 0,
  } as const;
  const header = (icon: string, children: ReactNode) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        backgroundColor: c.surface1,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <Icon name={icon} size={16} color={c.foregroundMuted} />
      {children}
    </View>
  );
  const row = (issue: SearchItem, highlighted: boolean) => (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, overflow: "hidden" }}>
      {/* the title gives way first, so the status never shrinks to a letter */}
      <Text style={{ color: c.foreground, fontSize: 14, flexShrink: 1, minWidth: 0 }} numberOfLines={1}>
        {issue.identifier} {issue.title}
      </Text>
      {issue.subtitle ? (
        <Text
          style={{
            color: highlighted ? c.foreground : c.foregroundMuted,
            fontSize: 12,
            flexShrink: 0,
            maxWidth: "45%",
          }}
          numberOfLines={1}
        >
          {issue.subtitle}
        </Text>
      ) : null}
    </View>
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

  if (picked)
    return (
      <View style={root}>
        {header(
          "MessageSquare",
          <TextInput
            ref={input}
            value={note}
            onChangeText={setNote}
            onSubmitEditing={send}
            placeholder="Add a message (optional)"
            placeholderTextColor={c.foregroundMuted}
            accessibilityLabel="Message to send with the issue"
            style={field}
          />,
        )}
        <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surface1 }}>
          {row(picked, true)}
        </View>
        {busy ? (
          <Text style={note12}>The agent is working: this adds the issue to its current turn.</Text>
        ) : null}
        <ScrollView style={{ flex: 1, minHeight: 0 }}>
          <Text style={{ ...note12, fontSize: 12, lineHeight: 18 }} selectable>
            {picked.text}
          </Text>
        </ScrollView>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            gap: 8,
            padding: 8,
            borderTopWidth: 1,
            borderTopColor: c.border,
          }}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => setPicked(null)}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 }}
          >
            <Text style={{ color: c.foreground, fontSize: 14 }}>Back</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Send ${picked.identifier} to the agent`}
            disabled={sending}
            onPress={send}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 6,
              backgroundColor: c.foreground,
              opacity: sending ? 0.55 : 1,
            }}
          >
            <Text style={{ color: c.surface0, fontSize: 14 }}>{busy ? "Send and steer" : "Send"}</Text>
          </Pressable>
        </View>
      </View>
    );

  return (
    <View style={root}>
      {header(
        "Search",
        <TextInput
          ref={input}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => issues[active] && setPicked(issues[active])}
          onKeyPress={(event) => {
            // the arrows move the highlight on web, where there's a keyboard
            const key = event.nativeEvent.key;
            if (key !== "ArrowDown" && key !== "ArrowUp") return;
            event.preventDefault();
            const step = key === "ArrowDown" ? 1 : -1;
            setActive((i) => Math.min(Math.max(i + step, 0), Math.max(issues.length - 1, 0)));
          }}
          placeholder={issueAttachments.searchPlaceholder}
          placeholderTextColor={c.foregroundMuted}
          accessibilityLabel="Search Linear issues"
          style={field}
        />,
      )}
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingVertical: 4 }}
        keyboardShouldPersistTaps="handled"
      >
        {search.error ? (
          <Text style={{ ...note12, color: c.statusDanger }}>{errorMessage(search.error)}</Text>
        ) : null}
        {!search.error && !issues.length ? (
          <Text style={note12}>{search.isFetching ? "Searching…" : "No issues found."}</Text>
        ) : null}
        {issues.map((issue, index) => (
          <Pressable
            key={issue.id}
            accessibilityRole="button"
            accessibilityLabel={`${issue.identifier} ${issue.title}`}
            onPress={() => setPicked(issue)}
            onHoverIn={() => setActive(index)}
            style={{
              minHeight: 36,
              justifyContent: "center",
              paddingHorizontal: 12,
              paddingVertical: 8,
              backgroundColor: index === active ? c.surface1 : "transparent",
            }}
          >
            {row(issue, index === active)}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
