"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api-client";

/** Minimal data hook: fetch on mount/key change, expose reload + optimistic setter. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await api<T>(path);
      if (current === generation.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}
