import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** A Linear account you added: one personal API key, for one Linear workspace. */
export interface SavedAccount {
  /** The Linear user's ID: adding the same account again replaces its key. */
  id: string;
  apiKey: string;
  workspace: string;
  /** The workspace's URL key, like `acme` in linear.app/acme. */
  urlKey: string;
  name: string;
  email: string;
}

export const ENVIRONMENT_ID = "environment";

const DIR = () => join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "linear");
// A file only the daemon's user can read: apps never get the keys back, only who they connect as.
const FILE = () => join(DIR(), "accounts.json");
// where the plugin's first version kept its one key
const LEGACY = () => join(DIR(), "api-key");

export async function legacyKey(): Promise<string | null> {
  return (await readFile(LEGACY(), "utf8").catch(() => "")).trim() || null;
}

export const removeLegacyKey = () => rm(LEGACY(), { force: true });

export async function savedAccounts(): Promise<SavedAccount[]> {
  const text = await readFile(FILE(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  return JSON.parse(text) as SavedAccount[];
}

async function write(accounts: SavedAccount[]): Promise<void> {
  const file = FILE();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

// one change at a time: two at once would each write the list they read, dropping the other's
let changing: Promise<unknown> = Promise.resolve();
function change(edit: (accounts: SavedAccount[]) => SavedAccount[] | null): Promise<void> {
  const next = changing.then(async () => {
    const edited = edit(await savedAccounts());
    if (edited) await write(edited);
  });
  changing = next.catch(() => {});
  return next;
}

/** Adds an account, or replaces its key; with `replace: false` an account already saved stays as it is. */
export function saveAccount(account: SavedAccount, { replace = true } = {}): Promise<void> {
  return change((accounts) => {
    if (!replace && accounts.some((saved) => saved.id === account.id)) return null;
    return [...accounts.filter((saved) => saved.id !== account.id), account];
  });
}

export function removeAccount(id: string): Promise<void> {
  return change((accounts) => accounts.filter((saved) => saved.id !== id));
}

/** Every account's key: the saved ones, then LINEAR_API_KEY from the daemon's environment. */
export async function accountKeys(): Promise<{ id: string; apiKey: string; saved: SavedAccount | null }[]> {
  const saved = await savedAccounts();
  const env = process.env.LINEAR_API_KEY?.trim();
  const keys: { id: string; apiKey: string; saved: SavedAccount | null }[] = saved.map((account) => ({
    id: account.id,
    apiKey: account.apiKey,
    saved: account,
  }));
  if (env && !saved.some((account) => account.apiKey === env))
    keys.push({ id: ENVIRONMENT_ID, apiKey: env, saved: null });
  return keys;
}
