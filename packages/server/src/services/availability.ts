import type {
  PermitAvailability,
  EntranceAvailability,
  DayAvailability,
} from "../types/index.js";

const RECGOV_API = "https://www.recreation.gov/api/permits";

// ---- Cache ----

interface CacheEntry {
  data: PermitAvailability;
  expiresAt: number;
}

const availabilityCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Kept for backwards compatibility with server index.ts
export async function closeBrowser(): Promise<void> {
  // No-op: we no longer use Playwright for availability
}

// ---- Recreation.gov availability API ----

/**
 * Response shape from recreation.gov's internal permits availability API:
 *
 * {
 *   payload: {
 *     permit_id: string,
 *     next_available_date: string,
 *     availability: {
 *       [divisionId: string]: {
 *         division_id: string,
 *         date_availability: {
 *           [isoDate: string]: {
 *             total: number,
 *             remaining: number,
 *             show_walkup: boolean,
 *             is_secret_quota: boolean,
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 */
interface RecGovAvailabilityResponse {
  payload: {
    permit_id: string;
    next_available_date: string;
    availability: Record<
      string,
      {
        division_id: string;
        date_availability: Record<
          string,
          {
            total: number;
            remaining: number;
            show_walkup: boolean;
            is_secret_quota: boolean;
          }
        >;
      }
    >;
  };
}

/**
 * Fetch permit availability directly from recreation.gov's internal API.
 * No browser needed -- just a simple HTTP call.
 */
export async function scrapeAvailability(
  permitId: string,
  month: string, // YYYY-MM
): Promise<PermitAvailability> {
  const cacheKey = `${permitId}-${month}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const result = await fetchAvailabilityFromApi(permitId, month);

  availabilityCache.set(cacheKey, {
    data: result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return result;
}

async function fetchAvailabilityFromApi(
  permitId: string,
  month: string,
): Promise<PermitAvailability> {
  // Build date range for the full month
  const [year, mon] = month.split("-").map(Number);
  const startDate = new Date(Date.UTC(year, mon - 1, 1));
  const endDate = new Date(Date.UTC(year, mon, 0)); // last day of month

  const url = new URL(`${RECGOV_API}/${permitId}/availability`);
  url.searchParams.set("start_date", startDate.toISOString());
  url.searchParams.set("end_date", endDate.toISOString());
  url.searchParams.set("commercial_acct", "false");

  console.log(`[availability] Fetching: ${url.toString()}`);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Recreation.gov API error (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as RecGovAvailabilityResponse;

  // Also try to fetch division names for nicer display
  const divisionNames = await fetchDivisionNames(permitId);

  // Parse the response
  const entrances: EntranceAvailability[] = [];

  for (const [divisionId, division] of Object.entries(
    data.payload.availability,
  )) {
    const days: DayAvailability[] = [];

    for (const [isoDate, avail] of Object.entries(
      division.date_availability,
    )) {
      // isoDate is like "2026-02-08T00:00:00Z" -- extract YYYY-MM-DD
      const date = isoDate.substring(0, 10);
      if (!date.startsWith(month)) continue;

      const { remaining, total, show_walkup } = avail;

      let status: DayAvailability["status"];
      if (show_walkup) {
        status = "walk-up";
      } else if (remaining <= 0) {
        status = "unavailable";
      } else if (remaining <= Math.ceil(total * 0.25)) {
        status = "limited";
      } else {
        status = "available";
      }

      days.push({ date, remaining, total, status });
    }

    if (days.length > 0) {
      days.sort((a, b) => a.date.localeCompare(b.date));

      entrances.push({
        entranceId: divisionId,
        entranceName: divisionNames.get(divisionId) || `Division ${divisionId}`,
        days,
      });
    }
  }

  console.log(
    `[availability] Got ${entrances.length} division(s), ${entrances.reduce((s, e) => s + e.days.length, 0)} days`,
  );

  return { permitId, month, entrances };
}

/**
 * Fetch the human-readable names for permit divisions.
 * Recreation.gov has a separate endpoint for this.
 */
const divisionNamesCache = new Map<string, Map<string, string>>();

async function fetchDivisionNames(
  permitId: string,
): Promise<Map<string, string>> {
  const cached = divisionNamesCache.get(permitId);
  if (cached) return cached;

  const names = new Map<string, string>();

  try {
    const url = `${RECGOV_API}/${permitId}/divisions`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
      },
    });

    if (res.ok) {
      const data = (await res.json()) as {
        payload:
          | Record<string, { name?: string; division_id?: string; id?: string }>
          | Array<{ name?: string; division_id?: string; id?: string }>;
      };

      if (Array.isArray(data.payload)) {
        // Array format
        for (const div of data.payload) {
          const id = div.division_id || div.id;
          if (id && div.name) {
            names.set(id, div.name);
          }
        }
      } else if (data.payload && typeof data.payload === "object") {
        // Object format keyed by division ID
        for (const [id, div] of Object.entries(data.payload)) {
          if (div && div.name) {
            names.set(id, div.name);
          }
        }
      }
    }
  } catch {
    // Non-critical -- we'll fall back to division IDs
  }

  divisionNamesCache.set(permitId, names);
  return names;
}
