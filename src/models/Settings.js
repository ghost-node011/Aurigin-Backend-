import mongoose from "mongoose";
import { DEFAULT_SETTINGS } from "../lib/constants.js";

/**
 * Company-wide policy settings, editable by HR/admin.
 *
 * A single document (`_id: "company"`) rather than a collection: there is
 * one set of rules for the company, and giving it a fixed id means reads
 * and writes never have to guess which row is the live one.
 *
 * Every field here was previously a hardcoded constant. The constants
 * remain as DEFAULT_SETTINGS — the values a fresh install starts from and
 * the fallback if the document is somehow missing.
 */
const leaveRuleSchema = new mongoose.Schema(
  {
    perMonth: { type: Number, required: true, min: 0, max: 31 },
    annualCap: { type: Number, required: true, min: 0, max: 365 },
  },
  { _id: false },
);

const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "company" },

    // Handbook §6.3 — the month the leave year opens (4 = April).
    leaveYearStartMonth: { type: Number, default: DEFAULT_SETTINGS.leaveYearStartMonth, min: 1, max: 12 },

    // Handbook §6.5–6.7 — accrued monthly, capped at the annual figure.
    leaveAccrual: {
      casual: { type: leaveRuleSchema, default: () => DEFAULT_SETTINGS.leaveAccrual.casual },
      sick: { type: leaveRuleSchema, default: () => DEFAULT_SETTINGS.leaveAccrual.sick },
      earned: { type: leaveRuleSchema, default: () => DEFAULT_SETTINGS.leaveAccrual.earned },
    },

    // Handbook §4.5 — default probation length in months.
    probationMonths: { type: Number, default: DEFAULT_SETTINGS.probationMonths, min: 0, max: 24 },

    // Handbook §6.4 — whether leave can be availed while on probation.
    leaveAllowedDuringProbation: { type: Boolean, default: DEFAULT_SETTINGS.leaveAllowedDuringProbation },

    // Handbook §1.13 — work-from-home allowances.
    wfhWeeklyQuota: { type: Number, default: DEFAULT_SETTINGS.wfhWeeklyQuota, min: 0, max: 7 },
    wfhProbationMonthlyQuota: {
      type: Number,
      default: DEFAULT_SETTINGS.wfhProbationMonthlyQuota,
      min: 0,
      max: 31,
    },

    // Office hours, as minutes past local midnight.
    checkInByMinutes: { type: Number, default: DEFAULT_SETTINGS.checkInByMinutes, min: 0, max: 1439 },
    checkOutFromMinutes: { type: Number, default: DEFAULT_SETTINGS.checkOutFromMinutes, min: 0, max: 1439 },

    // Off by default: a late arrival is recorded but raises no flag and
    // costs no exception. Leaving early is what's enforced.
    enforceLateCheckIn: { type: Boolean, default: DEFAULT_SETTINGS.enforceLateCheckIn },
    emergencyExceptionsPerMonth: {
      type: Number,
      default: DEFAULT_SETTINGS.emergencyExceptionsPerMonth,
      min: 0,
      max: 31,
    },

    updatedBy: { type: String, default: null },
  },
  { timestamps: true, _id: false },
);

settingsSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    return ret;
  },
});

export const Settings = mongoose.model("Settings", settingsSchema);

/**
 * The live settings, creating the document from defaults on first use so
 * callers never have to handle "not configured yet".
 */
export async function getSettings() {
  const existing = await Settings.findById("company");
  if (existing) return existing;
  return Settings.create({ _id: "company" });
}
