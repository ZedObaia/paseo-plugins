import { jsonFile } from "./files";

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

// apps never get the keys back, only who they connect as
const file = jsonFile<SavedAccount[]>("accounts.json", () => []);

export const savedAccounts = file.read;

/** Adds an account, or replaces its key. */
export async function saveAccount(account: SavedAccount): Promise<void> {
  await file.change((accounts) => [...accounts.filter((saved) => saved.id !== account.id), account]);
}

export async function removeAccount(id: string): Promise<void> {
  await file.change((accounts) => accounts.filter((saved) => saved.id !== id));
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
