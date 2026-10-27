"use client";

import type { ApprovalListItemDto, PurchaseRequestDto } from "@guardian/shared";
import { DecisionCard } from "@/components/decision-card";
import { Alert, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { humanize, money, relativeTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export default function ApprovalsPage() {
  const { data, error, loading, reload } = useApi<{ items: ApprovalListItemDto[] }>("/approvals");
  const pending = data?.items.filter((a) => a.status === "pending") ?? [];
  const history = data?.items.filter((a) => a.status !== "pending") ?? [];

  const asRequest = (a: ApprovalListItemDto): PurchaseRequestDto => ({
    id: a.purchaseRequestId,
    rawInput: a.request.rawInput,
    status: a.request.status,
    extracted: a.request.extracted,
    decision: a.request.decision,
    approval: a,
    order: null,
    createdAt: a.createdAt,
    updatedAt: a.createdAt,
  });

  return (
    <>
      <PageHeader title="Approvals" description="Purchases your policy flagged for a human decision. Approvals expire if you don't act." />
      {error && <Alert>{error}</Alert>}
      {loading && !data ? (
        <div className="flex justify-center py-16 text-ink-faint">
          <Spinner className="size-5" />
        </div>
      ) : (
        <div className="space-y-10">
          <section className="space-y-4">
            {pending.length === 0 ? (
              <EmptyState title="Nothing waiting on you">New flagged purchases will show up here.</EmptyState>
            ) : (
              pending.map((a) => (
                <div key={a.id} className="space-y-2">
                  <p className="text-xs text-ink-faint">
                    Requested {relativeTime(a.createdAt)} · expires at{" "}
                    {new Date(a.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </p>
                  <DecisionCard request={asRequest(a)} onChange={() => void reload()} />
                </div>
              ))
            )}
          </section>

          {history.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-medium text-ink-soft">History</h2>
              <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line bg-surface">
                {history.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                    <span className="min-w-0 truncate text-ink">{a.request.extracted.itemName ?? a.request.rawInput}</span>
                    <span className="flex shrink-0 items-center gap-4 text-ink-soft">
                      <span className="tabular">{money(a.request.extracted.amountCents, a.request.extracted.currency)}</span>
                      <span className="w-20 text-right">{humanize(a.status)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
