import { Router } from "express";
import { BniContact, BNI_CATEGORIES } from "../models/BniContact.js";
import { Employee } from "../models/Employee.js";
import { requireRole } from "../middleware/auth.js";
import { filterFrom } from "./bni.js";

/**
 * Email BNI members through BeeBark (admins only).
 *
 * Recipients are picked here from the BNI data, then handed to BeeBark's
 * comms API, which sends from no-reply@thebeebark.com and tracks delivery,
 * opens, clicks and bounces. Called server to server so BEEBARK_COMMS_API_KEY
 * never reaches the browser. BEEBARK_API_URL is BeeBark's backend origin.
 */
export const bniCommsRouter = Router();
bniCommsRouter.use(requireRole("admin"));

// The template each BNI category gets by default
// Step 1 is the intro without links (reaches Gmail's Primary tab); step 2,
// sent from Email reports, is the follow-up with links in the same thread.
export const TEMPLATE_FOR_CATEGORY = {
  architects: "bni-architects-intro",
  "interior designer": "bni-interiors-intro",
  construction: "bni-construction-intro",
  "real estate": "bni-real-estate-intro",
};
const FOLLOW_UP_FOR = (templateId) => templateId.replace(/-(intro|letter)$/, "") + "-links";

const FILTER_KEYS = ["category", "phone", "email", "verified", "q"];
const pickFilters = (raw = {}) =>
  Object.fromEntries(FILTER_KEYS.filter((k) => typeof raw[k] === "string" && raw[k] !== "").map((k) => [k, raw[k]]));

// Everyone matching the BNI filters who has an email address
const recipientFilter = (filters) => ({ ...filterFrom(filters), hasEmail: true });

