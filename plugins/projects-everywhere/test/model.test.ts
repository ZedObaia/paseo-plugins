import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLONEABLE,
  cloneUrlOf,
  homeRelative,
  identity,
  parseTarget,
  projectRows,
  remoteKeyOf,
} from "../client/model";

test("paths in a home folder become ~ paths, on macOS and Linux", () => {
  assert.equal(homeRelative("/Users/zeyad/workspace/paseo-plugins"), "~/workspace/paseo-plugins");
  assert.equal(homeRelative("/home/zeyad/workspace/x"), "~/workspace/x");
  assert.equal(homeRelative("/root/x"), "~/x");
  assert.equal(homeRelative("/Users/zeyad"), "~");
  assert.equal(homeRelative("/opt/projects/x"), "/opt/projects/x");
  assert.equal(homeRelative("/Users2/x"), "/Users2/x");
});

test("clone URLs from Paseo's remote project keys", () => {
  assert.equal(
    cloneUrlOf("remote:github.com/zedobaia/paseo-plugins"),
    "https://github.com/zedobaia/paseo-plugins.git",
  );
  assert.equal(cloneUrlOf("remote:gitlab.com/group/sub/repo"), "https://gitlab.com/group/sub/repo.git");
  assert.equal(cloneUrlOf("prj_0e3af0510537149c"), null);
  assert.equal(cloneUrlOf(undefined), null);
});

test("remote keys from clone URLs match Paseo's (lower case, no transport)", () => {
  assert.equal(
    remoteKeyOf("git@github.com:ZedObaia/paseo-plugins.git"),
    "remote:github.com/zedobaia/paseo-plugins",
  );
  assert.equal(
    remoteKeyOf("https://github.com/ZedObaia/paseo-plugins"),
    "remote:github.com/zedobaia/paseo-plugins",
  );
  assert.equal(remoteKeyOf("ssh://git@gitlab.com/g/sub/repo.git"), "remote:gitlab.com/g/sub/repo");
  assert.equal(cloneUrlOf(remoteKeyOf("git@github.com:a/b.git") ?? ""), "https://github.com/a/b.git");
});

test("one row per project: matched by remote, else by place in the home folder", () => {
  const rows = projectRows([
    {
      serverId: "mac",
      projects: [
        {
          serverId: "mac",
          projectId: "a",
          key: "remote:github.com/z/plugins",
          name: "paseo-plugins",
          root: "/Users/z/workspace/paseo-plugins",
        },
        { serverId: "mac", projectId: "b", key: "prj_1", name: "notes", root: "/Users/z/notes" },
      ],
    },
    {
      serverId: "box",
      projects: [
        {
          serverId: "box",
          projectId: "c",
          key: "remote:github.com/z/plugins",
          name: "plugins",
          root: "/home/z/code/plugins",
        },
        { serverId: "box", projectId: "d", key: "prj_2", name: "notes", root: "/home/z/notes" },
        { serverId: "box", projectId: "e", key: "prj_3", name: "box-only", root: "/srv/box-only" },
      ],
    },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.path, r.cloneUrl, [...r.on.keys()]]),
    [
      ["box-only", "/srv/box-only", null, ["box"]],
      ["notes", "~/notes", null, ["mac", "box"]],
      ["paseo-plugins", "~/workspace/paseo-plugins", "https://github.com/z/plugins.git", ["mac", "box"]],
    ],
  );
  assert.equal(identity({ key: undefined, root: "/home/z/notes" }), "path:~/notes");
});

test("add form input: GitHub shorthand, clone URLs and folders", () => {
  assert.deepEqual(parseTarget("ZedObaia/paseo-plugins", "~/workspace"), {
    path: "~/workspace/paseo-plugins",
    cloneUrl: "https://github.com/ZedObaia/paseo-plugins.git",
  });
  assert.deepEqual(parseTarget("git@github.com:ZedObaia/paseo-plugins.git", "~/code/"), {
    path: "~/code/paseo-plugins",
    cloneUrl: "git@github.com:ZedObaia/paseo-plugins.git",
  });
  assert.equal(parseTarget(" https://gitlab.com/g/repo ", "~/workspace")?.path, "~/workspace/repo");
  assert.deepEqual(parseTarget("~/workspace/notes/", "~/workspace"), {
    path: "~/workspace/notes",
    cloneUrl: null,
  });
  assert.deepEqual(parseTarget("/", "~/workspace"), { path: "/", cloneUrl: null });
  assert.equal(parseTarget("notes", "~/workspace"), null);
  assert.equal(parseTarget("ext::sh -c touch% /tmp/x", "~/workspace"), null);
  assert.equal(parseTarget("ZedObaia/paseo-plugins", "workspace"), null);
  assert.equal(CLONEABLE.test("file:///etc"), false);
});
