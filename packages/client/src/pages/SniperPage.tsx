import { useState, useEffect, useCallback, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  createSniperJob,
  deleteSniperJob,
  supplySniperCredentials,
  fetchPermits,
} from "../services/api";
import { useSniperEvents } from "../hooks/useSniperEvents";
import type { SniperJob, SniperStatus, PermitSummary, DateRange } from "../types/index";

// ---- Status styling ----

const statusConfig: Record<
  SniperStatus,
  { label: string; color: string; bg: string }
> = {
  pending: {
    label: "Pending",
    color: "text-stone-700",
    bg: "bg-stone-100",
  },
  "pre-warming": {
    label: "Pre-Warming",
    color: "text-blue-700",
    bg: "bg-blue-50",
  },
  watching: {
    label: "Watching",
    color: "text-amber-700",
    bg: "bg-amber-50",
  },
  booking: {
    label: "Booking",
    color: "text-purple-700",
    bg: "bg-purple-50",
  },
  "in-cart": {
    label: "In Cart!",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
  },
  failed: {
    label: "Failed",
    color: "text-red-700",
    bg: "bg-red-50",
  },
  cancelled: {
    label: "Cancelled",
    color: "text-stone-500",
    bg: "bg-stone-50",
  },
};

// ---- Helper: format countdown ----

