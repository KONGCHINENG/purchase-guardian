import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    /** postgres://… in production; pglite://memory or pglite://./path for zero-setup local dev and tests. */
    DATABASE_URL: z.string().min(1).default("pglite://./.data/pglite"),
    DATABASE_SSL: bool.default(false),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    /** Public origin of the web app; used for PayPal return URLs and CORS. */
    WEB_URL: z.string().url().default("http://localhost:3000"),
    CORS_ORIGINS: z.string().optional(),
    TRUST_PROXY: bool.default(true),

    AI_PROVIDER: z.enum(["anthropic", "heuristic"]).optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    PAYPAL_ENV: z.enum(["sandbox", "live", "mock"]).default("mock"),
    PAYPAL_CLIENT_ID: z.string().optional(),
    PAYPAL_CLIENT_SECRET: z.string().optional(),
    PAYPAL_WEBHOOK_ID: z.string().optional(),

    APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  })
  .superRefine((env, ctx) => {
    if (env.PAYPAL_ENV !== "mock" && (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET)) {
      ctx.addIssue({ code: "custom", path: ["PAYPAL_CLIENT_ID"], message: "PayPal credentials are required unless PAYPAL_ENV=mock" });
    }
    if (env.NODE_ENV === "production" && env.DATABASE_URL.startsWith("pglite:")) {
      ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "Use a real PostgreSQL database in production" });
    }
    if (env.NODE_ENV === "production" && env.PAYPAL_ENV === "mock") {
      ctx.addIssue({ code: "custom", path: ["PAYPAL_ENV"], message: "PAYPAL_ENV=mock is not allowed in production" });
    }
  });

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    database: { url: e.DATABASE_URL, ssl: e.DATABASE_SSL, poolMax: e.DATABASE_POOL_MAX },
    auth: {
      jwtSecret: e.JWT_SECRET,
      accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    },
    webUrl: e.WEB_URL.replace(/\/$/, ""),
    corsOrigins: (e.CORS_ORIGINS ?? e.WEB_URL).split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean),
    trustProxy: e.TRUST_PROXY,
    ai: {
      provider: e.AI_PROVIDER ?? (e.ANTHROPIC_API_KEY ? "anthropic" : "heuristic"),
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.ANTHROPIC_MODEL,
      timeoutMs: e.AI_TIMEOUT_MS,
    },
    paypal: {
      environment: e.PAYPAL_ENV,
      clientId: e.PAYPAL_CLIENT_ID,
      clientSecret: e.PAYPAL_CLIENT_SECRET,
      webhookId: e.PAYPAL_WEBHOOK_ID,
    },
    approvalTtlMinutes: e.APPROVAL_TTL_MINUTES,
    rateLimits: { authPerMinute: e.RATE_LIMIT_AUTH_PER_MINUTE },
  } as const;
}
