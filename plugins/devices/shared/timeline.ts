const OPERATORS = new Set(["&&", "||", ";", "|"]);

/** A shell command's words, split the way a POSIX shell would (quotes, escapes); operators apart. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) word = (word ?? "") + command[++i]!;
      else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command[++i]!;
    } else if (/\s/.test(char)) {
      push();
    } else if (char === ";" || char === "|" || char === "&") {
      push();
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        words.push(two);
        i++;
      } else words.push(char);
    } else {
      word = (word ?? "") + char;
    }
  }
  push();
  return words;
}

/** The arguments of the agent-device command in a shell command line, or null if it runs none. */
export function agentDeviceArgs(command: string): string[] | null {
  const words = shellWords(command);
  const at = words.findIndex((w) => w === "agent-device" || w.endsWith("/agent-device"));
  if (at < 0) return null;
  const rest = words.slice(at + 1);
  const end = rest.findIndex((w) => OPERATORS.has(w));
  return end < 0 ? rest : rest.slice(0, end);
}

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

/** What an agent-device command did, said plainly, for a chat's timeline. */
export function describe(args: readonly string[]): string {
  if (args.includes("--help") || args[0] === "help") return "Read agent-device's help";
  const [command = "", ...rest] = args.filter((a) => !a.startsWith("--"));
  const target = short(rest.join(" "));
  switch (command) {
    case "open":
      return target ? `Opened ${target}` : "Opened the app";
    case "close":
      return "Closed the app";
    case "press":
    case "click":
      return `Tapped ${target}`;
    case "longpress":
      return `Long-pressed ${target}`;
    case "fill":
      return `Filled ${short(rest[0] ?? "")}${rest.length > 1 ? ` with "${short(rest.slice(1).join(" "))}"` : ""}`;
    case "type":
      return `Typed "${target}"`;
    case "scroll":
      return `Scrolled ${target || "down"}`;
    case "back":
      return "Went back";
    case "home":
      return "Went to the home screen";
    case "snapshot":
      return "Read the screen";
    case "screenshot":
      return "Took a screenshot";
    case "wait":
      return `Waited for ${target}`;
    case "is":
    case "get":
    case "find":
      return `Checked ${target}`;
    case "devices":
      return "Listed devices";
    case "apps":
      return "Listed apps";
    case "install":
    case "reinstall":
      return "Installed the app";
    case "logs":
      return "Read the device's logs";
    case "record":
      return "Recorded the screen";
    default:
      return short(`agent-device ${args.join(" ")}`);
  }
}

const IMAGE = /(\/[^\s'"]+\.(?:png|jpe?g))/i;

/** The image a screenshot command saved: its path argument (against cwd), else one it printed. */
export function screenshotPath(args: readonly string[], output: string, cwd: string | null): string | null {
  const [command, file] = args.filter((a) => !a.startsWith("--"));
  if (command !== "screenshot") return null;
  if (file && /\.(png|jpe?g)$/i.test(file)) {
    if (file.startsWith("/")) return file;
    if (cwd) return `${cwd.replace(/\/$/, "")}/${file.replace(/^\.\//, "")}`;
  }
  return IMAGE.exec(output)?.[1] ?? null;
}
