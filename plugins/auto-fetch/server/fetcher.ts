import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type { Moved, Repo, Status } from "../shared/contracts";
import type { FastForward } from "./git";
import { wait } from "./wait";

export interface Git {
  commonDir(dir: string, options: { signal?: AbortSignal }): Promise<string>;
  mainPath(gitDir: string): string;
  fetchAll(gitDir: string, options: { signal?: AbortSignal }): Promise<void>;
  fastForward(gitDir: string, options: { signal?: AbortSignal }): Promise<FastForward[]>;
}

interface State {
  id: string;
  workspaces: number;
  running?: Promise<void>;
  lastAttemptAt: number | null;
  lastFetchedAt: number | null;
  /** Failures in a row, which space its fetches out. */
  failures: number;
  error: string | null;
  moved: Moved[];
  /** Fetch it on the next tick, whatever its schedule. */
  forced: boolean;
}

const MAX_BACKOFF_MS = 60 * 60_000;
const MOVES_KEPT_MS = 24 * 60 * 60_000;

const home = homedir();
const tilde = (path: string) =>
  path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Keeps the repositories behind the host's workspaces fetched: each one on its own schedule, one
 * at a time, and less often while it keeps failing.
 */
export class Fetcher {
  intervalMs = 5 * 60_000;
  fastForward = true;
  private readonly repos = new Map<string, State>();
  private queue: Promise<void> = Promise.resolve();
  private listError: string | null = null;
  private ticking: Promise<void> | undefined;
  private again = false;
  private readonly stopped = new AbortController();

  constructor(
    private readonly git: Git,
    private readonly list: () => Promise<string[]>,
    private readonly now = Date.now,
  ) {}

  /** On schedule after the last attempt, and twice as long after each failure in a row, up to an hour. */
  private nextAt(state: State): number {
    if (state.lastAttemptAt === null || state.forced) return 0;
    const backoff = Math.min(
      this.intervalMs * 2 ** state.failures,
      Math.max(this.intervalMs, MAX_BACKOFF_MS),
    );
    return state.lastAttemptAt + backoff;
  }

  private state(id: string): State {
    let state = this.repos.get(id);
    if (!state) {
      state = {
        id,
        workspaces: 0,
        lastAttemptAt: null,
        lastFetchedAt: null,
        failures: 0,
        error: null,
        moved: [],
        forced: false,
      };
      this.repos.set(id, state);
    }
    return state;
  }

  async repoOf(dir: string): Promise<string> {
    return this.git.commonDir(dir, { signal: this.stopped.signal });
  }

  /** Brings the list of repositories up to date with the workspaces. */
  private async discover(): Promise<void> {
    let dirs: string[];
    try {
      dirs = await this.list();
      this.listError = null;
    } catch (error) {
      this.listError = message(error);
      return;
    }
    const counts = new Map<string, number>();
    const resolved = new Map<string, string | null>();
    for (const dir of dirs) {
      // a directory that isn't a repository, or no longer exists, has nothing to fetch
      if (!resolved.has(dir)) resolved.set(dir, await this.repoOf(dir).catch(() => null));
      const id = resolved.get(dir);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, state] of this.repos) if (!counts.has(id) && !state.running) this.repos.delete(id);
    for (const [id, workspaces] of counts) this.state(id).workspaces = workspaces;
  }

  /** Fetches each repository that's due, one after another. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        await this.discover();
        for (const state of [...this.repos.values()]) {
          if (this.stopped.signal.aborted) return;
          // a failure is on the repository's status
          if (this.now() >= this.nextAt(state)) await this.refresh(state.id).catch(() => {});
        }
      } while (this.again && !this.stopped.signal.aborted);
    })().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  /** Fetches a repository now, or joins the fetch already running. Rejects with git's error. */
  refresh(id: string): Promise<void> {
    if (this.stopped.signal.aborted) return Promise.resolve();
    const state = this.state(id);
    if (state.running) return state.running;
    const run = this.queue.then(() => {
      if (!this.stopped.signal.aborted) return this.run(state);
    });
    this.queue = run.catch(() => {});
    return (state.running = run.finally(() => (state.running = undefined)));
  }

  private async run(state: State): Promise<void> {
    state.forced = false;
    state.lastAttemptAt = this.now();
    try {
      await this.git.fetchAll(state.id, { signal: this.stopped.signal });
      if (this.stopped.signal.aborted) return;
      const moved = this.fastForward
        ? await this.git.fastForward(state.id, { signal: this.stopped.signal })
        : [];
      const at = this.now();
      state.moved = [
        ...moved.map((m) => ({ ...m, at })),
        ...state.moved.filter((m) => at - m.at < MOVES_KEPT_MS && !moved.some((n) => n.branch === m.branch)),
      ].slice(0, 10);
      state.lastFetchedAt = at;
      state.failures = 0;
      state.error = null;
    } catch (error) {
      if (this.stopped.signal.aborted) return;
      state.failures += 1;
      state.error = message(error);
      throw error;
    }
  }

  /**
   * Fetches the repository holding `dir`, waiting for it at most `waitMs`, unless it was fetched
   * in the last `maxAgeMs`. Never rejects: whoever waits goes on either way.
   */
  async fresh(dir: string, maxAgeMs: number, waitMs: number): Promise<void> {
    await wait(
      (async () => {
        const id = await this.repoOf(dir).catch(() => null);
        if (!id) return;
        const { lastFetchedAt } = this.state(id);
        if (lastFetchedAt !== null && this.now() - lastFetchedAt < maxAgeMs) return;
        await this.refresh(id);
      })(),
      waitMs,
    ).catch(() => {});
  }

  /**
   * Fetches one repository and waits up to `waitMs` for it, rejecting with git's error. Without
   * one, has every repository fetched on the next tick and returns at once.
   */
  async fetchNow(target: { repo?: string; directory?: string }, waitMs: number): Promise<void> {
    await wait(
      (async () => {
        const { directory } = target;
        const id =
          target.repo ??
          (directory
            ? await this.repoOf(directory).catch(() => {
                throw new Error(`${directory} isn't in a git repository.`);
              })
            : undefined);
        if (!id) {
          for (const state of this.repos.values()) if (!state.running) state.forced = true;
          void this.tick().catch((error) => (this.listError = message(error)));
          return;
        }
        if (target.repo && !this.repos.has(id)) throw new Error("That repository has no workspaces anymore.");
        await this.refresh(id);
      })(),
      waitMs,
    );
  }

  status(): Status {
    const repos: Repo[] = [...this.repos.values()].map((state) => {
      const path = this.git.mainPath(state.id);
      return {
        id: state.id,
        name: basename(path),
        path: tilde(path),
        workspaces: state.workspaces,
        fetching: Boolean(state.running) || state.forced,
        lastFetchedAt: state.lastFetchedAt,
        nextFetchAt: state.running ? null : this.nextAt(state),
        error: state.error,
        moved: state.moved.filter((m) => this.now() - m.at < MOVES_KEPT_MS),
      };
    });
    repos.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return { now: this.now(), repos, error: this.listError };
  }

  stop(): void {
    this.stopped.abort();
  }
}
