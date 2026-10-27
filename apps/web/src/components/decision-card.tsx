"use client";

import type { ApprovalListItemDto, OrderDto, PurchaseRequestDto } from "@guardian/shared";
import Link from "next/link";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { BLOCKING_RULES, humanize, money, RULE_LABELS } from "@/lib/format";
import { StatusBadge } from "./status";
import { Alert, Badge, Button, cx } from "./ui";

type Props = {
  request: PurchaseRequestDto;
  onChange?: (next: PurchaseRequestDto) => void;
  compact?: boolean;
};

/**
 * The trust surface: what the AI understood, what the policy decided and why,
 * and the only actions the user is allowed to take next.
 */
export function DecisionCard({ request, onChange, compact }: Props) {
  const [busy, setBusy] = useState<null | "approve" | "reject" | "pay">(null);
  const [error, setError] = useState<string | null>(null);
  const { extracted: x, decision, approval, order } = request;

  const refresh = async () => onChange?.(await api<PurchaseRequestDto>(`/purchase-requests/${request.id}`));

  const decide = async (verdict: "approve" | "reject") => {
    if (!approval) return;
    setBusy(verdict);
    setError(null);
    try {
      await api<ApprovalListItemDto>(`/approvals/${approval.id}/${verdict}`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const pay = async () => {
    setBusy("pay");
    setError(null);
    try {
      const created = order?.approvalUrl
        ? order
        : await api<OrderDto>("/payments/paypal/orders", { method: "POST", body: { purchaseRequestId: request.id } });
      if (!created.approvalUrl) throw new Error("PayPal didn't return a checkout link");
      window.location.assign(created.approvalUrl);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
      await refresh().catch(() => undefined);
    }
  };

  const tone =
    decision?.decision === "block" ? "border-l-danger" : decision?.decision === "require_approval" ? "border-l-warn" : "border-l-brand";
  const canPay = request.status === "approved" || (request.status === "checkout_created" && Boolean(order?.approvalUrl));

  return (
    <div className={cx("animate-rise rounded-[var(--radius-card)] border border-line border-l-4 bg-surface shadow-[var(--shadow-card)]", tone)}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{x.itemName ?? "Analyzing request…"}</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            {x.merchantName || "No merchant named"} · {x.category ? humanize(x.category) : "—"}
            {x.quantity > 1 ? ` · qty ${x.quantity}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular text-lg font-semibold text-ink">{money(x.amountCents, x.currency)}</span>
          <StatusBadge status={request.status} />
        </div>
      </div>

      {decision && (
        <div className="px-5 pt-3">
          <p className="text-sm leading-relaxed text-ink">{decision.explanation}</p>
          {decision.triggeredRules.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {decision.triggeredRules.map((rule) => (
                <Badge key={rule} tone={BLOCKING_RULES.has(rule) ? "danger" : "warn"}>
                  {RULE_LABELS[rule] ?? humanize(rule.toLowerCase())}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {!compact && (
        <dl className="mx-5 mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-line pt-3 text-xs text-ink-faint sm:grid-cols-3">
          <div>
            <dt className="inline">AI confidence: </dt>
            <dd className="inline tabular text-ink-soft">{x.confidence === null ? "—" : `${Math.round(x.confidence * 100)}%`}</dd>
          </div>
          <div>
            <dt className="inline">Parsed by: </dt>
            <dd className="inline text-ink-soft">{x.provider ?? "—"}</dd>
          </div>
          {x.riskFlags.length > 0 && (
            <div className="col-span-2 sm:col-span-1">
              <dt className="inline">Flags: </dt>
              <dd className="inline text-warn">{x.riskFlags.map(humanize).join(", ")}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-2 px-5 pb-4 pt-3">
        {request.status === "pending_approval" && approval?.status === "pending" && (
          <>
            <Button onClick={() => decide("approve")} loading={busy === "approve"} disabled={Boolean(busy)}>
              Approve once
            </Button>
            <Button variant="danger" onClick={() => decide("reject")} loading={busy === "reject"} disabled={Boolean(busy)}>
              Reject
            </Button>
            <Link href="/policies" className="text-sm text-ink-soft underline-offset-4 hover:underline">
              Change policy
            </Link>
          </>
        )}
        {canPay && (
          <Button variant="paypal" onClick={pay} loading={busy === "pay"}>
            Pay with <span className="font-bold italic text-[#003087]">Pay</span>
            <span className="-ml-2 font-bold italic text-[#0070e0]">Pal</span>
          </Button>
        )}
        {request.status === "completed" && order && (
          <span className="text-sm text-brand">
            Paid · PayPal order <span className="font-mono text-xs">{order.paypalOrderId}</span>
          </span>
        )}
        <Link href={`/requests/${request.id}`} className="ml-auto text-sm text-ink-soft underline-offset-4 hover:text-ink hover:underline">
          Audit trail →
        </Link>
      </div>
      {error && (
        <div className="px-5 pb-4">
          <Alert>{error}</Alert>
        </div>
      )}
    </div>
  );
}