async function beebark(path, { method = "GET", body, query } = {}) {
  const base = (process.env.BEEBARK_API_URL || "").replace(/\/$/, "");
  const key = process.env.BEEBARK_COMMS_API_KEY;
  if (!base || !key) {
    const err = new Error("BeeBark email isn't connected — set BEEBARK_API_URL and BEEBARK_COMMS_API_KEY.");
    err.status = 503;
    throw err;
  }
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => typeof v === "string" && v !== ""))}` : "";
  const res = await fetch(`${base}/api/external/comms${path}${qs}`, {
    method,
    headers: { "x-api-key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ? `BeeBark: ${data.error}` : `BeeBark returned ${res.status}`);
    err.status = res.status >= 500 ? 502 : res.status;
    throw err;
  }
  return data;
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(err.status || 502).json({ error: err.message }));

const relay = (path) => wrap(async (req, res) => res.json(await beebark(path(req), { query: req.query })));

/** Templates (without HTML) plus the default template per category. */
bniCommsRouter.get("/templates", wrap(async (_req, res) => {
  const data = await beebark("/templates");
  res.json({ ...data, defaults: TEMPLATE_FOR_CATEGORY, followUpFor: Object.fromEntries(data.items.map((t) => [t.templateId, FOLLOW_UP_FOR(t.templateId)])) });
}));

/** Rendered preview: { templateId, name } */
bniCommsRouter.post("/preview", wrap(async (req, res) => {
  res.json(await beebark("/preview", { method: "POST", body: { templateId: req.body.templateId, name: req.body.name || "" } }));
}));

/** How many members the filters would email: ?category&phone&verified&q */
bniCommsRouter.get("/audience", wrap(async (req, res) => {
  const filters = pickFilters(req.query);
  const total = await BniContact.countDocuments(recipientFilter(filters));
  const byCategory = await BniContact.aggregate([
    { $match: recipientFilter(filters) },
    { $group: { _id: "$category", n: { $sum: 1 } } },
  ]);
  res.json({ total, byCategory: Object.fromEntries(byCategory.map((r) => [r._id, r.n])) });
}));

/**
 * Send. { templateId, filters, confirmCount } emails everyone matching the
 * filters; confirmCount must equal the current count, so a change in the data
 * can't silently widen a send. { templateId, test: true, testEmails } sends a
 * test copy to up to 5 typed addresses, or to the signed-in admin.
 */
bniCommsRouter.post("/send", wrap(async (req, res) => {
  const { templateId, test } = req.body;
  if (typeof templateId !== "string" || !templateId) return res.status(400).json({ error: "Choose a template" });
  const me = await Employee.findById(req.employeeId, { name: 1, email: 1 }).lean();

  if (test === true) {
    // Test to the addresses typed in the portal (up to 5), or to yourself
    const typed = String(req.body.testEmails ?? "")
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (typed.length > 5) return res.status(400).json({ error: "Send a test to at most 5 addresses" });
    const invalid = typed.filter((e) => !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e));
    if (invalid.length) return res.status(400).json({ error: `Not a valid email: ${invalid.join(", ")}` });
    const recipients = typed.length
      ? typed.map((email) => ({ email, name: email === me?.email?.toLowerCase() ? me.name : "" }))
      : [{ email: me?.email, name: me?.name }];
    const result = await beebark("/send", {
      method: "POST",
      body: { templateId, test: true, source: "bni", createdBy: me?.email ?? "", recipients },
    });
    return res.status(201).json({ ...result, sentTo: recipients.map((r) => r.email) });
  }

  const filters = pickFilters(req.body.filters);
  if (filters.category && !BNI_CATEGORIES.includes(filters.category)) return res.status(400).json({ error: "Unknown category" });
  const contacts = await BniContact.find(recipientFilter(filters), { name: 1, email: 1, company: 1, category: 1, city: 1 }).lean();
  if (contacts.length === 0) return res.status(400).json({ error: "No members with an email match these filters" });
  if (Number(req.body.confirmCount) !== contacts.length) {
    return res.status(409).json({ error: `The audience changed to ${contacts.length} members. Check and confirm again.`, total: contacts.length });
  }

  const result = await beebark("/send", {
    method: "POST",
    body: {
      templateId,
      source: "bni",
      audience: filters.category ?? "",
      filters,
      createdBy: me?.email ?? "",
      recipients: contacts.map((c) => ({
        email: c.email,
        name: c.name,
        externalId: String(c._id),
        variables: { company: c.company || "", city: c.city || "", category: c.category },
      })),
    },
  });
  res.status(201).json(result);
}));

/**
 * Follow-up to everyone an earlier send reached (skips bounced, failed,
 * spam-reported and unsubscribed). { templateId, dryRun: true } returns the
 * count; a real send needs confirmCount equal to that count.
 */
bniCommsRouter.post("/requests/:requestId/follow-up", wrap(async (req, res) => {
  const { templateId } = req.body;
  if (typeof templateId !== "string" || !templateId) return res.status(400).json({ error: "Choose a template" });
  const me = await Employee.findById(req.employeeId, { email: 1 }).lean();
  const body = { templateId, followUpOf: req.params.requestId, createdBy: me?.email ?? "" };
  const count = await beebark("/send", { method: "POST", body: { ...body, dryRun: true } });
  if (req.body.dryRun === true) return res.json(count);
  if (Number(req.body.confirmCount) !== count.queued) {
    return res.status(409).json({ error: `The follow-up audience is now ${count.queued}. Check and confirm again.`, queued: count.queued });
  }
  res.status(201).json(await beebark("/send", { method: "POST", body }));
}));

bniCommsRouter.get("/requests", wrap(async (req, res) => {
  res.json(await beebark("/requests", { query: { ...req.query, source: "bni" } }));
}));
bniCommsRouter.get("/requests/:requestId", relay((req) => `/requests/${encodeURIComponent(req.params.requestId)}`));
bniCommsRouter.post("/requests/:requestId/cancel", wrap(async (req, res) => {
  res.json(await beebark(`/requests/${encodeURIComponent(req.params.requestId)}/cancel`, { method: "POST" }));
}));
bniCommsRouter.get("/logs", relay(() => "/logs"));
bniCommsRouter.get("/logs/:id", relay((req) => `/logs/${encodeURIComponent(req.params.id)}`));
/** Stop one person's email in a send, if it hasn't gone out yet */
bniCommsRouter.post("/logs/:id/cancel", wrap(async (req, res) => {
  res.json(await beebark(`/logs/${encodeURIComponent(req.params.id)}/cancel`, { method: "POST" }));
}));

/** Stop emailing an address, e.g. after they reply "no": { email } */
bniCommsRouter.post("/suppressions", wrap(async (req, res) => {
  res.status(201).json(await beebark("/suppressions", { method: "POST", body: { email: req.body.email, reason: "manual" } }));
}));

/** Latest email status for the BNI contact ids on screen: { ids: [...] } */
bniCommsRouter.post("/status", wrap(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(String).slice(0, 200);
  res.json(await beebark("/status", { method: "POST", body: { source: "bni", externalIds: ids } }));
}));
