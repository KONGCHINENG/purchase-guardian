import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context";
import { parseWith } from "../../lib/errors";
import { requireAuth, userIdOf } from "../../plugins/auth";
import { deleteSubscription, saveSubscription, SubscriptionSchema } from "./service";

export async function pushRoutes(app: FastifyInstance, ctx: AppContext) {
  // Public: the browser needs the VAPID key before it can subscribe.
  app.get("/push/config", async () => ({ enabled: ctx.notifier.enabled, publicKey: ctx.notifier.publicKey }));

  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth(ctx));

    authed.post("/push/subscriptions", async (req, reply) => {
      await saveSubscription(ctx, userIdOf(req), parseWith(SubscriptionSchema, req.body), req.headers["user-agent"] ?? null);
      return reply.status(204).send();
    });

    authed.delete("/push/subscriptions", async (req, reply) => {
      const { endpoint } = parseWith(z.object({ endpoint: z.string().url() }), req.body);
      await deleteSubscription(ctx, userIdOf(req), endpoint);
      return reply.status(204).send();
    });

    authed.post("/push/test", async (req, reply) => {
      await ctx.notifier.notifyUser(userIdOf(req), { title: "Purchase Guardian", body: "Notifications are on. We'll ask here before anything risky is paid.", url: "/dashboard" });
      return reply.status(204).send();
    });
  });
}
