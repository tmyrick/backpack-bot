import { firefox, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { SniperJob, SniperJobRequest, DateRange } from "../types/index.js";
import {
  buildRecDateAttempts as buildRecDateAttemptsCore,
  computeJitteredPollInterval,
  computePermitAvailabilityQueryWindow,
  escapeRegExp,
  expandRange,
  findFirstFullyAvailableRange,
  findFirstRangeAcrossPermitDivisions,
  humanDelayMs,
  resolveNightsToClickInBrowser,
  uniqueStringsPreserveOrder,
  type RecDateAttempt,
} from "./sniper-logic.js";

export type { SniperJob, SniperJobRequest, DateRange };

type SniperJobOnDisk = Omit<SniperJob, never>;

/** Read recreation.gov credentials from environment variables */
function getRecgovCredentials(): { email: string; password: string } {
  const rawEmail = process.env.RECGOV_EMAIL;
  const rawPassword = process.env.RECGOV_PASSWORD;
  if (!rawEmail || !rawPassword) {
    throw new Error(
      "RECGOV_EMAIL and RECGOV_PASSWORD environment variables are required for sniper jobs",
    );
  }
  const email = rawEmail.trim();
  const password = rawPassword.trim();
  const masked = email.length > 2 ? `${email[0]}***@${email.split("@").pop()}` : "***";
  console.log(`[sniper] Using credentials for ${masked} (len=${email.length})`);
  return { email, password };
}

// ---- Constants ----

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "../../../../data");
const JOBS_FILE = path.join(DATA_DIR, "sniper-jobs.json");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");

const PRE_WARM_LEAD_MS = 2 * 60 * 1000; // 2 minutes before window
/** After wall-clock window time, wait this long before reload + browser booking (inventory flip on server). */
const POST_WINDOW_BEFORE_RELOAD_MS = 2_000;
const POLL_INTERVAL_MS = 4_000; // 4 seconds base — jittered in practice
const MAX_WATCH_DURATION_MS = 60 * 1000; // 60 seconds of polling
/** If still not in-cart after this (from run start): abort and close browser — avoids multi-hour pre-cart runs. */
const SNIPER_PRE_CART_MAX_RUNTIME_MS = 90 * 60 * 1000;
/** Hard cap from run start: ends cart keep-alive and closes browser (e.g. 4h total session). */
const SNIPER_JOB_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;
const RECGOV_API = "https://www.recreation.gov/api/permits";

const FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0";

/**
 * Launch Firefox with stealth settings to avoid bot detection.
 * Recreation.gov explicitly whitelists Firefox, eliminating the "outdated browser" banner.
 * Supports optional proxy via PROXY_SERVER env var (e.g. "http://user:pass@host:port").
 */
async function launchStealthBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const proxyServer = process.env.PROXY_SERVER;
  let proxyConfig: { server: string; username?: string; password?: string } | undefined;
  if (proxyServer) {
    try {
      const url = new URL(proxyServer);
      let username = decodeURIComponent(url.username);
      if (username && !username.includes("-session-")) {
        username += `-session-${crypto.randomUUID().slice(0, 8)}`;
      }
      proxyConfig = {
        server: `${url.protocol}//${url.hostname}:${url.port}`,
        ...(username ? { username } : {}),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      };
      console.log(`[sniper] Proxy session: ${username.split("-session-")[1] || "none"}`);
    } catch {
      proxyConfig = { server: proxyServer };
    }
  }

  const headless = process.env.HEADLESS !== "false" && process.env.HEADLESS !== "0";
  const browser = await firefox.launch({
    headless,
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
  });
  const headed = !headless;
  const visualClicks =
    headed &&
    (process.env.VISUAL_CLICKS === "true" || process.env.VISUAL_CLICKS === "1");
  console.log(
    "[sniper] Launched Firefox" +
      (headless ? " (headless)" : " (headed)") +
      (proxyServer ? " via proxy" : "") +
      (visualClicks ? " (VISUAL_CLICKS pulse on clicks)" : ""),
  );

  const context = await browser.newContext({
    userAgent: FIREFOX_UA,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    ignoreHTTPSErrors: !!proxyServer,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

// ---- In-memory state ----

const jobs = new Map<string, SniperJob>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const browsers = new Map<string, { browser: Browser; page: Page }>();
const abortControllers = new Map<string, AbortController>();

/** Pre-cart + hard max timers + optional cart keep-alive stopper. */
const sniperMaxRuntimeWatchers = new Map<
  string,
  {
    preCartTimer: ReturnType<typeof setTimeout>;
    maxRuntimeTimer: ReturnType<typeof setTimeout>;
    stopCartKeepAlive?: () => void;
  }
>();

function startSniperMaxRuntimeWatch(job: SniperJob): void {
  clearSniperMaxRuntimeWatch(job.id);
  const preCartTimer = setTimeout(() => {
    void enforceSniperPreCartMaxRuntimeLimit(job.id);
  }, SNIPER_PRE_CART_MAX_RUNTIME_MS);
  const maxRuntimeTimer = setTimeout(() => {
    void enforceSniperMaxRuntimeLimit(job.id);
  }, SNIPER_JOB_MAX_RUNTIME_MS);
  sniperMaxRuntimeWatchers.set(job.id, { preCartTimer, maxRuntimeTimer });
}

function registerCartKeepAliveStopper(jobId: string, stop: () => void): void {
  const entry = sniperMaxRuntimeWatchers.get(jobId);
  if (entry) {
    entry.stopCartKeepAlive = stop;
  }
}

function clearSniperMaxRuntimeWatch(jobId: string): void {
  const entry = sniperMaxRuntimeWatchers.get(jobId);
  if (!entry) return;
  clearTimeout(entry.preCartTimer);
  clearTimeout(entry.maxRuntimeTimer);
  entry.stopCartKeepAlive?.();
  sniperMaxRuntimeWatchers.delete(jobId);
}

/** Abort in-flight work, stop keep-alive, close browser; clears runtime watchers. */
async function forceSniperRuntimeShutdown(jobId: string): Promise<void> {
  clearSniperMaxRuntimeWatch(jobId);
  const ac = abortControllers.get(jobId);
  if (ac) {
    ac.abort();
    abortControllers.delete(jobId);
  }
  const b = browsers.get(jobId);
  if (b) {
    try {
      await b.browser.close();
    } catch {
      /* ignore */
    }
    browsers.delete(jobId);
  }
}

/** Fires at SNIPER_PRE_CART_MAX_RUNTIME_MS; no-op if already in-cart (4h limit still applies). */
async function enforceSniperPreCartMaxRuntimeLimit(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job || job.status === "in-cart") {
    return;
  }
  await forceSniperRuntimeShutdown(jobId);
  const j = jobs.get(jobId);
  if (j && j.status !== "cancelled") {
    const mins = Math.round(SNIPER_PRE_CART_MAX_RUNTIME_MS / 60_000);
    updateJob(j, {
      status: "failed",
      message: `Stopped after ${mins} min pre-cart limit (never reached cart). Window wait, booking, or polling took too long.`,
    });
    await saveJobs();
  }
}

async function enforceSniperMaxRuntimeLimit(jobId: string): Promise<void> {
  await forceSniperRuntimeShutdown(jobId);
  const job = jobs.get(jobId);
  if (job && job.status !== "cancelled") {
    const hours = SNIPER_JOB_MAX_RUNTIME_MS / 3_600_000;
    updateJob(job, {
      status: "failed",
      message: `Stopped after ${hours}h safety limit (browser closed; cart keep-alive ended). If something was in your cart, finish checkout on recreation.gov.`,
    });
    await saveJobs();
  }
}

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
    bookingType: req.bookingType || "permit",
    permitId: req.permitId || "",
    permitName: req.permitName || "",
    divisionId: req.divisionId || "",
    startingArea: req.startingArea || "",
    trailheadName: req.trailheadName || "",
    campgroundId: req.campgroundId || "",
    campgroundName: req.campgroundName || "",
    campgroundIsPermit: req.campgroundIsPermit || false,
    campsiteId: req.campsiteId || "",
    bookedCampsiteId: "",
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

  clearSniperMaxRuntimeWatch(id);

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
    // Backward-compat: old jobs without bookingType default to "permit"
    if (!dj.bookingType) dj.bookingType = "permit";
    if (!dj.campgroundId) dj.campgroundId = "";
    if (!dj.campgroundName) dj.campgroundName = "";
    if (dj.campgroundIsPermit === undefined) dj.campgroundIsPermit = false;
    if (!dj.campsiteId) dj.campsiteId = "";
    if (!dj.bookedCampsiteId) dj.bookedCampsiteId = "";
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
  for (const [, entry] of sniperMaxRuntimeWatchers) {
    clearTimeout(entry.preCartTimer);
    clearTimeout(entry.maxRuntimeTimer);
    entry.stopCartKeepAlive?.();
  }
  sniperMaxRuntimeWatchers.clear();

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
  const bookingType = job.bookingType || "permit";
  if (bookingType === "campsite") {
    return runCampsiteSniperJob(job);
  }
  return runPermitSniperJob(job);
}

// ---- Permit sniper flow (original) ----

