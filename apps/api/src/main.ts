import { createPayPalGateway } from "@guardian/paypal-client";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDatabase } from "./db/index";
import { runMigrations } from "./db/migrate";
import { createAnalyzer } from "./modules/ai/index";

const config = loadConfig();
const db = await createDatabase(config.database);
await runMigrations(db, (msg) => console.log(msg));

const app = await buildApp({
  config,
  db,
  analyzer: createAnalyzer(config.ai),
  paypal: createPayPalGateway(config.paypal),
});

app.log.info(
  { ai: config.ai.provider, model: config.ai.provider === "anthropic" ? config.ai.model : undefined, paypal: config.paypal.environment, db: db.kind },
  "Purchase Guardian API starting",
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");
  // Stop accepting connections, let in-flight requests finish, then release the pool.
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
