import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  PermitAvailability,
  EntranceAvailability,
  DayAvailability,
} from "../types/index.js";

// ---- Browser management ----

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
    });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// ---- Cache ----

interface CacheEntry {
  data: PermitAvailability;
  expiresAt: number;
}

const availabilityCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for availability data

// ---- Availability scraping ----

/**
 * Scrape permit availability from recreation.gov.
 *
 * Strategy:
 * 1. Navigate to the permit's detailed-availability page
 * 2. Intercept XHR/fetch requests to find the availability API endpoint
 * 3. Parse the JSON response for entrance/date availability data
 * 4. If interception fails, fall back to DOM scraping
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

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  try {
    const result = await scrapeWithInterception(context, permitId, month);
    availabilityCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return result;
  } finally {
    await context.close();
  }
}

/**
 * Primary strategy: Intercept the API responses that recreation.gov's
 * frontend makes when loading the availability calendar.
 */
async function scrapeWithInterception(
  context: BrowserContext,
  permitId: string,
  month: string,
): Promise<PermitAvailability> {
  const page = await context.newPage();

  // Collect intercepted API responses
  const interceptedData: Record<string, unknown> = {};

  page.on("response", async (response) => {
    const url = response.url();
    // Look for availability-related API calls
    if (
      url.includes("/availability") ||
      url.includes("/permit") ||
      url.includes("/itinerary")
    ) {
      try {
        if (response.headers()["content-type"]?.includes("application/json")) {
          const json = await response.json();
          interceptedData[url] = json;
        }
      } catch {
        // Response may not be JSON or may have been consumed
      }
    }
  });

  // Build the date from the month (use the 1st)
  const dateStr = `${month}-01`;

  const url = `https://www.recreation.gov/permits/${permitId}/registration/detailed-availability?date=${dateStr}&type=overnight`;

  console.log(`[availability] Navigating to: ${url}`);

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  } catch {
    console.warn("[availability] Page load timeout, proceeding with partial data");
  }

  // Give a moment for any lagging API calls
  await page.waitForTimeout(2000);

  // Try to extract data from intercepted API responses
  const apiResult = parseInterceptedData(interceptedData, permitId, month);
  if (apiResult && apiResult.entrances.length > 0) {
    console.log(
      `[availability] Got ${apiResult.entrances.length} entrances from intercepted API`,
    );
    await page.close();
    return apiResult;
  }

  // Fallback: scrape the DOM directly
  console.log("[availability] Falling back to DOM scraping");
  const domResult = await scrapeDom(page, permitId, month);
  await page.close();
  return domResult;
}

/**
 * Parse intercepted API response data.
 * Recreation.gov uses varying API formats. We look for the most common
 * patterns:
 *  - /api/permitinyo/availability (Inyo-style)
 *  - /api/permititinerary/availability (general permits)
 *  - Any JSON with date-keyed availability maps
 */
function parseInterceptedData(
  data: Record<string, unknown>,
  permitId: string,
  month: string,
): PermitAvailability | null {
  for (const [url, json] of Object.entries(data)) {
    console.log(`[availability] Intercepted: ${url}`);

    if (!json || typeof json !== "object") continue;

    const payload = json as Record<string, unknown>;

    // Pattern 1: { payload: { <entranceId>: { date_availability: { <date>: { remaining, total } } } } }
    if (payload.payload && typeof payload.payload === "object") {
      const entrances = parsePayloadFormat(
        payload.payload as Record<string, unknown>,
        month,
      );
      if (entrances.length > 0) {
        return { permitId, month, entrances };
      }
    }

    // Pattern 2: Direct object with entrance IDs at the top level
    // { <entranceId>: { date_availability: ... } }
    const entrances = parsePayloadFormat(payload, month);
    if (entrances.length > 0) {
      return { permitId, month, entrances };
    }

    // Pattern 3: { availability: { <date>: { ... } } } (flat format)
    if (payload.availability && typeof payload.availability === "object") {
      const entrances = parseFlatAvailability(
        payload.availability as Record<string, unknown>,
        month,
      );
      if (entrances.length > 0) {
        return { permitId, month, entrances };
      }
    }
  }

  return null;
}

