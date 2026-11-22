import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { connectionId, databaseType, endpoint, postgresUrl, type Candidate } from "./discovery";

export const stateDir = () =>
  path.join(process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"), "plugin-data", "databases");

export function pluginDirectory(): string {
  const config = JSON.parse(
    readFileSync(path.join(process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"), "config.json"), "utf8"),
  ) as { plugins?: Record<string, { path?: string; enabled?: boolean }> };
  for (const { path: directory, enabled } of Object.values(config.plugins ?? {})) {
    if (!directory || enabled === false) continue;
    try {
      if (JSON.parse(readFileSync(path.join(directory, "paseo-plugin.json"), "utf8")).id === "databases")
        return directory;
    } catch {
      /* Another plugin's checkout may have been removed. */
    }
  }
  throw new Error("The Databases plugin directory is missing from Paseo's configuration");
}

const file = () => path.join(stateDir(), "connections.json");
type Saved = { workspaceId: string; url: string };
async function read(): Promise<Saved[]> {
  try {
    const saved: unknown = JSON.parse(await readFile(file(), "utf8"));
    if (
      !Array.isArray(saved) ||
      !saved.every((s) => typeof s.workspaceId === "string" && typeof s.url === "string")
    )
      throw new Error("Invalid saved database connections");
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function savedConnections(workspaceId: string): Promise<Candidate[]> {
  return (await read())
    .filter((s) => s.workspaceId === workspaceId)
    .map(({ url }) => ({
      id: connectionId(`saved:${url}`),
      url,
      type: databaseType(url),
      name:
        databaseType(url) === "sqlite"
          ? path.basename(endpoint(url))
          : decodeURIComponent(postgresUrl(url).pathname.slice(1)),
      endpoint: endpoint(url),
      source: "saved",
      scope: "workspace",
      detail: "Saved for this workspace",
      needsCredentials: false,
    }));
}
let saving: Promise<void> = Promise.resolve();
export function saveConnection(workspaceId: string, url: string): Promise<void> {
  if (databaseType(url) === "pg") postgresUrl(url);
  saving = saving
    .catch(() => {})
    .then(async () => {
      const all = await read();
      if (all.some((s) => s.workspaceId === workspaceId && s.url === url)) return;
      all.push({ workspaceId, url });
      await mkdir(stateDir(), { recursive: true, mode: 0o700 });
      await writeFile(`${file()}.tmp`, JSON.stringify(all), { mode: 0o600 });
      await rename(`${file()}.tmp`, file());
    });
  return saving;
}
