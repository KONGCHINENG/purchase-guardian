import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppContext } from "./context";
import { AppError } from "./lib/errors";
import { verifyAccessToken } from "./lib/security";
import { approvalRoutes } from "./modules/approvals/routes";
import { authRoutes } from "./modules/auth/routes";
import { paymentRoutes } from "./modules/payments/routes";
import { policyRoutes } from "./modules/policies/routes";
import { purchaseRequestRoutes } from "./modules/purchase-requests/routes";

export type BuildAppOptions = Omit<AppContext, "log"> & { logger?: boolean | object };

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger:
      opts.logger ??
      {
        level: config.logLevel,
        redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        ...(config.isProduction ? {} : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }),
      },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined)?.slice(0, 64) || randomUUID(),
  });

  const ctx: AppContext = { ...opts, log: app.log };

  await app.register(helmet, { contentSecurityPolicy: false }); // JSON API: no HTML to protect
  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // Per user when authenticated (stateless JWT check, no DB hit), else per IP.
    keyGenerator: async (req) => {
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        try {
          return `user:${(await verifyAccessToken(header.slice(7), config.auth.jwtSecret)).userId}`;
        } catch {
          /* fall through to IP */
        }
      }
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: { code: "RATE_LIMITED", message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)}s.` },
    }),
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((error: FastifyError | AppError, req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if ((error as FastifyError).statusCode === 429) {
      // @fastify/rate-limit throws the object built by errorResponseBuilder above.
      const built = (error as unknown as { error?: { code: string; message: string } }).error;
      return reply.status(429).send({ error: built ?? { code: "RATE_LIMITED", message: error.message } });
    }
    if ((error as FastifyError).validation || (error as FastifyError).code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || (error as FastifyError).statusCode === 400) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: error.message } });
    }
    if ((error as FastifyError).statusCode === 413) {
      return reply.status(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" } });
    }
    req.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` } }),
  );

  // Liveness: process is up. Readiness: dependencies reachable (used by the load balancer).
  app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await ctx.db.ping();
      return { status: "ready", ai: config.ai.provider, paypal: ctx.paypal.environment };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  await app.register(
    async (v1) => {
      await authRoutes(v1, ctx);
      await v1.register(async (scope) => policyRoutes(scope, ctx));
      await v1.register(async (scope) => purchaseRequestRoutes(scope, ctx));
      await v1.register(async (scope) => approvalRoutes(scope, ctx));
      await v1.register(async (scope) => paymentRoutes(scope, ctx));
    },
    { prefix: "/api/v1" },
  );

  return app;
}
