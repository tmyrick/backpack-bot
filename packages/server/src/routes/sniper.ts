import { Router, type Request, type Response } from "express";
import {
  createJob,
  getJobs,
  getJob,
  cancelJob,
  deleteJob,
  subscribeToSniperUpdates,
  type SniperJobRequest,
} from "../services/sniper.js";

export const sniperRoutes = Router();

// ---- Create a new sniper job ----

sniperRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body as SniperJobRequest;

    // Validate required fields
    if (!body.permitId || !body.desiredDateRanges?.length || !body.windowOpensAt) {
      res.status(400).json({
        error:
          "Missing required fields: permitId, desiredDateRanges, windowOpensAt",
      });
      return;
    }

    // Validate each date range has both start and end
    for (const range of body.desiredDateRanges) {
      if (!range.startDate || !range.endDate) {
        res.status(400).json({
          error: "Each date range must have a startDate and endDate",
        });
        return;
      }
      if (range.endDate <= range.startDate) {
        res.status(400).json({
          error: `End date must be after start date (got ${range.startDate} to ${range.endDate})`,
        });
        return;
      }
    }

    const job = await createJob(body);
    res.status(201).json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[sniper:routes] Error creating job:", message);
    res.status(500).json({ error: message });
  }
});

// ---- List all jobs ----

sniperRoutes.get("/", (_req: Request, res: Response) => {
  const allJobs = getJobs();
  res.json({ jobs: allJobs });
});

// ---- SSE stream for live updates ----
// IMPORTANT: must be before /:id to avoid "events" matching as an id param

sniperRoutes.get("/events/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send all current jobs as initial state
  const allJobs = getJobs();
  for (const job of allJobs) {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
  }

  const unsubscribe = subscribeToSniperUpdates((job) => {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
  });

  req.on("close", () => {
    unsubscribe();
  });
});

// ---- Get a single job ----

sniperRoutes.get("/:id", (req: Request, res: Response) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ job });
});

// ---- Cancel a job ----

sniperRoutes.delete("/:id", async (req: Request, res: Response) => {
  const ok = await deleteJob(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ deleted: true });
});

