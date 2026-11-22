import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { envScript, launch, launcherName, shellKind, typed, waitForPrompt, type Launch } from "./shell";

const TRICKY = `it's "quoted" $HOME \`date\` \\ back\nslash`;

/** Writes a launch's files the way a run does, into a fresh temporary folder. */
function prepare(make: (tempDir: string) => Launch): Launch & { tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "quick-commands-shell-"));
  const run = make(tempDir);
  for (const { path, text } of run.files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return { ...run, tempDir };
}

test("bash, other POSIX shells and fish each get their own kind; others none", () => {
  assert.equal(shellKind("/bin/bash"), "bash");
  assert.equal(shellKind("/usr/local/bin/zsh"), "posix");
  assert.equal(shellKind("/bin/sh"), "posix");
  assert.equal(shellKind("/opt/homebrew/bin/fish"), "fish");
  assert.equal(shellKind("/usr/bin/nu"), null);
});

test("values survive the env file's quoting in a real shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "quick-commands-quote-"));
  const file = join(dir, "env");
  writeFileSync(file, envScript("posix", { TRICKY, EMPTY: "" }));
  const out = spawnSync("sh", ["-c", '. "$1"; printf "%s|%s" "$TRICKY" "$EMPTY"', "sh", file], {
    encoding: "utf8",
  });
  assert.equal(out.stdout, `${TRICKY}|`);
});

test("a run types each line and Enter; typed in, the lines become one without comments", () => {
  assert.equal(typed("  npm ci\nnpm run dev\n", true), "npm ci\rnpm run dev\r");
  assert.equal(typed("cd apps/web\n# then\n\nnpm test -- ", false), "cd apps/web; npm test --");
});

test("the launcher is named after the label, in a folder no other file shares", () => {
  assert.equal(launcherName("Dev server"), "Dev server");
  assert.equal(launcherName("web/api"), "web∕api");
  assert.equal(launcherName(".."), ".._");
  const run = launch("/bin/zsh", "posix", {}, "env", "ls", true, "/tmp/run");
  assert.deepEqual(run.args, ["/tmp/run/tab/env"]);
  assert.deepEqual(
    run.files.map((file) => file.path),
    ["/tmp/run/env", "/tmp/run/tab/env"],
  );
});

test("bash runs the command as it starts; zsh, insert-only bash and fish get it typed", () => {
  const bash = launch("/bin/bash", "bash", {}, "Dev", "npm run dev", true, "/tmp/run");
  assert.equal(bash.type, null);
  assert.ok(bash.files.some((file) => file.path === "/tmp/run/rc" && file.text.includes("\nnpm run dev\n")));
  assert.equal(launch("/bin/bash", "bash", {}, "Dev", "npm run dev", false, "/tmp/run").type, "npm run dev");
  assert.equal(launch("/bin/zsh", "posix", {}, "Dev", "npm run dev", true, "/tmp/run").type, "npm run dev\r");
  const fish = launch("/usr/bin/fish", "fish", { A: "it's" }, "Dev", "ls", true, "/tmp/run");
  assert.deepEqual(fish.args, ["-C", "source '/tmp/run/env'; rm -rf '/tmp/run'"]);
  assert.equal(fish.files[0].text, "set -gx A 'it\\'s'\n");
});

test("a POSIX launcher hands the shell its variables, deletes the files, and stays a shell", () => {
  const run = prepare((tempDir) => launch("/bin/sh", "posix", { TRICKY }, "Show env", "ls", true, tempDir));
  assert.equal(basename(run.args[0]), "Show env");
  const out = spawnSync(run.command, run.args, { input: 'printf "%s" "$TRICKY"\nexit\n', encoding: "utf8" });
  assert.equal(out.stdout, TRICKY);
  assert.equal(existsSync(run.tempDir), false);
});

test("bash's launcher runs the command with the variables, in history, and deletes the files", () => {
  const home = mkdtempSync(join(tmpdir(), "quick-commands-home-"));
  writeFileSync(join(home, ".bashrc"), "FROM_RC=yes\n");
  const run = prepare((tempDir) =>
    launch("/bin/bash", "bash", { TRICKY }, "Dev", 'printf "%s|%s" "$TRICKY" "$FROM_RC"', true, tempDir),
  );
  const out = spawnSync(run.command, run.args, {
    input: "history 1\nexit\n",
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.ok(out.stdout.includes(`${TRICKY}|yes`), out.stdout);
  assert.match(out.stdout, /printf "%s\|%s" "\$TRICKY" "\$FROM_RC"/);
  assert.equal(existsSync(run.tempDir), false);
});

test("the prompt counts once the screen shows something and stops changing", async () => {
  const screens = ["", "", "user@host:~$", "user@host:~$", "user@host:~$", "user@host:~$"];
  let read = 0;
  const ready = await waitForPrompt(async () => screens[Math.min(read++, screens.length - 1)], { stepMs: 1 });
  assert.equal(ready, true);
  assert.equal(read, 6);
  let tick = 0;
  const never = await waitForPrompt(async () => `frame ${tick++}`, { timeoutMs: 30, stepMs: 1 });
  assert.equal(never, false);
});
