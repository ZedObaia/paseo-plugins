export function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit += 1;
  }
  return `${n >= 100 || unit === 0 ? Math.round(n) : n.toFixed(1)} ${units[unit]}`;
}

export const pct = (value: number) => `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export const ratio = (used: number, total: number) => (total > 0 ? Math.min(1, used / total) : 0);
