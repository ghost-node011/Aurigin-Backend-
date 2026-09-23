import { Router } from "express";
import { Settings, getSettings } from "../models/Settings.js";
import { requireRole } from "../middleware/auth.js";
import { minutesToLabel, ACCRUED_LEAVE_TYPES, ALLOWANCE_LEAVE_TYPES } from "../lib/constants.js";

export const settingsRouter = Router();

/**
 * Everyone can read the settings — the app shows people the rules that
 * apply to them (leave rates, working hours, allowances), so this can't be
 * HR-only. Nothing here is sensitive.
 */
settingsRouter.get("/", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

const NUMERIC_FIELDS = {
  leaveYearStartMonth: { min: 1, max: 12, integer: true },
  probationMonths: { min: 0, max: 24, integer: true },
  checkInByMinutes: { min: 0, max: 1439, integer: true },
  checkOutFromMinutes: { min: 0, max: 1439, integer: true },
  emergencyExceptionsPerMonth: { min: 0, max: 31, integer: true },
};

settingsRouter.patch("/", requireRole("admin", "hr"), async (req, res) => {
  const settings = await getSettings();
  const body = req.body ?? {};

  for (const [field, rule] of Object.entries(NUMERIC_FIELDS)) {
    if (body[field] === undefined) continue;
    const value = Number(body[field]);
    if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
      return res.status(400).json({ error: `${field} must be a number between ${rule.min} and ${rule.max}` });
    }
    if (rule.integer && !Number.isInteger(value)) {
      return res.status(400).json({ error: `${field} must be a whole number` });
    }
    settings[field] = value;
  }

  for (const flag of ["leaveAllowedDuringProbation", "enforceLateCheckIn"]) {
    if (body[flag] !== undefined) settings[flag] = Boolean(body[flag]);
  }

  if (body.leaveAccrual) {
    for (const type of ACCRUED_LEAVE_TYPES) {
      const rule = body.leaveAccrual[type];
      if (!rule) continue;
      const perMonth = Number(rule.perMonth);
      const annualCap = Number(rule.annualCap);
      if (!Number.isFinite(perMonth) || perMonth < 0 || perMonth > 31) {
        return res.status(400).json({ error: `${type}.perMonth must be between 0 and 31` });
      }
      if (!Number.isFinite(annualCap) || annualCap < 0 || annualCap > 365) {
        return res.status(400).json({ error: `${type}.annualCap must be between 0 and 365` });
      }
      settings.leaveAccrual[type] = { perMonth, annualCap };
    }
  }

  if (body.leaveAllowances) {
    for (const type of ALLOWANCE_LEAVE_TYPES) {
      if (body.leaveAllowances[type] === undefined) continue;
      const days = Number(body.leaveAllowances[type]);
      if (!Number.isFinite(days) || days < 0 || days > 365) {
        return res.status(400).json({ error: `${type} allowance must be between 0 and 365 days` });
      }
      settings.leaveAllowances[type] = days;
    }
  }

  // A check-out floor at or before the check-in deadline would flag every
  // day at once, so it's rejected rather than saved.
  if (settings.checkOutFromMinutes <= settings.checkInByMinutes) {
    return res.status(400).json({
      error: `Check-out time (${minutesToLabel(settings.checkOutFromMinutes)}) must be later than the check-in deadline (${minutesToLabel(settings.checkInByMinutes)}).`,
    });
  }

  settings.updatedBy = req.employeeId;
  await settings.save();

  res.json(settings);
});

/** Restores every value to the shipped defaults. */
settingsRouter.post("/reset", requireRole("admin", "hr"), async (req, res) => {
  await Settings.deleteOne({ _id: "company" });
  const settings = await getSettings();
  settings.updatedBy = req.employeeId;
  await settings.save();
  res.json(settings);
});
