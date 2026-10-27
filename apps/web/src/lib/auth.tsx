"use client";

import type { AuthResponse, UserDto } from "@guardian/shared";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, refreshSession, setAccessToken, setSessionExpiredHandler } from "./api-client";

type AuthState =
  | { status: "loading"; user: null }
  | { status: "authenticated"; user: UserDto }
  | { status: "anonymous"; user: null };

type AuthContextValue = AuthState & {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: "loading", user: null });

  const accept = useCallback((session: AuthResponse) => {
    setAccessToken(session.accessToken);
    setState({ status: "authenticated", user: session.user });
  }, []);

  // Restore the session from the httpOnly refresh cookie on first load.
  useEffect(() => {
    let cancelled = false;
    refreshSession().then((session) => {
      if (cancelled) return;
      if (session) accept(session);
      else setState({ status: "anonymous", user: null });
    });
    return () => {
      cancelled = true;
    };
  }, [accept]);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setAccessToken(null);
      setState({ status: "anonymous", user: null });
      router.replace("/login?expired=1");
    });
    return () => setSessionExpiredHandler(null);
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login: async (email, password) => accept(await api<AuthResponse>("/auth/login", { method: "POST", body: { email, password } })),
      register: async (email, password, fullName) =>
        accept(await api<AuthResponse>("/auth/register", { method: "POST", body: { email, password, fullName: fullName || undefined } })),
      logout: async () => {
        await api("/auth/logout", { method: "POST" }).catch(() => undefined);
        setAccessToken(null);
        setState({ status: "anonymous", user: null });
        router.replace("/login");
      },
    }),
    [state, accept, router],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
