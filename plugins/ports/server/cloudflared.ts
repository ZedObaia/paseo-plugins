import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./exec";
import { findExecutable, isExecutable } from "./executables";

/**
 * The cloudflared the plugin downloads when there's none on the host, pinned to one release.
 * `sha256` is GitHub's digest of the release file; `binarySha256` is the checksum Cloudflare
 * publishes in the release notes, which for macOS is of the program inside the archive.
 */
export const CLOUDFLARED_VERSION = "2026.10.1";

export interface CloudflaredAsset {
  name: string;
  size: number;
  sha256: string;
  binarySha256: string;
  /** A .tgz holding the program, as on macOS; on Linux the release file is the program. */
  archive: boolean;
}

const ASSETS: Record<string, CloudflaredAsset> = {
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    size: 40_227_032,
    sha256: "3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586",
    binarySha256: "3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586",
    archive: false,
  },
  "linux-arm64": {
    name: "cloudflared-linux-arm64",
    size: 37_651_992,
    sha256: "2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46",
    binarySha256: "2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46",
    archive: false,
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    size: 21_768_449,
    sha256: "3b0dbaf378337e9d7fb6cd235a76d1d6a7dee434c2d8edf9281164fb6a3837ab",
    binarySha256: "8ccc6383aef109c8d88965937649a796febbb166dab4b73345e820623aee1ede",
    archive: true,
  },
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    size: 19_807_806,
    sha256: "647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc",
    binarySha256: "35b7e34c9a3f214d80d859c4223450c69e583c7668d228c45771026fe376cab9",
    archive: true,
  },
};

export const assetFor = (platform: NodeJS.Platform, arch: string): CloudflaredAsset | null =>
  ASSETS[`${platform}-${arch}`] ?? null;

export const assetUrl = (asset: CloudflaredAsset) =>
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`;

const binDir = () => join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "ports", "bin");
export const downloadedPath = () => join(binDir(), `cloudflared-${CLOUDFLARED_VERSION}`);

/** A cloudflared the host already has, else the one the plugin downloaded, else null. */
export function cloudflaredPath(): string | null {
  const installed = findExecutable("cloudflared");
  if (isExecutable(installed)) return installed;
  return isExecutable(downloadedPath()) ? downloadedPath() : null;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Checks a downloaded release file and returns the program in it, or throws. */
export async function verifiedProgram(
  file: Buffer,
  asset: CloudflaredAsset,
  workDir: string,
): Promise<Buffer> {
  if (file.length !== asset.size || sha256(file) !== asset.sha256)
    throw new Error("The downloaded cloudflared doesn't match Cloudflare's release, so it wasn't installed");
  let program = file;
  if (asset.archive) {
    const archive = join(workDir, asset.name);
    await writeFile(archive, file);
    await run("tar", ["-xzf", archive, "-C", workDir, "cloudflared"]);
    program = await readFile(join(workDir, "cloudflared"));
  }
  if (sha256(program) !== asset.binarySha256)
    throw new Error(
      "The downloaded cloudflared doesn't match Cloudflare's published checksum, so it wasn't installed",
    );
  return program;
}

async function download(): Promise<string> {
  const existing = cloudflaredPath();
  if (existing) return existing;
  const asset = assetFor(process.platform, process.arch);
  if (!asset)
    throw new Error(`The plugin has no cloudflared download for ${process.platform} on ${process.arch}`);
  await mkdir(binDir(), { recursive: true });
  const workDir = await mkdtemp(join(binDir(), ".download-"));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10 * 60_000);
  try {
    const res = await fetch(assetUrl(asset), { signal: abort.signal });
    if (!res.ok) throw new Error(`Downloading cloudflared failed: GitHub answered ${res.status}`);
    const program = await verifiedProgram(Buffer.from(await res.arrayBuffer()), asset, workDir);
    const part = join(workDir, "cloudflared.part");
    await writeFile(part, program);
    await chmod(part, 0o755);
    await rename(part, downloadedPath());
    console.log(`downloaded cloudflared ${CLOUDFLARED_VERSION} to ${downloadedPath()}`);
    return downloadedPath();
  } finally {
    clearTimeout(timer);
    await rm(workDir, { recursive: true, force: true });
  }
}

let downloading: Promise<string> | null = null;

/** Downloads cloudflared once, however many callers ask while it's running. */
export function installCloudflared(): Promise<string> {
  return (downloading ??= download().finally(() => (downloading = null)));
}
