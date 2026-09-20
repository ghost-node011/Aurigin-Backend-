import { Router } from "express";
import { AttendanceRecord } from "../models/AttendanceRecord.js";
import { todayISO, nowTime, nowMinutes, monthBounds } from "../lib/helpers.js";
import { requireSelf } from "../middleware/auth.js";
import { Employee } from "../models/Employee.js";
import { probationWfhBlock } from "../lib/wfh.js";
import { minutesToLabel } from "../lib/constants.js";
import { getSettings } from "../models/Settings.js";

export const attendanceRouter = Router();

attendanceRouter.get("/", async (_req, res) => {
  const records = await AttendanceRecord.find().sort({ date: -1 });
  res.json(records);
});

/**
 * Opens (or re-opens) today's record. A late check-in is recorded rather
 * than refused — people still need their attendance on file — and the
 * `lateCheckIn` flag is what an emergency exception later clears.
 */
async function checkInToday(employeeId, status) {
  const date = todayISO();
  const minutes = nowMinutes();
  const { checkInByMinutes } = await getSettings();
  return AttendanceRecord.findOneAndUpdate(
    { employeeId, date },
    {
      $set: {
        status,
        checkIn: nowTime(),
        checkInMinutes: minutes,
        lateCheckIn: minutes > checkInByMinutes,
      },
      $setOnInsert: { employeeId, date, checkOut: null, checkOutMinutes: null, hours: 0 },
    },
    { new: true, upsert: true },
  );
}

attendanceRouter.post("/check-in", requireSelf("employeeId"), async (req, res) => {
  const { employeeId } = req.body;
  const record = await checkInToday(employeeId, "Present");
  res.json(record);
});

attendanceRouter.post("/wfh", requireSelf("employeeId"), async (req, res) => {
  const { employeeId } = req.body;
  const employee = await Employee.findById(employeeId);
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  // Same allowance as raising a WFH request — otherwise marking WFH here
  // would be a way straight past it.
  const blocked = await probationWfhBlock(employee, todayISO());
  if (blocked) return res.status(400).json({ error: blocked });

  const record = await checkInToday(employeeId, "WFH");
  res.json(record);
});

attendanceRouter.post("/check-out", requireSelf("employeeId"), async (req, res) => {
  const { employeeId } = req.body;
  const date = todayISO();
  const record = await AttendanceRecord.findOne({ employeeId, date });
  if (!record) return res.status(404).json({ error: "No attendance record for today" });

  const minutes = nowMinutes();
  const { checkOutFromMinutes } = await getSettings();
  record.checkOut = nowTime();
  record.checkOutMinutes = minutes;
  record.earlyCheckOut = minutes < checkOutFromMinutes;
  record.hours =
    record.checkInMinutes != null ? Math.round(((minutes - record.checkInMinutes) / 60) * 10) / 10 : record.hours;
  await record.save();

  res.json(record);
});

/**
 * Claims one of the month's emergency exceptions for a given day, excusing
 * a late check-in and/or an early check-out on it.
 *
 * The allowance is counted in days, not in violations: a day that was both
 * late in and early out costs one exception, not two.
 */
attendanceRouter.post("/emergency", requireSelf("employeeId"), async (req, res) => {
  const { employeeId, date, reason } = req.body;
  const day = date || todayISO();

  const record = await AttendanceRecord.findOne({ employeeId, date: day });
  if (!record) return res.status(404).json({ error: `No attendance record for ${day}` });
  if (!record.lateCheckIn && !record.earlyCheckOut) {
    return res.status(400).json({ error: `Nothing to excuse on ${day} — check-in and check-out were both within hours.` });
  }
  if (record.emergency) return res.json(record);

  const settings = await getSettings();
  const allowance = settings.emergencyExceptionsPerMonth;
  const { start, end } = monthBounds(day);
  const used = await AttendanceRecord.countDocuments({
    employeeId,
    emergency: true,
    date: { $gte: start, $lte: end },
  });
  if (used >= allowance) {
    return res.status(400).json({
      error: `You have already used all ${allowance} emergency exception(s) this month. Working hours are check-in by ${minutesToLabel(settings.checkInByMinutes)} and check-out from ${minutesToLabel(settings.checkOutFromMinutes)}.`,
    });
  }

  record.emergency = true;
  record.emergencyReason = reason || "";
  await record.save();

  res.json(record);
});
