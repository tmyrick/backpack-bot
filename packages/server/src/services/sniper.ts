import { chromium, type Browser, type Page } from "playwright";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ---- Types ----

export interface DateRange {
  startDate: string; // YYYY-MM-DD (entry date)
  endDate: string;   // YYYY-MM-DD (exit date)
}

export type SniperStatus =
  | "pending"
  | "pre-warming"
  | "watching"
  | "booking"
  | "in-cart"
  | "failed"
  | "cancelled";

export interface SniperJob {
  id: string;
  permitId: string;
  permitName: string;
  divisionId: string;
  desiredDateRanges: DateRange[]; // in priority order
  groupSize: number;
  windowOpensAt: string; // ISO timestamp
  status: SniperStatus;
  attempts: number;
  message: string;
  bookedRange: DateRange | null;
  createdAt: string;
  updatedAt: string;
}

/** What the client sends to create a job */
export interface SniperJobRequest {
  permitId: string;
  permitName: string;
  divisionId: string;
  desiredDateRanges: DateRange[];
  groupSize: number;
  windowOpensAt: string;
  email: string;
  password: string;
}

/** The serialized form saved to disk (no credentials) */
type SniperJobOnDisk = Omit<SniperJob, never>; // same shape, just no creds

// ---- Constants ----

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../../data");
const JOBS_FILE = path.join(DATA_DIR, "sniper-jobs.json");

const PRE_WARM_LEAD_MS = 2 * 60 * 1000; // 2 minutes before window
const POLL_INTERVAL_MS = 1_500; // 1.5 seconds
const MAX_WATCH_DURATION_MS = 5 * 60 * 1000; // 5 minutes of watching
const RECGOV_API = "https://www.recreation.gov/api/permits";

// ---- In-memory state ----

const jobs = new Map<string, SniperJob>();
const credentials = new Map<string, { email: string; password: string }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const browsers = new Map<string, { browser: Browser; page: Page }>();
const abortControllers = new Map<string, AbortController>();

// ---- SSE subscribers ----

type SSECallback = (job: SniperJob) => void;
const subscribers = new Set<SSECallback>();

export function subscribeToSniperUpdates(cb: SSECallback): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function notify(job: SniperJob): void {
  for (const cb of subscribers) {
    try {
      cb(job);
    } catch {
      /* ignore */
    }
  }
}

function updateJob(job: SniperJob, updates: Partial<SniperJob>): void {
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  notify({ ...job });
}

// ---- Persistence ----

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function saveJobs(): Promise<void> {
  await ensureDataDir();
  const list = Array.from(jobs.values());
  await fs.writeFile(JOBS_FILE, JSON.stringify(list, null, 2));
}

async function loadJobsFromDisk(): Promise<SniperJobOnDisk[]> {
  try {
    const raw = await fs.readFile(JOBS_FILE, "utf-8");
    return JSON.parse(raw) as SniperJobOnDisk[];
  } catch {
    return [];
  }
}

// ---- Public API ----

export function getJobs(): SniperJob[] {
  return Array.from(jobs.values()).map((j) => ({ ...j }));
}

export function getJob(id: string): SniperJob | null {
  const j = jobs.get(id);
  return j ? { ...j } : null;
}

export function jobNeedsCredentials(id: string): boolean {
  return !credentials.has(id);
}

export async function createJob(req: SniperJobRequest): Promise<SniperJob> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const job: SniperJob = {
    id,
    permitId: req.permitId,
    permitName: req.permitName,
    divisionId: req.divisionId,
    desiredDateRanges: req.desiredDateRanges,
    groupSize: req.groupSize,
    windowOpensAt: req.windowOpensAt,
    status: "pending",
    attempts: 0,
    message: `Scheduled. Window opens at ${new Date(req.windowOpensAt).toLocaleString()}.`,
    bookedRange: null,
    createdAt: now,
    updatedAt: now,
  };

  jobs.set(id, job);
  credentials.set(id, { email: req.email, password: req.password });

  await saveJobs();
  scheduleJob(job);
  notify({ ...job });

  return { ...job };
}

