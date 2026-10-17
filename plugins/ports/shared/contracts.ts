import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const provider = z.enum(["funnel", "cloudflare"]);
export type Provider = z.infer<typeof provider>;
const access = z.enum(["open", "password"]);
export type Access = z.infer<typeof access>;

const port = z.object({
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
  /** Where your own devices open it. */
  url: z.string(),
  /** Opening it sets up its link first (see linkRpc); `url` is the link until then. */
  needsLink: z.boolean(),
  /** Reachable on your tailnet: over HTTPS by `tailscale serve`, or forwarded over HTTP. */
  private: z.object({ https: z.boolean() }).nullable(),
  /** Reachable by anyone with the link. */
  public: z.object({ url: z.string(), provider, access, password: z.string().nullable() }).nullable(),
});
export type Port = z.infer<typeof port>;

const option = z.object({
  available: z.boolean(),
  /** What's missing when it isn't available. */
  reason: z.string().nullable(),
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
  input: z.object({ port: z.number().int() }),
  output: z.object({ url: z.string() }),
});

export const sharePublicRpc = defineRpc({
  name: "ports.share.public",
  input: z.object({ port: z.number().int(), provider, access }),
  output: z.object({ url: z.string(), password: z.string().nullable() }),
});

/** Stops a port's public link. */
export const unshareRpc = defineRpc({
  name: "ports.unshare",
  input: z.object({ port: z.number().int() }),
  output: z.object({}),
});

export const linkSettings = defineSettings({
  id: "links",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Host name or address the app reaches this machine at; empty picks one automatically. */
    linkHost: z.string().default(""),
  }),
});
