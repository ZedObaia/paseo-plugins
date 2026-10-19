/** A run of text in one style. Links go only to web and mail addresses. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  url?: string;
}
type Style = Omit<Span, "text">;

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  /** A flat list item: `depth` is its nesting, `checked` null unless it's a task. */
  | { kind: "item"; depth: number; marker: string; checked: boolean | null; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; text: string }
  | { kind: "image"; alt: string; url: string }
  | { kind: "rule" };

const SAFE_URL = /^(https?:|mailto:)/i;
/** A link's target, with one level of parentheses like Wikipedia's, an optional title and the `)`. */
const target = (name: string) => String.raw`(?<${name}>(?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)`;
const IMAGE_LINE = new RegExp(String.raw`^\s*!\[(?<alt>[^\]]*)\]\(${target("url")}\s*$`);

// the first alternative that matches at the earliest position wins, so the order matters
const INLINE = new RegExp(
  [
    /\\(?<escaped>[\\`*_{}[\]()#+\-.!~>|])/,
    /`(?<code>[^`]+)`/,
    String.raw`!\[(?<alt>[^\]]*)\]\(${target("src")}`,
    String.raw`\[(?<label>[^\]]+)\]\(${target("href")}`,
    /<(?<auto>(?:https?|mailto):[^>\s]+)>/,
    /(?<bare>https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*_~])/,
    /\*\*(?<bold>.+?)\*\*|__(?<bold2>.+?)__/,
    /~~(?<strike>.+?)~~/,
    // `_` only around words, so snake_case stays as it is
    /\*(?<em>[^*\s](?:.*?[^*\s])?)\*|\b_(?<em2>.+?)_\b/,
  ]
    .map((part) => (typeof part === "string" ? part : part.source))
    .join("|"),
  "g",
);

export function parseInline(text: string, style: Style = {}): Span[] {
  const spans: Span[] = [];
  const push = (text: string, extra: Style = {}) => {
    if (text) spans.push({ text, ...style, ...extra });
  };
  const link = (url: string): Style => (SAFE_URL.test(url) ? { url } : {});
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    push(text.slice(last, match.index!));
    last = match.index! + match[0].length;
    const g = match.groups!;
    if (g.escaped) push(g.escaped);
    else if (g.code) push(g.code, { code: true });
    // an image inside text: a link to it
    else if (g.src) push(g.alt || "image", link(g.src));
    else if (g.href) spans.push(...parseInline(g.label, { ...style, ...link(g.href) }));
    else if (g.auto || g.bare) push(g.auto || g.bare, { url: g.auto || g.bare });
    else if (g.bold || g.bold2) spans.push(...parseInline(g.bold || g.bold2, { ...style, bold: true }));
    else if (g.strike) spans.push(...parseInline(g.strike, { ...style, strike: true }));
    else spans.push(...parseInline(g.em || g.em2, { ...style, italic: true }));
  }
  push(text.slice(last));
  return spans;
}

// a backslash at the end of a line is a line break, and lines keep theirs
const inline = (text: string) => parseInline(text.replace(/\\$/gm, ""));

/**
 * The markdown Linear writes, as blocks: headings, paragraphs, lists and tasks, quotes, code,
 * images on their own line and rules. Tables and HTML stay as text.
 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  // the paragraph, list item or quote still taking lines
  let open: { kind: "paragraph" | "item" | "quote"; lines: string[]; done(text: string): Block } | null =
    null;
  // the indents of the list items above, to tell how deep the next one is
  let indents: number[] = [];
  const flush = () => {
    if (open) blocks.push(open.done(open.lines.join("\n")));
    open = null;
  };
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      flush();
    } else if ((m = /^\s*(`{3,}|~{3,})/.exec(line))) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(m[1])) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      if (open?.kind !== "quote") {
        flush();
        open = { kind: "quote", lines: [], done: (text) => ({ kind: "quote", spans: inline(text) }) };
      }
      open.lines.push(m[1]);
    } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line))) {
      flush();
      indents = [];
      blocks.push({ kind: "heading", level: m[1].length, spans: inline(m[2]) });
    } else if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flush();
      indents = [];
      blocks.push({ kind: "rule" });
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line))) {
      flush();
      const indent = m[1].length;
      while (indents.length && indents[indents.length - 1] > indent) indents.pop();
      if (!indents.length || indents[indents.length - 1] < indent) indents.push(indent);
      const item = {
        kind: "item" as const,
        depth: indents.length - 1,
        marker: /\d/.test(m[2]) ? m[2] : "•",
        checked: m[3] ? m[3] !== " " : null,
      };
      open = { kind: "item", lines: [m[4]], done: (text) => ({ ...item, spans: inline(text) }) };
    } else if ((m = IMAGE_LINE.exec(line)) && /^https:\/\//i.test(m.groups!.url)) {
      flush();
      blocks.push({ kind: "image", alt: m.groups!.alt, url: m.groups!.url });
    } else if ((m = /^\+\+\+\s*(.*)$/.exec(line))) {
      // Linear's collapsible sections: the title shows, the closing line doesn't
      flush();
      if (m[1]) blocks.push({ kind: "heading", level: 4, spans: inline(m[1]) });
    } else if (open) {
      open.lines.push(line.trim());
    } else {
      indents = [];
      open = {
        kind: "paragraph",
        lines: [line.trim()],
        done: (text) => ({ kind: "paragraph", spans: inline(text) }),
      };
    }
  }
  flush();
  return blocks;
}
