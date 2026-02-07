import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { usePermitDetail } from "../hooks/usePermitDetail";
import { useAvailability } from "../hooks/useAvailability";
import AvailabilityCalendar from "../components/AvailabilityCalendar";

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent || "";
}

export default function PermitDetailPage() {
  const { permitId } = useParams<{ permitId: string }>();
  const { permit, loading, error } = usePermitDetail(permitId);
  const availability = useAvailability(permitId);
  const navigate = useNavigate();
  const [showAvailability, setShowAvailability] = useState(false);

  if (loading) {
    return (
      <div className="flex items-center gap-3 text-stone-500">
        <div className="h-5 w-5 border-2 border-stone-300 border-t-emerald-600 rounded-full animate-spin" />
        Loading permit details...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
        <p className="font-medium">Error loading permit</p>
        <p className="text-sm mt-1">{error}</p>
        <Link to="/" className="text-sm text-red-600 underline mt-2 inline-block">
          Back to permits list
        </Link>
      </div>
    );
  }

  if (!permit) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800">
        <p className="font-medium">Permit not found</p>
        <Link to="/" className="text-sm text-amber-600 underline mt-2 inline-block">
          Back to permits list
        </Link>
      </div>
    );
  }

  const handleSelectDate = (entranceId: string, date: string) => {
    const params = new URLSearchParams({
      permitId: permit.facilityId,
      entranceId,
      date,
    });
    navigate(`/booking?${params.toString()}`);
  };

  return (
    <div>
      <Link
        to="/"
        className="text-sm text-stone-400 hover:text-emerald-600 transition mb-4 inline-flex items-center gap-1"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to permits
      </Link>

      <h1 className="text-3xl font-bold mb-2">{permit.name}</h1>
      <p className="text-stone-500 mb-6">
        {stripHtml(permit.description) || "No description available."}
      </p>

      {/* Metadata */}
      <div className="flex flex-wrap gap-3 mb-8">
        <span className="bg-stone-100 text-stone-600 text-xs px-3 py-1 rounded-full">
          Facility ID: {permit.facilityId}
        </span>
        {permit.reservable && (
          <span className="bg-emerald-100 text-emerald-700 text-xs px-3 py-1 rounded-full font-medium">
            Reservable
          </span>
        )}
        {permit.latitude !== 0 && (
          <span className="bg-stone-100 text-stone-600 text-xs px-3 py-1 rounded-full">
            {permit.latitude.toFixed(4)}, {permit.longitude.toFixed(4)}
          </span>
        )}
      </div>

      {/* Links */}
      {permit.links.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Links</h2>
          <div className="flex flex-wrap gap-2">
            {permit.links.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm bg-blue-50 text-blue-700 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition"
              >
                {link.title || link.url}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Entry Points */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">
          Entry Points ({permit.entrances.length})
        </h2>

        {permit.entrances.length === 0 ? (
          <p className="text-stone-400 text-sm italic">
            No entry points found for this facility.
          </p>
        ) : (
          <div className="grid gap-3">
            {permit.entrances.map((entrance) => (
              <div
                key={entrance.id}
                className="bg-white border border-stone-200 rounded-lg p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium text-stone-900">
                      {entrance.name}
                    </h3>
                    {entrance.description && (
                      <p className="text-sm text-stone-500 mt-1">
                        {stripHtml(entrance.description)}
                      </p>
                    )}
                    <div className="flex gap-3 mt-2 text-xs text-stone-400">
                      <span>ID: {entrance.id}</span>
                      {entrance.district && (
                        <span>District: {entrance.district}</span>
                      )}
                      {entrance.town && <span>Town: {entrance.town}</span>}
                    </div>
                  </div>
                </div>

                {/* Zones */}
                {entrance.zones.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-stone-100">
                    <p className="text-xs font-medium text-stone-400 mb-2">
                      Zones ({entrance.zones.length})
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {entrance.zones.map((zone) => (
                        <span
                          key={zone.id}
                          className="text-xs bg-stone-100 text-stone-600 px-2 py-1 rounded"
                          title={zone.description || zone.name}
                        >
                          {zone.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Availability section */}
      <div className="bg-white border border-stone-200 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Availability</h2>
          {!showAvailability && (
            <button
              onClick={() => setShowAvailability(true)}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition"
            >
              Check Availability
            </button>
          )}
        </div>

        {showAvailability && availability.availability ? (
          <AvailabilityCalendar
            availability={availability.availability}
            month={availability.month}
            loading={availability.loading}
            error={availability.error}
            onPrevMonth={availability.prevMonth}
            onNextMonth={availability.nextMonth}
            onRefresh={availability.refresh}
            onSelectDate={handleSelectDate}
          />
        ) : showAvailability && availability.loading ? (
          <div className="flex items-center gap-3 text-stone-500 py-4">
            <div className="h-5 w-5 border-2 border-stone-300 border-t-emerald-600 rounded-full animate-spin" />
            Scraping availability from recreation.gov... This may take a moment.
          </div>
        ) : showAvailability && availability.error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-800 text-sm">
            {availability.error}
          </div>
        ) : !showAvailability ? (
          <p className="text-stone-500 text-sm">
            Click "Check Availability" to scrape real-time availability from
            recreation.gov. Click on an available date to set up automated
            booking.
          </p>
        ) : null}
      </div>
    </div>
  );
}
