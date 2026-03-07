import { Router } from "express";
import {
  getPermitFacilities,
  getPermitDetail,
} from "../services/ridb.js";
import { scrapeAvailability } from "../services/availability.js";

const router = Router();

/**
 * GET /api/permits?state=OR
 * Returns permit facilities for a given state (defaults to OR).
 */
router.get("/", async (req, res) => {
  try {
    const state = (req.query.state as string || "OR").toUpperCase();
    const permits = await getPermitFacilities(state);
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
 * GET /api/permits/:permitId/starting-areas
 * Groups a permit's divisions by district to detect "starting area" permits.
 * Returns { hasStartingAreas, startingAreas: [{ name, trailheads: [{ divisionId, name }] }] }
 */
router.get("/:permitId/starting-areas", async (req, res) => {
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
    const payload = data.payload;

    interface DivEntry { divisionId: string; name: string; district: string }
    const allDivisions: DivEntry[] = [];

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      for (const [id, val] of Object.entries(payload)) {
        const v = val as Record<string, unknown>;
        allDivisions.push({
          divisionId: id,
          name: (v.name as string) || (v.division_name as string) || `Division ${id}`,
          district: (v.district as string) || "",
        });
      }
    } else if (Array.isArray(payload)) {
      for (const d of payload) {
        allDivisions.push({
          divisionId: d.division_id || d.id || String(d),
          name: d.name || d.division_name || `Division ${d.division_id || d.id}`,
          district: d.district || "",
        });
      }
    }

    const districts = new Set(allDivisions.map((d) => d.district).filter(Boolean));

    if (districts.size > 1) {
      const grouped = new Map<string, DivEntry[]>();
      for (const div of allDivisions) {
        const key = div.district || "Other";
        const list = grouped.get(key) || [];
        list.push(div);
        grouped.set(key, list);
      }

      const startingAreas = Array.from(grouped.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, trailheads]) => ({
          name,
          trailheads: trailheads
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => ({ divisionId: t.divisionId, name: t.name })),
        }));

      res.json({ hasStartingAreas: true, startingAreas });
    } else {
      res.json({
        hasStartingAreas: false,
        startingAreas: [],
        trailheads: allDivisions
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => ({ divisionId: t.divisionId, name: t.name })),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[permits] Error fetching starting areas:", message);
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
