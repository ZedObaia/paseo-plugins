import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * Paseo bundles server code and resolves leftover require() calls from its own install, not
 * from this plugin. Native and CLI dependencies (sharp, serve-sim, agent-device) are loaded
 * from the plugin's directory instead, which the daemon records in its config.
 */
const HOME = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");

function pluginDir(): string {
  const config = JSON.parse(readFileSync(path.join(HOME, "config.json"), "utf8")) as {
    plugins?: Record<string, { path?: string }>;
  };
  const dir = config.plugins?.devices?.path;
  if (!dir) throw new Error("The devices plugin directory is missing from the daemon config");
  return dir;
}

export const PLUGIN_DIR = pluginDir();
export const pluginRequire = createRequire(path.join(PLUGIN_DIR, "package.json"));

/** Absolute path of a file inside an installed dependency (some don't export package.json). */
export function dependencyFile(pkg: string, file: string): string {
  const result = path.join(PLUGIN_DIR, "node_modules", pkg, file);
  if (!existsSync(result)) throw new Error(`${pkg} isn't installed in ${PLUGIN_DIR}; run npm ci there`);
  return result;
}
