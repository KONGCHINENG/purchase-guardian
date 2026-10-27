import { CreateOrderInputSchema } from "@guardian/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context";
import { parseWith, unauthorized } from "../../lib/errors";
import { metaOf, requireAuth, userIdOf } from "../../plugins/auth";
import * as payments from "./service";

const IdParams = z.object({ id: z.string().uuid("Invalid order id") });
const paymentRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

const WebhookEventSchema = z
  .object({
    id: z.string().min(1).max(200),
    event_type: z.string().min(1).max(200),
    resource: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export async function paymentRoutes(app: FastifyInstance, ctx: AppContext) {
  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth(ctx));

    authed.post("/payments/paypal/orders", paymentRateLimit, async (req, reply) => {
      const { purchaseRequestId } = parseWith(CreateOrderInputSchema, req.body);
      const order = await payments.createOrder(ctx, userIdOf(req), purchaseRequestId, metaOf(req));
      return reply.status(201).send(order);
    });

    authed.get("/payments/paypal/orders", async (req) => ({ items: await payments.listOrders(ctx, userIdOf(req)) }));

    authed.get("/payments/paypal/orders/:id", async (req) => {
      const { id } = parseWith(IdParams, req.params);
      return payments.getOrder(ctx, userIdOf(req), id);
    });

    authed.post("/payments/paypal/orders/:id/capture", paymentRateLimit, async (req) => {
      const { id } = parseWith(IdParams, req.params);
      return payments.captureOrder(ctx, userIdOf(req), id, metaOf(req));
    });
  });

  // Public, but every event must carry a valid PayPal signature.
  app.post("/webhooks/paypal", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    const event = parseWith(WebhookEventSchema, req.body);
    const verified = await ctx.paypal.verifyWebhookSignature(req.headers, req.body).catch((err: unknown) => {
      req.log.warn({ err }, "Webhook signature verification errored");
      return false;
    });
    if (!verified) {
      req.log.warn({ eventId: event.id, type: event.event_type }, "Rejected unverified PayPal webhook");
      throw unauthorized("Invalid webhook signature");
    }
    const result = await payments.handlePayPalWebhook(ctx, event as Parameters<typeof payments.handlePayPalWebhook>[1]);
    return reply.status(200).send({ received: true, result });
  });
}
