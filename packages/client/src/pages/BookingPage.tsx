import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useBookingEvents } from "../hooks/useBookingEvents";
import { createBooking, cancelBooking } from "../services/api";
import type { BookingState } from "../types/index.js";

const STATUS_STYLES: Record<string, string> = {
  idle: "bg-stone-700 text-stone-300",
  scheduled: "bg-blue-900/50 text-blue-300",
  waiting: "bg-amber-900/50 text-amber-300",
  attempting: "bg-yellow-900/50 text-yellow-200 animate-pulse",
  "in-cart": "bg-emerald-900/50 text-emerald-300",
  succeeded: "bg-emerald-800/50 text-emerald-200",
  failed: "bg-red-900/50 text-red-300",
  cancelled: "bg-stone-600 text-stone-400",
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
          <h1 className="text-3xl font-bold text-stone-100">Booking</h1>
          <p className="text-stone-400 mt-1">
            Configure and monitor automated permit booking attempts.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div
            className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-400"}`}
          />
          <span className="text-stone-500">
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        {/* Booking form */}
        <div>
          <h2 className="text-lg font-semibold mb-4 text-stone-200">New Booking Attempt</h2>
          <form
            onSubmit={handleSubmit}
            className="bg-stone-800 border border-stone-700 rounded-lg p-6 space-y-4"
          >
            {/* Permit ID */}
            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Permit ID
              </label>
              <input
                type="text"
                value={permitId}
                onChange={(e) => setPermitId(e.target.value)}
                placeholder="e.g. 4675311"
                required
                className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-900 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <p className="text-xs text-stone-500 mt-1">
                The permit facility ID from recreation.gov
              </p>
            </div>

            {/* Entrance ID */}
            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Entrance / Entry Point ID
              </label>
              <input
                type="text"
                value={entranceId}
                onChange={(e) => setEntranceId(e.target.value)}
                placeholder="e.g. 12345"
                required
                className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-900 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>

            {/* Date */}
            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Desired Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-900 text-stone-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>

            {/* Group size */}
            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Group Size
              </label>
              <input
                type="number"
                min="1"
                max="12"
                value={groupSize}
                onChange={(e) => setGroupSize(e.target.value)}
                required
                className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-900 text-stone-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>

            {/* Divider */}
            <hr className="border-stone-700" />

            {/* Recreation.gov credentials */}
            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Recreation.gov Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your-email@example.com"
                required
                className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-900 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Recreation.gov Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                required
                className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-900 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <p className="text-xs text-stone-500 mt-1">
                Credentials are only held in memory and never persisted to disk.
              </p>
            </div>

            {/* Divider */}
            <hr className="border-stone-200" />

            {/* Scheduling */}
            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Scheduled Start Time (optional)
              </label>
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-900 text-stone-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <p className="text-xs text-stone-500 mt-1">
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
              <label htmlFor="headless" className="text-sm text-stone-300">
                Run headless (no visible browser window)
              </label>
            </div>

            {/* Error */}
            {formError && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-200 text-sm">
                {formError}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Starting..." : "Start Booking Attempt"}
            </button>
          </form>
        </div>

        {/* Active bookings */}
        <div>
          <h2 className="text-lg font-semibold mb-4 text-stone-200">Active Bookings</h2>

          {bookings.length === 0 ? (
            <div className="bg-stone-800 border border-stone-700 rounded-lg p-6 text-center text-stone-400 text-sm">
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
    <div className="bg-stone-800 border border-stone-700 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <span
            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusStyle}`}
          >
            {booking.status}
          </span>
          <p className="text-xs text-stone-500 mt-1">
            ID: {booking.id.slice(0, 8)}...
          </p>
        </div>
        {isActive && (
          <button
            onClick={() => onCancel(booking.id)}
            className="text-xs px-3 py-1 bg-red-900/50 text-red-300 rounded-lg hover:bg-red-800/50 transition"
          >
            Cancel
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <div>
          <span className="text-stone-500">Permit:</span>{" "}
          <span className="text-stone-300">{booking.permitId}</span>
        </div>
        <div>
          <span className="text-stone-500">Entrance:</span>{" "}
          <span className="text-stone-300">{booking.entranceId}</span>
        </div>
        <div>
          <span className="text-stone-500">Date:</span>{" "}
          <span className="text-stone-300">{booking.date}</span>
        </div>
        <div>
          <span className="text-stone-500">Group:</span>{" "}
          <span className="text-stone-300">{booking.groupSize}</span>
        </div>
        <div>
          <span className="text-stone-500">Attempts:</span>{" "}
          <span className="text-stone-300">{booking.attempts}</span>
        </div>
        {booking.startAt && (
          <div>
            <span className="text-stone-500">Scheduled:</span>{" "}
            <span className="text-stone-300">
              {new Date(booking.startAt).toLocaleString()}
            </span>
          </div>
        )}
      </div>

      <div className="bg-stone-900 rounded p-2">
        <p className="text-xs text-stone-300">{booking.message}</p>
      </div>

      {booking.lastAttemptAt && (
        <p className="text-xs text-stone-500 mt-2">
          Last attempt: {new Date(booking.lastAttemptAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
