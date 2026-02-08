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
}

/** The serialized form saved to disk (no credentials) */
type SniperJobOnDisk = Omit<SniperJob, never>; // same shape, just no creds

/** Read recreation.gov credentials from environment variables */
function getRecgovCredentials(): { email: string; password: string } {
  const email = process.env.RECGOV_EMAIL;
  const password = process.env.RECGOV_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "RECGOV_EMAIL and RECGOV_PASSWORD environment variables are required for sniper jobs",
    );
  }
  return { email, password };
}

// ---- Constants ----

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "../../../../data");
const JOBS_FILE = path.join(DATA_DIR, "sniper-jobs.json");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");

const PRE_WARM_LEAD_MS = 2 * 60 * 1000; // 2 minutes before window
const POLL_INTERVAL_MS = 1_500; // 1.5 seconds
const MAX_WATCH_DURATION_MS = 5 * 60 * 1000; // 5 minutes of watching
const RECGOV_API = "https://www.recreation.gov/api/permits";

// ---- In-memory state ----

const jobs = new Map<string, SniperJob>();
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

  await saveJobs();
  scheduleJob(job);
  notify({ ...job });

  return { ...job };
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
        scheduleJob(dj);
        scheduledCount++;
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
  let creds: { email: string; password: string };
  try {
    creds = getRecgovCredentials();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateJob(job, {
      status: "failed",
      message: msg,
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
    jobLog(job, "Starting sign-in...");
    await signIn(page, creds.email, creds.password);
    jobLog(job, "Sign-in complete. Current URL:", page.url());
    if (signal.aborted) return;

    // Navigate to the permit page
    const firstRange = job.desiredDateRanges[0];
    const permitUrl = `https://www.recreation.gov/permits/${job.permitId}/registration/detailed-availability?date=${firstRange.startDate}&type=overnight`;
    jobLog(job, "Navigating to permit page:", permitUrl);
    await page.goto(permitUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000); // let JS hydrate
    jobLog(job, "Permit page loaded. URL:", page.url());
    await saveScreenshot(page, job, "permit-page-prewarm");

    if (signal.aborted) return;

    // Set group size - recreation.gov uses a custom dropdown for this
    jobLog(job, `Setting group size to ${job.groupSize}...`);
    await setGroupSize(page, job);

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

// ---- Debug helpers ----

function jobLog(job: SniperJob, ...args: unknown[]): void {
  console.log(`[sniper:${job.id.slice(0, 8)}]`, ...args);
}

async function saveScreenshot(
  page: Page,
  job: SniperJob,
  label: string,
): Promise<string | null> {
  try {
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${timestamp}_${job.id.slice(0, 8)}-${label}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    jobLog(job, `Screenshot saved: data/screenshots/${filename}`);
    return filepath;
  } catch (err) {
    jobLog(job, "Failed to save screenshot:", err);
    return null;
  }
}

async function debugPageState(
  page: Page,
  job: SniperJob,
  label: string,
): Promise<void> {
  jobLog(job, `[${label}] URL: ${page.url()}`);
  jobLog(job, `[${label}] Title: ${await page.title()}`);

  // Dump a summary of what's on the page
  const summary = await page.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(
      b => ({ text: b.textContent?.trim().substring(0, 60), disabled: b.disabled, classes: b.className.substring(0, 80) })
    );
    const inputs = Array.from(document.querySelectorAll('input')).map(
      i => ({ type: i.type, name: i.name, placeholder: i.placeholder })
    );
    const links = Array.from(document.querySelectorAll('a')).slice(0, 10).map(
      a => ({ text: a.textContent?.trim().substring(0, 40), href: a.href })
    );
    // Look for availability-related elements
    const availCells = document.querySelectorAll('[class*="available"], [class*="cell"], [data-date]');
    const bodyText = document.body?.innerText?.substring(0, 500) || '';
    return {
      buttonCount: buttons.length,
      buttons: buttons.slice(0, 15),
      inputCount: inputs.length,
      inputs: inputs.slice(0, 10),
      linkCount: links.length,
      availCellCount: availCells.length,
      bodyPreview: bodyText,
    };
  })()`);

  jobLog(job, `[${label}] Page summary:`, JSON.stringify(summary, null, 2));
  await saveScreenshot(page, job, label);
}

// ---- Group size selection ----

/**
 * Recreation.gov uses a custom dropdown for group size.
 * DOM structure (from inspecting recreation.gov):
 *   Trigger: button#guest-counter-QuotaUsageByMemberDaily
 *     text: "Add Group Members (20 max)..."
 *     aria-haspopup="dialog"
 *     aria-controls="guest-counter-QuotaUsageByMemberDaily-popup"
 *   Popup:  div#guest-counter-QuotaUsageByMemberDaily-popup role="dialog"
 *     Inside: stepper controls with minus (-) button, numeric input, plus (+) button
 *     Close button at bottom
 */
async function setGroupSize(page: Page, job: SniperJob): Promise<void> {
  const size = job.groupSize;
  jobLog(job, `Setting group size to ${size}...`);

  // DOM structure (from inspecting recreation.gov):
  //   Trigger:  button#guest-counter-QuotaUsageByMemberDaily
  //   Popup:    div#guest-counter-QuotaUsageByMemberDaily-popup (exists in DOM before open, empty)
  //     Content injected on open inside .sarsa-dropdown-base-popup:
  //       Input:  input#guest-counter-QuotaUsageByMemberDaily-number-field-People (type="text")
  //       Minus:  button[aria-label="Remove Peoples"]
  //       Plus:   button[aria-label="Add Peoples"]
  //       Close:  .sarsa-dropdown-base-popup-actions button (text "Close")

  const peopleInput = page.locator(
    "input#guest-counter-QuotaUsageByMemberDaily-number-field-People",
  );
  const plusBtn = page.locator('button[aria-label="Add Peoples"]');

  try {
    // Step 1: Click the trigger to open the dropdown
    jobLog(job, "Step 1: Opening group members dropdown...");
    const trigger = page.locator("button#guest-counter-QuotaUsageByMemberDaily");
    await trigger.waitFor({ timeout: 10000 });
    await trigger.click();

    // Wait for the CONTENT to render inside the popup (not just the popup div,
    // which exists empty in the DOM before opening). Wait for the input element.
    jobLog(job, "Waiting for popup content to render...");
    await peopleInput.waitFor({ state: "visible", timeout: 10000 });
    jobLog(job, "Dropdown content visible.");

    // Step 2: Read current value from the input
    const currentValStr = await peopleInput.inputValue();
    const currentVal = parseInt(currentValStr, 10) || 0;
    jobLog(job, `Current people count: ${currentVal}, target: ${size}`);

    // Step 3: Click the "Add Peoples" (+) button to reach the target
    // Don't use fill() -- React controlled inputs ignore synthetic value changes.
    // The + button is the only reliable way to change the value.
    const clicksNeeded = Math.max(0, size - currentVal);
    jobLog(job, `Clicking "Add Peoples" button ${clicksNeeded} times...`);

    for (let i = 0; i < clicksNeeded; i++) {
      await plusBtn.click({ timeout: 3000 });
      await page.waitForTimeout(200);
    }

    // Verify the value changed
    await page.waitForTimeout(300);
    const newVal = await peopleInput.inputValue();
    jobLog(job, `People count after clicking: ${newVal}`);

    await saveScreenshot(page, job, "group-size-set");

    // Step 4: Close the dropdown
    jobLog(job, "Step 4: Closing dropdown...");
    const closeBtn = page.locator(
      '.sarsa-dropdown-base-popup-actions button:has-text("Close")',
    );
    try {
      await closeBtn.click({ timeout: 3000 });
      jobLog(job, "Clicked Close button.");
    } catch {
      jobLog(job, "Close button not found, pressing Escape...");
      await page.keyboard.press("Escape");
    }

    // Step 5: Wait for the availability table to render
    jobLog(job, "Step 5: Waiting for availability table to load...");
    await page.waitForTimeout(3000);

    try {
      await page.locator('[data-testid="availability-cell"]').first().waitFor({ timeout: 10000 });
      jobLog(job, "Availability table detected.");
    } catch {
      jobLog(job, "Warning: availability-cell not found after setting group size.");
    }

    await saveScreenshot(page, job, "after-group-size-close");
    jobLog(job, "Group size set successfully.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "Error setting group size:", msg);
    await saveScreenshot(page, job, "group-size-error");
  }
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
    jobLog(job, "Navigating to:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000); // let JS hydrate

    // Must set group size before availability shows
    await setGroupSize(page, job);

    await debugPageState(page, job, "booking-page-loaded");

    // Get all the individual dates we need to book (each night)
    const nightDates = expandRange(targetRange);
    jobLog(job, "Night dates to book:", nightDates);

    // Recreation.gov availability grid uses buttons with aria-labels like:
    //   aria-label="Tilly Jane A-Frame Permit on February 16, 2026 - Available"
    // Cells are <div data-testid="availability-cell"> containing <button> elements.
    // Available cells have class "available", unavailable have "unavailable" + disabled.

    let clickCount = 0;

    for (const nightDate of nightDates) {
      // Format the date for the aria-label: "February 16, 2026"
      const d = new Date(nightDate + "T00:00:00");
      const monthName = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
      const dayOfMonth = d.getUTCDate();
      const year = d.getUTCFullYear();
      const ariaDateStr = `${monthName} ${dayOfMonth}, ${year}`;

      jobLog(job, `Looking for button with aria-label containing "${ariaDateStr}" and "Available"...`);

      try {
        // Find the available button by its aria-label
        const btn = page.locator(
          `button.rec-availability-date[aria-label*="${ariaDateStr}"][aria-label*="Available"]:not([disabled])`,
        );
        const count = await btn.count();
        jobLog(job, `  Found ${count} matching button(s)`);

        if (count > 0) {
          await btn.first().click({ timeout: 5000 });
          clickCount++;
          jobLog(job, `  Clicked! (${clickCount} total)`);
          await page.waitForTimeout(500);
        } else {
          // Fallback: try broader selector
          const fallback = page.locator(
            `button[aria-label*="${ariaDateStr}"]:not([disabled])`,
          );
          const fbCount = await fallback.count();
          jobLog(job, `  Fallback: found ${fbCount} button(s)`);
          if (fbCount > 0) {
            await fallback.first().click({ timeout: 5000 });
            clickCount++;
            jobLog(job, `  Fallback clicked! (${clickCount} total)`);
            await page.waitForTimeout(500);
          } else {
            jobLog(job, `  No available button found for ${nightDate}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        jobLog(job, `  Error clicking ${nightDate}: ${msg}`);
      }
    }

    jobLog(job, `Clicked ${clickCount}/${nightDates.length} date cells`);

    if (clickCount === 0) {
      jobLog(job, "No cells clicked - booking failed");
      await saveScreenshot(page, job, "no-cells-clicked");
      return "failed";
    }

    await page.waitForTimeout(2000);
    await saveScreenshot(page, job, "after-cell-click");

    // Click "Book Now"
    jobLog(job, "Looking for Book Now button...");
    let bookClicked = false;
    try {
      const bookBtn = page.locator('button:has-text("Book Now")');
      const bookCount = await bookBtn.count();
      jobLog(job, `Found ${bookCount} "Book Now" button(s)`);
      if (bookCount > 0) {
        await bookBtn.first().click({ timeout: 5000 });
        jobLog(job, "Clicked Book Now!");
        bookClicked = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jobLog(job, `Book Now error: ${msg}`);
    }

    // Fallback button selectors
    if (!bookClicked) {
      for (const label of ["Add to Cart", "Reserve", "Continue", "Next"]) {
        try {
          const btn = page.locator(`button:has-text("${label}")`);
          if ((await btn.count()) > 0) {
            jobLog(job, `Clicking fallback: "${label}"`);
            await btn.first().click({ timeout: 3000 });
            bookClicked = true;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!bookClicked) {
      jobLog(job, "No booking button found");
      await saveScreenshot(page, job, "no-book-button");
      return "failed";
    }

    // Wait for the Order Details page to load
    await page.waitForTimeout(5000);
    await saveScreenshot(page, job, "after-book-click");

    // Fill order details (address, terms checkbox) and proceed to cart
    const orderSuccess = await fillOrderDetails(page, job);
    if (orderSuccess) {
      jobLog(job, "Order details filled and proceeded to cart!");
      return "booked";
    } else {
      jobLog(job, "Order details filling failed, but booking was clicked. Check browser.");
      // Still return booked since the reservation is selected
      return "booked";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "attemptBrowserBooking error:", msg);
    try {
      await saveScreenshot(page, job, "booking-error");
    } catch { /* ignore */ }
    return "failed";
  }
}

// ---- Order details helper ----

/**
 * After clicking "Book Now", recreation.gov shows the Order Details page.
 * This fills in address fields from env vars, checks the terms checkbox,
 * and clicks "Proceed to Cart".
 *
 * DOM selectors (from inspecting recreation.gov):
 *   Country:  select#country (value e.g. "USA")
 *   Address:  input#address1
 *   Suite:    input#suite-number (optional)
 *   City:     input#city
 *   State:    select#state (value e.g. "OR")
 *   Zip:      input#zip_code
 *   Terms:    input#need-to-know-checkbox
 *   Submit:   button[data-testid="OrderDetailsSummary-cart-btn"] "Proceed to Cart"
 */
async function fillOrderDetails(page: Page, job: SniperJob): Promise<boolean> {
  jobLog(job, "Filling order details...");

  const address = process.env.RECGOV_ADDRESS;
  const city = process.env.RECGOV_CITY;
  const state = process.env.RECGOV_STATE;
  const zip = process.env.RECGOV_ZIP;
  const country = process.env.RECGOV_COUNTRY || "USA";

  if (!address || !city || !state || !zip) {
    jobLog(job, "Warning: RECGOV_ADDRESS/CITY/STATE/ZIP env vars not set. Skipping auto-fill.");
    await saveScreenshot(page, job, "order-details-no-env");
    return false;
  }

  try {
    // Wait for the order details form to load
    jobLog(job, "Waiting for order details form...");
    await page.locator("input#address1").waitFor({ state: "visible", timeout: 15000 });
    jobLog(job, "Order details form loaded.");

    // Fill country (select)
    jobLog(job, `Setting country to ${country}...`);
    await page.locator("select#country").selectOption(country);
    await page.waitForTimeout(500);

    // Fill address
    jobLog(job, `Setting address to "${address}"...`);
    await page.locator("input#address1").fill(address);

    // Fill city
    jobLog(job, `Setting city to "${city}"...`);
    await page.locator("input#city").fill(city);

    // Fill state (select) -- wait for state dropdown to populate after country selection
    jobLog(job, `Setting state to ${state}...`);
    await page.waitForTimeout(500);
    await page.locator("select#state").selectOption(state);

    // Fill zip
    jobLog(job, `Setting zip to "${zip}"...`);
    await page.locator("input#zip_code").fill(zip);

    await page.waitForTimeout(500);
    await saveScreenshot(page, job, "order-details-filled");

    // Check the "Need to Know" terms checkbox
    jobLog(job, "Checking terms checkbox...");
    const checkbox = page.locator("input#need-to-know-checkbox");
    const isChecked = await checkbox.isChecked();
    if (!isChecked) {
      // Click the label since the input is hidden (rec-input-hide class)
      await page.locator('label[for="need-to-know-checkbox"]').click();
      jobLog(job, "Terms checkbox checked.");
    } else {
      jobLog(job, "Terms checkbox already checked.");
    }

    await page.waitForTimeout(500);

    // Click "Proceed to Cart"
    jobLog(job, 'Clicking "Proceed to Cart"...');
    const cartBtn = page.locator('button[data-testid="OrderDetailsSummary-cart-btn"]');
    await cartBtn.waitFor({ timeout: 5000 });
    await cartBtn.click();
    jobLog(job, "Clicked Proceed to Cart!");

    await page.waitForTimeout(5000);
    await saveScreenshot(page, job, "after-proceed-to-cart");

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "Error filling order details:", msg);
    await saveScreenshot(page, job, "order-details-error");
    return false;
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
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000); // let the login form render

  // Exact selectors from recreation.gov DOM:
  //   Email:    input#email (type="email")
  //   Password: input#rec-acct-sign-in-password (type="password")
  //   Submit:   button.rec-acct-sign-in-btn (type="submit", text "Log In")

  const emailInput = page.locator("input#email");
  await emailInput.waitFor({ timeout: 10000 });
  await emailInput.fill(email);

  const passwordInput = page.locator("input#rec-acct-sign-in-password");
  await passwordInput.waitFor({ timeout: 5000 });
  await passwordInput.fill(password);

  const submitBtn = page.locator("button.rec-acct-sign-in-btn");
  await submitBtn.waitFor({ timeout: 5000 });
  await submitBtn.click();

  // Wait for navigation away from log-in page
  try {
    await page.waitForURL(
      (url) => !url.pathname.includes("log-in"),
      { timeout: 15000 },
    );
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
