import { CreatePurchaseRequestInputSchema, ListQuerySchema } from "@guardian/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context";
import { parseWith } from "../../lib/errors";
import { metaOf, requireAuth, userIdOf } from "../../plugins/auth";
import * as purchaseRequests from "./service";

const IdParams = z.object({ id: z.string().uuid("Invalid purchase request id") });
// LLM calls are the expensive path: rate-limit them per user, separately from reads.
const aiRateLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

export async function purchaseRequestRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", requireAuth(ctx));

  app.post("/purchase-requests", aiRateLimit, async (req, reply) => {
    const { rawInput } = parseWith(CreatePurchaseRequestInputSchema, req.body);
    const result = await purchaseRequests.createPurchaseRequest(ctx, userIdOf(req), rawInput, metaOf(req));
    return reply.status(201).send(result);
  });

  app.get("/purchase-requests", async (req) => {
    const query = parseWith(ListQuerySchema, req.query);
    return purchaseRequests.listPurchaseRequests(ctx, userIdOf(req), query);
  });

  app.get("/purchase-requests/:id", async (req) => {
    const { id } = parseWith(IdParams, req.params);
    return purchaseRequests.getPurchaseRequest(ctx, userIdOf(req), id);
  });

  app.post("/purchase-requests/:id/retry-analysis", aiRateLimit, async (req) => {
    const { id } = parseWith(IdParams, req.params);
    return purchaseRequests.retryAnalysis(ctx, userIdOf(req), id, metaOf(req));
  });
}
