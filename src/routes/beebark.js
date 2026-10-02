import { Router } from "express";
import { requireRole } from "../middleware/auth.js";

/**
 * BeeBark's pre-launch waitlist, for admins only (Arjun and Gaurank).
 *
 * Fetched server to server from BeeBark's read-only external API, so the
 * BeeBark key (BEEBARK_WAITLIST_API_KEY) never reaches the browser.
 * BEEBARK_API_URL is BeeBark's backend origin, e.g. https://api.thebeebark.com.
 */
export const beebarkRouter = Router();
beebarkRouter.use(requireRole("admin"));

const PASSTHROUGH = ["page", "limit", "q", "role", "careerStage", "interest", "source", "from", "to"];

function upstream(path, query) {
  const base = (process.env.BEEBARK_API_URL || "").replace(/\/$/, "");
  const key = process.env.BEEBARK_WAITLIST_API_KEY;
  if (!base || !key) return null;
  const params = new URLSearchParams(
    Object.entries(query).filter(([k, v]) => PASSTHROUGH.includes(k) && typeof v === "string" && v !== ""),
  );
  return fetch(`${base}/api/external/waitlist${path}?${params}`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(20_000),
  });
}

async function relay(res, response) {
  if (!response) return res.status(503).json({ error: "BeeBark isn't connected — set BEEBARK_API_URL and BEEBARK_WAITLIST_API_KEY." });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return res.status(502).json({ error: `BeeBark returned ${response.status}${body.error ? `: ${body.error}` : ""}` });
  }
  return null;
}

beebarkRouter.get("/waitlist", async (req, res) => {
  try {
    const response = await upstream("", req.query);
    if (await relay(res, response)) return;
    res.json(await response.json());
  } catch (err) {
    res.status(502).json({ error: `Couldn't reach BeeBark: ${err.message}` });
  }
});

beebarkRouter.get("/waitlist/export", async (req, res) => {
  try {
    const response = await upstream("/export", req.query);
    if (await relay(res, response)) return;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="beebark-waitlist.csv"');
    res.send(await response.text());
  } catch (err) {
    res.status(502).json({ error: `Couldn't reach BeeBark: ${err.message}` });
  }
});
