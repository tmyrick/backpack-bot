import { Link } from "react-router-dom";
import { usePermits } from "../hooks/usePermits";

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent || "";
}

export default function PermitsPage() {
  const { permits, loading, error } = usePermits();

  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">Oregon Wilderness Permits</h1>
      <p className="text-stone-500 mb-8">
        Browse available wilderness and backpacking permits in Oregon. Select a
        permit to view entry points, zones, and availability.
      </p>

      {loading && (
        <div className="flex items-center gap-3 text-stone-500">
          <div className="h-5 w-5 border-2 border-stone-300 border-t-emerald-600 rounded-full animate-spin" />
          Loading permits from RIDB...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
          <p className="font-medium">Error loading permits</p>
          <p className="text-sm mt-1">{error}</p>
          <p className="text-sm mt-2 text-red-600">
            Make sure the server is running and RIDB_API_KEY is set in your .env
            file.
          </p>
        </div>
      )}

      {!loading && !error && permits.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800">
          <p className="font-medium">No permits found</p>
          <p className="text-sm mt-1">
            No Oregon permit facilities were returned from the RIDB API. Make
            sure your API key is valid.
          </p>
        </div>
      )}

      <div className="grid gap-4">
        {permits.map((permit) => (
          <Link
            key={permit.facilityId}
            to={`/permits/${permit.facilityId}`}
            className="block bg-white border border-stone-200 rounded-lg p-5 hover:border-emerald-400 hover:shadow-md transition group"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-stone-900 group-hover:text-emerald-700 transition">
                  {permit.name}
                </h2>
                <p className="text-sm text-stone-500 mt-1 line-clamp-2">
                  {stripHtml(permit.description) || "No description available."}
                </p>
                <div className="flex gap-4 mt-3 text-xs text-stone-400">
                  <span>Facility ID: {permit.facilityId}</span>
                  {permit.entranceCount > 0 && (
                    <span>
                      {permit.entranceCount} entry point
                      {permit.entranceCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {permit.reservable && (
                    <span className="text-emerald-600 font-medium">
                      Reservable
                    </span>
                  )}
                </div>
              </div>
              <div className="text-stone-300 group-hover:text-emerald-500 transition mt-1">
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
