import type {
  RIDBFacility,
  RIDBPermitEntrance,
  RIDBZone,
  RIDBPaginatedResponse,
  PermitSummary,
  PermitDetail,
  PermitEntrance,
} from "../types/index.js";

const RIDB_BASE = "https://ridb.recreation.gov/api/v1";

function getApiKey(): string {
  const key = process.env.RIDB_API_KEY;
  if (!key) {
    throw new Error(
      "RIDB_API_KEY environment variable is required. Register at https://ridb.recreation.gov/ to get one.",
    );
  }
  return key;
}

async function ridbFetch<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${RIDB_BASE}${path}`);
  url.searchParams.set("apikey", getApiKey());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RIDB API error (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---- In-memory cache ----

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---- Public API ----

/**
 * Fetch all Oregon facilities that have permit entrances.
 * Paginates through results since RIDB returns max 50 per request.
 */
export async function getOregonPermitFacilities(): Promise<PermitSummary[]> {
  const cacheKey = "or-permit-facilities";
  const cached = getCached<PermitSummary[]>(cacheKey);
  if (cached) return cached;

  const allFacilities: RIDBFacility[] = [];
  let offset = 0;
  const limit = 50;

  // Paginate through all results
  while (true) {
    const response = await ridbFetch<RIDBPaginatedResponse<RIDBFacility>>(
      "/facilities",
      {
        state: "OR",
        query: "permit",
        full: "true",
        limit: String(limit),
        offset: String(offset),
      },
    );

    allFacilities.push(...response.RECDATA);

    if (
      response.RECDATA.length < limit ||
      allFacilities.length >= response.METADATA.RESULTS.TOTAL_COUNT
    ) {
      break;
    }
    offset += limit;
  }

  const summaries: PermitSummary[] = allFacilities.map((f) => ({
    facilityId: f.FacilityID,
    name: f.FacilityName,
    description: f.FacilityDescription,
    latitude: f.FacilityLatitude,
    longitude: f.FacilityLongitude,
    reservable: f.Reservable,
    links: (f.LINK || []).map((l) => ({ title: l.Title, url: l.URL })),
    entranceCount: (f.PERMITENTRANCE || []).length,
  }));

  setCache(cacheKey, summaries);
  return summaries;
}

/**
 * Fetch detailed info about a specific facility, including all
 * permit entrances and their zones.
 */
export async function getPermitDetail(
  facilityId: string,
): Promise<PermitDetail | null> {
  const cacheKey = `permit-detail-${facilityId}`;
  const cached = getCached<PermitDetail>(cacheKey);
  if (cached) return cached;

  // Fetch facility
  let facility: RIDBFacility;
  try {
    facility = await ridbFetch<RIDBFacility>(`/facilities/${facilityId}`, {
      full: "true",
    });
  } catch {
    return null;
  }

  // Fetch permit entrances for this facility
  const entrancesResp = await ridbFetch<
    RIDBPaginatedResponse<RIDBPermitEntrance>
  >(`/facilities/${facilityId}/permitentrances`, { limit: "50" });

  // Fetch zones for each entrance
  const entrances: PermitEntrance[] = await Promise.all(
    entrancesResp.RECDATA.map(async (e) => {
      const zonesResp = await ridbFetch<RIDBPaginatedResponse<RIDBZone>>(
        `/permitentrances/${e.PermitEntranceID}/zones`,
        { limit: "50" },
      );

      return {
        id: e.PermitEntranceID,
        name: e.PermitEntranceName,
        description: e.PermitEntranceDescription,
        district: e.District,
        town: e.Town,
        latitude: e.Latitude,
        longitude: e.Longitude,
        zones: zonesResp.RECDATA.map((z) => ({
          id: z.ZoneID,
          name: z.ZoneName,
          description: z.ZoneDescription,
        })),
      };
    }),
  );

  const detail: PermitDetail = {
    facilityId: facility.FacilityID,
    name: facility.FacilityName,
    description: facility.FacilityDescription,
    latitude: facility.FacilityLatitude,
    longitude: facility.FacilityLongitude,
    reservable: facility.Reservable,
    links: (facility.LINK || []).map((l) => ({ title: l.Title, url: l.URL })),
    entranceCount: entrances.length,
    entrances,
  };

  setCache(cacheKey, detail);
  return detail;
}
