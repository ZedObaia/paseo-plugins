import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const DIR = () => join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "linear");

/** A JSON file in the plugin's data directory, readable only by the daemon's user. */
export function jsonFile<T>(name: string, empty: () => T) {
  const path = () => join(DIR(), name);

  async function read(): Promise<T> {
    const text = await readFile(path(), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return text === null ? empty() : (JSON.parse(text) as T);
  }

  async function write(value: T): Promise<void> {
    const file = path();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await chmod(dirname(file), 0o700);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }

  // one change at a time: two at once would each write what they read, dropping the other's
  let changing: Promise<unknown> = Promise.resolve();
  function change(edit: (value: T) => T): Promise<T> {
    const next = changing.then(async () => {
      const value = edit(await read());
      await write(value);
      return value;
    });
    changing = next.catch(() => {});
    return next;
  }

  return { read, change };
}
