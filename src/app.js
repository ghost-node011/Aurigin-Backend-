import express from "express";
import cors from "cors";
import { connectDB } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { employeesRouter } from "./routes/employees.js";
import { leaveRouter } from "./routes/leave.js";
import { wfhRouter } from "./routes/wfh.js";
import { attendanceRouter } from "./routes/attendance.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { kudosRouter } from "./routes/kudos.js";
import { announcementsRouter } from "./routes/announcements.js";
import { settingsRouter } from "./routes/settings.js";
import { requireAuth } from "./middleware/auth.js";

export const app = express();

// Ensures the (cached) DB connection is ready before any route runs — keeps
// the app self-sufficient no matter which entrypoint invokes it (local
// server, Vercel function, tests), instead of relying on the caller to
// connect first.
app.use((_req, _res, next) => {
  connectDB().then(() => next(), next);
});

const allowedOrigins = (process.env.CORS_ORIGIN ?? "").split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : true }));
app.use(express.json());

app.get("/", (_req, res) => res.json({ name: "Aurigin HR API", status: "live", health: "/api/health" }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter); // login is public; /me protects itself

// Everything below requires a valid token.
app.use("/api", requireAuth);

app.use("/api/employees", employeesRouter);
app.use("/api/leave-requests", leaveRouter);
app.use("/api/wfh-requests", wfhRouter);
app.use("/api/attendance", attendanceRouter);
app.use("/api/onboarding-tasks", onboardingRouter);
app.use("/api/kudos", kudosRouter);
app.use("/api/announcements", announcementsRouter);
app.use("/api/settings", settingsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// Express apps are themselves valid (req, res) handlers, so this default
// export satisfies Vercel's "default export must be a function" requirement
// directly — no matter which file Vercel actually invokes.
export default app;
