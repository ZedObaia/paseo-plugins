import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { z } from "zod";
import { controlRpc, controlsRpc, type Device } from "../shared/contracts";
import { LOCATIONS, PERMISSIONS, PERMISSION_IDS, TEXT_SIZES, parseLocation } from "../shared/controls";
import { useAction } from "./data";
import { Button } from "./ui";

type Action = z.input<typeof controlRpc.input>["action"];

/**
 * A running device's settings a tester flips: appearance, text size, contrast or airplane mode,
 * a simulated location, links, and an app's permissions (and, on iOS, a test notification). Each
 * shows what the device reports after a change.
 */
export function DeviceSettings({
  theme,
  hostId,
  device,
}: {
  theme: PluginTheme;
  hostId: string;
  device: Device;
}) {
  const read = useRpc(controlsRpc);
  const control = useRpc(controlRpc);
  // under the host's key, so every action's refresh reads the device again
  const controls = useQuery({
    queryKey: ["devices", hostId, "controls", device.id],
    queryFn: () => read({ deviceId: device.id }),
  });
  const { busy, perform } = useAction(hostId);
  const [place, setPlace] = useState("");
  const [url, setUrl] = useState("");
  const [app, setApp] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const c = theme.colors;
  const data = controls.data;
  if (!data) {
    return controls.error ? (
      <Text style={{ color: c.statusDanger }}>{String(controls.error)}</Text>
    ) : (
      <ActivityIndicator color={c.foregroundMuted} />
    );
  }
  const ios = device.platform === "ios";
  const apply = (action: Action) => void perform(() => control({ deviceId: device.id, action }));
  const choice = (label: string, selected: boolean, action: Action) => (
    <Button
      key={label}
      theme={theme}
      label={label}
      primary={selected}
      disabled={busy}
      onPress={() => apply(action)}
    />
  );
  const point = parseLocation(place);
  const size = data.textSize;
  const picked = data.apps.find((a) => a.id === app);
  const field = (
    value: string,
    onChange: (text: string) => void,
    placeholder: string,
    onSubmit?: () => void,
  ) => (
    <TextInput
      value={value}
      onChangeText={onChange}
      onSubmitEditing={onSubmit}
      placeholder={placeholder}
      placeholderTextColor={c.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        flex: 1,
        minWidth: 160,
        color: c.foreground,
        backgroundColor: c.surface2,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
      }}
    />
  );

  return (
    <View style={{ gap: 14 }}>
      <Row theme={theme} label="Appearance">
        {choice("Light", data.appearance === "light", { kind: "appearance", value: "light" })}
        {choice("Dark", data.appearance === "dark", { kind: "appearance", value: "dark" })}
      </Row>
      <Row theme={theme} label="Text size">
        <Button
          theme={theme}
          label="A−"
          disabled={busy || size === null || size === 0}
          onPress={() => size !== null && apply({ kind: "textSize", value: size - 1 })}
        />
        <Text style={{ color: c.foreground, minWidth: 70, textAlign: "center" }}>
          {size === null ? "Unknown" : TEXT_SIZES[size]?.label}
        </Text>
        <Button
          theme={theme}
          label="A+"
          disabled={busy || size === null || size === TEXT_SIZES.length - 1}
          onPress={() => size !== null && apply({ kind: "textSize", value: size + 1 })}
        />
      </Row>
      {ios ? (
        <Row theme={theme} label="Increase Contrast">
          {choice("Off", data.contrast === false, { kind: "contrast", value: false })}
          {choice("On", data.contrast === true, { kind: "contrast", value: true })}
        </Row>
      ) : (
        <Row theme={theme} label="Airplane mode">
          {choice("Off", data.airplane === false, { kind: "airplane", value: false })}
          {choice("On", data.airplane === true, { kind: "airplane", value: true })}
        </Row>
      )}
      <Row
        theme={theme}
        label="Location"
        hint={data.location ? `Set here to ${data.location.lat}, ${data.location.lon}` : "Not set here"}
      >
        {LOCATIONS.map((l) =>
          choice(l.label, data.location?.lat === l.lat && data.location.lon === l.lon, {
            kind: "location",
            value: { lat: l.lat, lon: l.lon },
          }),
        )}
        {ios ? choice("Stop", false, { kind: "location", value: null }) : null}
      </Row>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {field(
          place,
          setPlace,
          "Latitude, longitude",
          () => point && apply({ kind: "location", value: point }),
        )}
        <Button
          theme={theme}
          label="Set location"
          disabled={busy || !point}
          onPress={() => point && apply({ kind: "location", value: point })}
        />
      </View>
      <Row
        theme={theme}
        label="Open a link"
        hint="A web page, or a deep link into an app like myapp://orders/42"
      >
        {field(
          url,
          setUrl,
          "https://… or myapp://…",
          () => url && apply({ kind: "openUrl", url: url.trim() }),
        )}
        <Button
          theme={theme}
          label="Open"
          disabled={busy || !url.trim()}
          onPress={() => apply({ kind: "openUrl", url: url.trim() })}
        />
      </Row>
      <Row
        theme={theme}
        label="Your apps"
        hint={data.apps.length ? "Pick one for its permissions" : "Apps you install show up here"}
      >
        {data.apps.map((a) => (
          <Button
            key={a.id}
            theme={theme}
            label={a.name}
            primary={a.id === app}
            onPress={() => setApp(a.id)}
          />
        ))}
      </Row>
      {picked ? (
        <View style={{ gap: 8 }}>
          {PERMISSION_IDS.filter((id) => !ios || PERMISSIONS[id].ios).map((id) => (
            <Row key={id} theme={theme} label={PERMISSIONS[id].label}>
              {choice("Allow", false, { kind: "permission", app: picked.id, permission: id, grant: true })}
              {choice("Deny", false, { kind: "permission", app: picked.id, permission: id, grant: false })}
            </Row>
          ))}
          {ios ? (
            <Row theme={theme} label="Test notification" hint={`Sent to ${picked.name}`}>
              {field(title, setTitle, "Title (optional)")}
              {field(body, setBody, "Message")}
              <Button
                theme={theme}
                label="Send"
                disabled={busy || !body.trim()}
                onPress={() =>
                  apply({ kind: "push", app: picked.id, title: title.trim(), body: body.trim() })
                }
              />
            </Row>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Row({
  theme,
  label,
  hint,
  children,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const c = theme.colors;
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 13 }}>
        {label}
        {hint ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` · ${hint}`}</Text> : null}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>{children}</View>
    </View>
  );
}
