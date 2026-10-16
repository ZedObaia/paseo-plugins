import assert from "node:assert/strict";
import { test } from "node:test";
import { labels, parseSize } from "./exec";
import { readOnlyMount } from "./system";

test("docker sizes, SI and binary units", () => {
  assert.equal(parseSize("1.2GB"), 1_200_000_000);
  assert.equal(parseSize("23.4MiB"), Math.round(23.4 * 1024 ** 2));
  assert.equal(parseSize("0B"), 0);
  assert.equal(parseSize("6.3GB (32%)"), 6_300_000_000);
  assert.equal(parseSize(undefined), 0);
});

test("docker labels", () => {
  assert.deepEqual(labels("com.docker.compose.project=chapbook,a=b=c"), {
    "com.docker.compose.project": "chapbook",
    a: "b=c",
  });
  assert.deepEqual(labels(""), {});
});

test("read-only mounts on macOS and Linux, not errors=remount-ro", () => {
  assert.equal(readOnlyMount("/dev/disk9s1 on /Volumes/Paseo 0.11.4-arm64 (hfs, local, read-only, quarantine)"), "/Volumes/Paseo 0.11.4-arm64");
  assert.equal(readOnlyMount("/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)"), null);
  assert.equal(readOnlyMount("/dev/sda1 on / type ext4 (rw,relatime,errors=remount-ro)"), null);
  assert.equal(readOnlyMount("/dev/loop3 on /snap/core type squashfs (ro,nodev)"), "/snap/core");
});
