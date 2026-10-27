import type { Database } from "./index";
import { migrations } from "./migrations";

/** Advisory-lock key so only one API replica runs migrations at a time. */
const MIGRATION_LOCK_KEY = 7_204_811;

export async function runMigrations(db: Database, log: (msg: string) => void = () => undefined): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  return db.transaction(async (tx) => {
    // Held until commit: concurrent replicas wait here, then see the work as already done.
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.id));
    const ran: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      log(`Applying migration ${migration.id}`);
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
      ran.push(migration.id);
    }
    return ran;
  });
}
