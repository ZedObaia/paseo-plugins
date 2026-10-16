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

const MANIFEST_ID = "devices";

/** The configured plugin directory whose manifest is this plugin's, whatever ID it was installed under. */
function pluginDir(): string {
  const config = JSON.parse(readFileSync(path.join(HOME, "config.json"), "utf8")) as {
    plugins?: Record<string, { path?: string; enabled?: boolean }>;
  };
  // git installs are recorded with the path of their checkout, like directory installs
  for (const { path: dir, enabled } of Object.values(config.plugins ?? {})) {
    if (!dir || enabled === false) continue;
    try {
      if (
        (JSON.parse(readFileSync(path.join(dir, "paseo-plugin.json"), "utf8")) as { id?: string }).id ===
        MANIFEST_ID
      )
        return dir;
    } catch {
      // not a readable plugin directory
    }
  }
  throw new Error("The devices plugin directory is missing from the daemon config");
}

export const PLUGIN_DIR = pluginDir();

/**
 * The Node that runs agent-device: this process's own binary. In the desktop app that's Paseo's
 * Electron helper, which needs ELECTRON_RUN_AS_NODE=1 (this process already has it; processes
 * started by agents don't, so pass NODE_ENV along).
 */
export const NODE = process.execPath;
export const NODE_ENV: Record<string, string> = process.versions.electron
  ? { ELECTRON_RUN_AS_NODE: "1" }
  : {};

/**
 * The Node that runs serve-sim. Its native module is signed by its author, and the desktop app's
 * hardened Electron helper only loads native code signed by Paseo, so there it runs on the
 * Node.js in PATH instead.
 */
export const ADDON_NODE = process.versions.electron ? "node" : process.execPath;
export const pluginRequire = createRequire(path.join(PLUGIN_DIR, "package.json"));

/** Absolute path of a file inside an installed dependency (some don't export package.json). */
export function dependencyFile(pkg: string, file: string): string {
  const result = path.join(PLUGIN_DIR, "node_modules", pkg, file);
  if (!existsSync(result)) throw new Error(`${pkg} isn't installed in ${PLUGIN_DIR}; run npm ci there`);
  return result;
}
