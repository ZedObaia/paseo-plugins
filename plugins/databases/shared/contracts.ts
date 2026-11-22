import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const connectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["pg", "sqlite"]),
  endpoint: z.string(),
  source: z.enum(["environment", "docker", "host", "saved"]),
  scope: z.enum(["workspace", "host"]),
  detail: z.string(),
  needsCredentials: z.boolean(),
});
export type Connection = z.infer<typeof connectionSchema>;

const studioSchema = z.object({ url: z.string(), port: z.number(), sessionId: z.string() });
export type StudioSession = z.infer<typeof studioSchema>;

export const discoverRpc = defineRpc({
  name: "databases.discover",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    connections: z.array(connectionSchema),
    notices: z.array(z.string()),
    studio: studioSchema.optional(),
  }),
});

export const launchRpc = defineRpc({
  name: "databases.launch",
  input: z.object({
    workspaceId: z.string().min(1),
    connectionId: z.string().optional(),
    reuseOptions: z.boolean().optional(),
    url: z.string().max(8192).optional(),
    file: z.string().trim().min(1).max(4096).optional(),
    provider: z.string().max(200).optional(),
    browserOrigin: z.string().max(2048).optional(),
    username: z.string().max(256).optional(),
    password: z.string().max(2048).optional(),
    database: z.string().min(1).max(256).optional(),
  }),
  output: studioSchema,
});

export const stopRpc = defineRpc({
  name: "databases.stop",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ message: z.string() }),
});
