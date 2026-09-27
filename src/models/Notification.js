import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

/** An in-app notification — the bell in the header. Mirrors the emails. */
const notificationSchema = new mongoose.Schema(
  {
    recipientId: { type: String, required: true, ref: "Employee" },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    link: { type: String, default: "/" }, // a portal path, e.g. /browse/WEB-12
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index({ recipientId: 1, createdAt: -1 });
// Old notifications clear themselves after 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

withIdJSON(notificationSchema);

export const Notification = mongoose.model("Notification", notificationSchema);
