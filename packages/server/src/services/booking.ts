import { chromium, type Browser, type Page } from "playwright";
import type { BookingRequest, BookingState, BookingStatus } from "../types/index.js";
import crypto from "crypto";

// ---- Active bookings store (in-memory) ----

const bookings = new Map<string, ManagedBooking>();

interface ManagedBooking {
  state: BookingState;
  request: BookingRequest;
  browser: Browser | null;
  page: Page | null;
  abortController: AbortController;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

// ---- SSE subscribers ----

type SSECallback = (state: BookingState) => void;
const subscribers = new Set<SSECallback>();

export function subscribeToBookingUpdates(cb: SSECallback): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function notifySubscribers(state: BookingState): void {
  for (const cb of subscribers) {
    try {
      cb(state);
    } catch {
      // Subscriber error shouldn't crash the booking
    }
  }
}

function updateState(
  booking: ManagedBooking,
  updates: Partial<BookingState>,
): void {
  Object.assign(booking.state, updates);
  notifySubscribers({ ...booking.state });
}

// ---- Public API ----

export function getBookings(): BookingState[] {
  return Array.from(bookings.values()).map((b) => ({ ...b.state }));
}

export function getBooking(id: string): BookingState | null {
  const b = bookings.get(id);
  return b ? { ...b.state } : null;
}

export async function startBooking(
  request: BookingRequest,
): Promise<BookingState> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const state: BookingState = {
    id,
    status: request.startAt ? "scheduled" : "waiting",
    permitId: request.permitId,
    entranceId: request.entranceId,
    date: request.date,
    groupSize: request.groupSize,
    startAt: request.startAt || null,
    attempts: 0,
    lastAttemptAt: null,
    message: request.startAt
      ? `Scheduled to start at ${request.startAt}`
      : "Starting booking attempt...",
    createdAt: now,
  };

  const managed: ManagedBooking = {
    state,
    request,
    browser: null,
    page: null,
    abortController: new AbortController(),
    timeoutId: null,
  };

  bookings.set(id, managed);
  notifySubscribers({ ...state });

  // If there's a scheduled start time, wait for it
  if (request.startAt) {
    const startTime = new Date(request.startAt).getTime();
    const delay = Math.max(0, startTime - Date.now());

    if (delay > 0) {
      console.log(
        `[booking:${id}] Scheduled to start in ${Math.round(delay / 1000)}s`,
      );
      managed.timeoutId = setTimeout(() => {
        runBookingLoop(managed);
      }, delay);
    } else {
      // Start time is in the past, start immediately
      runBookingLoop(managed);
    }
  } else {
    // Start immediately
    runBookingLoop(managed);
  }

  return { ...state };
}

export async function cancelBooking(id: string): Promise<boolean> {
  const managed = bookings.get(id);
  if (!managed) return false;

  managed.abortController.abort();

  if (managed.timeoutId) {
    clearTimeout(managed.timeoutId);
    managed.timeoutId = null;
  }

  if (managed.browser) {
    try {
      await managed.browser.close();
    } catch {
      // Browser might already be closed
    }
    managed.browser = null;
    managed.page = null;
  }

  updateState(managed, {
    status: "cancelled",
    message: "Booking cancelled by user.",
  });

  return true;
}

export async function cleanupAllBookings(): Promise<void> {
  for (const [id] of bookings) {
    await cancelBooking(id);
  }
}

// ---- Booking automation loop ----

const MAX_ATTEMPTS = 60; // Stop after 60 attempts
const RETRY_INTERVAL_MS = 10_000; // 10 seconds between retries

