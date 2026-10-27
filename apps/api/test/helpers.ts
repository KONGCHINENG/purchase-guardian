import { MockPayPalGateway, type PayPalGateway } from "@guardian/paypal-client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDatabase, type Database } from "../src/db/index";
import { runMigrations } from "../src/db/migrate";
import { HeuristicAnalyzer } from "../src/modules/ai/heuristic";
import type { AiAnalysis, AnalysisContext, PurchaseAnalyzer } from "../src/modules/ai/index";
import { OfflineShoppingAgent } from "../src/modules/demo-store/agent";
import type { Notifier, PushMessage } from "../src/modules/push/service";

/** Heuristic parse with a controllable confidence, standing in for a confident LLM. */
export class FakeAnalyzer implements PurchaseAnalyzer {
  readonly provider = "anthropic" as const;
  confidence = 0.95;
  fail = false;
  private readonly inner = new HeuristicAnalyzer();

  async analyze(raw: string, ctx: AnalysisContext): Promise<AiAnalysis> {
    if (this.fail) throw new Error("model down");
    const a = await this.inner.analyze(raw, ctx);
    return { ...a, intent: { ...a.intent, confidence: this.confidence }, provider: "anthropic", model: "fake-model" };
  }
}

export type TestApp = { app: FastifyInstance; db: Database; analyzer: FakeAnalyzer; notifier: FakeNotifier; close: () => Promise<void> };

export async function createTestApp(paypal: PayPalGateway = new MockPayPalGateway()): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret-test-secret-test-secret-0123",
    DATABASE_URL: "pglite://memory",
    WEB_URL: "http://localhost:3000",
    PAYPAL_ENV: "mock",
    LOG_LEVEL: "silent",
    RATE_LIMIT_AUTH_PER_MINUTE: "1000",
  });
  const db = await createDatabase(config.database);
  await runMigrations(db);
  const analyzer = new FakeAnalyzer();
  const notifier = new FakeNotifier();
  const app = await buildApp({ config, db, analyzer, paypal, notifier, agentModel: new OfflineShoppingAgent(), logger: false });
  await app.ready();
  return { app, db, analyzer, notifier, close: async () => { await app.close(); await db.close(); } };
}

/** Records push notifications instead of sending them. */
export class FakeNotifier implements Notifier {
  readonly enabled = true;
  readonly publicKey = "test-public-key";
  readonly sent: { userId: string; message: PushMessage }[] = [];
  async notifyUser(userId: string, message: PushMessage) {
    this.sent.push({ userId, message });
  }
}

let counter = 0;
export async function registerUser(app: FastifyInstance, overrides: { email?: string; password?: string } = {}) {
  const email = overrides.email ?? `user${++counter}-${Date.now()}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: overrides.password ?? "correct horse battery", fullName: "Test User" },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { accessToken: string; user: { id: string } };
  const cookie = res.cookies.find((c) => c.name === "guardian_rt")!;
  return { email, token: body.accessToken, userId: body.user.id, refreshCookie: cookie.value, auth: { authorization: `Bearer ${body.accessToken}` } };
}
