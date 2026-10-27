"use client";

import type { AgentRunDto, AgentStep, StoreProduct } from "@guardian/shared";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Spinner, cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api-client";
import { money } from "@/lib/format";

const AGENT_EXAMPLES = ["Restock kitchen basics under $30", "A birthday gift for my mum, around $40", "Noise-cancelling headphones for travel"];

export default function StorePage() {
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [checkingOut, setCheckingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: StoreProduct[] }>("/demo-store/products").then((r) => setProducts(r.items)).catch((e) => setError(errorMessage(e)));
  }, []);

  const lines = useMemo(
    () => Object.entries(cart).flatMap(([sku, quantity]) => {
      const p = products.find((x) => x.sku === sku);
      return p && quantity > 0 ? [{ product: p, quantity }] : [];
    }),
    [cart, products],
  );
  const total = lines.reduce((s, l) => s + l.product.priceCents * l.quantity, 0);
  const add = (sku: string, delta = 1) => setCart((c) => ({ ...c, [sku]: Math.max(0, Math.min(20, (c[sku] ?? 0) + delta)) }));

  const checkout = async () => {
    setCheckingOut(true);
    setError(null);
    try {
      const { checkoutUrl } = await api<{ checkoutUrl: string }>("/demo-store/checkout", {
        method: "POST",
        body: { items: lines.map((l) => ({ sku: l.product.sku, quantity: l.quantity })) },
      });
      window.location.assign(checkoutUrl);
    } catch (e) {
      setError(errorMessage(e));
      setCheckingOut(false);
    }
  };

  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-8">
        <AgentPanel />
        <section>
          <h2 className="mb-3 font-serif text-lg font-semibold">Shop the aisles</h2>
          {products.length === 0 ? (
            <div className="flex justify-center py-12 text-[#8a7a68]">
              <Spinner className="size-5" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {products.map((p) => (
                <div key={p.sku} className="flex flex-col rounded-2xl border border-[#eadfce] bg-white p-4 dark:border-[#3a2f25] dark:bg-[#231c16]">
                  <div className="text-3xl" aria-hidden>
                    {p.emoji}
                  </div>
                  <p className="mt-2 text-sm font-medium leading-snug">{p.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-[#8a7a68]">{p.description}</p>
                  <div className="mt-auto flex items-center justify-between pt-3">
                    <span className="tabular text-sm font-semibold">{money(p.priceCents)}</span>
                    <button
                      onClick={() => add(p.sku)}
                      className="rounded-full bg-[#2b2118] px-3 py-1 text-xs font-medium text-white hover:bg-[#c2541b] dark:bg-[#f3ebe1] dark:text-[#1a1511]"
                    >
                      {cart[p.sku] ? `In cart · ${cart[p.sku]}` : "Add"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-2xl border border-[#eadfce] bg-white p-5 dark:border-[#3a2f25] dark:bg-[#231c16]">
          <h2 className="font-serif text-lg font-semibold">Your cart</h2>
          {lines.length === 0 ? (
            <p className="mt-2 text-sm text-[#8a7a68]">Add something, or let the shopping agent fill it.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {lines.map(({ product, quantity }) => (
                <li key={product.sku} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {product.emoji} {product.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <button aria-label="Remove one" onClick={() => add(product.sku, -1)} className="size-6 rounded-full border border-[#eadfce] dark:border-[#3a2f25]">
                      −
                    </button>
                    <span className="tabular w-4 text-center">{quantity}</span>
                    <button aria-label="Add one" onClick={() => add(product.sku)} className="size-6 rounded-full border border-[#eadfce] dark:border-[#3a2f25]">
                      +
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex items-baseline justify-between border-t border-[#eadfce] pt-3 dark:border-[#3a2f25]">
            <span className="text-sm text-[#8a7a68]">Total</span>
            <span className="tabular text-xl font-semibold">{money(total)}</span>
          </div>
          <button
            disabled={lines.length === 0 || checkingOut}
            onClick={checkout}
            className="mt-4 flex h-11 w-full items-center justify-center gap-1.5 rounded-full bg-[#ffc439] text-sm font-medium text-[#111] hover:bg-[#f2b621] disabled:opacity-50"
          >
            {checkingOut ? <Spinner /> : null}
            Pay with <span className="font-bold italic text-[#003087]">Pay</span>
            <span className="-ml-1.5 font-bold italic text-[#0070e0]">Pal</span>
          </button>
          <p className="mt-2 text-center text-[11px] text-[#8a7a68]">🛡️ Protected by Purchase Guardian</p>
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        </div>
      </aside>
    </main>
  );
}

function AgentPanel() {
  const [goal, setGoal] = useState("");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<AgentRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (goal.trim().length < 3) return;
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const result = await api<AgentRunDto>("/demo-store/agent", { method: "POST", body: { goal } });
      setRun(result);
      if (result.checkout) setTimeout(() => window.location.assign(result.checkout!.checkoutUrl), 2200);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-2xl bg-[#2b2118] p-5 text-[#f3ebe1] dark:bg-[#0f0c09]">
      <p className="text-xs uppercase tracking-wide text-[#e9a77c]">AI shopping agent</p>
      <h1 className="mt-1 font-serif text-2xl font-semibold">Tell the agent what you need.</h1>
      <p className="mt-1 text-sm text-[#cbbba8]">It searches the store, fills a cart and asks to pay. It can't pay on its own: your Guardian decides.</p>
      <form onSubmit={submit} className="mt-4 flex gap-2">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Restock kitchen basics under $30"
          aria-label="Shopping goal"
          className="h-11 min-w-0 flex-1 rounded-full bg-white/10 px-4 text-sm text-white placeholder:text-[#a8988a] focus:bg-white/15 focus:outline-none"
        />
        <button disabled={running || goal.trim().length < 3} className="flex h-11 items-center gap-2 rounded-full bg-[#c2541b] px-5 text-sm font-medium text-white hover:bg-[#d8652a] disabled:opacity-50">
          {running ? <Spinner /> : null}
          {running ? "Shopping" : "Go"}
        </button>
      </form>
      {!run && !running && (
        <div className="mt-3 flex flex-wrap gap-2">
          {AGENT_EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => setGoal(ex)} className="rounded-full border border-white/15 px-3 py-1 text-xs text-[#cbbba8] hover:border-white/40 hover:text-white">
              {ex}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      {run && (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-[#a8988a]">{run.agent}</p>
          <ol className="space-y-1.5">
            {run.steps.map((step, i) => (
              <StepLine key={i} step={step} />
            ))}
          </ol>
          <p className="pt-1 text-sm">{run.message}</p>
          {run.checkout && (
            <p className="flex items-center gap-2 text-sm text-[#e9a77c]">
              <Spinner className="size-3" /> Handing the cart to your Purchase Guardian…
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function StepLine({ step }: { step: AgentStep }) {
  if (step.kind === "thought") return <li className="text-sm italic text-[#cbbba8]">{step.text}</li>;
  const label: Record<string, string> = {
    search_products: "🔎 Searched",
    add_to_cart: "➕ Added to cart",
    remove_from_cart: "➖ Removed",
    view_cart: "🧾 Checked cart",
    request_checkout: "🛡️ Requested checkout via Guardian",
  };
  const input = step.input as Record<string, unknown> | null;
  const detail = step.name === "search_products" ? `“${String(input?.query ?? "")}”` : step.name === "add_to_cart" ? String(input?.sku ?? "") : "";
  return (
    <li className={cx("flex gap-2 rounded-lg bg-white/5 px-3 py-1.5 font-mono text-xs", step.name === "request_checkout" && "text-[#e9a77c]")}>
      <span>{label[step.name] ?? step.name}</span>
      <span className="truncate text-[#a8988a]">{detail}</span>
    </li>
  );
}
