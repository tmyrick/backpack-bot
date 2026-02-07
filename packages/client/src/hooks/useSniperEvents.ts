import { useState, useEffect, useRef, useCallback } from "react";
import type { SniperJob } from "../types/index.js";

/**
 * Hook that subscribes to the sniper SSE stream and maintains
 * a live map of sniper job states.
 */
export function useSniperEvents() {
  const [jobs, setJobs] = useState<Map<string, SniperJob>>(new Map());
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/sniper/events/stream");
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (event) => {
      try {
        const job = JSON.parse(event.data) as SniperJob;
        if (job.id) {
          setJobs((prev) => {
            const next = new Map(prev);
            next.set(job.id, job);
            return next;
          });
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sniper");
      const data = await res.json();
      if (Array.isArray(data.jobs)) {
        setJobs(() => {
          const next = new Map<string, SniperJob>();
          for (const j of data.jobs) {
            next.set(j.id, j);
          }
          return next;
        });
      }
    } catch {
      // ignore
    }
  }, []);

  return {
    jobs: Array.from(jobs.values()),
    connected,
    refresh,
  };
}
