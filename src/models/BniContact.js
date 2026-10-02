import mongoose from "mongoose";
import { withIdJSON } from "./plugins.js";

export const BNI_CATEGORIES = ["interior designer", "architects", "construction", "real estate"];

/**
 * A BNI member lead, imported from the forwardly-leads database. Most are
 * provably Indian — `indianBy` records how (recorded country, an Indian
 * mobile number, or an .in email); the rest are email contacts with no
 * recorded country, marked `verifiedIndian: false`.
 */
const bniContactSchema = new mongoose.Schema(
  {
    sourceId: { type: Number, required: true, unique: true }, // BNI userId
    category: { type: String, enum: BNI_CATEGORIES, required: true, index: true },
    name: { type: String, default: "" },
    company: { type: String, default: "" },
    role: { type: String, default: "" },
    phone: { type: String, default: "" },
    mobile: { type: String, default: "" },
    email: { type: String, default: "" },
    website: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    country: { type: String, default: "India" },
    chapter: { type: String, default: "", index: true },
    business: { type: String, default: "" },
    keywords: { type: String, default: "" },
    hasPhone: { type: Boolean, default: false, index: true },
    hasEmail: { type: Boolean, default: false, index: true },
    indianBy: { type: [String], default: [] },
    // False for email-only fill-ins whose country isn't recorded anywhere:
    // not provably Indian, though nothing marks them as foreign either.
    verifiedIndian: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

bniContactSchema.index({ name: "text", company: "text", business: "text", chapter: "text" });

withIdJSON(bniContactSchema);

export const BniContact = mongoose.model("BniContact", bniContactSchema);
