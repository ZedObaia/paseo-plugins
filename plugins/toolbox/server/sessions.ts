import { randomUUID } from "node:crypto";

/** A sign-in in progress: the agent waits on this host's localhost for the browser to come back. */
export type Login = {
  state: "waiting" | "done" | "failed";
  message: string;
  // where the agent waits: http://localhost:<port>/callback
  callbackPort: number | null;
  // ends the agent's sign-in process
  stop(): void;
  timer: NodeJS.Timeout;
};

const logins = new Map<string, Login>();
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Tracks a new sign-in until it ends or times out. */
export function trackLogin(stop: () => void): { loginId: string; login: Login } {
  const loginId = randomUUID();
  const login: Login = {
    state: "waiting",
    message: "Waiting for you to sign in",
    callbackPort: null,
    stop,
    timer: setTimeout(() => finishLogin(login, "failed", "Sign-in timed out"), LOGIN_TIMEOUT_MS),
  };
  logins.set(loginId, login);
  return { loginId, login };
}

export function finishLogin(login: Login, state: "done" | "failed", message: string) {
  if (login.state !== "waiting") return;
  login.state = state;
  login.message = message;
  clearTimeout(login.timer);
  // a finished sign-in ends by itself once the agent has saved it
  if (state === "failed") login.stop();
}

/** Forgotten a while after it ends, once the panel has had time to hear how it went. */
export const forgetLogin = (loginId: string) =>
  void setTimeout(() => logins.delete(loginId), 5 * 60_000).unref();

export async function loginStatus(
  loginId: string,
  paste?: string,
): Promise<{ state: Login["state"]; message: string }> {
  const login = logins.get(loginId);
  if (!login) return { state: "failed", message: "That sign-in has ended. Start it again." };
  if (paste !== undefined && login.state === "waiting") await deliver(login, paste.trim());
  return { state: login.state, message: login.message };
}

/**
 * Hands the agent the address a browser on another device landed on, by visiting it from here:
 * it's the agent's own callback on this host. Only that callback is visited.
 */
async function deliver(login: Login, pasted: string): Promise<void> {
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/\S*)$/.exec(pasted);
  if (!login.callbackPort) throw new Error("This sign-in finishes on its own. Nothing to paste.");
  if (!m || Number(m[1]) !== login.callbackPort)
    throw new Error("Paste the browser's whole address. It starts with http://localhost.");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    await fetch(`http://127.0.0.1:${login.callbackPort}${m[2]}`, { signal: abort.signal });
  } catch {
    throw new Error("The sign-in stopped waiting. Start it again.");
  } finally {
    clearTimeout(timer);
  }
}

export function cancelLogin(loginId: string): void {
  const login = logins.get(loginId);
  if (login) finishLogin(login, "failed", "Cancelled");
  logins.delete(loginId);
}

export function stopLogins(): void {
  for (const id of logins.keys()) cancelLogin(id);
}

type Removed = { cwd: string; name: string; restore(): Promise<void> };
// what was removed, kept on the host (it can hold keys) for Undo
const removed = new Map<string, Removed>();

/** Keeps a way to put a removed connector back, for half an hour. */
export function rememberRemoval(cwd: string, name: string, restore: () => Promise<void>): string {
  const undoId = randomUUID();
  removed.set(undoId, { cwd, name, restore });
  setTimeout(() => removed.delete(undoId), 30 * 60_000).unref();
  return undoId;
}

export async function undoRemoval(undoId: string): Promise<{ cwd: string; name: string }> {
  const r = removed.get(undoId);
  if (!r) throw new Error("It's too late to undo that. Add the connector again.");
  await r.restore();
  removed.delete(undoId);
  return r;
}
