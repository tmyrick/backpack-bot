import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { SniperJob, SniperJobRequest, DateRange } from "../types/index.js";

export type { SniperJob, SniperJobRequest, DateRange };

type SniperJobOnDisk = Omit<SniperJob, never>;

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
const POLL_INTERVAL_MS = 1_000; // 1 second — faster detection when window opens
const MAX_WATCH_DURATION_MS = 60 * 1000; // 60 seconds of polling
const RECGOV_API = "https://www.recreation.gov/api/permits";

const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Launch a browser + context with stealth settings to avoid bot detection.
 * Tries system Chrome first, falls back to bundled Chromium if unavailable.
 * Supports optional proxy via PROXY_SERVER env var (e.g. "http://user:pass@host:port").
 */
async function launchStealthBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-sandbox",
  ];

  const proxyServer = process.env.PROXY_SERVER;
  let proxyConfig: { server: string; username?: string; password?: string } | undefined;
  if (proxyServer) {
    try {
      const url = new URL(proxyServer);
      let username = decodeURIComponent(url.username);
      // BrightData: append a sticky session ID so the same residential IP
      // is used for all requests in this browser session.
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

  const launchOpts: Parameters<typeof chromium.launch>[0] = {
    headless: true,
    args: launchArgs,
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
  };

  let browser: Browser;
  try {
    browser = await chromium.launch({ ...launchOpts, channel: "chrome" });
    console.log("[sniper] Launched system Chrome" + (proxyServer ? ` via proxy` : ""));
  } catch {
    browser = await chromium.launch(launchOpts);
    console.log("[sniper] System Chrome not found, using bundled Chromium" + (proxyServer ? ` via proxy` : ""));
  }

  const contextOpts: Parameters<typeof browser.newContext>[0] = {
    userAgent: WINDOWS_CHROME_UA,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    permissions: ["geolocation"],
    ignoreHTTPSErrors: !!proxyServer,
  };

  const context = await browser.newContext(contextOpts);

  // Remove navigator.webdriver flag before any page loads
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // Mimic real Chrome's plugins array (empty in headless, but length > 0 in real)
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    // Mimic real Chrome's languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    // Pass Chrome-specific checks
    (window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  });

  const page = await context.newPage();
  return { browser, context, page };
}

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
      signIn(page, creds.email, creds.password),
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

    jobLog(job, `Setting group size to ${job.groupSize}...`);
    await logStepTiming(job, "set group size (pre-warm)", () =>
      setGroupSize(page, job),
    );

    if (job.startingArea) {
      await logStepTiming(job, "click starting area filter (pre-warm)", () =>
        clickStartingAreaFilter(page, job),
      );
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
      signIn(page, creds.email, creds.password),
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
      jobLog(job, `Setting group size to ${job.groupSize}...`);
      await logStepTiming(job, "set group size (pre-warm)", () =>
        setGroupSize(page, job),
      );
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
      message: "Window open! Polling campsite availability...",
    });
    await saveJobs();

    const watchDeadline = Date.now() + MAX_WATCH_DURATION_MS;

    if (job.campgroundIsPermit) {
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
          message: `Poll #${job.attempts}: No availability yet. Next check in ${POLL_INTERVAL_MS / 1000}s...`,
        });
        await sleep(POLL_INTERVAL_MS, signal);
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

      const bookResult = await attemptBrowserBooking(page, job, foundRange);

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
        const result = await attemptBrowserBooking(page, job, fallbackRange);
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
          message: `Poll #${job.attempts}: No availability yet. Next check in ${POLL_INTERVAL_MS / 1000}s...`,
        });
        await sleep(POLL_INTERVAL_MS, signal);
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

      const bookResult = await attemptCampsiteBooking(page, job, found.range, found.campsiteId);

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

        const result = await attemptCampsiteBooking(page, job, fallbackRange, fallback.campsiteId);
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
      "User-Agent": WINDOWS_CHROME_UA,
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

