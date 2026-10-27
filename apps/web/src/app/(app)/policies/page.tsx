"use client";

import { CATEGORIES, CURRENCIES, RISK_SENSITIVITIES, type PolicyDto, type UpdatePolicyInput } from "@guardian/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Card, Field, Input, PageHeader, Spinner, cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api-client";
import { centsToDollars, dollarsToCents, humanize } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Draft = {
  currency: PolicyDto["currency"];
  monthly: string;
  perPurchase: string;
  approvalAbove: string;
  blockedCategories: string[];
  allowedMerchants: string;
  blockedMerchants: string;
  riskSensitivity: PolicyDto["riskSensitivity"];
};

const toDraft = (p: PolicyDto): Draft => ({
  currency: p.currency,
  monthly: centsToDollars(p.monthlyLimitCents),
  perPurchase: centsToDollars(p.perPurchaseLimitCents),
  approvalAbove: centsToDollars(p.requireApprovalAboveCents),
  blockedCategories: p.blockedCategories,
  allowedMerchants: p.allowedMerchants.join(", "),
  blockedMerchants: p.blockedMerchants.join(", "),
  riskSensitivity: p.riskSensitivity,
});

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

const SENSITIVITY_HINT: Record<PolicyDto["riskSensitivity"], string> = {
  strict: "Ask me unless the AI is ≥90% sure",
  balanced: "Ask me unless the AI is ≥75% sure",
  relaxed: "Ask me unless the AI is ≥60% sure",
};

export default function PoliciesPage() {
  const { data, error, loading, setData } = useApi<PolicyDto>("/policies/me");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);

  useEffect(() => {
    if (data) setDraft(toDraft(data));
  }, [data]);

  if (loading && !draft) {
    return (
      <div className="flex justify-center py-16 text-ink-faint">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (!draft) return error ? <Alert>{error}</Alert> : null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    const body: UpdatePolicyInput = {
      currency: draft.currency,
      monthlyLimitCents: dollarsToCents(draft.monthly),
      perPurchaseLimitCents: dollarsToCents(draft.perPurchase),
      requireApprovalAboveCents: dollarsToCents(draft.approvalAbove),
      blockedCategories: draft.blockedCategories as UpdatePolicyInput["blockedCategories"],
      allowedMerchants: splitList(draft.allowedMerchants),
      blockedMerchants: splitList(draft.blockedMerchants),
      riskSensitivity: draft.riskSensitivity,
    };
    try {
      const saved = await api<PolicyDto>("/policies/me", { method: "PUT", body });
      setData(saved);
      setMessage({ tone: "info", text: `Saved. Policy is now version ${saved.version}; new requests use it immediately.` });
    } catch (err) {
      setMessage({ tone: "danger", text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="mx-auto max-w-3xl">
      <PageHeader
        title="Spending policy"
        description={`The rules Guardian enforces on every purchase. Version ${data?.version ?? 1}.`}
        action={
          <Button type="submit" loading={saving}>
            Save policy
          </Button>
        }
      />
      {message && (
        <div className="mb-4">
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      )}

      <div className="space-y-5">
        <Card className="grid gap-5 p-6 sm:grid-cols-2">
          <Field label="Monthly budget" hint="Captured payments plus open checkouts count toward this.">
            <Input inputMode="decimal" value={draft.monthly} onChange={(e) => set("monthly", e.target.value)} required />
          </Field>
          <Field label="Per-purchase limit" hint="Anything above this is blocked outright.">
            <Input inputMode="decimal" value={draft.perPurchase} onChange={(e) => set("perPurchase", e.target.value)} required />
          </Field>
          <Field label="Ask me above" hint="Purchases above this need your approval.">
            <Input inputMode="decimal" value={draft.approvalAbove} onChange={(e) => set("approvalAbove", e.target.value)} required />
          </Field>
          <Field label="Currency">
            <select
              value={draft.currency}
              onChange={(e) => set("currency", e.target.value as Draft["currency"])}
              className="h-10 w-full rounded-[10px] border border-line bg-surface px-3 text-sm text-ink"
            >
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </Card>

        <Card className="p-6">
          <p className="text-sm font-medium text-ink">AI confidence</p>
          <p className="mt-0.5 text-xs text-ink-faint">How sure the AI must be about what you meant before Guardian skips asking you.</p>
          <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup">
            {RISK_SENSITIVITIES.map((s) => (
              <button
                type="button"
                role="radio"
                aria-checked={draft.riskSensitivity === s}
                key={s}
                onClick={() => set("riskSensitivity", s)}
                className={cx(
                  "rounded-[10px] border px-3 py-2.5 text-left text-sm transition-colors",
                  draft.riskSensitivity === s ? "border-brand bg-brand-tint text-ink" : "border-line text-ink-soft hover:bg-sunken",
                )}
              >
                <span className="block font-medium">{humanize(s)}</span>
                <span className="block text-xs text-ink-faint">{SENSITIVITY_HINT[s]}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <p className="text-sm font-medium text-ink">Blocked categories</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {CATEGORIES.filter((c) => c !== "other").map((c) => {
              const on = draft.blockedCategories.includes(c);
              return (
                <button
                  type="button"
                  key={c}
                  aria-pressed={on}
                  onClick={() => set("blockedCategories", on ? draft.blockedCategories.filter((x) => x !== c) : [...draft.blockedCategories, c])}
                  className={cx(
                    "rounded-full border px-3 py-1 text-sm transition-colors",
                    on ? "border-danger bg-danger-tint text-danger" : "border-line text-ink-soft hover:bg-sunken",
                  )}
                >
                  {humanize(c)}
                </button>
              );
            })}
          </div>
        </Card>

        <Card className="grid gap-5 p-6 sm:grid-cols-2">
          <Field label="Blocked merchants" hint="Comma-separated. Always blocked.">
            <textarea
              value={draft.blockedMerchants}
              onChange={(e) => set("blockedMerchants", e.target.value)}
              rows={3}
              className="w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </Field>
          <Field label="Allowed merchants" hint="Optional. If set, other merchants need approval.">
            <textarea
              value={draft.allowedMerchants}
              onChange={(e) => set("allowedMerchants", e.target.value)}
              rows={3}
              className="w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
            />
          </Field>
        </Card>
      </div>
    </form>
  );
}
