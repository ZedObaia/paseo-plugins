import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const directory = path.dirname(require.resolve("db-studio/package.json"));
// Paseo serves its own patched frontend; discard the unused upstream bundle and its older dependencies.
await rm(path.join(directory, "dist/web-dist"), { recursive: true, force: true });
