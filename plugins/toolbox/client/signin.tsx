import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { loginCancelRpc, loginStatusRpc } from "../shared/contracts";
import { errorText } from "./data";
import { Button, sizes } from "./ui";

export type SigningIn = { name: string; title: string; loginId: string; url: string | null };

/**
 * A sign-in in progress under its connector. Claude waits for the browser to come back to this
 * host; from a phone it can't, so the address the browser ended on can be pasted instead.
 */
export function SignIn({
  theme,
  compact,
  hostId,
  signing,
  onEnd,
}: {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  signing: SigningIn;
  onEnd(done: boolean, message: string): void;
}) {
  const c = theme.colors;
  const toast = useToast();
  const status = useRpc(loginStatusRpc);
  const cancel = useRpc(loginCancelRpc);
  const [paste, setPaste] = useState("");
  const progress = useQuery({
    queryKey: ["toolbox", hostId, "login", signing.loginId],
    queryFn: () => status({ loginId: signing.loginId }),
    refetchInterval: 2_000,
  });
  const state = progress.data?.state;
  useEffect(() => {
    if (state === "done" || state === "failed") onEnd(state === "done", progress.data?.message ?? "");
    // onEnd is a fresh closure on each render: the state changing is what matters
  }, [state]);

  async function send() {
    try {
      const result = await status({ loginId: signing.loginId, paste: paste.trim() });
      if (result.state !== "waiting") onEnd(result.state === "done", result.message);
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  return (
    <View
      style={{
        marginHorizontal: 12,
        marginBottom: 12,
        padding: 12,
        gap: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface0,
      }}
    >
      <Text
        style={{ color: c.foreground, fontSize: 13 }}
      >{`Finish signing in to ${signing.title} in your browser.`}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {signing.url ? (
          <Button
            theme={theme}
            compact={compact}
            icon="ExternalLink"
            label="Open sign-in page"
            onPress={() => void openExternalUrl(signing.url!).catch((e) => toast.error(errorText(e)))}
          />
        ) : null}
        <Button
          theme={theme}
          compact={compact}
          variant="ghost"
          label="Cancel"
          onPress={() => {
            void cancel({ loginId: signing.loginId }).catch(() => {});
            onEnd(false, "Cancelled");
          }}
        />
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        Signing in on another device? When the browser shows an error page, paste its address here.
      </Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          value={paste}
          onChangeText={setPaste}
          placeholder="http://localhost:…/callback?code=…"
          placeholderTextColor={c.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            flex: 1,
            minHeight: sizes(compact).control,
            paddingHorizontal: 8,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: c.border,
            color: c.foreground,
            fontSize: 12,
          }}
        />
        <Button
          theme={theme}
          compact={compact}
          label="Send"
          disabled={!paste.trim()}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}
