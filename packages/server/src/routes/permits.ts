import { Router } from "express";
import {
  getOregonPermitFacilities,
  getPermitDetail,
} from "../services/ridb.js";
import { scrapeAvailability } from "../services/availability.js";

const router = Router();

/**
 * GET /api/permits
 * Returns all Oregon permit facilities.
 */
router.get("/", async (_req, res) => {
  try {
    const permits = await getOregonPermitFacilities();
    res.json({ permits });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[permits] Error fetching permits:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/permits/:permitId
 * Returns detailed info for a specific permit facility,
 * including entrances and zones.
 */
router.get("/:permitId", async (req, res) => {
  try {
    const { permitId } = req.params;
    const permit = await getPermitDetail(permitId);
    if (!permit) {
      res.status(404).json({ error: "Permit not found" });
      return;
    }
    res.json({ permit });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[permits] Error fetching permit detail:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/permits/:permitId/divisions
 * Returns division names for a permit (proxied from recreation.gov).
 */
router.get("/:permitId/divisions", async (req, res) => {
  const { permitId } = req.params;
  try {
    const response = await fetch(
      `https://www.recreation.gov/api/permits/${permitId}/divisions`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) {
      res.status(response.status).json({ error: `Upstream: ${response.statusText}` });
      return;
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[permits] Error fetching divisions:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/permits/:permitId/availability?month=YYYY-MM
 * Scrapes recreation.gov for real-time availability data.
 */
router.get("/:permitId/availability", async (req, res) => {
  const { permitId } = req.params;
  const month = req.query.month as string;

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: "month query parameter required (YYYY-MM)" });
    return;
  }

  try {
    const availability = await scrapeAvailability(permitId, month);
    res.json({ availability });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[permits] Error scraping availability:", message);
    res.status(500).json({ error: message });
  }
});

export { router as permitRoutes };