function formatCountdown(isoDate: string): string {
  const diff = new Date(isoDate).getTime() - Date.now();
  if (diff <= 0) return "Now";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ---- Main page ----

export default function SniperPage() {
  const { jobs, connected } = useSniperEvents();
  const [searchParams] = useSearchParams();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-stone-800">Permit Sniper</h1>
        <p className="mt-2 text-stone-600">
          Configure a sniper job to automatically book a permit the instant
          availability opens. The bot will sign in 2 minutes early, then poll
          for availability every 1.5 seconds. The moment a slot opens, it books
          your highest-priority available date.
        </p>
      </div>

      <SniperForm
        defaultPermitId={searchParams.get("permitId") || ""}
        defaultPermitName={searchParams.get("permitName") || ""}
        defaultDivisionId={searchParams.get("divisionId") || ""}
      />

      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-stone-800">Active Jobs</h2>
          <span
            className={`text-xs px-2 py-1 rounded-full ${
              connected
                ? "bg-emerald-100 text-emerald-700"
                : "bg-red-100 text-red-700"
            }`}
          >
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>

        {jobs.length === 0 ? (
          <div className="text-center py-12 bg-stone-50 rounded-lg border border-stone-200">
            <p className="text-stone-500">
              No sniper jobs yet. Create one above.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {jobs
              .sort(
                (a, b) =>
                  new Date(b.createdAt).getTime() -
                  new Date(a.createdAt).getTime(),
              )
              .map((job) => (
                <SniperJobCard key={job.id} job={job} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Configuration Form ----

function SniperForm({
  defaultPermitId,
  defaultPermitName,
  defaultDivisionId,
}: {
  defaultPermitId: string;
  defaultPermitName: string;
  defaultDivisionId: string;
}) {
  const [permitId, setPermitId] = useState(defaultPermitId);
  const [permitName, setPermitName] = useState(defaultPermitName);
  const [divisionId, setDivisionId] = useState(defaultDivisionId);
  const [desiredRanges, setDesiredRanges] = useState<DateRange[]>([
    { startDate: "", endDate: "" },
  ]);
  const [groupSize, setGroupSize] = useState(1);
  const [windowOpensAt, setWindowOpensAt] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [permits, setPermits] = useState<PermitSummary[]>([]);
  const [loadingPermits, setLoadingPermits] = useState(false);
  const [divisions, setDivisions] = useState<
    { id: string; name: string }[]
  >([]);
  const [loadingDivisions, setLoadingDivisions] = useState(false);

  // Load permits list for the dropdown
  useEffect(() => {
    setLoadingPermits(true);
    fetchPermits()
      .then((p) => setPermits(p))
      .catch(() => {})
      .finally(() => setLoadingPermits(false));
  }, []);

  // Fetch divisions when permitId changes (proxied through our API)
  const loadDivisions = useCallback(async (pid: string) => {
    if (!pid) {
      setDivisions([]);
      return;
    }
    setLoadingDivisions(true);
    try {
      const res = await fetch(`/api/permits/${pid}/divisions`);
      if (res.ok) {
        const data = await res.json();
        const payload = data.payload;
        const divs: { id: string; name: string }[] = [];

        if (Array.isArray(payload)) {
          for (const d of payload) {
            divs.push({
              id: d.division_id || d.id || String(d),
              name: d.name || d.division_name || `Division ${d.division_id || d.id}`,
            });
          }
        } else if (payload && typeof payload === "object") {
          for (const [id, val] of Object.entries(payload)) {
            const v = val as Record<string, unknown>;
            divs.push({
              id,
              name: (v.name as string) || (v.division_name as string) || `Division ${id}`,
            });
          }
        }

        setDivisions(divs);
      }
    } catch {
      setDivisions([]);
    } finally {
      setLoadingDivisions(false);
    }
  }, []);

  useEffect(() => {
    if (permitId) {
      loadDivisions(permitId);
    }
  }, [permitId, loadDivisions]);

  // Handle permit selection
  const handlePermitChange = (fid: string) => {
    setPermitId(fid);
    const match = permits.find((p) => p.facilityId === fid);
    setPermitName(match?.name || "");
    setDivisionId("");
  };

  // Date range list management
  const addRange = () =>
    setDesiredRanges((r) => [...r, { startDate: "", endDate: "" }]);
  const removeRange = (index: number) =>
    setDesiredRanges((r) => r.filter((_, i) => i !== index));
  const updateRange = (
    index: number,
    field: "startDate" | "endDate",
    value: string,
  ) =>
    setDesiredRanges((r) =>
      r.map((v, i) => (i === index ? { ...v, [field]: value } : v)),
    );
  const moveRange = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= desiredRanges.length) return;
    setDesiredRanges((r) => {
      const copy = [...r];
      [copy[index], copy[newIndex]] = [copy[newIndex], copy[index]];
      return copy;
    });
  };

  // Helper: compute number of nights for a range
  const getNights = (range: DateRange): number | null => {
    if (!range.startDate || !range.endDate) return null;
    const start = new Date(range.startDate + "T00:00:00");
    const end = new Date(range.endDate + "T00:00:00");
    const diff = Math.round(
      (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
    );
    return diff > 0 ? diff : null;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const filteredRanges = desiredRanges.filter(
      (r) => r.startDate && r.endDate,
    );
    if (filteredRanges.length === 0) {
      setError("Add at least one desired date range.");
      return;
    }
    for (const r of filteredRanges) {
      if (r.endDate <= r.startDate) {
        setError(
          `End date must be after start date (${r.startDate} to ${r.endDate}).`,
        );
        return;
      }
    }
    if (!permitId) {
      setError("Select a permit.");
      return;
    }
    if (!divisionId) {
      setError("Select a division/entrance.");
      return;
    }
    if (!windowOpensAt) {
      setError("Set the window opening time.");
      return;
    }
    if (!email || !password) {
      setError("Recreation.gov credentials are required.");
      return;
    }

    setSubmitting(true);
    try {
      const job = await createSniperJob({
        permitId,
        permitName,
        divisionId,
        desiredDateRanges: filteredRanges,
        groupSize,
        windowOpensAt: new Date(windowOpensAt).toISOString(),
        email,
        password,
      });
      setSuccess(`Sniper job created! ID: ${job.id.slice(0, 8)}...`);
      // Reset form
      setDesiredRanges([{ startDate: "", endDate: "" }]);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create job");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-xl shadow-sm border border-stone-200 p-6 space-y-6"
    >
      <h2 className="text-xl font-semibold text-stone-800">
        Configure Sniper Job
      </h2>

      {/* Permit selection */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">
            Permit
          </label>
          <select
            value={permitId}
            onChange={(e) => handlePermitChange(e.target.value)}
            className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            disabled={loadingPermits}
          >
            <option value="">
              {loadingPermits ? "Loading permits..." : "Select a permit..."}
            </option>
            {permits.map((p) => (
              <option key={p.facilityId} value={p.facilityId}>
                {p.name}
              </option>
            ))}
          </select>
          {permitId && (
            <p className="mt-1 text-xs text-stone-500">ID: {permitId}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">
            Division / Entrance
          </label>
          <select
            value={divisionId}
            onChange={(e) => setDivisionId(e.target.value)}
            className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            disabled={!permitId || loadingDivisions}
          >
            <option value="">
              {loadingDivisions
                ? "Loading..."
                : !permitId
                  ? "Select a permit first"
                  : "Select a division..."}
            </option>
            {divisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          {!permitId && divisions.length === 0 && (
            <p className="mt-1 text-xs text-stone-500">
              Or enter a division ID manually:
            </p>
          )}
          {permitId && divisions.length === 0 && !loadingDivisions && (
            <input
              type="text"
              placeholder="Division ID"
              value={divisionId}
              onChange={(e) => setDivisionId(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            />
          )}
        </div>
      </div>

      {/* Desired date ranges */}
      <div>
        <label className="block text-sm font-medium text-stone-700 mb-2">
          Desired Date Ranges (in priority order)
        </label>
        <p className="text-xs text-stone-500 mb-2">
          Each range is a trip: entry date to exit date. First range is highest
          priority. If #1 isn't fully available, the bot tries #2, etc.
        </p>
        <div className="space-y-3">
          {desiredRanges.map((range, i) => {
            const nights = getNights(range);
            return (
              <div
                key={i}
                className="flex items-center gap-2 p-3 bg-stone-50 rounded-lg border border-stone-200"
              >
                <span className="w-6 text-center text-xs text-stone-400 font-mono shrink-0">
                  #{i + 1}
                </span>
                <div className="flex-1 grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">
                      Entry date
                    </label>
                    <input
                      type="date"
                      value={range.startDate}
                      onChange={(e) =>
                        updateRange(i, "startDate", e.target.value)
                      }
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">
                      Exit date
                    </label>
                    <input
                      type="date"
                      value={range.endDate}
                      onChange={(e) =>
                        updateRange(i, "endDate", e.target.value)
                      }
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    />
                  </div>
                </div>
                {nights !== null && (
                  <span className="text-xs text-emerald-600 font-medium shrink-0 w-16 text-center">
                    {nights} night{nights !== 1 ? "s" : ""}
                  </span>
                )}
                {range.startDate &&
                  range.endDate &&
                  range.endDate <= range.startDate && (
                    <span className="text-xs text-red-500 shrink-0">
                      Invalid
                    </span>
                  )}
                <div className="flex flex-col gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => moveRange(i, -1)}
                    disabled={i === 0}
                    className="p-0.5 text-stone-400 hover:text-stone-600 disabled:opacity-30"
                    title="Move up"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 15l7-7 7 7"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveRange(i, 1)}
                    disabled={i === desiredRanges.length - 1}
                    className="p-0.5 text-stone-400 hover:text-stone-600 disabled:opacity-30"
                    title="Move down"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                </div>
                {desiredRanges.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRange(i)}
                    className="p-1 text-red-400 hover:text-red-600 shrink-0"
                    title="Remove"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={addRange}
          className="mt-2 text-sm text-emerald-600 hover:text-emerald-700 font-medium"
        >
          + Add another date range
        </button>
      </div>

      {/* Group size + Window opens at */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">
            Group Size
          </label>
          <input
            type="number"
            min={1}
            max={30}
            value={groupSize}
            onChange={(e) => setGroupSize(Number(e.target.value))}
            className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">
            Window Opens At
          </label>
          <input
            type="datetime-local"
            value={windowOpensAt}
            onChange={(e) => setWindowOpensAt(e.target.value)}
            className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
          />
          <p className="mt-1 text-xs text-stone-500">
            When permits become available to reserve (your local time).
          </p>
          {/* Presets */}
          <div className="flex gap-2 mt-2 flex-wrap">
            {[
              {
                label: "Apr 1, 7 AM PDT",
                value: "2026-04-01T07:00",
              },
              {
                label: "Apr 1, 10 AM EDT",
                value: "2026-04-01T10:00",
              },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setWindowOpensAt(preset.value)}
                className="text-xs px-2 py-1 bg-stone-100 hover:bg-stone-200 rounded text-stone-600"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Credentials */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">
            Recreation.gov Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your-email@example.com"
            className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
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
            placeholder="your-password"
            className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
          />
        </div>
      </div>

      <p className="text-xs text-stone-500 bg-amber-50 border border-amber-200 rounded-lg p-3">
        <strong>Security note:</strong> Credentials are stored only in server
        memory and are never saved to disk. After a server restart, you will
        need to re-enter them for pending jobs.
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-700">
          {success}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-3 bg-emerald-700 hover:bg-emerald-800 text-white font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? "Creating..." : "Create Sniper Job"}
      </button>
    </form>
  );
}

// ---- Job Card ----

function SniperJobCard({ job }: { job: SniperJob }) {
  const [deleting, setDeleting] = useState(false);
  const [showCredForm, setShowCredForm] = useState(false);
  const [countdown, setCountdown] = useState(
    formatCountdown(job.windowOpensAt),
  );

  // Live countdown timer
  useEffect(() => {
    if (
      job.status !== "pending" &&
      job.status !== "pre-warming"
    ) return;

    const interval = setInterval(() => {
      setCountdown(formatCountdown(job.windowOpensAt));
    }, 1000);
    return () => clearInterval(interval);
  }, [job.status, job.windowOpensAt]);

  const config = statusConfig[job.status] || statusConfig.pending;

  const isActive =
    job.status === "pending" ||
    job.status === "pre-warming" ||
    job.status === "watching" ||
    job.status === "booking";

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteSniperJob(job.id);
    } catch {
      /* ignore */
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className={`rounded-xl border shadow-sm overflow-hidden ${
        job.status === "in-cart"
          ? "border-emerald-300 bg-emerald-50/50"
          : job.status === "failed"
            ? "border-red-200 bg-red-50/30"
            : "border-stone-200 bg-white"
      }`}
    >
      <div className="p-5">
        {/* Header row */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-stone-800">
              {job.permitName || `Permit ${job.permitId}`}
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Job {job.id.slice(0, 8)} &middot; Division {job.divisionId}
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full ${config.bg} ${config.color}`}
          >
            {config.label}
          </span>
        </div>

        {/* Status message */}
        <p className="text-sm text-stone-600 mb-3">{job.message}</p>

        {/* Info grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div className="col-span-2 md:col-span-1">
            <span className="text-stone-500 text-xs block">Date Ranges</span>
            <div className="flex flex-col gap-1 mt-0.5">
              {job.desiredDateRanges.map((r, i) => {
                const isBooked =
                  job.bookedRange &&
                  r.startDate === job.bookedRange.startDate &&
                  r.endDate === job.bookedRange.endDate;
                return (
                  <span
                    key={`${r.startDate}-${r.endDate}`}
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      isBooked
                        ? "bg-emerald-200 text-emerald-800 font-medium"
                        : "bg-stone-100 text-stone-600"
                    }`}
                  >
                    {i + 1}. {r.startDate} to {r.endDate}
                  </span>
                );
              })}
            </div>
          </div>

          <div>
            <span className="text-stone-500 text-xs block">Group Size</span>
            <span className="font-medium">{job.groupSize}</span>
          </div>

          <div>
            <span className="text-stone-500 text-xs block">Window Opens</span>
            <span className="font-medium">
              {new Date(job.windowOpensAt).toLocaleString()}
            </span>
            {isActive && (
              <span className="text-xs text-amber-600 block">{countdown}</span>
            )}
          </div>

          <div>
            <span className="text-stone-500 text-xs block">Polls</span>
            <span className="font-medium">{job.attempts}</span>
          </div>
        </div>

        {/* Booked range */}
        {job.bookedRange && (
          <div className="mt-3 bg-emerald-100 text-emerald-800 text-sm font-medium rounded-lg p-3">
            Booked: {job.bookedRange.startDate} to {job.bookedRange.endDate}{" "}
            &mdash; Complete your purchase on recreation.gov!
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-4">
          {isActive && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-sm bg-red-50 text-red-700 hover:bg-red-100 rounded-lg transition disabled:opacity-50"
            >
              {deleting ? "Cancelling..." : "Cancel"}
            </button>
          )}

          {!isActive &&
            job.status !== "in-cart" && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1.5 text-sm bg-stone-100 text-stone-600 hover:bg-stone-200 rounded-lg transition disabled:opacity-50"
              >
                {deleting ? "Removing..." : "Remove"}
              </button>
            )}

          {job.status === "pending" && (
            <button
              onClick={() => setShowCredForm(!showCredForm)}
              className="px-3 py-1.5 text-sm bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-lg transition"
            >
              Re-enter Credentials
            </button>
          )}
        </div>

        {/* Credential re-entry form */}
        {showCredForm && (
          <CredentialForm
            jobId={job.id}
            onDone={() => setShowCredForm(false)}
          />
        )}
      </div>
    </div>
  );
}

// ---- Credential re-entry form ----

function CredentialForm({
  jobId,
  onDone,
}: {
  jobId: string;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Both fields are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await supplySniperCredentials(jobId, email, password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2"
    >
      <p className="text-xs text-amber-700">
        Credentials were lost after server restart. Re-enter to activate this
        job.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="px-2 py-1.5 text-sm border border-amber-300 rounded focus:ring-1 focus:ring-amber-500"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="px-2 py-1.5 text-sm border border-amber-300 rounded focus:ring-1 focus:ring-amber-500"
        />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
        >
          {submitting ? "Saving..." : "Save Credentials"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-3 py-1 text-xs bg-stone-200 text-stone-600 rounded hover:bg-stone-300"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
