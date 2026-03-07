import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  createSniperJob,
  deleteSniperJob,
  fetchPermits,
  fetchCampgrounds,
  fetchCampsites,
} from "../services/api";
import { useSniperEvents } from "../hooks/useSniperEvents";
import SearchableSelect from "../components/SearchableSelect";
import type { SniperJob, SniperStatus, BookingType, PermitSummary, CampgroundSummary, CampsiteSummary, DateRange } from "../types/index";

// ---- Status styling ----

const statusConfig: Record<
  SniperStatus,
  { label: string; color: string; bg: string }
> = {
  pending: {
    label: "Pending",
    color: "text-stone-300",
    bg: "bg-stone-700",
  },
  "pre-warming": {
    label: "Pre-Warming",
    color: "text-blue-300",
    bg: "bg-blue-900/50",
  },
  watching: {
    label: "Watching",
    color: "text-amber-300",
    bg: "bg-amber-900/50",
  },
  booking: {
    label: "Booking",
    color: "text-purple-300",
    bg: "bg-purple-900/50",
  },
  "in-cart": {
    label: "In Cart!",
    color: "text-emerald-300",
    bg: "bg-emerald-900/50",
  },
  failed: {
    label: "Failed",
    color: "text-red-300",
    bg: "bg-red-900/50",
  },
  cancelled: {
    label: "Cancelled",
    color: "text-stone-400",
    bg: "bg-stone-700",
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
        <h1 className="text-3xl font-bold text-stone-100">Sniper</h1>
        <p className="mt-2 text-stone-400">
          Configure a sniper job to automatically book a permit or campsite the
          instant availability opens. The bot will sign in 2 minutes early, then
          poll for availability every 1 second. The moment a slot opens, it
          books your highest-priority available date.
        </p>
      </div>

      <SniperForm
        defaultPermitId={searchParams.get("permitId") || ""}
        defaultPermitName={searchParams.get("permitName") || ""}
        defaultDivisionId={searchParams.get("divisionId") || ""}
      />

      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-stone-200">Active Jobs</h2>
          <span
            className={`text-xs px-2 py-1 rounded-full ${
              connected
                ? "bg-emerald-900/50 text-emerald-300"
                : "bg-red-900/50 text-red-300"
            }`}
          >
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>

        {jobs.length === 0 ? (
          <div className="text-center py-12 bg-stone-800 rounded-lg border border-stone-700">
            <p className="text-stone-400">
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

const selectClasses = "w-full px-3 py-2 border border-stone-600 rounded-lg bg-stone-900 text-stone-100 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500";
const inputClasses = selectClasses;

function SniperForm({
  defaultPermitId,
  defaultPermitName,
  defaultDivisionId,
}: {
  defaultPermitId: string;
  defaultPermitName: string;
  defaultDivisionId: string;
}) {
  // ---- Top-level selectors ----
  const [state, setState] = useState("OR");
  const [bookingType, setBookingType] = useState<BookingType>("permit");

  // ---- Permit fields ----
  const [permitId, setPermitId] = useState(defaultPermitId);
  const [permitName, setPermitName] = useState(defaultPermitName);
  const [divisionId, setDivisionId] = useState(defaultDivisionId);
  const [permits, setPermits] = useState<PermitSummary[]>([]);
  const [loadingPermits, setLoadingPermits] = useState(false);
  const [divisions, setDivisions] = useState<{ id: string; name: string }[]>([]);
  const [loadingDivisions, setLoadingDivisions] = useState(false);

  // ---- Campsite fields ----
  const [campgroundId, setCampgroundId] = useState("");
  const [campgroundName, setCampgroundName] = useState("");
  const [campgroundIsPermit, setCampgroundIsPermit] = useState(false);
  const [campsiteId, setCampsiteId] = useState("");
  const [campgrounds, setCampgrounds] = useState<CampgroundSummary[]>([]);
  const [loadingCampgrounds, setLoadingCampgrounds] = useState(false);
  const [campsitesList, setCampsitesList] = useState<CampsiteSummary[]>([]);
  const [loadingCampsites, setLoadingCampsites] = useState(false);

  // ---- Common fields ----
  const [desiredRanges, setDesiredRanges] = useState<DateRange[]>([
    { startDate: "", endDate: "" },
  ]);
  const [groupSize, setGroupSize] = useState(1);
  const [windowOpensAt, setWindowOpensAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ---- Load permits when state changes ----
  useEffect(() => {
    if (bookingType !== "permit") return;
    setLoadingPermits(true);
    setPermitId("");
    setPermitName("");
    setDivisionId("");
    fetchPermits(state)
      .then((p) => setPermits(p))
      .catch(() => setPermits([]))
      .finally(() => setLoadingPermits(false));
  }, [state, bookingType]);

  // ---- Load campgrounds when state changes ----
  useEffect(() => {
    if (bookingType !== "campsite") return;
    setLoadingCampgrounds(true);
    setCampgroundId("");
    setCampgroundName("");
    setCampsiteId("");
    fetchCampgrounds(state)
      .then((c) => setCampgrounds(c))
      .catch(() => setCampgrounds([]))
      .finally(() => setLoadingCampgrounds(false));
  }, [state, bookingType]);

  // ---- Load divisions for selected permit ----
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

  // ---- Load campsites for selected campground ----
  useEffect(() => {
    if (!campgroundId) {
      setCampsitesList([]);
      return;
    }
    setLoadingCampsites(true);
    fetchCampsites(campgroundId)
      .then((cs) => setCampsitesList(cs))
      .catch(() => setCampsitesList([]))
      .finally(() => setLoadingCampsites(false));
  }, [campgroundId]);

  // ---- Memoized option lists for SearchableSelect ----
  const permitOptions = useMemo(
    () =>
      [...permits]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ value: p.facilityId, label: p.name })),
    [permits],
  );

  const divisionOptions = useMemo(
    () => divisions.map((d) => ({ value: d.id, label: d.name })),
    [divisions],
  );

  const campgroundOptions = useMemo(
    () =>
      [...campgrounds]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({
          value: c.facilityId,
          label: c.isPermitFacility ? `${c.name} (permit)` : c.name,
        })),
    [campgrounds],
  );

  const campsiteOptions = useMemo(
    () =>
      campsitesList.map((cs) => ({
        value: cs.campsiteId,
        label: cs.campsiteName + (cs.loop ? ` (${cs.loop})` : ""),
      })),
    [campsitesList],
  );

  // ---- Handlers ----
  const handlePermitChange = (fid: string) => {
    setPermitId(fid);
    const match = permits.find((p) => p.facilityId === fid);
    setPermitName(match?.name || "");
    setDivisionId("");
  };

  const handleCampgroundChange = (fid: string) => {
    setCampgroundId(fid);
    const match = campgrounds.find((c) => c.facilityId === fid);
    setCampgroundName(match?.name || "");
    setCampgroundIsPermit(match?.isPermitFacility || false);
    setCampsiteId("");
  };

  // Date range management
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
    if (bookingType === "permit") {
      if (!permitId) { setError("Select a permit."); return; }
      if (!divisionId) { setError("Select a division/entrance."); return; }
    } else {
      if (!campgroundId) { setError("Select a campground."); return; }
    }
    if (!windowOpensAt) {
      setError("Set the window opening time.");
      return;
    }

    setSubmitting(true);
    try {
      const job = await createSniperJob({
        bookingType,
        ...(bookingType === "permit"
          ? { permitId, permitName, divisionId }
          : { campgroundId, campgroundName, campgroundIsPermit, campsiteId: campsiteId || undefined }),
        desiredDateRanges: filteredRanges,
        groupSize,
        windowOpensAt: new Date(windowOpensAt).toISOString(),
      });
      setSuccess(`Sniper job created! ID: ${job.id.slice(0, 8)}...`);
      setDesiredRanges([{ startDate: "", endDate: "" }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create job");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-stone-800 rounded-xl shadow-sm border border-stone-700 p-6 space-y-6"
    >
      <h2 className="text-xl font-semibold text-stone-200">
        Configure Sniper Job
      </h2>

      {/* State + Booking type */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-stone-300 mb-1">
            State
          </label>
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className={selectClasses}
          >
            <option value="OR">Oregon</option>
            <option value="WA">Washington</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-300 mb-1">
            Booking Type
          </label>
          <div className="flex rounded-lg overflow-hidden border border-stone-600">
            {(["permit", "campsite"] as BookingType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setBookingType(t)}
                className={`flex-1 px-4 py-2 text-sm font-medium transition ${
                  bookingType === t
                    ? "bg-emerald-600 text-white"
                    : "bg-stone-900 text-stone-400 hover:bg-stone-700 hover:text-stone-200"
                }`}
              >
                {t === "permit" ? "Permit" : "Campsite"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Permit selection */}
      {bookingType === "permit" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-stone-300 mb-1">
              Permit
            </label>
            <SearchableSelect
              options={permitOptions}
              value={permitId}
              onChange={handlePermitChange}
              placeholder="Select a permit..."
              loading={loadingPermits}
              loadingText="Loading permits..."
            />
            {permitId && (
              <p className="mt-1 text-xs text-stone-500">ID: {permitId}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-300 mb-1">
              Division / Entrance
            </label>
            <SearchableSelect
              options={divisionOptions}
              value={divisionId}
              onChange={setDivisionId}
              placeholder={!permitId ? "Select a permit first" : "Select a division..."}
              disabled={!permitId}
              loading={loadingDivisions}
              loadingText="Loading..."
            />
            {permitId && divisions.length === 0 && !loadingDivisions && (
              <input
                type="text"
                placeholder="Division ID"
                value={divisionId}
                onChange={(e) => setDivisionId(e.target.value)}
                className={`mt-1 ${inputClasses} text-sm placeholder-stone-500`}
              />
            )}
          </div>
        </div>
      )}

      {/* Campsite selection */}
      {bookingType === "campsite" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-stone-300 mb-1">
              Campground
            </label>
            <SearchableSelect
              options={campgroundOptions}
              value={campgroundId}
              onChange={handleCampgroundChange}
              placeholder="Select a campground..."
              loading={loadingCampgrounds}
              loadingText="Loading campgrounds..."
            />
            {campgroundId && (
              <p className="mt-1 text-xs text-stone-500">ID: {campgroundId}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-300 mb-1">
              Campsite (optional)
            </label>
            <SearchableSelect
              options={campsiteOptions}
              value={campsiteId}
              onChange={setCampsiteId}
              placeholder={!campgroundId ? "Select a campground first" : "Any available campsite"}
              disabled={!campgroundId}
              loading={loadingCampsites}
              loadingText="Loading..."
            />
            <p className="mt-1 text-xs text-stone-500">
              Leave empty to book any available site at this campground.
            </p>
          </div>
        </div>
      )}

      {/* Desired date ranges */}
      <div>
        <label className="block text-sm font-medium text-stone-300 mb-2">
          Desired Date Ranges (in priority order)
        </label>
        <p className="text-xs text-stone-500 mb-2">
          {bookingType === "permit"
            ? "Each range is a trip: entry date to exit date. First range is highest priority."
            : "Each range is a stay: check-in to check-out. First range is highest priority."}
          {" "}If #1 isn't fully available, the bot tries #2, etc.
        </p>
        <div className="space-y-3">
          {desiredRanges.map((range, i) => {
            const nights = getNights(range);
            return (
              <div
                key={i}
                className="flex items-center gap-2 p-3 bg-stone-900 rounded-lg border border-stone-700"
              >
                <span className="w-6 text-center text-xs text-stone-500 font-mono shrink-0">
                  #{i + 1}
                </span>
                <div className="flex-1 grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">
                      {bookingType === "permit" ? "Entry date" : "Check-in"}
                    </label>
                    <input
                      type="date"
                      value={range.startDate}
                      onChange={(e) =>
                        updateRange(i, "startDate", e.target.value)
                      }
                      className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-800 text-stone-100 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">
                      {bookingType === "permit" ? "Exit date" : "Check-out"}
                    </label>
                    <input
                      type="date"
                      value={range.endDate}
                      onChange={(e) =>
                        updateRange(i, "endDate", e.target.value)
                      }
                      className="w-full px-3 py-2 border border-stone-600 rounded-lg text-sm bg-stone-800 text-stone-100 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    />
                  </div>
                </div>
                {nights !== null && (
                  <span className="text-xs text-emerald-400 font-medium shrink-0 w-16 text-center">
                    {nights} night{nights !== 1 ? "s" : ""}
                  </span>
                )}
                {range.startDate &&
                  range.endDate &&
                  range.endDate <= range.startDate && (
                    <span className="text-xs text-red-400 shrink-0">
                      Invalid
                    </span>
                  )}
                <div className="flex flex-col gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => moveRange(i, -1)}
                    disabled={i === 0}
                    className="p-0.5 text-stone-500 hover:text-stone-300 disabled:opacity-30"
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
                    className="p-0.5 text-stone-500 hover:text-stone-300 disabled:opacity-30"
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
                    className="p-1 text-red-400 hover:text-red-300 shrink-0"
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
          className="mt-2 text-sm text-emerald-400 hover:text-emerald-300 font-medium"
        >
          + Add another date range
        </button>
      </div>

      {/* Group size + Window opens at */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-stone-300 mb-1">
            Group Size
          </label>
          <input
            type="number"
            min={1}
            max={30}
            value={groupSize}
            onChange={(e) => setGroupSize(Number(e.target.value))}
            className={inputClasses}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-300 mb-1">
            Window Opens At
          </label>
          <input
            type="datetime-local"
            value={windowOpensAt}
            onChange={(e) => setWindowOpensAt(e.target.value)}
            className={inputClasses}
          />
          <p className="mt-1 text-xs text-stone-500">
            When reservations become available (your local time).
          </p>
          <div className="flex gap-2 mt-2 flex-wrap">
            {[
              { label: "Apr 1, 7 AM PDT", value: "2026-04-01T07:00" },
              { label: "Apr 1, 10 AM EDT", value: "2026-04-01T10:00" },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setWindowOpensAt(preset.value)}
                className="text-xs px-2 py-1 bg-stone-700 hover:bg-stone-600 rounded text-stone-300"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-stone-500 bg-stone-900 border border-stone-700 rounded-lg p-3">
        Recreation.gov credentials are read from server environment variables
        (RECGOV_EMAIL / RECGOV_PASSWORD).
      </p>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-emerald-900/30 border border-emerald-700 rounded-lg p-3 text-sm text-emerald-300">
          {success}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? "Creating..." : "Create Sniper Job"}
      </button>
    </form>
  );
}

// ---- Job Card ----

function SniperJobCard({ job }: { job: SniperJob }) {
  const [deleting, setDeleting] = useState(false);
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
          ? "border-emerald-600 bg-emerald-900/30"
          : job.status === "failed"
            ? "border-red-700 bg-red-900/20"
            : "border-stone-700 bg-stone-800"
      }`}
    >
      <div className="p-5">
        {/* Header row */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-stone-100">
              {job.bookingType === "campsite"
                ? (job.campgroundName || `Campground ${job.campgroundId}`)
                : (job.permitName || `Permit ${job.permitId}`)}
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Job {job.id.slice(0, 8)} &middot;{" "}
              {job.bookingType === "campsite"
                ? (job.campsiteId ? `Site ${job.campsiteId}` : "Any site")
                : `Division ${job.divisionId}`}
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-stone-700 text-stone-400">
                {job.bookingType === "campsite" ? "Campsite" : "Permit"}
              </span>
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full ${config.bg} ${config.color}`}
          >
            {config.label}
          </span>
        </div>

        {/* Status message */}
        <p className="text-sm text-stone-400 mb-3">{job.message}</p>

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
                        ? "bg-emerald-800 text-emerald-200 font-medium"
                        : "bg-stone-700 text-stone-300"
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
            <span className="font-medium text-stone-200">{job.groupSize}</span>
          </div>

          <div>
            <span className="text-stone-500 text-xs block">Window Opens</span>
            <span className="font-medium text-stone-200">
              {new Date(job.windowOpensAt).toLocaleString()}
            </span>
            {isActive && (
              <span className="text-xs text-amber-400 block">{countdown}</span>
            )}
          </div>

          <div>
            <span className="text-stone-500 text-xs block">Polls</span>
            <span className="font-medium text-stone-200">{job.attempts}</span>
          </div>
        </div>

        {/* Booked range */}
        {job.bookedRange && (
          <div className="mt-3 bg-emerald-900/50 text-emerald-200 text-sm font-medium rounded-lg p-3">
            Booked: {job.bookedRange.startDate} to {job.bookedRange.endDate}
            {job.bookedCampsiteId ? ` (site ${job.bookedCampsiteId})` : ""}
            {" "}&mdash; Complete your purchase on recreation.gov!
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-4">
          {isActive && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-sm bg-red-900/50 text-red-300 hover:bg-red-800/50 rounded-lg transition disabled:opacity-50"
            >
              {deleting ? "Cancelling..." : "Cancel"}
            </button>
          )}

          {!isActive && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1.5 text-sm bg-stone-700 text-stone-300 hover:bg-stone-600 rounded-lg transition disabled:opacity-50"
              >
                {deleting ? "Removing..." : "Remove"}
              </button>
            )}

        </div>
      </div>
    </div>
  );
}