/**
 * Check availability across ALL divisions of a permit facility.
 * Used when a "campground" in the UI is actually a permit-type facility.
 */
async function checkPermitFacilityAvailability(
  permitId: string,
  ranges: DateRange[],
): Promise<DateRange | null> {
  const allStartDates = ranges.map((r) => r.startDate).sort();
  const allEndDates = ranges.map((r) => r.endDate).sort();
  const queryStart = new Date(allStartDates[0] + "T00:00:00.000Z");
  const queryEnd = new Date(allEndDates[allEndDates.length - 1] + "T00:00:00.000Z");
  queryEnd.setUTCDate(queryEnd.getUTCDate() + 1);

  const url = `${RECGOV_API}/${permitId}/availability?start_date=${queryStart.toISOString()}&end_date=${queryEnd.toISOString()}&commercial_acct=false`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": WINDOWS_CHROME_UA,
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

  // Check ALL divisions -- find the first one where a desired range is fully available
  for (const [, division] of Object.entries(data.payload.availability)) {
    const availByDate = new Map<string, number>();
    for (const [isoDate, avail] of Object.entries(division.date_availability)) {
      availByDate.set(isoDate.substring(0, 10), avail.remaining);
    }

    for (const range of ranges) {
      const nights = expandRange(range);
      const allAvailable = nights.every((d) => (availByDate.get(d) ?? 0) > 0);
      if (allAvailable) {
        return range;
      }
    }
  }

  return null;
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
        "User-Agent": WINDOWS_CHROME_UA,
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
    await signIn(page, creds.email, creds.password);
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
    const ignoreBtn = page.locator('button:has-text("Ignore")');
    if (await ignoreBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await ignoreBtn.click();
    }
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
function humanDelay(min = 300, max = 800): number {
  return Math.floor(Math.random() * (max - min)) + min;
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
    await refreshBtn.click({ timeout: 5000 });
    await page.waitForTimeout(3000);
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
  await page.waitForTimeout(1500);
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

  await filterBtn.click({ timeout: 5000 });
  await page.waitForTimeout(humanDelay(800, 1500));
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
    await page.waitForTimeout(1500);

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
    const facilityId = job.permitId || job.campgroundId;
    const url = `https://www.recreation.gov/permits/${facilityId}/registration/detailed-availability?date=${targetRange.startDate}&type=overnight`;
    jobLog(job, "Navigating to:", url);
    await logStepTiming(job, "goto booking page + hydrate", async () => {
      await safeGoto(page, job, url, "booking-page-loaded-nav");
      await page.waitForTimeout(1500);
    });

    await page.waitForTimeout(humanDelay(500, 1200));

    await logStepTiming(job, "set group size (booking)", () =>
      setGroupSize(page, job),
    );

    if (job.startingArea) {
      await logStepTiming(job, "click starting area filter (booking)", () =>
        clickStartingAreaFilter(page, job),
      );
    }

    await page.waitForTimeout(humanDelay(800, 1500));

    // Check for "abnormal activity" error before proceeding
    if (await hasAbnormalActivityError(page)) {
      jobLog(job, "Abnormal activity error detected on booking page. Dismissing and retrying...");
      await saveScreenshot(page, job, "abnormal-activity-detected");
      // Try dismissing the error banner
      try {
        const closeBtn = page.locator('.rec-alert-dismiss, button[aria-label="Close"], .alert-close');
        if (await closeBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
          await closeBtn.first().click();
          await page.waitForTimeout(humanDelay(1000, 2000));
        }
      } catch {
        // Couldn't dismiss, try reloading
        jobLog(job, "Could not dismiss error. Reloading page...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(humanDelay(2000, 3000));
        await dismissOutdatedBrowserBanner(page);
        await setGroupSize(page, job);
        await page.waitForTimeout(humanDelay(800, 1500));
      }

      if (await hasAbnormalActivityError(page)) {
        jobLog(job, "Abnormal activity error persists after retry.");
        await saveScreenshot(page, job, "abnormal-activity-persistent");
        return "failed";
      }
    }

    await debugPageState(page, job, "booking-page-loaded");

    const nightDates = expandRange(targetRange);
    jobLog(job, "Night dates to book:", nightDates);

    let clickCount = 0;

    for (const nightDate of nightDates) {
      const d = new Date(nightDate + "T00:00:00");
      const monthName = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
      const dayOfMonth = d.getUTCDate();
      const year = d.getUTCFullYear();
      const ariaDateStr = `${monthName} ${dayOfMonth}, ${year}`;

      jobLog(job, `Looking for button with aria-label containing "${ariaDateStr}" and "Available"...`);

      // Human-like delay between date cell clicks
      if (clickCount > 0) {
        await page.waitForTimeout(humanDelay(400, 900));
      }

      try {
        let clicked = false;

        // If a specific trailhead is targeted, try its cells first
        if (job.trailheadName) {
          const trailBtn = page.locator(
            `button.rec-availability-date[aria-label*="${job.trailheadName}"][aria-label*="${ariaDateStr}"][aria-label*="Available"]:not([disabled])`,
          );
          const trailCount = await trailBtn.count();
          jobLog(job, `  Trailhead "${job.trailheadName}": found ${trailCount} matching button(s)`);
          if (trailCount > 0) {
            await trailBtn.first().click({ timeout: 5000 });
            clickCount++;
            clicked = true;
            jobLog(job, `  Trailhead cell clicked! (${clickCount} total)`);
            await page.waitForTimeout(humanDelay(200, 500));
          } else {
            jobLog(job, `  Target trailhead not available for ${nightDate}, falling back to any available...`);
          }
        }

        if (!clicked) {
          const btn = page.locator(
            `button.rec-availability-date[aria-label*="${ariaDateStr}"][aria-label*="Available"]:not([disabled])`,
          );
          const count = await btn.count();
          jobLog(job, `  Found ${count} matching button(s)`);

          if (count > 0) {
            await btn.first().click({ timeout: 5000 });
            clickCount++;
            jobLog(job, `  Clicked! (${clickCount} total)`);
            await page.waitForTimeout(humanDelay(200, 500));
          } else {
            const fallback = page.locator(
              `button[aria-label*="${ariaDateStr}"]:not([disabled])`,
            );
            const fbCount = await fallback.count();
            jobLog(job, `  Fallback: found ${fbCount} button(s)`);
            if (fbCount > 0) {
              await fallback.first().click({ timeout: 5000 });
              clickCount++;
              jobLog(job, `  Fallback clicked! (${clickCount} total)`);
              await page.waitForTimeout(humanDelay(200, 500));
            } else {
              jobLog(job, `  No available button found for ${nightDate}`);
            }
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

    await page.waitForTimeout(humanDelay(800, 1500));
    await saveScreenshot(page, job, "after-cell-click");

    const clickDatesMs = await logStepTiming(job, "click date cells", async () => {
      return clickCount;
    });
    void clickDatesMs;

    // Check again for abnormal activity before clicking Book Now
    if (await hasAbnormalActivityError(page)) {
      jobLog(job, "Abnormal activity error appeared after selecting dates.");
      await saveScreenshot(page, job, "abnormal-after-dates");
      return "failed";
    }

    await page.waitForTimeout(humanDelay(500, 1000));

    jobLog(job, "Looking for Book Now button...");
    let bookClicked = false;
    await logStepTiming(job, "click Book Now + wait for order details", async () => {
      try {
        const bookBtn = page.locator('button:has-text("Book Now")');
        const bookCount = await bookBtn.count();
        jobLog(job, `Found ${bookCount} "Book Now" button(s)`);
        if (bookCount > 0) {
          await page.waitForTimeout(humanDelay(300, 700));
          await bookBtn.first().click({ timeout: 5000 });
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
              await page.waitForTimeout(humanDelay(300, 600));
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
        throw new Error("No booking button found");
      }

      await page.waitForTimeout(2500);
      await saveScreenshot(page, job, "after-book-click");
    });

    // Check if a login modal appeared after clicking Book Now
    const loginNeeded = await handleLoginModal(page, job);

    if (loginNeeded) {
      jobLog(job, "Session expired mid-booking. Retrying booking flow after re-auth...");

      const facilityId2 = job.permitId || job.campgroundId;
      const retryUrl = `https://www.recreation.gov/permits/${facilityId2}/registration/detailed-availability?date=${targetRange.startDate}&type=overnight`;
      jobLog(job, "Re-navigating to:", retryUrl);
      await safeGoto(page, job, retryUrl, "retry-booking-nav");
      await page.waitForTimeout(1500);

      await setGroupSize(page, job);
      if (job.startingArea) {
        await clickStartingAreaFilter(page, job);
      }
      await page.waitForTimeout(humanDelay(800, 1500));
      await debugPageState(page, job, "retry-booking-page");

      const retryNightDates = expandRange(targetRange);
      let retryClickCount = 0;
      for (const nightDate of retryNightDates) {
        const d = new Date(nightDate + "T00:00:00");
        const monthName = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
        const dayOfMonth = d.getUTCDate();
        const year = d.getUTCFullYear();
        const ariaDateStr = `${monthName} ${dayOfMonth}, ${year}`;

        let selector: string;
        if (job.trailheadName) {
          selector = `button.rec-availability-date[aria-label*="${job.trailheadName}"][aria-label*="${ariaDateStr}"][aria-label*="Available"]:not([disabled])`;
        } else {
          selector = `button.rec-availability-date[aria-label*="${ariaDateStr}"][aria-label*="Available"]:not([disabled])`;
        }

        jobLog(job, `[retry] Looking for date cell: ${ariaDateStr}...`);
        const cells = page.locator(selector);
        const count = await cells.count();
        if (count > 0) {
          await cells.first().click();
          retryClickCount++;
          jobLog(job, `  [retry] Clicked! (${retryClickCount} total)`);
          await page.waitForTimeout(humanDelay(400, 800));
        }
      }

      if (retryClickCount === 0) {
        jobLog(job, "[retry] No date cells found after re-auth.");
        await saveScreenshot(page, job, "retry-no-dates");
        return "failed";
      }

      await page.waitForTimeout(humanDelay(500, 1000));
      const retryBookBtn = page.locator('button:has-text("Book Now")');
      if ((await retryBookBtn.count()) > 0) {
        await retryBookBtn.first().click({ timeout: 5000 });
        jobLog(job, "[retry] Clicked Book Now!");
        await page.waitForTimeout(2500);
        await saveScreenshot(page, job, "retry-after-book-click");
      } else {
        jobLog(job, "[retry] No Book Now button found.");
        await saveScreenshot(page, job, "retry-no-book-btn");
        return "failed";
      }
    }

    let orderSuccess = false;
    await logStepTiming(job, "fill order details + proceed to cart", async () => {
      orderSuccess = await fillOrderDetails(page, job);
    });
    if (orderSuccess) {
      jobLog(job, "Order details filled and proceeded to cart!");
      return "booked";
    } else {
      jobLog(job, "Order details filling failed, but booking was clicked. Check browser.");
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

    // Fill country (select)
    jobLog(job, `Setting country to ${country}...`);
    await page.locator("select#country").selectOption(country);
    await page.waitForTimeout(300);

    // Fill address
    jobLog(job, `Setting address to "${address}"...`);
    await page.locator("input#address1").fill(address);

    // Fill city
    jobLog(job, `Setting city to "${city}"...`);
    await page.locator("input#city").fill(city);

    // Fill state (select) -- wait for state dropdown to populate after country selection
    jobLog(job, `Setting state to ${state}...`);
    await page.waitForTimeout(300);
    await page.locator("select#state").selectOption(state);

    // Fill zip
    jobLog(job, `Setting zip to "${zip}"...`);
    await page.locator("input#zip_code").fill(zip);

    await page.waitForTimeout(300);
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

    await page.waitForTimeout(300);

    // Click "Proceed to Cart"
    jobLog(job, 'Clicking "Proceed to Cart"...');
    const cartBtn = page.locator('button[data-testid="OrderDetailsSummary-cart-btn"]');
    await cartBtn.waitFor({ timeout: 5000 });
    await cartBtn.click();
    jobLog(job, "Clicked Proceed to Cart!");

    await page.waitForTimeout(3000);
    await saveScreenshot(page, job, "after-proceed-to-cart");

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
): Promise<"booked" | "failed"> {
  try {
    // Try permits path first, fall back to campgrounds path
    let url = `https://www.recreation.gov/permits/${job.campgroundId}/registration/detailed-availability?date=${targetRange.startDate}&type=overnight`;
    jobLog(job, "Navigating to:", url);
    let navRes = await logStepTiming(job, "goto facility page + hydrate", async () => {
      const r = await safeGoto(page, job, url, "campground-page-loaded");
      await page.waitForTimeout(1500);
      return r;
    });

    if (navRes?.is404) {
      jobLog(job, "Permit URL returned 404. Falling back to campground URL...");
      url = `https://www.recreation.gov/camping/campgrounds/${job.campgroundId}/availability`;
      await logStepTiming(job, "goto campground page (fallback) + hydrate", async () => {
        await safeGoto(page, job, url, "campground-page-fallback");
        await page.waitForTimeout(1500);
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

        await startInput.first().click();
        await startInput.first().fill(startFormatted);
        await page.waitForTimeout(500);
        await endInput.first().click();
        await endInput.first().fill(endFormatted);
        await page.waitForTimeout(500);

        // Press Enter or click search to apply dates
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        jobLog(job, "Date input method failed, trying URL params:", msg);
        // Fallback: navigate with date params in URL
        const paramUrl = `${url}?start_date=${targetRange.startDate}&end_date=${targetRange.endDate}`;
        await safeGoto(page, job, paramUrl, "campsite-dates-fallback");
        await page.waitForTimeout(1500);
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
            await bookBtn.first().click({ timeout: 5000 });
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
              `button[aria-label*="${ariaDateStr}"][aria-label*="Available"]:not([disabled])`
            );
            if (await btn.count() > 0) {
              await btn.first().click({ timeout: 5000 });
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
                await btn.first().click({ timeout: 5000 });
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
        const result = await page.evaluate(`(() => {
          const rows = document.querySelectorAll('[class*="campsite-row"], [class*="site-row"], tr[data-component="CampsiteRow"]');
          for (const row of rows) {
            const text = row.textContent || '';
            if (text.includes('Available')) {
              const btn = row.querySelector('button:not([disabled])');
              if (btn) {
                btn.click();
                return 'clicked';
              }
            }
          }
          return 'not-found';
        })()`);

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

    await page.waitForTimeout(2500);
    await saveScreenshot(page, job, "campsite-after-book-click");

    // Fill order details (same form as permits)
    let orderSuccess = false;
    await logStepTiming(job, "fill order details + proceed to cart", async () => {
      orderSuccess = await fillOrderDetails(page, job);
    });

    if (orderSuccess) {
      jobLog(job, "Campsite order details filled and proceeded to cart!");
      return "booked";
    } else {
      jobLog(job, "Order details filling failed, but booking was clicked.");
      return "booked";
    }
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

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  console.log("[sniper] Signing in...");

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto("https://www.recreation.gov/log-in", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries && (msg.includes("ERR_HTTP_RESPONSE_CODE_FAILURE") || msg.includes("ERR_TIMED_OUT") || msg.includes("ERR_CONNECTION"))) {
        console.log(`[sniper] Sign-in page load failed (attempt ${attempt}/${maxRetries}): ${msg.slice(0, 100)}. Retrying in ${attempt * 3}s...`);
        await page.waitForTimeout(attempt * 3000);
        continue;
      }
      throw err;
    }
  }

  await page.waitForTimeout(1500);
  await dismissOutdatedBrowserBanner(page);

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
    await page.waitForTimeout(1500);
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
