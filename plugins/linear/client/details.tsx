import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from "react-native";
import { commentRpc, type Issue } from "../shared/contracts";
import { errorMessage, keys, useDetail } from "./data";
import { parseMarkdown, type Span } from "./markdown";
import { Button, Notice, sizes } from "./ui";

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, Menlo, monospace",
});
const HEADING_GROWTH = [6, 4, 2, 0, 0, 0];

/** An image at its own size, no wider than the text; a link to it if it doesn't load. */
function Picture({ theme, url, alt, open }: { theme: PluginTheme; url: string; alt: string; open(): void }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    Image.getSize(
      url,
      (width, height) => setSize({ width, height }),
      () => setFailed(true),
    );
  }, [url]);
  if (failed)
    return (
      <Text style={{ color: theme.colors.accent }} accessibilityRole="link" onPress={open}>
        {alt || "Image"}
      </Text>
    );
  if (!size)
    return <ActivityIndicator color={theme.colors.foregroundMuted} style={{ alignSelf: "flex-start" }} />;
  return (
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={alt || "Image"} onPress={open}>
      <Image
        source={{ uri: url }}
        style={{
          width: "100%",
          maxWidth: size.width,
          aspectRatio: size.width / size.height,
          borderRadius: 6,
        }}
      />
    </Pressable>
  );
}

/** Linear's markdown in the theme's colors; links and images open in the browser. */
function Markdown({ theme, compact, text }: { theme: PluginTheme; compact: boolean; text: string }) {
  const c = theme.colors;
  const s = sizes(compact);
  const toast = useToast();
  const open = (url: string) => void openExternalUrl(url).catch((error) => toast.error(errorMessage(error)));
  const base = { color: c.foreground, fontSize: s.text, lineHeight: 20 };
  const spans = (list: Span[]) =>
    list.map((span, index) => (
      <Text
        key={index}
        accessibilityRole={span.url ? "link" : undefined}
        onPress={span.url ? () => open(span.url!) : undefined}
        style={{
          fontWeight: span.bold ? "600" : undefined,
          fontStyle: span.italic ? "italic" : undefined,
          textDecorationLine: span.strike ? "line-through" : span.url ? "underline" : undefined,
          color: span.url ? c.accent : undefined,
          fontFamily: span.code ? MONO : undefined,
          backgroundColor: span.code ? c.surface2 : undefined,
        }}
      >
        {span.text}
      </Text>
    ));
  const blocks = parseMarkdown(text);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const fontSize = s.text + HEADING_GROWTH[block.level - 1];
            return (
              <Text
                key={index}
                style={{ ...base, fontSize, lineHeight: fontSize * 1.4, fontWeight: "600" }}
                selectable
              >
                {spans(block.spans)}
              </Text>
            );
          }
          case "paragraph":
            return (
              <Text key={index} style={base} selectable>
                {spans(block.spans)}
              </Text>
            );
          case "item":
            return (
              <View
                key={index}
                style={{
                  flexDirection: "row",
                  gap: 6,
                  paddingLeft: block.depth * 16,
                  // a list reads as one block
                  marginTop: blocks[index - 1]?.kind === "item" ? -4 : 0,
                }}
              >
                {block.checked === null ? (
                  <Text style={{ ...base, color: c.foregroundMuted, minWidth: 12 }}>{block.marker}</Text>
                ) : (
                  <View style={{ height: base.lineHeight, justifyContent: "center" }}>
                    <Icon
                      name={block.checked ? "SquareCheck" : "Square"}
                      size={s.icon}
                      color={c.foregroundMuted}
                    />
                  </View>
                )}
                <Text style={{ ...base, flex: 1 }} selectable>
                  {spans(block.spans)}
                </Text>
              </View>
            );
          case "quote":
            return (
              <View key={index} style={{ borderLeftWidth: 3, borderLeftColor: c.border, paddingLeft: 10 }}>
                <Text style={{ ...base, color: c.foregroundMuted }} selectable>
                  {spans(block.spans)}
                </Text>
              </View>
            );
          case "code":
            return (
              <View key={index} style={{ padding: 10, borderRadius: 6, backgroundColor: c.surface2 }}>
                <Text style={{ ...base, fontSize: s.text - 1, lineHeight: 18, fontFamily: MONO }} selectable>
                  {block.text}
                </Text>
              </View>
            );
          case "image":
            return (
              <Picture
                key={index}
                theme={theme}
                url={block.url}
                alt={block.alt}
                open={() => open(block.url)}
              />
            );
          case "rule":
            return <View key={index} style={{ height: 1, backgroundColor: c.border }} />;
        }
      })}
    </View>
  );
}

