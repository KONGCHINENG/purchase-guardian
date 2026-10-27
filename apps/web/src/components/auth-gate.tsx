"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { Spinner } from "./ui";

/** Renders children only for signed-in users; otherwise sends them to login and back. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (auth.status === "anonymous") {
      const next = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next || pathname)}`);
    }
  }, [auth.status, pathname, router]);

  if (auth.status !== "authenticated") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-faint">
        <Spinner className="size-5" />
      </div>
    );
  }
  return <>{children}</>;
}
