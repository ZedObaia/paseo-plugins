import { createHash } from "node:crypto";
import { dockerListeners } from "./docker";
import { processListeners, type Listener } from "./processes";

/** A server's binding and provenance, stable across restarts of the same command in its directory. */
export function listenerId(listener: Listener): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        listener.source,
        listener.address,
        listener.port,
        listener.cwd ?? listener.pid,
        listener.workspaceId,
        listener.name,
        listener.detail,
        listener.identity,
      ]),
    )
    .digest("hex");
}

/**
 * Checks that a shared server still owns its port before traffic reaches it. A page load sends
 * dozens of requests at once and reading the listeners blocks for tens of milliseconds, so one
 * read serves every check for `freshMs`; a server that takes over the port is refused once it's
 * seen, at most that long after.
 */
export class ListenerAccess {
  private reads = new Map<Listener["source"], { at: number; listeners: Promise<Listener[]> }>();

  constructor(
    private readonly load = (source: Listener["source"]) =>
      source === "docker" ? dockerListeners() : processListeners(),
    private readonly freshMs = 1_000,
  ) {}

  private listeners(source: Listener["source"]): Promise<Listener[]> {
    const read = this.reads.get(source);
    if (read && Date.now() - read.at < this.freshMs) return read.listeners;
    const listeners = this.load(source);
    const next = { at: Date.now(), listeners };
    this.reads.set(source, next);
    // a failed read isn't reused
    listeners.catch(() => this.reads.get(source) === next && this.reads.delete(source));
    return listeners;
  }

  async status(target: Listener): Promise<"present" | "missing" | "replaced"> {
    const listeners = await this.listeners(target.source);
    const at = listeners.filter((l) => l.address === target.address && l.port === target.port);
    if (at.some((l) => listenerId(l) === listenerId(target))) return "present";
    return at.length ? "replaced" : "missing";
  }

  guard(target: Listener): () => Promise<boolean> {
    let replaced = false;
    return async () => {
      if (replaced) return false;
      const status = await this.status(target).catch(() => "missing" as const);
      if (status === "replaced") replaced = true;
      return status === "present";
    };
  }
}
