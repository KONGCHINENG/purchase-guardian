"use client";

import type { CheckoutSessionDto } from "@guardian/shared";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, Card, ShieldMark, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api-client";
import { money } from "@/lib/format";

/** PayPal sends the buyer here after approval: capture, confirm, then hand back to the merchant. */
export default function PayReturnPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<CheckoutSessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<CheckoutSessionDto>(`/checkout-sessions/${id}/complete`, { method: "POST" })
      .then((s) => {
        setSession(s);
        if (s.redirectUrl) setTimeout(() => window.location.assign(s.redirectUrl!), 1600);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  return (
    <Card className="p-8 text-center">
      {error ? (
        <>
          <p className="font-semibold text-ink">Payment not completed</p>
          <div className="mt-3 text-left">
            <Alert>{error}</Alert>
          </div>
          <a href={`/pay/${id}`} className="mt-4 inline-block text-sm font-medium text-brand hover:underline">
            Back to checkout
          </a>
        </>
      ) : !session ? (
        <div className="flex flex-col items-center gap-3 py-4 text-sm text-ink-soft">
          <Spinner className="size-6" />
          Confirming your payment with PayPal…
        </div>
      ) : (
        <>
          <ShieldMark className="mx-auto size-12 text-brand" />
          <p className="mt-3 text-lg font-semibold text-ink">{session.status === "completed" ? "Payment complete" : "Payment processing"}</p>
          <p className="tabular text-3xl font-semibold text-ink">{money(session.amountCents, session.currency)}</p>
          <p className="mt-2 flex items-center justify-center gap-2 text-sm text-ink-soft">
            <Spinner className="size-3" /> Returning to {session.merchant.name}…
          </p>
        </>
      )}
    </Card>
  );
}