async function runPermitSniperJob(job: SniperJob): Promise<void> {
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
  startSniperMaxRuntimeWatch(job);

  try {
    // ---- Phase 1: Pre-warm ----
    updateJob(job, {
      status: "pre-warming",
      message: "Launching browser and signing in...",
    });
    await saveJobs();

    await logStepTiming(job, "launch browser", async () => {
      const { browser: b, page: p } = await launchStealthBrowser();
      browsers.set(job.id, { browser: b, page: p });
    });
    const { page } = browsers.get(job.id)!;

    if (signal.aborted) return;

    jobLog(job, "Starting sign-in...");
    await logStepTiming(job, "sign-in", () =>
      signIn(page, creds.email, creds.password, job),
    );
    jobLog(job, "Sign-in complete. Current URL:", page.url());
    if (signal.aborted) return;

    const firstRange = job.desiredDateRanges[0];
    const permitUrl = `https://www.recreation.gov/permits/${job.permitId}/registration/detailed-availability?date=${firstRange.startDate}&type=overnight`;
    jobLog(job, "Navigating to permit page:", permitUrl);
    await logStepTiming(job, "goto permit page + hydrate", async () => {
      await safeGoto(page, job, permitUrl, "permit-page-prewarm");
    });
    jobLog(job, "Permit page loaded. URL:", page.url());

    if (signal.aborted) return;

    try {
      jobLog(job, `Attempting to set group size during pre-warm (may not be available yet)...`);
      await logStepTiming(job, "set group size (pre-warm)", () =>
        setGroupSize(page, job),
      );

      if (job.startingArea) {
        await logStepTiming(job, "click starting area filter (pre-warm)", () =>
          clickStartingAreaFilter(page, job),
        );
      }
    } catch {
      jobLog(job, "Group size / starting area not available during pre-warm (window likely not open yet). Will set during booking.");
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

    // ---- Phase 2a: Window just opened — brief settle, then refresh UI and book (don't wait on API first) ----
    updateJob(job, {
      status: "watching",
      message: `Window open! Waiting ${POST_WINDOW_BEFORE_RELOAD_MS / 1000}s, then reloading and booking in the browser...`,
    });
    await saveJobs();
    await sleep(POST_WINDOW_BEFORE_RELOAD_MS, signal);
    if (signal.aborted) return;

    jobLog(job, "Post-window: reloading detailed availability for a fresh grid (API poll runs after this if needed).");
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await dismissOutdatedBrowserBanner(page);
      await page.waitForTimeout(humanDelay(150, 350));
    } catch (err) {
      jobLog(job, "Post-window reload failed:", err instanceof Error ? err.message : err);
    }

    for (const immediateRange of job.desiredDateRanges) {
      if (signal.aborted) return;
      updateJob(job, {
        status: "booking",
        message: `Trying ${immediateRange.startDate} - ${immediateRange.endDate} in browser right after window open...`,
      });
      await saveJobs();
      const immediateResult = await attemptBrowserBooking(page, job, immediateRange, creds);
      if (immediateResult === "booked") {
        updateJob(job, {
          status: "in-cart",
          bookedRange: immediateRange,
          message: `Permit for ${immediateRange.startDate} - ${immediateRange.endDate} added to cart! Complete your purchase on recreation.gov.`,
        });
        await saveJobs();
        return;
      }
    }

    jobLog(job, "Immediate post-window browser attempt(s) did not finish booking; polling availability API with retries...");

    // ---- Phase 2b: Watch (poll availability API) ----
    updateJob(job, {
      message: "Polling for availability (browser will retry when API sees openings)...",
    });
    await saveJobs();

    const watchDeadline = Date.now() + MAX_WATCH_DURATION_MS;
    let foundRange: DateRange | null = null;

    while (!signal.aborted && Date.now() < watchDeadline) {
      job.attempts++;
      try {
        if (job.startingArea && !job.divisionId) {
          foundRange = await checkPermitFacilityAvailability(
            job.permitId,
            job.desiredDateRanges,
          );
        } else if (job.startingArea && job.divisionId) {
          foundRange = await checkAvailability(
            job.permitId,
            job.divisionId,
            job.desiredDateRanges,
          );
          if (!foundRange) {
            foundRange = await checkPermitFacilityAvailability(
              job.permitId,
              job.desiredDateRanges,
            );
          }
        } else {
          foundRange = await checkAvailability(
            job.permitId,
            job.divisionId,
            job.desiredDateRanges,
          );
        }
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

      await sleep(jitteredPollInterval(), signal);
    }

    if (signal.aborted) return;

    if (!foundRange) {
      // No availability detected for any range. Try fallback: attempt browser booking
      // for each range anyway (API may be stale, or UI may show different availability).
      jobLog(job, `No availability in API after ${job.attempts} polls. Trying fallback: attempt browser booking for each date range...`);
      for (const fallbackRange of job.desiredDateRanges) {
        if (signal.aborted) return;

        updateJob(job, {
          status: "booking",
          message: `No API availability. Trying ${fallbackRange.startDate} - ${fallbackRange.endDate} via browser...`,
        });
        await saveJobs();

        const result = await attemptBrowserBooking(page, job, fallbackRange, creds);
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

      updateJob(job, {
        status: "failed",
        message: `No availability detected after ${job.attempts} polls (${MAX_WATCH_DURATION_MS / 1000}s). Tried all ${job.desiredDateRanges.length} date range(s) via browser. Window may have passed.`,
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

    const bookResult = await attemptBrowserBooking(page, job, foundRange, creds);

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

      let available: DateRange | null = null;
      if (job.startingArea && !job.divisionId) {
        available = await checkPermitFacilityAvailability(job.permitId, [fallbackRange]);
      } else {
        available = await checkAvailability(job.permitId, job.divisionId, [fallbackRange]);
        if (!available && job.startingArea) {
          available = await checkPermitFacilityAvailability(job.permitId, [fallbackRange]);
        }
      }
      if (!available) continue;

      updateJob(job, {
        message: `Primary range taken. Trying fallback: ${fallbackRange.startDate} - ${fallbackRange.endDate}...`,
      });

      const result = await attemptBrowserBooking(page, job, fallbackRange, creds);
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

    if (job.status !== "in-cart") {
      clearSniperMaxRuntimeWatch(job.id);
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

// ---- Campsite sniper flow ----

async function runCampsiteSniperJob(job: SniperJob): Promise<void> {
  let creds: { email: string; password: string };
  try {
    creds = getRecgovCredentials();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateJob(job, { status: "failed", message: msg });
    return;
  }

  const ac = new AbortController();
  abortControllers.set(job.id, ac);
  const { signal } = ac;
  startSniperMaxRuntimeWatch(job);

  try {
    // ---- Phase 1: Pre-warm ----
    updateJob(job, {
      status: "pre-warming",
      message: "Launching browser and signing in...",
    });
    await saveJobs();

    await logStepTiming(job, "launch browser", async () => {
      const { browser: b, page: p } = await launchStealthBrowser();
      browsers.set(job.id, { browser: b, page: p });
    });
    const { page } = browsers.get(job.id)!;

    if (signal.aborted) return;

    jobLog(job, "Starting sign-in...");
    await logStepTiming(job, "sign-in", () =>
      signIn(page, creds.email, creds.password, job),
    );
    jobLog(job, "Sign-in complete. Current URL:", page.url());
    if (signal.aborted) return;

    // Always try permits path first, fall back to campgrounds path
    const firstRange = job.desiredDateRanges[0];
    let campUrl = `https://www.recreation.gov/permits/${job.campgroundId}/registration/detailed-availability?date=${firstRange.startDate}&type=overnight`;
    jobLog(job, "Navigating to:", campUrl);

    let navResult = await logStepTiming(job, "goto facility page + hydrate", async () => {
      return await safeGoto(page, job, campUrl, "campground-page-prewarm");
    });

    if (navResult?.is404) {
      jobLog(job, "Permit URL returned 404. Falling back to campground URL...");
      campUrl = `https://www.recreation.gov/camping/campgrounds/${job.campgroundId}/availability`;
      jobLog(job, "Navigating to campground URL:", campUrl);
      navResult = await logStepTiming(job, "goto campground page (fallback) + hydrate", async () => {
        return await safeGoto(page, job, campUrl, "campground-page-fallback");
      });
    } else {
      job.campgroundIsPermit = true;
      await saveJobs();
    }

    if (job.campgroundIsPermit) {
      try {
        jobLog(job, `Attempting to set group size during pre-warm (may not be available yet)...`);
        await logStepTiming(job, "set group size (pre-warm)", () =>
          setGroupSize(page, job),
        );
      } catch {
        jobLog(job, "Group size not available during pre-warm (window likely not open yet). Will set during booking.");
      }
    }

    if (signal.aborted) return;

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

    // ---- Phase 2: Watch (poll campsite availability API) ----
    updateJob(job, {
      status: "watching",
      message: job.campgroundIsPermit
        ? "Window open! Reloading and trying the browser first..."
        : "Window open! Polling campsite availability...",
    });
    await saveJobs();

    const watchDeadline = Date.now() + MAX_WATCH_DURATION_MS;

    if (job.campgroundIsPermit) {
      updateJob(job, {
        message: `Window open! Waiting ${POST_WINDOW_BEFORE_RELOAD_MS / 1000}s, then reloading and booking...`,
      });
      await saveJobs();
      await sleep(POST_WINDOW_BEFORE_RELOAD_MS, signal);
      if (signal.aborted) return;

      jobLog(job, "Post-window: reloading permit-style facility page before first browser booking attempt.");
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        await dismissOutdatedBrowserBanner(page);
        await page.waitForTimeout(humanDelay(150, 350));
      } catch (err) {
        jobLog(job, "Post-window reload failed:", err instanceof Error ? err.message : err);
      }

      for (const immediateRange of job.desiredDateRanges) {
        if (signal.aborted) return;
        updateJob(job, {
          status: "booking",
          message: `Trying ${immediateRange.startDate} - ${immediateRange.endDate} in browser right after window open...`,
        });
        await saveJobs();
        const immediateResult = await attemptBrowserBooking(page, job, immediateRange, creds);
        if (immediateResult === "booked") {
          updateJob(job, {
            status: "in-cart",
            bookedRange: immediateRange,
            message: `${job.campgroundName} for ${immediateRange.startDate} - ${immediateRange.endDate} added to cart! Complete your purchase on recreation.gov.`,
          });
          await saveJobs();
          return;
        }
      }

      jobLog(job, "Immediate post-window browser attempt(s) did not finish booking; polling permit availability API...");

      updateJob(job, {
        message: "Polling for availability (browser will retry when API sees openings)...",
      });
      await saveJobs();

      // ---- Permit-type facility: use permit availability API ----
      let foundRange: DateRange | null = null;

      while (!signal.aborted && Date.now() < watchDeadline) {
        job.attempts++;
        try {
          // For permit facilities, divisionId may be empty -- pass campgroundId as permitId
          // and use empty divisionId to check overall facility availability
          foundRange = await checkPermitFacilityAvailability(
            job.campgroundId,
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
          message: `Poll #${job.attempts}: No availability yet. Retrying...`,
        });
        await sleep(jitteredPollInterval(), signal);
      }

      if (signal.aborted) return;

      if (!foundRange) {
        updateJob(job, {
          status: "failed",
          message: `No availability detected after ${job.attempts} polls (${MAX_WATCH_DURATION_MS / 1000}s).`,
        });
        await saveJobs();
        return;
      }

      // ---- Book using the permit flow ----
      updateJob(job, {
        status: "booking",
        message: `Booking ${foundRange.startDate} - ${foundRange.endDate}...`,
      });
      await saveJobs();

      const bookResult = await attemptBrowserBooking(page, job, foundRange, creds);

      if (bookResult === "booked") {
        updateJob(job, {
          status: "in-cart",
          bookedRange: foundRange,
          message: `${job.campgroundName} for ${foundRange.startDate} - ${foundRange.endDate} added to cart! Complete your purchase on recreation.gov.`,
        });
        await saveJobs();
        return;
      }

      // Try fallback ranges
      const remainingPermitRanges = job.desiredDateRanges.filter(
        (r) => r.startDate !== foundRange!.startDate || r.endDate !== foundRange!.endDate,
      );
      for (const fallbackRange of remainingPermitRanges) {
        if (signal.aborted) return;
        const available = await checkPermitFacilityAvailability(job.campgroundId, [fallbackRange]);
        if (!available) continue;

        updateJob(job, {
          message: `Primary range taken. Trying fallback: ${fallbackRange.startDate} - ${fallbackRange.endDate}...`,
        });
        const result = await attemptBrowserBooking(page, job, fallbackRange, creds);
        if (result === "booked") {
          updateJob(job, {
            status: "in-cart",
            bookedRange: fallbackRange,
            message: `${job.campgroundName} for ${fallbackRange.startDate} - ${fallbackRange.endDate} (fallback) added to cart!`,
          });
          await saveJobs();
          return;
        }
      }

      updateJob(job, {
        status: "failed",
        message: `Could not book any of the desired date ranges after ${job.attempts} attempts.`,
      });
    } else {
      // ---- True campground: use camps availability API ----
      let found: CampsiteAvailabilityResult | null = null;

      while (!signal.aborted && Date.now() < watchDeadline) {
        job.attempts++;
        try {
          found = await checkCampsiteAvailability(
            job.campgroundId,
            job.campsiteId,
            job.desiredDateRanges,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          updateJob(job, {
            message: `Poll #${job.attempts}: API error (${msg}). Retrying...`,
          });
        }

        if (found) {
          const siteLabel = job.campsiteId ? `site ${found.siteName}` : `site ${found.siteName} (auto-selected)`;
          updateJob(job, {
            message: `Availability detected on ${siteLabel} for ${found.range.startDate} - ${found.range.endDate}! Booking...`,
          });
          break;
        }

        updateJob(job, {
          message: `Poll #${job.attempts}: No availability yet. Retrying...`,
        });
        await sleep(jitteredPollInterval(), signal);
      }

      if (signal.aborted) return;

      if (!found) {
        updateJob(job, {
          status: "failed",
          message: `No campsite availability detected after ${job.attempts} polls (${MAX_WATCH_DURATION_MS / 1000}s).`,
        });
        await saveJobs();
        return;
      }

      // ---- Phase 3: Book ----
      updateJob(job, {
        status: "booking",
        message: `Booking campsite ${found.siteName} for ${found.range.startDate} - ${found.range.endDate}...`,
      });
      await saveJobs();

      const bookResult = await attemptCampsiteBooking(page, job, found.range, found.campsiteId, creds);

      if (bookResult === "booked") {
        updateJob(job, {
          status: "in-cart",
          bookedRange: found.range,
          bookedCampsiteId: found.campsiteId,
          message: `Campsite ${found.siteName} for ${found.range.startDate} - ${found.range.endDate} added to cart! Complete your purchase on recreation.gov.`,
        });
        await saveJobs();
        return;
      }

      // Try fallback ranges/sites
      const remainingRanges = job.desiredDateRanges.filter(
        (r) => r.startDate !== found!.range.startDate || r.endDate !== found!.range.endDate,
      );
      for (const fallbackRange of remainingRanges) {
        if (signal.aborted) return;

        const fallback = await checkCampsiteAvailability(
          job.campgroundId,
          job.campsiteId,
          [fallbackRange],
        );
        if (!fallback) continue;

        updateJob(job, {
          message: `Primary range taken. Trying fallback: ${fallbackRange.startDate} - ${fallbackRange.endDate} on site ${fallback.siteName}...`,
        });

        const result = await attemptCampsiteBooking(page, job, fallbackRange, fallback.campsiteId, creds);
        if (result === "booked") {
          updateJob(job, {
            status: "in-cart",
            bookedRange: fallbackRange,
            bookedCampsiteId: fallback.campsiteId,
            message: `Campsite ${fallback.siteName} for ${fallbackRange.startDate} - ${fallbackRange.endDate} (fallback) added to cart!`,
          });
          await saveJobs();
          return;
        }
      }

      updateJob(job, {
        status: "failed",
        message: `Could not book any campsite after ${job.attempts} attempts.`,
      });
    }
    await saveJobs();
  } catch (err) {
    if (signal.aborted) return;
    const msg = err instanceof Error ? err.message : "unknown error";
    updateJob(job, {
      status: "failed",
      message: `Campsite sniper failed: ${msg}`,
    });
    await saveJobs();
  } finally {
    abortControllers.delete(job.id);

    if (job.status !== "in-cart") {
      clearSniperMaxRuntimeWatch(job.id);
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
 * Dates to click in the permit grid. Production: every night in [startDate, endDate).
 * VISUAL_CLICKS: the range's startDate and endDate columns (as the user picked them), not interior nights —
 * e.g. Fri–Sun with endDate Sunday clicks Friday then Sunday, not Saturday.
 */
function nightsToClickInBrowser(range: DateRange): string[] {
  return resolveNightsToClickInBrowser(range, visualClicksEnabled());
}

async function checkAvailability(
  permitId: string,
  divisionId: string,
  ranges: DateRange[],
): Promise<DateRange | null> {
  const { queryStartIso, queryEndIso } = computePermitAvailabilityQueryWindow(ranges);
  const url = `${RECGOV_API}/${permitId}/availability?start_date=${queryStartIso}&end_date=${queryEndIso}&commercial_acct=false`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": FIREFOX_UA,
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

  const availByDate = new Map<string, number>();
  for (const [isoDate, avail] of Object.entries(division.date_availability)) {
    availByDate.set(isoDate.substring(0, 10), avail.remaining);
  }

  return findFirstFullyAvailableRange(ranges, availByDate);
}

/**
 * Check availability across ALL divisions of a permit facility.
 * Used when a "campground" in the UI is actually a permit-type facility.
 */
async function checkPermitFacilityAvailability(
  permitId: string,
  ranges: DateRange[],
): Promise<DateRange | null> {
  const { queryStartIso, queryEndIso } = computePermitAvailabilityQueryWindow(ranges);
  const url = `${RECGOV_API}/${permitId}/availability?start_date=${queryStartIso}&end_date=${queryEndIso}&commercial_acct=false`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": FIREFOX_UA,
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

  return findFirstRangeAcrossPermitDivisions(ranges, data.payload.availability);
}

// ---- Campsite availability polling (direct API, no browser) ----

const RECGOV_CAMPS_API = "https://www.recreation.gov/api/camps/availability/campground";

interface CampsiteAvailabilityResult {
  range: DateRange;
  campsiteId: string;
  siteName: string;
}

/**
 * Check campsite availability for a given campground.
 * Uses recreation.gov's undocumented camps availability API.
 *
 * If campsiteId is provided, checks only that campsite.
 * If campsiteId is empty, checks all campsites and returns the first fully-available one.
 */
async function checkCampsiteAvailability(
  campgroundId: string,
  campsiteId: string,
  ranges: DateRange[],
): Promise<CampsiteAvailabilityResult | null> {
  const allStartDates = ranges.map((r) => r.startDate).sort();
  const allEndDates = ranges.map((r) => r.endDate).sort();

  // We need to query each month that overlaps the desired ranges
  const startMonth = allStartDates[0].substring(0, 7);
  const endMonth = allEndDates[allEndDates.length - 1].substring(0, 7);

  // Collect availabilities across months
  const campsiteAvail = new Map<string, { availabilities: Record<string, string>; site: string }>();

  let currentMonth = startMonth;
  while (currentMonth <= endMonth) {
    const [y, m] = currentMonth.split("-").map(Number);
    const startDate = new Date(Date.UTC(y, m - 1, 1)).toISOString();

    const url = `${RECGOV_CAMPS_API}/${campgroundId}/month?start_date=${encodeURIComponent(startDate)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": FIREFOX_UA,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      campsites: Record<
        string,
        {
          availabilities: Record<string, string>;
          campsite_id: string;
          site: string;
        }
      >;
    };

    for (const [csId, cs] of Object.entries(data.campsites)) {
      const existing = campsiteAvail.get(csId);
      if (existing) {
        Object.assign(existing.availabilities, cs.availabilities);
      } else {
        campsiteAvail.set(csId, {
          availabilities: { ...cs.availabilities },
          site: cs.site,
        });
      }
    }

    // Advance to next month
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    currentMonth = `${nextY}-${String(nextM).padStart(2, "0")}`;
  }

  // Filter to target campsite if specified
  const candidates = campsiteId
    ? [[campsiteId, campsiteAvail.get(campsiteId)] as const].filter(([, v]) => v)
    : Array.from(campsiteAvail.entries());

  // Check ranges in priority order
  for (const range of ranges) {
    const nights = expandRange(range);
    if (nights.length === 0) {
      continue;
    }

    for (const [csId, cs] of candidates) {
      if (!cs) continue;
      const allAvailable = nights.every((d) => {
        const isoKey = `${d}T00:00:00Z`;
        return cs.availabilities[isoKey] === "Available";
      });

      if (allAvailable) {
        return { range, campsiteId: csId, siteName: cs.site };
      }
    }
  }

  return null;
}

// ---- Debug helpers ----

function jobLog(job: SniperJob, ...args: unknown[]): void {
  console.log(`[sniper:${job.id.slice(0, 8)}]`, ...args);
}

/** Run an async step and log how long it took. */
async function logStepTiming<T>(
  job: SniperJob,
  stepName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - start);
    jobLog(job, `⏱ ${stepName}: ${ms} ms`);
    return result;
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    jobLog(job, `⏱ ${stepName}: ${ms} ms (failed)`);
    throw err;
  }
}

async function saveScreenshot(
  page: Page,
  job: SniperJob | null,
  label: string,
): Promise<string | null> {
  try {
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const idPart = job ? job.id.slice(0, 8) : "login";
    const filename = `${timestamp}_${idPart}-${label}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    if (job) jobLog(job, `Screenshot saved: data/screenshots/${filename}`);
    else console.log(`[sniper] Screenshot saved: data/screenshots/${filename}`);
    return filepath;
  } catch (err) {
    if (job) jobLog(job, "Failed to save screenshot:", err);
    else console.log("[sniper] Failed to save screenshot:", err);
    return null;
  }
}

/**
 * Check if the user appears to be logged in (User button in header visible).
 */
async function isLoggedIn(page: Page): Promise<boolean> {
  return page.locator('[aria-label^="User:"]').first().isVisible({ timeout: 2000 }).catch(() => false);
}

/**
 * Ensure we're logged in. If not, sign in and optionally navigate to resumeUrl.
 * Returns true if we had to re-authenticate (caller may need to retry/restore state).
 */
async function ensureLoggedIn(
  page: Page,
  job: SniperJob,
  creds: { email: string; password: string },
  opts?: { resumeUrl?: string },
): Promise<boolean> {
  if (await isLoggedIn(page)) return false;

  jobLog(job, "Session expired detected. Re-authenticating...");
  await saveScreenshot(page, job, "session-expired-before-reauth");

  try {
    await signIn(page, creds.email, creds.password, job);
    jobLog(job, "Re-authentication succeeded.");
    await saveScreenshot(page, job, "reauth-success");

    if (opts?.resumeUrl) {
      jobLog(job, "Resuming at:", opts.resumeUrl);
      await safeGoto(page, job, opts.resumeUrl, "resume-after-reauth");
      await page.waitForTimeout(humanDelay(300, 600));
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "Re-authentication failed:", msg);
    await saveScreenshot(page, job, "reauth-failed");
    throw err;
  }
}

/**
 * Detect a login modal/form that recreation.gov shows when the session expires.
 * Instead of trying to re-auth inside the unreliable modal, navigates to the
 * full login page and uses the proven signIn() flow.
 * Returns true if login was needed (caller should retry booking steps).
 */
async function handleLoginModal(page: Page, job: SniperJob): Promise<boolean> {
  const loginModal = page.locator('input#email, input[type="email"]').first();
  const isLoginVisible = await loginModal.isVisible({ timeout: 2000 }).catch(() => false);

  if (!isLoginVisible) return false;

  const hasPassword = await page.locator('input#rec-acct-sign-in-password, input[type="password"]')
    .first().isVisible().catch(() => false);
  if (!hasPassword) return false;

  jobLog(job, "Login modal detected after booking action. Re-authenticating via full login page...");
  await saveScreenshot(page, job, "login-modal-detected");

  const creds = getRecgovCredentials();

  try {
    await signIn(page, creds.email, creds.password, job);
    jobLog(job, "Re-authentication via full login page succeeded.");
    await saveScreenshot(page, job, "reauth-success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "Re-authentication via full login failed:", msg);
    await saveScreenshot(page, job, "reauth-failed");
  }

  return true;
}

async function dismissOutdatedBrowserBanner(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const buorg = document.getElementById("buorg");
      if (buorg) buorg.remove();
    });
  } catch {
    // Banner not present, that's fine
  }
}

/**
 * Check if the "abnormal activity" error banner is present on the page.
 */
async function hasAbnormalActivityError(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    return text.includes("abnormal activity from your computer network");
  });
}

/**
 * Random delay between min and max ms to mimic human behavior.
 */
function humanDelay(min = 150, max = 400): number {
  return humanDelayMs(min, max, Math.random);
}

/** Return a jittered poll interval (±30% around POLL_INTERVAL_MS). */
function jitteredPollInterval(): number {
  return computeJitteredPollInterval(POLL_INTERVAL_MS, Math.random);
}

function visualClicksEnabled(): boolean {
  const headed = process.env.HEADLESS === "false" || process.env.HEADLESS === "0";
  const want = process.env.VISUAL_CLICKS === "true" || process.env.VISUAL_CLICKS === "1";
  return headed && want;
}

/** Normal runs exclude disabled cells; headed VISUAL_CLICKS includes them so pulses and click attempts can run for debugging. */
function dateCellDisabledSelectorClause(): string {
  return visualClicksEnabled() ? "" : ":not([disabled])";
}

function recAvailabilityButtonLocator(page: Page): ReturnType<Page["locator"]> {
  return visualClicksEnabled()
    ? page.locator("button.rec-availability-date")
    : page.locator("button.rec-availability-date:not([disabled])");
}

/**
 * Production: recreation.gov uses `{Trail} on March 20, 2026 - Available|Unavailable`. Matching `(?=.*Available)`
 * wrongly matches inside "Unavailable". We require ` - Available` instead.
 *
 * VISUAL_CLICKS: only trail + date or date alone — ignore - Available / - Unavailable for headed debugging.
 */
function buildRecDateAttempts(job: SniperJob, rowTrailOverride?: string): RecDateAttempt[] {
  return buildRecDateAttemptsCore(job, visualClicksEnabled(), rowTrailOverride);
}

function locatorForRecDateAttempt(page: Page, ariaDateStr: string, attempt: RecDateAttempt): Locator {
  const dt = escapeRegExp(ariaDateStr);
  const parts = [`(?=.*${dt})`];
  if (attempt.trail) parts.push(`(?=.*${escapeRegExp(attempt.trail)})`);
  if (attempt.requireAvailableInName) parts.push(`(?=.*\\s-\\sAvailable)`);
  const pattern = new RegExp(parts.join(""), "i");
  const byName = page.getByRole("button", { name: pattern });
  if (attempt.recClassOnly) {
    return recAvailabilityButtonLocator(page).and(byName);
  }
  const base = visualClicksEnabled() ? page.locator("button") : page.locator("button:not([disabled])");
  return base.and(byName);
}

async function logAriaSamplesForRecDateButtons(
  page: Page,
  job: SniperJob,
  ariaDateStr: string,
  logPrefix: string,
): Promise<void> {
  const labels = (await page.evaluate(
    `((needle) => {
      var buttons = Array.from(document.querySelectorAll("button.rec-availability-date"));
      return buttons
        .map(function (b) { return (b.getAttribute("aria-label") || "").trim(); })
        .filter(function (t) { return t.length > 0; })
        .filter(function (t) { return t.toLowerCase().indexOf(String(needle).toLowerCase()) !== -1; })
        .slice(0, 14);
    })(${JSON.stringify(ariaDateStr)})`,
  )) as string[];
  jobLog(
    job,
    `${logPrefix}Sample .rec-availability-date aria-labels mentioning "${ariaDateStr}" (${labels.length} shown):`,
    labels.length ? labels : "(none — label text may differ or grid not loaded)",
  );
}

/** Trailhead names from data rows (Olympic detailed grid), DOM order. */
async function listDetailedGridTrailheadNames(page: Page): Promise<string[]> {
  const names = (await page.evaluate(`(() => {
    var grid = document.querySelector('[aria-label="Availability by Trailhead and Dates"]')
      || document.querySelector(".detailed-availability-grid-new");
    if (!grid) return [];
    var rows = grid.querySelectorAll('[data-testid="Row"]');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.querySelector("[data-testid=sortable-table-column-header]")) continue;
      var cell = row.querySelector('[data-testid="grid-cell"]');
      if (!cell) continue;
      var content = cell.querySelector(".sarsa-button-content");
      var name = (content && content.textContent ? content.textContent : cell.textContent || "").trim();
      if (name && out.indexOf(name) === -1) out.push(name);
    }
    return out;
  })()`)) as string[];
  return names;
}

/**
 * VISUAL: switch Olympic starting-area chips to a filter that shows every trailhead row
 * (second pass mimics production falling back beyond the selected area).
 */
async function visualExpandOlympicToAllRows(page: Page, job: SniperJob): Promise<boolean> {
  const patterns = [/^all$/i, /^all\s+areas?$/i, /^view\s+all/i, /^all\s+trailheads?$/i];
  const n = await page.locator("button.olympic-filter-button").count();
  for (let i = 0; i < n; i++) {
    const btn = page.locator("button.olympic-filter-button").nth(i);
    const text = ((await btn.textContent()) || "").replace(/\s+/g, " ").trim();
    if (!text || !patterns.some((p) => p.test(text))) continue;
    const pressed = await btn.getAttribute("aria-pressed");
    if (pressed === "true") {
      jobLog(
        job,
        `VISUAL: "${text}" starting-area control already selected — using current grid as full-row pass.`,
      );
      return true;
    }
    await clickLoc(page, btn, { timeout: 5000 });
    await page.waitForTimeout(humanDelay(200, 400));
    jobLog(job, `VISUAL: selected "${text}" so we can walk every trail row (fallback-style).`);
    return true;
  }
  jobLog(
    job,
    'VISUAL: no All / All areas Olympic filter found — only rows visible under the current starting area will be walked.',
  );
  return false;
}

async function clickDateCellsForPermitBookingOneRow(
  page: Page,
  job: SniperJob,
  nightDates: string[],
  logPrefix: string,
  rowTrailOverride?: string,
): Promise<number> {
  const attempts = buildRecDateAttempts(job, rowTrailOverride);
  const visual = visualClicksEnabled();
  let clickCount = 0;

  for (const nightDate of nightDates) {
    const d = new Date(nightDate + "T00:00:00");
    const monthName = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const dayOfMonth = d.getUTCDate();
    const year = d.getUTCFullYear();
    const ariaDateStr = `${monthName} ${dayOfMonth}, ${year}`;

    jobLog(job, `${logPrefix}Date ${nightDate} — accessible name contains "${ariaDateStr}"`);

    if (clickCount > 0) {
      await page.waitForTimeout(visual ? humanDelay(100, 300) : 50);
    }

    let clicked = false;
    for (const attempt of attempts) {
      const loc = locatorForRecDateAttempt(page, ariaDateStr, attempt);
      const n = await loc.count();
      if (n === 0) continue;
      jobLog(job, `${logPrefix}  ${attempt.label} — ${n} candidate(s)`);
      try {
        await humanClick(page, loc, {
          timeout: 5000,
          ...(visual
            ? { force: true, visualTight: clickCount > 0 }
            : {}),
        });
        clickCount++;
        clicked = true;
        jobLog(job, `${logPrefix}  clicked (${clickCount} total for this pass)`);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        jobLog(job, `${logPrefix}  ${attempt.label} failed: ${msg}`);
      }
    }

    if (!clicked) {
      jobLog(job, `${logPrefix}  no button clicked for ${nightDate}`);
      if (!visual && job.trailheadName?.trim()) {
        await logAriaSamplesForRecDateButtons(page, job, ariaDateStr, logPrefix);
      }
    }
  }

  return clickCount;
}

/**
 * Click date cells for permit detailed-availability. Production: one pass using job.trailheadName.
 * VISUAL_CLICKS: walk every visible row in order (preferred trailhead first), then if job.startingArea
 * is set, switch the Olympic filter toward “All” when possible and walk remaining rows — production-style
 * priority first, full fallback demo without stopping early.
 */
async function clickDateCellsForPermitBooking(
  page: Page,
  job: SniperJob,
  nightDates: string[],
  logPrefix = "",
): Promise<number> {
  const visual = visualClicksEnabled();

  if (!visual) {
    if (job.startingArea?.trim() && !job.trailheadName?.trim()) {
      jobLog(
        job,
        `${logPrefix}startingArea is set but trailheadName is empty — only the Olympic filter applies. Each night uses the first matching .rec-availability-date in DOM order. Pick a trailhead in the sniper UI to target that row by name.`,
      );
    }
    return clickDateCellsForPermitBookingOneRow(page, job, nightDates, logPrefix, undefined);
  }

  const preferTh = job.trailheadName?.trim() || "";
  const listedFiltered = await listDetailedGridTrailheadNames(page);

  let phaseStartingArea: string[];
  if (preferTh) {
    phaseStartingArea = uniqueStringsPreserveOrder([preferTh, ...listedFiltered.filter((r) => r !== preferTh)]);
  } else {
    phaseStartingArea = listedFiltered.length > 0 ? [...listedFiltered] : [""];
  }

  jobLog(
    job,
    `${logPrefix}VISUAL: pass 1 — ${job.startingArea?.trim() ? "rows under current starting area" : "all visible rows"} (${phaseStartingArea.length}):`,
    phaseStartingArea.map((r) => r || "(first column)").join(" → "),
  );

  let bestPartial = 0;
  let anyFull = false;

  const runVisualRowWalk = async (rows: string[], phaseTag: string) => {
    for (let ri = 0; ri < rows.length; ri++) {
      const rowTrail = rows[ri];
      jobLog(
        job,
        `${logPrefix}VISUAL: ${phaseTag} ${ri + 1}/${rows.length} — row "${rowTrail || "(first column)"}"`,
      );
      const count = await clickDateCellsForPermitBookingOneRow(
        page,
        job,
        nightDates,
        logPrefix,
        rowTrail === "" ? "" : rowTrail,
      );
      bestPartial = Math.max(bestPartial, count);
      if (count === nightDates.length) {
        anyFull = true;
      } else {
        jobLog(
          job,
          `${logPrefix}VISUAL: row incomplete (${count}/${nightDates.length}), continuing to next row...`,
        );
      }
      if (ri < rows.length - 1) {
        const gapMs =
          count === nightDates.length ? humanDelay(800, 1000) : humanDelay(50, 120);
        await page.waitForTimeout(gapMs);
      }
    }
  };

  await runVisualRowWalk(phaseStartingArea, "starting-area / primary order");

  if (job.startingArea?.trim()) {
    const expanded = await visualExpandOlympicToAllRows(page, job);
    if (expanded) {
      const listedAll = await listDetailedGridTrailheadNames(page);
      const already = new Set(
        phaseStartingArea.map((r) => r).filter((r) => r.length > 0),
      );
      const phaseFallback = listedAll.filter((name) => !already.has(name));
      if (phaseFallback.length > 0) {
        jobLog(
          job,
          `${logPrefix}VISUAL: pass 2 — fallback rows not in starting-area list (${phaseFallback.length}):`,
          phaseFallback.join(" → "),
        );
        await runVisualRowWalk(phaseFallback, "global fallback");
      } else {
        jobLog(
          job,
          `${logPrefix}VISUAL: pass 2 — no extra rows after expanding filter (same set as pass 1).`,
        );
      }
    }
  }

  return anyFull ? nightDates.length : bestPartial;
}

/** Brief on-page rectangle so headed debugging shows where the next click targets (bright magenta — not the OS mouse cursor). */
async function pulseClickArea(page: Page, target: Locator, pulseOpts?: { fast?: boolean }): Promise<void> {
  const box = await target.boundingBox();
  if (!box) return;
  // String body runs in the browser only (server tsconfig has no DOM lib).
  await page.evaluate(
    `(() => {
      const b = ${JSON.stringify(box)};
      const pad = 2;
      const el = document.createElement("div");
      el.setAttribute("data-sniper-click-pulse", "1");
      const s = el.style;
      s.position = "fixed";
      s.left = (b.x - pad) + "px";
      s.top = (b.y - pad) + "px";
      s.width = (b.width + pad * 2) + "px";
      s.height = (b.height + pad * 2) + "px";
      s.border = "4px solid rgb(255, 0, 160)";
      s.borderRadius = "8px";
      s.boxSizing = "border-box";
      s.pointerEvents = "none";
      s.zIndex = "2147483647";
      s.opacity = "1";
      s.transition = "opacity 0.45s ease-out";
      s.background = "rgba(255, 0, 160, 0.22)";
      s.boxShadow = "0 0 0 2px rgba(255, 255, 255, 0.9), 0 0 18px 4px rgba(255, 0, 160, 0.75)";
      document.body.appendChild(el);
      setTimeout(function () {
        s.opacity = "0";
      }, 220);
      setTimeout(function () { el.remove(); }, 750);
    })()`,
  );
  const visual = visualClicksEnabled();
  const ms = visual
    ? pulseOpts?.fast
      ? humanDelay(20, 38)
      : humanDelay(72, 108)
    : 280;
  await page.waitForTimeout(ms);
}

async function clickLoc(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  options?: Parameters<Locator["click"]>[0],
): Promise<void> {
  const target = locator.first();
  if (visualClicksEnabled()) await pulseClickArea(page, target);
  await target.click(options);
}

/**
 * Move the mouse to a locator's bounding box with slight randomness,
 * hover briefly (like a real user pausing before clicking), then click.
 */
async function humanClick(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  opts?: { timeout?: number; force?: boolean; visualTight?: boolean },
): Promise<void> {
  const target = locator.first();
  const visual = visualClicksEnabled();
  if (visual) {
    const tight = opts?.visualTight === true;
    const box = await target.boundingBox();
    if (box) {
      const rx = 0.35 + Math.random() * 0.3;
      const ry = 0.35 + Math.random() * 0.3;
      const steps = tight ? 1 + Math.floor(Math.random() * 2) : 3 + Math.floor(Math.random() * 4);
      await page.mouse.move(box.x + box.width * rx, box.y + box.height * ry, { steps });
    }
    await pulseClickArea(page, target, tight ? { fast: true } : undefined);
    await page.waitForTimeout(tight ? humanDelay(8, 28) : humanDelay(18, 48));
    await target.click({
      timeout: opts?.timeout ?? 5000,
      force: opts?.force === true,
    });
    return;
  }
  const box = await target.boundingBox();
  if (box) {
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
    await page.waitForTimeout(humanDelay(50, 150));
  }
  await target.click({ timeout: opts?.timeout ?? 5000 });
}

/**
 * Type text character-by-character with variable delay to mimic human typing.
 * @param opts.fast - Use shorter delays (18-45ms/char) for login etc.; default is 30-80ms
 * @param opts.clearFirst - Select-all and clear before typing
 */
async function humanType(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  text: string,
  opts?: { clearFirst?: boolean; fast?: boolean },
): Promise<void> {
  const field = locator.first();
  if (visualClicksEnabled()) await pulseClickArea(page, field);
  await field.click();
  await page.waitForTimeout(opts?.fast ? humanDelay(30, 70) : humanDelay(50, 120));
  if (opts?.clearFirst) {
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+a`);
    await page.waitForTimeout(opts?.fast ? humanDelay(30, 60) : humanDelay(50, 120));
  }
  const chars = text.split("");
  const delayMin = opts?.fast ? 18 : 30;
  const delayRange = opts?.fast ? 27 : 50;
  const pauseEvery = opts?.fast ? 12 + Math.floor(Math.random() * 6) : 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < chars.length; i++) {
    await page.keyboard.type(chars[i]);
    if (i < chars.length - 1) {
      const delayMs = delayMin + Math.floor(Math.random() * delayRange);
      await page.waitForTimeout(delayMs);
      if (i > 0 && i % pauseEvery === 0) {
        await page.waitForTimeout(opts?.fast ? humanDelay(20, 50) : humanDelay(50, 150));
      }
    }
  }
}

/**
 * Simulate light browsing — mouse moves and scroll to warm the page before interacting.
 * Keeps delays short to avoid slowing checkout.
 */
async function simulateBrowsing(page: Page): Promise<void> {
  const totalScroll = 120 + Math.floor(Math.random() * 180);
  const stepCount = 3 + Math.floor(Math.random() * 2);
  const stepSize = Math.floor(totalScroll / stepCount);

  // Mouse moves with minimal delay
  await page.mouse.move(
    350 + Math.floor(Math.random() * 300),
    250 + Math.floor(Math.random() * 150),
    { steps: 5 },
  );
  await page.waitForTimeout(humanDelay(25, 50));
  await page.mouse.move(
    400 + Math.floor(Math.random() * 200),
    350 + Math.floor(Math.random() * 100),
    { steps: 5 },
  );
  await page.waitForTimeout(humanDelay(25, 50));

  // Scroll down
  for (let i = 0; i < stepCount; i++) {
    await page.evaluate(`window.scrollBy({ top: ${stepSize}, behavior: "auto" })`);
    await page.waitForTimeout(humanDelay(25, 50));
  }
  await page.waitForTimeout(humanDelay(30, 60));

  // Scroll back up slightly
  const backSteps = Math.min(2, Math.floor(stepCount / 2));
  for (let i = 0; i < backSteps; i++) {
    await page.evaluate(`window.scrollBy({ top: ${-stepSize}, behavior: "auto" })`);
    await page.waitForTimeout(humanDelay(25, 50));
  }
  await page.waitForTimeout(humanDelay(30, 60));
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

// ---- "Something went wrong" traffic modal handler ----

const MAX_TRAFFIC_RETRIES = 3;

/**
 * Recreation.gov shows a "Something went wrong" modal during heavy traffic.
 * Detects it and clicks the Refresh button, waiting for the page to reload.
 * Returns true if the modal was detected and handled.
 */
async function dismissTrafficModal(
  page: Page,
  job: SniperJob,
  retries = MAX_TRAFFIC_RETRIES,
): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const modal = page.locator('.sarsa-modal-content-body:has-text("Something went wrong")');
    const isVisible = await modal.isVisible().catch(() => false);
    if (!isVisible) return attempt > 0;

    jobLog(job, `Traffic modal detected (attempt ${attempt + 1}/${retries}). Clicking Refresh...`);
    await saveScreenshot(page, job, `traffic-modal-attempt-${attempt + 1}`);

    const refreshBtn = modal.locator('button:has-text("Refresh")');
    await clickLoc(page, refreshBtn, { timeout: 5000 });
    await page.waitForTimeout(800);
  }

  const stillVisible = await page
    .locator('.sarsa-modal-content-body:has-text("Something went wrong")')
    .isVisible()
    .catch(() => false);

  if (stillVisible) {
    jobLog(job, `Traffic modal persists after ${retries} retries.`);
    await saveScreenshot(page, job, "traffic-modal-persistent");
  }

  return true;
}

/**
 * Blocks pointer events on the cart (e.g. after re-auth) until dismissed.
 * Heading text from site: "Your cart is about to expire."
 */
async function dismissCartExpiryWarningModal(page: Page, job: SniperJob): Promise<boolean> {
  const heading = page.locator("#modal-heading").filter({ hasText: /about to expire/i });
  const visible = await heading.isVisible({ timeout: 1200 }).catch(() => false);
  if (!visible) return false;

  jobLog(job, "Cart expiry warning modal detected. Dismissing...");
  await saveScreenshot(page, job, "cart-expiry-modal");

  const portal = page.locator(".ReactModalPortal").filter({ has: heading });
  const buttonSelectors = [
    "button.sarsa-button-primary",
    'button:has-text("Continue")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button[aria-label="Close"]',
  ];
  for (const sel of buttonSelectors) {
    const btn = portal.locator(sel).first();
    try {
      if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
        await clickLoc(page, btn, { timeout: 8000 });
        await page.waitForTimeout(humanDelay(400, 900));
        if (!(await heading.isVisible().catch(() => false))) return true;
      }
    } catch {
      /* try next selector */
    }
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(humanDelay(300, 600));
  return !(await heading.isVisible().catch(() => false));
}

async function dismissBlockingCartModals(page: Page, job: SniperJob): Promise<void> {
  await dismissTrafficModal(page, job);
  await dismissCartExpiryWarningModal(page, job);
}

// ---- Cart keep-alive (Modify -> Order Details -> Proceed to Cart resets timer) ----

const CART_KEEPALIVE_INTERVAL_MIN_MS = 5 * 60 * 1000; // 5 minutes
const CART_KEEPALIVE_INTERVAL_MAX_MS = 9 * 60 * 1000; // 9 minutes
const CART_KEEPALIVE_WAIT_ON_ORDER_DETAILS_MIN_MS = 10 * 1000; // 10 seconds
const CART_KEEPALIVE_WAIT_ON_ORDER_DETAILS_MAX_MS = 30 * 1000; // 30 seconds
const CART_KEEPALIVE_ORDER_DETAILS_BTN_TIMEOUT_MS = 30 * 1000;

/**
 * Perform one keep-alive cycle: click Modify on cart -> Order Details -> wait -> Proceed to Cart.
 * Resets the cart timer. Returns true if successful.
 */
async function runCartKeepAliveCycle(
  page: Page,
  job: SniperJob,
): Promise<boolean> {
  try {
    const CART_URL = "https://www.recreation.gov/cart";
    let url = page.url();
    if (!url.includes("/cart")) {
      jobLog(job, "Cart keep-alive: not on cart page, navigating back...");
      try {
        const creds = getRecgovCredentials();
        await ensureLoggedIn(page, job, creds, { resumeUrl: CART_URL });
        if (!page.url().includes("/cart")) {
          await safeGoto(page, job, CART_URL, "cart-keepalive-resume");
        }
        await page.waitForTimeout(humanDelay(500, 1000));
        url = page.url();
      } catch (err) {
        jobLog(job, "Cart keep-alive: failed to navigate to cart:", err instanceof Error ? err.message : err);
        return false;
      }
      if (!url.includes("/cart")) {
        jobLog(job, "Cart keep-alive: still not on cart after navigate, skipping.");
        return false;
      }
    }

    // Defensive: session may have expired during cart wait
    try {
      const creds = getRecgovCredentials();
      const reAuthed = await ensureLoggedIn(page, job, creds, {
        resumeUrl: CART_URL,
      });
      if (reAuthed) {
        jobLog(job, "Cart keep-alive: re-authenticated, resuming on cart.");
        await page.waitForTimeout(humanDelay(500, 1000));
      }
    } catch (err) {
      jobLog(job, "Cart keep-alive: ensureLoggedIn failed:", err instanceof Error ? err.message : err);
      return false;
    }

    await dismissBlockingCartModals(page, job);

    const modifyBtn = page.locator(
      'button[aria-label="Edit Reservation"], button.rec-button-link[title="Edit Reservation"]',
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      await dismissBlockingCartModals(page, job);

      const isModifyVisible = await modifyBtn.first().isVisible({ timeout: 3000 }).catch(() => false);
      if (!isModifyVisible) {
        if (attempt === 1) {
          jobLog(job, "Cart keep-alive: Modify button not found, skipping.");
          return false;
        }
        try {
          await safeGoto(page, job, CART_URL, "cart-keepalive-await-modify");
          await page.waitForTimeout(humanDelay(500, 1200));
        } catch {
          /* ignore */
        }
        continue;
      }

      try {
        jobLog(job, "Cart keep-alive: clicking Modify to reset timer...");
        await humanClick(page, modifyBtn.first());
        await page.waitForTimeout(1000);

        await dismissBlockingCartModals(page, job);

        const orderDetailsBtn = page.locator('button[data-testid="OrderDetailsSummary-cart-btn"]');
        await orderDetailsBtn.waitFor({
          state: "visible",
          timeout: CART_KEEPALIVE_ORDER_DETAILS_BTN_TIMEOUT_MS,
        });
        jobLog(job, "Cart keep-alive: on Order Details page.");

        const waitMs = humanDelay(
          CART_KEEPALIVE_WAIT_ON_ORDER_DETAILS_MIN_MS,
          CART_KEEPALIVE_WAIT_ON_ORDER_DETAILS_MAX_MS,
        );
        jobLog(
          job,
          `Cart keep-alive: waiting ${Math.round(waitMs / 1000)}s (with mouse/scroll) before Proceed to Cart...`,
        );
        const waitStart = Date.now();
        await simulateBrowsing(page);
        await page.waitForTimeout(humanDelay(2000, 5000));
        await simulateBrowsing(page);
        const elapsed = Date.now() - waitStart;
        await page.waitForTimeout(Math.max(0, waitMs - elapsed));

        await dismissBlockingCartModals(page, job);
        await humanClick(page, orderDetailsBtn);
        await page.waitForTimeout(1500);

        let backOnCart = page.url().includes("/cart");
        if (backOnCart) {
          jobLog(job, "Cart keep-alive: back on cart. Timer reset.");
          await saveScreenshot(page, job, "cart-keepalive-done");
        } else {
          jobLog(job, "Cart keep-alive: may not have returned to cart. URL:", page.url());
          jobLog(job, "Cart keep-alive: navigating back to cart...");
          try {
            await safeGoto(page, job, CART_URL, "cart-keepalive-recovery");
            backOnCart = page.url().includes("/cart");
          } catch {
            /* ignore */
          }
        }
        return backOnCart;
      } catch (innerErr) {
        const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        if (attempt === 0) {
          jobLog(job, "Cart keep-alive: attempt failed, recovering:", innerMsg);
          await dismissBlockingCartModals(page, job);
          try {
            await safeGoto(page, job, CART_URL, "cart-keepalive-retry");
            await page.waitForTimeout(humanDelay(800, 1600));
          } catch {
            /* ignore */
          }
          continue;
        }
        throw innerErr;
      }
    }

    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "Cart keep-alive error:", msg);
    await saveScreenshot(page, job, "cart-keepalive-error");
    return false;
  }
}

/**
 * Start a periodic cart keep-alive: every 5-9 min (randomized), click Modify -> Order Details ->
 * wait 10-30s -> Proceed to Cart. This resets the cart timer. Call the returned function to stop.
 */
function startCartKeepAliveWatcher(
  page: Page,
  job: SniperJob,
): () => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
  registerCartKeepAliveStopper(job.id, stop);

  const scheduleNext = () => {
    if (stopped) return;
    const delayMs = humanDelay(CART_KEEPALIVE_INTERVAL_MIN_MS, CART_KEEPALIVE_INTERVAL_MAX_MS);
    jobLog(job, `Cart keep-alive: next run in ${Math.round(delayMs / 60000)} min.`);
    timeoutId = setTimeout(async () => {
      if (stopped) return;
      try {
        await runCartKeepAliveCycle(page, job);
      } catch {
        // Logged in runCartKeepAliveCycle
      }
      scheduleNext();
    }, delayMs);
  };

  jobLog(
    job,
    `Cart keep-alive: ~5–9 min cycles until ${SNIPER_JOB_MAX_RUNTIME_MS / 3_600_000}h total run limit (pre-cart jobs stop after ${Math.round(SNIPER_PRE_CART_MAX_RUNTIME_MS / 60_000)} min if not in cart).`,
  );
  scheduleNext();

  return stop;
}

/**
 * Navigate to a URL, handle the traffic modal, and detect 404-style pages.
 * Recreation.gov is a SPA so HTTP status is always 200, but 404 pages contain
 * "Please Bear With Us" or an empty/error body.
 */
async function safeGoto(
  page: Page,
  job: SniperJob,
  url: string,
  label: string,
): Promise<{ is404: boolean }> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(800);
  await dismissOutdatedBrowserBanner(page);
  await dismissTrafficModal(page, job);

  const pageCheck = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const is404 =
      text.includes("Please Bear With Us") ||
      text.includes("page you were looking for") ||
      text.includes("couldn't find what you're looking for");
    const isError =
      text.includes("an unexpected error occurred") ||
      text.includes("Sorry, an unexpected error occurred");
    return { is404, isError, bodyPreview: text.substring(0, 300) };
  });

  const isPageBroken = pageCheck.is404 || pageCheck.isError;

  if (isPageBroken) {
    jobLog(
      job,
      `Page error detected at ${url} (404=${pageCheck.is404}, error=${pageCheck.isError}). Body: ${pageCheck.bodyPreview}`,
    );
  }

  await saveScreenshot(page, job, label);
  return { is404: isPageBroken };
}

// ---- Starting area filter (trail overnight permits) ----

async function clickStartingAreaFilter(page: Page, job: SniperJob): Promise<void> {
  if (!job.startingArea) return;

  jobLog(job, `Clicking starting area filter: "${job.startingArea}"...`);

  const filterBtn = page.locator(
    `button.olympic-filter-button:has-text("${job.startingArea}")`,
  );
  const isVisible = await filterBtn.isVisible({ timeout: 3000 }).catch(() => false);

  if (!isVisible) {
    jobLog(job, `Starting area button "${job.startingArea}" not found — permit may not have starting areas.`);
    return;
  }

  const isPressed = await filterBtn.getAttribute("aria-pressed");
  if (isPressed === "true") {
    jobLog(job, `Starting area "${job.startingArea}" already selected.`);
    return;
  }

  await clickLoc(page, filterBtn, { timeout: 5000 });
  await page.waitForTimeout(humanDelay(150, 300));
  jobLog(job, `Starting area "${job.startingArea}" filter clicked.`);
  await saveScreenshot(page, job, "starting-area-selected");
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

  const trigger = page.locator("button#guest-counter-QuotaUsageByMemberDaily");
  const isPresent = await trigger.isVisible({ timeout: 3000 }).catch(() => false);
  if (!isPresent) {
    jobLog(job, "Group members selector not present — skipping (permit may have fixed group size).");
    return;
  }

  const peopleInput = page.locator(
    "input#guest-counter-QuotaUsageByMemberDaily-number-field-People",
  );
  const plusBtn = page.locator('button[aria-label="Add Peoples"]');

  try {
    jobLog(job, "Step 1: Opening group members dropdown...");
    await humanClick(page, trigger);

    jobLog(job, "Waiting for popup content to render...");
    await peopleInput.waitFor({ state: "visible", timeout: 10000 });
    jobLog(job, "Dropdown content visible.");

    const currentValStr = await peopleInput.inputValue();
    const currentVal = parseInt(currentValStr, 10) || 0;
    jobLog(job, `Current people count: ${currentVal}, target: ${size}`);

    const clicksNeeded = Math.max(0, size - currentVal);
    jobLog(job, `Clicking "Add Peoples" button ${clicksNeeded} times...`);

    for (let i = 0; i < clicksNeeded; i++) {
      await clickLoc(page, plusBtn, { timeout: 3000 });
      await page.waitForTimeout(50);
    }

    // Verify the value changed
    await page.waitForTimeout(80);
    const newVal = await peopleInput.inputValue();
    jobLog(job, `People count after clicking: ${newVal}`);

    await saveScreenshot(page, job, "group-size-set");

    jobLog(job, "Step 4: Closing dropdown...");
    const closeBtn = page.locator(
      '.sarsa-dropdown-base-popup-actions button:has-text("Close")',
    );
    try {
      await page.waitForTimeout(50);
      await humanClick(page, closeBtn, { timeout: 3000 });
      jobLog(job, "Clicked Close button.");
    } catch {
      jobLog(job, "Close button not found, pressing Escape...");
      await page.keyboard.press("Escape");
    }

    // Step 5: Wait for the availability table to render
    jobLog(job, "Step 5: Waiting for availability table to load...");
    await page.waitForTimeout(400);

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

/**
 * Quickly check if desired dates are available in the permit grid by parsing the DOM.
 * Uses header row for date columns, fuzzy-matches trailhead row, and checks for
 * "unavailable" class or disabled buttons. Enables early bail when dates are gone.
 */
async function checkGridAvailabilityForRange(
  page: Page,
  nightDates: string[],
  trailheadName: string | null,
): Promise<{ allAvailable: boolean; unavailableDates: string[] }> {
  // Use new Function to avoid bundler-injected __name breaking browser eval (tsx/esbuild)
  const evalBody = `
    const { nightDates: nd, trailheadName: tn } = args;
    const parseHeaderDate = (text) => {
      const m = text.match(/(\\w+)\\s+(\\d{1,2}),\\s*(\\d{4})/);
      if (!m) return null;
      const d = new Date(m[1] + " " + m[2] + ", " + m[3]);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    };
    const normalize = (s) => s.toLowerCase().trim().replace(/\\s+/g, " ");
    const fuzzyMatch = (rowText, target) =>
      normalize(rowText).includes(normalize(target)) || normalize(target).includes(normalize(rowText));
    const grid = document.querySelector('.detailed-availability-grid-new, [aria-label="Availability by Trailhead and Dates"]');
    if (!grid) return { allAvailable: true, unavailableDates: [] };
    const rows = grid.querySelectorAll('[data-testid="Row"]');
    if (rows.length < 2) return { allAvailable: true, unavailableDates: [] };
    const headerRow = rows[0];
    const headerCells = headerRow.querySelectorAll('[data-testid="grid-header-cell"]');
    const dateToColIndex = new Map();
    for (let i = 2; i < headerCells.length; i++) {
      const cell = headerCells[i];
      const sr = cell.querySelector(".rec-sr-only");
      const text = (sr && sr.textContent ? sr.textContent : "").trim();
      const dateStr = parseHeaderDate(text);
      if (dateStr) dateToColIndex.set(dateStr, i);
    }
    let targetRow = null;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const trailheadCell = row.querySelector('[data-testid="grid-cell"]');
      const trailheadText = (trailheadCell && trailheadCell.textContent ? trailheadCell.textContent : "").trim();
      if (!tn || fuzzyMatch(trailheadText, tn)) {
        targetRow = row;
        break;
      }
    }
    if (!targetRow) return { allAvailable: true, unavailableDates: [] };
    const cells = targetRow.querySelectorAll('[data-testid="grid-cell"], [data-testid="availability-cell"]');
    const unavailableDates = [];
    for (const nightDate of nd) {
      const colIndex = dateToColIndex.get(nightDate);
      if (colIndex === undefined) continue;
      const dateCell = cells[colIndex];
      if (!dateCell) continue;
      const btn = dateCell.querySelector("button");
      const isUnavailable = dateCell.classList.contains("unavailable") || (btn && btn.disabled === true);
      if (isUnavailable) unavailableDates.push(nightDate);
    }
    return { allAvailable: unavailableDates.length === 0, unavailableDates };
  `;
  const fn = new Function("args", evalBody) as (args: { nightDates: string[]; trailheadName: string | null }) => {
    allAvailable: boolean;
    unavailableDates: string[];
  };
  return page.evaluate(fn, { nightDates, trailheadName }) as Promise<{
    allAvailable: boolean;
    unavailableDates: string[];
  }>;
}

/** Count recreation.gov calendar date buttons — explains missing clicks when the grid is locked. */
async function logRecAvailabilityButtonStats(page: Page, job: SniperJob): Promise<void> {
  const stats = await page.evaluate(`(() => {
    var buttons = Array.from(document.querySelectorAll("button.rec-availability-date"));
    var enabled = buttons.filter(function (b) { return !b.disabled; });
    var avail = 0;
    for (var i = 0; i < enabled.length; i++) {
      var lab = (enabled[i].getAttribute("aria-label") || "").toLowerCase();
      if (lab.indexOf("available") !== -1) avail++;
    }
    return { total: buttons.length, enabled: enabled.length, withAvailableLabel: avail };
  })()`);
  jobLog(
    job,
    `rec-availability-date buttons: ${stats.total} total, ${stats.enabled} enabled, ${stats.withAvailableLabel} enabled with "Available" in aria-label.`,
  );
  if (stats.total === 0) {
    jobLog(
      job,
      "No calendar date buttons in the DOM — grid may still be loading, session blocked, or markup changed.",
    );
  } else if (stats.enabled === 0) {
    jobLog(
      job,
      visualClicksEnabled()
        ? "All date buttons are disabled — VISUAL_CLICKS mode still targets them (pulses; clicks may fail until the grid unlocks)."
        : "All date buttons are disabled — the table is not clickable (finish group size / filters, wait for load, booking window, or overlay). Selectors use :not([disabled]), so no cell clicks run.",
    );
  } else if (stats.withAvailableLabel === 0) {
    jobLog(
      job,
      'Enabled date buttons exist but none include "Available" in aria-label — labels may differ; cell clicks may still fail to match.',
    );
  }
}

// ---- Browser booking ----

async function attemptBrowserBooking(
  page: Page,
  job: SniperJob,
  targetRange: DateRange,
  creds: { email: string; password: string },
): Promise<"booked" | "failed"> {
  try {
    const visualDev = visualClicksEnabled();
    const facilityId = job.permitId || job.campgroundId;
    const permitUrl = `https://www.recreation.gov/permits/${facilityId}/registration/detailed-availability?date=${targetRange.startDate}&type=overnight`;

    // Defensive: detect session expiry and re-auth before proceeding
    const reAuthed = await ensureLoggedIn(page, job, creds, { resumeUrl: permitUrl });
    if (reAuthed) {
      jobLog(job, "Re-authenticated. Proceeding with booking from permit page.");
      if (!visualDev) {
        await page.waitForTimeout(humanDelay(300, 600));
      }
    }

    jobLog(job, "Navigating to:", permitUrl);
    await logStepTiming(job, "goto booking page + hydrate", async () => {
      await safeGoto(page, job, permitUrl, "booking-page-loaded-nav");
      await page.waitForTimeout(visualDev ? 0 : humanDelay(150, 350));
    });

    if (!visualDev) {
      await simulateBrowsing(page);
      await page.waitForTimeout(humanDelay(60, 120));
    }

    await logStepTiming(job, "set group size (booking)", () =>
      setGroupSize(page, job),
    );

    if (job.startingArea) {
      await logStepTiming(job, "click starting area filter (booking)", () =>
        clickStartingAreaFilter(page, job),
      );
    }

    await page.waitForTimeout(visualDev ? 0 : humanDelay(150, 300));

    // Check for "abnormal activity" error before proceeding
    if (!visualDev && (await hasAbnormalActivityError(page))) {
      jobLog(job, "Abnormal activity error detected on booking page. Dismissing and retrying...");
      await saveScreenshot(page, job, "abnormal-activity-detected");
      // Try dismissing the error banner
      try {
        const closeBtn = page.locator('.rec-alert-dismiss, button[aria-label="Close"], .alert-close');
        if (await closeBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
          await clickLoc(page, closeBtn);
          await page.waitForTimeout(humanDelay(150, 350));
        }
      } catch {
        // Couldn't dismiss, try reloading
        jobLog(job, "Could not dismiss error. Reloading page...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(humanDelay(800, 1200));
        await dismissOutdatedBrowserBanner(page);
        await setGroupSize(page, job);
        await page.waitForTimeout(humanDelay(150, 300));
      }

      if (await hasAbnormalActivityError(page)) {
        jobLog(job, "Abnormal activity error persists after retry.");
        await saveScreenshot(page, job, "abnormal-activity-persistent");
        return "failed";
      }
    }

    if (!visualDev) {
      await debugPageState(page, job, "booking-page-loaded");
    } else {
      jobLog(job, `[booking-page-loaded] URL: ${page.url()} (VISUAL_CLICKS: skipped full page debug dump)`);
    }

    const allNightsInRange = expandRange(targetRange);
    jobLog(job, "Nights in range [startDate, endDate) for reference:", allNightsInRange);
    const nightDates = nightsToClickInBrowser(targetRange);
    if (visualDev) {
      jobLog(
        job,
        `VISUAL_CLICKS: clicking range boundary date(s) only: ${nightDates.join(" → ")} (not every night in [startDate, endDate)).`,
      );
    } else {
      jobLog(job, "Night dates to click in grid:", nightDates);
    }

    if (!visualDev) {
      const gridCheck = await checkGridAvailabilityForRange(
        page,
        allNightsInRange,
        job.trailheadName || null,
      );
      if (!gridCheck.allAvailable) {
        jobLog(
          job,
          `Grid check: ${gridCheck.unavailableDates.length} date(s) unavailable for ${job.trailheadName || "selected row"}: ${gridCheck.unavailableDates.join(", ")}. Skipping.`,
        );
        await saveScreenshot(page, job, "grid-dates-unavailable");
        return "failed";
      }
    }

    if (!visualDev) {
      await logRecAvailabilityButtonStats(page, job);
    }

    const clickCount = await clickDateCellsForPermitBooking(page, job, nightDates, "");

    jobLog(job, `Clicked ${clickCount}/${nightDates.length} date cells`);

    if (clickCount === 0) {
      jobLog(job, "No cells clicked - booking failed");
      if (!visualDev) {
        await logRecAvailabilityButtonStats(page, job);
      }
      await saveScreenshot(page, job, "no-cells-clicked");
      return "failed";
    }

    if (visualDev && clickCount < nightDates.length) {
      jobLog(
        job,
        `VISUAL_CLICKS: expected ${nightDates.length} cell click(s); got ${clickCount}. Stopping before Book Now.`,
      );
      await saveScreenshot(page, job, "visual-incomplete-cell-clicks");
      return "failed";
    }

    if (visualDev && clickCount === nightDates.length) {
      jobLog(
        job,
        "VISUAL_CLICKS: start/end (boundary) cells clicked — skipping Book Now so the sniper can try the next desired range or fallback.",
      );
      await saveScreenshot(page, job, "visual-after-cells");
      return "failed";
    }

    await page.waitForTimeout(80);
    await saveScreenshot(page, job, "after-cell-click");

    const clickDatesMs = await logStepTiming(job, "click date cells", async () => {
      return clickCount;
    });
    void clickDatesMs;

    if (!visualDev && (await hasAbnormalActivityError(page))) {
      jobLog(job, "Abnormal activity error appeared after selecting dates.");
      await saveScreenshot(page, job, "abnormal-after-dates");
      return "failed";
    }

    await page.waitForTimeout(80);

    jobLog(job, "Looking for Book Now button...");
    let bookClicked = false;
    await logStepTiming(job, "click Book Now + wait for order details", async () => {
      try {
        const bookBtn = page.locator('button:has-text("Book Now")');
        const bookCount = await bookBtn.count();
        jobLog(job, `Found ${bookCount} "Book Now" button(s)`);
        if (bookCount > 0) {
          await page.waitForTimeout(50);
          await humanClick(page, bookBtn);
          jobLog(job, "Clicked Book Now!");
          bookClicked = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        jobLog(job, `Book Now error: ${msg}`);
      }

      if (!bookClicked) {
        for (const label of ["Add to Cart", "Reserve", "Continue", "Next"]) {
          try {
            const btn = page.locator(`button:has-text("${label}")`);
            if ((await btn.count()) > 0) {
              jobLog(job, `Clicking fallback: "${label}"`);
              await page.waitForTimeout(50);
              await humanClick(page, btn, { timeout: 3000 });
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
        throw new Error("No booking button found");
      }

      await page.waitForTimeout(600);
      await saveScreenshot(page, job, "after-book-click");
    });

    // Check if a login modal appeared after clicking Book Now
    let loginNeeded = await handleLoginModal(page, job);

    const maxRetriesAfterLogin = 2;
    for (let retryRound = 0; loginNeeded && retryRound < maxRetriesAfterLogin; retryRound++) {
      jobLog(job, `Session expired mid-booking. Retrying booking flow after re-auth (round ${retryRound + 1}/${maxRetriesAfterLogin})...`);

      const facilityId2 = job.permitId || job.campgroundId;
      const retryUrl = `https://www.recreation.gov/permits/${facilityId2}/registration/detailed-availability?date=${targetRange.startDate}&type=overnight`;
      jobLog(job, "Re-navigating to:", retryUrl);
      await safeGoto(page, job, retryUrl, "retry-booking-nav");
      await page.waitForTimeout(visualDev ? 0 : humanDelay(150, 350));

      await setGroupSize(page, job);
      if (job.startingArea) {
        await clickStartingAreaFilter(page, job);
      }
      await page.waitForTimeout(visualDev ? 0 : humanDelay(150, 300));
      if (!visualDev) {
        await debugPageState(page, job, "retry-booking-page");
      }

      const retryNightDates = nightsToClickInBrowser(targetRange);
      const retryClickCount = await clickDateCellsForPermitBooking(page, job, retryNightDates, "[retry] ");

      if (retryClickCount === 0) {
        jobLog(job, "[retry] No date cells found after re-auth.");
        await saveScreenshot(page, job, "retry-no-dates");
        return "failed";
      }

      if (visualDev && retryClickCount < retryNightDates.length) {
        jobLog(
          job,
          `[retry] VISUAL_CLICKS: expected ${retryNightDates.length} cell click(s); got ${retryClickCount}. Stopping before Book Now.`,
        );
        await saveScreenshot(page, job, "retry-visual-incomplete-clicks");
        return "failed";
      }

      if (visualDev && retryClickCount === retryNightDates.length) {
        jobLog(
          job,
          "[retry] VISUAL_CLICKS: boundary cells clicked — skipping Book Now (try next range/fallback).",
        );
        await saveScreenshot(page, job, "retry-visual-after-cells");
        return "failed";
      }

      await page.waitForTimeout(80);
      const retryBookBtn = page.locator('button:has-text("Book Now")');
      if ((await retryBookBtn.count()) > 0) {
        await humanClick(page, retryBookBtn);
        jobLog(job, "[retry] Clicked Book Now!");
        await page.waitForTimeout(500);
        await saveScreenshot(page, job, "retry-after-book-click");
      } else {
        jobLog(job, "[retry] No Book Now button found.");
        await saveScreenshot(page, job, "retry-no-book-btn");
        return "failed";
      }

      loginNeeded = await handleLoginModal(page, job);
      if (loginNeeded && retryRound < maxRetriesAfterLogin - 1) {
        jobLog(job, "Login modal appeared again. Retrying booking flow once more...");
      }
    }

    let orderResult: boolean | "retry" = false;
    const maxOrderDetailsRetries = 2;
    for (let orderRetry = 0; orderRetry < maxOrderDetailsRetries; orderRetry++) {
      if (orderRetry > 0) {
        jobLog(job, `Session expired during order details. Retrying from permit page (attempt ${orderRetry + 1}/${maxOrderDetailsRetries})...`);
        await safeGoto(page, job, permitUrl, "retry-order-details-nav");
        await page.waitForTimeout(visualDev ? 0 : humanDelay(150, 350));
        await setGroupSize(page, job);
        if (job.startingArea) await clickStartingAreaFilter(page, job);
        await page.waitForTimeout(visualDev ? 0 : humanDelay(150, 300));
        const retryNightDates = nightsToClickInBrowser(targetRange);
        const retryClickCount = await clickDateCellsForPermitBooking(
          page,
          job,
          retryNightDates,
          "[order retry] ",
        );
        if (retryClickCount === 0) {
          jobLog(job, "[order retry] No date cells found.");
          return "failed";
        }
        if (visualDev && retryClickCount < retryNightDates.length) {
          jobLog(
            job,
            `[order retry] VISUAL_CLICKS: expected ${retryNightDates.length} cell click(s); got ${retryClickCount}.`,
          );
          return "failed";
        }
        if (visualDev && retryClickCount === retryNightDates.length) {
          jobLog(job, "[order retry] VISUAL_CLICKS: boundary cells done — skipping Book Now.");
          return "failed";
        }
        const retryBookBtn = page.locator('button:has-text("Book Now")');
        if ((await retryBookBtn.count()) > 0) {
          await humanClick(page, retryBookBtn);
          await page.waitForTimeout(600);
        }
        const stillLoginNeeded = await handleLoginModal(page, job);
        if (stillLoginNeeded) {
          jobLog(job, "[order retry] Login modal appeared again.");
          continue;
        }
      }
      orderResult = await logStepTiming(job, "fill order details + proceed to cart", () =>
        fillOrderDetails(page, job),
      );
      if (orderResult === true) {
        jobLog(job, "Order details filled and proceeded to cart!");
        return "booked";
      }
      if (orderResult !== "retry") {
        jobLog(job, "Order details filling failed — item may be in cart but not completed. Check browser.");
        return "failed";
      }
    }
    jobLog(job, "Order details retry exhausted.");
    return "failed";
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
async function fillOrderDetails(page: Page, job: SniperJob): Promise<boolean | "retry"> {
  jobLog(job, "Filling order details...");

  // Defensive: session may have expired while on order details
  const loginNeeded = await handleLoginModal(page, job);
  if (loginNeeded) {
    jobLog(job, "Session expired during order details. Caller should retry from permit page.");
    return "retry";
  }

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
    // Check for abnormal activity error before waiting for form
    if (await hasAbnormalActivityError(page)) {
      jobLog(job, "Abnormal activity error detected on order details page.");
      await saveScreenshot(page, job, "order-details-abnormal-activity");
      return false;
    }

    // Wait for the order details form to load
    jobLog(job, "Waiting for order details form...");
    await page.locator("input#address1").waitFor({ state: "visible", timeout: 15000 });
    jobLog(job, "Order details form loaded.");

    jobLog(job, `Setting country to ${country}...`);
    await page.locator("select#country").selectOption(country);
    await page.waitForTimeout(humanDelay(150, 300));

    const addressInput = page.locator("input#address1");
    await humanType(page, addressInput, address);
    await page.waitForTimeout(humanDelay(150, 350));

    const cityInput = page.locator("input#city");
    await humanType(page, cityInput, city);
    await page.waitForTimeout(humanDelay(150, 300));

    jobLog(job, `Setting state to ${state}...`);
    await page.waitForTimeout(humanDelay(200, 500));
    await page.locator("select#state").selectOption(state);
    await page.waitForTimeout(humanDelay(150, 300));

    const zipInput = page.locator("input#zip_code");
    await humanType(page, zipInput, zip);

    await page.waitForTimeout(humanDelay(150, 350));
    await saveScreenshot(page, job, "order-details-filled");

    jobLog(job, "Checking terms checkbox...");
    const checkbox = page.locator("input#need-to-know-checkbox");
    const isChecked = await checkbox.isChecked();
    if (!isChecked) {
      const termsLabel = page.locator('label[for="need-to-know-checkbox"]');
      await humanClick(page, termsLabel);
      jobLog(job, "Terms checkbox checked.");
    } else {
      jobLog(job, "Terms checkbox already checked.");
    }

    await page.waitForTimeout(humanDelay(200, 400));

    jobLog(job, 'Clicking "Proceed to Cart"...');
    const cartBtn = page.locator('button[data-testid="OrderDetailsSummary-cart-btn"]');
    await cartBtn.waitFor({ timeout: 5000 });
    await humanClick(page, cartBtn);
    jobLog(job, "Clicked Proceed to Cart!");

    await page.waitForTimeout(1500);
    await page.waitForURL(/\/cart/, { timeout: 10000 }).catch(() => {});
    await saveScreenshot(page, job, "after-proceed-to-cart");

    if (page.url().includes("/cart")) {
      jobLog(
        job,
        "On cart page. Starting cart keep-alive (Modify → Order Details → Proceed to Cart on a jittered ~5–9 min schedule).",
      );
      startCartKeepAliveWatcher(page, job);
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "Error filling order details:", msg);
    await saveScreenshot(page, job, "order-details-error");
    return false;
  }
}

// ---- Campsite browser booking ----

async function attemptCampsiteBooking(
  page: Page,
  job: SniperJob,
  targetRange: DateRange,
  targetCampsiteId: string,
  creds: { email: string; password: string },
): Promise<"booked" | "failed"> {
  try {
    // Try permits path first, fall back to campgrounds path
    let url = `https://www.recreation.gov/permits/${job.campgroundId}/registration/detailed-availability?date=${targetRange.startDate}&type=overnight`;

    // Defensive: detect session expiry and re-auth before proceeding
    const reAuthed = await ensureLoggedIn(page, job, creds, { resumeUrl: url });
    if (reAuthed) {
      jobLog(job, "Re-authenticated. Proceeding with campsite booking from facility page.");
      await page.waitForTimeout(humanDelay(300, 600));
    }

    jobLog(job, "Navigating to:", url);
    let navRes = await logStepTiming(job, "goto facility page + hydrate", async () => {
      const r = await safeGoto(page, job, url, "campground-page-loaded");
      await page.waitForTimeout(800);
      return r;
    });

    if (navRes?.is404) {
      jobLog(job, "Permit URL returned 404. Falling back to campground URL...");
      url = `https://www.recreation.gov/camping/campgrounds/${job.campgroundId}/availability`;
      await logStepTiming(job, "goto campground page (fallback) + hydrate", async () => {
        await safeGoto(page, job, url, "campground-page-fallback");
        await page.waitForTimeout(800);
      });
    }

    // Set the check-in date using the date picker
    jobLog(job, `Setting dates: ${targetRange.startDate} to ${targetRange.endDate}...`);
    await logStepTiming(job, "set campsite dates", async () => {
      // Try the start-date input
      const startInput = page.locator('input#campground-start-date, input[name="startDate"], input[data-component="StartDate"]');
      const endInput = page.locator('input#campground-end-date, input[name="endDate"], input[data-component="EndDate"]');

      try {
        await startInput.first().waitFor({ timeout: 5000 });

        // Format dates for the input (MM/DD/YYYY)
        const sd = new Date(targetRange.startDate + "T00:00:00");
        const ed = new Date(targetRange.endDate + "T00:00:00");
        const startFormatted = `${String(sd.getMonth() + 1).padStart(2, "0")}/${String(sd.getDate()).padStart(2, "0")}/${sd.getFullYear()}`;
        const endFormatted = `${String(ed.getMonth() + 1).padStart(2, "0")}/${String(ed.getDate()).padStart(2, "0")}/${ed.getFullYear()}`;

        await humanType(page, startInput, startFormatted, { clearFirst: true });
        await page.waitForTimeout(humanDelay(150, 350));
        await humanType(page, endInput, endFormatted, { clearFirst: true });
        await page.waitForTimeout(humanDelay(150, 350));

        // Press Enter or click search to apply dates
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        jobLog(job, "Date input method failed, trying URL params:", msg);
        // Fallback: navigate with date params in URL
        const paramUrl = `${url}?start_date=${targetRange.startDate}&end_date=${targetRange.endDate}`;
        await safeGoto(page, job, paramUrl, "campsite-dates-fallback");
        await page.waitForTimeout(800);
      }
    });

    await saveScreenshot(page, job, "campsite-dates-set");

    // Find and click the target campsite's "Book" button
    jobLog(job, `Looking for campsite ${targetCampsiteId}...`);
    let bookClicked = false;

    await logStepTiming(job, "find and book campsite", async () => {
      // Recreation.gov campground availability shows a list of campsites
      // Each row has the site name/number and availability cells or a "Book" button

      // Strategy 1: Find by campsite data attribute or aria-label
      const siteRow = page.locator(
        `[data-campsite-id="${targetCampsiteId}"], tr:has([data-campsite-id="${targetCampsiteId}"])`
      );

      try {
        if (await siteRow.count() > 0) {
          const bookBtn = siteRow.first().locator('button:has-text("Book"), a:has-text("Book")');
          if (await bookBtn.count() > 0) {
            await clickLoc(page, bookBtn, { timeout: 5000 });
            bookClicked = true;
            jobLog(job, "Clicked Book via data-campsite-id selector");
          }
        }
      } catch {
        jobLog(job, "data-campsite-id selector failed, trying alternatives...");
      }

      // Strategy 2: Click available cells in the availability grid
      if (!bookClicked) {
        try {
          const nightDates = expandRange(targetRange);
          let clickCount = 0;

          for (const nightDate of nightDates) {
            const d = new Date(nightDate + "T00:00:00");
            const monthName = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
            const dayOfMonth = d.getUTCDate();
            const year = d.getUTCFullYear();
            const ariaDateStr = `${monthName} ${dayOfMonth}, ${year}`;

            const btn = page.locator(
              `button[aria-label*="${ariaDateStr}"][aria-label*="Available"]${dateCellDisabledSelectorClause()}`,
            );
            if (await btn.count() > 0) {
              await clickLoc(page, btn, { timeout: 5000 });
              clickCount++;
              await page.waitForTimeout(300);
            }
          }

          if (clickCount > 0) {
            jobLog(job, `Clicked ${clickCount} date cells`);

            // Look for Book Now button
            for (const label of ["Book Now", "Add to Cart", "Reserve", "Continue"]) {
              const btn = page.locator(`button:has-text("${label}")`);
              if (await btn.count() > 0) {
                await clickLoc(page, btn, { timeout: 5000 });
                bookClicked = true;
                jobLog(job, `Clicked "${label}" button`);
                break;
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          jobLog(job, "Cell-clicking strategy failed:", msg);
        }
      }

      // Strategy 3: Use page.evaluate to find and click the site row
      if (!bookClicked) {
        const campsiteBtnSel = visualClicksEnabled() ? "button" : "button:not([disabled])";
        const result = await page.evaluate(
          `(() => {
          const rows = document.querySelectorAll('[class*="campsite-row"], [class*="site-row"], tr[data-component="CampsiteRow"]');
          const sel = ${JSON.stringify(campsiteBtnSel)};
          for (const row of rows) {
            const text = row.textContent || '';
            if (text.includes('Available')) {
              const btn = row.querySelector(sel);
              if (btn) {
                btn.click();
                return 'clicked';
              }
            }
          }
          return 'not-found';
        })()`,
        );

        if (result === "clicked") {
          bookClicked = true;
          jobLog(job, "Clicked campsite via evaluate fallback");
        }
      }
    });

    if (!bookClicked) {
      jobLog(job, "No campsite booking button found");
      await saveScreenshot(page, job, "campsite-no-book-button");
      return "failed";
    }

    await page.waitForTimeout(1200);
    await saveScreenshot(page, job, "campsite-after-book-click");

    // Fill order details (same form as permits)
    const orderResult = await logStepTiming(job, "fill order details + proceed to cart", () =>
      fillOrderDetails(page, job),
    );
    if (orderResult === true) {
      jobLog(job, "Campsite order details filled and proceeded to cart!");
      return "booked";
    }
    if (orderResult === "retry") {
      jobLog(job, "Session expired during order details. Campsite booking would need full retry.");
    }
    jobLog(job, "Order details filling failed — item may be in cart but not completed.");
    return "failed";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobLog(job, "attemptCampsiteBooking error:", msg);
    try {
      await saveScreenshot(page, job, "campsite-booking-error");
    } catch { /* ignore */ }
    return "failed";
  }
}

// ---- Sign in helper ----

const SIGN_IN_MAX_RETRIES = 3;
const SIGN_IN_RETRY_DELAY_MS = 5000;

const LOGIN_PAGE_HTML_TRUNCATE = 12000;

async function logLoginPageHtml(page: Page, context: string): Promise<void> {
  try {
    // Extract form HTML to see actual input IDs/names (helps debug selector changes)
    const formHtml = await page
      .evaluate(() => {
        const form = document.querySelector("form");
        if (!form) return null;
        return form.outerHTML.slice(0, 6000);
      })
      .catch(() => null);
    if (formHtml) {
      console.log(`[sniper] Form HTML (first 6k chars):`);
      console.log(formHtml);
    } else {
      console.log(`[sniper] No form element found in DOM`);
    }

    const html = await page.content();
    const truncated = html.length > LOGIN_PAGE_HTML_TRUNCATE;
    const snippet = truncated ? html.slice(0, LOGIN_PAGE_HTML_TRUNCATE) : html;
    console.log(`[sniper] ${context}`);
    console.log(`[sniper] Full page HTML (${truncated ? `first ${LOGIN_PAGE_HTML_TRUNCATE} chars of ${html.length}` : html.length} chars):`);
    console.log(snippet);
    if (truncated) {
      console.log(`[sniper] ... (truncated, ${html.length - LOGIN_PAGE_HTML_TRUNCATE} more chars)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[sniper] Failed to capture login page HTML: ${msg}`);
  }
}

async function signIn(
  page: Page,
  email: string,
  password: string,
  job?: SniperJob | null,
): Promise<void> {
  console.log("[sniper] Signing in...");

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= SIGN_IN_MAX_RETRIES; attempt++) {
    try {
      await signInAttempt(page, email, password, job ?? null);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message.slice(0, 120);
      if (attempt < SIGN_IN_MAX_RETRIES) {
        console.log(`[sniper] Sign-in attempt ${attempt}/${SIGN_IN_MAX_RETRIES} failed: ${msg}. Retrying in ${SIGN_IN_RETRY_DELAY_MS / 1000}s...`);
        await page.waitForTimeout(SIGN_IN_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr ?? new Error("Sign-in failed after retries.");
}

async function signInAttempt(
  page: Page,
  email: string,
  password: string,
  job: SniperJob | null,
): Promise<void> {
  // Visit homepage first to warm cookies/session like a real user
  const maxNavRetries = 3;
  for (let attempt = 1; attempt <= maxNavRetries; attempt++) {
    try {
      await page.goto("https://www.recreation.gov/", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxNavRetries && (msg.includes("ERR_HTTP_RESPONSE_CODE_FAILURE") || msg.includes("ERR_TIMED_OUT") || msg.includes("ERR_CONNECTION"))) {
        console.log(`[sniper] Homepage load failed (attempt ${attempt}/${maxNavRetries}): ${msg.slice(0, 100)}. Retrying in ${attempt * 3}s...`);
        await page.waitForTimeout(attempt * 3000);
        continue;
      }
      throw err;
    }
  }

  await page.waitForTimeout(humanDelay(600, 1000));
  await dismissOutdatedBrowserBanner(page);
  await simulateBrowsing(page);

  // Navigate to login page
  for (let attempt = 1; attempt <= maxNavRetries; attempt++) {
    try {
      await page.goto("https://www.recreation.gov/log-in", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxNavRetries && (msg.includes("ERR_HTTP_RESPONSE_CODE_FAILURE") || msg.includes("ERR_TIMED_OUT") || msg.includes("ERR_CONNECTION"))) {
        console.log(`[sniper] Sign-in page load failed (attempt ${attempt}/${maxNavRetries}): ${msg.slice(0, 100)}. Retrying in ${attempt * 3}s...`);
        await page.waitForTimeout(attempt * 3000);
        continue;
      }
      throw err;
    }
  }

  await page.waitForTimeout(humanDelay(150, 350));
  await dismissOutdatedBrowserBanner(page);

  // If already logged in (e.g. from previous attempt), skip the form
  let skipFormFill = await page.locator('[aria-label^="User:"]').first().isVisible().catch(() => false);
  if (skipFormFill) {
    console.log("[sniper] Already logged in (detected user in header). Skipping form.");
  } else {
    const emailInput = page.locator('input#email, input[type="email"]').first();
    try {
      await emailInput.waitFor({ timeout: 10000 });
    } catch (err) {
      // On retry we may land on homepage or get redirected (already logged in) — check before failing
      const userVisible = await page.locator('[aria-label^="User:"]').first().isVisible().catch(() => false);
      if (userVisible) {
        console.log("[sniper] Already logged in (redirected from log-in).");
        skipFormFill = true;
      } else {
        console.log("[sniper] Email input not found. Current URL:", page.url());
        await logLoginPageHtml(page, "Email input timeout — page may have changed or form structure differs.");
        throw err;
      }
    }
  }

  if (!skipFormFill) {
    const emailInput = page.locator('input#email, input[type="email"]').first();
    await page.waitForTimeout(humanDelay(150, 350));
    await humanType(page, emailInput, email, { fast: true });

    await page.waitForTimeout(humanDelay(150, 350));

    const passwordInput = page.locator('input#rec-acct-sign-in-password, input[type="password"]').first();
    await passwordInput.waitFor({ timeout: 5000 });
    await humanType(page, passwordInput, password, { fast: true });

    await page.waitForTimeout(humanDelay(800, 1200));

    const submitBtn = page.locator('button.rec-acct-sign-in-btn, button[type="submit"]').first();
    await submitBtn.waitFor({ timeout: 5000 });
    await humanClick(page, submitBtn);

    // Wait for navigation away from log-in page
    try {
      await page.waitForURL(
        (url) => !url.pathname.includes("log-in"),
        { timeout: 20000 },
      );
    } catch {
      if (page.url().includes("log-in")) {
        await logLoginPageHtml(page, "Login failed. Still on log-in page after submit.");
        await saveScreenshot(page, job, "login-failed-still-on-page");
        throw new Error("Login failed. Check your recreation.gov credentials.");
      }
    }

    // Wait for session to be established — login modal must disappear
    await page.waitForTimeout(humanDelay(400, 700));

    // Wait for React modal overlay to close (form is in modal; underlying page may show user)
    await page
      .waitForFunction(
        () => !document.body.classList.contains("ReactModal__Body--open"),
        { timeout: 15000 },
      )
      .catch(() => {});

    // Positive check: header shows logged-in user (e.g. "User: Travis M." aria-label)
    const loggedInUserVisible = await page.locator('[aria-label^="User:"]').first().isVisible().catch(() => false);
    if (loggedInUserVisible) {
      console.log("[sniper] Signed in successfully (detected user in header).");
      // Skip failure checks and go straight to homepage confirmation
    } else {
      // Require BOTH email and sign-in password visible — post-login pages may have
      // a standalone email input (newsletter, signup) which would false-positive
      const loginFormVisible =
        (await page.locator('input#email, input[type="email"]').first().isVisible().catch(() => false)) &&
        (await page.locator('input#rec-acct-sign-in-password, input[type="password"]').first().isVisible().catch(() => false));
      const hasLoginError = await page.locator('text=/incorrect|error occurred|reset.*password/i').isVisible().catch(() => false);
      if (loginFormVisible || hasLoginError) {
        await logLoginPageHtml(
          page,
          "Login failed. Wrong credentials or bot detection (reCAPTCHA).",
        );
        await saveScreenshot(page, job, "login-failed-wrong-creds-or-bot");
        throw new Error(
          "Login failed. Recreation.gov may show 'wrong credentials' when it detects automation (reCAPTCHA/bot detection) even if credentials are correct. Try: HEADLESS=false, no proxy locally, or persistent browser profile.",
        );
      }
    }
  }

  // Navigate to homepage to confirm session persists
  await page.goto("https://www.recreation.gov/", { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(humanDelay(400, 700));

  const stillLoggedOut = await page.locator('#ga-global-nav-log-in-link, [aria-label*="Sign Up"][aria-label*="Log In"]').first().isVisible().catch(() => false);
  if (stillLoggedOut) {
    await logLoginPageHtml(page, "Login failed. Session did not persist.");
    await saveScreenshot(page, job, "login-failed-session-not-persisted");
    throw new Error(
      "Login failed. Session did not persist. Recreation.gov often blocks automated logins (reCAPTCHA). Try HEADLESS=false and/or disable PROXY_SERVER locally.",
    );
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
