import { useState, useEffect } from "react";
import type { PermitDetail } from "../types/index.js";
import { fetchPermitDetail } from "../services/api.js";

export function usePermitDetail(permitId: string | undefined) {
  const [permit, setPermit] = useState<PermitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!permitId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const data = await fetchPermitDetail(permitId!);
        if (!cancelled) setPermit(data);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load permit",
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
  }, [permitId]);

  return { permit, loading, error };
}
