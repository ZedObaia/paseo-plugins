/** The simulator's US keyboard: HID usage per character, and whether it needs shift. */
const KEYS = new Map<string, { usage: number; shift: boolean }>();
for (let i = 0; i < 26; i++) {
  KEYS.set(String.fromCharCode(97 + i), { usage: 4 + i, shift: false });
  KEYS.set(String.fromCharCode(65 + i), { usage: 4 + i, shift: true });
}
[..."1234567890"].forEach((key, i) => KEYS.set(key, { usage: 30 + i, shift: false }));
[..."!@#$%^&*()"].forEach((key, i) => KEYS.set(key, { usage: 30 + i, shift: true }));
for (const [plain, shifted, usage] of [
  ["-", "_", 45],
  ["=", "+", 46],
  ["[", "{", 47],
  ["]", "}", 48],
  ["\\", "|", 49],
  [";", ":", 51],
  ["'", '"', 52],
  ["`", "~", 53],
  [",", "<", 54],
  [".", ">", 55],
  ["/", "?", 56],
] as const) {
  KEYS.set(plain, { usage, shift: false });
  KEYS.set(shifted, { usage, shift: true });
}
KEYS.set(" ", { usage: 44, shift: false });
KEYS.set("\n", { usage: 40, shift: false });
KEYS.set("\t", { usage: 43, shift: false });

const SHIFT = 225;

export type KeyEvent = { type: "down" | "up"; usage: number };

/** Key presses that type `text`; throws on a character the US keyboard can't type. */
export function keyEvents(text: string): KeyEvent[] {
  return [...text.replace(/\r/g, "")].flatMap((char): KeyEvent[] => {
    const key = KEYS.get(char);
    if (!key)
      throw new Error(
        `The simulator's keyboard can't type ${JSON.stringify(char)}: US keyboard characters only`,
      );
    const press: KeyEvent[] = [
      { type: "down", usage: key.usage },
      { type: "up", usage: key.usage },
    ];
    return key.shift ? [{ type: "down", usage: SHIFT }, ...press, { type: "up", usage: SHIFT }] : press;
  });
}
