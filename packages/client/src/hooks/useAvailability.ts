import { useState, useEffect, useCallback } from "react";
import type { PermitAvailability } from "../types/index.js";
import { fetchAvailability } from "../services/api.js";

export function useAvailability(permitId: string | undefined) {
  const [availability, setAvailability] = useState<PermitAvailability | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  const load = useCallback(async () => {
    if (!permitId) return;

    setLoading(true);
    setError(null);

    try {
      const data = await fetchAvailability(permitId, month);
      setAvailability(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load availability",
      );
      setAvailability(null);
    } finally {
      setLoading(false);
    }
  }, [permitId, month]);

  useEffect(() => {
    load();
  }, [load]);

  const nextMonth = useCallback(() => {
    setMonth((prev) => {
      const [y, m] = prev.split("-").map(Number);
      const d = new Date(y, m); // month is 0-indexed, so m (1-indexed) gives next month
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
  }, []);

  const prevMonth = useCallback(() => {
    setMonth((prev) => {
      const [y, m] = prev.split("-").map(Number);
      const d = new Date(y, m - 2); // go back one month
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
  }, []);

  return { availability, loading, error, month, setMonth, nextMonth, prevMonth, refresh: load };
}
