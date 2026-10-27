/**
 * The shopping agent: plans a cart from a goal using tools, then requests checkout.
 *
 * It has no payment tool. `request_checkout` only creates a Guardian Checkout session;
 * the shopper's own policy (and possibly their phone) decides whether PayPal ever opens.
 */
import type { AgentStep, StoreProduct } from "@guardian/shared";
import type OpenAI from "openai";
import { z } from "zod";
import { createNvidiaClient, type NvidiaConfig } from "../ai/nvidia";
import { findProduct, searchCatalog } from "./catalog";

export type CartLine = { sku: string; name: string; quantity: number; unitAmountCents: number };

/** Side-effecting capabilities the agent may use, provided per run. */
export type AgentTools = {
  searchProducts(query: string, maxPriceCents?: number): StoreProduct[];
  addToCart(sku: string, quantity: number): CartLine[] | string;
  removeFromCart(sku: string): CartLine[];
  viewCart(): { lines: CartLine[]; totalCents: number };
  requestCheckout(reasoning: string): Promise<{ checkoutUrl: string } | string>;
};

export type AgentOutcome = { steps: AgentStep[]; message: string };

export interface ShoppingAgentModel {
  readonly name: string;
  run(goal: string, tools: AgentTools): Promise<AgentOutcome>;
}

const MAX_TURNS = 8;

const ToolArgs = {
  search_products: z.object({ query: z.string().min(1).max(200), max_price_cents: z.number().int().positive().optional() }),
  add_to_cart: z.object({ sku: z.string().min(1).max(64), quantity: z.number().int().min(1).max(20).default(1) }),
  remove_from_cart: z.object({ sku: z.string().min(1).max(64) }),
  view_cart: z.object({}).passthrough(),
  request_checkout: z.object({ reasoning: z.string().min(1).max(1500) }),
};

