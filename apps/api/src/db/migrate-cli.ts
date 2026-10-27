import { loadConfig } from "../config";
import { createDatabase } from "./index";
import { runMigrations } from "./migrate";

const config = loadConfig();
const db = await createDatabase(config.database);
try {
  const ran = await runMigrations(db, console.log);
  console.log(ran.length ? `Applied ${ran.length} migration(s).` : "Database is up to date.");
} finally {
  await db.close();
}
