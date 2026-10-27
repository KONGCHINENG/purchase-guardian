"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { ShieldMark, Spinner, cx } from "@/components/ui";
import { useAuth } from "@/lib/auth";

const NAV = [
  { href: "/dashboard", label: "Guardian" },
  { href: "/approvals", label: "Approvals" },
  { href: "/activity", label: "Activity" },
  { href: "/policies", label: "Policy" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (auth.status === "anonymous") {
      const next = typeof window === "undefined" ? pathname : window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [auth.status, pathname, router]);

  if (auth.status !== "authenticated") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-faint">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5 sm:px-8">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-ink">
            <ShieldMark className="size-5 text-brand" />
            <span className="hidden sm:inline">Purchase Guardian</span>
          </Link>
          <nav className="flex gap-1 overflow-x-auto text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cx(
                  "rounded-lg px-3 py-1.5 whitespace-nowrap transition-colors",
                  pathname.startsWith(item.href) ? "bg-surface font-medium text-ink shadow-[var(--shadow-card)]" : "text-ink-soft hover:text-ink",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden max-w-48 truncate text-ink-faint md:inline">{auth.user.email}</span>
            <button onClick={() => void auth.logout()} className="text-ink-soft hover:text-ink">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8">{children}</main>
    </div>
  );
}
