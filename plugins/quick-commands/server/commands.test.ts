import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandsFor,
  pickCommand,
  quickCommand,
  scopeName,
  withCommand,
  type QuickCommand,
} from "../shared/contracts";

const command = (label: string, projectId: string | null = null): QuickCommand =>
  quickCommand.parse({
    id: label.toLowerCase().replace(/\W/g, ""),
    label,
    command: `echo ${label}`,
    projectId,
  });

test("a saved command takes defaults for what it leaves out, and needs a name and a command", () => {
  assert.deepEqual(quickCommand.parse({ id: "c1", label: " Dev ", command: "npm run dev" }), {
    id: "c1",
    label: "Dev",
    command: "npm run dev",
    projectId: null,
    projectName: "",
    folder: "",
    pressEnter: true,
    replace: false,
    loadDotenv: false,
  });
  assert.equal(quickCommand.safeParse({ id: "c1", label: "Dev", command: " \n " }).success, false);
  assert.equal(quickCommand.safeParse({ id: "c1", label: " ", command: "ls" }).success, false);
});

test("a workspace's commands are its project's, then every project's, in their saved order", () => {
  const all = [
    command("Lint"),
    command("Dev", "p1"),
    command("Other", "p2"),
    command("Test"),
    command("Db", "p1"),
  ];
  assert.deepEqual(
    commandsFor(all, "p1").map((c) => c.label),
    ["Dev", "Db", "Lint", "Test"],
  );
  assert.deepEqual(
    commandsFor(all, "p3").map((c) => c.label),
    ["Lint", "Test"],
  );
});

test("/run takes a name in any case, or the start of one that only one name has", () => {
  const all = [command("Dev server"), command("Db reset"), command("Lint")];
  assert.equal(pickCommand(all, "lint").label, "Lint");
  assert.equal(pickCommand(all, "  DEV SERVER ").label, "Dev server");
  assert.equal(pickCommand(all, "dev").label, "Dev server");
  assert.throws(() => pickCommand(all, "d"), /"d" could be Dev server or Db reset/);
  assert.throws(
    () => pickCommand(all, "nope"),
    /No quick command here is named "nope": Dev server, Db reset, Lint/,
  );
  assert.throws(() => pickCommand(all, " "), /Name one after \/run: Dev server, Db reset, Lint/);
  assert.throws(() => pickCommand([], "lint"), /no quick commands yet/);
});

test("a project's name stands in for it, and says so once Paseo no longer has it", () => {
  assert.equal(scopeName({ projectId: null, projectName: "" }), "Every project");
  assert.equal(scopeName({ projectId: "p1", projectName: "acme-shop" }), "acme-shop");
  assert.equal(scopeName({ projectId: "p1", projectName: "" }), "a project Paseo no longer has");
});

test("saving one command keeps the others as they are now, whoever added them", () => {
  // the list as the daemon has it: a script added "Base" since the screen loaded
  const current = [command("Lint"), command("Base")];
  const edited = { ...command("Lint"), command: "npm run lint -- --fix" };
  assert.deepEqual(
    withCommand(current, edited).map((c) => [c.label, c.command]),
    [
      ["Lint", "npm run lint -- --fix"],
      ["Base", "echo Base"],
    ],
  );
  assert.deepEqual(
    withCommand(current, command("Dev")).map((c) => c.label),
    ["Lint", "Base", "Dev"],
  );
  // a new one can't take a name the newcomer has, in any case
  assert.throws(
    () => withCommand(current, { ...command("BASE"), id: "other" }),
    /Another command is named BASE/,
  );
});