export function supplyCredentials(
  id: string,
  email: string,
  password: string,
): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  credentials.set(id, { email, password });

  // If job is pending, re-schedule it (credentials were missing)
  if (job.status === "pending") {
    scheduleJob(job);
  }

  updateJob(job, {
    message: `Credentials updated. ${job.message}`,
  });
  return true;
}

export async function cancelJob(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;

  // Clear timers
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }

  // Abort running loops
  const ac = abortControllers.get(id);
  if (ac) {
    ac.abort();
    abortControllers.delete(id);
  }

  // Close browser
  const b = browsers.get(id);
  if (b) {
    try {
      await b.browser.close();
    } catch {
      /* ignore */
    }
    browsers.delete(id);
  }

  credentials.delete(id);

  updateJob(job, { status: "cancelled", message: "Cancelled by user." });
  await saveJobs();
  return true;
}

export async function deleteJob(id: string): Promise<boolean> {
  await cancelJob(id);
  jobs.delete(id);
  await saveJobs();
  return true;
}

/**
 * Called on server startup: load persisted jobs and schedule any
 * that are still pending.
 */
export async function loadAndScheduleJobs(): Promise<void> {
  const diskJobs = await loadJobsFromDisk();
  let scheduledCount = 0;

  for (const dj of diskJobs) {
    jobs.set(dj.id, dj);

    // Only re-schedule pending jobs whose window hasn't passed
    if (dj.status === "pending") {
      const windowTime = new Date(dj.windowOpensAt).getTime();
      if (windowTime + MAX_WATCH_DURATION_MS > Date.now()) {
        // Will need credentials before it can run
        updateJob(dj, {
          message: credentials.has(dj.id)
            ? dj.message
            : "Awaiting credentials (server restarted). Re-enter via the UI.",
        });
        if (credentials.has(dj.id)) {
          scheduleJob(dj);
          scheduledCount++;
        }
      } else {
        updateJob(dj, {
          status: "failed",
          message: "Window has already passed (server was offline).",
        });
      }
    }
  }

  await saveJobs();
  console.log(
    `[sniper] Loaded ${diskJobs.length} jobs, scheduled ${scheduledCount}.`,
  );
}

export async function cleanupAllSniper(): Promise<void> {
  for (const [id] of browsers) {
    const b = browsers.get(id);
    if (b) {
      try {
        await b.browser.close();
      } catch {
        /* ignore */
      }
    }
  }
  browsers.clear();

  for (const [, timer] of timers) {
    clearTimeout(timer);
  }
  timers.clear();

  for (const [, ac] of abortControllers) {
    ac.abort();
  }
  abortControllers.clear();

  await saveJobs();
}

// ---- Scheduling ----

function scheduleJob(job: SniperJob): void {
  // Clear any existing timer for this job
  const existing = timers.get(job.id);
  if (existing) clearTimeout(existing);

  const windowTime = new Date(job.windowOpensAt).getTime();
  const preWarmTime = windowTime - PRE_WARM_LEAD_MS;
  const delayToPreWarm = Math.max(0, preWarmTime - Date.now());

  if (delayToPreWarm > 0) {
    console.log(
      `[sniper:${job.id.slice(0, 8)}] Pre-warm in ${Math.round(delayToPreWarm / 1000)}s, window in ${Math.round((windowTime - Date.now()) / 1000)}s`,
    );
    const timer = setTimeout(() => {
      timers.delete(job.id);
      runSniperJob(job);
    }, delayToPreWarm);
    timers.set(job.id, timer);
  } else {
    // Pre-warm time already passed; start immediately
    console.log(
      `[sniper:${job.id.slice(0, 8)}] Starting immediately (pre-warm window passed)`,
    );
    runSniperJob(job);
  }
}

