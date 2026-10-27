"use client";

import type { Paginated, PurchaseRequestDto } from "@guardian/shared";
import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "@/components/status";
import { Alert, Button, EmptyState, PageHeader, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api-client";
import { money, relativeTime } from "@/lib/format";
import { useApi } from "@/lib/use-api";

export default function ActivityPage() {
  const first = useApi<Paginated<PurchaseRequestDto>>("/purchase-requests?limit=25");
  const [more, setMore] = useState<PurchaseRequestDto[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = [...(first.data?.items ?? []), ...more];
  const nextCursor = cursor === undefined ? first.data?.nextCursor : cursor;

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<Paginated<PurchaseRequestDto>>(`/purchase-requests?limit=25&cursor=${encodeURIComponent(nextCursor)}`);
      setMore((m) => [...m, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <PageHeader title="Activity" description="Every request, decision and PayPal order, with a full audit trail." />
      {(first.error || error) && <Alert>{first.error ?? error}</Alert>}
      {first.loading && !first.data ? (
        <div className="flex justify-center py-16 text-ink-faint">
          <Spinner className="size-5" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="No activity yet">
          <Link href="/dashboard" className="text-brand hover:underline">
            Ask Guardian to check a purchase
          </Link>
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-sunken/60 text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-5 py-3 font-medium">Item</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">Merchant</th>
                <th className="px-5 py-3 text-right font-medium">Amount</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="hidden px-5 py-3 text-right font-medium md:table-cell">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((r) => (
                <tr key={r.id} className="hover:bg-sunken/50">
                  <td className="max-w-0 px-5 py-3">
                    <Link href={`/requests/${r.id}`} className="block truncate font-medium text-ink hover:underline">
                      {r.extracted.itemName ?? r.rawInput}
                    </Link>
                  </td>
                  <td className="hidden px-5 py-3 text-ink-soft sm:table-cell">{r.extracted.merchantName ?? "—"}</td>
                  <td className="tabular px-5 py-3 text-right text-ink">{money(r.extracted.amountCents, r.extracted.currency)}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="hidden px-5 py-3 text-right text-ink-faint md:table-cell">{relativeTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}
