import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { agentSettings } from "../shared/contracts";

/** What turning agent tools on does, said before the user does it. */
export const AGENT_TOOLS =
  "Agents you start get agent-device tools to read, tap and type on their workspace's devices, and can " +
  "add a free simulator or emulator to it; a USB phone only once you add it. The first time an agent " +
  "drives a device, agent-device installs its helpers there: on an iOS simulator, an XCTest runner app " +
  "it builds with Xcode on this Mac; on an Android emulator or phone, two helper apps it ships with, one " +
  "that reads the screen's layout and a keyboard for typing. Nothing is downloaded.";

export function AgentSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(agentSettings);
  if (settings.status === "loading") return null;
  if (settings.status === "error")
    return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  return (
    <SettingsSection title="Agents">
      <SettingsCard>
        <SettingsSwitch
          label="Agent tools"
          hint={
            `${AGENT_TOOLS} Turning this off takes the devices away from agents already running; ` +
            "helpers already installed stay on them."
          }
          value={settings.status === "ready" && settings.values.agentTools}
          disabled={settings.saving}
          error={settings.status === "invalid" ? settings.error : settings.saveError}
          onValueChange={(agentTools) => void settings.save({ agentTools }, settings.revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
