/** What the copy prints last: its exit code. 3: the skill is already there and wasn't replaced. */
export const COPY_EXIT = /__TOOLBOX_COPY_EXIT_(\d+)__/;
export const ALREADY_THERE = "3";

/**
 * The most a packed skill can be, in base64: it travels as the copy command's arguments, and macOS
 * takes 1 MB of arguments and environment at most.
 */
export const MAX_ARCHIVE = 600_000;

// Runs as `sh -c SCRIPT sh <path in home> keep|replace <base64>…`, so no value is parsed by a shell.
// It only writes inside a skills or commands folder in the home folder: a replace removes what's
// there first. The files it writes are the host user's, not the owners they had here. The terminal
// stays open once it's done until the plugin has read the result: Paseo drops a terminal's output
// when its command ends.
const SCRIPT = [
  "rel=$1 mode=$2",
  "shift 2",
  "dest=$HOME/$rel",
  "case /$rel/ in",
  "  */../*|*/./*|//*) code=2 ;;",
  "  */skills/?*/|*/skill/?*/|*/commands/?*.md/)",
  '    if { [ -e "$dest" ] || [ -L "$dest" ]; } && [ "$mode" != replace ]; then code=3',
  "    else",
  "      tmp=$(mktemp -d) &&",
  '        printf %s "$@" | base64 -d | tar -xzf - --no-same-owner -C "$tmp" &&',
  '        mkdir -p "$(dirname "$dest")" &&',
  '        rm -rf "$dest" &&',
  '        mv "$tmp"/* "$dest"',
  "      code=$?",
  '      [ -n "$tmp" ] && rm -rf "$tmp"',
  "    fi ;;",
  "  *) code=2 ;;",
  "esac",
  '[ "$code" = 2 ] && echo "$rel isn\'t a skill\'s place in the home folder"',
  'printf "\\n__TOOLBOX_COPY_EXIT_%s__\\n" "$code"',
  "exec sleep 600",
].join("\n");

/** The terminal command that puts a packed skill at `path` in the home folder. */
export function copyCommand(path: string, archive: string, replace: boolean) {
  // Linux takes one argument of 128 KB at most
  const chunks = archive.match(/.{1,100000}/g) ?? [];
  return { command: "sh", args: ["-c", SCRIPT, "sh", path, replace ? "replace" : "keep", ...chunks] };
}
