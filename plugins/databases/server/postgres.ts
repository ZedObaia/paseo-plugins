import pg from "pg";
import { postgresUrl } from "./discovery";

export const MAX_ROWS = 1000;
export type Column = {
  schema: string;
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  description: string | null;
};
export const SCHEMA_SQL = `
SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
       NOT a.attnotnull AS nullable, pg_catalog.col_description(c.oid, a.attnum) AS description
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  AND has_schema_privilege(n.oid, 'USAGE') AND has_column_privilege(c.oid, a.attnum, 'SELECT')
ORDER BY n.nspname, c.relname, a.attnum`;

export class Postgres {
  private pools = new Map<string, pg.Pool>();
  private schemas = new Map<string, { at: number; columns: Column[] }>();
  private running = new Map<string, number>();
  private clients = new Map<string, Promise<{ client: pg.Client; pid: number }>>();
  private busy = false;
  private currentUrl: string;
  constructor(url: string) {
    this.currentUrl = postgresUrl(url).href;
  }

  async setUrl(url: string) {
    const next = postgresUrl(url).href;
    if (next === this.currentUrl) return;
    await this.close();
    this.currentUrl = next;
  }
  private pool(database?: string): pg.Pool {
    const url = postgresUrl(this.currentUrl);
    if (database) url.pathname = `/${encodeURIComponent(database)}`;
    const key = url.href;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new pg.Pool({
        connectionString: key,
        max: 3,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 15000,
        statement_timeout: 30000,
        application_name: "paseo-databases",
      });
      pool.on("error", () => {
        this.schemas.clear();
      });
      this.pools.set(key, pool);
    }
    return pool;
  }
  async schema(database?: string, refresh = false): Promise<Column[]> {
    const key = database ?? "";
    const cached = this.schemas.get(key);
    if (!refresh && cached && Date.now() - cached.at < 30000) return cached.columns;
    const { rows } = await this.pool(database).query<Column>(SCHEMA_SQL);
    this.schemas.set(key, { at: Date.now(), columns: rows });
    return rows;
  }
  async execute(sql: string, database?: string) {
    if (this.busy) throw new Error("A query is already running. Cancel it or wait for it to finish.");
    this.busy = true;
    const start = Date.now();
    try {
      const key = database ?? "";
      let connected = this.clients.get(key);
      if (!connected) {
        const url = postgresUrl(this.currentUrl);
        if (database) url.pathname = `/${encodeURIComponent(database)}`;
        const client = new pg.Client({
          connectionString: url.href,
          connectionTimeoutMillis: 5000,
          statement_timeout: 30000,
          application_name: "paseo-sql-editor",
        });
        client.on("error", () => {
          this.clients.delete(key);
        });
        connected = client
          .connect()
          .then(async () => {
            const {
              rows: [{ pid }],
            } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            return { client, pid };
          })
          .catch((error) => {
            this.clients.delete(key);
            throw error;
          });
        this.clients.set(key, connected);
      }
      const { client, pid } = await connected;
      this.running.set(database ?? "", pid);
      return await new Promise<{
        columns: string[];
        rows: Record<string, unknown>[];
        rowCount: number;
        duration: number;
        message?: string;
      }>((resolve, reject) => {
        const rows: Record<string, unknown>[] = [];
        let seen = 0;
        // Extended protocol rejects multiple statements before executing any of them.
        const config = { text: sql, queryMode: "extended" };
        const query = client.query(new pg.Query(config));
        query.on("row", (row: Record<string, unknown>) => {
          seen++;
          if (rows.length < MAX_ROWS) rows.push(row);
        });
        query.once("error", reject);
        query.once("end", (result: pg.QueryResult) => {
          this.schemas.clear();
          resolve({
            columns: result.fields.map((f) => f.name),
            rows,
            rowCount: result.rowCount ?? seen,
            duration: Date.now() - start,
            message:
              seen > MAX_ROWS
                ? `Showing the first ${MAX_ROWS} of ${seen} rows. Add LIMIT or a filter to narrow the result.`
                : result.command === "SELECT"
                  ? undefined
                  : `${result.command}: ${result.rowCount ?? 0} rows affected`,
          });
        });
      });
    } finally {
      this.running.delete(database ?? "");
      this.busy = false;
    }
  }
  async cancel() {
    await Promise.all(
      [...this.running].map(([database, pid]) =>
        this.pool(database || undefined).query("SELECT pg_cancel_backend($1)", [pid]),
      ),
    );
  }
  async close() {
    // A disconnected server must not prevent the remaining clients from closing.
    await this.cancel().catch(() => {});
    await Promise.all(
      [...this.clients.values()]
        .map(async (connected) => (await connected).client.end())
        .map((closing) => closing.catch(() => {})),
    );
    this.clients.clear();
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
    this.schemas.clear();
  }
}
