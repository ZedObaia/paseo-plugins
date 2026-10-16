import type Sharp from "sharp";
import { pluginRequire } from "./paths";

const sharp = pluginRequire("sharp") as typeof Sharp;

export interface Frame {
  seq: number;
  image: Buffer;
  // RGB pixels when set (Android gRPC); otherwise `image` is an encoded JPEG/PNG
  raw?: { width: number; height: number };
  // degrees to turn the picture clockwise to show it upright
  rotate?: number;
}

const cache = new Map<
  string,
  { seq: number; maxWidth: number; rotate: number; jpeg: string; width: number; height: number }
>();

/** A JPEG no wider than maxWidth, as base64. Re-encodes only when the frame or the width changed. */
export async function encode(deviceId: string, frame: Frame, maxWidth: number) {
  const hit = cache.get(deviceId);
  const rotate = frame.rotate ?? 0;
  if (hit && hit.seq === frame.seq && hit.maxWidth === maxWidth && hit.rotate === rotate) return hit;
  const input = frame.raw ? sharp(frame.image, { raw: { ...frame.raw, channels: 3 } }) : sharp(frame.image);
  const { data, info } = await input
    .rotate(rotate)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer({ resolveWithObject: true });
  const entry = {
    seq: frame.seq,
    maxWidth,
    rotate,
    jpeg: data.toString("base64"),
    width: info.width,
    height: info.height,
  };
  cache.set(deviceId, entry);
  return entry;
}

export const forget = (deviceId: string) => cache.delete(deviceId);
