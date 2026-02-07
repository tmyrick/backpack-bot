import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useBookingEvents } from "../hooks/useBookingEvents";
import { createBooking, cancelBooking } from "../services/api";
import type { BookingState } from "../types/index.js";

const STATUS_STYLES: Record<string, string> = {
  idle: "bg-stone-100 text-stone-600",
  scheduled: "bg-blue-100 text-blue-700",
  waiting: "bg-amber-100 text-amber-700",
  attempting: "bg-yellow-100 text-yellow-800 animate-pulse",
  "in-cart": "bg-emerald-100 text-emerald-800",
  succeeded: "bg-emerald-200 text-emerald-900",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-stone-200 text-stone-500",
};

export default function BookingPage() {
  const [searchParams] = useSearchParams();
  const { bookings, connected } = useBookingEvents();

  // Form state (pre-filled from query params if coming from availability calendar)
  const [permitId, setPermitId] = useState(
    searchParams.get("permitId") || "",
  );
  const [entranceId, setEntranceId] = useState(
    searchParams.get("entranceId") || "",
  );
  const [date, setDate] = useState(searchParams.get("date") || "");
  const [groupSize, setGroupSize] = useState("1");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [startAt, setStartAt] = useState("");
  const [headless, setHeadless] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);

    try {
      await createBooking({
        permitId,
        entranceId,
        date,
        groupSize: parseInt(groupSize, 10),
        email,
        password,
        startAt: startAt || undefined,
        headless,
      });
      // Clear sensitive fields after submission
      setPassword("");
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to start booking",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (bookingId: string) => {
    try {
      await cancelBooking(bookingId);
    } catch {
      // ignore
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Booking</h1>
          <p className="text-stone-500 mt-1">
            Configure and monitor automated permit booking attempts.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div
            className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-400"}`}
          />
          <span className="text-stone-400">
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        {/* Booking form */}
        <div>
          <h2 className="text-lg font-semibold mb-4">New Booking Attempt</h2>
          <form
            onSubmit={handleSubmit}
            className="bg-white border border-stone-200 rounded-lg p-6 space-y-4"
          >
            {/* Permit ID */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Permit ID
              </label>
              <input
                type="text"
                value={permitId}
                onChange={(e) => setPermitId(e.target.value)}
                placeholder="e.g. 4675311"
                required
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <p className="text-xs text-stone-400 mt-1">
                The permit facility ID from recreation.gov
              </p>
            </div>

            {/* Entrance ID */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Entrance / Entry Point ID
              </label>
              <input
                type="text"
                value={entranceId}
                onChange={(e) => setEntranceId(e.target.value)}
                placeholder="e.g. 12345"
                required
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>

            {/* Date */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Desired Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>

            {/* Group size */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Group Size
              </label>
              <input
                type="number"
                min="1"
                max="12"
                value={groupSize}
                onChange={(e) => setGroupSize(e.target.value)}
                required
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>

            {/* Divider */}
            <hr className="border-stone-200" />

            {/* Recreation.gov credentials */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Recreation.gov Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your-email@example.com"
                required
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Recreation.gov Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                required
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <p className="text-xs text-stone-400 mt-1">
                Credentials are only held in memory and never persisted to disk.
              </p>
            </div>

            {/* Divider */}
            <hr className="border-stone-200" />

            {/* Scheduling */}
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                Scheduled Start Time (optional)
              </label>
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <p className="text-xs text-stone-400 mt-1">
                Schedule the bot to start attempting at a specific time (e.g.,
                when the booking window opens). Leave empty to start
                immediately.
              </p>
            </div>

            {/* Headless toggle */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="headless"
                checked={headless}
                onChange={(e) => setHeadless(e.target.checked)}
                className="rounded border-stone-300 text-emerald-600 focus:ring-emerald-500"
              />
              <label htmlFor="headless" className="text-sm text-stone-700">
                Run headless (no visible browser window)
              </label>
            </div>

            {/* Error */}
            {formError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-800 text-sm">
                {formError}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Starting..." : "Start Booking Attempt"}
            </button>
          </form>
        </div>

        {/* Active bookings */}
        <div>
          <h2 className="text-lg font-semibold mb-4">Active Bookings</h2>

          {bookings.length === 0 ? (
            <div className="bg-stone-50 border border-stone-200 rounded-lg p-6 text-center text-stone-500 text-sm">
              No active booking attempts. Configure one using the form.
            </div>
          ) : (
            <div className="space-y-3">
              {bookings.map((booking) => (
                <BookingCard
                  key={booking.id}
                  booking={booking}
                  onCancel={handleCancel}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BookingCard({
  booking,
  onCancel,
}: {
  booking: BookingState;
  onCancel: (id: string) => void;
}) {
  const isActive = ["scheduled", "waiting", "attempting"].includes(
    booking.status,
  );
  const statusStyle = STATUS_STYLES[booking.status] || STATUS_STYLES.idle;

  return (
    <div className="bg-white border border-stone-200 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <span
            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusStyle}`}
          >
            {booking.status}
          </span>
          <p className="text-xs text-stone-400 mt-1">
            ID: {booking.id.slice(0, 8)}...
          </p>
        </div>
        {isActive && (
          <button
            onClick={() => onCancel(booking.id)}
            className="text-xs px-3 py-1 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition"
          >
            Cancel
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <div>
          <span className="text-stone-400">Permit:</span>{" "}
          <span className="text-stone-700">{booking.permitId}</span>
        </div>
        <div>
          <span className="text-stone-400">Entrance:</span>{" "}
          <span className="text-stone-700">{booking.entranceId}</span>
        </div>
        <div>
          <span className="text-stone-400">Date:</span>{" "}
          <span className="text-stone-700">{booking.date}</span>
        </div>
        <div>
          <span className="text-stone-400">Group:</span>{" "}
          <span className="text-stone-700">{booking.groupSize}</span>
        </div>
        <div>
          <span className="text-stone-400">Attempts:</span>{" "}
          <span className="text-stone-700">{booking.attempts}</span>
        </div>
        {booking.startAt && (
          <div>
            <span className="text-stone-400">Scheduled:</span>{" "}
            <span className="text-stone-700">
              {new Date(booking.startAt).toLocaleString()}
            </span>
          </div>
        )}
      </div>

      <div className="bg-stone-50 rounded p-2">
        <p className="text-xs text-stone-600">{booking.message}</p>
      </div>

      {booking.lastAttemptAt && (
        <p className="text-xs text-stone-400 mt-2">
          Last attempt: {new Date(booking.lastAttemptAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
