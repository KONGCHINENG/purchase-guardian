"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { Alert, Button, Field, Input, ShieldMark } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const auth = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const next = params.get("next")?.startsWith("/") ? params.get("next")! : "/dashboard";

  useEffect(() => {
    if (auth.status === "authenticated") router.replace(next);
  }, [auth.status, next, router]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const email = String(form.get("email"));
      const password = String(form.get("password"));
      if (mode === "login") await auth.login(email, password);
      else await auth.register(email, password, String(form.get("fullName") ?? ""));
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center gap-2 font-semibold text-ink">
          <ShieldMark className="size-6 text-brand" /> Purchase Guardian
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {mode === "login" ? "Sign in to review what your AI wants to buy." : "Set your spending rules once. Your AI follows them."}
        </p>
        {params.get("expired") && (
          <div className="mt-4">
            <Alert tone="info">Your session expired. Please sign in again.</Alert>
          </div>
        )}
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          {mode === "register" && (
            <Field label="Name">
              <Input name="fullName" autoComplete="name" placeholder="Alex Tan" />
            </Field>
          )}
          <Field label="Email">
            <Input name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
          </Field>
          <Field label="Password" hint={mode === "register" ? "At least 10 characters." : undefined}>
            <Input
              name="password"
              type="password"
              required
              minLength={mode === "register" ? 10 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </Field>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" loading={pending} className="w-full">
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-ink-soft">
          {mode === "login" ? (
            <>
              New here?{" "}
              <Link href="/register" className="font-medium text-brand hover:underline">
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-brand hover:underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </main>
  );
}
