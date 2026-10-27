import { APPROVAL_STATUSES } from "@guardian/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context";
import { parseWith } from "../../lib/errors";
import { metaOf, requireAuth, userIdOf } from "../../plugins/auth";
import * as approvals from "./service";

const IdParams = z.object({ id: z.string().uuid("Invalid approval id") });
const ListQuery = z.object({ status: z.enum(APPROVAL_STATUSES).optional() });

export async function approvalRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", requireAuth(ctx));

  app.get("/approvals", async (req) => {
    const { status } = parseWith(ListQuery, req.query);
    return { items: await approvals.listApprovals(ctx, userIdOf(req), status) };
  });

  app.post("/approvals/:id/approve", async (req) => {
    const { id } = parseWith(IdParams, req.params);
    return approvals.decideApproval(ctx, userIdOf(req), id, "approved", metaOf(req));
  });

  app.post("/approvals/:id/reject", async (req) => {
    const { id } = parseWith(IdParams, req.params);
    return approvals.decideApproval(ctx, userIdOf(req), id, "rejected", metaOf(req));
  });
}
