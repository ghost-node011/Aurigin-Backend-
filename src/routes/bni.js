import { Router } from "express";
import { BniContact, BNI_CATEGORIES } from "../models/BniContact.js";
import { requireRole } from "../middleware/auth.js";

/** BNI member data — admins only (Arjun and Gaurank). */
export const bniRouter = Router();
bniRouter.use(requireRole("admin"));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function filterFrom(q) {
  const filter = {};
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
    { $group: { _id: "$category", total: { $sum: 1 }, phone: { $sum: { $cond: ["$hasPhone", 1, 0] } }, email: { $sum: { $cond: ["$hasEmail", 1, 0] } }, verified: { $sum: { $cond: ["$verifiedIndian", 1, 0] } } } },
  ]);
  const byCat = Object.fromEntries(rows.map((r) => [r._id, r]));
  res.json(BNI_CATEGORIES.map((c) => ({ category: c, total: byCat[c]?.total ?? 0, phone: byCat[c]?.phone ?? 0, email: byCat[c]?.email ?? 0, verified: byCat[c]?.verified ?? 0 })));
});

/** A page of contacts: ?category&phone=yes|no&email=yes|no&q&page&limit */
bniRouter.get("/", async (req, res) => {
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
bniRouter.get("/export", async (req, res) => {
  const items = await BniContact.find(filterFrom(req.query)).sort({ category: 1, hasPhone: -1, name: 1 }).lean();
  const lines = [CSV_COLUMNS.join(","), ...items.map((i) => CSV_COLUMNS.map((c) => csvCell(i[c])).join(","))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="bni-data${req.query.category ? "-" + String(req.query.category).replace(/\s+/g, "-") : ""}.csv"`);
  res.send("﻿" + lines.join("\n"));
});
