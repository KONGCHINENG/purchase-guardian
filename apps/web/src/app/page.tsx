import Link from "next/link";
import { ShieldMark } from "@/components/ui";

const STEPS = [
  { title: "AI describes", body: "Claude turns “buy a $65 gift from Amazon” into a structured, validated purchase intent. It can’t approve anything." },
  { title: "Policy decides", body: "A deterministic engine checks your budget, limits, merchants and categories, and explains exactly why." },
  { title: "You stay in control", body: "Risky or large purchases wait for your one-tap approval. Blocked ones never reach checkout." },
  { title: "PayPal executes", body: "Only approved purchases get a PayPal checkout, bound to one request and one idempotency key." },
];

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-5xl px-5 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <div className="flex items-center gap-2 font-semibold text-ink">
          <ShieldMark className="size-6 text-brand" /> Purchase Guardian
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/login" className="rounded-[10px] px-3 py-2 text-ink-soft hover:text-ink">
            Sign in
          </Link>
          <Link href="/register" className="rounded-[10px] bg-brand px-3.5 py-2 font-medium text-white hover:bg-brand-strong dark:text-canvas">
            Get started
          </Link>
        </nav>
      </header>

      <section className="py-16 sm:py-24">
        <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-brand-tint px-3 py-1 text-xs font-medium text-brand-strong">
          PayPal Sandbox · Claude
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-6xl">
          Your AI can shop. Purchase Guardian decides whether it should pay.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-soft">
          Agents need spending boundaries you can enforce, reasoning you can read, and payments only you can authorize. The AI
          proposes, your policy decides, and PayPal executes.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/register" className="rounded-[10px] bg-brand px-5 py-3 font-medium text-white hover:bg-brand-strong dark:text-canvas">
            Create your guardian
          </Link>
          <a href="#how" className="rounded-[10px] border border-line bg-surface px-5 py-3 font-medium text-ink hover:bg-sunken">
            How it works
          </a>
        </div>
      </section>

      <section id="how" className="grid gap-4 pb-20 sm:grid-cols-2">
        {STEPS.map((s, i) => (
          <div key={s.title} className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
            <span className="font-mono text-xs text-ink-faint">0{i + 1}</span>
            <h2 className="mt-2 font-semibold text-ink">{s.title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{s.body}</p>
          </div>
        ))}
      </section>

      <footer className="border-t border-line py-8 text-sm text-ink-faint">Sandbox only. No real money moves.</footer>
    </main>
  );
}
