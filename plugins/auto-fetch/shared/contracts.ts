import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const INTERVALS = [1, 2, 5, 10, 15, 30, 60] as const;

export const fetchSettings = defineSettings({
  id: "fetch",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Minutes between two fetches of a repository. */
    intervalMinutes: z.number().int().min(1).max(1440).default(5),
    /** Move local branches that are only behind their upstream and aren't checked out anywhere. */
    fastForward: z.boolean().default(true),
    /** Start a worktree that would branch from a local branch from the remote branch it tracks. */
    fromRemote: z.boolean().default(true),
    /** Give each worktree of a newly added project its own workspace. */
    importWorktrees: z.boolean().default(true),
  }),
});

const moved = z.object({
  branch: z.string(),
  /** Its upstream, such as origin/main. */
  upstream: z.string(),
  commits: z.number().int(),
  /** Host time in ms. */
  at: z.number(),
});
export type Moved = z.infer<typeof moved>;

const repo = z.object({
  /** The git directory its worktrees share. */
  id: z.string(),
  name: z.string(),
  /** The main checkout, or the git directory of a bare repository, with ~ for the home directory. */
  path: z.string(),
  /** Its active Paseo workspaces. */
  workspaces: z.number().int(),
  fetching: z.boolean(),
  /** Host times in ms; compare them with `now`, not the app's clock. */
  lastFetchedAt: z.number().nullable(),
  nextFetchAt: z.number().nullable(),
  /** Why the last fetch failed; cleared by the next one that works. */
  error: z.string().nullable(),
  /** Branches fetches moved forward in the last day, newest first. */
  moved: z.array(moved),
});
export type Repo = z.infer<typeof repo>;

const status = z.object({
  now: z.number(),
  repos: z.array(repo),
  /** Why the workspace list couldn't be read. */
  error: z.string().nullable(),
});
export type Status = z.infer<typeof status>;

export const statusRpc = defineRpc({
  name: "auto-fetch.status",
  input: z.object({}),
  output: status,
});

/**
 * Fetches one repository, by its ID or a directory inside it, and answers when it's done, or
 * after 25 s with it still fetching; it fails with git's error. Without either, starts fetching
 * every repository and answers at once.
 */
export const fetchNowRpc = defineRpc({
  name: "auto-fetch.fetch-now",
  input: z.object({ repo: z.string().optional(), directory: z.string().optional() }),
  output: status,
});

/**
 * The app calls this when it loads. The plugin's daemon side only reaches the Paseo API through
 * an RPC or a hook, and needs it to add a new project's worktrees as workspaces.
 */
export const attachRpc = defineRpc({
  name: "auto-fetch.attach",
  input: z.object({}),
  output: z.object({}),
});

/** Adds a project's missing workspaces, answering after at most 25 s while longer imports continue. */
export const importWorktreesRpc = defineRpc({
  name: "auto-fetch.import-worktrees",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({ added: z.array(z.string()), importing: z.boolean() }),
});

const pending = z.object({
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  /** Its linked worktrees that have no workspace, active or archived in this project. */
  worktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable() })),
  importing: z.boolean(),
  error: z.string().nullable(),
});
export type Pending = z.infer<typeof pending>;

/** Each git project's worktrees that have no workspace yet, for the sidebar's footer row. */
export const pendingWorktreesRpc = defineRpc({
  name: "auto-fetch.pending-worktrees",
  input: z.object({}),
  output: z.object({ projects: z.array(pending), scanning: z.boolean() }),
});
