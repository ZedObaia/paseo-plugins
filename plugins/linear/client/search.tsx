import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, type TextInput as NativeTextInput } from "react-native";
import { issueAttachments, type SearchItem } from "../shared/contracts";
import { errorMessage, useSearch } from "./data";

const SEARCH_DELAY_MS = 250;
// the app dismisses the keyboard as a popover opens, which would blur an input focused sooner
export const FOCUS_DELAY_MS = 200;

/** A borderless input's style, for an InputBar. */
export const fieldStyle = (theme: PluginTheme) =>
  ({
    flex: 1,
    paddingVertical: 12,
    color: theme.colors.foreground,
    fontSize: 14,
    outlineWidth: 0,
  }) as const;

/** An input across the top of a picker, after an icon, or a back arrow when there's somewhere to go back to. */
export function InputBar({
  theme,
  icon,
  back,
  children,
}: {
  theme: PluginTheme;
  icon: string;
  back?: { label: string; onPress(): void };
  children: ReactNode;
}) {
  const c = theme.colors;
  return (
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
      {back ? (
        <Pressable accessibilityRole="button" accessibilityLabel={back.label} onPress={back.onPress}>
          <Icon name="ArrowLeft" size={16} color={c.foregroundMuted} />
        </Pressable>
      ) : (
        <Icon name={icon} size={16} color={c.foregroundMuted} />
      )}
      {children}
    </View>
  );
}

/** An issue on one line: its identifier and title, then where it stands. */
export function IssueRow({
  theme,
  issue,
  highlighted,
}: {
  theme: PluginTheme;
  issue: SearchItem;
  highlighted: boolean;
}) {
  const c = theme.colors;
  return (
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
}

/**
 * Linear's search across every account: an input, and the issues it finds to pick from. What's
 * typed is the caller's, so it's still there after going back from an issue.
 */
export function IssueSearch({
  theme,
  hostId,
  draft,
  setDraft,
  pick,
  back,
}: {
  theme: PluginTheme;
  hostId: string;
  draft: string;
  setDraft(text: string): void;
  pick(issue: SearchItem): void;
  back?: { label: string; onPress(): void };
}) {
  const c = theme.colors;
  const [query, setQuery] = useState(draft);
  const [active, setActive] = useState(0);
  const input = useRef<NativeTextInput>(null);
  const search = useSearch(hostId, query);
  const issues = search.data ?? [];

  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const note = { paddingHorizontal: 12, paddingVertical: 8, color: c.foregroundMuted, fontSize: 13 };
  return (
    <>
      <InputBar theme={theme} icon="Search" back={back}>
        <TextInput
          ref={input}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => issues[active] && pick(issues[active])}
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
          style={fieldStyle(theme)}
        />
      </InputBar>
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingVertical: 4 }}
        keyboardShouldPersistTaps="handled"
      >
        {search.error ? (
          <Text style={{ ...note, color: c.statusDanger }}>{errorMessage(search.error)}</Text>
        ) : null}
        {!search.error && !issues.length ? (
          <Text style={note}>{search.isFetching ? "Searching…" : "No issues found."}</Text>
        ) : null}
        {issues.map((issue, index) => (
          <Pressable
            key={issue.id}
            accessibilityRole="button"
            accessibilityLabel={`${issue.identifier} ${issue.title}`}
            onPress={() => pick(issue)}
            onHoverIn={() => setActive(index)}
            style={{
              minHeight: 36,
              justifyContent: "center",
              paddingHorizontal: 12,
              paddingVertical: 8,
              backgroundColor: index === active ? c.surface1 : "transparent",
            }}
          >
            <IssueRow theme={theme} issue={issue} highlighted={index === active} />
          </Pressable>
        ))}
      </ScrollView>
    </>
  );
}
