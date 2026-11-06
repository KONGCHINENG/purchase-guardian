import type { StoreProduct } from "@guardian/shared";

/** Northwind Market: the built-in demo merchant. Prices chosen to exercise every policy rule. */
export const CATALOG: StoreProduct[] = [
  { sku: "HH-TOWEL", name: "Paper towels (6 rolls)", description: "Strong, absorbent kitchen rolls.", category: "household", priceCents: 899, emoji: "🧻", tags: ["kitchen", "cleaning", "basics", "restock"] },
  { sku: "HH-SOAP", name: "Dish soap, lemon", description: "Grease-cutting dish liquid, 750 ml.", category: "household", priceCents: 349, emoji: "🧴", tags: ["kitchen", "cleaning", "basics", "restock"] },
  { sku: "HH-TRASH", name: "Trash bags (40 pack)", description: "Drawstring 50 L bags.", category: "household", priceCents: 1199, emoji: "🗑️", tags: ["kitchen", "basics", "restock"] },
  { sku: "HH-DETERG", name: "Laundry detergent", description: "Concentrated, 60 washes.", category: "household", priceCents: 1599, emoji: "🫧", tags: ["laundry", "cleaning", "basics", "restock"] },
  { sku: "GR-COFFEE", name: "Coffee beans, 1 kg", description: "Medium roast, single origin.", category: "groceries", priceCents: 2299, emoji: "☕", tags: ["coffee", "breakfast", "pantry"] },
  { sku: "GR-OATS", name: "Rolled oats, 2 kg", description: "Whole-grain breakfast oats.", category: "groceries", priceCents: 649, emoji: "🥣", tags: ["breakfast", "pantry", "basics"] },
  { sku: "GR-RICE", name: "Jasmine rice, 5 kg", description: "Fragrant long-grain rice.", category: "groceries", priceCents: 1499, emoji: "🍚", tags: ["pantry", "dinner", "basics"] },
  { sku: "GR-TEA", name: "Green tea (100 bags)", description: "Sencha green tea.", category: "groceries", priceCents: 899, emoji: "🍵", tags: ["tea", "pantry"] },
  { sku: "GF-CANDLE", name: "Scented candle gift set", description: "Three soy candles in a gift box.", category: "gifts", priceCents: 3499, emoji: "🕯️", tags: ["gift", "birthday", "present", "home"] },
  { sku: "GF-CHOC", name: "Artisan chocolate box", description: "24 hand-made pralines.", category: "gifts", priceCents: 2799, emoji: "🍫", tags: ["gift", "birthday", "present", "sweet"] },
  { sku: "GF-PLANT", name: "Potted monstera", description: "Easy-care houseplant with ceramic pot.", category: "gifts", priceCents: 6500, emoji: "🪴", tags: ["gift", "birthday", "present", "home", "plant"] },
  { sku: "EL-CABLE", name: "USB-C cable (2 m)", description: "Braided 100 W charging cable.", category: "electronics", priceCents: 1299, emoji: "🔌", tags: ["charger", "phone", "laptop", "cable"] },
  { sku: "EL-EARBUDS", name: "Wireless earbuds", description: "Bluetooth 5.3, 30 h battery.", category: "electronics", priceCents: 7999, emoji: "🎧", tags: ["audio", "music", "headphones"] },
  { sku: "EL-HEADPH", name: "Noise-cancelling headphones", description: "Over-ear, adaptive ANC, 40 h battery.", category: "electronics", priceCents: 32000, emoji: "🎧", tags: ["audio", "music", "headphones", "premium", "travel"] },
  { sku: "AL-WINE", name: "Red wine, Rioja", description: "2019 Reserva, 750 ml.", category: "alcohol", priceCents: 2499, emoji: "🍷", tags: ["wine", "dinner", "gift", "party"] },
  { sku: "EN-GIFTCARD", name: "Northwind gift card", description: "Digital gift card, $50.", category: "gifts", priceCents: 5000, emoji: "🎁", tags: ["gift", "card", "present"] },
];

export const findProduct = (sku: string) => CATALOG.find((p) => p.sku === sku);

/** Words that say how to shop, not what to buy. Matching them caused "one kettle" to find a phone cable. */
const STOP_WORDS = new Set(
  "a an the and or for with without of to in on at by from me my our us i we you some any one two three few buy get want need find order purchase please under below over above less more than max maximum around about total budget cheap new item items thing things something".split(" "),
);

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** "candles" and "candle" should meet; keep it simple and predictable. */
const stem = (w: string) => (w.length > 4 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** The words in a query that can actually identify a product. Empty means "no real search terms". */
export function searchTerms(query: string): string[] {
  return [...new Set(words(query).filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)).map(stem))];
}

/** A term matches a whole word (or the start of one, for terms of 4+ letters, so "choc" finds chocolate). */
const matches = (term: string, productWords: string[]) => productWords.some((w) => w === term || (term.length >= 4 && w.startsWith(term)));

/** Simple relevance search shared by the store UI and the shopping agent's tool. */
export function searchCatalog(query: string, maxPriceCents?: number, limit = 6): StoreProduct[] {
  const terms = searchTerms(query);
  const scored = CATALOG.filter((p) => maxPriceCents === undefined || p.priceCents <= maxPriceCents)
    .map((p) => {
      const tagWords = p.tags.flatMap(words).map(stem);
      const allWords = [...words(`${p.name} ${p.description} ${p.category}`).map(stem), ...tagWords];
      return { p, score: terms.reduce((s, t) => s + (matches(t, tagWords) ? 2 : matches(t, allWords) ? 1 : 0), 0) };
    })
    .filter((x) => terms.length === 0 || x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.priceCents - b.p.priceCents);
  return scored.slice(0, limit).map((x) => x.p);
}

/** Dominant category of a cart (by value): what Guardian's category rules evaluate. */
export function cartCategory(items: { sku: string; quantity: number }[]): StoreProduct["category"] {
  const totals = new Map<StoreProduct["category"], number>();
  for (const item of items) {
    const p = findProduct(item.sku);
    if (p) totals.set(p.category, (totals.get(p.category) ?? 0) + p.priceCents * item.quantity);
  }
  // Restricted categories win regardless of value, so a cart can't hide alcohol behind groceries.
  for (const restricted of ["gambling", "alcohol"] as const) if (totals.has(restricted)) return restricted;
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
}
