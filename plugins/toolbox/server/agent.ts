import type { z } from "zod";
import type { Behavior, Change, listRpc, NewServer, skillRpc, Where } from "../shared/contracts";

export type FolderView = z.output<typeof listRpc.output>;
export type SkillFile = z.output<typeof skillRpc.output>;

/** What Toolbox needs from each agent, for a folder its chats run in. */
export type Agent = {
  list(cwd: string, refresh: boolean): Promise<FolderView>;
  /** Saves switches, and says how a chat catches up: a restart, or these commands sent to it. */
  save(cwd: string, changes: Change[]): Promise<{ restart: boolean; commands: string[] }>;
  /** Adds an MCP server where the user chose; returns what to tell them. */
  add(cwd: string, name: string, where: Where, server: NewServer): Promise<string>;
  /** Removes a connector where it's configured; returns the Undo id. */
  remove(cwd: string, name: string): Promise<string>;
  setRule(
    cwd: string,
    server: string,
    tool: string | null,
    behavior: Behavior,
  ): Promise<{ restart: boolean }>;
  skill(cwd: string, name: string): Promise<SkillFile>;
  /** `again`: signs it out first. */
  login(cwd: string, name: string, again: boolean): Promise<{ loginId: string; url: string | null }>;
  trust(cwd: string): Promise<string>;
};
