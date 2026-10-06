import { Router } from "express";
import mongoose from "mongoose";
import { BniContact, BNI_CATEGORIES } from "../models/BniContact.js";
import { Employee } from "../models/Employee.js";
import { requireRole } from "../middleware/auth.js";
import { beebark } from "./bniComms.js";

/**
 * BNI member data. Admins can do everything; people granted "BNI directory"
 * on their profile can view the directory and remove members, but not export
 * it or see or send emails (those routes are admin-only).
 */
export const bniRouter = Router();

export async function canManageBni(req) {
  if (req.role === "admin") return true;
  const me = await Employee.findById(req.employeeId, { canManageBni: 1 }).lean();
  return Boolean(me?.canManageBni);
}

bniRouter.use(async (req, res, next) => {
  if (await canManageBni(req)) return next();
  res.status(403).json({ error: "Not allowed for your role" });
});

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ?removed=yes lists removed members (admins only, see GET /)
export function filterFrom(q) {
  const filter = { removedAt: q.removed === "yes" ? { $ne: null } : null };
  if (BNI_CATEGORIES.includes(q.category)) filter.category = q.category;
  if (q.phone === "yes") filter.hasPhone = true;
  if (q.phone === "no") filter.hasPhone = false;
  if (q.email === "yes") filter.hasEmail = true;
  if (q.email === "no") filter.hasEmail = false;
  if (q.verified === "yes") filter.verifiedIndian = true;
  if (q.verified === "no") filter.verifiedIndian = false;
  const text = String(q.q ?? "").trim().slice(0, 80);
  if (text) {
    const re = new RegExp(escapeRegex(text), "i");
    filter.$or = [{ name: re }, { company: re }, { chapter: re }, { email: re }, { phone: re }, { mobile: re }, { city: re }];
  }
  return filter;
}

/** Totals per category, with how many have a phone and an email. */
bniRouter.get("/stats", async (_req, res) => {
  const rows = await BniContact.aggregate([
    { $match: { removedAt: null } },
    { $group: { _id: "$category", total: { $sum: 1 }, phone: { $sum: { $cond: ["$hasPhone", 1, 0] } }, email: { $sum: { $cond: ["$hasEmail", 1, 0] } }, verified: { $sum: { $cond: ["$verifiedIndian", 1, 0] } } } },
  ]);
  const byCat = Object.fromEntries(rows.map((r) => [r._id, r]));
  res.json(BNI_CATEGORIES.map((c) => ({ category: c, total: byCat[c]?.total ?? 0, phone: byCat[c]?.phone ?? 0, email: byCat[c]?.email ?? 0, verified: byCat[c]?.verified ?? 0 })));
});

/** A page of contacts: ?category&phone=yes|no&email=yes|no&q&page&limit */
bniRouter.get("/", async (req, res) => {
  if (req.query.removed === "yes" && req.role !== "admin") return res.status(403).json({ error: "Not allowed for your role" });
  const filter = filterFrom(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const [items, total] = await Promise.all([
    BniContact.find(filter).sort({ verifiedIndian: -1, hasPhone: -1, hasEmail: -1, name: 1 }).skip((page - 1) * limit).limit(limit),
    BniContact.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

const CSV_COLUMNS = ["category", "name", "company", "role", "mobile", "phone", "email", "website", "city", "state", "chapter", "business", "verifiedIndian"];
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The current filter as a CSV download. */
bniRouter.get("/export", requireRole("admin"), async (req, res) => {
  const items = await BniContact.find(filterFrom(req.query)).sort({ category: 1, hasPhone: -1, name: 1 }).lean();
  const lines = [CSV_COLUMNS.join(","), ...items.map((i) => CSV_COLUMNS.map((c) => csvCell(i[c])).join(","))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="bni-data${req.query.category ? "-" + String(req.query.category).replace(/\s+/g, "-") : ""}.csv"`);
  res.send("﻿" + lines.join("\n"));
});

const EMAIL_SPLIT = /[\s,;/]+/;
const emailsOf = (contact) => String(contact.email || "").split(EMAIL_SPLIT).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e));

/**
 * Remove members from the directory: { ids: [...] } (up to 500).
 * They disappear from the list, counts and email audiences, and their email
 * addresses go on BeeBark's do-not-email list so no future send reaches them.
 */
bniRouter.post("/remove", async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))].filter((id) => mongoose.isValidObjectId(id)).slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: "Choose at least one member" });
  const me = await Employee.findById(req.employeeId, { name: 1 }).lean();
  const contacts = await BniContact.find({ _id: { $in: ids }, removedAt: null }, { email: 1 }).lean();
  if (!contacts.length) return res.json({ removed: 0, emailsBlocked: 0 });
  await BniContact.updateMany(
    { _id: { $in: contacts.map((c) => c._id) } },
    { $set: { removedAt: new Date(), removedBy: req.employeeId, removedByName: me?.name ?? "" } },
  );

  // Best effort: the member is already out of every audience here even if BeeBark can't be reached
  const emails = [...new Set(contacts.flatMap(emailsOf))];
  let emailsBlocked = 0;
  const failures = [];
  for (const email of emails) {
    try {
      await beebark("/suppressions", { method: "POST", body: { email, reason: "manual" } });
      emailsBlocked += 1;
    } catch (err) {
      failures.push(email);
    }
  }
  res.json({ removed: contacts.length, emailsBlocked, emailBlockFailed: failures.length });
});

/** Put removed members back (admins only). Their emails stay on BeeBark's do-not-email list. */
bniRouter.post("/restore", requireRole("admin"), async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))].filter((id) => mongoose.isValidObjectId(id)).slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: "Choose at least one member" });
  const r = await BniContact.updateMany({ _id: { $in: ids }, removedAt: { $ne: null } }, { $set: { removedAt: null, removedBy: "", removedByName: "" } });
  res.json({ restored: r.modifiedCount });
});
