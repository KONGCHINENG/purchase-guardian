import type { PurchaseRequestStatus } from "@guardian/shared";
import { Badge } from "./ui";

const STATUS: Record<PurchaseRequestStatus, { label: string; tone: "neutral" | "brand" | "warn" | "danger" | "info" }> = {
  analyzing: { label: "Analyzing", tone: "neutral" },
  blocked: { label: "Blocked", tone: "danger" },
  pending_approval: { label: "Needs approval", tone: "warn" },
  approved: { label: "Approved", tone: "brand" },
  checkout_created: { label: "Awaiting payment", tone: "info" },
  completed: { label: "Paid", tone: "brand" },
  rejected: { label: "Rejected", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export function StatusBadge({ status }: { status: PurchaseRequestStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
