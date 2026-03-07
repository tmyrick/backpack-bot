import { Router } from "express";
import {
  getCampgroundFacilities,
  getCampsitesForFacility,
} from "../services/ridb.js";

const router = Router();

/**
 * GET /api/campgrounds?state=OR
 * Returns campground facilities for a given state (defaults to OR).
 */
router.get("/", async (req, res) => {
  try {
    const state = (req.query.state as string || "OR").toUpperCase();
    const campgrounds = await getCampgroundFacilities(state);
    res.json({ campgrounds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[campgrounds] Error fetching campgrounds:", message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/campgrounds/:campgroundId/campsites
 * Returns campsites for a specific campground from RIDB.
 */
router.get("/:campgroundId/campsites", async (req, res) => {
  try {
    const { campgroundId } = req.params;
    const campsites = await getCampsitesForFacility(campgroundId);
    res.json({ campsites });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[campgrounds] Error fetching campsites:", message);
    res.status(500).json({ error: message });
  }
});

export { router as campgroundRoutes };
