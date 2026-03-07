import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { permitRoutes } from "./routes/permits.js";
import { bookingRoutes } from "./routes/booking.js";
import { sniperRoutes } from "./routes/sniper.js";
import { campgroundRoutes } from "./routes/campgrounds.js";
import { closeBrowser } from "./services/availability.js";
import { cleanupAllBookings } from "./services/booking.js";
import {
  loadAndScheduleJobs,
  cleanupAllSniper,
} from "./services/sniper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json());

app.use("/api/permits", permitRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/sniper", sniperRoutes);
app.use("/api/campgrounds", campgroundRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Serve screenshots for debugging (list + individual files)
const screenshotsDir = path.join(
  process.env.DATA_DIR || path.resolve(__dirname, "../../../data"),
  "screenshots",
);

app.get("/api/screenshots", async (_req, res) => {
  try {
    const files = await fs.promises.readdir(screenshotsDir);
    const pngs = files.filter((f) => f.endsWith(".png")).sort().reverse();
    res.json({ screenshots: pngs });
  } catch {
    res.json({ screenshots: [] });
  }
});

app.get("/api/screenshots/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(screenshotsDir, filename);
  if (!fs.existsSync(filepath)) {
    res.status(404).json({ error: "Screenshot not found" });
    return;
  }
  res.sendFile(filepath);
});

// In production, serve the built client static files
const clientDistPath = process.env.CLIENT_DIST_PATH
  || path.resolve(__dirname, "../../client/dist");

if (fs.existsSync(clientDistPath)) {
  console.log(`[backpack-bot] Serving static files from ${clientDistPath}`);
  app.use(express.static(clientDistPath));

  // Catch-all: return index.html for client-side routing.
  // Use middleware instead of a route so we avoid path-to-regexp catch-all syntax.
  app.use((_req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

// Log unhandled errors so we can see why the process might exit
process.on("uncaughtException", (err) => {
  console.error("[backpack-bot] uncaughtException:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[backpack-bot] unhandledRejection:", reason);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[backpack-bot] Server listening on 0.0.0.0:${PORT}`);

  // Defer async startup so the server is definitely listening before we do I/O
  setImmediate(async () => {
    try {
      await loadAndScheduleJobs();
    } catch (err) {
      console.error("[backpack-bot] Failed to load sniper jobs:", err);
    }
  });
});

// Graceful shutdown
async function shutdown() {
  console.log("\n[backpack-bot] Shutting down...");
  await cleanupAllBookings();
  await cleanupAllSniper();
  await closeBrowser();
  server.close(() => {
    console.log("[backpack-bot] Server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
