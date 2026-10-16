function scaled(value: number, base: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let unit = 0;
  while (n >= base && unit < units.length - 1) {
    n /= base;
    unit += 1;
  }
  return `${n >= 100 || unit === 0 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`;
}

/** Disk and Docker sizes, in the decimal units df and Docker use. */
export const bytes = (value: number) => scaled(value, 1000);

/** Memory and swap, in binary units labelled GB, as Activity Monitor and most tools show RAM. */
export const memory = (value: number) => scaled(value, 1024);

export const pct = (value: number) => `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export const ratio = (used: number, total: number) => (total > 0 ? Math.min(1, used / total) : 0);

/** "1 volume", "3 volumes". */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
