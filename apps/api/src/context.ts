import type { PayPalGateway } from "@guardian/paypal-client";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config";
import type { Database } from "./db/index";
import type { PurchaseAnalyzer } from "./modules/ai/index";
import type { ShoppingAgentModel } from "./modules/demo-store/agent";
import type { Notifier } from "./modules/push/service";

/** Everything a service needs, injected once at startup (and swapped for fakes in tests). */
export type AppContext = {
  config: Config;
  db: Database;
  analyzer: PurchaseAnalyzer;
  paypal: PayPalGateway;
  notifier: Notifier;
  agentModel: ShoppingAgentModel;
  log: FastifyBaseLogger;
};
