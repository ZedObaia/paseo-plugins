import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { servesOnly, type ServedPort } from "./tailscale";

/**
 * Something the plugin set up outside itself. Tailscale's serve settings belong to the whole
 * machine and outlive the plugin and the daemon, and a tunnel process can outlive a plugin that
 * was killed, so each one is written down before it's made and crossed off once it's gone.
 */
export type ShareRecord =
  | { kind: "serve" | "funnel"; httpsPort: number; target: string }
  | { kind: "cloudflared"; pid: number; target: string };

const same = (a: ShareRecord, b: ShareRecord) => JSON.stringify(a) === JSON.stringify(b);

export const recordsPath = () =>
  join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "ports", "shares.json");

export class Records {
  private records: ShareRecord[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path = recordsPath()) {}

  async load(): Promise<ShareRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { records?: ShareRecord[] };
      this.records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch {
      this.records = [];
    }
    return [...this.records];
  }

  add(record: ShareRecord): Promise<void> {
    this.records.push(record);
    return this.save();
  }

  remove(record: ShareRecord): Promise<void> {
    this.records = this.records.filter((r) => !same(r, record));
    return this.save();
  }

  clear(): Promise<void> {
    this.records = [];
    return this.save();
  }

  // one write at a time, each replacing the file whole
  private save(): Promise<void> {
    const text = `${JSON.stringify({ version: 1, records: this.records }, null, 2)}\n`;
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await mkdir(join(this.path, ".."), { recursive: true });
        await writeFile(`${this.path}.tmp`, text);
        await rename(`${this.path}.tmp`, this.path);
      });
    return this.writing;
  }
}

export interface LeftoverPlan {
  /** Serve and Funnel ports still set up exactly as the plugin left them. */
  unserve: { kind: "serve" | "funnel"; httpsPort: number }[];
  /** Tunnel processes still running with the command the plugin started them with. */
  kill: number[];
  /** Records of ports someone has changed since: those are left alone. */
  changed: ShareRecord[];
}

/**
 * What to undo when the plugin starts. A port is only turned off if it still serves exactly what
 * the plugin set up; one that's gone needs nothing, and one that serves something else now is
 * someone else's. A process is only killed if it's still the cloudflared the plugin started.
 */
export function leftoverPlan(
  records: readonly ShareRecord[],
  config: Map<number, ServedPort> | null,
  commandOf: (pid: number) => string | null,
): LeftoverPlan {
  const plan: LeftoverPlan = { unserve: [], kill: [], changed: [] };
  for (const record of records) {
    if (record.kind === "cloudflared") {
      const command = commandOf(record.pid);
      if (command && /cloudflared/.test(command) && command.includes(record.target))
        plan.kill.push(record.pid);
      continue;
    }
    if (!config?.has(record.httpsPort)) continue;
    if (servesOnly(config, record.httpsPort, record.target))
      plan.unserve.push({ kind: record.kind, httpsPort: record.httpsPort });
    else plan.changed.push(record);
  }
  return plan;
}
