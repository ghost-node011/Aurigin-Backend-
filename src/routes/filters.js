import { Router } from "express";
import mongoose from "mongoose";
import { SavedFilter } from "../models/SavedFilter.js";
import { uploadSignature, cloudinaryConfigured } from "../lib/cloudinary.js";

export const filtersRouter = Router();

/** Your own filters plus everyone's shared ones. */
filtersRouter.get("/", async (req, res) => {
  res.json(await SavedFilter.find({ $or: [{ ownerId: req.employeeId }, { shared: true }] }).sort({ name: 1 }));
});

filtersRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Filter name is required" });
  const query = req.body?.query && typeof req.body.query === "object" ? req.body.query : {};
  // Only plain string params survive — the same ones GET /issues accepts.
  const clean = Object.fromEntries(
    Object.entries(query).filter(([k, v]) => /^[a-z]+$/.test(k) && typeof v === "string" && v.length < 500),
  );
  const filter = await SavedFilter.create({ ownerId: req.employeeId, name: name.slice(0, 80), query: clean, shared: Boolean(req.body?.shared) });
  res.status(201).json(filter);
});

filtersRouter.delete("/:id", async (req, res) => {
  const filter = mongoose.isValidObjectId(req.params.id) ? await SavedFilter.findById(req.params.id) : null;
  if (!filter) return res.status(404).json({ error: "Filter not found" });
  if (filter.ownerId !== req.employeeId) return res.status(403).json({ error: "You can only delete your own filters" });
  await filter.deleteOne();
  res.status(204).end();
});

export const uploadsRouter = Router();

/** A signature for uploading one file straight to Cloudinary from the browser. */
uploadsRouter.get("/signature", (_req, res) => {
  if (!cloudinaryConfigured()) return res.status(503).json({ error: "File uploads aren't configured on the server" });
  res.json(uploadSignature());
});
