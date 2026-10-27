"use client";

import type { OrderDto } from "@guardian/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Alert, Card, ShieldMark, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api-client";
import { money } from "@/lib/format";

function CaptureView() {
  const params = useSearchParams();
  const orderId = params.get("orderId");
  const [order, setOrder] = useState<OrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Capture exactly once per page load (Strict Mode double-invokes effects in dev);
    // the API is idempotent anyway, so a refresh is also safe.
    if (!orderId || started.current) return;
    started.current = true;
    api<OrderDto>(`/payments/paypal/orders/${orderId}/capture`, { method: "POST" })
      .then(setOrder)
      .catch((e) => setError(errorMessage(e)));
  }, [orderId]);

  if (!orderId) return <Alert>Missing order reference.</Alert>;

  return (
    <Card className="mx-auto max-w-md p-8 text-center">
      {error ? (
        <>
          <p className="text-lg font-semibold text-ink">Payment not completed</p>
          <div className="mt-4 text-left">
            <Alert>{error}</Alert>
          </div>
        </>
      ) : !order ? (
        <div className="flex flex-col items-center gap-3 py-6 text-ink-soft">
          <Spinner className="size-6" />
          Confirming your payment with PayPal…
        </div>
      ) : (
        <>
          <ShieldMark className="mx-auto size-12 text-brand" />
          <p className="mt-4 text-xl font-semibold text-ink">{order.status === "completed" ? "Payment complete" : "Payment processing"}</p>
          <p className="tabular mt-1 text-3xl font-semibold text-ink">{money(order.amountCents, order.currency)}</p>
          <p className="mt-2 text-sm text-ink-soft">
            {order.status === "completed"
              ? "PayPal captured the payment. It's recorded in your audit trail."
              : "PayPal is still processing this payment. We'll update it automatically."}
          </p>
          <p className="mt-3 font-mono text-xs text-ink-faint">PayPal order {order.paypalOrderId}</p>
        </>
      )}
      <div className="mt-6 flex justify-center gap-4 text-sm">
        {order && (
          <Link href={`/requests/${order.purchaseRequestId}`} className="font-medium text-brand hover:underline">
            View audit trail
          </Link>
        )}
        <Link href="/dashboard" className="text-ink-soft hover:text-ink">
          Back to Guardian
        </Link>
      </div>
    </Card>
  );
}

export default function CheckoutReturnPage() {
  return (
    <Suspense>
      <CaptureView />
    </Suspense>
  );
}
