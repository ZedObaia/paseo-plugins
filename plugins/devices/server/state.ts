import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Assignment } from "../shared/contracts";

export const STATE_DIR = path.join(
  process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
  "plugin-data",
  "devices",
);
const FILE = path.join(STATE_DIR, "state.json");

interface State {
  // one device per workspace; a device belongs to at most one workspace
  assignments: Assignment[];
  // devices this plugin created (simulators, extra emulator instances): offered for deletion
  owned: string[];
}

let state: State = { assignments: [], owned: [] };

export async function loadState(): Promise<void> {
  try {
    state = { ...state, ...(JSON.parse(await readFile(FILE, "utf8")) as Partial<State>) };
  } catch {
    // first run
  }
}

// Saves run one after another: two RPCs saving at once would share the temp file.
let saving = Promise.resolve();
function save(): Promise<void> {
  saving = saving
    .catch(() => {})
    .then(async () => {
      await mkdir(STATE_DIR, { recursive: true });
      await writeFile(`${FILE}.tmp`, JSON.stringify(state, null, 2));
      await rename(`${FILE}.tmp`, FILE);
    });
  return saving;
}

export const assignments = (): readonly Assignment[] => state.assignments;
export const owned = (): readonly string[] => state.owned;
export const isOwned = (deviceId: string) => state.owned.includes(deviceId);
export const holderOf = (deviceId: string) => state.assignments.find((a) => a.deviceId === deviceId);

export async function setAssignment(
  workspace: Omit<Assignment, "deviceId">,
  deviceId: string | null,
  takeOver: boolean,
): Promise<string> {
  const holder = deviceId ? holderOf(deviceId) : undefined;
  if (holder && holder.workspaceId !== workspace.workspaceId && !takeOver) {
    throw new Error(`In use by ${holder.workspaceName}`);
  }
  state.assignments = state.assignments.filter(
    (a) => a.workspaceId !== workspace.workspaceId && (deviceId === null || a.deviceId !== deviceId),
  );
  if (deviceId) state.assignments.push({ ...workspace, deviceId });
  await save();
  if (!deviceId) return "Released the device";
  return holder && holder.workspaceId !== workspace.workspaceId
    ? `Taken over from ${holder.workspaceName}`
    : "Device assigned";
}

export async function setOwned(deviceId: string, owned: boolean): Promise<void> {
  state.owned = state.owned.filter((id) => id !== deviceId);
  if (owned) state.owned.push(deviceId);
  else state.assignments = state.assignments.filter((a) => a.deviceId !== deviceId);
  await save();
}

/**
 * The assignment of the workspace containing cwd (the deepest directory wins).
 * ponytail: only workspaces holding a device are known here, so a workspace without one inside
 * another's folder gets the outer workspace's device. Paseo keeps worktrees in ~/.paseo/worktrees,
 * so that takes a project added inside another; the fix is a paginated workspace list per agent.
 */
export function assignmentFor(cwd: string): Assignment | undefined {
  const inside = (dir: string) =>
    cwd === dir || cwd.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  return [...state.assignments]
    .filter((a) => inside(a.directory))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
}
