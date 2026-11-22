import type { Column } from "./postgres";

const identifier = (name: string) =>
  /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
const unquote = (name: string) =>
  name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
export function completions(columns: Column[], text: string) {
  const tail = /([\w"]+)\.([\w"]*)$/.exec(text);
  let qualifier = tail ? unquote(tail[1]) : null;
  const prefix = (tail?.[2] ?? /[\w]*$/.exec(text)?.[0] ?? "").toLowerCase().replaceAll('"', "");
  // shortcut: simple FROM/JOIN aliases only; use a SQL parser when completion needs CTE/subquery scopes.
  if (qualifier) {
    const aliases =
      /\b(?:from|join|update|into)\s+((?:"(?:[^"]|"")+"|[\w]+)(?:\.(?:"(?:[^"]|"")+"|[\w]+))?)(?:\s+(?:as\s+)?("(?:[^"]|"")+"|[\w]+))?/gi;
    for (const match of text.matchAll(aliases)) {
      if (match[2] && unquote(match[2]) === qualifier) qualifier = unquote(match[1].split(".").at(-1)!);
    }
  }
  const items: { label: string; insertText: string; detail: string; kind: "Field" | "Class" | "Module" }[] =
    [];
  const seen = new Set<string>();
  const add = (name: string, detail: string, kind: "Field" | "Class" | "Module") => {
    const key = `${kind}:${name}`;
    if (!name.toLowerCase().startsWith(prefix) || seen.has(key)) return;
    seen.add(key);
    items.push({ label: name, insertText: identifier(name), detail, kind });
  };
  for (const column of columns) {
    if (!qualifier) {
      add(column.schema, "Schema", "Module");
      add(column.table, column.schema, "Class");
      add(column.column, `${column.schema}.${column.table} · ${column.type}`, "Field");
    } else if (qualifier === column.schema) add(column.table, column.schema, "Class");
    else if (qualifier === column.table) add(column.column, column.type, "Field");
  }
  return items.slice(0, 300);
}
