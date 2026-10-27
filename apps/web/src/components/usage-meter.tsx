import type { UsageDto } from "@guardian/shared";
import Link from "next/link";
import { money } from "@/lib/format";
import { Card } from "./ui";

export function UsageMeter({ usage }: { usage: UsageDto | null }) {
  if (!usage) return <Card className="h-[188px] animate-pulse p-5" />;
  const limit = Math.max(usage.monthlyLimitCents, 1);
  const spentPct = Math.min(100, (usage.spentCents / limit) * 100);
  const reservedPct = Math.min(100 - spentPct, (usage.reservedCents / limit) * 100);
  const month = new Date(usage.periodStart).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-ink-soft">{month} budget</p>
        <Link href="/policies" className="text-xs text-ink-faint hover:text-ink">
          Edit
        </Link>
      </div>
      <p className="tabular mt-1 text-3xl font-semibold tracking-tight text-ink">{money(usage.remainingCents, usage.currency)}</p>
      <p className="text-sm text-ink-faint">left of {money(usage.monthlyLimitCents, usage.currency)}</p>
      <div
        className="mt-4 flex h-2 overflow-hidden rounded-full bg-sunken"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={usage.monthlyLimitCents}
        aria-valuenow={usage.spentCents + usage.reservedCents}
        aria-label="Monthly budget used"
      >
        <div className="bg-brand transition-all" style={{ width: `${spentPct}%` }} />
        <div className="bg-brand/40 transition-all" style={{ width: `${reservedPct}%` }} />
      </div>
      <div className="mt-3 flex gap-4 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-brand" /> Spent {money(usage.spentCents, usage.currency)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-brand/40" /> In checkout {money(usage.reservedCents, usage.currency)}
        </span>
      </div>
    </Card>
  );
}
