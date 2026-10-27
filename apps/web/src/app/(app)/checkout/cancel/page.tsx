import Link from "next/link";
import { Card } from "@/components/ui";

export default function CheckoutCancelPage() {
  return (
    <Card className="mx-auto max-w-md p-8 text-center">
      <p className="text-lg font-semibold text-ink">Checkout cancelled</p>
      <p className="mt-2 text-sm text-ink-soft">
        Nothing was charged. The purchase stays approved, so you can reopen PayPal from Guardian while the checkout is still open.
      </p>
      <Link href="/dashboard" className="mt-6 inline-block font-medium text-brand hover:underline">
        Back to Guardian
      </Link>
    </Card>
  );
}
