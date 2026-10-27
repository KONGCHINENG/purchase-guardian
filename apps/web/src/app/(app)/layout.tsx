"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AuthGate } from "@/components/auth-gate";
import { ShieldMark, cx } from "@/components/ui";
import { useAuth } from "@/lib/auth";

const NAV = [
  { href: "/dashboard", label: "Guardian", icon: "M12 3 5 6v5c0 4.4 3 8.2 7 9.3 4-1.1 7-4.9 7-9.3V6l-7-3Z" },
  { href: "/approvals", label: "Approvals", icon: "M9 12.5l2 2 4-4.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" },
  { href: "/activity", label: "Activity", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/policies", label: "Policy", icon: "M5 8h14M5 16h14M9 5v6M15 13v6" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <Shell>{children}</Shell>
    </AuthGate>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = usePathname();
  const active = (href: string) => pathname.startsWith(href);

  return (
    <div className="min-h-dvh pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-8">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-ink">
            <ShieldMark className="size-5 text-brand" />
            <span>Purchase Guardian</span>
          </Link>
          <nav className="hidden gap-1 text-sm sm:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cx(
                  "rounded-lg px-3 py-1.5 whitespace-nowrap transition-colors",
                  active(item.href) ? "bg-surface font-medium text-ink shadow-[var(--shadow-card)]" : "text-ink-soft hover:text-ink",
                )}
              >
                {item.label}
              </Link>
            ))}
            <Link href="/store" className="rounded-lg px-3 py-1.5 text-ink-soft hover:text-ink">
              Demo store ↗
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden max-w-48 truncate text-ink-faint md:inline">{auth.user?.email}</span>
            <button onClick={() => void auth.logout()} className="text-ink-soft hover:text-ink">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">{children}</main>

      {/* Mobile tab bar: the installed-app navigation. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cx("flex flex-col items-center gap-1 py-2.5 text-[11px]", active(item.href) ? "text-brand" : "text-ink-faint")}
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={item.icon} />
            </svg>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