function parsePayloadFormat(
  payload: Record<string, unknown>,
  month: string,
): EntranceAvailability[] {
  const entrances: EntranceAvailability[] = [];

  for (const [entranceId, value] of Object.entries(payload)) {
    if (!value || typeof value !== "object") continue;
    const entranceData = value as Record<string, unknown>;

    const dateAvailability =
      (entranceData.date_availability as Record<string, unknown>) ||
      (entranceData.availability as Record<string, unknown>);

    if (!dateAvailability || typeof dateAvailability !== "object") continue;

    const days: DayAvailability[] = [];

    for (const [dateKey, dateVal] of Object.entries(dateAvailability)) {
      if (!dateKey.startsWith(month)) continue;
      if (!dateVal || typeof dateVal !== "object") continue;

      const d = dateVal as Record<string, unknown>;
      const remaining = typeof d.remaining === "number" ? d.remaining : 0;
      const total = typeof d.total === "number" ? d.total : 0;
      const isWalkUp = d.is_walkup === true || d.walk_up === true;

      let status: DayAvailability["status"];
      if (isWalkUp) {
        status = "walk-up";
      } else if (remaining <= 0) {
        status = "unavailable";
      } else if (remaining <= Math.ceil(total * 0.25)) {
        status = "limited";
      } else {
        status = "available";
      }

      // Extract just the date part (YYYY-MM-DD)
      const date = dateKey.length > 10 ? dateKey.substring(0, 10) : dateKey;

      days.push({ date, remaining, total, status });
    }

    if (days.length > 0) {
      days.sort((a, b) => a.date.localeCompare(b.date));

      const name =
        typeof entranceData.name === "string"
          ? entranceData.name
          : typeof entranceData.trail_name === "string"
            ? entranceData.trail_name
            : entranceId;

      entrances.push({
        entranceId,
        entranceName: name,
        days,
      });
    }
  }

  return entrances;
}

function parseFlatAvailability(
  availability: Record<string, unknown>,
  month: string,
): EntranceAvailability[] {
  const days: DayAvailability[] = [];

  for (const [dateKey, val] of Object.entries(availability)) {
    if (!dateKey.startsWith(month)) continue;
    if (!val || typeof val !== "object") continue;

    const d = val as Record<string, unknown>;
    const remaining = typeof d.remaining === "number" ? d.remaining : 0;
    const total = typeof d.total === "number" ? d.total : 0;

    let status: DayAvailability["status"];
    if (remaining <= 0) {
      status = "unavailable";
    } else if (remaining <= Math.ceil(total * 0.25)) {
      status = "limited";
    } else {
      status = "available";
    }

    const date = dateKey.length > 10 ? dateKey.substring(0, 10) : dateKey;
    days.push({ date, remaining, total, status });
  }

  if (days.length > 0) {
    days.sort((a, b) => a.date.localeCompare(b.date));
    return [{ entranceId: "all", entranceName: "All Entry Points", days }];
  }

  return [];
}

/**
 * Fallback: scrape availability directly from the page DOM.
 * This handles cases where we couldn't intercept the API call.
 */
async function scrapeDom(
  page: Page,
  permitId: string,
  month: string,
): Promise<PermitAvailability> {
  try {
    // Wait for the availability table to render
    await page.waitForSelector(
      '[class*="availability"], [class*="calendar"], table',
      { timeout: 10000 },
    );

    // page.evaluate runs in the browser context. We pass a string function
    // so TypeScript doesn't try to type-check browser globals (document, etc.)
    // in this server-side compilation unit.
    const browserScript = `
      (targetMonth) => {
        const results = [];
        const rows = document.querySelectorAll(
          '[class*="availability-row"], [class*="permit-row"], tr[class*="row"]'
        );
        rows.forEach((row, index) => {
          const nameEl = row.querySelector('[class*="name"], [class*="label"], td:first-child');
          const name = (nameEl && nameEl.textContent && nameEl.textContent.trim()) || ('Entry Point ' + (index + 1));
          const cells = row.querySelectorAll('[class*="cell"], [class*="day"], td:not(:first-child)');
          const days = [];
          cells.forEach((cell, dayIndex) => {
            const text = (cell.textContent && cell.textContent.trim()) || '';
            const classList = cell.className || '';
            const dayNum = dayIndex + 1;
            const date = targetMonth + '-' + String(dayNum).padStart(2, '0');
            let status = 'unknown';
            let remaining = 0;
            const total = 0;
            if (classList.includes('unavailable') || classList.includes('closed')) {
              status = 'unavailable';
            } else if (classList.includes('walk-up') || classList.includes('walkup')) {
              status = 'walk-up';
            } else if (classList.includes('available') || classList.includes('open')) {
              status = 'available';
              remaining = parseInt(text, 10) || 1;
            }
            if (status !== 'unknown') {
              days.push({ date, remaining, total, status });
            }
          });
          if (days.length > 0) {
            results.push({ entranceId: String(index), entranceName: name, days });
          }
        });
        return results;
      }
    `;

    type ScrapedEntrance = {
      entranceId: string;
      entranceName: string;
      days: { date: string; remaining: number; total: number; status: string }[];
    };

    const entrances: ScrapedEntrance[] = await page.evaluate(
      browserScript,
      month,
    ) as ScrapedEntrance[];

    return {
      permitId,
      month,
      entrances: entrances.map((e) => ({
        ...e,
        days: e.days.map((d) => ({
          ...d,
          status: d.status as DayAvailability["status"],
        })),
      })),
    };
  } catch (err) {
    console.warn("[availability] DOM scraping failed:", err);
    return { permitId, month, entrances: [] };
  }
}
