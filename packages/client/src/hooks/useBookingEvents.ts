import { useState, useEffect, useRef, useCallback } from "react";
import type { BookingState } from "../types/index.js";

/**
 * Hook that subscribes to the booking SSE stream and maintains
 * a live map of booking states.
 */
export function useBookingEvents() {
  const [bookings, setBookings] = useState<Map<string, BookingState>>(
    new Map(),
  );
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/booking/events/stream");
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "init" && Array.isArray(data.bookings)) {
          setBookings((prev) => {
            const next = new Map(prev);
            for (const b of data.bookings as BookingState[]) {
              next.set(b.id, b);
            }
            return next;
          });
        } else if (data.type === "update" && data.booking) {
          setBookings((prev) => {
            const next = new Map(prev);
            next.set(data.booking.id, data.booking as BookingState);
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
      const res = await fetch("/api/booking/status");
      const data = await res.json();
      if (Array.isArray(data.bookings)) {
        setBookings(() => {
          const next = new Map<string, BookingState>();
          for (const b of data.bookings) {
            next.set(b.id, b);
          }
          return next;
        });
      }
    } catch {
      // ignore
    }
  }, []);

  return {
    bookings: Array.from(bookings.values()),
    connected,
    refresh,
  };
}
