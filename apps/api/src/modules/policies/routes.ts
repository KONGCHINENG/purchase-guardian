import { UpdatePolicyInputSchema } from "@guardian/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context";
import { parseWith } from "../../lib/errors";
import { metaOf, requireAuth, userIdOf } from "../../plugins/auth";
import * as policies from "./service";

export async function policyRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", requireAuth(ctx));

  app.get("/policies/me", async (req) => policies.getPolicy(ctx, userIdOf(req)));

  app.put("/policies/me", async (req) =>
    policies.updatePolicy(ctx, userIdOf(req), parseWith(UpdatePolicyInputSchema, req.body), metaOf(req)),
  );

  app.get("/policies/me/usage", async (req) => policies.getUsage(ctx, userIdOf(req)));
}
