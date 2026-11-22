import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { quickCommand, type QuickCommand } from "../shared/contracts";
import { runCommand } from "./run";

/** Runs a test under another SHELL, the variable a run starts. */
function useShell(t: TestContext, shell: string) {
  const before = process.env.SHELL;
  process.env.SHELL = shell;
  t.after(() => {
    if (before === undefined) delete process.env.SHELL;
    else process.env.SHELL = before;
  });
}

const command = (fields: Partial<QuickCommand> & { label: string; command: string }) =>
  quickCommand.parse({ id: "c1", ...fields });

/** Paseo's API as a run uses it: one workspace, and terminals that remember what was done to them. */
function fakePaseo(directory: string, terminals: { id: string; name: string }[] = []) {
  const done = {
    killed: [] as string[],
    created: [] as {
      name?: string;
      cwd?: string;
      command?: string;
      args?: string[];
      launcher: string;
      env: string;
    }[],
    written: [] as string[],
  };
  const paseo = {
    workspaces: {
      ref: () => ({
        refresh: async () => ({
          projectId: "p1",
          workspaceDirectory: directory,
          projectRootPath: directory,
          scripts: [],
        }),
      }),
    },
    terminals: {
      list: async () => ({ entries: terminals }),
      ref: (id: string) => ({ kill: async () => void done.killed.push(id) }),
      create: async (options: { name?: string; cwd?: string; command?: string; args?: string[] }) => {
        // keep what the files said, then delete them as the shell would
        const launcher = readFileSync(options.args![0], "utf8");
        const tempDir = dirname(dirname(options.args![0]));
        done.created.push({ ...options, launcher, env: readFileSync(join(tempDir, "env"), "utf8") });
        rmSync(tempDir, { recursive: true });
        return {
          id: "t-new",
          capture: async () => ({ lines: ["user@host:~$ "] }),
          write: (text: string) => void done.written.push(text),
        };
      },
    },
  };
  return { paseo: paseo as never, done };
}

test("a run opens a terminal named after the command, in its folder, then types it", async (t) => {
  useShell(t, "/bin/zsh");
  const directory = mkdtempSync(join(tmpdir(), "quick-commands-run-"));
  mkdirSync(join(directory, "apps", "web"), { recursive: true });
  writeFileSync(join(directory, ".env"), "SECRET=s3cret\n");
  const { paseo, done } = fakePaseo(directory);
  const result = await runCommand(
    paseo,
    command({ label: "Web dev", command: "npm run dev", folder: "apps/web", loadDotenv: true }),
    "w1",
    true,
  );
  assert.deepEqual(result, { terminalId: "t-new" });
  const [created] = done.created;
  assert.equal(created.name, "Web dev");
  assert.equal(created.cwd, join(directory, "apps", "web"));
  assert.equal(created.command, "/bin/zsh");
  assert.match(created.args![0], /\/tab\/Web dev$/);
  assert.match(created.launcher, /^\. '[^']+\/env'; rm -rf /);
  assert.match(created.env, /^export SECRET='s3cret'$/m);
  assert.match(created.env, new RegExp(`^export PASEO_WORKTREE_PATH='${directory}'$`, "m"));
  assert.deepEqual(done.written, ["npm run dev\r"]);
});

test("replacing closes the terminals named after the command, and only those", async (t) => {
  useShell(t, "/bin/bash");
  const directory = mkdtempSync(join(tmpdir(), "quick-commands-run-"));
  const { paseo, done } = fakePaseo(directory, [
    { id: "t1", name: "Dev" },
    { id: "t2", name: "Terminal 1" },
    { id: "t3", name: "Dev" },
  ]);
  await runCommand(paseo, command({ label: "Dev", command: "npm run dev", replace: true }), "w1", true);
  assert.deepEqual(done.killed, ["t1", "t3"]);
  // bash runs it as it starts: nothing to type
  assert.deepEqual(done.written, []);
});

test("a command for another project, a missing folder or an unknown shell starts nothing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "quick-commands-run-"));
  const { paseo, done } = fakePaseo(directory);
  useShell(t, "/bin/bash");
  await assert.rejects(
    runCommand(
      paseo,
      command({ label: "Dev", command: "ls", projectId: "p2", projectName: "docs" }),
      "w1",
      true,
    ),
    /Dev is for docs, not this one/,
  );
  await assert.rejects(
    runCommand(paseo, command({ label: "Dev", command: "ls", folder: "apps/api" }), "w1", true),
    /This workspace has no apps\/api folder/,
  );
  // the first useShell puts SHELL back afterwards
  process.env.SHELL = "/usr/bin/nu";
  await assert.rejects(
    runCommand(paseo, command({ label: "Dev", command: "ls" }), "w1", true),
    /can't hand variables to nu/,
  );
  assert.equal(done.created.length, 0);
});

test("a terminal that fails to start leaves no variables behind", async (t) => {
  useShell(t, "/bin/bash");
  const directory = mkdtempSync(join(tmpdir(), "quick-commands-run-"));
  writeFileSync(join(directory, ".env"), "SECRET=s3cret\n");
  const { paseo } = fakePaseo(directory);
  const runs = () => readdirSync(tmpdir()).filter((name) => name.startsWith("paseo-quick-commands-"));
  const before = runs();
  (paseo as { terminals: { create(): Promise<never> } }).terminals.create = async () => {
    throw new Error("The daemon did not create a terminal");
  };
  await assert.rejects(
    runCommand(paseo, command({ label: "Dev", command: "ls", loadDotenv: true }), "w1", true),
    /did not create a terminal/,
  );
  const left = runs().filter((name) => !before.includes(name));
  assert.deepEqual(left, []);
  assert.ok(existsSync(directory));
});
