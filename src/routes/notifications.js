import { Router } from "express";
import mongoose from "mongoose";
import { Notification } from "../models/Notification.js";

export const notificationsRouter = Router();

/** The caller's latest notifications and how many are unread. */
notificationsRouter.get("/", async (req, res) => {
  const [items, unread] = await Promise.all([
    Notification.find({ recipientId: req.employeeId }).sort({ createdAt: -1 }).limit(40),
    Notification.countDocuments({ recipientId: req.employeeId, read: false }),
  ]);
  res.json({ items, unread });
});

/** Marks the given notifications (or all, with `{ all: true }`) as read. */
notificationsRouter.post("/read", async (req, res) => {
  const filter = { recipientId: req.employeeId, read: false };
  if (!req.body?.all) {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => mongoose.isValidObjectId(id));
    filter._id = { $in: ids };
  }
  await Notification.updateMany(filter, { read: true });
  res.json({ ok: true });
});