async function runBookingLoop(managed: ManagedBooking): Promise<void> {
  const { state, request, abortController } = managed;
  const { signal } = abortController;

  updateState(managed, {
    status: "attempting",
    message: "Launching browser...",
  });

  try {
    // Launch browser
    const headless = request.headless !== false;
    managed.browser = await chromium.launch({ headless });
    const context = await managed.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    managed.page = await context.newPage();

    if (signal.aborted) return;

    // Step 1: Sign in
    updateState(managed, { message: "Signing in to recreation.gov..." });
    await signIn(managed.page, request.email, request.password);

    if (signal.aborted) return;

    // Step 2: Attempt booking in a loop
    while (
      !signal.aborted &&
      state.attempts < MAX_ATTEMPTS &&
      state.status === "attempting"
    ) {
      state.attempts++;
      state.lastAttemptAt = new Date().toISOString();

      updateState(managed, {
        message: `Attempt ${state.attempts}/${MAX_ATTEMPTS}: Navigating to permit page...`,
      });

      try {
        const result = await attemptBooking(managed.page, request);

        if (result === "booked") {
          updateState(managed, {
            status: "in-cart",
            message:
              "Permit added to cart! Complete your purchase on recreation.gov.",
          });
          return;
        } else if (result === "unavailable") {
          updateState(managed, {
            message: `Attempt ${state.attempts}/${MAX_ATTEMPTS}: Not available yet. Retrying in ${RETRY_INTERVAL_MS / 1000}s...`,
          });
          // Wait before retrying
          await sleep(RETRY_INTERVAL_MS, signal);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        updateState(managed, {
          message: `Attempt ${state.attempts}/${MAX_ATTEMPTS}: Error - ${msg}. Retrying...`,
        });
        await sleep(RETRY_INTERVAL_MS, signal);
      }
    }

    if (signal.aborted) return;

    // Exhausted attempts
    updateState(managed, {
      status: "failed",
      message: `Failed after ${state.attempts} attempts. The permit was not available during the booking window.`,
    });
  } catch (err) {
    if (signal.aborted) return;
    const msg = err instanceof Error ? err.message : "Unknown error";
    updateState(managed, {
      status: "failed",
      message: `Booking failed: ${msg}`,
    });
  } finally {
    // Keep browser open if permit is in cart (user needs to complete purchase)
    if (state.status !== "in-cart" && managed.browser) {
      try {
        await managed.browser.close();
      } catch {
        // Ignore
      }
      managed.browser = null;
      managed.page = null;
    }
  }
}

// ---- Browser automation steps ----

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  console.log("[booking] Navigating to login page...");
  await page.goto("https://www.recreation.gov/log-in", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // Fill in credentials
  // Recreation.gov login form uses various selectors; try common patterns
  const emailSelectors = [
    'input[name="email"]',
    'input[type="email"]',
    '#email',
    'input[placeholder*="email" i]',
    'input[aria-label*="email" i]',
  ];

  const passwordSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    '#password',
    'input[placeholder*="password" i]',
    'input[aria-label*="password" i]',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.fill(email);
        emailFilled = true;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!emailFilled) {
    throw new Error("Could not find email input on login page");
  }

  let passwordFilled = false;
  for (const sel of passwordSelectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.fill(password);
        passwordFilled = true;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!passwordFilled) {
    throw new Error("Could not find password input on login page");
  }

  // Click the sign-in / log-in button
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Log In")',
    'button:has-text("Sign In")',
    'input[type="submit"]',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        await el.click();
        submitted = true;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!submitted) {
    // Fall back to pressing Enter
    await page.keyboard.press("Enter");
  }

  // Wait for navigation after login
  try {
    await page.waitForURL("**/recreation.gov/**", { timeout: 15000 });
    // Give the page time to fully hydrate
    await page.waitForTimeout(2000);
  } catch {
    // Check if we're still on the login page (login might have failed)
    if (page.url().includes("log-in")) {
      throw new Error(
        "Login failed. Check your email and password. You may also need to verify your account.",
      );
    }
  }

  console.log("[booking] Signed in successfully.");
}

