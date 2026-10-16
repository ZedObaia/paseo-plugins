import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, type GestureResponderEvent, type LayoutChangeEvent, Text, View } from "react-native";
import { frameRpc, inputRpc } from "../shared/contracts";

type Shown = { uri: string; width: number; height: number };

/**
 * The device screen, fitted to the panel. Frames are polled (the next request goes out when the
 * previous one lands, so slow links just get fewer frames) and drawn double-buffered: a new frame
 * loads invisibly on top and replaces the old one only once decoded, so phones don't flicker.
 * A tap, a hold (long press) or a drag on the picture goes to the device.
 */
export function LiveScreen({ theme, deviceId }: { theme: PluginTheme; deviceId: string }) {
  const frame = useRpc(frameRpc);
  const input = useRpc(inputRpc);
  const c = theme.colors;
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [shown, setShown] = useState<Shown | null>(null);
  const [next, setNext] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const touch = useRef<{ x: number; y: number; at: number } | null>(null);

  // request roughly the pixels we'll draw (2x for sharp text), capped for slow links
  const maxWidth = Math.min(720, Math.max(240, Math.round(box.width * 2)));

  useEffect(() => {
    if (!box.width) return;
    let stopped = false;
    let seq = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let delay = 400;
      try {
        const result = await frame({ deviceId, maxWidth, since: seq });
        if (stopped) return;
        if (result.status === "frame") {
          seq = result.seq;
          setProblem(null);
          setNext({ uri: `data:image/jpeg;base64,${result.jpeg}`, width: result.width, height: result.height });
          delay = 120;
        } else if (result.status === "unavailable") {
          setProblem(result.reason);
          delay = 2_000;
        }
      } catch (error) {
        if (stopped) return;
        setProblem(error instanceof Error ? error.message : String(error));
        delay = 2_000;
      }
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [deviceId, maxWidth, box.width > 0]);

  const picture = shown ?? next;
  // fit the device into the panel, keeping its aspect ratio
  const scale = picture ? Math.min(box.width / picture.width, box.height / picture.height) : 0;
  const size = picture ? { width: Math.floor(picture.width * scale), height: Math.floor(picture.height * scale) } : { width: 0, height: 0 };

  const point = (e: GestureResponderEvent) => ({
    x: Math.min(1, Math.max(0, e.nativeEvent.locationX / (size.width || 1))),
    y: Math.min(1, Math.max(0, e.nativeEvent.locationY / (size.height || 1))),
  });
  const send = (body: Parameters<typeof input>[0]["input"]) =>
    void input({ deviceId, input: body }).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));

  function release(e: GestureResponderEvent) {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const end = point(e);
    const heldMs = Date.now() - start.at;
    const moved = Math.hypot((end.x - start.x) * size.width, (end.y - start.y) * size.height);
    if (moved < 8) send({ kind: "tap", x: start.x, y: start.y, holdMs: heldMs > 450 ? Math.min(heldMs, 5_000) : 60 });
    else send({ kind: "swipe", from: { x: start.x, y: start.y }, to: end, durationMs: Math.min(5_000, Math.max(80, heldMs)) });
  }

  return (
    <View
      style={{ flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center" }}
      onLayout={(e: LayoutChangeEvent) => setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
    >
      {picture ? (
        <View
          style={{ width: size.width, height: size.height, borderRadius: 18, overflow: "hidden", backgroundColor: "black" }}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(e) => (touch.current = { ...point(e), at: Date.now() })}
          onResponderRelease={release}
          onResponderTerminate={() => (touch.current = null)}
          accessibilityLabel="Device screen. Tap, hold or drag to control it."
        >
          {shown ? <Image source={{ uri: shown.uri }} style={{ width: size.width, height: size.height }} fadeDuration={0} /> : null}
          {next && next.uri !== shown?.uri ? (
            <Image
              source={{ uri: next.uri }}
              style={{ position: "absolute", top: 0, left: 0, width: size.width, height: size.height, opacity: shown ? 0 : 1 }}
              fadeDuration={0}
              onLoad={() => setShown(next)}
            />
          ) : null}
        </View>
      ) : problem ? null : (
        <ActivityIndicator color={c.foregroundMuted} />
      )}
      {problem ? (
        <Text style={{ color: c.foregroundMuted, position: picture ? "absolute" : "relative", bottom: picture ? 8 : undefined, textAlign: "center" }}>
          {problem}
        </Text>
      ) : null}
    </View>
  );
}
