import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

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
  /** Where to open it from the app. */
  url: z.string(),
  /** Bound to loopback on a host the app reaches over the network: opening it forwards it first. */
  needsForward: z.boolean(),
  forwarded: z.boolean(),
});
export type Port = z.infer<typeof port>;

export const scanRpc = defineRpc({
  name: "ports.scan",
  input: z.object({}),
  output: z.object({
    /** Ports by workspace ID; workspaces without ports are left out. */
    workspaces: z.record(z.string(), z.array(port)),
    /** Host name or address in the links. */
    linkHost: z.string(),
    /** Why the scan found nothing it could attribute, e.g. an unsupported platform. */
    error: z.string().nullable(),
  }),
});

export const forwardRpc = defineRpc({
  name: "ports.forward",
  input: z.object({ port: z.number().int() }),
  output: z.object({ url: z.string() }),
});

export const unforwardRpc = defineRpc({
  name: "ports.unforward",
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