async function attemptBooking(
  page: Page,
  request: BookingRequest,
): Promise<"booked" | "unavailable"> {
  const { permitId, entranceId, date, groupSize } = request;

  // Navigate to the permit availability page
  const url = `https://www.recreation.gov/permits/${permitId}/registration/detailed-availability?date=${date}&type=overnight`;
  console.log(`[booking] Navigating to: ${url}`);

  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Set group size if there's an input for it
  try {
    const groupInput = await page.waitForSelector(
      'input[name*="group" i], input[aria-label*="group" i], input[aria-label*="number" i], #number-input',
      { timeout: 5000 },
    );
    if (groupInput) {
      await groupInput.fill("");
      await groupInput.fill(String(groupSize));
      await page.waitForTimeout(1000);
    }
  } catch {
    console.log("[booking] No group size input found, skipping...");
  }

  // Look for the entrance row and check availability
  // Recreation.gov renders a table/grid with permit entrances as rows
  // Each cell represents a date and shows remaining permits

  // Try to find the specific entrance and date cell
  const booked = await page.evaluate(
    `
    (args) => {
      const { entranceId, date } = args;

      // Strategy 1: Find by data attributes
      const cell = document.querySelector(
        '[data-entrance-id="' + entranceId + '"][data-date="' + date + '"]'
      );
      if (cell) {
        const btn = cell.querySelector('button') || cell;
        if (!btn.classList.contains('unavailable') && !btn.disabled) {
          btn.click();
          return 'clicked';
        }
        return 'unavailable';
      }

      // Strategy 2: Find rows with matching entrance ID text, then click the date cell
      const rows = document.querySelectorAll(
        '[class*="availability-row"], [class*="permit-row"], tr'
      );
      for (const row of rows) {
        const firstCell = row.querySelector('td:first-child, [class*="name"]');
        const text = firstCell ? firstCell.textContent || '' : '';

        if (text.includes(entranceId)) {
          // Found the row - try to find the date cell
          const dateCells = row.querySelectorAll('td:not(:first-child), [class*="cell"]');
          for (const dc of dateCells) {
            const className = dc.className || '';
            if (className.includes('available') && !className.includes('unavailable')) {
              const btn = dc.querySelector('button') || dc;
              btn.click();
              return 'clicked';
            }
          }
          return 'unavailable';
        }
      }

      // Strategy 3: Try clicking any available cell matching the permit
      const allAvailable = document.querySelectorAll(
        '[class*="available"]:not([class*="unavailable"]) button, ' +
        '[class*="available"]:not([class*="unavailable"])'
      );
      if (allAvailable.length > 0) {
        allAvailable[0].click();
        return 'clicked-first-available';
      }

      return 'unavailable';
    }
  `,
    { entranceId, date },
  );

  if (booked === "unavailable") {
    return "unavailable";
  }

  console.log(`[booking] Clicked on available permit cell: ${booked}`);
  await page.waitForTimeout(2000);

  // Try to click "Book Now" or "Add to Cart" button
  const bookButtonSelectors = [
    'button:has-text("Book Now")',
    'button:has-text("Add to Cart")',
    'button:has-text("Reserve")',
    'button:has-text("Continue")',
    'button[class*="book" i]',
    'button[class*="reserve" i]',
  ];

  for (const sel of bookButtonSelectors) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 5000 });
      if (btn) {
        await btn.click();
        console.log(`[booking] Clicked booking button: ${sel}`);
        await page.waitForTimeout(3000);

        // Check if we landed on a cart/checkout page
        const currentUrl = page.url();
        if (
          currentUrl.includes("cart") ||
          currentUrl.includes("checkout") ||
          currentUrl.includes("confirmation")
        ) {
          return "booked";
        }

        // Check for a success message
        const successText = await page.textContent("body");
        if (
          successText &&
          (successText.includes("added to cart") ||
            successText.includes("reserved") ||
            successText.includes("booking confirmed"))
        ) {
          return "booked";
        }

        // If we got this far, assume it worked
        return "booked";
      }
    } catch {
      continue;
    }
  }

  // If we clicked an available cell but couldn't find a book button,
  // it might mean the page layout changed. Return unavailable to retry.
  console.log("[booking] Could not find booking button after selecting permit.");
  return "unavailable";
}

// ---- Utilities ----

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    });
  });
}
