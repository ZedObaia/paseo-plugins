import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Project } from "./registry";

/** What the importer needs of the Paseo API. */
export interface Workspaces {
  create(options: {
    source: { kind: "directory"; path: string; projectId: string };
    idempotencyKey: string;
  }): Promise<unknown>;
}

export interface ImporterDeps {
  projects(): Promise<Project[]>;
  workspaceDirs(): Promise<string[]>;
  worktreesToAdd(root: string, workspaceDirs: string[]): Promise<string[]>;
  /** Where the projects it has seen are kept. */
  file: string;
}

export const knownProjectsFile = (home: string) => join(home, "plugin-data", "auto-fetch", "projects.json");

/**
 * Gives a new project's worktrees their own workspaces. A project is new when the plugin first
 * sees it; the ones the host had when the plugin first ran aren't, and keep the workspaces they
 * have.
 */
export class Importer {
  enabled = true;
  private known: Set<string> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ImporterDeps) {}

  private async load(): Promise<Set<string>> {
    if (this.known) return this.known;
    try {
      const saved = JSON.parse(await readFile(this.deps.file, "utf8")) as { known?: unknown };
      this.known = new Set(Array.isArray(saved.known) ? saved.known.map(String) : []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // the first run: the projects there are now aren't new
      this.known = new Set((await this.deps.projects()).map((p) => p.projectId));
      await this.save();
    }
    return this.known;
  }

  private async save(): Promise<void> {
    const temp = `${this.deps.file}.${process.pid}.tmp`;
    await mkdir(dirname(this.deps.file), { recursive: true });
    await writeFile(temp, JSON.stringify({ known: [...(this.known ?? [])] }));
    await rename(temp, this.deps.file);
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
    return this.serial(async () => {
      const known = await this.load();
      const fresh = (await this.deps.projects()).filter((p) => !known.has(p.projectId));
      if (!fresh.length || (this.enabled && !workspaces)) return;
      for (const project of fresh) {
        if (this.enabled && workspaces)
          await this.add(workspaces, project).catch((error) =>
            console.error(`adding the worktrees of ${project.rootPath} failed:`, error),
          );
        known.add(project.projectId);
      }
      await this.save();
    });
  }

  /** Adds a project's worktrees that have no workspace yet, and answers with their directories. */
  importProject(workspaces: Workspaces, project: Project): Promise<string[]> {
    return this.serial(() => this.add(workspaces, project));
  }

  private async add(workspaces: Workspaces, project: Project): Promise<string[]> {
    const paths = await this.deps.worktreesToAdd(project.rootPath, await this.deps.workspaceDirs());
    for (const path of paths)
      await workspaces.create({
        source: { kind: "directory", path, projectId: project.projectId },
        // a retry of the same request doesn't make a second workspace
        idempotencyKey: `auto-fetch:${project.projectId}:${path}`,
      });
    if (paths.length) console.log(`added ${paths.length} worktrees of ${project.rootPath}:`, paths);
    return paths;
  }
}
