/**
 * Pure booking / date-selection helpers extracted from sniper.ts for unit testing
 * and reuse without loading Playwright or job runtime state.
 */
import type { DateRange, SniperJob } from "../types/index.js";

export type RecDateAttempt = {
  trail: string | null;
  requireAvailableInName: boolean;
  recClassOnly: boolean;
  label: string;
};

export type PermitDivisionPayload = {
  date_availability: Record<string, { remaining: number; total?: number }>;
};

/**
 * Expand a DateRange into YYYY-MM-DD strings for each night (start inclusive, end exclusive).
 */
export function expandRange(range: DateRange): string[] {
  const dates: string[] = [];
  const current = new Date(range.startDate + "T00:00:00.000Z");
  const end = new Date(range.endDate + "T00:00:00.000Z");
  while (current < end) {
    dates.push(current.toISOString().substring(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Production: every night in [startDate, endDate).
 * Visual: boundary dates only [startDate, endDate] when both valid and start < end.
 */
export function resolveNightsToClickInBrowser(range: DateRange, visualClicksEnabled: boolean): string[] {
  if (!visualClicksEnabled) {
    return expandRange(range);
  }
  if (!range.startDate) {
    return expandRange(range);
  }
  if (!range.endDate || range.startDate >= range.endDate) {
    return [range.startDate];
  }
  return [range.startDate, range.endDate];
}

export function formatRange(range: DateRange): string {
  const nights = expandRange(range).length;
  return `${range.startDate} to ${range.endDate} (${nights} night${nights !== 1 ? "s" : ""})`;
}

export function uniqueStringsPreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type JobTrailPick = Pick<SniperJob, "trailheadName">;

/**
 * Build ordered locator strategies for recreation.gov permit date buttons.
 * @param visualClicksEnabled - headed VISUAL_CLICKS dev mode vs production matching.
 * @param rowTrailOverride - when set (including ""), overrides job.trailheadName for row targeting.
 */
export function buildRecDateAttempts(
  job: JobTrailPick,
  visualClicksEnabled: boolean,
  rowTrailOverride?: string,
): RecDateAttempt[] {
  const attempts: RecDateAttempt[] = [];
  const th =
    rowTrailOverride !== undefined ? rowTrailOverride.trim() || undefined : job.trailheadName?.trim();

  if (visualClicksEnabled) {
    if (th) {
      attempts.push({
        trail: th,
        requireAvailableInName: false,
        recClassOnly: true,
        label: `VISUAL: trailhead "${th}" + date (ignores - Available / - Unavailable; no other-row fallback)`,
      });
    } else {
      attempts.push({
        trail: null,
        requireAvailableInName: false,
        recClassOnly: true,
        label: "VISUAL: first .rec-availability-date for this date (Olympic filter only; no generic-button fallback)",
      });
    }
    return attempts;
  }

  if (th) {
    attempts.push({
      trail: th,
      requireAvailableInName: true,
      recClassOnly: true,
      label: `trailhead "${th}" + date + " - Available"`,
    });
  }
  attempts.push({
    trail: null,
    requireAvailableInName: true,
    recClassOnly: true,
    label: th ? 'any row: date + " - Available"' : 'first row: date + " - Available"',
  });
  attempts.push({
    trail: null,
    requireAvailableInName: false,
    recClassOnly: false,
    label: "fallback: any enabled button whose name contains the date",
  });
  return attempts;
}

/** First range in array order where every night has remaining &gt; 0. */
export function findFirstFullyAvailableRange(
  ranges: DateRange[],
  availByDate: Map<string, number>,
): DateRange | null {
  for (const range of ranges) {
    const nights = expandRange(range);
    if (nights.length === 0) {
      continue;
    }
    const allAvailable = nights.every((d) => (availByDate.get(d) ?? 0) > 0);
    if (allAvailable) {
      return range;
    }
  }
  return null;
}

/**
 * Same priority as checkPermitFacilityAvailability: iterate API division buckets in object key order,
 * return first range (in `ranges` order) fully available in that division.
 */
export function findFirstRangeAcrossPermitDivisions(
  ranges: DateRange[],
  availability: Record<string, PermitDivisionPayload>,
): DateRange | null {
  for (const [, division] of Object.entries(availability)) {
    const availByDate = new Map<string, number>();
    for (const [isoDate, avail] of Object.entries(division.date_availability)) {
      availByDate.set(isoDate.substring(0, 10), avail.remaining);
    }
    const hit = findFirstFullyAvailableRange(ranges, availByDate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Builds the start/end instants used by the permits availability API (end extended by one day).
 */
export function computePermitAvailabilityQueryWindow(ranges: DateRange[]): {
  queryStartIso: string;
  queryEndIso: string;
} {
  if (ranges.length === 0) {
    throw new Error("computePermitAvailabilityQueryWindow: ranges must not be empty");
  }
  const allStartDates = ranges.map((r) => r.startDate).sort();
  const allEndDates = ranges.map((r) => r.endDate).sort();
  const queryStart = new Date(allStartDates[0] + "T00:00:00.000Z");
  const queryEnd = new Date(allEndDates[allEndDates.length - 1] + "T00:00:00.000Z");
  queryEnd.setUTCDate(queryEnd.getUTCDate() + 1);
  return { queryStartIso: queryStart.toISOString(), queryEndIso: queryEnd.toISOString() };
}

/** Deterministic version of sniper jitteredPollInterval for tests. */
export function computeJitteredPollInterval(baseMs: number, random01: () => number): number {
  const jitter = baseMs * 0.3;
  return Math.floor(baseMs + (random01() * 2 - 1) * jitter);
}

/** Deterministic humanDelay for tests. */
export function humanDelayMs(min: number, max: number, random01: () => number): number {
  return Math.floor(random01() * (max - min)) + min;
}
