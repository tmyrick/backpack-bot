import express from "express";
import cors from "cors";
import { permitRoutes } from "./routes/permits.js";
import { bookingRoutes } from "./routes/booking.js";
import { closeBrowser } from "./services/availability.js";
import { cleanupAllBookings } from "./services/booking.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use("/api/permits", permitRoutes);
app.use("/api/booking", bookingRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, () => {
  console.log(`[backpack-bot] Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
async function shutdown() {
  console.log("\n[backpack-bot] Shutting down...");
  await cleanupAllBookings();
  await closeBrowser();
  server.close(() => {
    console.log("[backpack-bot] Server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
