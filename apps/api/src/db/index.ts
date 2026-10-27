/**
 * Thin database abstraction over node-postgres (production) and PGlite (embedded
 * Postgres-in-WASM for zero-setup local dev and tests). Both speak the same SQL,
 * so every query and migration runs unchanged on either.
 */
import pg from "pg";

export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  readonly kind: "postgres" | "pglite";
  /** Runs `fn` in a transaction; commits on success, rolls back on any thrown error. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Executes a multi-statement SQL script (migrations). */
  exec(sql: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface Transaction extends Queryable {
  exec(sql: string): Promise<void>;
}

// BIGINT money columns comfortably fit in a JS number (2^53 cents ≈ $90 trillion).
const INT8_OID = 20;
const NUMERIC_OID = 1700;

export async function createDatabase(opts: { url: string; ssl?: boolean; poolMax?: number }): Promise<Database> {
  if (opts.url.startsWith("pglite:")) return createPglite(opts.url);
  return createPostgres(opts);
}

function createPostgres(opts: { url: string; ssl?: boolean; poolMax?: number }): Database {
  pg.types.setTypeParser(INT8_OID, (v) => Number(v));
  pg.types.setTypeParser(NUMERIC_OID, (v) => Number.parseFloat(v));
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.poolMax ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });

  const wrap = (client: pg.PoolClient | pg.Pool): Transaction => ({
    async query<T>(text: string, params?: unknown[]) {
      const res = await client.query(text, params as unknown[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  });
  const root = wrap(pool);

  return {
    kind: "postgres",
    query: root.query,
    exec: root.exec,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPglite(url: string): Promise<Database> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { citext } = await import("@electric-sql/pglite/contrib/citext");
  const location = url.slice("pglite://".length);
  const dataDir = location === "memory" || location === "" ? undefined : location;
  if (dataDir) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });
  }
  const db = await PGlite.create({
    dataDir,
    extensions: { citext },
    parsers: { [INT8_OID]: (v: string) => Number(v), [NUMERIC_OID]: (v: string) => Number.parseFloat(v) },
  });

  const toResult = <T>(res: { rows: unknown[]; affectedRows?: number }): QueryResult<T> => ({
    rows: res.rows as T[],
    rowCount: res.affectedRows ?? res.rows.length,
  });

  return {
    kind: "pglite",
    async query<T>(text: string, params?: unknown[]) {
      return toResult<T>(await db.query(text, params as unknown[]));
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async transaction(fn) {
      return db.transaction(async (tx) =>
        fn({
          async query<T>(text: string, params?: unknown[]) {
            return toResult<T>(await tx.query(text, params as unknown[]));
          },
          async exec(sql: string) {
            await tx.exec(sql);
          },
        }),
      );
    },
    async ping() {
      await db.query("SELECT 1");
    },
    async close() {
      await db.close();
    },
  };
}

/** Postgres error helpers (same SQLSTATE codes on pg and PGlite). */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string } | undefined;
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}
