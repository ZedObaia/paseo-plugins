import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { linkSettings } from "../shared/contracts";
import { useScan } from "./data";

export function LinkSettings({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(linkSettings);
  const current = useScan(host.id).data?.linkHost;
  const [draft, setDraft] = useState<string | null>(null);
  if (settings.status === "loading") return null;
  if (settings.status === "error")
    return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  const saved = settings.status === "ready" ? settings.values.linkHost : "";
  const changed = draft !== null && draft.trim() !== saved;
  return (
    <SettingsSection title="Links">
      <SettingsCard>
        <SettingsInput
          label="Address for links"
          hint={
            "The host name or IP address your devices reach this machine at, such as its Tailscale " +
            "name. Leave it empty to use the address the daemon listens on" +
            (current ? ` (links open at ${current} now).` : ".")
          }
          initialValue={saved}
          placeholder="Automatic"
          error={settings.status === "invalid" ? settings.error : settings.saveError}
          onChangeText={setDraft}
        />
        <SettingsAction
          label="Save the address"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={!changed || settings.saving}
          onPress={async () => {
            if (await settings.save({ linkHost: (draft ?? "").trim() }, settings.revision)) setDraft(null);
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
