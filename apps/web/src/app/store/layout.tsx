import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Northwind Market (demo store)" };

/** A deliberately different brand: this is "someone else's shop" that uses Guardian Checkout. */
export default function StoreLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[#fbf7f1] text-[#2b2118] dark:bg-[#1a1511] dark:text-[#f3ebe1]">
      <header className="border-b border-[#eadfce] bg-[#fbf7f1]/90 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-[#3a2f25] dark:bg-[#1a1511]/90">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-8">
          <Link href="/store" className="font-serif text-xl font-semibold tracking-tight">
            Northwind <span className="text-[#c2541b]">Market</span>
          </Link>
          <span className="rounded-full border border-[#eadfce] px-2.5 py-1 text-[11px] uppercase tracking-wide text-[#8a7a68] dark:border-[#3a2f25]">
            Demo merchant
          </span>
        </div>
      </header>
      {children}
    </div>
  );
}