/** An issue's description and latest comments, and a box to add one. */
export function Details({
  theme,
  compact,
  hostId,
  accountId,
  issue,
  close,
}: {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  accountId: string;
  issue: Issue;
  close(): void;
}) {
  const c = theme.colors;
  const s = sizes(compact);
  const queryClient = useQueryClient();
  const detail = useDetail(hostId, accountId, issue.id);
  const addComment = useRpc(commentRpc);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async () => {
    if (!draft.trim() || posting) return;
    setPosting(true);
    setError(null);
    try {
      await addComment({ accountId, id: issue.id, body: draft });
      setDraft("");
      // the board too: the issue moves up as the latest updated
      await queryClient.invalidateQueries({ queryKey: keys.issues(hostId) });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPosting(false);
    }
  };

  const body = { color: c.foreground, fontSize: s.text, lineHeight: 20 };
  const description = detail.data?.description?.trim();
  return (
    <Modal title={issue.identifier} open onOpenChange={(open) => !open && close()}>
      <Modal.Content>
        <View style={{ gap: 4 }}>
          <Text style={{ color: c.foreground, fontSize: s.text + 3, fontWeight: "600" }} selectable>
            {issue.title}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {[
              issue.state.name,
              issue.priority > 0 ? issue.priorityLabel : null,
              issue.assignee,
              issue.project,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        {detail.isLoading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
        {detail.error ? <Notice theme={theme} danger text={errorMessage(detail.error)} /> : null}
        {detail.data ? (
          <>
            {description ? (
              <Markdown theme={theme} compact={compact} text={description} />
            ) : (
              <Notice theme={theme} text="No description." />
            )}
            <Text style={{ color: c.foreground, fontSize: s.text, fontWeight: "600" }}>Comments</Text>
            {detail.data.comments.length ? null : <Notice theme={theme} text="No comments yet." />}
            {detail.data.comments.map((comment) => (
              <View
                key={comment.createdAt}
                style={{
                  gap: 4,
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: c.border,
                  backgroundColor: c.surface1,
                }}
              >
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  <Text style={{ color: c.foreground, fontWeight: "600" }}>{comment.user ?? "Someone"}</Text>
                  {` · ${comment.createdAt.slice(0, 10)}`}
                </Text>
                <Markdown theme={theme} compact={compact} text={comment.body} />
              </View>
            ))}
          </>
        ) : null}
        <TextInput
          multiline
          value={draft}
          onChangeText={setDraft}
          placeholder="Leave a comment"
          placeholderTextColor={c.foregroundMuted}
          accessibilityLabel={`Comment on ${issue.identifier}`}
          style={{
            ...body,
            minHeight: 80,
            paddingHorizontal: 10,
            paddingVertical: 8,
            textAlignVertical: "top",
            borderRadius: 6,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.surface1,
          }}
        />
        {error ? <Notice theme={theme} danger text={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
          {posting ? <ActivityIndicator color={c.foregroundMuted} /> : null}
          <Button
            theme={theme}
            compact={compact}
            variant="primary"
            icon="MessageSquare"
            label="Comment"
            disabled={!draft.trim() || posting}
            onPress={() => void post()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