// ---- Main sniper loop ----

async function runSniperJob(job: SniperJob): Promise<void> {
  const creds = credentials.get(job.id);
  if (!creds) {
    updateJob(job, {
      message:
        "Cannot start: credentials not provided. Re-enter via the Sniper page.",
    });
    return;
  }

  const ac = new AbortController();
  abortControllers.set(job.id, ac);
  const { signal } = ac;

  try {
    // ---- Phase 1: Pre-warm ----
    updateJob(job, {
      status: "pre-warming",
      message: "Launching browser and signing in...",
    });
    await saveJobs();

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    browsers.set(job.id, { browser, page });

    if (signal.aborted) return;

    // Sign in
    await signIn(page, creds.email, creds.password);
    if (signal.aborted) return;

    // Navigate to the permit page
    const firstRange = job.desiredDateRanges[0];
    const permitUrl = `https://www.recreation.gov/permits/${job.permitId}/registration/detailed-availability?date=${firstRange.startDate}&type=overnight`;
    await page.goto(permitUrl, { waitUntil: "networkidle", timeout: 30000 });

    if (signal.aborted) return;

    // Set group size
    try {
      const groupInput = await page.waitForSelector(
        'input[name*="group" i], input[aria-label*="group" i], input[aria-label*="number" i], #number-input',
        { timeout: 5000 },
      );
      if (groupInput) {
        await groupInput.fill("");
        await groupInput.fill(String(job.groupSize));
        await page.waitForTimeout(500);
      }
    } catch {
      /* group input not found */
    }

    // Wait until window opens
    const windowTime = new Date(job.windowOpensAt).getTime();
    const waitMs = windowTime - Date.now();
    if (waitMs > 0) {
      updateJob(job, {
        message: `Pre-warmed. Waiting ${Math.round(waitMs / 1000)}s for window to open...`,
      });
      await sleep(waitMs, signal);
    }

    if (signal.aborted) return;

    // ---- Phase 2: Watch (poll availability API) ----
    updateJob(job, {
      status: "watching",
      message: "Window open! Polling for availability...",
    });
    await saveJobs();

    const watchDeadline = Date.now() + MAX_WATCH_DURATION_MS;
    let foundRange: DateRange | null = null;

    while (!signal.aborted && Date.now() < watchDeadline) {
      job.attempts++;
      try {
        foundRange = await checkAvailability(
          job.permitId,
          job.divisionId,
          job.desiredDateRanges,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        updateJob(job, {
          message: `Poll #${job.attempts}: API error (${msg}). Retrying...`,
        });
      }

      if (foundRange) {
        updateJob(job, {
          message: `Availability detected for ${foundRange.startDate} - ${foundRange.endDate}! Attempting to book...`,
        });
        break;
      }

      updateJob(job, {
        message: `Poll #${job.attempts}: No availability yet. Next check in ${POLL_INTERVAL_MS / 1000}s...`,
      });

      await sleep(POLL_INTERVAL_MS, signal);
    }

    if (signal.aborted) return;

    if (!foundRange) {
      updateJob(job, {
        status: "failed",
        message: `No availability detected after ${job.attempts} polls (${MAX_WATCH_DURATION_MS / 1000}s). Window may have passed.`,
      });
      await saveJobs();
      return;
    }

    // ---- Phase 3: Book ----
    updateJob(job, {
      status: "booking",
      message: `Booking ${foundRange.startDate} - ${foundRange.endDate}...`,
    });
    await saveJobs();

    const bookResult = await attemptBrowserBooking(page, job, foundRange);

    if (bookResult === "booked") {
      updateJob(job, {
        status: "in-cart",
        bookedRange: foundRange,
        message: `Permit for ${foundRange.startDate} - ${foundRange.endDate} added to cart! Complete your purchase on recreation.gov.`,
      });
      await saveJobs();
      return;
    }

    // First range failed (race condition). Try remaining ranges.
    const remainingRanges = job.desiredDateRanges.filter(
      (r) => r.startDate !== foundRange!.startDate || r.endDate !== foundRange!.endDate,
    );
    for (const fallbackRange of remainingRanges) {
      if (signal.aborted) return;

      // Re-check availability for this specific range
      const available = await checkAvailability(
        job.permitId,
        job.divisionId,
        [fallbackRange],
      );
      if (!available) continue;

      updateJob(job, {
        message: `Primary range taken. Trying fallback: ${fallbackRange.startDate} - ${fallbackRange.endDate}...`,
      });

      const result = await attemptBrowserBooking(page, job, fallbackRange);
      if (result === "booked") {
        updateJob(job, {
          status: "in-cart",
          bookedRange: fallbackRange,
          message: `Permit for ${fallbackRange.startDate} - ${fallbackRange.endDate} (fallback) added to cart! Complete purchase on recreation.gov.`,
        });
        await saveJobs();
        return;
      }
    }

    // All ranges failed
    updateJob(job, {
      status: "failed",
      message: `Could not book any of the desired date ranges after ${job.attempts} attempts.`,
    });
    await saveJobs();
  } catch (err) {
    if (signal.aborted) return;
    const msg = err instanceof Error ? err.message : "unknown error";
    updateJob(job, {
      status: "failed",
      message: `Sniper failed: ${msg}`,
    });
    await saveJobs();
  } finally {
    abortControllers.delete(job.id);

    // Close browser unless permit is in cart
    if (job.status !== "in-cart") {
      const b = browsers.get(job.id);
      if (b) {
        try {
          await b.browser.close();
        } catch {
          /* ignore */
        }
        browsers.delete(job.id);
      }
    }
  }
}

// ---- Availability polling (direct API, no browser) ----

/**
 * Expand a DateRange into an array of individual YYYY-MM-DD strings
 * covering every night of the trip (startDate inclusive, endDate exclusive).
 * For a 3-night trip entering July 15 and exiting July 18:
 *   expandRange({ startDate: "2026-07-15", endDate: "2026-07-18" })
 *   => ["2026-07-15", "2026-07-16", "2026-07-17"]
 */
function expandRange(range: DateRange): string[] {
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
 * Format a DateRange for display: "Jul 15 - Jul 18 (3 nights)"
 */
function formatRange(range: DateRange): string {
  const nights = expandRange(range).length;
  return `${range.startDate} to ${range.endDate} (${nights} night${nights !== 1 ? "s" : ""})`;
}

async function checkAvailability(
  permitId: string,
  divisionId: string,
  ranges: DateRange[],
): Promise<DateRange | null> {
  // Compute the widest date window covering all desired ranges
  const allStartDates = ranges.map((r) => r.startDate).sort();
  const allEndDates = ranges.map((r) => r.endDate).sort();
  const queryStart = new Date(allStartDates[0] + "T00:00:00.000Z");
  const queryEnd = new Date(allEndDates[allEndDates.length - 1] + "T00:00:00.000Z");
  // Extend end by 1 day for the API
  queryEnd.setUTCDate(queryEnd.getUTCDate() + 1);

  const url = `${RECGOV_API}/${permitId}/availability?start_date=${queryStart.toISOString()}&end_date=${queryEnd.toISOString()}&commercial_acct=false`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    payload: {
      availability: Record<
        string,
        {
          date_availability: Record<
            string,
            { remaining: number; total: number }
          >;
        }
      >;
    };
  };

  const division = data.payload.availability[divisionId];
  if (!division) return null;

  // Build a lookup of date -> remaining
  const availByDate = new Map<string, number>();
  for (const [isoDate, avail] of Object.entries(division.date_availability)) {
    availByDate.set(isoDate.substring(0, 10), avail.remaining);
  }

  // Check ranges in priority order -- ALL dates in the range must have remaining > 0
  for (const range of ranges) {
    const nights = expandRange(range);
    const allAvailable = nights.every((d) => (availByDate.get(d) ?? 0) > 0);
    if (allAvailable) {
      return range;
    }
  }

  return null;
}

// ---- Browser booking ----

async function attemptBrowserBooking(
  page: Page,
  job: SniperJob,
  targetRange: DateRange,
): Promise<"booked" | "failed"> {
  try {
    // Navigate to the availability page for the start date of the range
    const url = `https://www.recreation.gov/permits/${job.permitId}/registration/detailed-availability?date=${targetRange.startDate}&type=overnight`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Get all the individual dates we need to book (each night)
    const nightDates = expandRange(targetRange);

    // Try to click the available cells for each night in the range
    const clicked = await page.evaluate(
      `(args) => {
        const { divisionId, nightDates } = args;
        let clickCount = 0;

        for (const targetDate of nightDates) {
          // Strategy 1: data attributes
          const cell = document.querySelector(
            '[data-division-id="' + divisionId + '"][data-date="' + targetDate + '"]'
          );
          if (cell) {
            const btn = cell.querySelector('button') || cell;
            if (!btn.classList.contains('unavailable') && !btn.disabled) {
              btn.click();
              clickCount++;
              continue;
            }
          }

          // Strategy 2: Find rows by text, click available cells
          const rows = document.querySelectorAll(
            '[class*="availability-row"], [class*="permit-row"], tr'
          );
          for (const row of rows) {
            const firstCell = row.querySelector('td:first-child, [class*="name"]');
            const text = firstCell ? firstCell.textContent || '' : '';
            if (text.includes(divisionId) || rows.length === 1) {
              const dateCells = row.querySelectorAll('td:not(:first-child), [class*="cell"]');
              for (const dc of dateCells) {
                const cn = dc.className || '';
                if (cn.includes('available') && !cn.includes('unavailable')) {
                  const btn = dc.querySelector('button') || dc;
                  btn.click();
                  clickCount++;
                  break;
                }
              }
            }
          }
        }

        return clickCount > 0 ? 'clicked' : 'none';
      }`,
      { divisionId: job.divisionId, nightDates },
    );

    if (clicked === "none") {
      return "failed";
    }

    await page.waitForTimeout(2000);

    // Click "Book Now" / "Add to Cart"
    const bookSelectors = [
      'button:has-text("Book Now")',
      'button:has-text("Add to Cart")',
      'button:has-text("Reserve")',
      'button:has-text("Continue")',
    ];

    for (const sel of bookSelectors) {
      try {
        const btn = await page.waitForSelector(sel, { timeout: 5000 });
        if (btn) {
          await btn.click();
          await page.waitForTimeout(3000);
          return "booked";
        }
      } catch {
        continue;
      }
    }

    return "failed";
  } catch {
    return "failed";
  }
}

// ---- Sign in helper ----

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  console.log("[sniper] Signing in...");
  await page.goto("https://www.recreation.gov/log-in", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // Email
  for (const sel of [
    'input[name="email"]',
    'input[type="email"]',
    "#email",
    'input[placeholder*="email" i]',
  ]) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.fill(email);
        break;
      }
    } catch {
      continue;
    }
  }

  // Password
  for (const sel of [
    'input[name="password"]',
    'input[type="password"]',
    "#password",
  ]) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.fill(password);
        break;
      }
    } catch {
      continue;
    }
  }

  // Submit
  for (const sel of [
    'button[type="submit"]',
    'button:has-text("Log In")',
    'button:has-text("Sign In")',
  ]) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.click();
        break;
      }
    } catch {
      continue;
    }
  }

  try {
    await page.waitForURL("**/recreation.gov/**", { timeout: 15000 });
    await page.waitForTimeout(2000);
  } catch {
    if (page.url().includes("log-in")) {
      throw new Error("Login failed. Check your recreation.gov credentials.");
    }
  }

  console.log("[sniper] Signed in successfully.");
}

// ---- Utility ----

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}
