"use client";

import type { MerchantCheckoutSessionDto } from "@guardian/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import { api } from "@/lib/api-client";
import { money } from "@/lib/format";

/** The merchant's return page. It trusts its own server-side lookup, never the query string. */
function Complete() {
  const params = useSearchParams();
  const sessionId = params.get("guardian_session");
  const [session, setSession] = useState<MerchantCheckoutSessionDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    api<MerchantCheckoutSessionDto>(`/demo-store/sessions/${sessionId}`).then(setSession).catch(() => setFailed(true));
  }, [sessionId]);

  if (!sessionId || failed) return <Message emoji="🤔" title="We couldn't find that order." />;
  if (!session) {
    return (
      <div className="flex justify-center py-24 text-[#8a7a68]">
        <Spinner className="size-6" />
      </div>
    );
  }

  switch (session.status) {
    case "completed":
      return (
        <Message emoji="🎉" title="Order confirmed">
          {money(session.amountCents, session.currency)} paid with PayPal · order {session.merchantReference}
          <br />
          <span className="font-mono text-xs">PayPal {session.paypalOrderId}</span>
        </Message>
      );
    case "blocked":
      return <Message emoji="🛡️" title="Your Purchase Guardian declined this order">Nothing was charged. Your spending policy didn&apos;t allow this purchase.</Message>;
    case "cancelled":
      return <Message emoji="↩️" title="Checkout cancelled">Nothing was charged. Your cart is still here when you&apos;re ready.</Message>;
    case "expired":
      return <Message emoji="⏱️" title="Checkout expired">Nothing was charged. Please try again.</Message>;
    default:
      return <Message emoji="⏳" title="Payment pending">We&apos;ll confirm your order as soon as payment completes.</Message>;
  }
}

function Message({ emoji, title, children }: { emoji: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <div className="text-5xl" aria-hidden>
        {emoji}
      </div>
      <h1 className="mt-4 font-serif text-2xl font-semibold">{title}</h1>
      {children && <p className="mt-2 text-sm text-[#8a7a68]">{children}</p>}
      <Link href="/store" className="mt-8 inline-block rounded-full bg-[#2b2118] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#c2541b] dark:bg-[#f3ebe1] dark:text-[#1a1511]">
        Back to the store
      </Link>
    </div>
  );
}

export default function StoreCompletePage() {
  return (
    <Suspense>
      <Complete />
    </Suspense>
  );
}
