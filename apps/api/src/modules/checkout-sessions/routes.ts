import { CreateCheckoutSessionInputSchema } from "@guardian/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context";
import { AppError, parseWith } from "../../lib/errors";
import { metaOf, requireAuth, userIdOf } from "../../plugins/auth";
import * as checkout from "./service";

const IdParams = z.object({ id: z.string().uuid("Invalid checkout session id") });

declare module "fastify" {
  interface FastifyRequest {
    merchant?: checkout.MerchantRow;
  }
}

/** Server-to-server merchant auth: `Authorization: Bearer pgm_…`. */
function requireMerchant(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const merchant = header?.startsWith("Bearer pgm_") ? await checkout.findMerchantByKey(ctx.db, header.slice(7)) : null;
    if (!merchant) throw new AppError(401, "INVALID_MERCHANT_KEY", "A valid merchant API key is required");
    req.merchant = merchant;
  };
}

export async function checkoutSessionRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- Merchant (server-to-server) -------------------------------------------
  app.register(async (merchantScope) => {
    merchantScope.addHook("preHandler", requireMerchant(ctx));

    merchantScope.post("/checkout-sessions", async (req, reply) => {
      const input = parseWith(CreateCheckoutSessionInputSchema, req.body);
      return reply.status(201).send(await checkout.createSession(ctx, req.merchant!, input));
    });

    merchantScope.get("/checkout-sessions/:id", async (req) => {
      const { id } = parseWith(IdParams, req.params);
      return checkout.getSessionForMerchant(ctx, req.merchant!, id);
    });
  });

  // ---- Shopper (browser) -----------------------------------------------------
  app.register(async (shopper) => {
    shopper.addHook("preHandler", requireAuth(ctx));

    shopper.get("/checkout-sessions/:id/view", async (req) => {
      const { id } = parseWith(IdParams, req.params);
      return checkout.viewSession(ctx, userIdOf(req), id);
    });

    shopper.post("/checkout-sessions/:id/claim", async (req) => {
      const { id } = parseWith(IdParams, req.params);
      return checkout.claimSession(ctx, userIdOf(req), id, metaOf(req));
    });

    shopper.post("/checkout-sessions/:id/pay", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
      const { id } = parseWith(IdParams, req.params);
      return checkout.startPayment(ctx, userIdOf(req), id, metaOf(req));
    });

    shopper.post("/checkout-sessions/:id/complete", async (req) => {
      const { id } = parseWith(IdParams, req.params);
      return checkout.completePayment(ctx, userIdOf(req), id, metaOf(req));
    });

    shopper.post("/checkout-sessions/:id/cancel", async (req) => {
      const { id } = parseWith(IdParams, req.params);
      return checkout.cancelSession(ctx, userIdOf(req), id, metaOf(req));
    });
  });
}
