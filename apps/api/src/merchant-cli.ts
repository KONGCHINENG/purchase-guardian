/**
 * Registers (or rotates the key of) a merchant that can send shoppers through Guardian Checkout.
 *   npm run merchant:create -w @guardian/api -- "Acme Store" acme https://shop.acme.com
 * The API key is printed once; only its hash is stored.
 */
import { loadConfig } from "./config";
import { createDatabase } from "./db/index";
import { runMigrations } from "./db/migrate";
import { createMerchant } from "./modules/checkout-sessions/service";

const [name, slug, ...origins] = process.argv.slice(2);
if (!name || !slug || origins.length === 0) {
  console.error('Usage: merchant:create "<name>" <slug> <https://allowed-origin> [...more origins]');
  process.exit(1);
}

const config = loadConfig();
const db = await createDatabase(config.database);
try {
  await runMigrations(db);
  const { merchant, apiKey } = await createMerchant(db, { name, slug, origins });
  console.log(`Merchant "${merchant.name}" (${merchant.slug}) ready.`);
  console.log(`Allowed return origins: ${merchant.allowed_return_origins.join(", ")}`);
  console.log(`API key (store it now, it won't be shown again):\n  ${apiKey}`);
} finally {
  await db.close();
}
