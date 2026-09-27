import { Router } from "express";
import { AttendanceRecord } from "../models/AttendanceRecord.js";
import { todayISO, nowTime, nowMinutes, monthBounds } from "../lib/helpers.js";
import { requireSelf } from "../middleware/auth.js";
import { Employee } from "../models/Employee.js";
import { minutesToLabel } from "../lib/constants.js";
import { getSettings } from "../models/Settings.js";
import { wfhRequested } from "../lib/notify.js";

export const attendanceRouter = Router();

attendanceRouter.get("/", async (_req, res) => {
  const records = await AttendanceRecord.find().sort({ date: -1 });
  res.json(records);
});

/**
 * Opens (or re-opens) today's record. A late check-in is recorded rather
 * than refused — people still need their attendance on file — and the
 * `lateCheckIn` flag is what an emergency exception later clears. Checking
 * in on a weekly holiday, before the window opens or after office hours is
 * refused outright (except for test accounts).
 *
 * Returns `{ error }` instead of a record when it's refused.
 */
async function checkInToday(employeeId, status) {
  const date = todayISO();
  const minutes = nowMinutes();
  const [settings, employee] = await Promise.all([getSettings(), Employee.findById(employeeId, { policyExempt: 1 }).lean()]);
  const { checkInByMinutes, checkInOpensMinutesBefore, checkOutFromMinutes, enforceLateCheckIn, weeklyOffDays } = settings;
  if (!employee?.policyExempt) {
    const weekday = new Date(date + "T00:00:00Z").getUTCDay();
    if (weeklyOffDays.includes(weekday)) {
      return { error: "Today is a weekly holiday — no attendance to mark (Handbook §1.10)." };
    }
    const opensAt = checkInByMinutes - checkInOpensMinutesBefore;
    if (minutes < opensAt) {
      return { error: `Check-in opens at ${minutesToLabel(opensAt)}. Office starts at ${minutesToLabel(checkInByMinutes)}.` };
    }
    // After office hours there's no working day left to open.
    if (minutes >= checkOutFromMinutes) {
      return { error: `Check-in is closed — office hours ended at ${minutesToLabel(checkOutFromMinutes)}.` };
    }
  }
  const record = await AttendanceRecord.findOneAndUpdate(
    { employeeId, date },
    {
      $set: {
        status,
        checkIn: nowTime(),
        checkInMinutes: minutes,
        // Arriving late is recorded but not held against anyone unless the
        // company explicitly turns that on.
        lateCheckIn: enforceLateCheckIn && minutes > checkInByMinutes,
      },
      $setOnInsert: { employeeId, date, checkOut: null, checkOutMinutes: null, hours: 0 },
    },
    { new: true, upsert: true },
  );
  return { record };
}

attendanceRouter.post("/check-in", requireSelf("employeeId"), async (req, res) => {
  const { employeeId } = req.body;
  const { record, error } = await checkInToday(employeeId, "Present");
  if (error) return res.status(400).json({ error });
  res.json(record);
});

attendanceRouter.post("/wfh", requireSelf("employeeId"), async (req, res) => {
  const { employeeId } = req.body;
  const employee = await Employee.findById(employeeId);
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const alreadyMarked = await AttendanceRecord.exists({ employeeId, date: todayISO(), status: "WFH" });
  const { record, error } = await checkInToday(employeeId, "WFH");
  if (error) return res.status(400).json({ error });
  // Same-day WFH needs no approval, but the manager should still know.
  if (!alreadyMarked) {
    await wfhRequested(
      { employeeId, date: record.date, approverId: employee.managerId, checkIn: record.checkIn, reason: "" },
      { sameDay: true },
    );
  }
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
    return res.status(400).json({ error: `Nothing to excuse on ${day} — you worked the full day.` });
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
