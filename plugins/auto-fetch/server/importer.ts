import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Pending } from "../shared/contracts";
import type { RunOptions } from "./git";
import type { Project } from "./registry";
import { resolved, type Missing } from "./worktrees";

/** What the importer needs of the Paseo API. */
export interface Workspaces {
  create(options: { source: { kind: "directory"; path: string; projectId: string } }): Promise<unknown>;
}

export interface ImporterDeps {
  projects(): Promise<Project[]>;
  /** Directories the project's import leaves alone. */
  takenDirs(projectId: string): Promise<string[]>;
  missingWorktrees(root: string, taken: string[], options?: RunOptions): Promise<Missing[]>;
  /** Where the projects it has seen are kept. */
  file: string;
}

export const knownProjectsFile = (home: string) => join(home, "plugin-data", "auto-fetch", "projects.json");

// the sidebar asks every few seconds on each client; git is asked at most this often
const PENDING_FRESH_MS = 10_000;

/**
 * Gives a new project's worktrees their own workspaces. A project is new when the plugin first
 * sees it; the ones the host had when the plugin first ran aren't, and keep the workspaces they
 * have.
 */
export class Importer {
  enabled = true;
  private known: Set<string> | undefined;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();
  private checking: Promise<void> | undefined;
  private readonly imports = new Map<string, Promise<string[]>>();
  private readonly errors = new Map<string, string>();
  private readonly stopped = new AbortController();
  private pendingCache: { at: number; value: Pending[] } | undefined;
  private pendingScan: Promise<Pending[]> | undefined;
  private pendingVersion = 0;

  constructor(private readonly deps: ImporterDeps) {}

  private async load(): Promise<Set<string>> {
    if (this.known) return this.known;
    try {
      const saved = JSON.parse(await readFile(this.deps.file, "utf8")) as { known?: unknown };
      if (!Array.isArray(saved?.known) || saved.known.some((id) => typeof id !== "string"))
        throw new Error(`${this.deps.file} has no valid project list`);
      this.known = new Set(saved.known);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // the first run: the projects there are now aren't new
      this.known = new Set((await this.deps.projects()).map((p) => p.projectId));
      this.dirty = true;
    }
    return this.known;
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    const temp = `${this.deps.file}.${process.pid}.tmp`;
    await mkdir(dirname(this.deps.file), { recursive: true });
    await writeFile(temp, JSON.stringify({ known: [...(this.known ?? [])] }));
    await rename(temp, this.deps.file);
    this.dirty = false;
  }

  /** One at a time, so two checks never add the same worktree twice. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Adds the worktrees of projects it hasn't seen. Without the Paseo API yet, a new project
   * waits for the next check that has it.
   */
  check(workspaces: Workspaces | undefined): Promise<void> {
    if (this.checking) return this.checking;
    return (this.checking = (async () => {
      const known = await this.load();
      await this.save();
      const fresh = (await this.deps.projects()).filter((p) => !known.has(p.projectId));
      if (!fresh.length || (this.enabled && !workspaces)) return;
      for (const project of fresh) {
        if (this.stopped.signal.aborted) return;
        try {
          if (this.enabled && workspaces) await this.importProject(workspaces, project);
        } catch (error) {
          if (this.stopped.signal.aborted) return;
          console.error(`adding the worktrees of ${project.rootPath} failed:`, error);
          continue;
        }
        if (this.stopped.signal.aborted) return;
        known.add(project.projectId);
        this.dirty = true;
      }
      await this.save();
    })().finally(() => (this.checking = undefined)));
  }

  /** Adds a project's worktrees that have no workspace yet, and answers with their directories. */
  importProject(workspaces: Workspaces, project: Project): Promise<string[]> {
    const running = this.imports.get(project.projectId);
    if (running) return running;
    this.errors.delete(project.projectId);
    this.invalidate();
    const run = this.serial(() => this.add(workspaces, project))
      .catch((error) => {
        this.errors.set(project.projectId, error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => {
        this.imports.delete(project.projectId);
        this.invalidate();
      });
    this.imports.set(project.projectId, run);
    return run;
  }

  private async add(workspaces: Workspaces, project: Project): Promise<string[]> {
    if (this.stopped.signal.aborted) return [];
    const missing = await this.deps.missingWorktrees(
      project.rootPath,
      await this.deps.takenDirs(project.projectId),
      { signal: this.stopped.signal },
    );
    const added: string[] = [];
    for (const { path } of missing) {
      if (this.stopped.signal.aborted) break;
      // another client may have added or archived it while the previous one was being created
      const taken = await this.deps.takenDirs(project.projectId);
      if (this.stopped.signal.aborted) break;
      if (taken.some((dir) => resolved(dir) === resolved(path))) continue;
      await workspaces.create({ source: { kind: "directory", path, projectId: project.projectId } });
      added.push(path);
    }
    if (added.length) console.log(`added ${added.length} worktrees of ${project.rootPath}:`, added);
    return added;
  }

  /** Each git project's worktrees that have no workspace, leaving out projects with none. */
  pending(): Promise<Pending[]> {
    if (this.pendingCache && Date.now() - this.pendingCache.at < PENDING_FRESH_MS)
      return Promise.resolve(this.snapshot());
    if (this.pendingScan) return this.pendingScan.then((value) => this.activity(value));
    const version = this.pendingVersion;
    const value = (async () => {
      const pending: Pending[] = [];
      for (const project of await this.deps.projects()) {
        if (this.stopped.signal.aborted) break;
        // a project whose directory is gone or no longer a repository has nothing to add
        const worktrees = await this.deps
          .missingWorktrees(project.rootPath, await this.deps.takenDirs(project.projectId), {
            signal: this.stopped.signal,
          })
          .catch(() => []);
        if (worktrees.length)
          pending.push({
            projectId: project.projectId,
            name: project.customName || project.displayName || basename(project.rootPath),
            path: project.rootPath,
            worktrees,
            importing: false,
            error: null,
          });
      }
      return pending.sort((a, b) => a.name.localeCompare(b.name));
    })();
    this.pendingScan = value
      .then((value) => {
        this.pendingCache = { at: version === this.pendingVersion ? Date.now() : 0, value };
        return value;
      })
      .finally(() => (this.pendingScan = undefined));
    return this.pendingScan.then((value) => this.activity(value));
  }

  private activity(projects: Pending[]): Pending[] {
    return projects.map((project) => ({
      ...project,
      importing: this.imports.has(project.projectId),
      error: this.errors.get(project.projectId) ?? null,
    }));
  }

  snapshot(): Pending[] {
    return this.activity(this.pendingCache?.value ?? []);
  }

  get scanning(): boolean {
    return Boolean(this.pendingScan);
  }

  isImporting(projectId: string): boolean {
    return this.imports.has(projectId);
  }

  /** Workspaces or worktrees changed: the next pending() asks git again. */
  invalidate(): void {
    this.pendingVersion++;
    if (this.pendingCache) this.pendingCache.at = 0;
  }

  stop(): void {
    this.stopped.abort();
  }
}
