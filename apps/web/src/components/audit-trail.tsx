import type { AuditEventDto } from "@guardian/shared";
import { humanize } from "@/lib/format";
import { cx } from "./ui";

const ACTOR_STYLE: Record<AuditEventDto["actor"], { label: string; dot: string }> = {
  user: { label: "You", dot: "bg-ink" },
  ai: { label: "AI", dot: "bg-info" },
  policy_engine: { label: "Policy engine", dot: "bg-warn" },
  system: { label: "System", dot: "bg-ink-faint" },
  paypal: { label: "PayPal", dot: "bg-[#0070e0]" },
};

function describe(e: AuditEventDto): string | null {
  const m = e.metadata as Record<string, unknown>;
  if (e.action === "ai.analysis_completed") return typeof m.summary === "string" ? m.summary : null;
  if (e.action === "policy.evaluated") return typeof m.explanation === "string" ? m.explanation : null;
  if (e.action === "payment.order_created") return `PayPal order ${String(m.paypalOrderId)} (${String(m.environment)})`;
  if (e.action === "payment.captured") return m.captureId ? `Capture ${String(m.captureId)}` : null;
  if (e.action === "payment.checkout_denied") return typeof m.explanation === "string" ? m.explanation : null;
  return null;
}

export function AuditTrail({ events }: { events: AuditEventDto[] }) {
  return (
    <ol className="relative space-y-5 border-l border-line pl-6">
      {events.map((e) => {
        const actor = ACTOR_STYLE[e.actor];
        const detail = describe(e);
        return (
          <li key={e.id} className="relative">
            <span className={cx("absolute -left-[29px] top-1.5 size-2.5 rounded-full ring-4 ring-surface", actor.dot)} />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-ink">{humanize(e.action.split(".").pop() ?? e.action)}</span>
              <span className="text-xs text-ink-faint">
                {actor.label} · {new Date(e.createdAt).toLocaleString()}
              </span>
              {e.outcome && <span className="font-mono text-xs text-ink-soft">{e.outcome}</span>}
            </div>
            {detail && <p className="mt-0.5 text-sm text-ink-soft">{detail}</p>}
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-soft">Raw event</summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-sunken p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
                {JSON.stringify({ action: e.action, ...e.metadata }, null, 2)}
              </pre>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
