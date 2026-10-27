"use client";

import type { ReactNode } from "react";
import { AuthGate } from "@/components/auth-gate";
import { ShieldMark } from "@/components/ui";

/** Minimal chrome for the checkout interstitial: it should feel like a step in a payment, not an app. */
export default function CheckoutLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <div className="flex min-h-dvh flex-col items-center px-4 pb-10 pt-[calc(1.5rem+env(safe-area-inset-top))]">
        <div className="mb-6 flex items-center gap-2 text-sm font-medium text-ink-soft">
          <ShieldMark className="size-5 text-brand" /> Secured by Purchase Guardian
        </div>
        <div className="w-full max-w-md">{children}</div>
      </div>
    </AuthGate>
  );
}
