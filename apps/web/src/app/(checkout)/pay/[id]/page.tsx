"use client";

import type { CheckoutSessionDto } from "@guardian/shared";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Spinner, cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api-client";
import { BLOCKING_RULES, humanize, money, RULE_LABELS } from "@/lib/format";

const POLL_MS = 2500;
const AUTO_CONTINUE_MS = 1800;

function CheckoutView() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const paypalCancelled = params.get("paypal") === "cancelled";
  const [session, setSession] = useState<CheckoutSessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "pay" | "cancel">(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const redirected = useRef(false);

  const go = useCallback((url: string) => {
    if (redirected.current) return;
    redirected.current = true;
    window.location.assign(url);
  }, []);

  // 1) Claim on load: binds the session to this shopper and runs their policy.
  useEffect(() => {
    api<CheckoutSessionDto>(`/checkout-sessions/${id}/claim`, { method: "POST" })
      .then(setSession)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  // 2) While waiting for approval (possibly on another device), poll.
  useEffect(() => {
    if (session?.status !== "pending_approval") return;
    const timer = setInterval(() => {
      api<CheckoutSessionDto>(`/checkout-sessions/${id}/view`).then(setSession).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [id, session?.status]);

  const pay = useCallback(async () => {
    setBusy("pay");
    setError(null);
    try {
      const { approvalUrl } = await api<{ approvalUrl: string }>(`/checkout-sessions/${id}/pay`, { method: "POST" });
      go(approvalUrl);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }, [go, id]);

  // 3) Approved → continue to PayPal automatically. Final → back to the merchant.
  useEffect(() => {
    if (!session) return;
    if (session.status === "approved" && !paypalCancelled) {
      setCountdown(AUTO_CONTINUE_MS);
      const t = setTimeout(() => void pay(), AUTO_CONTINUE_MS);
      return () => clearTimeout(t);
    }
    if (session.redirectUrl && session.status !== "completed") {
      const t = setTimeout(() => go(session.redirectUrl!), session.status === "blocked" ? 5000 : 2500);
      return () => clearTimeout(t);
    }
    if (session.status === "completed" && session.redirectUrl) go(session.redirectUrl);
  }, [session, paypalCancelled, pay, go]);

  const decide = async (verdict: "approve" | "reject") => {
    const approvalId = session?.request?.approval?.id;
    if (!approvalId) return;
    setBusy(verdict);
    try {
      await api(`/approvals/${approvalId}/${verdict}`, { method: "POST" });
      setSession(await api<CheckoutSessionDto>(`/checkout-sessions/${id}/view`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    try {
      const next = await api<CheckoutSessionDto>(`/checkout-sessions/${id}/cancel`, { method: "POST" });
      if (next.redirectUrl) go(next.redirectUrl);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  if (error && !session) {
    return (
      <Card className="p-6">
        <p className="font-semibold text-ink">Checkout unavailable</p>
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      </Card>
    );
  }
  if (!session) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-sm text-ink-soft">
        <Spinner className="size-6" />
        Checking this purchase against your policy…
      </Card>
    );
  }

  const decision = session.request?.decision;
  const tone =
    session.status === "blocked" ? "border-t-danger" : session.status === "pending_approval" ? "border-t-warn" : "border-t-brand";

  return (
    <Card className={cx("animate-rise overflow-hidden border-t-4", tone)}>
      <div className="p-6">
        <p className="text-xs uppercase tracking-wide text-ink-faint">Paying {session.merchant.name}</p>
        <p className="tabular mt-1 text-4xl font-semibold tracking-tight text-ink">{money(session.amountCents, session.currency)}</p>

        <ul className="mt-4 space-y-1.5 text-sm">
          {session.items.map((item, i) => (
            <li key={i} className="flex justify-between gap-4 text-ink-soft">
              <span className="truncate">
                {item.quantity}× {item.name}
              </span>
              <span className="tabular shrink-0">{money(item.unitAmountCents * item.quantity, session.currency)}</span>
            </li>
          ))}
        </ul>

        {session.agentContext && (
          <div className="mt-4 rounded-[10px] bg-info-tint px-3.5 py-3 text-sm text-info">
            <p className="font-medium">🤖 Requested by {session.agentContext.agentName}</p>
            <p className="mt-0.5 opacity-90">Goal: “{session.agentContext.goal}”</p>
            {session.agentContext.reasoning && <p className="mt-1 text-xs opacity-80">{session.agentContext.reasoning}</p>}
          </div>
        )}
      </div>

      <div className="border-t border-line bg-sunken/50 p-6">
        <StatusHeadline session={session} countdown={countdown} paypalCancelled={paypalCancelled} />
        {decision && <p className="mt-2 text-sm leading-relaxed text-ink-soft">{decision.explanation}</p>}
        {decision && decision.triggeredRules.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {decision.triggeredRules.map((r) => (
              <Badge key={r} tone={BLOCKING_RULES.has(r) ? "danger" : "warn"}>
                {RULE_LABELS[r] ?? humanize(r.toLowerCase())}
              </Badge>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-2">
          {session.status === "pending_approval" && (
            <>
              <Button onClick={() => decide("approve")} loading={busy === "approve"} disabled={Boolean(busy)}>
                Approve and pay
              </Button>
              <Button variant="danger" onClick={() => decide("reject")} loading={busy === "reject"} disabled={Boolean(busy)}>
                Decline
              </Button>
              <p className="text-center text-xs text-ink-faint">Or approve from the Guardian app on your phone. This page updates automatically.</p>
            </>
          )}
          {(session.status === "approved" || session.status === "paying") && (
            <Button variant="paypal" onClick={pay} loading={busy === "pay"}>
              Continue with <span className="font-bold italic text-[#003087]">Pay</span>
              <span className="-ml-2 font-bold italic text-[#0070e0]">Pal</span>
            </Button>
          )}
          {!session.redirectUrl && (
            <Button variant="ghost" onClick={cancel} loading={busy === "cancel"} disabled={Boolean(busy)}>
              Cancel and return to {session.merchant.name}
            </Button>
          )}
          {session.redirectUrl && session.status !== "completed" && (
            <Button variant="secondary" onClick={() => go(session.redirectUrl!)}>
              Return to {session.merchant.name}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function StatusHeadline({ session, countdown, paypalCancelled }: { session: CheckoutSessionDto; countdown: number | null; paypalCancelled: boolean }) {
  switch (session.status) {
    case "approved":
    case "paying":
      return (
        <p className="flex items-center gap-2 font-semibold text-brand">
          ✓ Approved by your policy
          {!paypalCancelled && countdown !== null && (
            <span className="flex items-center gap-1.5 text-xs font-normal text-ink-faint">
              <Spinner className="size-3" /> opening PayPal…
            </span>
          )}
          {paypalCancelled && <span className="text-xs font-normal text-ink-faint">PayPal was closed. Continue when ready.</span>}
        </p>
      );
    case "pending_approval":
      return (
        <p className="flex items-center gap-2 font-semibold text-warn">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-warn opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-warn" />
          </span>
          Waiting for your approval
        </p>
      );
    case "blocked":
      return <p className="font-semibold text-danger">✕ Blocked by your policy. Returning to the store…</p>;
    case "completed":
      return <p className="font-semibold text-brand">✓ Paid. Returning to the store…</p>;
    case "cancelled":
      return <p className="font-semibold text-ink">Cancelled. Returning to the store…</p>;
    case "expired":
      return <p className="font-semibold text-ink">This checkout expired. Returning to the store…</p>;
    case "failed":
      return <p className="font-semibold text-danger">Something went wrong. Returning to the store…</p>;
    default:
      return <p className="font-semibold text-ink-soft">Checking…</p>;
  }
}

export default function PayPage() {
  return (
    <Suspense>
      <CheckoutView />
    </Suspense>
  );
}
