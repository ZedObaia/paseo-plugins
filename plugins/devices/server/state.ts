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
  // a workspace holds any number of devices; a device belongs to at most one workspace
  assignments: Assignment[];
  // devices this plugin created (simulators, extra emulator instances): offered for deletion
  owned: string[];
  // devices the user let agents drive (agent-device installs its helpers on first use)
  agentTools: string[];
  // workspace id -> the device its agents last chose with use_device
  targets: Record<string, string>;
}

let state: State = { assignments: [], owned: [], agentTools: [], targets: {} };

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
export const agentToolsAllowed = (deviceId: string) => state.agentTools.includes(deviceId);
export const anyAgentTools = () => state.agentTools.length > 0;

export async function allowAgentTools(deviceId: string, allow: boolean): Promise<void> {
  state.agentTools = state.agentTools.filter((id) => id !== deviceId);
  if (allow) {
    // agents keep the device they drive: allowing one added before it doesn't move them
    const holder = holderOf(deviceId);
    const current = holder && targetOf(holder.workspaceId);
    if (holder && current) state.targets[holder.workspaceId] ??= current.deviceId;
    state.agentTools.push(deviceId);
  }
  // allowed again later, it doesn't pull agents back from where they moved
  else forgetTarget(deviceId);
  await save();
}
export const holderOf = (deviceId: string) => state.assignments.find((a) => a.deviceId === deviceId);

/** Forgets that agents in any workspace chose this device. */
function forgetTarget(deviceId: string): void {
  for (const [workspaceId, target] of Object.entries(state.targets))
    if (target === deviceId) delete state.targets[workspaceId];
}

/** Forgets who holds a device, and that agents chose it. */
function unassign(deviceId: string): void {
  state.assignments = state.assignments.filter((a) => a.deviceId !== deviceId);
  forgetTarget(deviceId);
}

/** Adds a device to a workspace's devices. Refuses one another workspace holds unless takeOver. */
export async function addAssignment(
  workspace: Omit<Assignment, "deviceId">,
  deviceId: string,
  takeOver: boolean,
): Promise<string> {
  const holder = holderOf(deviceId);
  if (holder?.workspaceId === workspace.workspaceId) return "It's already this workspace's device";
  if (holder && !takeOver) throw new Error(`In use by ${holder.workspaceName}`);
  unassign(deviceId);
  state.assignments.push({ ...workspace, deviceId });
  await save();
  return holder ? `Taken over from ${holder.workspaceName}` : "Device added";
}

/** Takes a device from a workspace; false if that workspace doesn't hold it (any more). */
export async function removeAssignment(workspaceId: string, deviceId: string): Promise<boolean> {
  if (holderOf(deviceId)?.workspaceId !== workspaceId) return false;
  unassign(deviceId);
  await save();
  return true;
}

/**
 * The device agents in a workspace drive, of those it holds that allow agents: the one they last
 * chose, else the first added. agent-device follows one device per workspace.
 * ponytail: per workspace, so two agents in one workspace switch each other; per-agent config
 * files would fix that.
 */
export function targetOf(workspaceId: string): Assignment | undefined {
  const drivable = state.assignments.filter(
    (a) => a.workspaceId === workspaceId && agentToolsAllowed(a.deviceId),
  );
  return drivable.find((a) => a.deviceId === state.targets[workspaceId]) ?? drivable[0];
}

export async function setTarget(workspaceId: string, deviceId: string): Promise<void> {
  // released, taken over or consent withdrawn since use_device began: it mustn't come back later
  if (holderOf(deviceId)?.workspaceId !== workspaceId || !agentToolsAllowed(deviceId)) return;
  state.targets[workspaceId] = deviceId;
  await save();
}

export async function setOwned(deviceId: string, owned: boolean): Promise<void> {
  state.owned = state.owned.filter((id) => id !== deviceId);
  if (owned) state.owned.push(deviceId);
  else {
    // a copy that's gone for good: its id may come back as a different emulator
    unassign(deviceId);
    state.agentTools = state.agentTools.filter((id) => id !== deviceId);
  }
  await save();
}

export const isInside = (cwd: string, dir: string) =>
  cwd === dir || cwd.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * An assignment of the workspace containing cwd (the deepest directory wins), for its workspace.
 * ponytail: only workspaces holding a device are known here, so a workspace without one inside
 * another's folder gets the outer workspace's devices and picker. Paseo keeps worktrees in
 * ~/.paseo/worktrees, so that takes a project added inside another; the fix is a paginated
 * workspace list per agent.
 */
export function assignmentFor(cwd: string): Assignment | undefined {
  return [...state.assignments]
    .filter((a) => isInside(cwd, a.directory))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
}
