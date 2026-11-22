import { Platform, Share } from "react-native";

type Shot = { png: string; path: string };
// the browser's clipboard and links, typed here: the client code is built without the DOM's types
type Web = {
  ClipboardItem?: new (items: Record<string, Promise<unknown>>) => unknown;
  navigator?: { clipboard?: { write(items: unknown[]): Promise<void> } };
  document?: { createElement(tag: "a"): { href: string; download: string; click(): void } };
  fetch(url: string): Promise<{ blob(): Promise<unknown> }>;
};
const web = globalThis as unknown as Web;
const dataUrl = (png: string) => `data:image/png;base64,${png}`;

/**
 * Copies a device's screen to this app's clipboard as a PNG. In the desktop app and browsers the
 * copy starts during the press, with the picture to follow (Safari only lets a click write the
 * clipboard); where there's no clipboard, as on a plain-http address, it downloads instead. Plugins
 * can't put an image on a phone's clipboard: the iPhone app opens the share sheet, whose Copy does,
 * and on Android the screenshot stays on the host, where every one is kept for a day. Says what
 * happened.
 */
export async function copyScreenshot(take: () => Promise<Shot>, name: string): Promise<string> {
  if (Platform.OS === "web") {
    const clipboard = web.navigator?.clipboard;
    if (clipboard && web.ClipboardItem) {
      const png = take().then(({ png: base64 }) => web.fetch(dataUrl(base64)).then((r) => r.blob()));
      await clipboard.write([new web.ClipboardItem({ "image/png": png })]);
      return "Screenshot copied";
    }
    const { png } = await take();
    const link = web.document?.createElement("a");
    if (link) {
      link.href = dataUrl(png);
      link.download = name;
      link.click();
      return "Copying isn't available here: the screenshot was downloaded";
    }
  }
  const { png, path } = await take();
  if (Platform.OS === "ios") {
    const result = await Share.share({ url: dataUrl(png) });
    return result.action === Share.sharedAction
      ? "Screenshot shared"
      : `Screenshot kept on the host: ${path}`;
  }
  return `Screenshot saved on the host: ${path}`;
}
