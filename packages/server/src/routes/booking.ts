import { Router } from "express";
import type { BookingRequest } from "../types/index.js";
import {
  startBooking,
  cancelBooking,
  getBookings,
  getBooking,
  subscribeToBookingUpdates,
} from "../services/booking.js";

const router = Router();

/**
 * POST /api/booking
 * Start a new booking attempt.
 */
router.post("/", async (req, res) => {
  try {
    const body = req.body as Partial<BookingRequest>;

    // Validate required fields
    if (!body.permitId || !body.entranceId || !body.date || !body.groupSize) {
      res.status(400).json({
        error:
          "Missing required fields: permitId, entranceId, date, groupSize",
      });
      return;
    }
    if (!body.email || !body.password) {
      res.status(400).json({
        error:
          "Missing required fields: email, password (recreation.gov credentials)",
      });
      return;
    }

    const request: BookingRequest = {
      permitId: body.permitId,
      entranceId: body.entranceId,
      date: body.date,
      groupSize: body.groupSize,
      email: body.email,
      password: body.password,
      startAt: body.startAt,
      headless: body.headless,
    };

    const booking = await startBooking(request);
    res.json({ booking });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[booking] Error starting booking:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/booking/status
 * Get all active booking states.
 */
router.get("/status", (_req, res) => {
  res.json({ bookings: getBookings() });
});

/**
 * GET /api/booking/:bookingId
 * Get a specific booking state.
 */
router.get("/:bookingId", (req, res) => {
  const { bookingId } = req.params;
  const booking = getBooking(bookingId);
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  res.json({ booking });
});

/**
 * DELETE /api/booking/:bookingId
 * Cancel a booking attempt.
 */
router.delete("/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;
    const cancelled = await cancelBooking(bookingId);
    if (!cancelled) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }
    res.json({ cancelled: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/booking/events
 * Server-Sent Events stream for real-time booking status updates.
 */
router.get("/events/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial state
  const bookings = getBookings();
  res.write(`data: ${JSON.stringify({ type: "init", bookings })}\n\n`);

  // Subscribe to updates
  const unsubscribe = subscribeToBookingUpdates((state) => {
    res.write(`data: ${JSON.stringify({ type: "update", booking: state })}\n\n`);
  });

  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export { router as bookingRoutes };
