/**
 * Northwind Market: a demo merchant that lives in this deployment for convenience but
 * talks to Guardian exactly like an external store would, through the checkout-session
 * service with its own merchant identity and allowlisted return URLs.
 */
import { AgentRunInputSchema, StoreCheckoutInputSchema, type AgentRunDto, type CheckoutItem } from "@guardian/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context";
import { badRequest, parseWith } from "../../lib/errors";
import { createSession, ensureDemoMerchant, getSessionForMerchant, type MerchantRow } from "../checkout-sessions/service";
import { createAgentTools, type CartLine } from "./agent";
import { CATALOG, cartCategory, findProduct } from "./catalog";

export async function demoStoreRoutes(app: FastifyInstance, ctx: AppContext) {
  let merchant: MerchantRow | null = null;
  const demoMerchant = async () => (merchant ??= await ensureDemoMerchant(ctx));
  const storeUrl = (path: string) => `${ctx.config.webUrl}/store${path}`;

  const openSession = async (lines: CartLine[], agent?: { name: string; goal: string; reasoning: string }) => {
    const items: CheckoutItem[] = lines.map((l) => ({ name: l.name, sku: l.sku, quantity: l.quantity, unitAmountCents: l.unitAmountCents }));
    const session = await createSession(ctx, await demoMerchant(), {
      items,
      currency: "USD",
      category: cartCategory(lines),
      merchantReference: `NW-${Date.now().toString(36).toUpperCase()}`,
      returnUrl: storeUrl("/complete"),
      cancelUrl: storeUrl("/complete"),
      agentContext: agent ? { agentName: agent.name, goal: agent.goal, reasoning: agent.reasoning } : undefined,
    });
    return { sessionId: session.id, checkoutUrl: session.checkoutUrl };
  };

  app.get("/demo-store/products", async () => ({ items: CATALOG }));

  app.post("/demo-store/checkout", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { items } = parseWith(StoreCheckoutInputSchema, req.body);
    const lines = items.map(({ sku, quantity }) => {
      const p = findProduct(sku);
      if (!p) throw badRequest(`Unknown product ${sku}`);
      return { sku, name: p.name, quantity, unitAmountCents: p.priceCents };
    });
    return reply.status(201).send(await openSession(lines));
  });

  // The agent spends LLM credit: keep it on a tight per-IP budget.
  app.post("/demo-store/agent", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req): Promise<AgentRunDto> => {
    const { goal } = parseWith(AgentRunInputSchema, req.body);
    let checkout: AgentRunDto["checkout"] = null;
    const tools = createAgentTools(async (lines, reasoning) => {
      checkout = await openSession(lines, { name: ctx.agentModel.name, goal, reasoning });
      return { checkoutUrl: checkout.checkoutUrl };
    });
    try {
      const outcome = await ctx.agentModel.run(goal, tools);
      return { agent: ctx.agentModel.name, steps: outcome.steps, message: outcome.message, cart: tools.cart, checkout };
    } catch (error) {
      req.log.warn({ err: error }, "Shopping agent failed");
      return { agent: ctx.agentModel.name, steps: [], message: "The shopping agent is unavailable right now. Try again, or shop manually.", cart: tools.cart, checkout };
    }
  });

  // What the store's "order complete" page reads: merchant-level status only.
  app.get("/demo-store/sessions/:id", async (req) => {
    const { id } = parseWith(z.object({ id: z.string().uuid() }), req.params);
    return getSessionForMerchant(ctx, await demoMerchant(), id);
  });
}
