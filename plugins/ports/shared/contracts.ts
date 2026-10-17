import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const provider = z.enum(["funnel", "cloudflare"]);
export type Provider = z.infer<typeof provider>;
const access = z.enum(["open", "password"]);
export type Access = z.infer<typeof access>;

const port = z.object({
  id: z.string(),
  port: z.number().int(),
  /** What the socket is bound to: 127.0.0.1, ::1, 0.0.0.0, ::, or one interface's address. */
  address: z.string(),
  /** Process name, or container name for a Docker port. */
  name: z.string(),
  /** Command line, or the image for a Docker port. */
  detail: z.string(),
  pid: z.number().int().nullable(),
  source: z.enum(["process", "docker"]),
  /** The Paseo service script that was given this port, if any. */
  service: z.string().nullable(),
  /** What it speaks, from its answer to one request; `unknown` until it answers. */
  protocol: z.enum(["http", "https", "other", "unknown"]),
  /** It gets links: an HTTP server that's a process, serves a page, or that you allowed. */
  links: z.boolean(),
  /** An HTTP server that only gets links if you allow it, like a container's API. */
  allowable: z.boolean(),
  /** You allowed links for it. */
  allowed: z.boolean(),
  /** host:port it can be reached at as it is, without a forward; null when only this machine can. */
  reach: z.string().nullable(),
  /** Where your own devices open it. */
  url: z.string(),
  /** Opening it sets up its link first (see linkRpc); `url` is the link until then. */
  needsLink: z.boolean(),
  /** Reachable on your tailnet: over HTTPS by `tailscale serve`, or forwarded over HTTP. */
  private: z.object({ https: z.boolean(), error: z.string().optional() }).nullable(),
  /** Reachable by anyone with the link. */
  public: z
    .object({
      url: z.string(),
      provider,
      access,
      password: z.string().nullable(),
      error: z.string().optional(),
    })
    .nullable(),
});
export type Port = z.infer<typeof port>;

const option = z.object({
  available: z.boolean(),
  /** What's missing when it isn't available. */
  reason: z.string().nullable(),
  /** What the plugin can download to make it available, once the user agrees to. */
  download: z.object({ version: z.string(), sizeBytes: z.number() }).nullable(),
});
export type SharingOption = z.infer<typeof option>;

const sharing = z.object({
  /** The machine's name on the tailnet, e.g. devbox.tail1234.ts.net. */
  tailnetName: z.string().nullable(),
  /** Private shares over HTTPS. Without it a private share is a forward over HTTP. */
  https: option,
  funnel: option,
  cloudflare: option,
});
export type Sharing = z.infer<typeof sharing>;

const target = z.object({ workspaceId: z.string().min(1), id: z.string().min(1) });
export type PortTarget = z.infer<typeof target>;

export const scanRpc = defineRpc({
  name: "ports.scan",
  input: z.object({}),
  output: z.object({
    /** Ports by workspace ID; workspaces without ports are left out. */
    workspaces: z.record(z.string(), z.array(port)),
    /** Host name or address in the links. */
    linkHost: z.string(),
    sharing,
    /** Why the scan found nothing it could attribute, e.g. an unsupported platform. */
    error: z.string().nullable(),
  }),
});

/**
 * The link your devices open a port at: HTTPS at the machine's tailnet name where Tailscale has
 * it, else the link host, forwarded when the server only listens on loopback.
 */
export const linkRpc = defineRpc({
  name: "ports.link",
  input: target,
  output: z.object({ url: z.string() }),
});

export const sharePublicRpc = defineRpc({
  name: "ports.share.public",
  input: target.extend({ provider, access }),
  output: z.object({ url: z.string(), password: z.string().nullable() }),
});

/**
 * Downloads cloudflared, which only happens when the user asks for it. Answers within 40 s;
 * `done` is false while the download is still running, so call it again.
 */
export const installCloudflaredRpc = defineRpc({
  name: "ports.cloudflared.install",
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
});

/** Stops a link the plugin created. */
export const unshareRpc = defineRpc({
  name: "ports.unshare",
  input: target.extend({ level: z.enum(["private", "public"]).default("public") }),
  output: z.object({}),
});

export const linkSettings = defineSettings({
  id: "links",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Host name or address the app reaches this machine at; empty picks one automatically. */
    linkHost: z.string().default(""),
    /** Ports you allowed links for though they don't get them by default, by server identity. */
    allowed: z.array(z.string()).default([]),
  }),
});
