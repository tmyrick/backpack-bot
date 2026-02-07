import type { PermitAvailability, DayAvailability } from "../types/index.js";

interface Props {
  availability: PermitAvailability;
  month: string;
  loading: boolean;
  error: string | null;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onRefresh: () => void;
  onSelectDate?: (entranceId: string, date: string) => void;
}

const STATUS_COLORS: Record<DayAvailability["status"], string> = {
  available: "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 cursor-pointer",
  limited: "bg-amber-100 text-amber-800 hover:bg-amber-200 cursor-pointer",
  unavailable: "bg-red-50 text-red-300",
  "walk-up": "bg-sky-100 text-sky-700",
  unknown: "bg-stone-100 text-stone-400",
};

const STATUS_LABELS: Record<DayAvailability["status"], string> = {
  available: "Available",
  limited: "Limited",
  unavailable: "Unavailable",
  "walk-up": "Walk-up only",
  unknown: "Unknown",
};

function formatMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(y, m - 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function getDaysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export default function AvailabilityCalendar({
  availability,
  month,
  loading,
  error,
  onPrevMonth,
  onNextMonth,
  onRefresh,
  onSelectDate,
}: Props) {
  const daysInMonth = getDaysInMonth(month);

  // Build a lookup: entranceId -> date -> DayAvailability
  const lookup = new Map<string, Map<string, DayAvailability>>();
  for (const entrance of availability.entrances) {
    const dayMap = new Map<string, DayAvailability>();
    for (const day of entrance.days) {
      dayMap.set(day.date, day);
    }
    lookup.set(entrance.entranceId, dayMap);
  }

  return (
    <div>
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={onPrevMonth}
          disabled={loading}
          className="px-3 py-1.5 text-sm bg-white border border-stone-200 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
        >
          Previous
        </button>
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold">{formatMonthLabel(month)}</h3>
          {loading && (
            <div className="h-4 w-4 border-2 border-stone-300 border-t-emerald-600 rounded-full animate-spin" />
          )}
        </div>
        <button
          onClick={onNextMonth}
          disabled={loading}
          className="px-3 py-1.5 text-sm bg-white border border-stone-200 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
        >
          Next
        </button>
      </div>

      {/* Refresh */}
      <div className="flex justify-end mb-3">
        <button
          onClick={onRefresh}
          disabled={loading}
          className="text-xs text-stone-400 hover:text-emerald-600 transition disabled:opacity-50"
        >
          Refresh availability
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-800 text-sm mb-4">
          {error}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-4">
        {(Object.entries(STATUS_LABELS) as [DayAvailability["status"], string][]).map(
          ([status, label]) => (
            <div key={status} className="flex items-center gap-1.5 text-xs">
              <div className={`w-3 h-3 rounded ${STATUS_COLORS[status].split(" ")[0]}`} />
              <span className="text-stone-600">{label}</span>
            </div>
          ),
        )}
      </div>

      {/* Calendar grid */}
      {availability.entrances.length === 0 && !loading ? (
        <div className="bg-stone-50 border border-stone-200 rounded-lg p-6 text-center text-stone-500 text-sm">
          No availability data found for this month. This could mean the permit
          season hasn't started yet, or the scraper couldn't extract data from
          the page.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left px-2 py-2 bg-stone-50 border border-stone-200 font-medium text-stone-600 sticky left-0 z-10 min-w-[180px]">
                  Entry Point
                </th>
                {Array.from({ length: daysInMonth }, (_, i) => (
                  <th
                    key={i}
                    className="px-1 py-2 bg-stone-50 border border-stone-200 font-medium text-stone-500 text-center min-w-[40px]"
                  >
                    {i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {availability.entrances.map((entrance) => {
                const dayMap = lookup.get(entrance.entranceId);
                return (
                  <tr key={entrance.entranceId}>
                    <td className="px-2 py-2 border border-stone-200 font-medium text-stone-700 sticky left-0 bg-white z-10">
                      <div className="truncate max-w-[180px]" title={entrance.entranceName}>
                        {entrance.entranceName}
                      </div>
                    </td>
                    {Array.from({ length: daysInMonth }, (_, i) => {
                      const dateStr = `${month}-${String(i + 1).padStart(2, "0")}`;
                      const day = dayMap?.get(dateStr);
                      const status = day?.status || "unknown";
                      const colorClass = STATUS_COLORS[status];
                      const isClickable =
                        status === "available" || status === "limited";

                      return (
                        <td
                          key={i}
                          className={`px-1 py-2 border border-stone-200 text-center text-xs font-medium transition ${colorClass}`}
                          title={`${entrance.entranceName} - ${dateStr}: ${
                            day
                              ? `${day.remaining}/${day.total} (${STATUS_LABELS[status]})`
                              : "No data"
                          }`}
                          onClick={
                            isClickable && onSelectDate
                              ? () =>
                                  onSelectDate(entrance.entranceId, dateStr)
                              : undefined
                          }
                        >
                          {day ? day.remaining : ""}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