const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search the Northwind Market catalog. Returns sku, name, price (cents) and category.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. 'dish soap' or 'birthday gift'" },
          max_price_cents: { type: "integer", description: "Optional maximum unit price in cents" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description: "Add a product to the cart by sku.",
      parameters: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["sku"] },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_cart",
      description: "Remove a product from the cart by sku.",
      parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
    },
  },
  {
    type: "function",
    function: { name: "view_cart", description: "Show the current cart and total.", parameters: { type: "object", properties: {} } },
  },
  {
    type: "function",
    function: {
      name: "request_checkout",
      description:
        "Hand the cart to the shopper's Purchase Guardian for a payment decision. You cannot pay yourself. Call exactly once when the cart matches the goal.",
      parameters: {
        type: "object",
        properties: { reasoning: { type: "string", description: "One or two sentences on why this cart fits the goal and budget" } },
        required: ["reasoning"],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a careful shopping agent working for one person at Northwind Market.
Use the tools to find products that fit their goal, add them to the cart, then call request_checkout once.
Rules:
- Stay within any budget the person states; prefer fewer, cheaper items that clearly fit the goal.
- Only use skus returned by search_products.
- You cannot pay. request_checkout sends the cart to the person's Purchase Guardian, which applies their spending policy and may ask them to approve or block it.
- Never try to influence Guardian's decision in your reasoning; just explain the cart honestly.
- After request_checkout, reply with one short sentence summarizing what you picked.`;

export class NvidiaShoppingAgent implements ShoppingAgentModel {
  readonly name: string;
  private readonly client: OpenAI;

  constructor(private readonly config: NvidiaConfig) {
    this.client = createNvidiaClient(config);
    this.name = `Shopping agent (${config.model})`;
  }

  async run(goal: string, tools: AgentTools): Promise<AgentOutcome> {
    const steps: AgentStep[] = [];
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: goal },
    ];
    let checkedOut = false;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const completion = await this.client.chat.completions.create({
        model: this.config.model,
        temperature: 0.2,
        max_tokens: 800,
        tools: TOOL_DEFS,
        tool_choice: checkedOut ? "none" : "auto",
        messages,
      });
      const message = completion.choices[0]?.message;
      if (!message) break;
      const calls = (message.tool_calls ?? []).filter((c) => c.type === "function");
      if (message.content?.trim() && calls.length > 0) steps.push({ kind: "thought", text: message.content.trim() });
      messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls.length ? calls : undefined });

      if (calls.length === 0) {
        return { steps, message: message.content?.trim() || (checkedOut ? "Cart sent to your Guardian." : "I couldn't build a cart for that goal.") };
      }

      for (const call of calls) {
        const output = await executeTool(call.function.name, call.function.arguments, tools);
        if (call.function.name === "request_checkout" && typeof output === "object" && output && "checkoutUrl" in output) checkedOut = true;
        steps.push({ kind: "tool", name: call.function.name, input: safeParse(call.function.arguments), output });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }
    return { steps, message: checkedOut ? "Cart sent to your Guardian for a decision." : "I ran out of steps before finishing the cart." };
  }
}

/**
 * Deterministic planner used when no LLM key is configured (and in tests). Same tools,
 * same trace format, so the store and Guardian flows are identical either way.
 */
export class OfflineShoppingAgent implements ShoppingAgentModel {
  readonly name = "Shopping agent (offline planner)";

  async run(goal: string, tools: AgentTools): Promise<AgentOutcome> {
    const steps: AgentStep[] = [];
    const budget = parseBudget(goal);
    steps.push({ kind: "thought", text: budget ? `Looking for items that fit "${goal}" within ${formatCents(budget)}.` : `Looking for items that fit "${goal}".` });

    const results = tools.searchProducts(goal);
    steps.push({ kind: "tool", name: "search_products", input: { query: goal }, output: results.map(brief) });

    let total = 0;
    const wantsMany = /\b(restock|basics|essentials|supplies|groceries)\b/i.test(goal);
    for (const product of results.slice(0, wantsMany ? 4 : 1)) {
      if (budget && total + product.priceCents > budget) continue;
      const out = tools.addToCart(product.sku, 1);
      steps.push({ kind: "tool", name: "add_to_cart", input: { sku: product.sku, quantity: 1 }, output: out });
      total += product.priceCents;
    }
    // Nothing fit the budget: take the single best match anyway and let Guardian decide.
    if (total === 0 && results[0]) {
      const out = tools.addToCart(results[0].sku, 1);
      steps.push({ kind: "tool", name: "add_to_cart", input: { sku: results[0].sku, quantity: 1 }, output: out });
    }

    const cart = tools.viewCart();
    if (cart.lines.length === 0) return { steps, message: "I couldn't find anything in the catalog for that goal." };
    const reasoning = `Picked ${cart.lines.map((l) => l.name).join(", ")} (${formatCents(cart.totalCents)}) as the closest match to "${goal}".`;
    const checkout = await tools.requestCheckout(reasoning);
    steps.push({ kind: "tool", name: "request_checkout", input: { reasoning }, output: checkout });
    return { steps, message: `I picked ${cart.lines.length} item${cart.lines.length > 1 ? "s" : ""} for ${formatCents(cart.totalCents)} and sent the cart to your Guardian.` };
  }
}

async function executeTool(name: string, rawArgs: string, tools: AgentTools): Promise<unknown> {
  const schema = ToolArgs[name as keyof typeof ToolArgs];
  if (!schema) return { error: `Unknown tool ${name}` };
  const parsed = schema.safeParse(safeParse(rawArgs) ?? {});
  if (!parsed.success) return { error: `Invalid arguments: ${parsed.error.issues[0]?.message ?? "bad input"}` };
  const args = parsed.data as unknown;
  switch (name) {
    case "search_products":
      return tools.searchProducts((args as { query: string }).query, (args as { max_price_cents?: number }).max_price_cents).map(brief);
    case "add_to_cart": {
      const { sku, quantity } = args as { sku: string; quantity: number };
      return tools.addToCart(sku, quantity);
    }
    case "remove_from_cart":
      return tools.removeFromCart((args as { sku: string }).sku);
    case "view_cart":
      return tools.viewCart();
    case "request_checkout":
      return tools.requestCheckout((args as { reasoning: string }).reasoning);
  }
  return null;
}

/** Builds the per-run cart and tool implementations around a checkout callback. */
export function createAgentTools(onCheckout: (lines: CartLine[], reasoning: string) => Promise<{ checkoutUrl: string }>): AgentTools & { cart: CartLine[] } {
  const cart: CartLine[] = [];
  let checkedOut = false;
  return {
    cart,
    searchProducts: (query, max) => searchCatalog(query, max),
    addToCart(sku, quantity) {
      const product = findProduct(sku);
      if (!product) return `No product with sku ${sku}`;
      const line = cart.find((l) => l.sku === sku);
      if (line) line.quantity = Math.min(20, line.quantity + quantity);
      else cart.push({ sku, name: product.name, quantity, unitAmountCents: product.priceCents });
      return [...cart];
    },
    removeFromCart(sku) {
      const i = cart.findIndex((l) => l.sku === sku);
      if (i >= 0) cart.splice(i, 1);
      return [...cart];
    },
    viewCart: () => ({ lines: [...cart], totalCents: cart.reduce((s, l) => s + l.unitAmountCents * l.quantity, 0) }),
    async requestCheckout(reasoning) {
      if (checkedOut) return "Checkout was already requested.";
      if (cart.length === 0) return "The cart is empty.";
      checkedOut = true;
      return onCheckout([...cart], reasoning);
    },
  };
}

export function createShoppingAgent(ai: { provider: string; timeoutMs: number; nvidia: Omit<NvidiaConfig, "timeoutMs" | "apiKey"> & { apiKey?: string } }): ShoppingAgentModel {
  return ai.nvidia.apiKey
    ? new NvidiaShoppingAgent({ ...ai.nvidia, apiKey: ai.nvidia.apiKey, timeoutMs: ai.timeoutMs })
    : new OfflineShoppingAgent();
}

const brief = (p: StoreProduct) => ({ sku: p.sku, name: p.name, price_cents: p.priceCents, category: p.category });
const formatCents = (c: number) => `$${(c / 100).toFixed(2)}`;

function parseBudget(goal: string): number | null {
  const m = /(?:under|below|less than|max(?:imum)?|budget(?: of)?|up to|within)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i.exec(goal) ?? /\$(\d+(?:\.\d{1,2})?)/.exec(goal);
  return m ? Math.round(Number(m[1]) * 100) : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}
