import { useState, useEffect } from "react";
import type { PermitSummary } from "../types/index.js";
import { fetchPermits } from "../services/api.js";

export function usePermits() {
  const [permits, setPermits] = useState<PermitSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const data = await fetchPermits();
        if (!cancelled) setPermits(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load permits",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { permits, loading, error };
}
