"use client";

import type { PurchaseRequestDetailDto } from "@guardian/shared";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuditTrail } from "@/components/audit-trail";
import { DecisionCard } from "@/components/decision-card";
import { Alert, Card, Spinner } from "@/components/ui";
import { humanize, money } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export default function RequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<PurchaseRequestDetailDto>(`/purchase-requests/${id}`);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/activity" className="text-sm text-ink-soft hover:text-ink">
        ← Activity
      </Link>
      {error && <Alert>{error}</Alert>}
      {loading && !data ? (
        <div className="flex justify-center py-16 text-ink-faint">
          <Spinner className="size-5" />
        </div>
      ) : data ? (
        <>
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-faint">Request</p>
            <p className="mt-1 text-lg text-ink">“{data.rawInput}”</p>
          </div>
          <DecisionCard request={data} onChange={() => void reload()} />

          {data.order && (
            <Card className="p-5">
              <p className="text-sm font-medium text-ink">PayPal order</p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-ink-faint">Order ID</dt>
                  <dd className="truncate font-mono text-xs text-ink">{data.order.paypalOrderId ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-faint">Status</dt>
                  <dd className="text-ink">{humanize(data.order.status)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-faint">Amount</dt>
                  <dd className="tabular text-ink">{money(data.order.amountCents, data.order.currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-faint">Capture ID</dt>
                  <dd className="truncate font-mono text-xs text-ink">{data.order.captureId ?? "—"}</dd>
                </div>
              </dl>
            </Card>
          )}

          <Card className="p-6">
            <p className="mb-5 text-sm font-medium text-ink">Audit trail</p>
            <AuditTrail events={data.audit} />
            <p className="mt-6 text-xs text-ink-faint">The audit log is append-only: the database rejects edits and deletions.</p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
