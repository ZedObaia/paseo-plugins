import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dotenvFor, gitDir, parseDotenv, serviceEnvName, workspaceEnv, type WorkspaceLike } from "./env";

const scratch = () => mkdtempSync(join(tmpdir(), "quick-commands-env-"));

/** A project checkout and one Paseo worktree of it, the way git and Paseo lay them out. */
function project(options: { branch?: string; port?: number } = {}) {
  const root = scratch();
  const checkout = join(root, "app");
  const worktree = join(root, "worktrees", "login-form");
  const worktreeGit = join(checkout, ".git", "worktrees", "login-form");
  mkdirSync(join(worktreeGit, "paseo"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGit}\n`);
  writeFileSync(
    join(worktreeGit, "HEAD"),
    options.branch === undefined ? "ref: refs/heads/feature/login\n" : options.branch,
  );
  if (options.port)
    writeFileSync(
      join(worktreeGit, "paseo", "worktree.json"),
      JSON.stringify({ version: 2, runtime: { worktreePort: options.port } }),
    );
  return { checkout, worktree, worktreeGit };
}

const workspace = (
  directory: string,
  root: string,
  scripts: WorkspaceLike["scripts"] = [],
): WorkspaceLike => ({
  workspaceDirectory: directory,
  projectRootPath: root,
  scripts,
});

test("git's folder is .git in a checkout, the one a worktree's .git file names, and none elsewhere", async () => {
  const { checkout, worktree, worktreeGit } = project();
  assert.equal(await gitDir(checkout), join(checkout, ".git"));
  assert.equal(await gitDir(worktree), worktreeGit);
  assert.equal(await gitDir(scratch()), null);
  // git writes a relative path for some worktrees
  const relative = scratch();
  mkdirSync(join(relative, "inner", "gitdata"), { recursive: true });
  writeFileSync(join(relative, "inner", ".git"), "gitdir: gitdata\n");
  assert.equal(await gitDir(join(relative, "inner")), join(relative, "inner", "gitdata"));
});

test("a worktree's env has paseo.json's variables: paths, branch, port and services", async () => {
  const { checkout, worktree } = project({ port: 39389 });
  const env = await workspaceEnv(
    workspace(worktree, checkout, [
      { scriptName: "web", type: "service", port: 3000, proxyUrl: "http://web--app.localhost:6767" },
      { scriptName: "my-api", type: "service", port: 51732, proxyUrl: null },
      { scriptName: "test", type: "script", port: null, proxyUrl: null },
    ]),
  );
  assert.deepEqual(env, {
    PASEO_SOURCE_CHECKOUT_PATH: checkout,
    PASEO_WORKTREE_PATH: worktree,
    PASEO_BRANCH_NAME: "feature/login",
    PASEO_WORKTREE_PORT: "39389",
    PASEO_SERVICE_WEB_PORT: "3000",
    PASEO_SERVICE_WEB_URL: "http://web--app.localhost:6767",
    PASEO_SERVICE_MY_API_PORT: "51732",
  });
});

test("a detached worktree has an empty branch, and a folder outside git has neither branch nor port", async () => {
  const { checkout, worktree } = project({ branch: "0123abcd\n" });
  assert.equal((await workspaceEnv(workspace(worktree, checkout))).PASEO_BRANCH_NAME, "");
  const folder = scratch();
  assert.deepEqual(await workspaceEnv(workspace(folder, folder)), {
    PASEO_SOURCE_CHECKOUT_PATH: folder,
    PASEO_WORKTREE_PATH: folder,
  });
});

test("service names are spelled the way Paseo spells them", () => {
  assert.equal(serviceEnvName("web"), "WEB");
  assert.equal(serviceEnvName("my-api.v2"), "MY_API_V2");
  assert.equal(serviceEnvName("-edge-"), "EDGE");
});

test(".env files read as dotenv reads them, without expanding values", () => {
  const values = parseDotenv(
    [
      "# a comment",
      "PLAIN=postgres://localhost/app # the database",
      "export EXPORTED=yes",
      "SINGLE='it''s $HOME'",
      'DOUBLE="line one\\nline two"',
      'MULTI="first',
      'second"',
      "EMPTY=",
      "SPACED = padded ",
      "dotted.name=skipped",
      "REF=$PLAIN",
    ].join("\r\n"),
  );
  assert.deepEqual(values, {
    PLAIN: "postgres://localhost/app",
    EXPORTED: "yes",
    SINGLE: "it''s $HOME",
    DOUBLE: "line one\nline two",
    MULTI: "first\nsecond",
    EMPTY: "",
    SPACED: "padded",
    REF: "$PLAIN",
  });
});

test("a .env comes from the workspace, else the project checkout, and its folder's wins", async () => {
  const { checkout, worktree } = project();
  writeFileSync(join(checkout, ".env"), "A=checkout\nB=checkout\n");
  mkdirSync(join(checkout, "apps", "web"), { recursive: true });
  writeFileSync(join(checkout, "apps", "web", ".env"), "B=checkout-web\n");
  const ws = workspace(worktree, checkout);
  // a fresh worktree has none: the checkout's
  assert.deepEqual(await dotenvFor(ws, worktree), { A: "checkout", B: "checkout" });
  assert.deepEqual(await dotenvFor(ws, join(worktree, "apps", "web")), { A: "checkout", B: "checkout-web" });
  // once it has its own, only its own
  writeFileSync(join(worktree, ".env"), "A=worktree\n");
  assert.deepEqual(await dotenvFor(ws, worktree), { A: "worktree" });
  assert.deepEqual(await dotenvFor(workspace(scratch(), scratch()), "/nowhere"), {});
});
